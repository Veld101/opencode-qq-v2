import { Throttler } from "./util/throttle"
import type { InboundEvent } from "./types"

const TOOL_PROGRESS_INTERVAL_MS = 60_000
const ERROR_SUMMARY_MAX = 300

/** SessionError.Error 是结构化对象，直接 String() 会得到 [object Object] */
function summarizeError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as Record<string, any>
    const message = e.data && typeof e.data === "object" ? e.data.message : undefined
    if (typeof message === "string" && message) return message.slice(0, ERROR_SUMMARY_MAX)
    if (typeof e.message === "string" && e.message) return e.message.slice(0, ERROR_SUMMARY_MAX)
    if (typeof e.name === "string" && e.name) return e.name.slice(0, ERROR_SUMMARY_MAX)
  }
  return String(error ?? "未知错误").slice(0, ERROR_SUMMARY_MAX)
}

export type PusherDeps = {
  isOurSession: (sessionId: string) => boolean
  openidOfSession: (sessionId: string) => string | null
  /** 该会话是否正被某条 QQ 消息同步等待（在等待中则不重复推送，避免与回复重复） */
  isTurnInFlight: (sessionId: string) => boolean
  send: (openid: string, text: string) => Promise<void>
  /** 是否推送工具进度（函数式以便配置热生效） */
  toolProgress: () => boolean
  lastAssistantText: (sessionId: string) => string | null
  subscribe: (handler: (e: InboundEvent) => void) => void
  toolProgressIntervalMs?: number
}

/**
 * 主动推送：
 * - 会话完成 / 执行失败 → 通知 QQ
 * - 工具进度（可选，节流）
 * 仅对「非 QQ 消息触发」的回合推送，避免与同步回复重复打扰。
 */
export class EventPusher {
  private throttler: Throttler
  private offlineQueue: Array<{ openid: string; text: string }> = []
  private online = true
  private toolNames = new Map<string, string>()

  constructor(private deps: PusherDeps) {
    this.throttler = new Throttler(deps.toolProgressIntervalMs ?? TOOL_PROGRESS_INTERVAL_MS, (openid, lines) => {
      void this.deps.send(openid, `🛠 工具进度:\n${lines.map((l) => `- ${l}`).join("\n")}`).catch(() => {})
    })
    deps.subscribe((evt) => this.handle(evt))
  }

  setOnline(online: boolean): void {
    this.online = online
    if (online) {
      for (const item of this.offlineQueue.splice(0)) {
        void this.deps.send(item.openid, item.text).catch(() => {})
      }
    }
  }

  private deliver(openid: string, text: string): void {
    if (!this.online) {
      this.offlineQueue.push({ openid, text })
      return
    }
    void this.deps.send(openid, text).catch(() => {})
  }

  handle(evt: InboundEvent): void {
    const d = evt.data ?? {}

    // 工具名先入表（session.tool.called 本身不带 name）
    if (evt.type === "session.tool.input.started") {
      const id = String(d.id ?? "")
      if (id) this.toolNames.set(id, String(d.name ?? "tool"))
      return
    }

    const sessionId = String(d.sessionID ?? "")
    if (!sessionId || !this.deps.isOurSession(sessionId)) return
    if (this.deps.isTurnInFlight(sessionId)) return // 同步回复已覆盖，不重复推

    const openid = this.deps.openidOfSession(sessionId)
    if (!openid) return

    switch (evt.type) {
      case "session.idle": {
        const tail = this.deps.lastAssistantText?.(sessionId)
        this.deliver(openid, tail ? `✅ 任务完成。\n摘要: ${tail.slice(-200)}` : "✅ 任务完成。")
        break
      }
      case "session.execution.failed": {
        this.deliver(openid, `❌ 出错: ${summarizeError(d.error)}`)
        break
      }
      case "session.tool.called": {
        if (this.deps.toolProgress()) {
          const name = this.toolNames.get(String(d.id ?? "")) ?? "tool"
          this.throttler.push(openid, name)
        }
        break
      }
      default:
        break
    }
  }

  dispose(): void {
    this.throttler.dispose()
  }
}
