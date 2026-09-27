import os from "node:os"
import path from "node:path"

/** 获取 access_token（官方文档：Token 鉴权已废弃，改用 AppID + AppSecret 换 access_token） */
export const TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken"
/** 正式环境 REST 基址 */
export const REST_BASE_PROD = "https://api.bot.qq.com"
/** 沙箱环境 REST 基址 */
export const REST_BASE_SANDBOX = "https://sandbox.api.sgroup.qq.com"

/** 单聊 + 群@ 事件 intent（GROUP_AND_C2C_EVENT = 1 << 25） */
export const INTENT_GROUP_AND_C2C = 1 << 25

/** 单聊被动回复窗口：收到消息后 60 分钟 */
export const PASSIVE_WINDOW_MS = 60 * 60 * 1000
/** 每条收到的消息最多被动回复次数（ack + 结果等） */
export const MAX_REPLIES_PER_MSG_ID = 4
/** QQ 侧权限审批等待超时 */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
/** 流式打字机节流间隔 */
export const STREAM_FLUSH_INTERVAL_MS = 1200
/** 等待 OpenCode 单轮执行完成的上限 */
export const REPLY_TIMEOUT_MS = 30 * 60 * 1000

/**
 * OpenCode 配置目录。
 * 注意：Windows 下 opencode 进程常常没有 HOME 环境变量，必须回退到 os.homedir()。
 */
export function configDir(): string {
  if (process.env.OPENCODE_QQ_CONFIG_DIR) return process.env.OPENCODE_QQ_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

export const CONFIG_PATH = (): string =>
  process.env.OPENCODE_QQ_CONFIG ?? path.join(configDir(), "opencode-qq.json")

export const SESSIONS_PATH = (): string => path.join(configDir(), "opencode-qq-sessions.json")

/** 插件运行日志（OpenCode 不采集插件 stdout，故独立落盘） */
export const LOG_PATH = (): string => path.join(configDir(), "opencode-qq.log")

/** 获取 WebSocket 网关地址的 REST 路径 */
export const GATEWAY_PATH = "/gateway"
