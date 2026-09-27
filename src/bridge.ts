import { REPLY_TIMEOUT_MS } from "./constants"
import type { HostBridge, PromptFile } from "./types"

/**
 * OpenCode V2 宿主绑定层。
 *
 * 与 V1 的关键差异（已核对 V2 OpenAPI / 插件文档）：
 *  - V1: client.session.prompt({body:{parts,noReply}}) 直接返回助手消息 parts
 *  - V2: ctx.session.prompt({sessionID,text,files}) 只做「消息投递」，不返回回复；
 *        必须 ctx.session.wait() 后读 ctx.session.context() 取最终文本
 *  - V1: 无对应 → V2 用 ctx.session.synthetic() 注入不触发回复的消息
 *  - V1: client.config.get() 取默认模型 → V2 ctx.model.default() / ctx.session.create({model})
 *
 * ctx 用宽松类型（与同机 codebuddy-auth 插件一致），避免耦合插件 API 的具体版本。
 */
export class V2Bridge implements HostBridge {
  onSessionReset?: (sessionId: string) => void

  private model?: string
  /** 固定工作目录：会话创建时通过 location 指定，避免受插件 location 影响 */
  private workdir?: string
  private modelRef: { providerID: string; id: string } | undefined = undefined
  /** 正被某条 QQ 消息同步等待的会话，用于抑制重复的完成推送 */
  private inFlight = new Set<string>()

  constructor(private ctx: any) {}

  /** 应用（或热更新）配置；模型变化时清掉解析缓存 */
  configure(opts: { model?: string; workdir?: string }): void {
    if (opts.model !== this.model) this.modelRef = undefined
    this.model = opts.model
    this.workdir = opts.workdir
  }

  isInFlight(sessionId: string): boolean {
    return this.inFlight.has(sessionId)
  }

  /**
   * 解析要用的模型：显式配置 > OpenCode 全局默认。
   * 解析失败不缓存，便于配置变更后自动恢复。
   */
  private async resolveModel(): Promise<{ providerID: string; id: string } | null> {
    if (this.modelRef) return this.modelRef

    if (this.model) {
      const i = this.model.indexOf("/")
      if (i > 0) {
        this.modelRef = { providerID: this.model.slice(0, i), id: this.model.slice(i + 1) }
        return this.modelRef
      }
    }

    try {
      const def = await this.ctx?.model?.default?.()
      const providerID = def?.providerID
      const modelID = def?.modelID ?? def?.id
      if (providerID && modelID) {
        this.modelRef = { providerID: String(providerID), id: String(modelID) }
        return this.modelRef
      }
    } catch {
      /* 无默认模型 */
    }
    return null
  }

  async sessionCreate(title: string, directory?: string): Promise<{ id: string }> {
    const model = await this.resolveModel()
    if (!model) {
      throw new Error(
        '未配置模型：请在 opencode-qq.json 设置 "model": "providerID/modelID"，或为 OpenCode 设置全局默认模型',
      )
    }
    const dir = directory ?? this.workdir
    const session = await this.ctx.session.create({
      title,
      model,
      // 固定工作目录（Location.PublicRef = { directory }）
      ...(dir ? { location: { directory: dir } } : {}),
    })
    return { id: String(session.id) }
  }

  async sessionPrompt(
    sessionId: string,
    text: string,
    noReply: boolean,
    files?: PromptFile[],
  ): Promise<{ text: string }> {
    if (noReply) {
      // 只写入上下文，不触发模型回复
      await this.ctx.session.synthetic({ sessionID: sessionId, text })
      return { text: "" }
    }

    const beforeId = await this.lastAssistantId(sessionId)

    this.inFlight.add(sessionId)
    try {
      await this.ctx.session.prompt({
        sessionID: sessionId,
        text,
        ...(files && files.length > 0
          ? { files: files.map((f) => ({ uri: f.dataUrl, ...(f.name ? { name: f.name } : {}) })) }
          : {}),
      })

      return { text: await this.waitForReply(sessionId, beforeId) }
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  private async lastAssistantId(sessionId: string): Promise<string | null> {
    const found = await this.readLastAssistant(sessionId)
    return found?.id ?? null
  }

  private async readLastAssistant(sessionId: string): Promise<{ id: string; text: string } | null> {
    let messages: any[]
    try {
      messages = (await this.ctx.session.context({ sessionID: sessionId })) ?? []
    } catch {
      return null
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m || m.type !== "assistant") continue
      const text = (Array.isArray(m.content) ? m.content : [])
        .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("")
      if (text) return { id: String(m.id), text }
    }
    return null
  }

  private async waitForReply(sessionId: string, beforeId: string | null): Promise<string> {
    const deadline = Date.now() + REPLY_TIMEOUT_MS
    // context() 返回整个会话记录，读取成本随会话增长。
    // 首轮短间隔以尽快拿到结果，之后退避，避免长回合里高频全量读取。
    let delay = 300
    while (Date.now() < deadline) {
      try {
        await this.ctx.session.wait({ sessionID: sessionId })
      } catch {
        /* 会话可能尚未进入 busy，忽略后由轮询兜底 */
      }
      const found = await this.readLastAssistant(sessionId)
      if (found && found.id !== beforeId) return found.text
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(Math.round(delay * 1.5), 3_000)
    }
    return "(等待 OpenCode 回复超时)"
  }
}
