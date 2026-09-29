import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { configDir } from "./constants"

type LockFile = { pid?: number; token?: string; at?: number }

/**
 * 跨实例互斥锁（文件锁 + 实例令牌 + 心跳 + TTL 接管）。
 *
 * 为什么需要：OpenCode 会**按 location 加载同一插件的多个实例**（同一进程内），
 * 且服务本身也可能是多进程。若每个实例都去连 QQ 网关，同一机器人会有多条 WS 会话，
 * 导致重复收消息、被平台踢下线、用户收到重复回复。
 *
 * 关键点：锁归属必须是「实例」而不是「进程」。
 * 早期版本只比对 pid，导致同进程内旧实例 dispose 时把新实例刚建的锁删掉，
 * 新实例于是误判「无人持有」又起一个网关 —— 已用 token 修正。
 */
export class InstanceLock {
  private file: string
  /** 本实例的唯一令牌；只有令牌匹配才允许释放锁 */
  private readonly token = randomUUID()
  private held = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    name: string,
    private ttlMs = 60_000,
  ) {
    this.file = path.join(configDir(), `${name}.lock`)
  }

  get path(): string {
    return this.file
  }

  get isHeld(): boolean {
    return this.held
  }

  /** 尝试获取锁；成功返回 true，被其他存活实例持有返回 false */
  acquire(): boolean {
    if (this.held) return true

    // 排他创建抢占
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.payload()), { flag: "wx" })
      this.onAcquired()
      return true
    } catch {
      /* 已存在，继续判断是否陈旧 */
    }

    // 已存在 → 持有者心跳过期，或持有进程已不存在，才接管
    try {
      const raw = this.read()
      const age = Date.now() - Number(raw?.at ?? 0)
      const staleByTime = !raw?.at || Number.isNaN(age) || age > this.ttlMs
      const ownerGone = !this.isProcessAlive(Number(raw?.pid))
      if (staleByTime || ownerGone) {
        fs.writeFileSync(this.file, JSON.stringify(this.payload()))
        this.onAcquired()
        return true
      }
    } catch {
      /* 读取/解析失败一律视为被占用，避免抢占正在初始化的持有者 */
    }
    return false
  }

  /**
   * 判断锁持有进程是否还活着。
   * 同进程直接视为活着——同进程内多实例的互斥交由令牌逻辑处理，
   * 否则后加载的实例会把先前实例的锁抢走，导致同时存在两个网关。
   */
  private isProcessAlive(pid: number): boolean {
    if (!pid || pid === process.pid) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (e: any) {
      // EPERM：进程存在但无权限 → 视为活着；ESRCH/EINVAL 等 → 视为已退出
      return e?.code === "EPERM"
    }
  }

  private payload(): LockFile {
    return { pid: process.pid, token: this.token, at: Date.now() }
  }

  private read(): LockFile {
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as LockFile
  }

  private onAcquired(): void {
    this.held = true
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(
      () => {
        if (!this.held) return
        try {
          // 只有仍是我们持有才续期；令牌被别人接管则放弃
          if (this.read().token === this.token) {
            fs.writeFileSync(this.file, JSON.stringify(this.payload()))
          } else {
            this.held = false
          }
        } catch {
          /* 心跳失败不致命 */
        }
      },
      Math.max(5_000, Math.floor(this.ttlMs / 3)),
    )
  }

  /** 释放锁：仅当锁仍属于本实例（令牌匹配）时才删除 */
  release(): void {
    this.held = false
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    try {
      if (this.read().token === this.token) fs.unlinkSync(this.file)
    } catch {
      /* ignore */
    }
  }
}
