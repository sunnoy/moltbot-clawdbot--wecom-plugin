# v2.0 复核结论（以 SDK 为准）

> 复核日期：2026-03-09
> 范围：当前 `main` 代码、`@wecom/aibot-node-sdk` 本地实现与 README / 设计文档
> 参考：
> - 官方开发者文档：`https://developer.work.weixin.qq.com/document/path/101463`
> - 本地 SDK 类型：`node_modules/@wecom/aibot-node-sdk/dist/index.d.ts`
> - 本地 SDK README：`node_modules/@wecom/aibot-node-sdk/README.md`
>
> 本文后续判断以 SDK 类型、README 和运行时代码为准；`101463` 仅作为协议参考。

---

## 一、当前结论

当前插件已经完成 v2 主线的大部分迁移，核心链路已经是：

- WS-only 入站
- `replyStream` 被动流式回复
- `sendMessage` 主动文本发送
- `msgItem` 最终帧图片回复
- `<think>` 标签透传与规范化
- `enter_chat` 欢迎语
- Agent API / Webhook 仅作为增强出站

本轮复核后，真正还需要继续优化的点集中在两类：

1. **协议与运行时硬项**
2. **增强能力补齐**

---

## 二、已确认正确的部分

### 2.1 主链路

- `wecom/ws-monitor.js` 已经是唯一入站主链路，不再依赖 HTTP callback。
- `sendWsReply()` 已通过 SDK `replyStream()` 发送流式回复。
- `sendWsMessage()` 已通过 SDK `sendMessage()` 发送主动 markdown 消息。
- `event.enter_chat` 已接入 `replyWelcome()`。

### 2.2 已经接入的 v2 增强

- `dm-policy.js` 已支持 `pairing / open / disabled`
- `group-policy.js` 已支持群聊策略
- 动态 Agent / workspace template / ACL 已保留
- `think-parser.js` 已接入运行时，不再只是测试代码
- 最终帧图片已通过 `msgItem` 发出

### 2.3 当前基线状态

- `package.json` 已为 `2.0.0`
- 当前测试已通过：`78/78`
- 旧 review 文档中的“5 个测试失败”等结论已经失效

---

## 三、本轮已完成的运行时补齐

### 3.1 `msgid` 去重已补齐

已在 `wecom/ws-monitor.js` 入口补上 `MessageDeduplicator`，按 `accountId + msgid` 做短 TTL 去重，避免断线重投时重复处理同一消息。

### 3.2 `disconnected_event` 占线处理已补齐

已新增 `event.disconnected_event` 监听。收到事件后会：

- 记录明确日志
- 主动 `disconnect()`
- 结束当前 monitor promise，并抛出“botId 被其他连接接管”的错误

### 3.3 `template_card_event` / `feedback_event` 已最小接入

已新增最小监听并记录事件日志，后续扩展模板卡片更新和用户反馈闭环时可以直接沿用这些入口。

### 3.4 欢迎语已改为可配置

已增加：

- `channels.wecom.welcomeMessage`
- 账号级 `channels.wecom.<accountId>.welcomeMessage`

未配置时仍回落到默认欢迎语。

### 3.5 主动发送 / 24h 回复额度已做最小感知

已增加本地近似记账与状态暴露：

- 入站消息会重置对应会话的 24h reply window
- 最终被动回复会累计 24h reply quota
- 主动 `sendMessage()` 会优先消耗 24h reply quota，否则累计到每日主动推送额度
- 接近阈值或超限时会打 warning 日志

当前策略仍是“感知 + 告警”，不是强阻断；这样可以避免本地估算误差直接拦消息。

### 3.6 状态面板已暴露占线 / 配额状态

已通过两层暴露：

- `buildAccountSnapshot()` 附带 `wecomStatus`
- `collectStatusIssues()` 输出连接占线与配额压力告警

当前已经能在状态侧看到：

- 连接是否被其他实例接管
- 24h reply window 是否接近或达到上限
- 每日主动推送额度是否接近或达到上限

---

## 四、SDK 与开发者文档存在漂移的点

### 4.1 `msg_item` 能力以 SDK 为准

**冲突**

- `101463` 当前仍写着：`aibot_respond_msg` 暂不支持 `msg_item`
- 但本地 SDK README、类型声明和运行时代码都已经支持：
  - `replyStream(..., msgItem?)`
  - 仅 `finish=true` 时生效
  - 最多 10 个图片项

**本项目决策**

以 SDK 为准，保留当前 `finish=true + msgItem` 图片回复实现。

**文档建议**

README 中应显式写明：

- 当前实现按 SDK 能力工作
- 企业微信 `developer` 文档存在滞后
- 若线上实际返回能力不一致，插件应退化为纯文本最终帧，而不是影响主回复链路

### 4.2 `disconnected_event` 在协议文档存在，但 SDK README 未枚举

**现状**

- SDK README 公开列出三个事件：`enter_chat / template_card_event / feedback_event`
- 但 SDK 运行时代码会对任意 `eventtype` 触发 `event.${eventtype}`

**本项目决策**

实现上可以直接监听 `event.disconnected_event`，不需要等待 SDK README 单独补齐。

---

## 五、README 已完成的纠偏项

README 已于本轮同步到当前 v2 实现；下面保留本次完成纠偏的重点，方便后续核对。

### 5.1 配置字段写错了主路径

已清理的旧字段包括：

- `channels.wecom.token`
- `channels.wecom.encodingAesKey`
- `channels.wecom.agent.token`
- `channels.wecom.agent.encodingAesKey`

而 v2 主路径实际应是：

- `channels.wecom.botId`
- `channels.wecom.secret`
- 可选 `channels.wecom.websocketUrl`

Agent 配置仅作为增强出站，不再需要 Agent 入站回调字段。

### 5.2 Bot 模式说明仍写成 HTTP 回调 + stream_refresh

已清理的旧说法包括：

- Bot 模式通过 HTTP POST 回调
- 通过 `stream_refresh` 轮询刷新
- AI 机器人不支持主动发送

这些说法都与当前 v2 实现和 SDK 能力不符。

应统一改为：

- Bot 模式 = 官方 WebSocket 长连接
- 流式刷新由开发者主动通过长连接推送
- 支持 `sendMessage()` 主动发送 markdown / template_card

### 5.3 入站媒体解密描述仍沿用 `encodingAesKey`

已修正 FAQ 中“使用配置的 `encodingAesKey` 解密图片”的旧说法。

WS 模式下正确说法应是：

- 图片 / 文件消息带独立 `aeskey`
- 使用消息体里的 `image.aeskey` 或 `file.aeskey`
- 不再依赖统一 `EncodingAESKey`

### 5.4 支持能力有过度声明

已收敛此前超出当前实现边界的描述，例如：

- “位置、链接、视频”等消息类型
- “完整支持 XML 回调”
- “Bot 模式需要配置 HTTP 可访问地址”

这些都应收敛到当前 v2 真实能力。

---

## 六、下一阶段优先级

### P1

1. 状态页暴露更细粒度的最近事件与会话级明细
2. 模板卡片事件从“仅记录”升级为“可更新卡片”
3. 配额告警后的自动后备策略

### P2

1. 会话级配额与占线状态的更细明细
2. 运维文档中补充更多 WS-only 部署排障说明
3. 持续明确“以 SDK 为准”的能力边界

---

## 七、这一轮复核后的核心判断

v2 当前不是“架构没搭起来”，而是“主链路已经成型，P0 已补齐，文档口径也已回到 WS-only，剩余工作主要是增强能力继续往前补”。

如果只看运行时代码，最该优先补的是：

1. 模板卡片点击后的实际业务处理
2. 更细粒度的状态展示
3. 额度告警后的自动后备策略

如果只看后续文档工作，最该继续补的是：

1. 更细粒度的状态与配额运维说明
2. 模板卡片 / 反馈事件的业务接入示例
3. SDK 能力边界与官方文档漂移的持续记录
