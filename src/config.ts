import fs from "node:fs"
import { CONFIG_PATH } from "./constants"
import type { QqConfig } from "./types"

/**
 * 配置来源优先级：环境变量 > 配置文件。
 * 任一缺失 appId/appSecret 则返回 null（插件静默禁用，不影响 opencode 启动）。
 */
export function loadConfig(path: string = CONFIG_PATH()): QqConfig | null {
  let file: Record<string, any> = {}
  try {
    file = JSON.parse(fs.readFileSync(path, "utf8"))
  } catch {
    // 文件不存在或非法不致命，凭据可完全来自环境变量
  }

  const appId = process.env.QQ_BOT_APPID ?? file.appId
  const appSecret = process.env.QQ_BOT_APPSECRET ?? file.appSecret
  if (!appId || !appSecret) return null

  // 模板占位符视为未配置，避免反复打接口并给出清晰提示
  const PLACEHOLDERS = new Set(["REPLACE_ME_APPID", "REPLACE_ME_APPSECRET", "你的AppID", "你的AppSecret"])
  if (PLACEHOLDERS.has(String(appId)) || PLACEHOLDERS.has(String(appSecret))) {
    console.warn(`[opencode-qq] 凭据仍是模板占位符，请填写真实的 AppID/AppSecret（文件：${path}）`)
    return null
  }

  const modelRaw = process.env.QQ_BOT_MODEL ?? file.model
  const workdirRaw = process.env.QQ_BOT_WORKDIR ?? file.workdir

  return {
    appId: String(appId),
    appSecret: String(appSecret),
    sandbox: file.sandbox ?? false,
    allowlist: Array.isArray(file.allowlist) ? file.allowlist.map(String) : [],
    events: { toolProgress: file.events?.toolProgress ?? false },
    model: typeof modelRaw === "string" && modelRaw.length > 0 ? modelRaw : undefined,
    workdir: typeof workdirRaw === "string" && workdirRaw.length > 0 ? workdirRaw : undefined,
    markdownReply: file.markdownReply ?? true,
    // 默认关闭流式：先用「等待完成 + 读取最终文本」的可靠路径跑通，验证后再开
    streaming: file.streaming ?? false,
  }
}
