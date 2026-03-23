---
name: wecom-msg
description: 企业微信消息技能。提供会话列表查询、消息记录拉取（支持文本/图片/文件/语音/视频）、多媒体文件获取和文本消息发送能力。当用户需要“查看消息”、”看聊天记录”、”发消息给某人”、”最近有什么消息”、”给群里发消息”、”看看发了什么图片/文件”时触发。
---

# 企业微信消息技能

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

> ⚠️ **路径与停止规则**：
> - 如果要读取本 skill，必须直接使用 `<available_skills>` 或 `skillsSnapshot` 中给出的精确绝对路径。
> - 不要猜测或改写为 `/data/openclaw/skills/wecom-*`、`/workspace/.openclaw/skills/...`、`/root/.openclaw/workspace-*/.openclaw/skills/...`，也不要用 `exec` + `ls/find` 探路。
> - 若 `wecom_mcp` 返回 `errcode: 846609` 或 `unsupported mcp biz type`，表示当前 bot 未开通 `msg` category，不是路径、白名单或 sandbox 问题；立即停止继续 `read`、`list`、`find`、memory fallback 探索，直接告知用户当前机器人未开通消息能力。

通过 `wecom_mcp call msg <接口名> '<json入参>'` 与企业微信消息系统交互。

## 接口列表

### 1. 获取会话列表

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_msg_chat_list '{"begin_time": "2026-03-11 00:00:00", "end_time": "2026-03-17 23:59:59"}'`

按时间范围查询有消息的会话列表，支持分页。详情见 `references/api-get-msg-chat-list.md`。

### 2. 拉取聊天记录

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_messages '{"chat_type": 1, "chatid": "zhangsan", "begin_time": "2026-03-17 09:00:00", "end_time": "2026-03-17 18:00:00"}'`

根据会话类型和会话 ID 拉取指定时间范围内的消息记录，支持分页。详情见 `references/api-get-messages.md`。

### 3. 发送文本消息

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg send_message '{"chat_type": 1, "chatid": "zhangsan", "msgtype": "text", "text": {"content": "hello world"}}'`

向单聊或群聊发送文本消息。详情见 `references/api-send-message.md`。

## 核心规则

### 时间范围

- 所有时间参数使用 `YYYY-MM-DD HH:mm:ss` 格式。
- 用户未指定时间时，默认使用最近 7 天。
- `get_messages` 只支持当前时刻往前 7 天内的数据。
- 如果用户给出的开始时间早于 7 天窗口，要主动调整到有效范围并明确告知。

### 会话定位

- 当用户直接提供 `chatid` 时，直接使用。
- 当用户提供人名或群名而不是 ID 时，先调用 `get_msg_chat_list` 获取候选会话，再按 `chat_name` 在本地筛选。
- 精确匹配唯一结果时可直接使用。
- 模糊匹配多个结果时，必须先向用户展示候选项，不要擅自决定。
- 没有匹配结果时，要明确告知未找到对应会话。
- `get_msg_chat_list` 返回里没有 `chat_type`，若用户明确说“群”“群聊”“项目群”等，优先用 `chat_type=2`；否则默认 `chat_type=1`。

### 消息展示

- `get_messages` 当前只按文档约定处理文本消息；遇到非文本字段时，不要编造内容，按原始结构说明。
- 展示消息时优先把 `userid` 转成可读姓名。
- 如需做 `userid -> 姓名/别名` 映射，调用 `wecom-contact-lookup` 的 `get_userlist`，并在本地建立映射。
- 若无法映射，保留 `userid` 原样展示。

### 发送规则

- `send_message` 仅用于发送文本消息。
- 用户要求发送图片、PDF、视频、语音或其它文件时，不要误用 `wecom_mcp msg send_message`；应改用本插件原生的 `MEDIA:` / `FILE:` 路径投递能力。
- 发送消息前必须先做一次面向用户的确认，至少确认发送对象和发送内容。
- 用户确认前，不要执行 `send_message`。

## 典型工作流

### 查看最近有哪些会话

1. 确定时间范围。
2. 调用 `get_msg_chat_list`。
3. 按“会话名称 + 最后消息时间 + 消息数量”整理结果。
4. 若 `has_more=true`，提示用户还可以继续翻页。

### 查看某个聊天对象的记录

1. 确定时间范围。
2. 如需，先通过 `get_msg_chat_list` 定位 `chatid`。
3. 调用 `get_messages`。
4. 如需，调用 `wecom-contact-lookup` 获取通讯录，把 `userid` 映射为姓名/别名。
5. 按时间顺序展示消息。
6. 若 `next_cursor` 非空，提示还有更多消息可继续查看。

### 给某人或某个群发文本

1. 如需，先定位 `chatid` 与 `chat_type`。
2. 向用户确认发送对象和文本内容。
3. 用户确认后，调用 `send_message`。
4. 返回发送结果。

### 看完消息后代发回复

1. 先执行“查看聊天记录”流程。
2. 从上下文中提取待回复对象和回复内容。
3. 再执行“给某人或某个群发文本”流程。

## 错误处理

- 若返回 `tool not allowed`、`unknown tool: wecom_mcp`、`permission denied`，说明问题在宿主机工具放行，不要继续试探，按 `wecom-preflight` 规则处理。
- 若返回 `unsupported mcp biz type` 或 `errcode: 846609`，说明当前 bot 未开通 `msg` category，不要继续尝试其它 category。
- 若返回 API 业务错误，直接展示 `errcode` 和 `errmsg`，必要时最多重试 1 次。
- 若查询结果为空，要明确告知“当前时间范围内没有找到消息/会话”，不要编造。

## 快速参考

| 接口 | 用途 | 关键输入 | 关键输出 |
|------|------|----------|----------|
| `get_msg_chat_list` | 查询时间范围内有消息的会话列表 | `begin_time`, `end_time`, `cursor?` | `chats`, `has_more`, `next_cursor` |
| `get_messages` | 拉取指定会话消息 | `chat_type`, `chatid`, `begin_time`, `end_time`, `cursor?` | `messages`, `next_cursor` |
| `send_message` | 发送文本消息 | `chat_type`, `chatid`, `msgtype=text`, `text.content` | `errcode`, `errmsg` |
