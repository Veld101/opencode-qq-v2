# opencode-qq-v2

把 **QQ 官方机器人**接到 **OpenCode V2**：在手机 QQ 单聊里直接给 OpenCode 下指令，AI 回复发回 QQ，
需要执行危险操作时在 QQ 里审批。

原 `opencode-qq`（npm v0.1.0）是 **OpenCode V1 插件**，官方明确 *"V1 plugin implementations do not run in V2"*，
因此本项目把它**移植到 V2 插件 API**，并修掉了原版的若干问题。

## 两种运行形态（**请用独立进程**）

同一套逻辑（`src/app.ts`）跑在两种宿主上，由启动入口选择：

| 形态 | 入口 | 生命周期 | 适用 |
| --- | --- | --- | --- |
| **独立进程** ✅ | `bridge.ts` | **不依赖 OpenCode 的 location**，7×24 常驻 | 机器人 |
| 服务端插件 | `index.ts` | 绑在 location 上，location 被回收即被卸载 | 临时/开发 |

**为什么推荐独立进程**：OpenCode 会**主动回收空闲 location**（日志里 `location services evicted` 每天出现几十次），
收回时连带卸载该 location 上的插件。实测曾出现插件被卸载后 **9.4 小时无人接管**，机器人一直掉线——
因为此时进程内已无本插件的任何代码，定时器/锁/自查全部消失，无法自愈。
独立进程不受此影响，且崩溃后由守护脚本自动拉起。

## 架构（独立进程形态）

```
QQ 用户私聊
    │
    ▼
QQ 官方 WebSocket 网关 (wss://api.bot.qq.com/websocket/，本机主动外连，无需公网 IP)
    │  C2C_MESSAGE_CREATE / permission.asked / session.text.delta / session.idle …
    ▼
QQGateway（Token 预刷新 · 心跳+ACK 假死检测 · Resume 补发 · 指数退避重连）
    │
    ├── 指令层：/new  /workspace  /status  /help
    ├── 审批层：Approver（编号 → “同意 N / 拒绝 N / 总是 N”）
    ▼
BridgeHost（宿主抽象，两种实现）
    ├── HttpHost  ──► @opencode/client + Service.ensure()   独立进程形态
    └── PluginHost ─► setup(ctx) 的插件上下文              插件形态
          · session.create()          建会话（可指定 location）
          · session.prompt()          投递消息
          · session.wait()            等待本轮执行完成
          · session.context()         取助手最终文本
          · session.synthetic()       注入引导语（不触发回复）
          · permissionReply()         代为应答审批
          · subscribeEvents()         订阅事件流（流式 / 完成 / 出错推送）
    │
    ▼
QQApi.sendC2C（被动回复优先，额度耗尽降级主动消息；Markdown 失败降级纯文本）
```

## 相对原 `opencode-qq` 的修正

| 问题 | 原版 | 本项目 |
| --- | --- | --- |
| 插件 API | V1（`@opencode-ai/plugin`），V2 不加载 | V2（`export default { id, setup(ctx) }`） |
| `/gateway` 取址 | **缺 `Authorization: QQBot <token>` 头** | 已补 |
| access_token 错误 | 只看 HTTP 状态码，业务错误被当成功 | 按响应体 `code` 判定 |
| Windows 路径 | 用 `process.env.HOME`，Windows 常为空 | 回退 `os.homedir()` |
| 事件形状 | V1 `properties` | V2 `data`；`message.part.updated`→`session.text.*`，`session.error`→`session.execution.failed` |
| 取助手回复 | `session.prompt()` 直接返回 | V2 改为 `wait()` + `context()` |
| 完成推送 | 与同步回复重复打扰 | 用 in-flight 判定抑制重复 |
| 外部依赖 | `ws` 包 | 内建 `WebSocket`，零运行时依赖 |
| `msg_seq` 归属 | 存在实例上 | 提升到模块级，避免热重载重建实例后重复用号 |
| 长任务反馈 | 只有一句「已收到」 | 默认开启流式打字机，1~3 秒可见文字；并记录首字/工具数/总耗时 |
| 心跳假死 | 只发心跳不校验 ACK | 校验 ACK，连续未 ACK 判假死并强制重连 |

## 安装

```bash
cd D:/workspace/opencode-qq-v2
bun install
```

### 独立进程形态（推荐）

**不要**把它加进 `opencode.json` 的 `plugins` —— 独立进程自己通过 HTTP API 连 OpenCode。

**日常使用：双击桌面的「QQ机器人」快捷方式**（指向本仓库根目录的 `start-bridge.cmd`）。
会弹出一个控制台窗口：

- **关闭窗口即停止**
- 桥进程意外退出会自动重启（5 秒）
- 窗口标题即为状态提示；日志见 `~/.config/opencode/opencode-qq.log`

若窗口丢失、后台还有残留，用兜底脚本：

```powershell
pwsh -File scripts/stop.ps1
```

也可以在终端直接跑：

```bash
bun bridge.ts        # 或 cmd /c start-bridge.cmd
```

> ⚠️ `start-bridge.cmd` **必须保持纯 ASCII 内容**。批处理文件被 `cmd.exe` 按 OEM 代码页
> （中文系统是 GBK）解析，UTF-8 中文字节会导致语法错乱、脚本静默失败——这一坑已实测踩过。
> 中文只放在快捷方式名字里（`.lnk` 是 UTF-16，不受影响）。

#### 多机器人（多个 AppID 并存，单聊）

同一台机器可以同时跑多个单聊机器人。每个机器人 = **独立 AppID + 独立配置目录**，
彼此不共享会话、不共享日志、也不会互抢网关锁。

一键新建：

```powershell
pwsh -File scripts/new-bot.ps1 -Name bot-b -Workdir D:/workspace/proj-b
```

它会做三件事：

1. 建配置目录 `~/.config/opencode/bots/bot-b/`，按 `opencode-qq.example.json` 生成配置模板；
2. 在 `assets/bots/bot-b.ico` 生成图标（按机器人名稳定配色，也可用 `-C1`/`-C2` 指定）；
3. 创建「QQ机器人-bot-b」快捷方式（指向 `start-bridge.cmd bot-b`；目录规则见下方「快捷方式目录」）。

之后只需往该配置里填这个机器人的 `AppID`/`AppSecret`，双击快捷方式即可。

隔离边界全部由环境变量 `OPENCODE_QQ_CONFIG_DIR` 决定（`start-bridge.cmd <bot>` 会设置它）：

| 资源 | 路径 |
| --- | --- |
| 配置 | `<configDir>/opencode-qq.json` |
| 网关锁 | `<configDir>/opencode-qq-gateway.lock` |
| 会话映射 | `<configDir>/opencode-qq-sessions.json` |
| 实例锁 | `<configDir>/opencode-qq-instance.lock` |
| 日志 | `<configDir>/opencode-qq.log` |

约定与注意：

- 不带参数的 `start-bridge.cmd` 仍是「默认」实例，读 `~/.config/opencode/opencode-qq.json`，**与旧用法完全兼容**。
- 不同机器人**必须是不同的 AppID**：同一个 AppID 并发连网关会被平台踢下线。
- 会话严格隔离：同一个用户分别对两个机器人说话，得到两条互不相干的 OpenCode 会话。
- 工作目录按机器人各自配置（`workdir` / `workspaces`），可以指向不同项目，互不影响。
- 停止单个机器人：`pwsh -File scripts/stop.ps1 -Bot bot-b`；不带 `-Bot` 则停止全部桥进程。
- 不要用 `OPENCODE_QQ_CONFIG` 来做多实例隔离——它只换配置文件，锁 / 会话 / 日志仍会共用。
- **单实例**：同一个机器人的桥进程只允许一个。重复双击同一个快捷方式时，后启动的进程会打印
  「已有实例在运行」并自动关闭窗口（退出码 3），不会进入重启循环，也不会重复推送通知。
  守卫文件是 `<configDir>/opencode-qq-instance.lock`，按机器人隔离，多个机器人互不影响。
- **快捷方式约定**：`QQ机器人-<name>` → 目标 `start-bridge.cmd`，参数 `<name>`，
  图标 `assets/bots/<name>.ico`（同名恒定配色），窗口标题 `QQ Bot [<name>]`，便于多窗口区分。
- **快捷方式目录**：优先级为 `-ShortcutDir` 参数 > 环境变量 `OPENCODE_QQ_SHORTCUT_DIR` > 桌面。
  想集中放一处，设一次用户环境变量即可（下例把所有快捷方式放进 `D:\tools\快捷方式`）：
  `[Environment]::SetEnvironmentVariable('OPENCODE_QQ_SHORTCUT_DIR', 'D:\tools\快捷方式', 'User')`

##### 管理快捷方式（全部启动 / 全部停止）

```powershell
pwsh -File scripts/install-shortcuts.ps1   # 一次性创建下面两个快捷方式（目录同「快捷方式目录」规则）
```

| 快捷方式 | 行为 |
| --- | --- |
| `QQ机器人-全部启动` | 遍历默认实例与 `bots/*/`，逐个拉起（每个一个窗口；已在运行的会自行跳过） |
| `QQ机器人-全部停止` | 调 `scripts/stop.ps1` 停掉所有桥进程，并保留窗口显示结果 |

##### 把「默认实例」迁移成具名机器人（可选）

```powershell
pwsh -File scripts/stop.ps1                             # 先停掉默认实例
pwsh -File scripts/migrate-default-bot.ps1 -Name main   # 迁移并生成「QQ机器人-main」
```

迁移会移动 `opencode-qq.json`、`opencode-qq-sessions.json` 与日志到 `bots/main/`，
再由 `new-bot.ps1` 生成图标与快捷方式；旧的「QQ机器人」快捷方式会被清理。
**会话文件一并带走，所以历史上下文能延续。**

#### 可选：开机/登录自动启动

如果不想每次手动点（**注意：触发条件是「登录时」，不是「开机时」**）：

```powershell
pwsh -File scripts/install-task.ps1             # 默认实例
pwsh -File scripts/install-task.ps1 -Bot bot-b  # 指定机器人
pwsh -File scripts/uninstall-task.ps1 -Bot bot-b
```

任务名默认为 `opencode-qq-bridge`，带 `-Bot` 时为 `opencode-qq-bridge-<name>`；
它会在用户登录后延迟 30 秒启动 `scripts/supervisor.ps1`（带 `-Bot`），
由它拉起并看护 `bun bridge.ts`。若发现该机器人已有实例在运行，守护会自行退出，不会无限重启。

为什么不做成真正的 Windows 服务：服务默认以 `LocalSystem` 运行，**拿不到你的用户目录**
（配置 `~/.config/opencode/`、锁、日志都在那），也连不上**按用户注册的 OpenCode 服务**，
需要改成「以你的账户运行」并保存 Windows 密码才行。

### 插件形态（备选）

在 `~/.config/opencode/opencode.json` 的 `plugins` 数组里加入本目录
（**注意 V2 的键是 `plugins` 不是 `plugin`**）：

```jsonc
{
  "plugins": ["D:/workspace/opencode-qq-v2"]
}
```

OpenCode 会热加载；`opencode plugin list` 应能看到 `opencode-qq  local  .../index.ts`。
⚠️ 该形态无法 7×24 常驻（见上文 location 回收），仅建议临时使用。

> 两种形态可以同时存在：它们用同一把文件锁 `opencode-qq-gateway.lock` 互斥，
> 只有一个会真正持有 QQ 网关，不会重复收消息。

## 配置

凭据放本地文件 `~/.config/opencode/opencode-qq.json`（**不要提交到 Git**），或走环境变量。

```json
{
  "appId": "你的AppID",
  "appSecret": "你的AppSecret",
  "sandbox": true,
  "allowlist": ["你的openid"],
  "model": "providerID/modelID",
  "markdownReply": true,
  "streaming": false,
  "events": { "toolProgress": false }
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `appId` / `appSecret` | 必填 | QQ 开放平台 → 机器人 → 开发设置。**Token 鉴权已废弃，务必用 AppSecret** |
| `sandbox` | `false` | 沙箱环境走 `sandbox.api.sgroup.qq.com`；正式走 `api.bot.qq.com` |
| `allowlist` | `[]` | 允许的 **openid** 白名单。**空数组 = 不限制，强烈建议填上** |
| `model` | 无 | 覆盖模型，`providerID/modelID`；不填用 OpenCode 全局默认 |
| `workspaces` | 无 | 工作区白名单 `[{ name, path }]`。QQ 侧**只能在这些条目之间切换**，不能指定任意路径 |
| `defaultWorkspace` | 列表首项 | 默认工作区名；指向不存在的名字时回退首项 |
| `workdir` | 无 | 旧的单一工作目录；**仅在未配置 `workspaces` 时**作为唯一工作区（向后兼容） |
| `markdownReply` | `true` | 用 Markdown 发送，失败自动降级纯文本 |
| `streaming` | `true` | 打字机流式输出（依赖 `session.text.delta`），失败自动回落普通回复 |
| `events.toolProgress` | `false` | 推送工具执行进度（按会话 60 秒至多一条） |
| `events.mirrorSessionText` | `false` | 把**非 QQ 触发**的助手正文逐段镜像到 QQ（前缀 `📄 `）：在桌面端驱动同一个会话时，手机也能实时看到生成的内容。QQ 自己触发的回合由同步回复覆盖，不会重复。开启后 `session.idle` 不再补发「任务完成+摘要」，避免同一轮收两遍 |

环境变量（优先级高于文件）：`QQ_BOT_APPID`、`QQ_BOT_APPSECRET`、`QQ_BOT_MODEL`、`OPENCODE_QQ_CONFIG`（自定义文件路径）。

## 验证顺序（重要）

**第 1 步 · 先验凭据与网关，不要直接上插件：**

```bash
bun scripts/probe-qq.ts            # 连接并监听 90 秒
bun scripts/probe-qq.ts --token-only   # 只验 AppID/AppSecret
```

探针只打印令牌长度，不会打印密钥。用它确认：

1. `access_token` 能否换取 → 报 100016 就是 AppID/Secret 不对（沙箱与正式凭据可能不同）
2. `/gateway` 是否可达
3. 网关是否 `READY`
4. 手机私聊一条，是否收到 `📩` 并回显 `pong`

**第 2 步 · 拿到 openid**：探针输出里的 `openid : ...` 就是你的身份标识，填进 `allowlist`。

**第 3 步 · 启用插件**：重启 OpenCode（或等热加载），在 QQ 里发消息。

**第 4 步 · 逻辑自测**（不需要凭据）：

```bash
bun scripts/selftest.ts     # 44 项断言
bunx tsc --noEmit           # 类型检查
```

## QQ 侧指令

| 指令 | 行为 |
| --- | --- |
| `/new` | 重置**当前工作区**的会话 |
| `/workspace`（简写 `/ws`） | 列出工作区，标出当前项与会话状态 |
| `/workspace <名称\|序号>` | 切换工作区，历史相互独立 |
| `/status` | 查看当前工作区、目录、会话 ID、待审批数 |
| `/help` | 帮助 |
| `同意 N` / `拒绝 N` / `总是 N` | 应答第 N 号权限请求 |

## 多项目：工作区切换

**一个 QQ 号 × 每个工作区 = 各自独立的长期会话**，历史互不污染；切换项目不会把上一个项目的上下文带过去。

```json
{
  "workspaces": [
    { "name": "opencode", "path": "D:/workspace/opencode" },
    { "name": "img", "path": "D:/workspace/img-operation" }
  ],
  "defaultWorkspace": "opencode"
}
```

QQ 里：

```
你: /workspace
机器人: 当前工作区: opencode
        → 1. opencode — D:/workspace/opencode [已有会话]
          2. img — D:/workspace/img-operation [未开会话]
        切换: /workspace <名称|序号>

你: /ws 2
机器人: 已切换到工作区「img」
        目录: D:/workspace/img-operation
        下次消息将在此工作区新建会话
```

设计取舍：

- **只允许在配置声明的工作区之间切换**，不接受 QQ 里输入任意路径 —— 否则等于开放远程任意目录读写
- `path` 省略时该工作区跟随 OpenCode 当前目录
- 修改 `workspaces` / `defaultWorkspace` 会**重置全部会话绑定**（旧会话的位置无法迁移），日志会记 `工作区列表已变化`
- 存储格式为 v2（`{ version, current, sessions }`，键为 `openid::工作区`）；旧的 v1 文件（`openid → sessionId`）会自动迁移到默认工作区

## 安全须知

**这是一个远程代码执行入口。** QQ 账号被盗 = 别人能在你机器上跑命令。已做的收敛：

- `allowlist` 只放你自己的 openid
- 高风险操作走 `permission.asked` → QQ 审批，**不会自动放行**
- 密钥只从本地文件/环境变量读取，不落日志、不打印

建议额外在 OpenCode 配置里对 `bash`/`write`/`edit` 设更严格的 permission 规则。

## 运维与排障

### 运行日志

OpenCode 不采集插件 stdout，因此插件独立落盘：

```
C:\Users\Administrator\.config\opencode\opencode-qq.log
```

关键事件都会记录：插件启动（含 pid / 工作目录 / 模型）、网关连接与断开、收到消息、回复、权限请求、处理失败。
超过 2MB 自动滚动为 `.log.1`。**日志不含 AppSecret / access_token。**

### 重要：配置改动需要触发重载

插件**只在 `setup` 时读取 `opencode-qq.json`**。改完配置后需触发一次重载才生效：

- 改动 `D:\workspace\opencode-qq-v2` 下任一源码文件（OpenCode 监听该目录，会自动热加载），或
- `opencode service restart`

### 多实例互斥（为什么只有一个网关）

OpenCode 会**按 location 加载同一插件的多个实例**（同一进程内），服务本身也可能是多进程。
若每个实例都去连 QQ 网关，会出现多条 WS 会话、重复收消息、被平台踢下线、用户收到重复回复。

因此插件用文件锁 `opencode-qq-gateway.lock`（实例令牌 + 心跳 + TTL）保证**全局只有一个网关**：

- 抢到锁的实例运行网关；其余实例进入待命，每 30s 重试
- 持锁实例崩溃后锁在 60s 后过期，待命实例自动接管
- 锁归属是**实例**而非进程：旧实例 dispose 时不会误删新实例的锁（早期按 pid 归属的版本会，已修）

排查时看日志里是否只有一个 `网关已启动`，其余应为 `未抢到网关锁…进入待命`。

### 被动回复额度

QQ 的单聊被动回复（带 `msg_id`）**每条收到消息最多回复 4 次**（`MAX_REPLIES_PER_MSG_ID`），
且被动窗口为 60 分钟。额度用尽后会自动降级为主动消息。因此额度留给：

```
ack「已收到，处理中…」(seq=1) + 最终回答（可能分多片）+ 流式打字机
```

> 注意：`msg_seq` 计数器位于 `src/qq/api.ts` 的**模块级**。配置热重载会重建 `QQApi` 实例，
> 若计数器随实例清零，就会在被动窗口内对同一 `msg_id` 重复分配序号，
> 触发 `40054005 消息被去重，请检查请求msgseq`。回归用例见 `selftest`。

### 长时间任务怎么反馈进度

不额外发「仍在处理…」提示（之前版本会周期性推送，已去掉）。进度反馈依靠：

- **流式打字机**（`streaming: true`，默认开）：生成中的文本每 1.2 秒以全量快照推给 QQ，
  1~3 秒内就能看到文字开始出现
- **正文镜像**（`events.mirrorSessionText: true`）：桌面端/其它客户端驱动同一个会话时，
  每段助手正文一生成完就转发一条到 QQ（前缀 `📄 `），手机上也能实时跟进度
- 回复日志里的 `首字=… 工具=… 总耗时=…`，用于事后定位慢在哪一侧

### 模型必须配置

`ctx.session.create` 需要显式模型。若 `opencode-qq.json` 未设 `model` 且 OpenCode 也没有全局默认模型，
会在 QQ 里收到明确报错：`未配置模型：请在 opencode-qq.json 设置 "model": "providerID/modelID"…`

列出可用模型：

```powershell
opencode api get /api/model
```


## 已知限制

- **仅单聊（C2C）**。群聊需机器人提审上线后在管理端配置，个人开发者沙箱无法测群聊。
- **机器人不能主动开聊**，必须先由用户发消息。被动回复窗口 60 分钟，每条消息最多回 4 条；超窗转为主动消息，受平台频控与额度约束。
- 新机器人**正式环境默认启用 IP 白名单**，提审上线前需在管理端填本机公网出口 IP；沙箱不受影响。
- `session.text.delta` 是 ephemeral 事件，断线期间会丢片（`session.text.ended` 会补全量）。
- **离线期间的消息收不到**。QQ 单聊消息是 WebSocket 事件推送，平台**不提供拉取历史/离线消息的接口**；
  唯一的补偿是官方网关的 *Resume*：短暂断开（网络抖动、进程崩溃重启）后重连，网关会补发该 `seq` 之后
  遗漏的事件。为此本桥把 `session_id` + `last_seq` 落盘到 `<configDir>/opencode-qq-gateway-session.json`，
  让重启也能接住这段补发（日志会打印「网关会话已恢复」；失败则回落到重建会话）。
  **关机或长时间离线（会话过期）期间的消息平台侧已不存在，无法恢复** —— 只能靠保持常驻来压缩这个窗口。
- 会话建在**当前工作区**的目录下。未配置 `workspaces` 时等价于 `workdir`；两者都没有时跟随 OpenCode 当前目录。

## 目录结构

```
bridge.ts                 独立进程入口（7×24 常驻形态，推荐）
index.ts                  插件入口（export default { id, setup }；备选形态）
src/
  app.ts                  应用编排层（与宿主无关，两种形态共用）
  host/
    http-host.ts          独立进程宿主：@opencode/client + Service.ensure()
    plugin-host.ts        插件宿主：setup(ctx) 的插件上下文
  session-manager.ts      每个 (openid, 工作区) ↔ 独立长期会话，落盘延续（v2 格式，含 v1 迁移）
  workspaces.ts           工作区列表解析、按名/序号查找、变更指纹
  text-buffer.ts          累计 session.text.* 流式文本
  event-pusher.ts         完成 / 出错 / 工具进度推送
  approver.ts             权限请求编号与应答解析
  lock.ts                 跨实例互斥锁（令牌 + 心跳 + TTL 接管）
  logger.ts               独立文件日志
  config.ts               配置加载（环境变量 > 文件）
  constants.ts            端点、intent、超时、路径
  qq/{auth,gateway,api,stream,session-store}.ts   QQ 官方协议实现（session-store：会话落盘，供重启后 Resume）
  util/{chunk,media,quote,throttle}.ts
scripts/
  supervisor.ps1          守护脚本（-Bot 指定机器人；桥崩溃后自动重启）
  install-task.ps1        注册「登录时自启」计划任务（-Bot）
  uninstall-task.ps1      卸载计划任务（-Bot）
  stop.ps1                停止桥进程（-Bot 只停指定机器人；不带则停全部）
  new-bot.ps1             新建机器人实例（配置目录 + 图标 + 桌面快捷方式）
  migrate-default-bot.ps1 把默认实例迁移成具名机器人（可选，一次性）
  install-shortcuts.ps1   创建「全部启动 / 全部停止」桌面快捷方式
  make-bot-icon.ps1       生成机器人图标（多尺寸 .ico）
  make-glyph-icon.ps1     生成管理图标（▶ 运行 / ■ 停止）
  icon-lib.ps1            .ico 生成共享实现（供上面两个图标脚本复用）
  probe-qq.ts             凭据 + 网关 + 收发连通性探针
  selftest.ts             无凭据逻辑自测
  start-all.ps1           拉起所有机器人（配置几个启动几个；已在运行的跳过）
assets/
  qqbot.ico               默认机器人的图标（桌面快捷方式引用）
  run-all.ico             管理快捷方式图标「全部启动」
  stop-all.ico            管理快捷方式图标「全部停止」
  bots/<name>.ico         各机器人实例图标（由 new-bot.ps1 生成）
start-bridge.cmd          手动启动入口（桌面快捷方式指向它；保持纯 ASCII）
                          无参数 = 默认实例；`start-bridge.cmd <bot>` = 多机器人实例
stop-all.cmd              停止所有机器人（包装 scripts/stop.ps1；保持纯 ASCII）
```

## License

MIT（移植自 `opencode-qq`，MIT）
