/**
 * 无需 QQ 凭据的逻辑自测。
 * 覆盖：文本分块 / 权限审批解析 / V2 文本缓冲 / 会话管理 / V2 宿主桥接 / 节流器。
 *
 * 用法：bun scripts/selftest.ts
 */
import { Approver, isPermissionGone } from "../src/approver"
import { AssistantTextBuffer } from "../src/text-buffer"
import { SessionManager } from "../src/session-manager"
import { PluginHost } from "../src/host/plugin-host"
import { InstanceLock } from "../src/lock"
import { parseC2CMessage, isHeartbeatStale, decideHandshake } from "../src/qq/gateway"
import { FileSessionStore } from "../src/qq/session-store"
import { QQApi, __resetSeqCounters } from "../src/qq/api"
import { StreamSender, isRetryableStreamStatus } from "../src/qq/stream"
import { defaultWorkspaceName, findWorkspace, resolveWorkspaces } from "../src/workspaces"
import { splitText } from "../src/util/chunk"
import { Throttler } from "../src/util/throttle"
import { parseCommand } from "../src/commands"
import { replyTimeoutMessage } from "../src/constants"
import { classifyProviderFailure, pickFallback, parseModelRef } from "../src/model-fallback"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EventPusher } from "../src/event-pusher"
import type { HostBridge, InboundEvent } from "../src/types"

// 自测经 src/logger 落盘，而日志路径默认与线上桥共用一份
// （~/.config/opencode/opencode-qq.log）——实测会把测试产生的假告警写进生产日志，
// 排障时极具误导性（曾把 50015001 的测试响应误读成线上故障）；实例锁文件同理。
// 故强制重定向到临时目录：自测绝不该碰线上目录，所以用赋值而不是 ??=。
// 另外要先建出目录——logger 用 appendFileSync，不会自动创建父目录，缺目录会静默丢日志。
const SELFTEST_CFG_DIR = path.join(os.tmpdir(), "opencode-qq-selftest")
fs.mkdirSync(SELFTEST_CFG_DIR, { recursive: true })
process.env.OPENCODE_QQ_CONFIG_DIR = SELFTEST_CFG_DIR

let passed = 0
let failed = 0

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}\n      期望: ${e}\n      实际: ${a}`)
  }
}
function truthy(label: string, value: unknown): void {
  eq(label, !!value, true)
}
function section(name: string): void {
  console.log(`\n── ${name} ──`)
}

// ── splitText ───────────────────────────────────────────────────────────────
section("splitText：UTF-8 字节边界")
{
  eq("短文本不切分", splitText("你好"), ["你好"])
  eq("空文本返回空数组", splitText(""), [])
  const long = "字".repeat(700) // 2100 字节 > 1900
  const chunks = splitText(long)
  truthy("超长被切分", chunks.length > 1)
  truthy(
    "每片都不超 1900 字节",
    chunks.every((c) => Buffer.byteLength(c, "utf8") <= 1900),
  )
  eq("拼接后无损", chunks.join(""), long)
}

// ── Approver ────────────────────────────────────────────────────────────────
section("Approver：远程审批")
{
  const ap = new Approver(1000)
  const seq = ap.register("ses_1", "per_1", "执行命令: npm test")
  eq("编号从 1 开始", seq, 1)
  truthy("render 含编号", ap.render(seq).includes("#1"))
  eq("解析 同意", ap.parseReply("同意 1"), { reply: "once", seq: 1 })
  eq("解析 拒绝", ap.parseReply("拒绝 1"), { reply: "reject", seq: 1 })
  eq("解析 总是", ap.parseReply("总是 1"), { reply: "always", seq: 1 })
  eq("容忍空白", ap.parseReply("  同意  1  "), { reply: "once", seq: 1 })
  eq("无关文本不解析", ap.parseReply("同意吧"), null)
  eq("计数正确", ap.countBySession("ses_1"), 1)
  const item = ap.confirm(seq)
  eq("confirm 返回 permissionId", item?.permissionId, "per_1")
  eq("confirm 后出队", ap.countBySession("ses_1"), 0)
  eq("重复 confirm 返回 undefined", ap.confirm(seq), undefined)

  const ap2 = new Approver(50)
  ap2.register("ses_2", "per_2", "x")
  await new Promise((r) => setTimeout(r, 80))
  eq("超时后自动清理", ap2.countBySession("ses_2"), 0)

  const ap3 = new Approver(1000)
  ap3.register("ses_3", "p1", "a")
  ap3.register("ses_3", "p2", "b")
  ap3.register("ses_4", "p3", "c")
  ap3.clearSession("ses_3")
  eq("clearSession 只清目标会话", ap3.countBySession("ses_3"), 0)
  eq("clearSession 不影响他人", ap3.countBySession("ses_4"), 1)

  // 双端抢答：桌面弹窗先应答，QQ 侧再答就会拿到 PermissionNotFoundError
  truthy(
    "识别「审批已被其它客户端消费」",
    isPermissionGone(new Error("PermissionNotFoundError: Permission request not found: per_x")),
  )
  truthy("识别纯文本形式", isPermissionGone("Permission request not found: per_x"))
  eq("其它错误不误判", isPermissionGone(new Error("network down")), false)
  eq("空值不误判", isPermissionGone(undefined), false)
}

// ── AssistantTextBuffer（V2 事件形状）────────────────────────────────────────
section("AssistantTextBuffer：V2 流式文本")
{
  let our = true
  const buf = new AssistantTextBuffer(() => our)
  const ev = (type: string, data: Record<string, any>): InboundEvent => ({ type, data })

  buf.handle(ev("session.text.started", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0 }))
  buf.handle(ev("session.text.delta", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: "你" }))
  buf.handle(ev("session.text.delta", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: "好" }))
  eq("delta 增量累计", buf.text("ses_1"), "你好")

  // 第二个文本段（ordinal 递增）追加而非覆盖
  buf.handle(ev("session.text.delta", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 1, delta: "世界" }))
  eq("多段按序拼接", buf.text("ses_1"), "你好世界")

  // ended 用全量覆盖，修正丢片
  buf.handle(ev("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, text: "你好啊" }))
  eq("ended 全量覆盖", buf.text("ses_1"), "你好啊世界")

  our = false
  buf.handle(ev("session.text.delta", { sessionID: "ses_other", assistantMessageID: "m", ordinal: 0, delta: "x" }))
  eq("非本插件会话不接收", buf.text("ses_other"), null)

  buf.clear("ses_1")
  eq("clear 生效", buf.text("ses_1"), null)
}

// ── SessionManager（含 V2 桥接）──────────────────────────────────────────────
section("PluginHost：宿主接口换形")
{
  const calls: string[] = []
  const messages: any[] = []
  let createdInput: any = null
  let defaultModel: any = { providerID: "prov", modelID: "def-model" }
  const ctx = {
    model: {
      async default() {
        return defaultModel
      },
    },
    session: {
      async create(input: any) {
        calls.push("create")
        createdInput = input
        return { id: "ses_new", title: input.title }
      },
      async synthetic(input: any) {
        calls.push("synthetic")
        return {}
      },
      async prompt(input: any) {
        calls.push("prompt")
        messages.push({ id: "msg_u1", type: "user", content: [] })
        messages.push({
          id: "msg_a1",
          type: "assistant",
          content: [{ type: "reasoning", text: "思考中" }, { type: "text", text: "来自 OpenCode 的回复" }],
        })
        return {}
      },
      async wait(input: any) {
        calls.push("wait")
        return undefined
      },
      async context(input: any) {
        return messages
      },
    },
  }

  const bridge = new PluginHost(ctx)
  bridge.configure({ model: "anthropic/claude-sonnet-4-5", workdir: "D:/workspace/opencode" })
  const created = await bridge.sessionCreate("标题")
  eq("create 返回 id", created.id, "ses_new")
  truthy("create 已调用", calls.includes("create"))
  eq("显式配置的模型被传入（providerID/id 形状）", createdInput.model, {
    providerID: "anthropic",
    id: "claude-sonnet-4-5",
  })
  eq("固定 workdir 通过 location 传入", createdInput.location, { directory: "D:/workspace/opencode" })

  const bridgeDefault = new PluginHost(ctx)
  bridgeDefault.configure({})
  await bridgeDefault.sessionCreate("标题2")
  eq("未配置时回退到全局默认模型（modelID → id）", createdInput.model, { providerID: "prov", id: "def-model" })
  eq("未配置 workdir 时不传 location", createdInput.location, undefined)

  // 热换模型：configure 必须让解析缓存失效
  const bridgeHot = new PluginHost(ctx)
  bridgeHot.configure({ model: "p1/m1" })
  await bridgeHot.sessionCreate("a")
  eq("模型 A 生效", createdInput.model, { providerID: "p1", id: "m1" })
  bridgeHot.configure({ model: "p2/m2" })
  await bridgeHot.sessionCreate("b")
  eq("热换模型后缓存失效、新模型生效", createdInput.model, { providerID: "p2", id: "m2" })

  defaultModel = undefined
  const bridgeNone = new PluginHost({ ...ctx, model: { default: async () => undefined } })
  bridgeNone.configure({})
  let threw = ""
  try {
    await bridgeNone.sessionCreate("标题3")
  } catch (e) {
    threw = String(e)
  }
  truthy("无模型可用时抛出明确错误", threw.includes("未配置模型"))

  const r = await bridge.sessionPrompt("ses_new", "你好", false)
  eq("从 context 提取 assistant 的 text part", r.text, "来自 OpenCode 的回复")
  truthy("调用了 wait", calls.includes("wait"))
  truthy("调用了 prompt", calls.includes("prompt"))
  eq("in-flight 已复位", bridge.isInFlight("ses_new"), false)

  calls.length = 0
  await bridge.sessionPrompt("ses_new", "引导语", true)
  truthy("noReply 走 synthetic", calls.includes("synthetic"))
  eq("noReply 不触发模型", calls.includes("prompt"), false)
}

section("SessionManager：指令、派发与工作区隔离")
{
  const sent: any[] = []
  const created: Array<{ title: string; dir?: string }> = []
  const fake: HostBridge = {
    async sessionCreate(title: string, dir?: string) {
      created.push({ title, dir })
      return { id: `ses_${created.length}` }
    },
    async sessionPrompt(_id, text, noReply) {
      sent.push({ text, noReply })
      return { text: noReply ? "" : `回复:${text}` }
    },
    isInFlight: () => false,
  }
  const tmp = `D:/Data/Temp/opencode/selftest-sessions-${Date.now()}.json`
  const sm = new SessionManager(fake, tmp, undefined as any, () => 0)
  sm.setWorkspaces(resolveWorkspaces({ workspaces: [], workdir: "D:/proj/a" } as any))

  eq("指令 /help", (await sm.dispatch("user1", "/help")).includes("opencode-qq 指令"), true)
  eq("普通消息得到回复", await sm.dispatch("user1", "你好"), "回复:你好")
  truthy("会话已建立", (await sm.getSessionId("user1")) !== null)
  truthy("首次会话带人设引导", sent[0]?.noReply === true)
  eq("默认工作区名为 default", sm.workspaceOf("user1"), "default")
  eq("建会话时带上工作区目录", created[0]?.dir, "D:/proj/a")
  eq("指令 /new 重置", (await sm.dispatch("user1", "/new")).includes("已重置"), true)
  eq("重置后无会话", await sm.getSessionId("user1"), null)
  eq("未知斜杠指令透传给模型", await sm.dispatch("user1", "/init"), "回复:/init")
  eq("parseCommand 只认白名单", parseCommand("/foo"), null)

  await sm.dispatch("user2", "hi")
  truthy("user2 已建会话", (await sm.getSessionId("user2")) !== null)
  sm.resetAll()
  eq("resetAll 清空 user1", await sm.getSessionId("user1"), null)
  eq("resetAll 清空 user2", await sm.getSessionId("user2"), null)
}

section("工作区：列表解析与切换隔离")
{
  const single = resolveWorkspaces({ workspaces: [], workdir: "D:/only" } as any)
  eq("未配置 workspaces 时退化为单一工作区", single.length, 1)
  eq("退化为 default 且标记默认", single[0], { name: "default", path: "D:/only", isDefault: true })

  const list = resolveWorkspaces({
    workspaces: [
      { name: "opencode", path: "D:/workspace/opencode" },
      { name: "img", path: "D:/workspace/img-operation" },
      { name: "opencode", path: "D:/dup" },
      { name: "  ", path: "x" },
    ],
    workdir: "D:/ignored",
    defaultWorkspace: "img",
  } as any)
  eq("去重并过滤空名", list.map((w) => w.name), ["opencode", "img"])
  eq("defaultWorkspace 生效", defaultWorkspaceName(list), "img")
  eq("按名字查找（大小写不敏感）", findWorkspace(list, "OPENCODE")?.path, "D:/workspace/opencode")
  eq("按序号查找（1 基）", findWorkspace(list, "2")?.name, "img")
  eq("越界序号返回 null", findWorkspace(list, "9"), null)
  eq("未知名字返回 null", findWorkspace(list, "nope"), null)
  eq(
    "defaultWorkspace 指向不存在时回退首项",
    defaultWorkspaceName(resolveWorkspaces({ workspaces: [{ name: "a" }], defaultWorkspace: "zzz" } as any)),
    "a",
  )

  const created2: Array<{ dir?: string }> = []
  const fake: HostBridge = {
    async sessionCreate(_t: string, dir?: string) {
      created2.push({ dir })
      return { id: `ses_ws_${created2.length}` }
    },
    async sessionPrompt(_id, text, noReply) {
      return { text: noReply ? "" : `回复:${text}` }
    },
    isInFlight: () => false,
  }
  const tmp = `D:/Data/Temp/opencode/selftest-ws-${Date.now()}.json`
  const sm = new SessionManager(fake, tmp, undefined as any, () => 0)
  sm.setWorkspaces(
    resolveWorkspaces({
      workspaces: [
        { name: "opencode", path: "D:/workspace/opencode" },
        { name: "img", path: "D:/workspace/img-operation" },
      ],
      defaultWorkspace: "opencode",
    } as any),
  )

  eq("初始为默认工作区", sm.workspaceOf("u"), "opencode")
  await sm.dispatch("u", "在 opencode 里问")
  const opencodeSession = sm.getSessionId("u")
  truthy("opencode 工作区已建会话", opencodeSession !== null)
  eq("会话建在 opencode 目录", created2[0]?.dir, "D:/workspace/opencode")

  truthy("切换提示含目标工作区", (await sm.dispatch("u", "/workspace img")).includes("img"))
  eq("切换后当前工作区为 img", sm.workspaceOf("u"), "img")
  eq("img 工作区尚无会话（历史隔离）", sm.getSessionId("u"), null)

  await sm.dispatch("u", "在 img 里问")
  const imgSession = sm.getSessionId("u")
  truthy("img 工作区新开会话", imgSession !== null)
  truthy("两个工作区会话不同", imgSession !== opencodeSession)
  eq("会话建在 img 目录", created2[1]?.dir, "D:/workspace/img-operation")
  eq("两个工作区各建一次会话", created2.length, 2)

  eq("/workspace 无参可列出", (await sm.dispatch("u", "/workspace")).includes("img"), true)
  truthy("序号切换也可用", (await sm.dispatch("u", "/ws 1")).includes("opencode"))
  eq("切回后沿用原会话", sm.getSessionId("u"), opencodeSession)
  eq("切回不重复建会话", created2.length, 2)

  truthy("未知工作区给出可用列表", (await sm.dispatch("u", "/workspace nope")).includes("opencode"))

  await sm.dispatch("u", "/new")
  eq("/new 只重置当前工作区", sm.getSessionId("u"), null)
  await sm.dispatch("u", "/workspace img")
  eq("其他工作区会话不受影响", sm.getSessionId("u"), imgSession)

  sm.setWorkspaces(resolveWorkspaces({ workspaces: [{ name: "opencode", path: "D:/moved" }] } as any))
  eq("工作区列表变化后会话全部失效", sm.getSessionId("u"), null)
}

section("SessionManager：v1 存储格式迁移")
{
  const dir = `D:/Data/Temp/opencode/migrate-${Date.now()}`
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, "sessions.json")
  fs.writeFileSync(p, JSON.stringify({ "user-old": "ses_legacy" }))
  const fake: HostBridge = {
    async sessionCreate() {
      return { id: "x" }
    },
    async sessionPrompt() {
      return { text: "" }
    },
    isInFlight: () => false,
  }
  const sm = new SessionManager(fake, p, undefined as any, () => 0)
  sm.setWorkspaces(resolveWorkspaces({ workspaces: [{ name: "solo", path: "D:/solo" }] } as any))
  eq("v1 记录挂到默认工作区", sm.getSessionId("user-old"), "ses_legacy")
}

// ── Throttler ───────────────────────────────────────────────────────────────
section("Throttler：节流聚合")
{
  const flushed: Array<{ key: string; lines: string[] }> = []
  const t = new Throttler(40, (key, lines) => flushed.push({ key, lines }))
  t.push("a", "1")
  t.push("a", "2")
  t.push("b", "9")
  eq("窗口内不 flush", flushed.length, 0)
  await new Promise((r) => setTimeout(r, 90))
  eq("到点按 key 聚合", flushed.length, 2)
  eq("a 聚合两条", flushed.find((f) => f.key === "a")?.lines, ["1", "2"])
  eq("b 独立", flushed.find((f) => f.key === "b")?.lines, ["9"])
}

// ── InstanceLock ────────────────────────────────────────────────────────────
section("InstanceLock：跨进程互斥")
{
  // 指定独立目录，避免污染真实配置目录
  const dir = `D:/Data/Temp/opencode/locktest-${Date.now()}`
  fs.mkdirSync(dir, { recursive: true })
  // 记下外层（文件顶部设的临时目录）并在本段结束后恢复：这里若直接 delete，
  // 会把顶部的重定向一起抹掉，导致本段之后的所有日志又写回线上日志文件。
  const prevCfgDir = process.env.OPENCODE_QQ_CONFIG_DIR
  process.env.OPENCODE_QQ_CONFIG_DIR = dir

  const a = new InstanceLock("gw", 60_000)
  const b = new InstanceLock("gw", 60_000)
  eq("A 抢到锁", a.acquire(), true)
  eq("A 重复抢返回 true", a.acquire(), true)
  eq("B 抢不到（同进程不同实例也不行）", b.acquire(), false)
  a.release()
  eq("A 释放后 B 可抢", b.acquire(), true)
  eq("B 持有中", b.isHeld, true)
  b.release()

  // 模拟持锁进程崩溃：心跳已过期
  const lockFile = path.join(dir, "gw.lock")
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, token: "dead", at: Date.now() - 10_000 }))
  const c = new InstanceLock("gw", 1_000)
  eq("陈旧锁可被接管", c.acquire(), true)
  eq("接管后持有", c.isHeld, true)
  c.release()
  eq("释放后锁文件已删除", fs.existsSync(lockFile), false)

  // 回归：旧持有者在新持有者接管后 release，绝不能删掉新持有者的锁
  const d = new InstanceLock("gw2", 1_000)
  const e = new InstanceLock("gw2", 1_000)
  const lock2 = path.join(dir, "gw2.lock")
  eq("D 抢到", d.acquire(), true)
  // 伪造 D 心跳过期（别人写的锁），使 E 合法接管
  fs.writeFileSync(lock2, JSON.stringify({ pid: 999999, token: "stale", at: Date.now() - 10_000 }))
  eq("E 接管陈旧锁", e.acquire(), true)
  d.release()
  eq("旧持有者 release 不影响新持有者（回归）", fs.existsSync(lock2), true)
  eq("新持有者仍持有", e.isHeld, true)
  e.release()
  eq("新持有者释放后才删除锁文件", fs.existsSync(lock2), false)

  // 回归：持有进程已退出时，无需等 TTL 即可接管（硬杀后快速恢复）
  const dead = new InstanceLock("gw3", 60_000)
  const lock3 = path.join(dir, "gw3.lock")
  fs.writeFileSync(lock3, JSON.stringify({ pid: 2147483646, token: "gone", at: Date.now() }))
  eq("持有进程不存在 → 立即接管（不等 TTL）", dead.acquire(), true)
  eq("接管后持有", dead.isHeld, true)
  dead.release()

  // 反向：持有进程就是自己时不得抢占（防止同进程多实例互抢）
  const selfPid = new InstanceLock("gw4", 60_000)
  const lock4 = path.join(dir, "gw4.lock")
  fs.writeFileSync(lock4, JSON.stringify({ pid: process.pid, token: "self", at: Date.now() }))
  eq("持有者是自己进程 → 不抢占", selfPid.acquire(), false)
  fs.unlinkSync(lock4)

  if (prevCfgDir === undefined) delete process.env.OPENCODE_QQ_CONFIG_DIR
  else process.env.OPENCODE_QQ_CONFIG_DIR = prevCfgDir
}

// ── GatewaySessionStore ─────────────────────────────────────────────────────
section("GatewaySessionStore：会话持久化（重启后仍能 Resume）")
{
  const dir = `D:/Data/Temp/opencode/gwsession-${Date.now()}`
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "opencode-qq-gateway-session.json")
  const store = new FileSessionStore(file)

  eq("初始无会话", store.load(), null)

  store.save({ sessionId: "sess-1", lastSeq: 1337, at: 111 })
  eq("保存后可加载", store.load()?.sessionId, "sess-1")
  eq("seq 一并保留", store.load()?.lastSeq, 1337)

  store.save({ sessionId: "sess-1", lastSeq: 1338, at: 222 })
  eq("再次保存覆盖为新 seq", store.load()?.lastSeq, 1338)

  store.clear()
  eq("clear 后无会话", store.load(), null)

  // 损坏 / 缺字段一律视为「没有可恢复的会话」，绝不能抛异常
  fs.writeFileSync(file, "{ not json")
  eq("损坏文件 → null（不致命）", store.load(), null)

  fs.writeFileSync(file, JSON.stringify({ sessionId: "", lastSeq: 5 }))
  eq("空 sessionId → null", store.load(), null)

  fs.writeFileSync(file, JSON.stringify({ sessionId: "x" }))
  eq("缺 lastSeq → null", store.load(), null)

  fs.writeFileSync(file, JSON.stringify({ sessionId: "x", lastSeq: 0 }))
  eq("seq=0 是合法值（不能当缺失）", store.load()?.lastSeq, 0)

  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 握手决策 ────────────────────────────────────────────────────────────────
section("gateway：Hello 握手决策（有会话就 Resume，才能补发）")
{
  eq("无会话 → identify", decideHandshake(null, null), "identify")
  eq("有会话 + seq → resume", decideHandshake("sess-1", 1337), "resume")
  eq("seq=0 → resume（0 有效）", decideHandshake("sess-1", 0), "resume")
  eq("有会话但无 seq → identify", decideHandshake("sess-1", null), "identify")
  eq("有 seq 但无会话 → identify", decideHandshake(null, 1337), "identify")
  eq("空字符串 sessionId → identify", decideHandshake("", 1337), "identify")
}

// ── parseC2CMessage ─────────────────────────────────────────────────────────
section("parseC2CMessage：字段形状兼容（线上 bug 回归）")
{
  // QQ 官方单聊(v2) 真实形状：用户标识在 author.user_openid，消息 id 在 d.id
  const official = {
    id: "ROBOT1.0_abc",
    author: { id: "u1", user_openid: "OPENID_A" },
    content: "你好",
    timestamp: "2026-09-27T14:33:19.000Z",
  }
  const m1 = parseC2CMessage(official)
  eq("官方形状：openid 取 author.user_openid", m1.openid, "OPENID_A")
  eq("官方形状：msgId 取 d.id", m1.msgId, "ROBOT1.0_abc")
  eq("官方形状：content", m1.content, "你好")
  truthy("官方形状：timestamp 可解析", m1.timestamp > 0)

  // 旧版 / 频道风格：顶层 openid + msg_id
  const m2 = parseC2CMessage({ openid: "OPENID_B", msg_id: "msg_2", content: "hi" })
  eq("旧形状：openid", m2.openid, "OPENID_B")
  eq("旧形状：msgId", m2.msgId, "msg_2")

  // 字段缺失不得抛异常
  const m3 = parseC2CMessage({})
  eq("缺字段：openid 为空串（由上层拒绝并报错）", m3.openid, "")
  eq("缺字段：msgId 为空串", m3.msgId, "")

  // 图片附件识别
  const m4 = parseC2CMessage({
    id: "x",
    author: { user_openid: "o" },
    attachments: [{ content_type: "image", url: "https://example.com/a.png" }],
  })
  eq("图片附件被识别", m4.attachments.length, 1)
  eq("非图片附件被过滤", parseC2CMessage({ attachments: [{ content_type: "file", url: "x" }] }).attachments.length, 0)
}

// ── QQApi：msg_seq 跨实例共享（40054005 回归）────────────────────────────────
section("QQApi：msg_seq 计数器必须跨实例共享（热重载回归）")
{
  __resetSeqCounters()
  const bodies: Array<Record<string, any>> = []
  const fakeFetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ id: "m1" }), { status: 200, headers: { "Content-Type": "application/json" } })
  }) as unknown as typeof fetch
  const opts = { restBase: "https://example.invalid", getToken: async () => "t", fetchFn: fakeFetch }

  const apiA = new QQApi(opts)
  await apiA.sendC2C("openid1", "ack", { msgId: "MSG1" })
  eq("实例 A 首次使用 seq=1", bodies.at(-1)?.msg_seq, 1)
  eq("被动回复带 msg_id", bodies.at(-1)?.msg_id, "MSG1")

  // 模拟配置热重载：重建 QQApi（旧实现会在此清零计数器 → 重复 seq=1 → 40054005）
  const apiB = new QQApi(opts)
  await apiB.sendC2C("openid1", "answer", { msgId: "MSG1" })
  eq("重建实例后 seq 递增为 2（回归）", bodies.at(-1)?.msg_seq, 2)

  // 不同 msg_id 各自独立计数
  await apiB.sendC2C("openid1", "ack2", { msgId: "MSG2" })
  eq("新 msg_id 从 seq=1 开始", bodies.at(-1)?.msg_seq, 1)

  // 额度用尽后降级为主动消息（不带 msg_id / msg_seq）
  await apiB.sendC2C("openid1", "3", { msgId: "MSG1" })
  await apiB.sendC2C("openid1", "4", { msgId: "MSG1" })
  await apiB.sendC2C("openid1", "overflow", { msgId: "MSG1" })
  const overflow = bodies.at(-1)!
  eq("超出额度后不再带 msg_id", overflow.msg_id, undefined)
  eq("超出额度后不再带 msg_seq", overflow.msg_seq, undefined)

  // 不带 msgId 即主动消息
  await apiB.sendC2C("openid1", "proactive")
  eq("主动消息不带 msg_id", bodies.at(-1)?.msg_id, undefined)

  __resetSeqCounters()
}

section("网关心跳假死判定（掉线不自知的回归）")
{
  const interval = 45_000
  eq("刚发心跳、ACK 正常 → 不判假死", isHeartbeatStale(0, 0, interval), false)
  eq("发过 1 次未 ACK、时间未超 → 不判假死", isHeartbeatStale(1, interval, interval), false)
  eq("连续 2 次未 ACK → 判假死", isHeartbeatStale(2, interval, interval), true)
  eq("距上次 ACK 超 3 个周期 → 判假死", isHeartbeatStale(0, interval * 3 + 1, interval), true)
  eq("恰好 3 个周期不判（边界）", isHeartbeatStale(0, interval * 3, interval), false)
}

// ── StreamSender：瞬时失败重试 ──────────────────────────────────────────────
section("StreamSender：平台瞬时失败的有界重试（回归：一次 500 丢掉整轮打字机）")
{
  const mkRes = (status: number, body: unknown = {}): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response

  eq("500 可重试", isRetryableStreamStatus(500), true)
  eq("503 可重试", isRetryableStreamStatus(503), true)
  eq("429 可重试", isRetryableStreamStatus(429), true)
  eq("400 不重试", isRetryableStreamStatus(400), false)
  eq("404 不重试", isRetryableStreamStatus(404), false)

  // 前两次 500（线上实际遇到的 50015001「系统繁忙，请稍后重试」），第三次成功
  const bodies: any[] = []
  let n = 0
  const retried = new StreamSender(
    {
      restBase: "http://test",
      getToken: async () => "token",
      fetchFn: (async (_url: string, init: any) => {
        bodies.push(JSON.parse(String(init.body)))
        n++
        return n < 3
          ? mkRes(500, { message: "系统繁忙，请稍后重试", code: 50015001 })
          : mkRes(200, { id: "sm_1" })
      }) as unknown as typeof fetch,
    },
    { openid: "o", msgId: "m", msgSeq: 2 },
  )
  await retried.update("第一片")
  eq("重试后成功 → 不置败", retried.failed, false)
  eq("共尝试 3 次", bodies.length, 3)
  eq("重试期间 index 不前进（避免造重复段）", bodies.map((b) => b.index), [0, 0, 0])
  eq("首帧带 msg_id", bodies[0].msg_id, "m")

  // 4xx 是确定性错误：立即置败、不浪费被动额度
  let badCalls = 0
  const noRetry = new StreamSender(
    {
      restBase: "http://test",
      getToken: async () => "token",
      fetchFn: (async () => {
        badCalls++
        return mkRes(400, { code: 40007 })
      }) as unknown as typeof fetch,
    },
    { openid: "o", msgId: "m", msgSeq: 2 },
  )
  await noRetry.update("x")
  eq("4xx 立即置败", noRetry.failed, true)
  eq("4xx 只尝试 1 次", badCalls, 1)
}

// ── EventPusher：正文镜像 ───────────────────────────────────────────────────
section("EventPusher：会话正文镜像（桌面端干活、手机上看）")
{
  const sent: string[] = []
  const handlers: Array<(e: InboundEvent) => void> = []
  let inFlight = false
  let mirror = true
  const pusher = new EventPusher({
    isOurSession: () => true,
    openidOfSession: () => "o1",
    isTurnInFlight: () => inFlight,
    send: async (_openid, text) => {
      sent.push(text)
    },
    toolProgress: () => false,
    mirrorText: () => mirror,
    lastAssistantText: () => "末尾摘要",
    subscribe: (h) => handlers.push(h),
  })
  const emit = (type: string, data: Record<string, any>): void => {
    for (const h of [...handlers]) h({ type, data })
  }
  const ended = (msgId: string, ordinal: number, text: string): void =>
    emit("session.text.ended", { sessionID: "s1", assistantMessageID: msgId, ordinal, text })

  ended("m1", 0, "第一段正文")
  eq("正文镜像带前缀", sent.at(-1), "📄 第一段正文")

  ended("m1", 0, "第一段正文")
  eq("同一块重放不重复推", sent.length, 1)

  ended("m1", 1, "第二段正文")
  eq("不同 ordinal 视为新块", sent.length, 2)

  inFlight = true
  ended("m2", 0, "同步回复的内容")
  eq("在飞回合（QQ 触发）不镜像", sent.length, 2)
  inFlight = false
  ended("m2", 0, "同步回复的内容")
  eq("在飞块迟到也不重复镜像", sent.length, 2)

  ended("m3", 0, "   ")
  eq("空文本不推", sent.length, 2)

  mirror = false
  ended("m4", 0, "关闭镜像后不该推")
  eq("关闭镜像后正文不推", sent.length, 2)
  emit("session.idle", { sessionID: "s1" })
  truthy("关闭镜像后回落「任务完成+摘要」", String(sent.at(-1)).includes("任务完成"))

  mirror = true
  sent.length = 0
  emit("session.idle", { sessionID: "s1" })
  eq("打开镜像后 idle 不再补摘要（避免一轮收两遍）", sent.length, 0)

  pusher.dispose()
}

// ── 回复超时文案 ────────────────────────────────────────────────────────────
section("回复超时：必须把真实原因带出来（昨晚 499 中断无迹可查的回归）")
{
  const plain = replyTimeoutMessage(10, null)
  truthy("无错误时也给出可操作提示", plain.includes("弹窗"))
  eq("无错误时不出现 null", plain.includes("null"), false)

  const withErr = replyTimeoutMessage(10, "InterruptError: All fibers interrupted")
  truthy("带出真实错误原文", withErr.includes("All fibers interrupted"))
  truthy("带出分钟数", withErr.includes("10 分钟"))
  truthy("提示可能卡在弹窗", withErr.includes("question"))
}

// ── 限额降级 ────────────────────────────────────────────────────────────────
section("限额降级：只认限额，且不挑等于当前的模型")
{
  // 线上真实原文（2026-10-08 / 10-10 各一次）
  const real =
    'AI.Error: Provider request failed with HTTP 429: {"code":6004,"msg":"您的使用量已超出频率限制，' +
    '将在 2026-10-10 13:13:46 UTC+8 重置，您也可以切换其他模型继续使用。"}'
  eq("识别线上真实 429 原文", classifyProviderFailure(real), "rate_limit")
  eq("识别 HTTP 429", classifyProviderFailure("Provider request failed with HTTP 429"), "rate_limit")
  eq("识别 code 6004", classifyProviderFailure('{"code":6004}'), "rate_limit")
  eq("识别 rate limit 英文", classifyProviderFailure("AI.Error.RateLimit"), "rate_limit")
  eq("普通错误不误判", classifyProviderFailure("Provider request failed with HTTP 400"), null)
  eq("网络错误不误判", classifyProviderFailure("getaddrinfo ENOTFOUND api.bot.qq.com"), null)
  eq("空值不误判", classifyProviderFailure(undefined), null)
  eq("含随机数字不误判", classifyProviderFailure("trace_id=429abc not a limit"), null)

  eq("跳过等于当前的模型", pickFallback("opencode-go/deepseek-v4.1-flash", ["opencode-go/deepseek-v4.1-flash", "codebuddy/deepseek-v4.1-flash"]), "codebuddy/deepseek-v4.1-flash")
  eq("取第一个候选", pickFallback("opencode-go/x", ["codebuddy/deepseek-v4.1-flash"]), "codebuddy/deepseek-v4.1-flash")
  eq("跳过空项", pickFallback("a/b", ["", "  ", "codebuddy/deepseek-v4.1-flash"]), "codebuddy/deepseek-v4.1-flash")
  eq("无候选返回 null", pickFallback("a/b", []), null)
  eq("候选全等于当前则 null", pickFallback("a/b", ["a/b"]), null)

  eq("解析模型引用", parseModelRef("codebuddy/deepseek-v4.1-flash"), { providerID: "codebuddy", id: "deepseek-v4.1-flash" })
  eq("模型 ID 可含斜杠", parseModelRef("openrouter/anthropic/claude"), { providerID: "openrouter", id: "anthropic/claude" })
  eq("非法引用返回 null", parseModelRef("no-slash"), null)
  eq("空 provider 返回 null", parseModelRef("/x"), null)
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n════════ 结果：${passed} 通过 / ${failed} 失败 ════════`)
process.exit(failed === 0 ? 0 : 1)
