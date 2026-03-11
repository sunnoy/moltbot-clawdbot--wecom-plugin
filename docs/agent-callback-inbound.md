# 自建应用 Agent Callback 作为入站通道方案

> 状态：设计草稿 | 日期：2026-03-11

## 1. 背景与目标

### 现状

本插件目前只有一条入站通道：**AI Bot WebSocket 长连接**（`@wecom/aibot-node-sdk` + `WSClient`）。

```
用户消息 → 企业微信服务器 → wss://openws.work.weixin.qq.com → WSClient → processWsMessage()
```

出站已有三条路（WS 回复、Agent API、Webhook Bot），但入站单点依赖 AI Bot。

### 目标

在保持 WS 路径零变更的前提下，将**自建应用（Agent）HTTP Callback** 作为第二条入站通道接入，出站继续复用已有的 `sendViaAgent()`。

预期效果：

| 场景 | 入站 | 出站 |
|------|------|------|
| 仅配置 AI Bot（`botId`+`secret`） | WS（现有） | WS 回复 / Agent API fallback |
| 仅配置自建应用（`agent.callback.*`） | HTTP Callback（新增） | Agent API |
| 同时配置两者 | WS + HTTP Callback 并联 | 来自 WS → WS 回复；来自 Callback → Agent API |

---

## 2. 企业微信自建应用 Callback 机制

### 2.1 验签与解密

企业微信向配置的 URL 发送请求，分两种：

**GET（URL 验证）**：
```
GET /wecom/callback?msg_signature=...&timestamp=...&nonce=...&echostr=<加密串>
```
响应：解密 `echostr` 后原文返回。

**POST（消息推送）**：
```
POST /wecom/callback?msg_signature=...&timestamp=...&nonce=...
Body: <xml><ToUserName>...</ToUserName><Encrypt>...</Encrypt></xml>
```
解密后得到明文 XML（`MsgType`、`Content`、`MsgId`、`FromUserName` 等）。

### 2.2 加解密算法

- XML 包装层：`msg_signature = SHA1(sort(token, timestamp, nonce, encrypt_msg))`
- AES 解密：`AES-256-CBC`，key = `BASE64(encodingAESKey+"=")`，IV = key 前 16 字节
- 解密后格式：`[random_16B][4B msgLen BigEndian][msgContent][corpId]`

### 2.3 消息类型

| MsgType | 说明 | 对应现有 WS 逻辑 |
|---------|------|----------------|
| `text` | 文本 | `body.text.content` |
| `image` | 图片 | `body.image.url` + 通过 `MediaId → /media/get` 下载 |
| `voice` | 语音（ASR 转文字） | `body.voice.Recognition` |
| `file` | 文件 | `body.file.media_id → /media/get` 下载 |
| `event` / `click` | 菜单/事件 | 忽略（记录日志） |

---

## 3. 配置结构扩展

### 3.1 新增字段

在已有 `agent.corpId/corpSecret/agentId` 之下新增 `agent.callback` 块：

```json
{
  "channels": {
    "wecom": {
      "botId": "...",
      "secret": "...",
      "agent": {
        "corpId": "ww1234567890abcdef",
        "corpSecret": "...",
        "agentId": 1000003,
        "callback": {
          "token": "随机字符串（与企业微信后台配置一致）",
          "encodingAESKey": "43位字符串（与企业微信后台配置一致）",
          "path": "/api/channels/wecom/callback"
        }
      }
    }
  }
}
```

`botId`/`secret` 与 `agent.callback` 可独立配置，互不依赖：
- 只有 `botId`+`secret` → 仅 WS 入站（现有行为）
- 只有 `agent.callback.*` → 仅 HTTP Callback 入站（纯 Agent 模式）
- 两者都配置 → 并联

### 3.2 accounts.js 扩展

在 `buildAccount()` 中新增 `callbackConfig` 字段：

```js
const callbackRaw = isPlainObject(agent.callback) ? agent.callback : {};
const callbackToken = String(callbackRaw.token ?? "").trim();
const callbackAESKey = String(callbackRaw.encodingAESKey ?? "").trim();
const callbackPath = String(callbackRaw.path ?? "").trim() || "/api/channels/wecom/callback";
const callbackConfigured = Boolean(callbackToken && callbackAESKey && agent.corpId);

return {
  // ... 现有字段 ...
  callbackConfigured,
  callbackConfig: callbackConfigured ? {
    token: callbackToken,
    encodingAESKey: callbackAESKey,
    path: callbackPath,
    corpId: String(agent.corpId),
  } : null,
};
```

### 3.3 constants.js 新增常量

```js
export const CALLBACK_INBOUND_MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB
export const CALLBACK_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
export const CALLBACK_MEDIA_MAX_SIZE_MB = 20;
```

---

## 4. 新增模块

### 4.1 `wecom/callback-crypto.js`

**职责**：纯函数，与 Node crypto 交互。无副作用，可单测。

```
verifyCallbackSignature({ token, timestamp, nonce, msgEncrypt }) → boolean
decryptCallbackMessage({ encodingAESKey, encrypted }) → { xml: string, corpId: string }
encryptCallbackMessage({ encodingAESKey, token, timestamp, nonce, replyXml }) → string（非必需，当前不用）
```

实现细节：
- `verifyCallbackSignature`：`SHA1(sort([token, timestamp, nonce, msgEncrypt]).join(""))` 与 `msg_signature` 对比
- `decryptCallbackMessage`：
  1. `key = Buffer.from(encodingAESKey + "=", "base64")` （32 字节）
  2. `iv = key.slice(0, 16)`
  3. `decipher = crypto.createDecipheriv("aes-256-cbc", key, iv)`，`decipher.setAutoPadding(false)`
  4. 解密后 `slice(16)` 剥离随机头，读 4 字节大端长度，截取消息体，剩余部分为 corpId

### 4.2 `wecom/callback-inbound.js`

**职责**：HTTP 请求处理 + 消息解析 + 分发到 `processCallbackMessage()`。

核心导出：

```js
export function createCallbackHandler({ account, config, runtime }) → handler(req, res)
```

handler 处理逻辑：

```
GET  → 解密 echostr，返回明文
POST → 验签 → 解密 → 解析 XML → parseCallbackMessageXml() → processCallbackMessage()
```

`parseCallbackMessageXml(xml)` 返回标准化结构（对齐 `parseMessageContent()` 的输出）：

```js
{
  msgId: "...",
  senderId: "...",   // FromUserName
  agentId: "...",    // AgentID
  chatId: "...",     // 单聊 = senderId；群聊暂不支持（企业微信 callback 无 chatId）
  isGroupChat: false,
  text: "...",
  mediaId: "...",    // image/voice/file 的 MediaId
  mediaType: "image" | "file" | null,
  voiceRecognition: "...",  // voice 消息 ASR 文字
}
```

媒体下载：不在 handler 内下载，而是传递 `mediaId` 给 `processCallbackMessage()`，由其按需下载（与 `downloadAndSaveMedia()` 保持一致的目录和 TTL 策略）。

### 4.3 `wecom/callback-media.js`

**职责**：通过 Agent API 下载企业微信媒体文件。

```js
export async function downloadCallbackMedia({ agent, mediaId, type, runtime, config })
  → { path: string, contentType: string }
```

内部调用：
```
GET https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=<token>&media_id=<mediaId>
```
`getAccessToken()` 已在 `agent-api.js` 中实现，直接复用。

---

## 5. 核心处理流程复用

### 5.1 重构 `processWsMessage()` → 参数化 `replyFn`

**当前**：`processWsMessage()` 内部硬编码调用 `sendWsReply()`。

**目标**：将回复函数作为参数注入，使 WS 和 Callback 两条路共享同一处理核心。

```js
// 拆分出新的核心函数（ws-monitor.js 内部使用，不导出）
async function processInboundMessage({
  parsedContent,   // { text, mediaList, senderId, chatId, isGroupChat, messageId, reqId }
  account,
  config,
  runtime,
  replyFn,         // async ({ text, finish, streamId }) => void
}) { ... }
```

`processWsMessage()` 保持现有签名不变，内部调用 `processInboundMessage()` 并传入：
```js
replyFn: ({ text, finish, streamId }) =>
  sendWsReply({ wsClient, frame, text, finish, streamId, accountId: account.accountId })
```

`processCallbackMessage()` 传入：
```js
replyFn: ({ text }) =>
  agentSendText({ agent, toUser: senderId, text })
```

Callback 的 `replyFn` 不需要 `finish`/`streamId`（Agent API 调用本身是原子的，直接分块发送即可）。

### 5.2 流式处理降级

WS 路径支持流式推送（`sendWsReply` 多次、`finish: false/true`）。

Callback 路径无法流式，`replyFn` 在 `finish: true` 时才实际发送，`finish: false` 时只累积状态（类似现有的 `enqueuePendingReply` 机制）。

在 `processInboundMessage()` 内部通过 `replyFn.supportsStreaming` 标志位区分：

```js
replyFn.supportsStreaming = true;   // WS 路径
replyFn.supportsStreaming = false;  // Callback 路径（仅 finish=true 时发送）
```

---

## 6. 注册生命周期

### 6.1 `index.js` 中注册 HTTP 路由

```js
register(api) {
  setRuntime(api.runtime);
  setOpenclawConfig(api.config);
  api.registerChannel({ plugin: wecomChannelPlugin });

  // 新增：注册 callback 路由（多账户支持）
  const callbackRouteCleanups = new Map();
  const registerCallbackRoutes = (cfg) => {
    for (const [accountId, cleanup] of callbackRouteCleanups) {
      cleanup();
      callbackRouteCleanups.delete(accountId);
    }
    for (const accountId of listAccountIds(cfg)) {
      const account = resolveAccount(cfg, accountId);
      if (!account?.callbackConfig) continue;
      const cleanup = api.registerHttpRoute({
        path: account.callbackConfig.path,
        auth: "plugin",
        match: "prefix",
        handler: createCallbackHandler({ account, config: cfg, runtime: api.runtime }),
      });
      callbackRouteCleanups.set(accountId, cleanup);
    }
  };

  registerCallbackRoutes(api.config);

  api.on("config_reloaded", (_event, { config }) => {
    setOpenclawConfig(config);
    registerCallbackRoutes(config);
  });

  // ... 现有 before_prompt_build 钩子 ...
}
```

注意：`api.registerHttpRoute` 返回 cleanup 函数（见 `http-registry.js`），在配置热重载时需要先反注册旧路由再注册新路由，防止路径冲突。

### 6.2 `gateway.startAccount` 无需修改

Callback 入站完全由 HTTP 框架驱动，无需在 `startAccount` 中启动额外任务。

只需在 `startAccount` 检查：

```js
if (!account.configured && !account.callbackConfig) {
  throw new Error(`Account ${account.accountId}: neither WS bot nor callback is configured`);
}
```

---

## 7. 安全性

### 7.1 验签

每次 POST 必须通过 `verifyCallbackSignature()`，验签失败返回 `403`：

```js
if (!verifyCallbackSignature({ token, timestamp, nonce, msgEncrypt })) {
  res.writeHead(403);
  res.end("forbidden");
  return true;
}
```

### 7.2 Replay 防重放

企业微信自带 `timestamp`，建议拒绝 `|now - timestamp| > 300s` 的请求（5 分钟窗口），防重放。

### 7.3 Body 限制

使用 `CALLBACK_INBOUND_MAX_BODY_BYTES`（1 MB）限制 POST body，防止超大请求耗尽内存。

### 7.4 路由鉴权（`auth: "plugin"`）

选择 `auth: "plugin"` 而非 `"gateway"`，因为企业微信服务器是外部调用方，无法携带 gateway token。安全性由企业微信的验签机制（`msg_signature`）保证，而不是 gateway 层认证。

### 7.5 CorpId 校验

解密后从 AES 消息体尾部提取 `corpId`，与 `account.agentCredentials.corpId` 对比，不一致则拒绝：

```js
if (corpId !== account.agentCredentials.corpId) {
  logger.warn(`[Callback:${account.accountId}] corpId mismatch`);
  return;
}
```

---

## 8. 出站回复路由

Callback 入站后，出站走 **Agent API**（`agentSendText` / `agentSendMedia`），已有实现。

对比表：

| | WS 入站出站 | Callback 入站出站 |
|--|--|--|
| 文本 | `sendWsReply(frame, ...)` | `agentSendText({ toUser: senderId })` |
| 图片 | 无法直接，Agent API fallback | `agentSendMedia({ type: "image" })` |
| 文件 | 无法直接，Agent API fallback | `agentSendMedia({ type: "file" })` |
| 流式 | 支持（多次 `sendWsReply`） | **不支持**（Agent API 为原子调用） |
| 回复窗口限制 | 有（24h 回复窗口） | 无（可主动发，但受日配额限制） |

---

## 9. sessionKey 与会话一致性

`buildInboundContext()` 中 `sessionKey` 由 `core.routing.resolveAgentRoute()` 计算，参数是 `{ channel, accountId, peer: { kind, id } }`。

Callback 入站的 `peer.id = senderId`（企业 userId），与 WS 入站相同。因此：

- **同一用户先后通过 WS 和 Callback 发消息，会话自动共享**（sessionKey 相同）。
- 无需额外处理会话合并。

---

## 10. deduplication

现有 `inboundMessageDeduplicator` 使用 `accountId:messageId` 作为 key。

企业微信对同一条消息分配唯一的 `MsgId`（WS 侧）/ `MsgId`（Callback 侧），两侧命名空间一致，理论上不会重复。极端情况下（网络重试）deduplicator 会挡掉重复投递。

---

## 11. 多账户支持

每个账户可独立配置 `agent.callback.path`，不同账户使用不同路径：

```json
{
  "channels": {
    "wecom": {
      "acme": {
        "agent": { "callback": { "path": "/api/channels/wecom/callback/acme" } }
      },
      "demo": {
        "agent": { "callback": { "path": "/api/channels/wecom/callback/demo" } }
      }
    }
  }
}
```

`createCallbackHandler()` 工厂函数按账户实例化，各自持有独立的解密 key 和 token。

---

## 12. 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `wecom/constants.js` | 修改 | 新增 `CALLBACK_*` 常量 |
| `wecom/accounts.js` | 修改 | `buildAccount()` 中解析 `agent.callback`，输出 `callbackConfig` / `callbackConfigured` |
| `wecom/callback-crypto.js` | **新增** | `verifyCallbackSignature()` + `decryptCallbackMessage()` |
| `wecom/callback-media.js` | **新增** | `downloadCallbackMedia()`，通过 Agent API 下载媒体 |
| `wecom/callback-inbound.js` | **新增** | `createCallbackHandler()` + `parseCallbackMessageXml()` + `processCallbackMessage()` |
| `wecom/ws-monitor.js` | 修改 | 将 `processWsMessage()` 内核拆分为 `processInboundMessage()`，注入 `replyFn` |
| `wecom/channel-plugin.js` | 修改 | `configSchema` 新增 `agent.callback.*` 字段的 `uiHints`；`isConfigured` 放宽检查 |
| `index.js` | 修改 | `register()` 中调用 `api.registerHttpRoute()` 注册 callback |
| `tests/callback-crypto.test.js` | **新增** | 单测 AES 解密和验签（使用企业微信文档的测试向量） |
| `tests/callback-inbound.test.js` | **新增** | 单测 HTTP handler，mock `api.registerHttpRoute` |

---

## 13. 实施顺序

```
第一步：callback-crypto.js（纯函数，可先写单测）
   ↓
第二步：callback-media.js（复用 getAccessToken，独立可测）
   ↓
第三步：accounts.js 扩展 callbackConfig（改动最小，影响全局配置解析）
   ↓
第四步：ws-monitor.js 拆分 processInboundMessage（有现有测试保护）
   ↓
第五步：callback-inbound.js（依赖前四步）
   ↓
第六步：index.js 注册路由 + channel-plugin.js 配置 schema 扩展
   ↓
第七步：集成测试（E2E：发 HTTP POST → 验证 Agent API 出站）
```

---

## 14. 已知限制与后续工作

| 限制 | 说明 |
|------|------|
| 自建应用 callback 不支持群聊消息（企业微信限制） | 群消息不含 `ChatId`；可通过消息内容中的 `@机器人` 触发但无法区分群，暂不支持 |
| 无流式推送 | Callback 出站为原子调用，用户在 WeCom 看不到打字效果；可通过先发 thinking 消息再发最终结果缓解 |
| callback 路径冲突 | 多 wecom 账户的 path 必须唯一，否则 `registerPluginHttpRoute` 会阻止重复注册 |
| 企业微信服务端 IP 白名单 | 建议在网关前置 nginx/caddy 限制来源 IP（企业微信公开了回调 IP 段） |
