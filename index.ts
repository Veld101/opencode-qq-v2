// opencode-qq 插件入口（OpenCode V2 服务端插件形态）
//
// 逻辑全部在 src/app.ts；这里只负责构造「插件宿主」。
//
// ⚠️ 插件生命周期绑定在 OpenCode 的 location 上：location 被回收时插件会被卸载，
//    QQ 网关随之停止，且此时进程内已无本插件的代码，无法自愈。
//    需要 7×24 常驻请改用独立进程形态（bridge.ts）。
import { startApp } from "./src/app"
import { PluginHost } from "./src/host/plugin-host"

export default {
  id: "opencode-qq",

  async setup(ctx: any) {
    return await startApp(new PluginHost(ctx))
  },
}
