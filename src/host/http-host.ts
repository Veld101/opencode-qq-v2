import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { REPLY_TIMEOUT_MS, replyTimeoutMessage } from "../constants"
import { log } from "../logger"
import type { BridgeHost, InboundEvent, PromptFile } from "../types"

/**
 * 独立进程宿主：通过 @opencode/client 调 OpenCode V2 HTTP API。
 *
 * 与插件宿主的根本区别：**生命周期不依赖 OpenCode 的 location**。
 * OpenCode 会回收空闲 location 并卸载其插件，插件形态下 QQ 网关会随之消失且无法自愈；
 * 独立进程则一直活着，因此适合 7×24 常驻的机器人。
 *
 * Service.ensure() 会复用已注册的健康服务；缺失时按 `opencode serve --service` 拉起。
 */
export class HttpHost implements BridgeHost {
  onSessionReset?: (sessionId: string) => void

  private model?: string
  private workdir?: string
  private modelRef: { providerID: string; id: string } | undefined = undefined
  private inFlight = new Set<string>()

  private constructor(
    private client: any,
    private endpoint: { url: string },
  ) {}

  /** 连接（必要时拉起）本机 OpenCode 服务 */
  static async connect(): Promise<HttpHost> {
    const endpoint = await Service.ensure()
    const client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint) as any,
    })
    return new HttpHost(client, endpoint)
  }

  /** 服务可达性检查，供启动时快速失败 */
  async health(): Promise<void> {
    const info = await this.client.server.info()
    log("INFO", `OpenCode 服务可达: version=${info?.version ?? "?"} pid=${info?.pid ?? "?"}`)
  }

  configure(opts: { model?: string; workdir?: string }): void {
    if (opts.model !== this.model) this.modelRef = undefined
    this.model = opts.model
    this.workdir = opts.workdir
  }

  describe(): string {
    return `host=http endpoint=${this.endpoint.url}`
  }

  isInFlight(sessionId: string): boolean {
    return this.inFlight.has(sessionId)
  }

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
      // ModelDefaultOutput = { location, data: ModelInfo | null }
      const out = await this.client.model.default()
      const providerID = out?.data?.providerID
      const modelID = out?.data?.id ?? out?.data?.modelID
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
    const session = await this.client.session.create({
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
      await this.client.session.synthetic({ sessionID: sessionId, text })
      return { text: "" }
    }

    const beforeId = await this.lastAssistantId(sessionId)
    this.inFlight.add(sessionId)
    try {
      await this.client.session.prompt({
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
    // HTTP 客户端字段是 decision（插件 ctx 那边叫 reply）
    await this.client.permission.reply({ sessionID, requestID, decision })
  }

  async subscribeEvents(sink: (event: InboundEvent) => void, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const raw of this.client.event.subscribe({ signal })) {
          if (signal.aborted) break
          sink({ type: String((raw as any)?.type ?? ""), data: (raw as any)?.data ?? {} })
        }
      } catch (e) {
        if (signal.aborted) break
        log("WARN", `HTTP 事件订阅中断，2s 后重订: ${String(e).slice(0, 160)}`)
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
      messages = (await this.client.session.context({ sessionID: sessionId })) ?? []
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
    let delay = 300
    /** 最近一次 wait 失败的原文，以及失败次数（超时提示要带上它，否则无从排查） */
    let lastWaitError: string | null = null
    let waitErrors = 0

    while (Date.now() < deadline) {
      try {
        await this.client.session.wait({ sessionID: sessionId })
      } catch (e) {
        // 不能静默吞掉：正常慢回合会一直阻塞在 wait 上直到出结果，
        // 只有 wait 反复报错（如 499 / All fibers interrupted）才会走到这里空转。
        waitErrors++
        lastWaitError = String(e).slice(0, 200)
      }
      const found = await this.readLastAssistant(sessionId)
      if (found && found.id !== beforeId) return found.text
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(Math.round(delay * 1.5), 3_000)
    }

    const minutes = Math.round(REPLY_TIMEOUT_MS / 60_000)
    log(
      "WARN",
      `等待会话回复超时 ${minutes} 分钟 session=${sessionId} wait失败=${waitErrors}次 ` +
        `最近错误=${lastWaitError ?? "（无）"}`,
    )
    return replyTimeoutMessage(minutes, lastWaitError)
  }
}
