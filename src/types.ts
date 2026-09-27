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
  events: { toolProgress: boolean }
  model?: string
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

/** 宿主桥接接口：session-manager 只依赖这个抽象，不直接碰 ctx */
export interface HostBridge {
  /** directory 缺省时由宿主决定（跟随插件 location） */
  sessionCreate(title: string, directory?: string): Promise<{ id: string }>
  /** 返回助手回复文本 */
  sessionPrompt(sessionId: string, text: string, noReply: boolean, files?: PromptFile[]): Promise<{ text: string }>
  onSessionReset?(sessionId: string): void
}
