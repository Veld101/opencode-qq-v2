import { MAX_REPLIES_PER_MSG_ID, PASSIVE_WINDOW_MS } from "../constants"

type ApiOpts = {
  restBase: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}

type SendOptions = {
  /** 被动回复锚定的 msg_id；缺省即主动消息 */
  msgId?: string
  format?: "text" | "markdown"
}

/**
 * 被动回复序号（msg_seq）计数器。
 *
 * 必须放在模块级而非 QQApi 实例上：配置热重载会重建 QQApi，
 * 若计数器随实例清零，就会在 60 分钟被动窗口内对同一 msg_id 重复分配序号，
 * 触发 40054005「消息被去重，请检查请求msgseq」。
 * 记录带时间戳，超出被动窗口即回收，避免无界增长。
 */
const seqCounters = new Map<string, { seq: number; at: number }>()

function nextSeq(msgId?: string): number | undefined {
  if (!msgId) return undefined
  const now = Date.now()

  for (const [key, value] of seqCounters) {
    if (now - value.at > PASSIVE_WINDOW_MS) seqCounters.delete(key)
  }

  const used = seqCounters.get(msgId)?.seq ?? 0
  if (used >= MAX_REPLIES_PER_MSG_ID) return undefined // 额度用尽 → 调用方降级主动消息
  const seq = used + 1
  seqCounters.set(msgId, { seq, at: now })
  return seq
}

/** 仅供测试：清空序号表 */
export function __resetSeqCounters(): void {
  seqCounters.clear()
}

/** QQ 单聊消息发送。串行化所有发送以避免打爆频控，并管理被动回复额度。 */
export class QQApi {
  private fetchFn: typeof fetch
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private opts: ApiOpts) {
    this.fetchFn = opts.fetchFn ?? fetch
  }

  sendC2C(openid: string, content: string, options: SendOptions = {}): Promise<void> {
    const task = this.queue.then(() => this.doSend(openid, content, options))
    this.queue = task.catch(() => {}) // 吞掉错误保持队列继续
    return task
  }

  private async postWithRetry(openid: string, body: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const token = await this.opts.getToken()
      const res = await this.fetchFn(`${this.opts.restBase}/v2/users/${openid}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
        body: JSON.stringify(body),
      })
      if (res.status === 429 && attempt < 3) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "1")
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000))
        continue
      }
      if (!res.ok) throw new Error(`sendC2C failed: HTTP ${res.status} ${await res.text()}`)
      return
    }
  }

  private async doSend(openid: string, content: string, options: SendOptions): Promise<void> {
    const format = options.format ?? "text"
    let msgId = options.msgId
    let seqReserved: number | undefined
    if (msgId) {
      seqReserved = nextSeq(msgId)
      if (seqReserved === undefined) msgId = undefined // 被动额度用尽 → 主动消息
    }

    const makeBody = (fmt: "text" | "markdown"): Record<string, unknown> => {
      const body: Record<string, unknown> =
        fmt === "markdown" ? { msg_type: 2, markdown: { content } } : { msg_type: 0, content }
      if (msgId && seqReserved !== undefined) {
        body.msg_id = msgId
        body.msg_seq = seqReserved
      }
      return body
    }

    try {
      await this.postWithRetry(openid, makeBody(format))
    } catch (e) {
      if (format === "markdown") {
        // Markdown 被拒时降级为纯文本（复用同一 msg_seq）
        await this.postWithRetry(openid, makeBody("text"))
        return
      }
      throw e
    }
  }
}
