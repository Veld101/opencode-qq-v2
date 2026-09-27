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
 */
export class StreamSender {
  private streamMsgId: string | null = null
  private index = 0
  private begun = false
  private finished = false
  /** 任一环节失败即置败，调用方回落到普通被动回复，不丢内容 */
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
    if (this.failed) return
    try {
      const token = await this.opts.getToken()
      const res = await (this.opts.fetchFn ?? fetch)(
        `${this.opts.restBase}/v2/users/${this.ref.openid}/stream_messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        this.failed = true
        return
      }
      const data = (await res.json()) as { id?: string }
      if (!this.streamMsgId && data.id) this.streamMsgId = data.id
      this.index++
    } catch {
      this.failed = true
    }
  }
}
