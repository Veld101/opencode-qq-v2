import fs from "node:fs"
import path from "node:path"
import { configDir } from "../constants"

/** 网关会话（Resume 所需的最小状态） */
export type GatewaySession = {
  sessionId: string
  lastSeq: number
  /** 落盘时间，仅用于排查 */
  at: number
}

export interface SessionStore {
  load(): GatewaySession | null
  save(session: GatewaySession): void
  clear(): void
}

/**
 * 会话落盘位置：放在本实例自己的配置目录下。
 *
 * 多机器人是「一进程一配置目录」，所以这份文件天然按机器人隔离，
 * 不会出现两个机器人互相 Resume 对方会话的情况。
 */
export function gatewaySessionPath(): string {
  return path.join(configDir(), "opencode-qq-gateway-session.json")
}

/**
 * 把网关会话落到磁盘，供进程重启后继续 Resume。
 *
 * 为什么需要：官方文档「恢复登录态 Session」说明——websocket 断开后短时间内重连，
 * 网关会补发中间遗漏的事件；前提是客户端能提供 session_id + seq。
 * 这两个值原先只存在内存里，进程一重启就归零，于是重启窗口内的消息全丢。
 *
 * 任何读取失败（文件不存在、JSON 损坏、字段缺失）都返回 null 而不是抛异常：
 * 宁可退回 Identify 开新会话，也不能让网关起不来。
 */
export class FileSessionStore implements SessionStore {
  constructor(private file: string = gatewaySessionPath()) {}

  load(): GatewaySession | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as any
      if (!raw || typeof raw !== "object") return null
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : ""
      const lastSeq =
        typeof raw.lastSeq === "number" && Number.isFinite(raw.lastSeq) ? raw.lastSeq : null
      if (!sessionId || lastSeq === null) return null
      return { sessionId, lastSeq, at: Number(raw.at ?? 0) }
    } catch {
      return null
    }
  }

  save(session: GatewaySession): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(session), "utf8")
    } catch {
      /* 落盘失败不影响网关主流程 */
    }
  }

  clear(): void {
    try {
      fs.rmSync(this.file, { force: true })
    } catch {
      /* ignore */
    }
  }
}
