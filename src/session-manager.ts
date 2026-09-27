import fs from "node:fs"
import { parseCommand } from "./commands"
import { defaultWorkspaceName, findWorkspace, workspacesFingerprint, type ResolvedWorkspace } from "./workspaces"
import type { HostBridge, PromptFile } from "./types"

type SessionInfo = { openid: string; workspace: string; sessionId: string }

type PersistedV2 = {
  version: 2
  /** openid → 当前工作区名 */
  current: Record<string, string>
  /** `${openid}::${workspace}` → sessionId */
  sessions: Record<string, string>
}

const key = (openid: string, workspace: string): string => `${openid}::${workspace}`
const SESSION_GREETING = "以下用户将通过 QQ 单聊与你对话，回答请精炼易读。"

/**
 * QQ 会话绑定管理。
 *
 * 每个 (openid, 工作区) 组合各自一个长期 OpenCode 会话，落盘以便重启延续：
 * - 同一用户在不同项目之间切换时，历史互不污染
 * - `/new` 只重置当前工作区的会话
 * - 工作区白名单来自配置，QQ 侧只能切换、不能指定任意路径
 */
export class SessionManager {
  private sessions = new Map<string, string>()
  private current = new Map<string, string>()
  private workspaces: ResolvedWorkspace[] = []
  private fingerprint = ""
  /** v1 迁移来的记录先挂在临时工作区名下，等 setWorkspaces 后重挂到真正的默认工作区 */
  private provisionalWorkspace: string | null = null

  constructor(
    private bridge: HostBridge,
    private persistPath: string,
    private fsMod: typeof fs = fs,
    private pendingCount?: (sessionId: string) => number,
  ) {
    this.load()
  }

  /** 应用工作区列表；列表变化会导致既有会话位置无效，需要重建 */
  setWorkspaces(list: ResolvedWorkspace[]): boolean {
    // 首次应用时，把 v1 迁移来的记录重挂到真正的默认工作区
    if (this.provisionalWorkspace !== null) {
      const target = defaultWorkspaceName(list)
      for (const [k, sid] of [...this.sessions]) {
        if (k.endsWith(`::${this.provisionalWorkspace}`)) {
          this.sessions.delete(k)
          this.sessions.set(`${k.slice(0, k.lastIndexOf("::"))}::${target}`, sid)
        }
      }
      this.provisionalWorkspace = null
      this.persist()
    }

    const next = workspacesFingerprint(list)
    const changed = this.fingerprint.length > 0 && this.fingerprint !== next
    this.workspaces = list
    this.fingerprint = next
    if (changed) this.resetAll()
    return changed
  }

  private load(): void {
    try {
      const raw = JSON.parse(this.fsMod.readFileSync(this.persistPath, "utf8")) as any
      if (raw && raw.version === 2) {
        const data = raw as PersistedV2
        for (const [k, v] of Object.entries(data.sessions ?? {})) this.sessions.set(k, String(v))
        for (const [k, v] of Object.entries(data.current ?? {})) this.current.set(k, String(v))
        return
      }
      // v1：{ openid: sessionId }，先挂在临时名，待 setWorkspaces 后重挂到默认工作区
      this.provisionalWorkspace = "default"
      for (const [openid, sid] of Object.entries(raw ?? {})) {
        if (typeof sid === "string") this.sessions.set(key(openid, "default"), sid)
      }
    } catch {
      /* 首次运行无文件 */
    }
  }

  private workspaceList(): ResolvedWorkspace[] {
    return this.workspaces.length > 0 ? this.workspaces : [{ name: "default", isDefault: true }]
  }

  workspaceOf(openid: string): string {
    const list = this.workspaceList()
    const saved = this.current.get(openid)
    if (saved && list.some((w) => w.name === saved)) return saved
    return defaultWorkspaceName(list)
  }

  private setWorkspace(openid: string, name: string): void {
    this.current.set(openid, name)
    this.persist()
  }

  private workspacePath(openid: string): string | undefined {
    const name = this.workspaceOf(openid)
    return this.workspaceList().find((w) => w.name === name)?.path
  }

  getSessionId(openid: string): string | null {
    return this.sessions.get(key(openid, this.workspaceOf(openid))) ?? null
  }

  isOurSession(sessionId: string): boolean {
    for (const sid of this.sessions.values()) if (sid === sessionId) return true
    return false
  }

  /** 事件回调需要反查：某个 session 属于哪个 openid */
  openidOfSession(sessionId: string): string | null {
    for (const [k, sid] of this.sessions) {
      if (sid === sessionId) return k.slice(0, k.lastIndexOf("::"))
    }
    return null
  }

  listSessions(): SessionInfo[] {
    const out: SessionInfo[] = []
    for (const [k, sid] of this.sessions) {
      const at = k.lastIndexOf("::")
      out.push({ openid: k.slice(0, at), workspace: k.slice(at + 2), sessionId: sid })
    }
    return out
  }

  /** 重置当前工作区的会话 */
  reset(openid: string): void {
    const k = key(openid, this.workspaceOf(openid))
    const sid = this.sessions.get(k)
    this.sessions.delete(k)
    this.persist()
    if (sid) this.bridge.onSessionReset?.(sid)
  }

  /** 清空全部绑定（工作区列表变更等场景：旧会话位置无法迁移，只能重开） */
  resetAll(): void {
    for (const sid of this.sessions.values()) this.bridge.onSessionReset?.(sid)
    this.sessions.clear()
    this.persist()
  }

  /** 返回要发回 QQ 的文本 */
  async dispatch(openid: string, text: string, files: PromptFile[] = []): Promise<string> {
    const cmd = parseCommand(text)
    if (cmd) {
      switch (cmd.type) {
        case "new":
          this.reset(openid)
          return `已重置当前工作区「${this.workspaceOf(openid)}」的会话，下次消息将开启新对话。`
        case "status":
          return this.statusReply(openid)
        case "workspace":
          return this.workspaceReply(openid, cmd.arg)
        case "help":
          return [
            "opencode-qq 指令:",
            "/new — 重置当前工作区的会话",
            "/workspace — 列出工作区",
            "/workspace <名称|序号> — 切换工作区（历史相互独立）",
            "/status — 查看当前工作区与会话",
            "/help — 本帮助",
            "其余文本将直接交给 OpenCode 处理。",
          ].join("\n")
      }
    }

    let sessionId = this.getSessionId(openid)
    if (!sessionId) {
      const created = await this.bridge.sessionCreate(text.slice(0, 20), this.workspacePath(openid))
      sessionId = created.id
      this.sessions.set(key(openid, this.workspaceOf(openid)), sessionId)
      this.persist()
      // 用 synthetic 消息做一次风格引导（不触发模型回复）
      await this.bridge.sessionPrompt(sessionId, SESSION_GREETING, true).catch(() => {})
    }

    const result = await this.bridge.sessionPrompt(sessionId, text, false, files)
    return result.text || "(无文本回复)"
  }

  private workspaceReply(openid: string, arg?: string): string {
    const list = this.workspaceList()
    const currentName = this.workspaceOf(openid)

    if (!arg) {
      const lines = list.map((w, i) => {
        const mark = w.name === currentName ? "→" : "  "
        const path = w.path ?? "（跟随 OpenCode 当前目录）"
        const has = this.sessions.has(key(openid, w.name)) ? "已有会话" : "未开会话"
        return `${mark} ${i + 1}. ${w.name} — ${path} [${has}]`
      })
      return [`当前工作区: ${currentName}`, ...lines, "", "切换: /workspace <名称|序号>"].join("\n")
    }

    const target = findWorkspace(list, arg)
    if (!target) {
      return `未找到工作区「${arg}」。可用：\n${list.map((w, i) => `${i + 1}. ${w.name}`).join("\n")}`
    }
    if (target.name === currentName) {
      return `已经在工作区「${target.name}」了。`
    }

    this.setWorkspace(openid, target.name)
    const existing = this.sessions.get(key(openid, target.name))
    return [
      `已切换到工作区「${target.name}」`,
      `目录: ${target.path ?? "（跟随 OpenCode 当前目录）"}`,
      existing ? `沿用已有会话 ${existing}` : "下次消息将在此工作区新建会话",
    ].join("\n")
  }

  statusReply(openid: string): string {
    const ws = this.workspaceOf(openid)
    const wsPath = this.workspaceList().find((w) => w.name === ws)?.path ?? "（跟随 OpenCode 当前目录）"
    const sid = this.getSessionId(openid)
    const lines = [`工作区: ${ws}`, `目录: ${wsPath}`]
    if (!sid) {
      lines.push("会话: 暂无，发任意消息即可开始")
    } else {
      lines.push(`会话: ${sid}`)
      const pending = this.pendingCount?.(sid)
      if (pending !== undefined) lines.push(`待审批: ${pending} 条`)
    }
    lines.push(`已建会话的工作区: ${this.listSessions().filter((s) => s.openid === openid).length} 个`)
    return lines.join("\n")
  }

  private persist(): void {
    try {
      const data: PersistedV2 = {
        version: 2,
        current: Object.fromEntries(this.current),
        sessions: Object.fromEntries(this.sessions),
      }
      this.fsMod.writeFileSync(this.persistPath, JSON.stringify(data))
    } catch {
      /* 写失败不影响主流程 */
    }
  }
}
