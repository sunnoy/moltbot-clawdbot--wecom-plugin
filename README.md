# OpenClaw 企业微信（WeCom）增强插件

[![npm](https://img.shields.io/npm/v/@sunnoy/wecom)](https://www.npmjs.com/package/@sunnoy/wecom)
[![license](https://img.shields.io/npm/l/@sunnoy/wecom)](LICENSE)

`@sunnoy/wecom` 是 [OpenClaw](https://github.com/openclaw/openclaw) 企业微信渠道的**社区增强插件**，基于官方 [`@wecom/wecom-openclaw-plugin`](https://github.com/WecomTeam/wecom-openclaw-plugin) 的 WebSocket 长连接骨架，提供多账号管理、动态 Agent 隔离、Agent API / Webhook 增强出站、指令白名单、配额感知等企业级特性。

底层 SDK：[`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk) — 企业微信智能机器人 Node.js SDK。

> **⚠️ 从 HTTP 回调迁移到长连接：** 2.0 版本完全采用企业微信 [AI 机器人 WebSocket 长连接模式](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657)。如果你之前使用 HTTP 回调（Token + EncodingAESKey + 回调 URL），需要在企业微信管理后台将机器人切换到长连接模式，然后删除旧的回调配置。切换后只需 `botId` 和 `secret` 即可接入。

> **2.1 新增：** 在 WS 长连接之外，2.1 版本新增了企业微信**自建应用"接收消息"HTTP 回调**作为可选入站通道。在 `channels.wecom.agent` 下配置 `callback.token`、`callback.encodingAESKey`、`callback.path` 即可同时启用，与 WS 通道并行运行，互不影响。

## 相比官方插件的增强特性

下表列出了本插件相比 [官方 WeCom OpenClaw 插件](https://github.com/WecomTeam/wecom-openclaw-plugin)（[npm](https://www.npmjs.com/package/@wecom/wecom-openclaw-plugin)）额外提供的能力：

| 特性 | 官方插件 | 本插件 |
| --- | :---: | :---: |
| WebSocket 长连接 + 流式回复 | ✅ | ✅ |
| 私聊 / 群聊接收 | ✅ | ✅ |
| DM 准入策略（pairing / open / allowlist / disabled） | ✅ | ✅ |
| 群聊准入策略（open / allowlist / disabled） | ✅ | ✅ |
| 按群配置发送者白名单 | ✅ | ✅ |
| 思考占位（`<think>` 占位符） | ✅ | ✅ |
| CLI 交互式配置向导 | ✅ | ✅ |
| **多账号管理**（多 Bot 独立配置、共享字段继承） | ❌ | ✅ |
| **动态 Agent 路由**（按用户 / 群自动隔离会话与工作区） | ❌ | ✅ |
| **Workspace 模板**（自动为新 Agent 复制 AGENTS.md 等引导文件） | ❌ | ✅ |
| **Agent API 增强出站**（自建应用主动发送文本、图片、文件） | ❌ | ✅ |
| **部门 / 标签目标发送**（`party:` / `tag:` 寻址） | ❌ | ✅ |
| **Webhook Bot 群通知**（命名 webhook 映射，markdown / 图片 / 文件） | ❌ | ✅ |
| **指令白名单**（限制普通用户可执行的 slash 命令） | ❌ | ✅ |
| **管理员绕过**（命令白名单 + 动态 Agent 路由） | ❌ | ✅ |
| **运行时配额感知**（被动回复 24h 窗口 + 主动发送额度追踪与告警） | ❌ | ✅ |
| **Pending Reply 重试**（WS 断连后自动通过 Agent API 补发未送达回复） | ❌ | ✅ |
| **Reasoning 流式节流**（800ms 节流防止 SDK 队列溢出） | ❌ | ✅ |
| **`<think>` 标签规范化**（兼容 `<thinking>` / `<thought>` 等变体） | ❌ | ✅ |
| **Reply 媒体指令解析**（自动提取 LLM 输出中的 `MEDIA:` / `FILE:` 路径） | ❌ | ✅ |
| **出站代理**（`network.egressProxyUrl`） | ❌ | ✅ |
| **自定义 API 基础地址**（`network.apiBaseUrl` / `WECOM_API_BASE_URL`） | ❌ | ✅ |
| **Bindings 路由**（固定绑定企业微信账号到指定 Agent） | ❌ | ✅ |
| **消息去重**（reqId + msgId 去重，防止重复处理） | ❌ | ✅ |
| **入站图文混排**（`mixed` 消息拆解为文本 + 图片） | ❌ | ✅ |
| **入站语音转写**（`voice.content` 自动提取） | ❌ | ✅ |
| **入站引用消息**（`quote` 上下文透传） | ❌ | ✅ |
| **自建应用回调入站**（HTTP 回调作为独立入站通道，与 WS 并行） | ❌ | ✅ |
| **Agent API Markdown 回复**（回调入站回复默认 markdown 格式） | ❌ | ✅ |
| **入站/出站信息日志**（WS / CB 收发日志，便于追踪消息流） | ❌ | ✅ |

## 目录

- [相比官方插件的增强特性](#相比官方插件的增强特性)
- [前置要求](#前置要求)
- [安装](#安装)
- [从 HTTP 回调迁移](#从-http-回调迁移)
- [运行测试](#运行测试)
- [配置](#配置)
- [私聊与群聊准入策略](#私聊与群聊准入策略)
- [企业微信侧配置](#企业微信侧配置)
- [消息能力与投递策略](#消息能力与投递策略)
- [动态 Agent 与路由](#动态-agent-与路由)
- [自建应用回调入站](#自建应用回调入站)
- [常见问题](#常见问题)
- [项目结构](#项目结构)
- [自定义 Skills 配合沙箱使用实践](#自定义-skills-配合沙箱使用实践)
- [相关链接](#相关链接)
- [贡献与协议](#贡献与协议)

## 前置要求

- 已安装 [OpenClaw](https://github.com/openclaw/openclaw) `2026.3.23-2+`
- 企业微信管理后台权限，可创建 AI 机器人或自建应用
- **机器人已切换到长连接模式**（参考[官方文档](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657)）
- 运行 OpenClaw 的机器可以出站访问：
  - `wss://openws.work.weixin.qq.com`
  - `https://qyapi.weixin.qq.com`（启用 Agent / Webhook 时）

Bot 主链路不需要企业微信反向访问你的 HTTP 回调地址。

## 安装

```bash
openclaw plugins install @sunnoy/wecom
```

> **3.0 兼容性说明：** 从 `3.0.0` 开始，本插件仅支持 OpenClaw `2026.3.23-2+`。旧版 OpenClaw 请继续使用 `2.x`。

> **从官方插件迁移：** 如果之前使用 `openclaw plugins install @wecom/wecom-openclaw-plugin`，请先卸载官方插件再安装本插件。`channels.wecom` 配置字段兼容，无需修改。

## 从 HTTP 回调迁移

如果之前使用 HTTP 回调模式（Token + EncodingAESKey + 回调 URL），迁移步骤如下：

1. **企业微信后台**：进入「应用管理」→「智能机器人」，将机器人切换到长连接模式（参考[官方文档](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657)）
2. **记录凭证**：切换后获取新的 `BotId` 和 `Secret`
3. **更新配置**：在 `~/.openclaw/openclaw.json` 中：
   - 设置 `channels.wecom.botId` 和 `channels.wecom.secret`
   - 删除旧的 `token`、`encodingAesKey`、回调 URL 相关配置
4. **安装插件**：`openclaw plugins install @sunnoy/wecom`
5. **重启 Gateway**：`openclaw gateway restart`

迁移后不再需要公网可达的 HTTP 回调地址，插件会主动连接企业微信 WebSocket。

## 运行测试

```bash
npm test
```

## 配置

### 单账号示例

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "plugins": {
    "entries": {
      "wecom": {
        "enabled": true
      }
    }
  },
  "channels": {
    "wecom": {
      "enabled": true,
      "botId": "aibxxxxxxxxxxxxxxxx",
      "secret": "xxxxxxxxxxxxxxxx",
      "welcomeMessage": "你好，我是 AI 助手。",
      "sendThinkingMessage": true,
      "dmPolicy": "pairing",
      "allowFrom": [],
      "groupPolicy": "open",
      "groupAllowFrom": [],
      "adminUsers": ["admin-userid"],
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/compact", "/help", "/status"]
      },
      "dynamicAgents": {
        "enabled": true,
        "adminBypass": false
      },
      "dm": {
        "createAgentOnFirstMessage": true
      },
      "groupChat": {
        "enabled": true,
        "requireMention": true,
        "mentionPatterns": ["@"]
      },
      "workspaceTemplate": "/path/to/template-dir",
      "mediaLocalRoots": ["/tmp/openclaw"],
      "agent": {
        "corpId": "wwxxxxxxxxxxxxxxxx",
        "corpSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "agentId": 1000002
      },
      "webhooks": {
        "ops": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
        "dev": "yyy"
      },
      "network": {
        "egressProxyUrl": "http://proxy.internal:8080",
        "apiBaseUrl": "https://qyapi.weixin.qq.com"
      }
    }
  }
}
```

`webhooks` 的 value 既可以是完整 URL，也可以只写群机器人的 `key`。

### 核心配置

| 配置项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `plugins.entries.wecom.enabled` | boolean | 是 | 启用插件 |
| `channels.wecom.enabled` | boolean | 否 | 渠道开关 |
| `channels.wecom.botId` | string | 是 | 企业微信 AI 机器人 Bot ID |
| `channels.wecom.secret` | string | 是 | 企业微信 AI 机器人 Secret |
| `channels.wecom.websocketUrl` | string | 否 | WS 地址，默认 `wss://openws.work.weixin.qq.com` |
| `channels.wecom.sendThinkingMessage` | boolean | 否 | 是否先发送 `<think></think>` 占位，默认 `true` |
| `channels.wecom.welcomeMessage` | string | 否 | 进入会话欢迎语（非空时固定使用该字符串） |
| `channels.wecom.welcomeMessagesFile` | string | 否 | 欢迎语列表文件路径。支持：`{ "messages": [ ... ] }` 或顶层数组；每条欢迎语可为**一行一个字符串的数组**（推荐，易读），或单条字符串（可含 `\\n`）。相对路径基于 OpenClaw 状态目录（`~/.openclaw` 或 `OPENCLAW_STATE_DIR`）。未设置 `welcomeMessage` 时从该文件随机选取；**修改文件后无需重启服务**（按 mtime 自动重读） |
| `channels.wecom.adminUsers` | string[] | 否 | 管理员用户 ID，可绕过命令白名单 |
| `channels.wecom.defaultAccount` | string | 否 | 多账号模式默认账号 |

### 准入与安全配置

| 配置项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `channels.wecom.dmPolicy` | string | 否 | `pairing`、`allowlist`、`open`、`disabled`，默认 `pairing` |
| `channels.wecom.allowFrom` | string[] | 否 | 私聊 allowlist |
| `channels.wecom.groupPolicy` | string | 否 | `open`、`allowlist`、`disabled`，默认 `open` |
| `channels.wecom.groupAllowFrom` | string[] | 否 | 允许触发的群聊 ID 列表 |
| `channels.wecom.groups` | object | 否 | 按群覆盖配置，可为某个群单独设置 `allowFrom` |
| `channels.wecom.commands.enabled` | boolean | 否 | 是否启用命令白名单，默认 `true` |
| `channels.wecom.commands.allowlist` | string[] | 否 | 普通用户允许执行的命令 |

### 路由与工作区配置

| 配置项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `channels.wecom.dynamicAgents.enabled` | boolean | 否 | 是否启用动态 Agent，默认 `true` |
| `channels.wecom.dynamicAgents.adminBypass` | boolean | 否 | 管理员是否绕过动态 Agent，默认 `false` |
| `channels.wecom.dm.createAgentOnFirstMessage` | boolean | 否 | 私聊是否按用户建独立 Agent，默认 `true` |
| `channels.wecom.groupChat.enabled` | boolean | 否 | 是否启用群聊处理，默认 `true` |
| `channels.wecom.groupChat.requireMention` | boolean | 否 | 群聊是否要求 @ 才响应，默认 `true` |
| `channels.wecom.groupChat.mentionPatterns` | string[] | 否 | 群聊触发前缀，默认 `["@"]` |
| `channels.wecom.workspaceTemplate` | string | 否 | 动态 Agent 工作区模板目录 |
| `channels.wecom.mediaLocalRoots` | string[] | 否 | 额外允许被动回复读取的宿主机目录列表。用于放行 `MEDIA:/abs/path` 或 `FILE:/abs/path` 指向的本地文件；默认只允许当前 Agent workspace 和浏览器产物目录。多账号模式下也可配置在 `channels.wecom.<accountId>.mediaLocalRoots`。修改后需重启 Gateway 生效 |

### 增强出站配置

| 配置项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `channels.wecom.agent.corpId` | string | 否 | 自建应用 CorpID |
| `channels.wecom.agent.corpSecret` | string | 否 | 自建应用 Secret |
| `channels.wecom.agent.agentId` | number | 否 | 自建应用 AgentId |
| `channels.wecom.agent.replyFormat` | string | 否 | 回调入站回复格式，`"markdown"`（默认）或 `"text"` |
| `channels.wecom.agent.callback.token` | string | 否 | 回调验签 Token |
| `channels.wecom.agent.callback.encodingAESKey` | string | 否 | 回调消息解密密钥（43 位） |
| `channels.wecom.agent.callback.path` | string | 否 | 回调 HTTP 路由路径，如 `"/webhooks/app"` |
| `channels.wecom.webhooks` | object | 否 | 群机器人 webhook 映射 |
| `channels.wecom.network.egressProxyUrl` | string | 否 | Agent / Webhook 出站代理 |
| `channels.wecom.network.apiBaseUrl` | string | 否 | 企业微信 API 基础地址覆盖，默认官方地址 |

Agent 增强出站不需要 `token`、`encodingAesKey`、回调 URL；只有需要同时启用**回调入站**时才需配置 `agent.callback.*`。

### 多账号示例

```json
{
  "channels": {
    "wecom": {
      "defaultAccount": "open",
      "adminUsers": ["admin-userid"],
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/compact", "/help", "/status"]
      },
      "open": {
        "botId": "aib-open-xxx",
        "secret": "secret-open-xxx",
        "dmPolicy": "open"
      },
      "support": {
        "botId": "aib-support-xxx",
        "secret": "secret-support-xxx",
        "dmPolicy": "pairing",
        "mediaLocalRoots": ["/tmp/openclaw"],
        "agent": {
          "corpId": "wwxxxxxxxxxxxxxxxx",
          "corpSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "agentId": 1000002
        },
        "webhooks": {
          "ops": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
        }
      }
    }
  }
}
```

多账号模式下：

- 顶层共享字段会合并到各账号
- `channels.wecom.<accountId>` 是每个账号自己的覆盖项
- 动态 Agent ID 会自动带账号前缀
- 旧的 v1 `token` / `encodingAesKey` 字段不再使用

## 私聊与群聊准入策略

### 私聊 `dmPolicy`

| 值 | 含义 |
| --- | --- |
| `pairing` | 默认模式。陌生用户首次私聊会收到配对码，管理员执行 `openclaw pairing approve wecom <code>` 后放行 |
| `allowlist` | 只允许 `allowFrom` 中的用户私聊，不自动发配对码 |
| `open` | 允许所有能私聊机器人的企业微信成员直接进入会话 |
| `disabled` | 禁用私聊 |

`open` 的含义就是：如果机器人可见范围允许，企业内任何能私聊到这个 Bot 的成员都可以直接使用。

### 群聊策略

| 配置 | 说明 |
| --- | --- |
| `groupPolicy: "open"` | 所有群可触发 |
| `groupPolicy: "allowlist"` + `groupAllowFrom` | 只允许指定群 |
| `groupPolicy: "disabled"` | 禁用群聊 |
| `groupChat.requireMention` | 群聊是否必须 @ 才触发 |
| `groups.<chatId>.allowFrom` | 某个群里仅允许指定成员触发 |

## 企业微信侧配置

### 1. 创建 AI 机器人（Bot 主链路）

这是 v2 的主接入方式，使用 WebSocket 长连接。

1. 登录[企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 进入「应用管理」→「智能机器人」
3. 创建机器人，选择长连接模式（参考[官方文档](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657)）
4. 创建完成后记录 `BotId` 和 `Secret`
5. 填入 OpenClaw 配置的 `channels.wecom.botId` 和 `channels.wecom.secret`
6. 启动 OpenClaw，插件会主动连接官方 WebSocket

长连接模式下不需要配置 HTTP 回调 URL、Token、EncodingAESKey。

### 2. 创建自建应用（Agent 增强出站 + 可选回调入站）

自建应用承担两个可选职责：

**增强出站**（主动推送消息）：
- 主动给用户 / 群 / 部门 / 标签发消息
- 上传图片和文件
- 当 WS 断连时作为回复后备通道

**回调入站**（可选，与 WS 并行）：
- 企业微信将用户消息以 HTTP POST 推送到你的服务器
- 适合需要独立入站 URL 或不方便使用 WS 长连接的场景

创建步骤：

1. 在企业微信后台创建自建应用
2. 记录 `CorpID`、`AgentId`、`Secret`
3. 填入配置：
   - `channels.wecom.agent.corpId`
   - `channels.wecom.agent.agentId`
   - `channels.wecom.agent.corpSecret`
4. **仅启用回调入站时**，额外在应用的「接收消息」中配置回调 URL，并填入对应的 `agent.callback.*` 配置（见[自建应用回调入站](#自建应用回调入站)）

### 3. 配置群机器人（Webhook 增强出站，可选）

Webhook 只负责群通知。

1. 在目标群添加群机器人
2. 复制 webhook URL 或 key
3. 配置到 `channels.wecom.webhooks`
4. 发送目标使用 `webhook:<name>`

## 消息能力与投递策略

### 能力矩阵

| 能力 | Bot（WS） | Agent API | Webhook |
| --- | :---: | :---: | :---: |
| 私聊接收 | ✅ | ✅（回调入站） | — |
| 群聊接收（可配置 @ 触发） | ✅ | ✅（回调入站） | — |
| 被动流式回复 | ✅ | — | — |
| 被动最终帧图片 | ✅ | ✅ | ✅ |
| 主动发送文本 | ✅ | ✅ | ✅ |
| 主动发送图片 / 文件 | — | ✅ | ✅ |
| 发送到部门 / 标签 | — | ✅ | — |
| 思考过程 `<think>` | ✅ | — | — |
| 欢迎语 | ✅ | — | — |
| WS 断连补发 | — | ✅ | — |

### 入站消息

| 类型 | 说明 |
| --- | --- |
| `text` | 文本消息 |
| `image` | 图片（AES 加密下载 + 解密） |
| `voice` | 语音（自动提取转写文本 `voice.content`） |
| `file` | 文件（AES 加密下载 + 解密） |
| `mixed` | 图文混排（自动拆解为文本 + 图片） |
| `quote` | 引用消息（上下文透传） |

### 被动回复

被动回复统一走 WebSocket `replyStream`：

- 文本内容支持 Markdown
- `<thinking>`、`<thought>` 等变体会被规范化为 `<think>`
- 可先发送 `<think></think>` 占位（配置 `sendThinkingMessage`）
- 思考流式更新采用 800ms 节流，防止 SDK 队列溢出
- 最终回复 `finish=true` 时可附带图片 `msg_item`
- 若最终回复包含 WS 不支持的媒体（文件等），会先文本提示再通过 Agent API 补发

本插件会自动解析模型输出中的 `MEDIA:` / `FILE:` 指令，并在回复完成后上传对应文件：

- 图片使用 `MEDIA:/abs/path`
- PDF、音频、视频、压缩包、Office 文档等非图片文件使用 `FILE:/abs/path`
- 沙箱内当前工作区文件可直接写成 `MEDIA:/workspace/...` 或 `FILE:/workspace/...`
- 浏览器生成的文件默认允许从 OpenClaw 状态目录下的浏览器媒体目录读取
- 宿主机其他目录默认不放行；如果需要回复 `/tmp/openclaw/report.pdf` 这类文件，请把其父目录加入 `channels.wecom.mediaLocalRoots`，多账号模式可配在 `channels.wecom.<accountId>.mediaLocalRoots`
- 更新 `mediaLocalRoots` 后需重启 Gateway 生效

### 主动发送与后备策略

主动发送分层：

1. 普通文本优先走 WS `sendMessage`
2. 目标为 `webhook:<name>` 时走 Webhook
3. 目标为用户 / 群 / 部门 / 标签，且配置了 Agent 时走 Agent API
4. 发送图片 / 文件时，WS 侧给出文本提示，媒体交给 Agent / Webhook 通道
5. 未配置 Agent / Webhook 时，只保留 WS 文本提示

### WS 断连自动重试

当 WS 断连导致最终回复发送失败时：

1. 插件自动将未送达回复加入 pending 队列（TTL 5 分钟，最多 50 条）
2. WS 重连并认证成功后，自动通过 Agent API 补发所有 pending 回复
3. 过期条目自动丢弃，不会无限积压

### 运行时配额感知

插件做本地近似记账，并把状态暴露到账号 snapshot / status：

- 连接占线：同一个 `botId` 被其他实例接管时，标记 `displaced`
- 24h 被动回复窗口：按会话追踪 reply quota（限额 30，告警 24）
- 每会话每日主动发送额度：按会话追踪 active send quota（限额 10，告警 8）
- 接近上限或触顶时输出 warning

当前策略是"感知 + 告警"，不做硬阻断。

### 支持的目标格式

| 格式 | 示例 | 说明 |
| --- | --- | --- |
| `wecom:<userId>` | `wecom:zhangsan` | 发给企业微信用户 |
| `group:<chatId>` | `group:wr123456` | 发给群聊 |
| `party:<id>` | `party:2` | 发给部门 |
| `tag:<name>` | `tag:Developers` | 发给标签 |
| `webhook:<name>` | `webhook:ops` | 发给 webhook 群 |
| `<chatId>` | `wr123456` | 直接写群 ID 也可识别 |

## 动态 Agent 与路由

### 动态 Agent

默认路由规则：

- 私聊：`wecom-dm-<userId>`
- 群聊：`wecom-group-<chatId>`
- 多账号私聊：`wecom-<accountId>-dm-<userId>`
- 多账号群聊：`wecom-<accountId>-group-<chatId>`

好处：

- 每个用户 / 群聊独立上下文
- 每个动态 Agent 独立工作区
- 可以按账号进一步隔离

### Workspace 模板

`workspaceTemplate` 目录中的模板文件会在动态 Agent 首次创建时复制到工作区：

- `AGENTS.md`、`BOOTSTRAP.md`、`CLAUDE.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`system-prompt.md`

插件会在工作区里写入 `.openclaw/wecom-template-state.json` 记录首次模板同步状态。已有 state 的工作区后续只补缺，不覆盖已有文件。

`BOOTSTRAP.md` 只会在工作区还没有 `memory/` 或 `MEMORY.md` 时参与同步；一旦工作区已经出现记忆痕迹，插件就不再回种 bootstrap，避免打断已完成 onboarding 的会话。

历史工作区如果还没有 state，插件会先补写 state，再按“只补缺、不覆盖”处理，避免存量工作区被重新整批同步。

### Bindings

如果 OpenClaw 配置了 `bindings`，则优先按 binding 路由，不会被动态 Agent 覆盖。

## 自建应用回调入站

自建应用的「接收消息」HTTP 回调可作为额外的入站通道，与 WS 长连接并行运行，互不干扰。适合已有自建应用的场景，或需要独立回调 URL 的情况。

### 配置

在 `channels.wecom.agent` 下增加 `callback` 子对象：

```json
{
  "channels": {
    "wecom": {
      "botId": "aib-xxx",
      "secret": "bot-secret-xxx",
      "agent": {
        "corpId": "wwxxxxxxxxxxxx",
        "corpSecret": "app-secret-xxx",
        "agentId": 1000002,
        "replyFormat": "markdown",
        "callback": {
          "token": "YourToken",
          "encodingAESKey": "43位密钥",
          "path": "/webhooks/app"
        }
      }
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `agent.callback.token` | 企业微信「接收消息」里配置的 Token |
| `agent.callback.encodingAESKey` | 43 位 EncodingAESKey |
| `agent.callback.path` | Gateway 监听的 HTTP 路径，需与企业微信后台填写的 URL 一致 |
| `agent.replyFormat` | 回复格式，`"markdown"`（默认）或 `"text"` |

### 企业微信侧配置

1. 进入自建应用 → 「接收消息」
2. 填写 URL：`https://<your-gateway-host>:<port><path>`（例如 `https://example.com:18789/webhooks/app`）
3. 填写 Token 和 EncodingAESKey（与配置保持一致）
4. 点击「保存」，企业微信将发送 GET 请求验证（gateway 会自动回复 echostr）
5. 验证通过后，用户发给自建应用的消息将通过 HTTP POST 推送到 gateway

### 支持的消息类型

| 类型 | 说明 |
| --- | --- |
| `text` | 文本消息 |
| `image` | 图片（通过 Agent API 下载） |
| `voice` | 语音文件 |
| `file` | 文件 |
| `video` | 视频文件 |

事件类消息（关注、进入会话等）会被静默忽略。

## 常见问题

### Q: 2.0 和之前最大的区别是什么？

2.0 完全采用 WebSocket 长连接，不再使用 HTTP 回调。需要在企业微信后台将机器人切换到[长连接模式](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657)。

### Q: 3.0 为什么不能再装在旧 OpenClaw 上？

3.0 开始直接适配 OpenClaw `2026.3.23-2+` 的新版 plugin SDK 导出和媒体/runtime 约定，旧版 core 缺少这些接口。旧环境请固定使用 `2.x`。

### Q: 之前用的官方插件 `@wecom/wecom-openclaw-plugin`，怎么迁移？

```bash
# 卸载官方插件
openclaw plugins uninstall wecom-openclaw-plugin
# 安装本插件
openclaw plugins install @sunnoy/wecom
# 重启
openclaw gateway restart
```

`channels.wecom` 配置字段兼容，无需修改。

### Q: `dmPolicy: "open"` 是不是企业里任何人都能私聊？

是。前提是该成员对这个机器人可见，并且能在企业微信里私聊到它。

### Q: `pairing` 模式怎么放行用户？

用户第一次私聊会收到配对码。管理员执行：

```bash
openclaw pairing approve wecom <code>
```

### Q: Agent 还需要配置 `token` / `encodingAesKey` 吗？

不需要。Agent 只做增强出站，保留 `corpId`、`corpSecret`、`agentId` 即可。

### Q: 入站图片还依赖全局 `EncodingAESKey` 吗？

不依赖。WS 消息体里的图片 / 文件自带独立 `aeskey`，插件按 `image.aeskey` 或 `file.aeskey` 下载与解密。

### Q: 收到 `disconnected_event` 是什么情况？

通常表示同一个 `botId` 被另一个实例接管了。企业微信同一时刻只允许一个活跃长连接。

### Q: 什么时候会走 Agent 或 Webhook？

- `webhook:<name>` 目标固定走 Webhook
- 发送部门 / 标签 / 媒体消息时优先走 Agent
- WS 断连后的 pending 回复通过 Agent API 补发
- WS 文本主动发送失败时，尝试回退到 Agent

### Q: 回复本地文件时提示“没有权限访问路径”怎么办？

先确认文件路径是否在允许目录里：

- 当前 Agent 工作区文件默认允许，可直接用 `FILE:/workspace/...` 或 `MEDIA:/workspace/...`
- 浏览器生成的文件默认允许
- 宿主机其他目录需要把父目录加入 `channels.wecom.mediaLocalRoots`
- 多账号模式如果只想对某个账号生效，可配置 `channels.wecom.<accountId>.mediaLocalRoots`

例如：

```json
{
  "channels": {
    "wecom": {
      "mediaLocalRoots": ["/tmp/openclaw"]
    }
  }
}
```

修改后重启 Gateway。`v2.2.1+` 已支持把 `mediaLocalRoots` 并入被动回复文件允许目录。

### Q: `60020 not allow to access from your ip` 是什么问题？

企业微信自建应用 API 的可信 IP 限制。把当前服务器出口 IP 加入企业微信应用的可信 IP 白名单即可。

## 项目结构

```text
openclaw-plugin-wecom/
├── index.js                      # 插件入口、生命周期、onboarding
├── dynamic-agent.js              # 动态 Agent 路由判断
├── image-processor.js            # 图片格式检测、MD5、Base64
├── logger.js                     # 结构化日志
├── think-parser.js               # <think> 标签规范化
├── utils.js                      # 工具函数
├── openclaw.plugin.json          # 插件元数据
├── wecom/
│   ├── accounts.js               # 多账号管理与配置继承
│   ├── agent-api.js              # Agent API（Token、发送、上传）
│   ├── allow-from.js             # allowlist 规范化与匹配
│   ├── callback-crypto.js        # 回调 AES 解密与签名验证
│   ├── callback-inbound.js       # 自建应用回调入站处理
│   ├── callback-media.js         # 回调媒体下载
│   ├── channel-plugin.js         # 核心通道（sendNotice / sendMedia）
│   ├── commands.js               # 指令白名单与命令拦截
│   ├── constants.js              # 常量定义
│   ├── dm-policy.js              # 私聊准入策略
│   ├── group-policy.js           # 群聊准入策略
│   ├── http.js                   # HTTP 请求 + 代理
│   ├── onboarding.js             # CLI 交互式配置向导
│   ├── runtime-telemetry.js      # 运行时配额追踪
│   ├── sandbox.js                # 沙箱集成
│   ├── state.js                  # 插件状态管理
│   ├── target.js                 # 目标解析（user / group / party / tag / webhook）
│   ├── webhook-bot.js            # Webhook Bot 发送
│   ├── workspace-template.js     # 工作区模板同步
│   ├── ws-monitor.js             # WS 消息处理、流式回复、节流、重试
│   └── ws-state.js               # WS 状态 + pending reply 队列
└── tests/
    ├── accounts-reserved-keys.test.js
    ├── api-base-url.test.js
    ├── callback-crypto.test.js
    ├── callback-inbound.test.js
    ├── channel-plugin.media-type.test.js
    ├── channel-plugin.notice.test.js
    ├── dynamic-agent.test.js
    ├── image-processor.test.js
    ├── issue-fixes.test.js
    ├── reply-media-directive.test.js
    ├── runtime-telemetry.test.js
    ├── target.test.js
    ├── think-parser.test.js
    ├── workspace-template.test.js
    ├── ws-monitor.quote-mixed.test.js
    └── ws.e2e.test.js
```

## 自定义 Skills 配合沙箱使用实践

OpenClaw 支持自定义 Skills 并通过沙箱（Docker）隔离执行，下面保留一份生产环境常见配置示例：

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "workspaceAccess": "rw",
        "scope": "agent",
        "docker": {
          "image": "your-registry.com/openclaw-agent:v2026.x.x",
          "readOnlyRoot": false,
          "network": "bridge",
          "extraHosts": [
            "your-domain.internal:xxx.xxx.xxx.xxx"
          ],
          "binds": [
            "/path/to/skills:/workspace/skills:ro"
          ],
          "dangerouslyAllowReservedContainerTargets": true,
          "dangerouslyAllowExternalBindSources": true
        },
        "prune": {
          "idleHours": 87600,
          "maxAgeDays": 3650
        }
      }
    }
  },
  "skills": {
    "allowBundled": ["_none_"],
    "load": {
      "extraDirs": ["/path/to/skills"],
      "watch": true,
      "watchDebounceMs": 250
    }
  }
}
```

关键点：

- `sandbox.mode: "all"` 表示所有操作都走沙箱
- `sandbox.workspaceAccess: "rw"` 允许 Agent 读写工作区
- `sandbox.scope: "agent"` 表示每个 Agent 独立沙箱
- `sandbox.docker.binds` 可把宿主机技能目录映射到容器内 `/workspace/skills`
- `skills.load.extraDirs` 用于声明自定义 Skills 加载目录
- `skills.load.watch` 改动 Skill 后自动热加载

## 相关链接

- [OpenClaw](https://github.com/openclaw/openclaw) — 开源 AI Agent 运行时
- [官方 WeCom OpenClaw 插件](https://github.com/WecomTeam/wecom-openclaw-plugin)（[npm](https://www.npmjs.com/package/@wecom/wecom-openclaw-plugin)）
- [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk) — 企业微信智能机器人 Node.js SDK
- [企业微信 AI 机器人官方文档](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657)

## 贡献与协议

- 贡献说明见 `CONTRIBUTING.md`
- 许可证为 `ISC`
