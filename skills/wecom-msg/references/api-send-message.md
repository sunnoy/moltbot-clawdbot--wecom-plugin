# `send_message` API

向单聊或群聊发送文本消息。

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chat_type` | integer | 是 | 会话类型，`1` 表示单聊，`2` 表示群聊 |
| `chatid` | string | 是 | 会话 ID。单聊时通常为 userid，群聊时为群 ID |
| `msgtype` | string | 是 | 消息类型。当前只应使用 `text` |
| `text` | object | 是 | 文本消息体 |
| `text.content` | string | 是 | 文本内容，受企业微信消息长度限制 |

## 请求示例

单聊：

```text
wecom_mcp call msg send_message '{"chat_type":1,"chatid":"zhangsan","msgtype":"text","text":{"content":"hello world"}}'
```

群聊：

```text
wecom_mcp call msg send_message '{"chat_type":2,"chatid":"wrxxxxxxxx","msgtype":"text","text":{"content":"大家好"}}'
```

## 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功 |
| `errmsg` | string | 错误信息 |

## 响应示例

```json
{
  "errcode": 0,
  "errmsg": "ok"
}
```

## 使用约束

- 在当前插件里，这个接口只应用于文本消息。
- 发图片、PDF、视频、语音或其它文件时，不要误用这个接口；应改用插件原生的 `MEDIA:` / `FILE:` 路径投递能力。
- 执行发送前必须先征得用户确认，避免误发。
