import type { InboundEvent } from "./types"

/**
 * 累计助手流式文本。
 *
 * V2 事件（已核对 schema）：
 *   session.text.started { sessionID, assistantMessageID, ordinal }
 *   session.text.delta   { sessionID, assistantMessageID, ordinal, delta }  （ephemeral）
 *   session.text.ended   { sessionID, assistantMessageID, ordinal, text }   （durable，全量）
 *
 * delta 做增量累计；ended 用全量值覆盖，避免丢片导致文本不完整。
 */
export class AssistantTextBuffer {
  /** sessionID → (messageID::ordinal → 文本) */
  private parts = new Map<string, Map<string, string>>()

  constructor(private isOurSession: (sessionId: string) => boolean) {}

  handle(evt: InboundEvent): void {
    const d = evt.data ?? {}
    const sid = String(d.sessionID ?? "")
    if (!sid || !this.isOurSession(sid)) return

    const messageId = String(d.assistantMessageID ?? "")
    const ordinal = Number(d.ordinal ?? 0)
    if (!messageId) return
    const key = `${messageId}::${ordinal}`

    if (evt.type === "session.text.delta") {
      if (typeof d.delta !== "string") return
      const bucket = this.parts.get(sid) ?? new Map<string, string>()
      bucket.set(key, (bucket.get(key) ?? "") + d.delta)
      this.parts.set(sid, bucket)
      return
    }

    if (evt.type === "session.text.ended") {
      if (typeof d.text !== "string") return
      const bucket = this.parts.get(sid) ?? new Map<string, string>()
      bucket.set(key, d.text) // 全量覆盖
      this.parts.set(sid, bucket)
    }
  }

  text(sessionId: string): string | null {
    const bucket = this.parts.get(sessionId)
    if (!bucket || bucket.size === 0) return null
    return [...bucket.values()].join("")
  }

  clear(sessionId: string): void {
    this.parts.delete(sessionId)
  }

  clearAll(): void {
    this.parts.clear()
  }
}
