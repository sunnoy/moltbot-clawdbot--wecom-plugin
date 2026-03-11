# Changelog

## 2.0.2 (2026-03-11)

### Fixes

- **群聊正文中的 `@` 标识误删**: 移除 WeCom 群消息进入 Agent 前对所有 `@...` token 的二次清洗，避免将 `callerUri="...@H323"`、`calleeUri="...@CONFNO"` 这类正文内容误判为 mention 并截断

### Tests

- 新增群聊回归测试，覆盖 `@H323` / `@CONFNO` 在入站上下文中的保留行为
- 新增 `extractGroupMessageContent()` 单测，验证 mention 去除与正文 `@` token 保留可同时成立

## 2.0.1 (2026-03-10)

### Fixes

- **动态 Agent 配置持久化**: `ensureDynamicAgentListed` 改为直接写入已变更的内存配置（与 `logoutAccount` 一致），修复因 `loadConfig()` 在 gateway 运行时返回相同内存快照导致写入被跳过的问题，新动态 Agent 现在会正确持久化到磁盘配置文件
- **Main Agent 心跳丢失**: 初始化 `agents.list` 时为 main 条目添加 `heartbeat: {}`，防止动态 Agent 注册后 main 的心跳调度被意外排除（`hasExplicitHeartbeatAgents` 逻辑）

### Notes

- **SDK 100 条队列限制**: 企微 `@wecom/aibot-node-sdk` 对每个 `reqId` 的回复队列上限为 100 条（`maxReplyQueueSize=100`），超出后直接 reject。官方插件未做任何节流处理，完全依赖 core 的 buffered dispatcher 自然控制频率。本插件因额外支持 reasoning stream，中间消息量更大，保留了 `MAX_INTERMEDIATE_STREAM_MESSAGES=85` 上限 + 800ms 时间节流双重防护

## 1.9.0 (2026-03-06)

### Features

- **Bindings 路由**: 支持通过 OpenClaw `bindings` 配置将不同 WeCom 账户绑定到不同 Agent，显式 binding 优先于动态 Agent 路由 (#85)
- **deliveryMode: "direct"**: 对齐上游标准，声明直接投递模式
- **emptyPluginConfigSchema()**: plugin-level configSchema 改用上游推荐的 safeParse 格式

### Fixes

- **Agent API 长文本截断**: 新增 `splitTextByByteLimit()` 按 WeCom 2048 字节限制自动分段，优先在换行处断开 (#84)
- **XML body 误发检测**: Bot webhook 收到 XML 请求时返回 400 并提示使用 Agent 回调地址 (#83)
- **消除顶层副作用**: `setInterval` 从模块顶层移入 `register()` 函数

### Chore

- 删除 e2e 测试资源（远程测试通过后清理）
- 更新 README：新增 Bindings 路由文档，更新项目结构

## 1.7.1 (2026-03-05)

### Fixes

- **Fix message truncation during tool calls (#73)**: Move `mainResponseDone` flag from deliver callback to after `dispatchDone`, preventing the 30s idle timeout from closing the stream while LLM is still executing tools

## 1.7.0 (2026-03-05)

### Features

- **Thinking mode support**: Parse `<think>` / `<thinking>` / `<thought>` tags from LLM output and display reasoning in WeCom's collapsible `thinking_content` field
- **Passive reply thinking UI**: First sync response shows thinking mode UI immediately via `thinking_content` field
- **Markdown fallback**: response_url fallback now sends `msgtype: "markdown"` instead of `text` for richer formatting

### Fixes

- **Stream routing**: Fix concurrent message race by checking `ctxStream.finished` before reusing async-context stream; fall back to latest recoverable stream
- **Agent inbound whitelist**: Filter non-message event types (subscribe/unsubscribe etc.) to prevent them from triggering LLM replies
- **MEDIA regex**: Match only line-start `^MEDIA:` directives to align with upstream OpenClaw behavior
- **Grace timer**: Reduce post-dispatch grace timer from 3000ms to 200ms for faster stream finalization
- **Remove auto-detect /workspace/ paths**: Remove overly aggressive workspace path auto-detection in outbound delivery; rely on upstream MEDIA directives and payload.mediaUrls instead

### Docs

- Add table of contents navigation to README
- Add streaming capabilities documentation (Markdown, thinking mode, images)
- Add `think-parser.js` to project structure

## 1.6.2

- fix: guard /workspace path traversal in outbound delivery

## 1.6.1

- fix: admin bypass option and wecom routing fixes

## 1.6.0

- fix: adapt to OpenClaw 3.2 registerHttpRoute API

## 1.5.1

- fix: wecom compatibility and agent media delivery

## 1.5.0

- feat: 媒体类型自动识别 & 流恢复增强

## 1.4.1

- fix: 智能解密媒体文件，防止 Bot 模式文件损坏

## 1.4.0

- feat: 多账号支持（Multi-Bot）
