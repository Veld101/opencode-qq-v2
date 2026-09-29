// opencode-qq 独立进程入口（7×24 常驻形态）
//
// 与插件形态（index.ts）的区别：
//   - 不依赖 OpenCode 的 location 生命周期 —— OpenCode 回收空闲 location 不会影响本进程
//   - 通过 @opencode/client 走 V2 HTTP API；服务未运行时会尝试拉起（Service.ensure）
//   - 自身崩溃由外部守护拉起（计划任务 / 服务）
//
// 运行：
//   bun bridge.ts
//   bun bridge.ts --bot <name>    多机器人：实例名，仅用于日志标识（配置目录由
//                                 OPENCODE_QQ_CONFIG_DIR 决定，见 start-bridge.cmd）
import { startApp } from "./src/app"
import { HttpHost } from "./src/host/http-host"
import { InstanceLock } from "./src/lock"
import { log } from "./src/logger"

/** 重复启动时的退出码；start-bridge.cmd 据此关闭窗口，而不是进入重启循环 */
const EXIT_ALREADY_RUNNING = 3

/** 读取 `--flag value` 形式的启动参数（缺失返回 undefined） */
function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const bot = argValue("--bot")
  const tag = bot ? `bot=${bot} ` : ""

  // 单实例守卫：同一个配置目录只允许一个桥进程。
  // 每个机器人有各自的 OPENCODE_QQ_CONFIG_DIR，所以守卫天然按机器人隔离；
  // 重复双击同一个快捷方式时，后启动的进程在这里直接退出（窗口随退出码关闭）。
  const guard = new InstanceLock("opencode-qq-instance", 60_000)
  if (!guard.acquire()) {
    log("WARN", `${tag}已有实例在运行（${guard.path}），本进程退出`)
    process.exit(EXIT_ALREADY_RUNNING)
  }

  log("INFO", `独立桥进程启动 ${tag}pid=${process.pid}`)
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
    try {
      guard.release()
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
