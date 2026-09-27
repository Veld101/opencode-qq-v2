import { MAX_REPLIES_PER_MSG_ID } from "../constants"

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

/** QQ 单聊消息发送。串行化所有发送以避免打爆频控，并管理被动回复额度。 */
export class QQApi {
  private fetchFn: typeof fetch
  private queue: Promise<unknown> = Promise.resolve()
  private seqCounters = new Map<string, number>()

  constructor(private opts: ApiOpts) {
    this.fetchFn = opts.fetchFn ?? fetch
  }

  sendC2C(openid: string, content: string, options: SendOptions = {}): Promise<void> {
    const task = this.queue.then(() => this.doSend(openid, content, options))
    this.queue = task.catch(() => {}) // 吞掉错误保持队列继续
    return task
  }

  /** 被动回复序号；额度用尽返回 undefined（调用方降级为主动消息） */
  private nextSeq(msgId?: string): number | undefined {
    if (!msgId) return undefined
    const used = this.seqCounters.get(msgId) ?? 0
    if (used >= MAX_REPLIES_PER_MSG_ID) return undefined
    const seq = used + 1
    this.seqCounters.set(msgId, seq)
    if (this.seqCounters.size > 500) this.seqCounters.clear()
    return seq
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
      seqReserved = this.nextSeq(msgId)
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
