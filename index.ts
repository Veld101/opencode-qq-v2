import fs from "node:fs"
// opencode-qq：QQ 官方机器人（单聊）↔ OpenCode V2 插件
//
// 启动顺序：读配置 → 建桥接 → 订阅事件 → 抢实例锁 → 启网关 → 节流刷流式
// 配置热更新：轮询 opencode-qq.json 的 mtime，变化即重新应用（无需重启或改源码触发重载）。
import { Approver } from "./src/approver"
import { loadConfig } from "./src/config"
import { QQGateway, createGatewayUrlFetcher } from "./src/qq/gateway"
import { QQApi, reserveSeq } from "./src/qq/api"
import { AuthManager } from "./src/qq/auth"
import { StreamSender } from "./src/qq/stream"
import { EventPusher } from "./src/event-pusher"
import { AssistantTextBuffer } from "./src/text-buffer"
import { SessionManager } from "./src/session-manager"
import { resolveWorkspaces } from "./src/workspaces"
import { V2Bridge } from "./src/bridge"
import { splitText } from "./src/util/chunk"
import { guessImageMime, toImageDataUrl } from "./src/util/media"
import { log } from "./src/logger"
import { InstanceLock } from "./src/lock"
import {
  APPROVAL_TIMEOUT_MS,
  CONFIG_PATH,
  INTENT_GROUP_AND_C2C,
  LOG_PATH,
  PASSIVE_WINDOW_MS,
  REST_BASE_PROD,
  REST_BASE_SANDBOX,
  SESSIONS_PATH,
  STREAM_FLUSH_INTERVAL_MS,
} from "./src/constants"
import type { InboundEvent, PromptFile, QqConfig } from "./src/types"

/** 配置轮询间隔 */
const CONFIG_POLL_MS = 3000

/** 从权限事件里抽一句人类可读的摘要 */
function permissionSummary(data: Record<string, any>): string {
  const action = String(data?.action ?? "操作")
  const resources = Array.isArray(data?.resources) ? data.resources.map(String) : []
  const detail = resources.slice(0, 3).join(", ")
  const extra = typeof data?.message === "string" && data.message ? ` (${data.message})` : ""
  return `${action}${detail ? `: ${detail}` : ""}${extra}`.slice(0, 200)
}

/** 文件 mtime；不存在返回 0（可感知创建/删除） */
function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}

export default {
  id: "opencode-qq",

  async setup(ctx: any) {
    // ── 可变配置相关状态（支持热更新）────────────────────────────────────
    let cfg: QqConfig | null = loadConfig()
    let allowSet = new Set(cfg?.allowlist ?? [])
    let restBase = cfg?.sandbox ? REST_BASE_SANDBOX : REST_BASE_PROD
    let auth: AuthManager | null = cfg ? new AuthManager(cfg.appId, cfg.appSecret) : null
    let api: QQApi | null = cfg ? new QQApi({ restBase, getToken: () => auth!.getToken() }) : null

    const approver = new Approver(APPROVAL_TIMEOUT_MS)

    // ── 宿主桥接 ────────────────────────────────────────────────────────────
    const bridge = new V2Bridge(ctx)
    const sessions = new SessionManager(bridge, SESSIONS_PATH(), fs, (sid) => approver.countBySession(sid))
    bridge.onSessionReset = (sid) => approver.clearSession(sid)
    if (cfg) sessions.setWorkspaces(resolveWorkspaces(cfg))

    // ── 事件订阅 ────────────────────────────────────────────────────────────
    const listeners: Array<(e: InboundEvent) => void> = []
    const assistantBuf = new AssistantTextBuffer((sid) => sessions.isOurSession(sid))

    const openidOfSession = (sessionId: string): string | null => sessions.openidOfSession(sessionId)

    /** 延迟埋点：openid → 本回合时间线，用于定位「到底慢在哪」 */
    const timings = new Map<string, { t0: number; firstTextAt: number | null; tools: number }>()

    const pusher = new EventPusher({
      isOurSession: (sid) => sessions.isOurSession(sid),
      openidOfSession,
      isTurnInFlight: (sid) => bridge.isInFlight(sid),
      send: async (openid, text) => {
        if (!api) return
        for (const part of splitText(text)) await api.sendC2C(openid, part)
      },
      toolProgress: () => cfg?.events.toolProgress ?? false,
      lastAssistantText: (sid) => assistantBuf.text(sid),
      subscribe: (h) => listeners.push(h),
    })

    // 权限请求 → 编号推送
    listeners.push((e) => {
      if (e.type !== "permission.asked") return
      const sessionId = String(e.data?.sessionID ?? "")
      const permissionId = String(e.data?.id ?? "")
      if (!sessions.isOurSession(sessionId) || !permissionId) return
      const seq = approver.register(sessionId, permissionId, permissionSummary(e.data ?? {}))
      const openid = openidOfSession(sessionId)
      log("INFO", `权限请求 #${seq} session=${sessionId} openid=${openid ?? "?"} ${permissionSummary(e.data ?? {})}`)
      if (openid) void replyTo(openid, approver.render(seq))
    })

    // 文本缓冲：供流式、进度提示与「任务完成」摘要使用
    listeners.push((e) => {
      assistantBuf.handle(e)

      // 埋点：本回合首个文本片出现的时间（= 用户视角的「首字延迟」）与工具调用次数
      if (e.type === "session.text.delta" || e.type === "session.text.ended") {
        const sid = String(e.data?.sessionID ?? "")
        const openid = sid ? openidOfSession(sid) : null
        if (openid) {
          const t = timings.get(openid)
          if (t && t.firstTextAt === null) t.firstTextAt = Date.now()
        }
      }
      if (e.type === "session.tool.called") {
        const sid = String(e.data?.sessionID ?? "")
        const openid = sid ? openidOfSession(sid) : null
        if (openid) {
          const t = timings.get(openid)
          if (t) t.tools++
        }
      }

      if (e.type === "session.idle" || e.type === "session.execution.failed" || e.type === "session.execution.succeeded") {
        const sid = String(e.data?.sessionID ?? "")
        if (sid) setTimeout(() => assistantBuf.clear(sid), 5000)
      }
    })

    // 订阅公开事件流（source 断开后重订）
    const abort = new AbortController()
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const raw of ctx.event.subscribe({ signal: abort.signal })) {
            if (abort.signal.aborted) break
            const evt: InboundEvent = { type: String((raw as any).type ?? ""), data: (raw as any).data ?? {} }
            for (const h of [...listeners]) h(evt)
          }
        } catch (e) {
          if (abort.signal.aborted) break
          log("WARN", `事件订阅中断，2s 后重订: ${String(e).slice(0, 160)}`)
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    })()

    // ── 下行：QQ 消息处理 ───────────────────────────────────────────────────
    const passiveRefs = new Map<string, { msgId: string; receivedAt: number }>()
    const pendingNotice = new Map<string, string>()
    const streams = new Map<
      string,
      { sender: StreamSender | null; msgId: string; msgSeq: number; lastLen: number }
    >()

    const beginStream = (openid: string) => {
      if (!cfg?.streaming) return null
      const ref = passiveRefs.get(openid)
      if (!ref) return null
      // 预留一个被动序号；额度不足就不走流式，把额度留给最终回答
      const msgSeq = reserveSeq(ref.msgId)
      if (msgSeq === undefined) return null
      const old = streams.get(openid)
      if (old?.sender) old.sender.failed = true
      const ctxStream = { sender: null as StreamSender | null, msgId: ref.msgId, msgSeq, lastLen: 0 }
      streams.set(openid, ctxStream)
      return ctxStream
    }

    const endStream = (openid: string, fullText: string, handle: ReturnType<typeof beginStream>): boolean => {
      const current = streams.get(openid)
      if (!handle || current !== handle) return false
      streams.delete(openid)
      if (!handle.sender || handle.sender.failed) return false
      void handle.sender.finish(fullText)
      return true
    }

    /** 发送并反馈是否真的送达（QQ 返回 HTTP 200 才算成功） */
    async function replyTo(openid: string, text: string, format: "text" | "markdown" = "text"): Promise<boolean> {
      if (!api) {
        log("WARN", `未配置凭据，无法发送: ${text.slice(0, 40)}`)
        return false
      }
      const ref = passiveRefs.get(openid)
      let delivered = true
      for (const chunk of splitText(text)) {
        const usePassive = !!ref && Date.now() - ref.receivedAt < PASSIVE_WINDOW_MS
        try {
          await api.sendC2C(openid, chunk, usePassive ? { msgId: ref!.msgId, format } : { format })
        } catch (e) {
          delivered = false
          // 早期版本静默吞掉发送异常，导致「日志显示已回复、用户却收不到」的假象
          log("ERROR", `发送失败 openid=${openid || "(空)"} passive=${usePassive}: ${String(e).slice(0, 200)}`)
          if (!usePassive) pendingNotice.set(openid, "（此前有未能送达的消息）")
        }
      }
      return delivered
    }

    // ── 网关（每次用当前配置重建，以支持热更新）──────────────────────────────
    const gatewayOpts = () => ({
      getGatewayUrl: createGatewayUrlFetcher(restBase, () => auth!.getToken()),
      getToken: () => auth!.getToken(),
      intents: INTENT_GROUP_AND_C2C,
      // 协议字段漂移排查：记录单聊原始事件（省略 content，避免记录聊天内容）
      onEvent: (type: string, data: Record<string, any>) => {
        if (type !== "C2C_MESSAGE_CREATE") return
        const { content: _omit, ...rest } = data
        log("INFO", `原始事件 ${type}（省略 content）: ${JSON.stringify(rest).slice(0, 600)}`)
      },
      connected: () => {
        pusher.setOnline(true)
        log("INFO", `网关已连接${cfg?.sandbox ? "（沙箱）" : "（正式）"}`)
      },
      disconnected: () => {
        pusher.setOnline(false)
        log("WARN", "网关连接断开，正在重连")
      },
      onStale: (detail: string) => {
        pusher.setOnline(false)
        log("WARN", `网关心跳假死（${detail}），强制重连`)
      },
      onClose: (code: number, reason: string) => {
        // 4009=会话过期 / 4006=无效会话 / 1000=正常关闭 / 1006=异常断开（常见于代理）
        log("WARN", `网关连接关闭 code=${code}${reason ? ` reason=${reason}` : ""}`)
      },
      message: async (msg: any) => {
        let stream: ReturnType<typeof beginStream> = null
        try {
          if (!msg.openid) {
            log("ERROR", `事件缺少 openid，无法回复；msgId=${msg.msgId || "(空)"}（QQ 事件字段可能又变了）`)
            return
          }
          if (allowSet.size > 0 && !allowSet.has(msg.openid)) {
            log("WARN", `消息被 allowlist 拒绝 openid=${msg.openid}`)
            return
          }
          log(
            "INFO",
            `收到消息 openid=${msg.openid} msgId=${msg.msgId} 附件=${msg.attachments.length} 字数=${msg.content.length}`,
          )

          passiveRefs.set(msg.openid, { msgId: msg.msgId, receivedAt: Date.now() })
          await replyTo(msg.openid, "已收到，处理中…")

          // 审批回复优先于普通对话
          const parsed = approver.parseReply(msg.content.trim())
          if (parsed) {
            const item = approver.confirm(parsed.seq)
            if (!item) {
              await replyTo(msg.openid, `#${parsed.seq} 不存在或已超时。`)
              return
            }
            await ctx.permission.reply({
              sessionID: item.sessionId,
              requestID: item.permissionId,
              reply: parsed.reply,
            })
            await replyTo(msg.openid, `已${parsed.reply === "reject" ? "拒绝" : "批准"} #${parsed.seq}`)
            return
          }

          const notice = pendingNotice.get(msg.openid)
          pendingNotice.delete(msg.openid)

          const files: PromptFile[] = []
          for (const att of msg.attachments ?? []) {
            try {
              files.push({ mime: guessImageMime(att.url), dataUrl: await toImageDataUrl(att.url) })
            } catch {
              await replyTo(msg.openid, "⚠️ 图片下载失败，仅处理文字部分").catch(() => {})
            }
          }

          const promptText =
            (msg.quotedText ? `[引用消息] ${msg.quotedText}\n` : "") +
            (files.length ? `[图片 x${files.length}] ` : "") +
            msg.content

          const timing = { t0: Date.now(), firstTextAt: null as number | null, tools: 0 }
          timings.set(msg.openid, timing)
          stream = beginStream(msg.openid)
          let answer: string
          try {
            answer = await sessions.dispatch(msg.openid, promptText, files)
          } finally {
            timings.delete(msg.openid)
          }
          const deliveredByStream = endStream(msg.openid, answer, stream)
          let delivered = true
          if (!deliveredByStream) {
            delivered = await replyTo(
              msg.openid,
              (notice ? `${notice}\n` : "") + answer,
              cfg?.markdownReply ? "markdown" : "text",
            )
          }
          const firstTextMs = timing.firstTextAt === null ? null : timing.firstTextAt - timing.t0
          log(
            delivered ? "INFO" : "ERROR",
            `${delivered ? "已回复" : "回复未送达"} openid=${msg.openid} 字数=${answer.length} ` +
              `流式=${deliveredByStream} 首字=${firstTextMs === null ? "无" : `${firstTextMs}ms`} ` +
              `工具=${timing.tools} 总耗时=${Date.now() - timing.t0}ms`,
          )
        } catch (e) {
          if (stream && streams.get(msg.openid) === stream) streams.delete(msg.openid)
          log("ERROR", `处理失败 openid=${msg.openid}: ${String(e).slice(0, 300)}`)
          await replyTo(msg.openid, `处理失败: ${String(e).slice(0, 200)}`).catch(() => {})
        }
      },
    })

    // 流式打字机：按节流把累计全文推给 QQ（每片是全量快照）
    const flushTimer = setInterval(() => {
      if (!cfg?.streaming || !auth) return
      for (const { openid, sessionId } of sessions.listSessions()) {
        const bufText = assistantBuf.text(sessionId)
        if (!bufText) continue
        const s = streams.get(openid)
        if (!s || s.sender?.failed) continue
        if (!s.sender) {
          s.sender = new StreamSender(
            { restBase, getToken: () => auth!.getToken() },
            { openid, msgId: s.msgId, msgSeq: s.msgSeq },
          )
        }
        if (bufText.length <= s.lastLen) continue
        s.lastLen = bufText.length
        void s.sender.update(bufText)
      }
    }, STREAM_FLUSH_INTERVAL_MS)

    // ── 跨实例互斥 ──────────────────────────────────────────────────────────
    // OpenCode 按 location 加载同一插件的多个实例（同进程），服务本身也可能多进程。
    // 必须保证全局只有一个 QQ 网关，否则重复收消息、被平台踢下线、用户收到重复回复。
    const lock = new InstanceLock("opencode-qq-gateway", 60_000)
    let gateway: QQGateway | null = null
    let lockTimer: ReturnType<typeof setInterval> | null = null

    const startGateway = (): boolean => {
      if (gateway) return true
      if (!cfg || !auth) return false
      if (!lock.acquire()) return false
      gateway = new QQGateway(gatewayOpts())
      gateway.start()
      log("INFO", `网关已启动 pid=${process.pid}`)
      return true
    }

    const ensureRunning = (): void => {
      if (startGateway()) {
        if (lockTimer) {
          clearInterval(lockTimer)
          lockTimer = null
        }
        return
      }
      if (!cfg) return
      if (!lockTimer) {
        log("WARN", `pid=${process.pid} 未抢到网关锁（${lock.path}），进入待命，每 30s 重试`)
        lockTimer = setInterval(ensureRunning, 30_000)
      }
    }

    const restartGateway = (): void => {
      if (gateway) {
        gateway.stop()
        gateway = null
      }
      if (!cfg) {
        log("WARN", "配置缺失，网关已停止")
        return
      }
      ensureRunning()
    }

    // 不变量：只有持锁实例可以运行网关。
    // 热重载并不保证调用插件 dispose，因此不能只依赖清理函数——
    // 一旦发现自己已不是锁持有者，本实例必须主动停掉网关，否则会留下多条 WS 会话
    //（表现为重复收消息、被平台踢下线）。
    const guardTimer = setInterval(() => {
      if (gateway && !lock.isHeld) {
        log("WARN", `pid=${process.pid} 已失去网关锁，主动停止本实例网关`)
        gateway.stop()
        gateway = null
      }
    }, 10_000)

    // ── 配置热更新 ──────────────────────────────────────────────────────────
    const applyConfig = (next: QqConfig | null): void => {
      cfg = next

      if (!next) {
        auth = null
        api = null
        allowSet = new Set()
        log("WARN", "配置无效或已移除，插件停用")
        return
      }

      restBase = next.sandbox ? REST_BASE_SANDBOX : REST_BASE_PROD
      auth = new AuthManager(next.appId, next.appSecret)
      api = new QQApi({ restBase, getToken: () => auth!.getToken() })
      allowSet = new Set(next.allowlist)
      bridge.configure({ model: next.model, workdir: next.workdir })

      // 工作区列表变化时，旧会话的位置无法迁移，只能重置绑定（SessionManager 内部按指纹判断）
      const workspaces = resolveWorkspaces(next)
      if (sessions.setWorkspaces(workspaces)) {
        log("WARN", "工作区列表已变化，已重置全部 QQ 会话绑定")
      }

      const wsDesc = workspaces.map((w) => `${w.name}${w.isDefault ? "*" : ""}=${w.path ?? "(跟随 location)"}`).join(", ")
      log(
        "INFO",
        `配置已应用 env=${next.sandbox ? "sandbox" : "prod"} 工作区=[${wsDesc}] ` +
          `model=${next.model ?? "(全局默认)"} ` +
          `allowlist=${next.allowlist.length === 0 ? "(不限制)" : next.allowlist.join(",")} ` +
          `streaming=${next.streaming} toolProgress=${next.events.toolProgress} log=${LOG_PATH()}`,
      )
    }

    applyConfig(cfg)
    log("INFO", `插件进程已就绪 pid=${process.pid} location=${ctx?.location?.directory ?? "?"}`)

    const configPath = CONFIG_PATH()
    let lastConfigMtime = mtimeOf(configPath)
    const configTimer = setInterval(() => {
      const m = mtimeOf(configPath)
      if (m === lastConfigMtime) return
      lastConfigMtime = m
      log("INFO", "检测到 opencode-qq.json 变化，热重载")
      applyConfig(loadConfig(configPath))
      restartGateway()
    }, CONFIG_POLL_MS)

    // 首次启动
    if (cfg) {
      ensureRunning()
    } else {
      log("WARN", "未配置凭据，插件待命；补齐 opencode-qq.json（含 appId/appSecret）后会自动启用")
    }

    return () => {
      abort.abort()
      clearInterval(configTimer)
      clearInterval(guardTimer)
      if (lockTimer) clearInterval(lockTimer)
      clearInterval(flushTimer)
      assistantBuf.clearAll()
      // 早期版本 dispose 不写日志，导致「网关悄悄停了」很难排查
      if (gateway) log("INFO", `插件卸载，网关已停止 pid=${process.pid}`)
      gateway?.stop()
      lock.release()
      pusher.dispose()
    }
  },
}
