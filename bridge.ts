// opencode-qq 独立进程入口（7×24 常驻形态）
//
// 与插件形态（index.ts）的区别：
//   - 不依赖 OpenCode 的 location 生命周期 —— OpenCode 回收空闲 location 不会影响本进程
//   - 通过 @opencode/client 走 V2 HTTP API；服务未运行时会尝试拉起（Service.ensure）
//   - 自身崩溃由外部守护拉起（计划任务 / 服务）
//
// 运行：
//   bun bridge.ts
import { startApp } from "./src/app"
import { HttpHost } from "./src/host/http-host"
import { log } from "./src/logger"

async function main(): Promise<void> {
  log("INFO", `独立桥进程启动 pid=${process.pid}`)
  const host = await HttpHost.connect()
  await host.health()
  const stop = await startApp(host)
  log("INFO", "独立桥已就绪")

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    log("INFO", `收到 ${signal}，正在退出`)
    try {
      stop()
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 150)
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch((e) => {
  log("ERROR", `独立桥启动失败: ${String(e).slice(0, 400)}`)
  process.exit(1)
})
