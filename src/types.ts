/** QQ 侧附件（仅图片） */
export type QqAttachment = {
  contentType: "image"
  url: string
  filename?: string
}

/** 网关下发的一条单聊消息 */
export type QqIncoming = {
  openid: string
  content: string
  msgId: string
  timestamp: number
  attachments: QqAttachment[]
  quotedText: string
}

/** 传给宿主（OpenCode）的图片附件 */
export type PromptFile = {
  mime: string
  dataUrl: string
  name?: string
}

/** 工作区声明：QQ 侧只能在这些条目之间切换（不接受任意路径） */
export type Workspace = {
  name: string
  /** 缺省表示跟随插件所在 location */
  path?: string
}

export type QqConfig = {
  appId: string
  appSecret: string
  sandbox: boolean
  allowlist: string[]
  events: { toolProgress: boolean; mirrorSessionText: boolean }
  model?: string
  /**
   * 限额时的备用模型（按顺序挑第一个与当前不同的）。
   * provider 额度耗尽（HTTP 429 / code 6004）时自动切过去并重发，避免整轮停摆。
   * 空数组 = 不启用降级。
   */
  modelFallbacks: string[]
  /** QQ 会话的工作目录；固定后 QQ 指令始终作用于此目录，不受插件 location 影响 */
  workdir?: string
  /** 可切换的工作区白名单；未配置时退化为单一工作区（等价于 workdir） */
  workspaces: Workspace[]
  /** 默认工作区名；缺省取列表第一项 */
  defaultWorkspace?: string
  markdownReply: boolean
  streaming: boolean
}

/**
 * 归一化后的 OpenCode 事件。
 * V2 事件信封形状为 { id, created, metadata?, type, location?, data }，
 * 业务负载统一在 `data` 下（V1 是 `properties`）。
 */
export type InboundEvent = {
  type: string
  data: Record<string, any>
}

/** 宿主桥接接口：session-manager 只依赖这个抽象，不直接碰 ctx / HTTP */
export interface HostBridge {
  /** directory 缺省时由宿主决定（跟随插件 location） */
  sessionCreate(title: string, directory?: string): Promise<{ id: string }>
  /** 返回助手回复文本 */
  sessionPrompt(sessionId: string, text: string, noReply: boolean, files?: PromptFile[]): Promise<{ text: string }>
  onSessionReset?(sessionId: string): void
  isInFlight(sessionId: string): boolean
}

/**
 * 完整宿主能力：插件宿主与独立进程宿主各自实现。
 * 上层编排（src/app.ts）只依赖这个接口，因此同一套逻辑可跑在两种形态下。
 */
export interface BridgeHost extends HostBridge {
  /** 应用（或热更新）配置 */
  configure(opts: { model?: string; workdir?: string }): void
  /** 代答权限请求。两种宿主字段名不同（插件用 reply、HTTP 用 decision），由实现抹平 */
  permissionReply(sessionID: string, requestID: string, decision: "once" | "always" | "reject"): Promise<void>
  /**
   * 切换会话后续回合使用的模型（限额降级用）。
   * 可选：插件宿主未实现，此时 app 层会跳过降级而不是报错。
   */
  switchModel?(sessionID: string, model: string): Promise<void>
  /** 订阅 OpenCode 事件流；实现负责断线重订，直到 signal 被 abort */
  subscribeEvents(sink: (event: InboundEvent) => void, signal: AbortSignal): Promise<void>
  /** 用于日志的身份描述（插件 location 或 HTTP endpoint） */
  describe(): string
}
