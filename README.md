# opencode-qq-v2

把 **QQ 官方机器人**接到 **OpenCode V2**：在手机 QQ 单聊里直接给 OpenCode 下指令，AI 回复发回 QQ，
需要执行危险操作时在 QQ 里审批。

原 `opencode-qq`（npm v0.1.0）是 **OpenCode V1 插件**，官方明确 *"V1 plugin implementations do not run in V2"*，
因此本项目把它**移植到 V2 插件 API**，并修掉了原版的若干问题。

## 架构

```
QQ 用户私聊
    │
    ▼
QQ 官方 WebSocket 网关 (wss://api.bot.qq.com/websocket/，本机主动外连，无需公网 IP)
    │  C2C_MESSAGE_CREATE / permission.asked / session.text.delta / session.idle …
    ▼
QQGateway（Token 预刷新 · 心跳 · Resume 补发 · 指数退避重连）
    │
    ├── 指令层：/new  /workspace  /status  /help
    ├── 审批层：Approver（编号 → “同意 N / 拒绝 N / 总是 N”）
    ▼
V2Bridge ──► OpenCode V2 插件上下文 ctx
    · ctx.session.create()            建会话
    · ctx.session.prompt()            投递消息
    · ctx.session.wait()              等待本轮执行完成
    · ctx.session.context()           取助手最终文本
    · ctx.session.synthetic()         注入引导语（不触发回复）
    · ctx.permission.reply()          代为应答审批
    · ctx.event.subscribe()           订阅事件流（流式 / 完成 / 出错推送）
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

在 `~/.config/opencode/opencode.json` 的 `plugins` 数组里加入本目录（**注意 V2 的键是 `plugins` 不是 `plugin`**）：

```jsonc
{
  "plugins": [
    "./plugins/codebuddy-auth",
    "D:/workspace/opencode-qq-v2"
  ]
}
```

OpenCode 会热加载；`opencode plugin list` 应能看到 `opencode-qq  local  .../index.ts`。

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
- 回复日志里的 `首字=… 工具=… 总耗时=…`，用于事后定位慢在哪一侧

### 模型必须配置

`ctx.session.create` 需要显式模型。若 `opencode-qq.json` 未设 `model` 且 OpenCode 也没有全局默认模型，
会在 QQ 里收到明确报错：`未配置模型：请在 opencode-qq.json 设置 "model": "providerID/modelID"…`

列出可用模型：

```powershell
opencode api get /api/model
```


- **仅单聊（C2C）**。群聊需机器人提审上线后在管理端配置，个人开发者沙箱无法测群聊。
- **机器人不能主动开聊**，必须先由用户发消息。被动回复窗口 60 分钟，每条消息最多回 4 条；超窗转为主动消息，受平台频控与额度约束。
- 新机器人**正式环境默认启用 IP 白名单**，提审上线前需在管理端填本机公网出口 IP；沙箱不受影响。
- `session.text.delta` 是 ephemeral 事件，断线期间会丢片（`session.text.ended` 会补全量）。
- 会话建在**当前工作区**的目录下。未配置 `workspaces` 时等价于 `workdir`；两者都没有时跟随 OpenCode 当前目录。

## 目录结构

```
index.ts                 插件入口（export default { id, setup }）
src/
  bridge.ts              V2 宿主绑定层（prompt/wait/context/synthetic/permission）
  session-manager.ts     每个 (openid, 工作区) ↔ 独立长期会话，落盘延续（v2 格式，含 v1 迁移）
  workspaces.ts          工作区列表解析、按名/序号查找、变更指纹
  text-buffer.ts         累计 session.text.* 流式文本
  event-pusher.ts        完成 / 出错 / 工具进度推送
  approver.ts            权限请求编号与应答解析
  lock.ts                跨实例互斥锁（令牌 + 心跳 + TTL 接管）
  logger.ts              独立文件日志
  config.ts              配置加载（环境变量 > 文件）
  constants.ts           端点、intent、超时、路径
  qq/{auth,gateway,api,stream}.ts   QQ 官方协议实现
  util/{chunk,media,quote,throttle}.ts
scripts/
  probe-qq.ts            凭据 + 网关 + 收发连通性探针
  selftest.ts            无凭据逻辑自测（60 项断言）
```

## License

MIT（移植自 `opencode-qq`，MIT）
