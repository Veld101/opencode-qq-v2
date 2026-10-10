// opencode-qq 应用编排层（与宿主无关：插件宿主 / 独立进程宿主都走这里）
//
// 启动顺序：读配置 → 用宿主桥接 → 订阅事件 → 抢实例锁 → 启网关 → 节流刷流式
// 配置热更新：轮询 opencode-qq.json 的 mtime，变化即重新应用。
import fs from "node:fs"
import { Approver, isPermissionGone } from "./approver"
import { loadConfig } from "./config"
import { QQGateway, createGatewayUrlFetcher } from "./qq/gateway"
import { QQApi, reserveSeq } from "./qq/api"
import { AuthManager } from "./qq/auth"
import { StreamSender } from "./qq/stream"
import { FileSessionStore } from "./qq/session-store"
import { EventPusher, summarizeError } from "./event-pusher"
import { classifyProviderFailure, pickFallback } from "./model-fallback"
import { AssistantTextBuffer } from "./text-buffer"
import { SessionManager } from "./session-manager"
import { resolveWorkspaces } from "./workspaces"
import { splitText } from "./util/chunk"
import { guessImageMime, toImageDataUrl } from "./util/media"
import { log } from "./logger"
import { InstanceLock } from "./lock"
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
} from "./constants"
import type { BridgeHost, InboundEvent, PromptFile, QqConfig } from "./types"

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

/** 启动应用；返回停止函数（幂等） */
export async function startApp(host: BridgeHost): Promise<() => void> {
    // ── 可变配置相关状态（支持热更新）────────────────────────────────────
    let cfg: QqConfig | null = loadConfig()
    let allowSet = new Set(cfg?.allowlist ?? [])
    let restBase = cfg?.sandbox ? REST_BASE_SANDBOX : REST_BASE_PROD
    let auth: AuthManager | null = cfg ? new AuthManager(cfg.appId, cfg.appSecret) : null
    let api: QQApi | null = cfg ? new QQApi({ restBase, getToken: () => auth!.getToken() }) : null

    const approver = new Approver(APPROVAL_TIMEOUT_MS)

    // ── 宿主桥接 ────────────────────────────────────────────────────────────
    const bridge = host
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
        // 主动推送也走 replyTo：被动窗口内优先被动回复（不耗主动额度），失败会落日志。
        // 再补一条「已送达」记录：不记内容、只记字数，与「收到消息」同一隐私口径——
        // 否则推送成功时日志里一片空白，收没收到只能靠肉眼。
        const delivered = await replyTo(openid, text)
        log(
          delivered ? "INFO" : "ERROR",
          `${delivered ? "推送已送达" : "推送未送达"} openid=${openid} 字数=${text.length}`,
        )
      },
      toolProgress: () => cfg?.events.toolProgress ?? false,
      mirrorText: () => cfg?.events.mirrorSessionText ?? false,
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

    // ── 限额降级：记录「这一轮为什么失败」───────────────────────────────────
    // EventPusher 在回合在飞时会抑制推送（避免与同步回复重复），所以这里单独记录，
    // 不受抑制影响。key = sessionID。
    const lastFailure = new Map<string, string>()
    listeners.push((e) => {
      if (e.type !== "session.execution.failed") return
      const sid = String(e.data?.sessionID ?? "")
      if (!sid) return
      lastFailure.set(sid, summarizeError(e.data?.error))
    })

    // 订阅公开事件流（具体宿主负责断线重订，直到 abort）
    const abort = new AbortController()
    void host
      .subscribeEvents((evt) => {
        for (const h of [...listeners]) h(evt)
      }, abort.signal)
      .catch((e) => {
        if (!abort.signal.aborted) log("ERROR", `事件订阅终止: ${String(e).slice(0, 200)}`)
      })

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

    /**
     * 限额降级：provider 额度耗尽（HTTP 429 / code 6004）时切到备用模型并重发这一条。
     * 只在「本轮确实记录了限额失败」时触发；调用方保证每条消息最多降级一次。
     */
    async function degradeOnQuota(
      openid: string,
      promptText: string,
      files: PromptFile[],
      firstAnswer: string,
    ): Promise<string> {
      const sid = sessions.getSessionId(openid)
      if (!sid) return firstAnswer
      const recorded = lastFailure.get(sid)
      if (recorded) lastFailure.delete(sid)
      // 第二信号：超时文案里会带出「最近一次等待错误」（见 constants.replyTimeoutMessage），
      // 若事件链路没能把限额带上来，这里仍有机会捕获到。
      const failure = recorded ?? (classifyProviderFailure(firstAnswer) ? firstAnswer : undefined)
      if (!failure) return firstAnswer
      if (classifyProviderFailure(failure) !== "rate_limit") return firstAnswer

      const fallbacks = cfg?.modelFallbacks ?? []
      const next = pickFallback(cfg?.model, fallbacks)
      if (!next || !host.switchModel) {
        log(
          "WARN",
          `限额失败，但无可用降级目标（modelFallbacks=${fallbacks.length}，宿主支持=${!!host.switchModel}）: ${failure.slice(0, 160)}`,
        )
        return firstAnswer
      }

      log("WARN", `限额失败，切换模型 ${cfg?.model ?? "(全局默认)"} → ${next} 并重发: ${failure.slice(0, 160)}`)
      try {
        await host.switchModel(sid, next)
      } catch (e) {
        log("ERROR", `切换模型失败: ${String(e).slice(0, 200)}`)
        await replyTo(openid, `⚠️ 模型限额，但切换到 ${next} 失败：${String(e).slice(0, 120)}`)
        return firstAnswer
      }
      await replyTo(
        openid,
        `⚠️ 模型限额（${cfg?.model ?? "默认模型"}），已自动切到 ${next} 并重发本条；本会话后续都用它。`,
      )
      const retry = await sessions.dispatch(openid, promptText, files)
      lastFailure.delete(sid)
      return retry
    }

    // ── 网关（每次用当前配置重建，以支持热更新）──────────────────────────────
    // 会话落盘：进程重启后优先 Resume，让网关补发断开期间遗漏的事件（见 qq/session-store.ts）
    const sessionStore = new FileSessionStore()
    const gatewayOpts = () => ({
      sessionStore,
      getGatewayUrl: createGatewayUrlFetcher(restBase, () => auth!.getToken()),
      getToken: () => auth!.getToken(),
      intents: INTENT_GROUP_AND_C2C,
      // 协议字段漂移排查：记录单聊原始事件（省略 content，避免记录聊天内容）
      onEvent: (type: string, data: Record<string, any>) => {
        // 会话是「新建」还是「恢复」，直接决定重启期间的离线消息能否补发，值得留痕
        if (type === "READY") {
          log("INFO", `网关会话已建立（新会话）session=${String(data.session_id ?? "").slice(0, 8)}`)
          return
        }
        if (type === "RESUMED") {
          log("INFO", "网关会话已恢复（Resume 成功，断开期间遗漏的事件已补发）")
          return
        }
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
            try {
              await host.permissionReply(item.sessionId, item.permissionId, parsed.reply)
              await replyTo(msg.openid, `已${parsed.reply === "reject" ? "拒绝" : "批准"} #${parsed.seq}`)
            } catch (e) {
              // 双端抢答：桌面弹窗先答了，QQ 侧就会「来晚一步」。
              // 这不是故障，直接说清楚；否则整轮会被外层兜底成「处理失败」，看起来像机器人坏了。
              if (!isPermissionGone(e)) throw e
              log("INFO", `权限 #${parsed.seq} 已被其它客户端处理（双端抢答），QQ 侧批准未生效`)
              await replyTo(msg.openid, `#${parsed.seq} 已在其它客户端（如桌面弹窗）处理，此处无需重复批准。`)
            }
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
          // 清掉上一轮残留的失败记录，避免把旧失败误判成本轮限额
          const sidBefore = sessions.getSessionId(msg.openid)
          if (sidBefore) lastFailure.delete(sidBefore)
          let answer: string
          try {
            answer = await sessions.dispatch(msg.openid, promptText, files)
            answer = await degradeOnQuota(msg.openid, promptText, files, answer)
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
          `streaming=${next.streaming} toolProgress=${next.events.toolProgress} ` +
            `mirrorText=${next.events.mirrorSessionText} ` +
            `modelFallbacks=[${next.modelFallbacks.join(", ")}] log=${LOG_PATH()}`,
      )
    }

    applyConfig(cfg)
    log("INFO", `插件进程已就绪 pid=${process.pid} ${host.describe()}`)

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

    // 停止函数：幂等
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      abort.abort()
      clearInterval(configTimer)
      clearInterval(guardTimer)
      if (lockTimer) clearInterval(lockTimer)
      clearInterval(flushTimer)
      assistantBuf.clearAll()
      if (gateway) log("INFO", `应用停止，网关已关闭 pid=${process.pid}`)
      gateway?.stop()
      lock.release()
      pusher.dispose()
    }
}
