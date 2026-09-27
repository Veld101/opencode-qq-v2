import fs from "node:fs"
import { parseCommand } from "./commands"
import type { HostBridge, PromptFile } from "./types"

/** 每个 QQ openid 对应一个长期 OpenCode 会话，落盘以便重启延续 */
export class SessionManager {
  private map = new Map<string, string>()

  constructor(
    private bridge: HostBridge,
    private persistPath: string,
    private fsMod: typeof fs = fs,
    private pendingCount?: (sessionId: string) => number,
  ) {
    try {
      const raw = JSON.parse(this.fsMod.readFileSync(persistPath, "utf8")) as Record<string, string>
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v)
    } catch {
      /* 首次运行无文件 */
    }
  }

  async getSessionId(openid: string): Promise<string | null> {
    return this.map.get(openid) ?? null
  }

  isOurSession(sessionId: string): boolean {
    for (const sid of this.map.values()) if (sid === sessionId) return true
    return false
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map)
  }

  reset(openid: string): void {
    const sid = this.map.get(openid)
    this.map.delete(openid)
    this.persist()
    if (sid) this.bridge.onSessionReset?.(sid)
  }

  /** 清空全部绑定（工作目录变更等场景：旧会话位置无法迁移，只能重开） */
  resetAll(): void {
    for (const sid of this.map.values()) this.bridge.onSessionReset?.(sid)
    this.map.clear()
    this.persist()
  }

  /** 返回要发回 QQ 的文本 */
  async dispatch(openid: string, text: string, files: PromptFile[] = []): Promise<string> {
    const cmd = parseCommand(text)
    if (cmd) {
      switch (cmd.type) {
        case "new":
          this.reset(openid)
          return "已重置会话，下次消息将开启新对话。"
        case "status":
          return this.statusReply(openid)
        case "help":
          return [
            "opencode-qq 指令:",
            "/new — 重置当前会话",
            "/status — 查看会话状态",
            "/help — 本帮助",
            "其余文本将直接交给 OpenCode 处理。",
          ].join("\n")
      }
    }

    let sessionId = await this.getSessionId(openid)
    if (!sessionId) {
      const title = text.slice(0, 20)
      const created = await this.bridge.sessionCreate(title)
      sessionId = created.id
      this.map.set(openid, sessionId)
      this.persist()
      // 用 synthetic 消息做一次人设/风格引导（不触发模型回复）
      await this.bridge
        .sessionPrompt(sessionId, "以下用户将通过 QQ 单聊与你对话，回答请精炼易读。", true)
        .catch(() => {})
    }

    const result = await this.bridge.sessionPrompt(sessionId, text, false, files)
    return result.text || "(无文本回复)"
  }

  async statusReply(openid: string): Promise<string> {
    const sid = await this.getSessionId(openid)
    if (!sid) return "暂无会话，发任意消息即可开始。"
    let reply = `当前会话: ${sid}\n状态: 已就绪`
    const pending = this.pendingCount?.(sid)
    if (pending !== undefined) reply += `\n待审批: ${pending} 条`
    return reply
  }

  private persist(): void {
    try {
      this.fsMod.writeFileSync(this.persistPath, JSON.stringify(Object.fromEntries(this.map)))
    } catch {
      /* 写失败不影响主流程 */
    }
  }
}
