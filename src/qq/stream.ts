import { log } from "../logger"

/**
 * 该 HTTP 状态是否值得重试。
 * 429 限频与 5xx 都是平台侧瞬时问题（响应体常为「系统繁忙，请稍后重试」），重试有意义；
 * 4xx 是确定性错误（协议字段错、msg_id 过期、index 冲突等），重试只会白耗被动回复额度。
 */
export function isRetryableStreamStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

/** 单帧最多尝试次数（含首次）；用尽后置败，由调用方回落普通被动回复 */
const STREAM_MAX_ATTEMPTS = 3
/** 重试退避基准（毫秒）：第 n 次重试等待 base * n */
const STREAM_RETRY_BASE_MS = 400

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type StreamOpts = {
  restBase: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}

type StreamRef = {
  openid: string
  msgId: string
  msgSeq: number
}

/**
 * stream_messages 打字机发送器。
 *
 * 延迟 begin：首次 update() 即首片（input_state=1,index=0），其后 update 为全量 replace
 * 续片——正文天然以首片为前缀，保证 replace 前缀链一致（协议要求，否则 40007）。
 * 内部串行队列保证报文按序、index 有序，允许调用方 fire-and-forget。
 * 平台侧瞬时错误（429 / 5xx）先做有界重试，只有确定性错误或重试耗尽才置败。
 */
export class StreamSender {
  private streamMsgId: string | null = null
  private index = 0
  private begun = false
  private finished = false
  /**
   * 判定为不可恢复后置败，调用方回落到普通被动回复，不丢内容。
   * 注意语义：是「本帧已不可恢复」而不是「一遇错就置败」——瞬时错误会先重试。
   */
  failed = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private opts: StreamOpts,
    private ref: StreamRef,
  ) {}

  update(fullText: string): Promise<void> {
    if (this.failed || this.finished || !fullText) return Promise.resolve()
    if (!this.begun) {
      this.begun = true
      return this.enqueue(() => ({
        input_mode: "replace",
        input_state: 1,
        index: 0,
        content_type: "markdown",
        content_raw: fullText,
        msg_id: this.ref.msgId,
        msg_seq: this.ref.msgSeq,
      }))
    }
    return this.enqueue(() => this.pieceBody(1, fullText))
  }

  finish(fullText: string): Promise<void> {
    if (this.failed || this.finished || !fullText) return Promise.resolve()
    if (!this.begun) {
      const first = this.update(fullText)
      this.finished = true
      return first.then(() => {
        if (this.failed) return
        return this.enqueue(() => this.pieceBody(10, fullText))
      })
    }
    this.finished = true
    return this.enqueue(() => this.pieceBody(10, fullText))
  }

  private pieceBody(inputState: number, fullText: string): Record<string, unknown> {
    return {
      input_mode: "replace",
      input_state: inputState,
      index: this.index,
      content_type: "markdown",
      content_raw: fullText,
      ...(this.streamMsgId ? { stream_msg_id: this.streamMsgId } : {}),
      msg_seq: this.ref.msgSeq,
    }
  }

  private enqueue(makeBody: () => Record<string, unknown>): Promise<void> {
    const task = this.queue.then(async () => {
      await this.post(makeBody())
    })
    this.queue = task.catch(() => {})
    return task
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    const url = `${this.opts.restBase}/v2/users/${this.ref.openid}/stream_messages`

    for (let attempt = 1; attempt <= STREAM_MAX_ATTEMPTS; attempt++) {
      // 调用方可能在排队期间（或重试退避期间）已置败，例如同一 openid 来了新消息
      if (this.failed) return

      let res: Response
      try {
        const token = await this.opts.getToken()
        res = await (this.opts.fetchFn ?? fetch)(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
          body: JSON.stringify(body),
        })
      } catch (e) {
        // 网络类异常（代理抖动、连接被重置）与 5xx 同属瞬时问题，同样重试
        if (attempt < STREAM_MAX_ATTEMPTS) {
          await sleep(STREAM_RETRY_BASE_MS * attempt)
          continue
        }
        this.failed = true
        log("WARN", `流式发送异常（已尝试 ${attempt} 次，放弃）: ${String(e).slice(0, 200)}`)
        return
      }

      if (res.ok) {
        const data = (await res.json()) as { id?: string }
        if (!this.streamMsgId && data.id) this.streamMsgId = data.id
        this.index++
        return
      }

      const detail = await res.text().catch(() => "")
      // 早期实现把任何非 2xx 都当永久失败：一次平台抖动（HTTP 500「系统繁忙，请稍后重试」）
      // 就会丢掉整轮打字机，用户要干等数分钟才看到最终回答。故 5xx/429 先行重试。
      if (isRetryableStreamStatus(res.status) && attempt < STREAM_MAX_ATTEMPTS) {
        log(
          "WARN",
          `流式发送被拒 HTTP ${res.status}（第 ${attempt}/${STREAM_MAX_ATTEMPTS} 次，将重试）: ${detail.slice(0, 200)}`,
        )
        await sleep(STREAM_RETRY_BASE_MS * attempt)
        continue
      }

      this.failed = true
      log("WARN", `流式发送被拒 HTTP ${res.status}（已尝试 ${attempt} 次，放弃）: ${detail.slice(0, 200)}`)
      return
    }
  }
}
