/**
 * QQ 官方机器人连通性探针。
 *
 * 用途：在启用插件前，独立验证「AppID/AppSecret → access_token → 网关 → Identify → 收消息 → 回消息」
 * 整条链路，把问题定位在 QQ 侧还是 OpenCode 侧。
 *
 * 用法：
 *   bun scripts/probe-qq.ts                # 连接并监听 90 秒，收到消息即回显
 *   bun scripts/probe-qq.ts --listen 300   # 自定义监听秒数
 *   bun scripts/probe-qq.ts --no-reply     # 只收不回
 *   bun scripts/probe-qq.ts --token-only   # 只验证凭据换取 access_token
 *
 * 凭据来源：环境变量 QQ_BOT_APPID / QQ_BOT_APPSECRET，或配置文件（默认 ~/.config/opencode/opencode-qq.json）。
 * 本脚本只打印令牌长度与到期时间，绝不打印令牌或密钥明文。
 */
import { CONFIG_PATH, INTENT_GROUP_AND_C2C, REST_BASE_PROD, REST_BASE_SANDBOX } from "../src/constants"
import { loadConfig } from "../src/config"
import { AuthManager } from "../src/qq/auth"
import { QQApi } from "../src/qq/api"
import { QQGateway, createGatewayUrlFetcher } from "../src/qq/gateway"

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const listenSecs = Number(argValue("--listen") ?? 90)
const noReply = process.argv.includes("--no-reply")
const tokenOnly = process.argv.includes("--token-only")

function step(n: number, msg: string): void {
  console.log(`\n[${n}] ${msg}`)
}
function ok(msg: string): void {
  console.log(`    ✅ ${msg}`)
}
function fail(msg: string): void {
  console.log(`    ❌ ${msg}`)
}

const cfg = loadConfig()
if (!cfg) {
  console.error(
    `未找到凭据。\n` +
      `  · 配置文件：${CONFIG_PATH()}\n` +
      `  · 或环境变量：QQ_BOT_APPID / QQ_BOT_APPSECRET\n` +
      `配置文件格式见 opencode-qq.example.json。`,
  )
  process.exit(1)
}

console.log("opencode-qq 连通性探针")
console.log(`  AppID      : ${cfg.appId}`)
console.log(`  AppSecret  : ${"*".repeat(String(cfg.appSecret).length)}（已隐藏，长度 ${String(cfg.appSecret).length}）`)
console.log(`  环境       : ${cfg.sandbox ? "沙箱" : "正式"}`)

const restBase = cfg.sandbox ? REST_BASE_SANDBOX : REST_BASE_PROD
const auth = new AuthManager(cfg.appId, cfg.appSecret)

step(1, "用 AppID + AppSecret 换取 access_token …")
try {
  const token = await auth.getToken()
  ok(`access_token 已获取（长度 ${token.length}）。注意：Token 鉴权已废弃，必须走这条路径。`)
} catch (e) {
  fail(String(e))
  console.log(
    `\n排查提示：\n` +
      `  · 100007 / 10004 → AppID 无效、机器人不存在或状态异常\n` +
      `  · 100016        → AppID 或 AppSecret 不正确（沙箱与正式环境凭据可能不同）\n` +
      `  · 100001        → 请求过于频繁，稍后重试`,
  )
  process.exit(1)
}

if (tokenOnly) {
  console.log("\n--token-only 模式结束。")
  process.exit(0)
}

step(2, "获取 WebSocket 网关地址（/gateway）…")
const getGatewayUrl = createGatewayUrlFetcher(restBase, () => auth.getToken())
try {
  const url = await getGatewayUrl()
  ok(`网关地址: ${url}`)
} catch (e) {
  fail(String(e))
  process.exit(1)
}

step(3, `连接网关并 Identify（intents=${INTENT_GROUP_AND_C2C}，单聊+群@）…`)

let received = 0
const api = new QQApi({ restBase, getToken: () => auth.getToken() })

const gateway = new QQGateway({
  getGatewayUrl,
  getToken: () => auth.getToken(),
  intents: INTENT_GROUP_AND_C2C,
  connected: () => ok("网关已就绪（READY / RESUMED）"),
  disconnected: () => console.log("    … 连接已断开，正在按指数退避重连"),
  message: async (msg) => {
    received++
    console.log(`\n    📩 收到单聊消息 #${received}`)
    console.log(`       openid : ${msg.openid}`)
    console.log(`       msg_id : ${msg.msgId}`)
    console.log(`       附件   : ${msg.attachments.length} 个`)
    console.log(`       内容   : ${msg.content}`)
    if (noReply) return
    try {
      await api.sendC2C(msg.openid, `pong: 收到「${msg.content}」`, { msgId: msg.msgId })
      console.log("       ↳ 已回复 pong（被动回复）")
    } catch (e) {
      console.log(`       ↳ 回复失败: ${String(e).slice(0, 200)}`)
    }
  },
})

gateway.start()
console.log(`    监听中，${listenSecs} 秒后自动退出。现在用手机 QQ 给机器人发一条私聊消息。`)

setTimeout(() => {
  gateway.stop()
  console.log(`\n监听结束：共收到 ${received} 条消息。`)
  if (received === 0) {
    console.log(
      `\n若一条都没收到，依次检查：\n` +
        `  · 机器人是否已在 QQ 开放平台启用；沙箱环境下是否把自己加进了沙箱单聊账号\n` +
        `  · 是否用管理员 QQ / 沙箱账号主动发起私聊（QQ 限制机器人不能主动开聊）\n` +
        `  · ${cfg.sandbox ? "当前是沙箱环境" : "当前是正式环境"}，与平台管理端配置是否一致`,
    )
  }
  process.exit(0)
}, listenSecs * 1000)
