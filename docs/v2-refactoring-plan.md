# v2.0 目标设计：官方 WS 骨架 + 本项目增强

> 本文描述 v2 主线的目标设计，不再讨论任何 HTTP callback 过渡态。
> 方向：以官方插件 (`@wecom/wecom-openclaw-plugin`) 的 WebSocket 架构为骨架，
> 叠加本项目已有的多账号、动态 Agent、workspace 模板、ACL、Webhook Bot、Agent API 等增强能力，发布大版本 `2.0.0`。

---

## 零、设计校准（基于官方实码）

在进入实施前，先明确几个已经验证过的边界，避免方案继续建立在错误前提上：

1. **迁移的是架构，不是直接复用官方内部模块**  
   官方 npm 包实际对外只暴露 bundle 和类型声明，不能把 `dist/src/*.d.ts` 当作可直接 import 的运行时代码来依赖。  
   结论：v2 需要吸收官方的模块拆分和流程设计，而不是深度依赖官方包内部文件。

2. **官方实现是单账号，社区版必须继续保留多账号**  
   官方 `listAccountIds()` 只返回默认账号；本项目的增强定位要求继续支持多账号和账号级动态 Agent 隔离。

3. **官方主动发送能力只覆盖文本/Markdown，不覆盖真正的媒体主动发送**  
   官方主动发送主路径是 `wsClient.sendMessage(chatId, { msgtype: "markdown" })`；`sendMedia` 目前只是文本占位，不具备本项目已有的文件/图片后备能力。  
   结论：Webhook Bot 和 Agent API 仍然是本项目的差异化能力，不能被官方实现替代。

4. **官方 reqId 持久化不属于当前插件的必要能力**  
   官方实现会把 `chatId -> reqId` 落盘，但主动发送仍然直接依赖活跃 `WSClient.sendMessage`，并不先查 reqId。  
   结论：当前插件不保留这层持久化状态，避免引入未被消费的补丁式冗余状态文件。

---

## 一、架构对比

| 维度 | 官方插件 v1.0.5 | 社区插件 v1.9.1 | v2.0 目标 |
|------|-----------------|-----------------|-----------|
| 连接模式 | WebSocket only | HTTP 回调 + Agent API + WebSocket(WIP) | **WebSocket only** |
| SDK | `@wecom/aibot-node-sdk` WSClient | 自建 XML 解析 + AES 解密 | `@wecom/aibot-node-sdk` |
| Plugin SDK 接口 | pairing / security / messaging / onboarding / directory | 仅 config / gateway / outbound | **全量实现** |
| 多账号 | 单账号 (`DEFAULT_ACCOUNT_ID`) | 多账号字典模式 | **多账号** |
| 动态 Agent | ❌ | ✅ 按用户/群隔离 | ✅ |
| 命令白名单 | ❌ | ✅ allowlist + admin bypass | ✅ |
| Workspace 模板 | ❌ | ✅ bootstrap 文件同步 | ✅ |
| Webhook Bot | ❌ | ✅ 群通知推送 | ✅ |
| Agent API 出站 | ❌ | ✅ 自建应用发消息/文件 | ✅ (出站后备) |
| 主动文本发送 | ✅ `sendMessage(markdown)` | ✅ Agent/Webhook/HTTP 补丁混合 | **✅ `sendMessage` 为主路径** |
| 主动媒体发送 | ⚠️ `sendMedia` 仅文本占位 | ✅ 图片/文件多通道发送 | **✅ 保留 Webhook/Agent 媒体能力** |
| dmPolicy / groupPolicy | ✅ pairing / open / disabled | ❌ | ✅ |
| 入群欢迎 | ❌ | ✅ enter_chat 事件 | ✅ |
| ReqId 持久化 | ✅ 内存+磁盘双层 | ✅ 内存 only | ✅ 内存+磁盘（非主动发送前置） |
| 代理支持 | ❌ | ✅ egressProxyUrl | ✅ |
| 配置助手 (onboarding) | ✅ CLI wizard | ❌ | ✅ |

---

## 二、文件处置分类

### 2.1 删除（HTTP 回调专用，v2 不再需要）

| 文件 | 用途 | 删除原因 |
|------|------|----------|
| `crypto.js` | AES-256-CBC 解密 XML callback 消息体 | WS 模式由 SDK 处理加解密 |
| `webhook.js` | WecomWebhook 类，HTTP JSON 响应构建 | WS 模式无 HTTP 回调 |
| `stream-manager.js` | HTTP 轮询流生命周期 (create/update/append/finish) | WS 用 replyStream 替代 |
| `wecom/http-handler.js` | HTTP 请求分发、消息防抖、轮询刷新 | WS 模式无 HTTP handler |
| `wecom/http-handler-state.js` | handler 注册追踪 | 依赖 http-handler |
| `wecom/response-url.js` | response_url 解析与回退 | WS 模式无 response_url |
| `wecom/agent-inbound.js` | Agent 模式 XML 回调处理 | WS 模式替代 Agent 入站 |
| `wecom/xml-parser.js` | XML 解析 (WeCom 回调专用) | WS 消息已是 JSON |
| `wecom/stream-utils.js` | 流注册/恢复映射 | 依赖 stream-manager |
| `wecom/webhook-targets.js` | Webhook 路径→账号路由 | WS 模式无 HTTP 路由 |

### 2.2 保留（共享/通用模块，无需改动或微调）

| 文件 | 用途 | 备注 |
|------|------|------|
| `logger.js` | 日志封装 | 不变 |
| `utils.js` | TTLCache、MessageDeduplicator、splitTextByByteLimit | 不变 |
| `think-parser.js` | `<think>` 标签解析 | 不变 |
| `dynamic-agent.js` | 动态 Agent 路由逻辑 | 不变 |
| `image-processor.js` | 图片合并处理 | 不变 |
| `wecom/commands.js` | 命令白名单、admin bypass | 不变 |
| `wecom/allow-from.js` | allowFrom 权限解析 | 不变 |
| `wecom/target.js` | resolveWecomTarget (wecom:xxx 解析) | 不变 |
| `wecom/workspace-template.js` | 动态 Agent workspace 模板同步 | 不变 |
| `wecom/accounts.js` | 多账号解析 (字典模式) | 小改：移除 HTTP 字段，统一到 `botId/secret/websocketUrl` 账号形态 |

### 2.3 保留但需小幅调整

| 文件 | 用途 | 调整内容 |
|------|------|----------|
| `wecom/webhook-bot.js` | Webhook Bot 群通知 (独立于连接模式) | 不变，出站时调用 |
| `wecom/agent-api.js` | Agent API 出站 (token 管理, send/upload) | 不变，作为出站后备通道 |
| `wecom/http.js` | wecomFetch + 代理支持 | 不变，媒体下载/API 调用仍需要 |
| `wecom/media.js` | 旧媒体下载/解密助手 | 仅保留可复用的 MIME/文件名辅助；依赖 HTTP callback/Agent 入站的解密逻辑移除 |
| `wecom/constants.js` | 常量定义 | 清理 HTTP 专用常量 (DEBOUNCE_MS 等) |

### 2.4 重写

| 文件 | 当前职责 | v2 新职责 |
|------|----------|-----------|
| `index.js` | 注册 channel + HTTP route + 清理定时器 | 注册 channel only，移除 HTTP route |
| `wecom/state.js` | 全局状态 (含 HTTP 流 maps) | 精简：仅保留 runtime/config/streamContext/dispatchLocks |
| `wecom/channel-plugin.js` | 860行，HTTP 流式出站 + webhook 网关 | **全量重写**：合并官方 Plugin SDK 接口 + WS 出站 |
| `wecom/outbound-delivery.js` | 3层出站回退 (stream→response_url→agent) | 删除；若需要抽公共能力，新建纯 WS 语义的 `ws-outbound.js` |
| `wecom/inbound-processor.js` | HTTP 回调消息处理 + 防抖 | 移除（逻辑迁入 ws-monitor） |
| `wecom/ws-state.js` | WS 实例管理 + 内存 message state | **精简**：仅保留 WS 实例与消息处理态，不再维护未消费的 reqId 持久化 |
| `wecom/ws-monitor.js` | WS 消息处理 (初版) | **重写**：对齐官方 7 步 pipeline + 加入 dmPolicy/groupPolicy 检查 |

---

## 三、新增功能（从官方合并）

### 3.0 迁移边界

- 吸收官方的模块边界：`channel` / `monitor` / `message-sender` / `state-manager` / `dm-policy` / `group-policy`
- 不照搬官方的单账号假设
- 不照搬官方当前较弱的 `sendMedia`
- 不再推进任何 `HTTP callback -> SDK route` 的中间态方案，主线直接切到 WS-only

### 3.1 Plugin SDK 接口补全

```
wecomPlugin = {
  id, meta, capabilities, reload,

  // ── 新增（从官方合并） ──
  pairing: {
    idLabel: "wecomUserId",
    normalizeAllowEntry(entry),
    notifyApproval({ cfg, id }),
  },

  security: {
    resolveDmPolicy({ account }),      // → policy + allowFrom + paths
    collectWarnings({ account, cfg }),  // dmPolicy="open" / groupPolicy 警告
  },

  messaging: {
    normalizeTarget(target),
    targetResolver: {
      looksLikeId(id),
      hint: "<userId|groupId>",
    },
  },

  onboarding: wecomOnboardingAdapter,  // CLI 向导：botId + secret + dmPolicy

  // ── 已有（保留/增强） ──
  config: { ... },          // 多账号（字典模式增强：加 isConfigured / describeAccount / resolveAllowFrom）
  directory: { ... },
  outbound: { ... },        // WS 出站（重写）
  gateway: { ... },         // WS startAccount（重写）
  status: { ... },          // 从官方合并 collectStatusIssues / buildChannelSummary 等
}
```

### 3.2 dmPolicy & groupPolicy

官方管控逻辑，在消息处理 pipeline 中增加策略检查：

- **dmPolicy**:
  - `pairing`（默认）：未配对用户收到配对提示，消息不转发
  - `open`：所有用户均可直接对话
  - `disabled`：禁用私聊

- **groupPolicy**:
  - `open`（默认）：所有群组均可触发
  - `disabled`：禁用群聊
  - `allowlist`：仅 `groupAllowFrom` 列表中的群组可触发

### 3.3 Onboarding Adapter

CLI 设置向导，引导用户配置：
1. Bot ID
2. Secret
3. dmPolicy（可选）

### 3.4 ReqId 持久化 (磁盘+内存双层)

参照官方实现：
- 内存层：Map + TTL (7天) + LRU 淘汰 (200条)
- 磁盘层：`readJsonFileWithFallback` / `withFileLock` / `writeJsonFileAtomically`
- 防抖落盘 (1000ms debounce)
- 启动时从磁盘预热到内存
- 仅作为恢复和状态增强，不参与主动消息主链路的可用性判断

### 3.5 Status 接口

```js
status: {
  defaultRuntime,
  collectStatusIssues(accounts),
  buildChannelSummary({ snapshot }),
  probeAccount(),
  buildAccountSnapshot({ account, runtime }),
}
```

---

## 四、社区增强特性保留清单

| 特性 | 实现文件 | v2 集成点 |
|------|----------|-----------|
| 动态 Agent 路由 | `dynamic-agent.js` | ws-monitor → processWsMessage 中使用 |
| 命令白名单 | `wecom/commands.js` | ws-monitor → 命令检查阶段 |
| Admin 绕过白名单 | `wecom/commands.js` | ws-monitor → isWecomAdmin |
| AllowFrom 权限 | `wecom/allow-from.js` | ws-monitor → commandAuthorized |
| Workspace 模板同步 | `wecom/workspace-template.js` | ws-monitor → ensureDynamicAgentListed |
| Webhook Bot 群通知 | `wecom/webhook-bot.js` | outbound → sendText/sendMedia webhook 通道 |
| Agent API 出站 | `wecom/agent-api.js` | outbound → sendText/sendMedia agent 后备 |
| 多账号 (字典模式) | `wecom/accounts.js` | config.listAccountIds / resolveAccount |
| 代理支持 | `wecom/http.js` | wecomFetch 全局代理 |
| 图片合并 | `image-processor.js` | 媒体处理 pipeline |
| 入群欢迎 | `wecom/ws-monitor.js` | event.enter_chat 处理 |
| Think 标签解析 | `think-parser.js` | 出站文本后处理 |

---

## 五、Config Schema 变更

### 旧（v1.x）
```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "token": "xxx",              // ← HTTP 回调 token
      "encodingAesKey": "xxx",     // ← HTTP 回调 AES key
      "agent": {                   // ← Agent 模式
        "corpId": "xxx",
        "corpSecret": "xxx",
        "agentId": 1000001,
        "token": "xxx",
        "encodingAesKey": "xxx"
      }
    }
  }
}
```

### 新（v2.0，单账号）
```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "botId": "xxx",              // ← WS 机器人 ID（必填）
      "secret": "xxx",            // ← WS 机器人密钥（必填）
      "websocketUrl": "wss://...", // ← 可选，有默认值
      "name": "企业微信",
      "sendThinkingMessage": true,

      "dmPolicy": "pairing",      // ← 新增：私聊策略
      "allowFrom": ["user1"],     // ← 新增 (官方)
      "groupPolicy": "open",      // ← 新增：群聊策略
      "groupAllowFrom": [],       // ← 新增：群聊白名单

      "commands": { ... },         // ← 保留：命令白名单
      "dynamicAgents": { ... },    // ← 保留：动态 Agent
      "adminUsers": [],            // ← 保留：管理员
      "workspaceTemplate": "...",  // ← 保留：workspace 模板

      "agent": {                   // ← 保留：Agent API（仅出站后备）
        "corpId": "xxx",
        "corpSecret": "xxx",
        "agentId": 1000001
      },

      "webhooks": { ... },         // ← 保留：Webhook Bot
      "network": { ... }           // ← 保留：代理/API base
    }
  }
}
```

### 新（v2.0，多账号字典模式）
```json
{
  "channels": {
    "wecom": {
      "default": {
        "enabled": true,
        "botId": "default-bot-id",
        "secret": "default-secret"
      },
      "sales": {
        "enabled": true,
        "botId": "sales-bot-id",
        "secret": "sales-secret",
        "workspaceTemplate": "/data/wecom-sales-template"
      }
    }
  }
}
```

**关键变更**：
- `token` + `encodingAesKey` → `botId` + `secret`（连接模式切换）
- `agent.token` + `agent.encodingAesKey` 删除（不再有 Agent 入站回调）
- `agent.corpId/corpSecret/agentId` 保留（出站 API 后备）
- 新增 `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`
- 新增 `websocketUrl`, `name`, `sendThinkingMessage`
- `instances` 不再作为 v2 主配置形态；多账号采用字典式账号块，单账号配置作为兼容迁移入口

---

## 六、消息处理 Pipeline（v2）

```
WSClient.on("message", frame)
    │
    ├─ 1. parseMessageContent(frame.body)
    │     → textParts, imageUrls, fileUrls, quoteContent
    │
    ├─ 2. checkGroupPolicy(chatType, chatId, config)          ← 新增
    │     → groupPolicy=disabled → 忽略
    │     → groupPolicy=allowlist → 不在 groupAllowFrom → 忽略
    │     → groupPolicy=open → 继续
    │
    ├─ 3. checkDmPolicy(chatType, senderId, config)           ← 新增
    │     → dmPolicy=disabled → 忽略
    │     → dmPolicy=pairing → 检查配对状态，未配对 → 提示
    │     → dmPolicy=open → 继续
    │
    ├─ 4. Group mention gating                                 ← 保留
    │     → shouldTriggerGroupResponse → extractGroupMessageContent
    │
    ├─ 5. Command allowlist enforcement                        ← 保留
    │     → checkCommandAllowlist + isWecomAdmin
    │
    ├─ 6. downloadAndSaveMedia(wsClient, urls, aesKeys)
    │     → SDK downloadFile → core.media.saveMediaBuffer
    │
    ├─ 7. Dynamic agent routing                                ← 保留
    │     → getDynamicAgentConfig → generateAgentId
    │     → ensureDynamicAgentListed (workspace template)
    │
    ├─ 8. init message state
    │
    ├─ 9. sendThinkingReply (可选)
    │
    └─ 10. routeAndDispatchMessage
          → core.routing.resolveAgentRoute
          → core.reply.dispatchReplyWithBufferedBlockDispatcher
          → deliver callback: replyStream(frame, streamId, accumulated, finish)
```

---

## 七、消息投递逻辑（v2）

```
A. 被动回复链路（仅存在于 ws-monitor 内部）
   frame -> dispatchReplyWithBufferedBlockDispatcher -> deliver callback
        -> replyStream(frame, streamId, accumulated, finish)

B. 主动文本链路（channel outbound）
   direct/group chatId
        -> wsClient.sendMessage(chatId, { msgtype: "markdown", markdown })

C. 主动媒体/特殊目标链路（channel outbound）
   webhook:name
        -> Webhook Bot

   unsupported media type / explicit app target / 需要文件私发
        -> Agent API
```

明确移除的 HTTP 时代补丁：

- `response_url` 补投
- `activeStreams` / `recoverableStream` 恢复
- `messageBuffers` 防抖合并
- `streamMeta` idle-close
- 基于 stream miss 的多层兜底判定

v2 中的原则是：

1. 被动回复只在拥有原始 WS `frame` 时走 `replyStream`
2. 主动发送直接走 `sendMessage`
3. Webhook Bot / Agent API 是能力型通道，不再是为了弥补 HTTP callback 限制而存在的补丁层

---

## 八、实施落地顺序

### Phase 1: 切换运行主链路
1. `gateway.startAccount` 改为直接启动 `ws-monitor`
2. `index.js` 移除 HTTP route 注册
3. `package.json` 增加 `@wecom/aibot-node-sdk`
4. `accounts.js` 收敛到 WS 账号形态，并明确多账号字典模式

### Phase 2: 清理 HTTP 遗留状态
5. 删除 HTTP callback 相关文件
6. 精简 `state.js`：移除 `responseUrls` / `messageBuffers` / `activeStreams` / `streamMeta`
7. 精简 `constants.js`：移除 HTTP 专用常量
8. 删除 `outbound-delivery.js`、`stream-manager.js` 及其依赖链

### Phase 3: 核心重写
9. 重写 `channel-plugin.js`：合并官方 Plugin SDK 接口
10. 重写 `ws-monitor.js`：以官方 7 步 pipeline 为骨架，挂入社区增强
11. 重写 outbound：区分被动 `replyStream` 和主动 `sendMessage`

### Phase 4: 功能补全
13. 实现 onboarding adapter (CLI wizard)
14. 实现 dmPolicy / groupPolicy / pairing 接口
15. 实现 status / security / messaging 接口
16. 对齐 `openclaw.plugin.json`

### Phase 5: 收尾
17. 更新测试
18. 更新 README 和 CHANGELOG
19. 补迁移说明（v1 HTTP -> v2 WS）

---

## 九、依赖变更

### 新增
- `@wecom/aibot-node-sdk`: `^1.0.1` (peerDependencies 或 dependencies)

### 移除
- 无需额外移除 (xml/crypto 为 Node built-in)

### 保留
- `undici`: optionalDependencies (proxy 支持)
- `openclaw`: peerDependencies

---

## 十、package.json files 字段更新

### 移除
```
- "crypto.js"
- "webhook.js"
- "stream-manager.js"
```

### 新增
无（ws-state.js / ws-monitor.js 已在 wecom/ 目录中，包含于 `"wecom"` 通配）

---

## 十一、Breaking Changes 总结

1. **连接模式**：HTTP 回调 → WebSocket（需重新配置 botId + secret）
2. **配置字段**：`token` + `encodingAesKey` → `botId` + `secret`
3. **Agent 入站回调**：移除（不再支持 Agent 模式入站）
4. **HTTP 路由**：不再注册 `/webhooks` 路由
5. **stream-manager**：移除（WS replyStream 替代）
6. **多账号配置说明**：`instances` 不再作为主形态，改用字典式账号块
7. **最低要求**：需安装 `@wecom/aibot-node-sdk`
