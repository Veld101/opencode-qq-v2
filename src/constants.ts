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
/**
 * 等待 OpenCode 单轮执行完成的上限。
 *
 * 取 10 分钟而非更短，是因为实测正常回合经常跑到 5~6 分钟
 * （日志: 总耗时 323s / 346s / 358s），余量不足会把正常慢回合误判成超时。
 * 也不必回到 30 分钟：超时只会在 session.wait 反复报错空转时触发
 * （正常慢回合会一直阻塞在 wait 上直到出结果），30 分钟只是让用户干等。
 */
export const REPLY_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 等待超时时的提示文案。
 *
 * 独立成函数是为了可测：QQ 侧文案不能只靠肉眼保证。
 * 把「最近一次等待错误」带出来，是因为早期实现把 wait 抛的异常整个吞掉，
 * 用户只收到一句无信息的超时提示，499/中断这类真实原因因此完全无迹可查。
 */
export function replyTimeoutMessage(minutes: number, lastWaitError: string | null): string {
  const hint = "会话可能卡在需要你在桌面客户端确认的弹窗上（question / 审批）"
  return lastWaitError
    ? `(等待 OpenCode 回复超时 ${minutes} 分钟：${hint}；最近一次等待错误：${lastWaitError})`
    : `(等待 OpenCode 回复超时 ${minutes} 分钟：${hint})`
}

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
