import { REPLY_TIMEOUT_MS } from "../constants"
import { log } from "../logger"
import type { BridgeHost, InboundEvent, PromptFile } from "../types"

/**
 * 插件宿主：跑在 OpenCode 插件运行时内，通过 setup(ctx) 拿到的上下文行事。
 *
 * 与 V2 插件 API 的对接要点（已核对 V2 OpenAPI / 插件文档）：
 *  - ctx.session.prompt 只投递消息，不返回回复 → 需 wait 后读 context
 *  - ctx.session.synthetic 注入不触发回复的消息
 *  - ctx.permission.reply 的字段是 `reply`（HTTP 客户端那边叫 `decision`）
 *  - ctx.event.subscribe 提供公开事件流
 *
 * ctx 用宽松类型（与同机 codebuddy-auth 插件一致），避免耦合插件 API 的具体版本。
 *
 * 注意：插件形态的生命周期绑在 OpenCode 的 location 上——
 * location 被回收时本插件会被卸载，QQ 网关随之停止且无法自愈。
 * 需要 7×24 常驻请用独立进程形态（src/host/http-host.ts + bridge.ts）。
 */
export class PluginHost implements BridgeHost {
  onSessionReset?: (sessionId: string) => void

  private model?: string
  private workdir?: string
  private modelRef: { providerID: string; id: string } | undefined = undefined
  private inFlight = new Set<string>()

  constructor(private ctx: any) {}

  configure(opts: { model?: string; workdir?: string }): void {
    if (opts.model !== this.model) this.modelRef = undefined
    this.model = opts.model
    this.workdir = opts.workdir
  }

  describe(): string {
    return `host=plugin location=${this.ctx?.location?.directory ?? "?"}`
  }

  isInFlight(sessionId: string): boolean {
    return this.inFlight.has(sessionId)
  }

  /** 显式配置 > OpenCode 全局默认；失败不缓存，便于配置变更后自动恢复 */
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

  async permissionReply(sessionID: string, requestID: string, decision: "once" | "always" | "reject"): Promise<void> {
    await this.ctx.permission.reply({ sessionID, requestID, reply: decision })
  }

  async subscribeEvents(sink: (event: InboundEvent) => void, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const raw of this.ctx.event.subscribe({ signal })) {
          if (signal.aborted) break
          sink({ type: String((raw as any)?.type ?? ""), data: (raw as any)?.data ?? {} })
        }
      } catch (e) {
        if (signal.aborted) break
        log("WARN", `插件事件订阅中断，2s 后重订: ${String(e).slice(0, 160)}`)
        await new Promise((r) => setTimeout(r, 2000))
      }
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
