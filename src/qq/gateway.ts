import { GATEWAY_PATH } from "../constants"
import { extractQuotedText } from "../util/quote"
import type { QqIncoming } from "../types"

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

/** 这些 close code 表示会话不可 Resume，必须清空 session 重新 Identify */
const NON_RESUMABLE_CLOSE = new Set([4004, 4006, 4007, 4009, 4010, 4011, 4012, 4013, 4014])

export type GatewayOpts = {
  getGatewayUrl: () => Promise<string>
  getToken: () => Promise<string>
  intents: number
  connected: () => void
  disconnected: () => void
  message: (msg: QqIncoming) => void | Promise<void>
  /** 可选：原始事件调试钩子（用于协议字段漂移排查） */
  onEvent?: (type: string, data: Record<string, any>) => void
  /** 可选：心跳假死检测触发（连接还在但服务端不再响应心跳） */
  onStale?: (detail: string) => void
  /** 可选：连接关闭（用于判断是平台主动关、代理断开还是会话过期） */
  onClose?: (code: number, reason: string) => void
  maxSeen?: number
  reconnectBaseMs?: number
}

/**
 * 心跳假死判定。
 *
 * 只发心跳不校验 ACK 是不够的：经代理（尤其 fake-ip/TUN）时，
 * 经常出现 TCP 仍 Established、上游早已失效的情况——表现为「明明显示已连接，却收不到任何消息」。
 * 连续 2 次未收到 ACK，或距上次 ACK 超过 3 个心跳周期，即判定假死并强制重连。
 */
export function isHeartbeatStale(pendingHeartbeats: number, sinceAckMs: number, intervalMs: number): boolean {
  return pendingHeartbeats >= 2 || sinceAckMs > intervalMs * 3
}

/** 解析 QQ 官方单聊消息事件，兼容两种字段形状 */
export function parseC2CMessage(d: Record<string, any>): QqIncoming {
  // 字段形状兼容：
  //  · QQ 官方单聊(v2)：用户标识在 author.user_openid，消息 id 在 d.id
  //  · 旧版/频道风格：顶层的 d.openid / d.msg_id
  const author = (d.author ?? {}) as Record<string, any>
  const rawAttachments = Array.isArray(d.attachments) ? d.attachments : []
  return {
    openid: String(author.user_openid ?? author.id ?? d.openid ?? ""),
    content: String(d.content ?? ""),
    msgId: String(d.id ?? d.msg_id ?? ""),
    timestamp: Date.parse(String(d.timestamp ?? "")) || Date.now(),
    attachments: rawAttachments
      .filter((a: any) => !!a && typeof a === "object")
      .filter(
        (a: any) =>
          String(a.content_type ?? a.contentType ?? "") === "image" ||
          String(a.url ?? "").match(/\.(png|jpe?g|gif|webp)/i),
      )
      .map((a: any) => ({
        contentType: "image" as const,
        url: String(a.url ?? ""),
        filename: a.filename === undefined ? undefined : String(a.filename),
      }))
      .filter((a: any) => a.url),
    quotedText: extractQuotedText(d),
  }
}

export class QQGateway {
  private ws: WebSocket | null = null
  private sessionId: string | null = null
  private lastSeq: number | null = null
  private resumeAttempted = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** 最近一次收到心跳 ACK 的时间，用于假死检测 */
  private lastAckAt = 0
  /** 已发出但尚未收到 ACK 的心跳数 */
  private pendingHeartbeats = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private stopped = false
  private seenIds = new Set<string>()
  private seenOrder: string[] = []

  constructor(private opts: GatewayOpts) {}

  private isDuplicate(key: string): boolean {
    if (!key) return false
    if (this.seenIds.has(key)) return true
    this.seenIds.add(key)
    this.seenOrder.push(key)
    const cap = this.opts.maxSeen ?? 1000
    if (this.seenOrder.length > cap) {
      const oldest = this.seenOrder.shift()
      if (oldest !== undefined) this.seenIds.delete(oldest)
    }
    return false
  }

  start(): void {
    this.stopped = false
    this.connect().catch(() => this.scheduleReconnect())
  }

  stop(): void {
    this.stopped = true
    this.cleanup()
  }

  private cleanup(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.ws) {
      const ws = this.ws
      // 断开所有回调，避免 close 事件再次触发重连
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    this.ws = null
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.resumeAttempted) {
      // Resume 也失败了 → 放弃会话，下次走 Identify
      this.resumeAttempted = false
      this.sessionId = null
      this.lastSeq = null
    }
    const base = this.opts.reconnectBaseMs ?? 1000
    const delay = Math.min(base * 2 ** this.reconnectAttempt, 60_000)
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return
      this.connect().catch(() => this.scheduleReconnect())
    }, delay)
  }

  private async connect(): Promise<void> {
    const url = await this.opts.getGatewayUrl()
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onmessage = (ev: MessageEvent) => {
      let pkt: any
      try {
        pkt = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data))
      } catch (e) {
        console.warn(`[opencode-qq] 丢弃非 JSON 网关帧: ${String(e).slice(0, 120)}`)
        return
      }
      this.handlePacket(pkt)
    }

    ws.onclose = (ev: CloseEvent) => {
      this.opts.onClose?.(Number(ev.code ?? 0), String(ev.reason ?? ""))
      if (NON_RESUMABLE_CLOSE.has(ev.code)) {
        this.sessionId = null
        this.lastSeq = null
        this.resumeAttempted = false
      }
      this.opts.disconnected()
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  private handlePacket(pkt: any): void {
    switch (pkt.op) {
      case OP_HELLO: {
        const interval = Number(pkt.d?.heartbeat_interval ?? 45000)
        this.startHeartbeat(interval)
        if (this.sessionId !== null && this.lastSeq !== null) {
          this.resumeAttempted = true
          void this.sendResume().catch(() => this.ws?.close())
        } else {
          this.resumeAttempted = false
          void this.sendIdentify().catch(() => this.ws?.close())
        }
        break
      }
      case OP_HEARTBEAT_ACK:
        this.lastAckAt = Date.now()
        this.pendingHeartbeats = 0
        break
      case OP_INVALID_SESSION: {
        // 服务端拒绝 Resume：清空会话后重新 Identify，否则会一直重连失败
        this.sessionId = null
        this.lastSeq = null
        this.resumeAttempted = false
        void this.sendIdentify().catch(() => this.ws?.close())
        break
      }
      case OP_DISPATCH: {
        this.lastSeq = typeof pkt.s === "number" ? pkt.s : this.lastSeq
        const d = (pkt.d ?? {}) as Record<string, any>
        const key: string = pkt.id ?? String(d.msg_id ?? "")
        if (this.isDuplicate(key)) return
        this.handleDispatch(String(pkt.t ?? ""), d)
        break
      }
      default:
        break
    }
  }

  private async sendIdentify(): Promise<void> {
    const token = await this.opts.getToken()
    this.ws?.send(
      JSON.stringify({
        op: OP_IDENTIFY,
        d: { token: `QQBot ${token}`, intents: this.opts.intents, shard: [0, 1] },
      }),
    )
  }

  private async sendResume(): Promise<void> {
    const token = await this.opts.getToken()
    this.ws?.send(
      JSON.stringify({
        op: OP_RESUME,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
      }),
    )
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.lastAckAt = Date.now()
    this.pendingHeartbeats = 0
    this.heartbeatTimer = setInterval(() => {
      const sinceAck = Date.now() - this.lastAckAt
      if (isHeartbeatStale(this.pendingHeartbeats, sinceAck, intervalMs)) {
        // 假死：主动拆连接并重连（不能只调 close()，僵尸连接可能永远等不到 close 事件）
        this.opts.onStale?.(
          `连续 ${this.pendingHeartbeats} 次心跳未 ACK，距上次 ACK ${Math.round(sinceAck / 1000)}s`,
        )
        // 假死意味着服务端侧的会话大概率已失效，放弃 Resume，下一轮重新 Identify
        this.sessionId = null
        this.lastSeq = null
        this.resumeAttempted = false
        this.cleanup()
        this.opts.disconnected()
        this.scheduleReconnect()
        return
      }
      this.pendingHeartbeats++
      this.ws?.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq }))
    }, intervalMs)
  }

  private handleDispatch(t: string, d: Record<string, any>): void {
    this.opts.onEvent?.(t, d)

    if (t === "READY") {
      this.sessionId = String(d.session_id ?? "")
      this.resumeAttempted = false
      this.reconnectAttempt = 0
      this.opts.connected()
      return
    }
    if (t === "RESUMED") {
      this.resumeAttempted = false
      this.reconnectAttempt = 0
      this.opts.connected()
      return
    }
    if (t === "C2C_MESSAGE_CREATE") {
      void this.opts.message(parseC2CMessage(d))
    }
  }
}

/** 获取网关地址。注意：/gateway 需要 Authorization 头，缺失会被拒。 */
export function createGatewayUrlFetcher(
  restBase: string,
  getToken: () => Promise<string>,
  fetchFn: typeof fetch = fetch,
): () => Promise<string> {
  return async () => {
    const token = await getToken()
    const res = await fetchFn(`${restBase}${GATEWAY_PATH}`, {
      headers: { Authorization: `QQBot ${token}` },
    })
    if (!res.ok) throw new Error(`get gateway failed: HTTP ${res.status} ${await res.text()}`)
    const data = (await res.json()) as { url?: string }
    if (!data.url) throw new Error("get gateway failed: empty url")
    return data.url
  }
}
