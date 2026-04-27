# Changelog

## 3.2.0 (2026-04-27)

相对 [v3.1.0](https://github.com/sunnoy/openclaw-plugin-wecom/releases/tag/v3.1.0) 的变更摘要。

### Features

- **Workspace 模板额外文件**: 新增 `channels.wecom.workspaceTemplateExtraFiles`，支持在默认引导文件之外复制相对路径脚本/配置目录，并跳过 `.git`、`node_modules`、`.env*` 和路径穿越项
- **文件+文本入站聚合**: WS 入站对纯附件消息增加短窗口等待，可与同一用户紧邻文本合并为一次处理；`mixed` 消息同步支持提取文件附件

### Fixes

- **入站文件下载失败显式回复**: 加密附件下载失败时不再 fallback 到普通 HTTP 读取，也不再把空/乱码上下文交给模型猜测；会重试后直接提示用户重发附件
- **等待模型响应不再堆叠**: 思考占位只刷新当前秒数，避免 `等待模型响应 1s/2s/...` 在企微卡片中持续堆叠
- **思考流诊断增强**: `sendThinkingMessage=true` 但未收到 OpenClaw reasoning stream 时记录 session `reasoningLevel`，便于排查是否被显式设为 `off`

## 3.1.0 (2026-04-27)

相对 [v3.0.1](https://github.com/sunnoy/openclaw-plugin-wecom/releases/tag/v3.0.1) 的变更摘要。

### Features

- **官方 WeCom MCP 2026.4.23 对齐**: `wecom_mcp` 协商版本升级到官方 `2026.4.23`，SDK 升级到 `@wecom/aibot-node-sdk@1.0.6`
- **MCP 上下文透传**: 工具工厂透传可信 `requesterUserId`、`agentAccountId`、原始大小写 `chatId/chatType`，文档授权错误时可通过 `aibot_send_biz_msg` 发送授权卡片
- **MCP 拦截器增强**: 支持 SmartPage `page_filepath` 读取、SmartPage 导出内容落本地文件、`get_msg_media` base64 媒体落本地文件、业务错误码触发缓存清理
- **MCP 多账号 fallback**: 默认账号非长连接机器人时，自动选择第一个配置了 `botId/secret` 的账号获取 MCP 配置
- **doc-only skills 部署收敛**: 移除当前企业未开通的 contact/todo/meeting/schedule/msg/send-media skills，保留 doc、smart sheet 和 preflight 相关 skills
- **ali-ai 安装脚本**: 新增 `scripts/install-plugin.sh`，同步插件代码与共享 skills、远端执行 `npm ci --omit=dev`、保持 `root:root` ownership 并重启校验 gateway

### Docs

- README 增加企业微信 MCP 文档与智能表格说明，明确 `forbidden for current apikey` 属于企业微信后端权限拒绝，需要企业微信侧授权
- 更新 MCP 远程探测脚本默认版本与远端插件路径，避免继续使用旧 `plugin_version=1.0.12`

### Tests

- 扩展 `tests/mcp-tool.test.js`，覆盖官方协商版本、请求人 header、文档授权卡片、SmartPage 文件读取/导出、本地 session chat 信息容量控制、多账号 MCP fallback
- 本地全量测试通过：`287 pass / 0 fail`

## 3.0.1 (2026-04-08)

相对 [v3.0.0](https://github.com/sunnoy/openclaw-plugin-wecom/releases/tag/v3.0.0) 的变更摘要。

### Fixes

- **WeCom `/workspace/...` 宿主路径解析对齐新版 OpenClaw**: `ws-monitor` 和动态 agent workspace template 的路径计算改为优先读取 `agents.defaults.workspace` / `agents.list[].workspace`，非默认 agent 不再错误回退到 `~/.openclaw/workspace-<agentId>`，修复新版多 agent workspace 根目录迁移后 `FILE:/workspace/...` / `MEDIA:/workspace/...` 文件发送失败的问题
- **回复文件发送引导强化**: WeCom reply guidance 明确要求把 `MEDIA:` / `FILE:` 指令放在 `<final>` 标签内，并补充 browser 媒体必须先 `stage_browser_media` 再回复，减少模型回错宿主路径或把指令写到标签外导致的静默丢失

### Tests

- 扩展 `tests/reply-media-directive.test.js`，覆盖 `agents.defaults.workspace` 作为非默认 agent workspace 基座时的 `/workspace/...` 解析
- 扩展 `tests/workspace-template.test.js`，覆盖 dynamic agent workspace 路径计算与 template seed 对新版 workspace 根目录的兼容

## 3.0.0 (2026-03-24)

相对 [v2.4.1](https://github.com/sunnoy/openclaw-plugin-wecom/releases/tag/v2.4.1) 的变更摘要。

### Breaking Changes

- **仅支持 OpenClaw `2026.3.23-2+`**: `peerDependencies.openclaw` 收紧为 `^2026.3.23-2`，并切换到新版 SDK 导出路径（`plugin-sdk/status-helpers`、`plugin-sdk/core`、`plugin-sdk/media-runtime`）
- **不再兼容旧版 core 媒体/状态目录分支**: 移除旧 `plugin-sdk` 媒体加载 fallback 和 `CLAWDBOT_STATE_DIR` 兼容读取，运行环境统一按新版 OpenClaw 约定处理

### Features

- **跨会话 WeCom 主动消息 sender 协议**: 为 `message.send` / `message.sendAttachment` 注入 `[[sender:...]]` 隐式头，并在 WS、Webhook、Agent API 出站时转成可见发送人前缀，避免子 Agent 主动触达其他会话时丢失发送者身份
- **中文名目标寻址增强**: `resolveWecomTarget()` 支持将纯中文姓名转拼音 userId，并结合 `~/.openclaw/agents` 下已存在的动态 DM Agent 自动补全或纠正目标 userId
- **动态 Agent 子会话投递钩子接入新版事件系统**: `subagent_delivery_target` / `subagent_spawned` / `subagent_ended` 改为通过 `api.on(...)` 注册，兼容新版 OpenClaw 生命周期
- **新增 `stage_browser_media` 工具**: 将浏览器工具产出的 `~/.openclaw/media/browser/*` 文件复制到当前 workspace，并返回可直接用于最终回复的 `/workspace/...` 指令，绕开 core block reply 对宿主机浏览器路径的 sandbox 拦截

### Fixes

- **WS 主动发送统一走 Markdown 载荷**: `sendWsMessage()` 统一发送 markdown body，减少结构化文本在主动消息中的降级
- **账号启动保存 channel runtime**: `startAccount()` 显式缓存 `ctx.channelRuntime`，为新版 core 的 channel 运行时能力留出兼容入口
- **新版状态摘要工具适配**: 账户状态摘要 helper 改从新版 SDK 子路径导入，避免 `2026.3.23-2` 上的运行时导出不匹配
- **浏览器媒体回复引导修正**: WeCom reply guidance 和 README 明确要求先用 `stage_browser_media` 把浏览器宿主机路径转进 `/workspace/...`，避免模型直接回传 `media/browser` 绝对路径导致 block reply 媒体丢失

### Tests

- 新增 `tests/outbound-sender-hook.test.js`、`tests/outbound-sender-protocol.test.js` 覆盖 sender 协议 hook 与协议转换
- 扩展 `tests/target.test.js`、`tests/reply-media-directive.test.js`、`tests/ws.e2e.test.js`，覆盖中文名寻址、内联 WeCom 规则和 WS 主动发送行为
- 新增 `tests/browser-media-tool.test.js` 覆盖浏览器媒体 staging 与安全校验

## 2.4.0 (2026-03-23)

相对 [v2.3.0](https://github.com/yangsjt/openclaw-plugin-wecom/releases/tag/v2.3.0) 的变更摘要。

### Features

- **MCP 按需架构重构**: 移除 `mcp-config.js` 持久化模块，改为通过 WS 客户端按需获取 MCP 配置并内存缓存，消除文件系统路径依赖（#132, #141）
- **MCP `msg` category 支持**: `wecom_mcp` 新增消息类 MCP 调用（群聊/单聊消息查询），配套 `wecom-msg` 和 `wecom-send-media` skill
- **MCP 企业规模限制说明**: tool description 和错误消息中明确标注企微官方策略——>10 人企业仅支持 `doc` category，<=10 人小团队支持全部 category
- **回调入站媒体下载兼容**: `downloadCallbackMedia` 改用 `core.media` runtime，兼容新版 OpenClaw 媒体存储接口
- **image_studio 回复规范**: WS 回复引导中增加 image_studio 成功后不重复输出图片 URL 的约束

### Fixes

- **Callback-only 账户启动修复 (#137)**: `startAccount` 跳过无 WS 凭据的 callback-only 账户的 WS monitor，防止 gateway restart 循环崩溃
- **动态 Agent 配置写入安全检查 (#136)**: `ensureDynamicAgentListed` 写入前验证内存配置含 `channels` 段，防止不完整快照覆盖用户配置文件
- **`replyFormat: "text"` 全路径生效 (#139)**: `sendViaAgent` 传递 `format` 参数，`sendViaWebhook` 根据配置选择 `webhookSendText` / `webhookSendMarkdown`，个人微信端不再显示"暂不支持此消息类型"
- **MCP unsupported category 错误增强 (#140)**: 返回企业规模限制说明 + 更明确的停止重试指令，减少 LLM 无效探索

### Chore

- 删除 `wecom/mcp-config.js`、`scripts/wecom-mcp-probe.js`、`tests/mcp-config.test.js`
- 新增 `scripts/wecom-mcp-remote-call.js` 远程 MCP 调用探测脚本
- 新增 `tests/callback-media.test.js` 回调媒体下载测试
- `.gitignore` 增加 `.claude/` 目录

## 2.3.0 (2026-03-20)

相对 [v2.2.1](https://github.com/sunnoy/openclaw-plugin-wecom/releases/tag/v2.2.1) 的变更摘要。

### Features

- **欢迎语外链文件 `welcomeMessagesFile`**: 支持从 OpenClaw 状态目录下的 JSON 加载欢迎语列表（顶层数组、`{ "messages": [...] }`、或每条为行数组），按 mtime+size 缓存，**改文件无需重启 gateway**；`welcomeMessage` 仍优先生效
- **可选 `image_studio` 工具**: 通过 `plugins.entries.wecom` 的 `qwenImageTools` 配置启用，对接通义/万相生图与编辑（`wecom/plugin-config.js` + `openclaw.plugin.json` schema）
- **子 Agent 投递前公告（WS）**: `subagent announce delivery hooks`，便于在 WS 机器人模式下在子 Agent 回复前向用户展示状态（#133）

### Fixes

- **动态 Agent 继承主 Agent 配置**: 会话 key 含 channel，并以账户 `agentId` 为继承基准（#125）
- **被动回复本地媒体与空群 @**: 修正媒体根路径与空 mention 场景（#120）
- **部门 ID 误判**: 避免将正文中的电话号码误识别为部门 ID（#124）

### Chore

- 新增运维脚本：`scripts/set-reasoning-stream-remote.js`、`scripts/wecom-mcp-remote-probe.js`
- `.gitignore` 增加本地 `welcome-messages.json`；删除过时迁移文档 `docs/official-1010-migration-plan.md`
- 默认内置欢迎语补充图片编辑与语音对话说明（未配置外链文件时的回退文案）

## 2.1.0 (2026-03-11)

### Features

- **自建应用 Agent 回调入站通道**: 支持企微自建应用"接收消息"HTTP 回调模式作为独立入站渠道。在 `agent.callback` 配置 `token`、`encodingAESKey`、`path` 即可启用；路由自动注册，与 WS 通道并行运行
- **Agent API 回复支持 Markdown**: `agentSendText` 新增 `format` 参数（`"text"` | `"markdown"`），回调入站回复默认为 `"markdown"`；可通过 `agent.replyFormat` 配置项覆盖
- **入站/出站信息日志**: WS 入站 `[WS:account] ← inbound`、CB 入站 `[CB:account] ← inbound`、CB 出站 `[CB:account] → outbound` 三条 INFO 日志，便于在 gateway 日志中追踪消息流

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
