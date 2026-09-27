import fs from "node:fs"
import { LOG_PATH } from "./constants"

let initialized = false

function rotateIfNeeded(): void {
  if (initialized) return
  initialized = true
  try {
    const st = fs.statSync(LOG_PATH())
    // 超过 2MB 滚动一次，避免长期运行无限增长
    if (st.size > 2 * 1024 * 1024) fs.renameSync(LOG_PATH(), `${LOG_PATH()}.1`)
  } catch {
    /* 文件不存在 */
  }
}

/**
 * 插件运行日志。
 * OpenCode 不采集插件 stdout，因此单独落盘，便于排查链路问题。
 * 绝不记录 AppSecret / access_token。
 */
export function log(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const line = `${new Date().toISOString()} ${level} ${message}\n`
  try {
    rotateIfNeeded()
    fs.appendFileSync(LOG_PATH(), line, "utf8")
  } catch {
    /* 落盘失败不影响主流程 */
  }
  const fn = level === "ERROR" ? console.error : console.log
  fn(`[opencode-qq] ${message}`)
}
