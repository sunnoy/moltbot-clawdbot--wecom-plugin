# OpenClaw 企业微信 (WeCom) AI 机器人插件

[简体中文](https://github.com/sunnoy/openclaw-plugin-wecom/blob/main/README_ZH.md) | [English](https://github.com/sunnoy/openclaw-plugin-wecom/blob/main/README.md)

`openclaw-plugin-wecom` 是一个专为 [OpenClaw](https://github.com/openclaw/openclaw) 框架开发的企业微信（WeCom）集成插件。它允许你将强大的 AI 能力无缝接入企业微信，并支持多项高级功能。

## ✨ 核心特性

- 🌊 **流式输出 (Streaming)**: 基于企业微信最新的 AI 机器人流式分片机制，实现流畅的打字机式回复体验。
- 🤖 **动态 Agent 管理**: 默认按"每个私聊用户 / 每个群聊"自动创建独立 Agent。每个 Agent 拥有独立的工作区与对话上下文，实现更强的数据隔离。
- 👥 **群聊深度集成**: 支持群聊消息解析，可通过 @提及（At-mention）精准触发机器人响应。
- 🖼️ **图片支持**: 自动将本地图片（截图、生成的图像）进行 base64 编码并发送，无需额外配置。
- 🛠️ **指令增强**: 内置常用指令支持（如 `/new` 开启新会话、`/status` 查看状态等），并提供指令白名单配置功能。
- 🔒 **安全与认证**: 完整支持企业微信消息加解密、URL 验证及发送者身份校验。
- ⚡ **高性能异步处理**: 采用异步消息处理架构，确保即使在长耗时 AI 推理过程中，企业微信网关也能保持高响应性。

## 📋 前置要求

- 已安装 [OpenClaw](https://github.com/openclaw/openclaw) (版本 2026.1.30+)
- 企业微信管理后台权限，可创建智能机器人应用
- 可从企业微信访问的服务器地址（HTTP/HTTPS）

## 🚀 安装

### 方式一：使用 OpenClaw CLI（推荐）

```bash
openclaw plugins install openclaw-plugin-wecom
```

### 方式二：使用 npm

```bash
npm install openclaw-plugin-wecom
```

## ⚙️ 配置

在 OpenClaw 配置文件（`~/.openclaw/openclaw.json`）中添加：

```json
{
  "plugins": {
    "entries": {
      "openclaw-plugin-wecom": {
        "enabled": true
      }
    }
  },
  "channels": {
    "wecom": {
      "enabled": true,
      "token": "你的 Token",
      "encodingAesKey": "你的 EncodingAESKey",
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/status", "/help", "/compact"]
      }
    }
  }
}
```

### 配置说明

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `plugins.entries.openclaw-plugin-wecom.enabled` | boolean | 是 | 启用插件 |
| `channels.wecom.token` | string | 是 | 企业微信机器人 Token |
| `channels.wecom.encodingAesKey` | string | 是 | 企业微信消息加密密钥（43 位） |
| `channels.wecom.commands.allowlist` | array | 否 | 允许的指令白名单 |

## 🔌 企业微信后台配置

1. 登录[企业微信管理后台](https://work.weixin.qq.com/)
2. 进入"应用管理" → "应用" → "创建应用" → 选择"智能机器人"
3. 在"接收消息配置"中设置：
   - **URL**: `https://your-domain.com/webhooks/wecom`
   - **Token**: 与 `channels.wecom.token` 一致
   - **EncodingAESKey**: 与 `channels.wecom.encodingAesKey` 一致
4. 保存配置并启用消息接收

## 🤖 动态 Agent 路由

本插件实现"按人/按群隔离"的 Agent 管理：

### 工作原理

1. 企业微信消息到达后，插件生成确定性的 `agentId`：
   - **私聊**: `wecom-dm-<userId>`
   - **群聊**: `wecom-group-<chatId>`
2. OpenClaw 自动创建/复用对应的 Agent 工作区
3. 每个用户/群聊拥有独立的对话历史和上下文

### 高级配置

配置在 `channels.wecom` 下：

```json
{
  "channels": {
    "wecom": {
      "dynamicAgents": {
        "enabled": true
      },
      "dm": {
        "createAgentOnFirstMessage": true
      },
      "groupChat": {
        "enabled": true,
        "requireMention": true
      }
    }
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `dynamicAgents.enabled` | boolean | `true` | 是否启用动态 Agent |
| `dm.createAgentOnFirstMessage` | boolean | `true` | 私聊使用动态 Agent |
| `groupChat.enabled` | boolean | `true` | 启用群聊处理 |
| `groupChat.requireMention` | boolean | `true` | 群聊必须 @ 提及才响应 |

### 禁用动态 Agent

如果需要所有消息进入默认 Agent：

```json
{
  "channels": {
    "wecom": {
      "dynamicAgents": { "enabled": false }
    }
  }
}
```

## 🛠️ 指令白名单

为防止普通用户通过企业微信消息执行敏感的 Gateway 管理指令，本插件支持**指令白名单**机制。

```json
{
  "channels": {
    "wecom": {
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/status", "/help", "/compact"]
      }
    }
  }
}
```

### 推荐白名单指令

| 指令 | 说明 | 安全级别 |
|------|------|----------|
| `/new` | 重置当前对话，开启全新会话 | ✅ 用户级 |
| `/compact` | 压缩当前会话上下文 | ✅ 用户级 |
| `/help` | 查看帮助信息 | ✅ 用户级 |
| `/status` | 查看当前 Agent 状态 | ✅ 用户级 |

> ⚠️ **安全提示**：不要将 `/gateway`、`/plugins` 等管理指令添加到白名单，避免普通用户获得 Gateway 实例的管理权限。

## ❓ 常见问题 (FAQ)

### Q: 配置文件中的插件 ID 应该使用什么？

**A:** 在 `plugins.entries` 中，应该使用**完整的插件 ID**：

```json
{
  "plugins": {
    "entries": {
      "openclaw-plugin-wecom": { "enabled": true }  // ✅ 正确
    }
  }
}
```

**不要**使用 channel id：
```json
{
  "plugins": {
    "entries": {
      "wecom": { "enabled": true }  // ❌ 错误
    }
  }
}
```

### Q: 为什么 `openclaw doctor` 报告警告？

**A:** 如果看到配置警告，运行：

```bash
openclaw doctor --fix
```

这会自动修复常见的配置问题。

### Q: 图片发送是如何工作的？

**A:** 插件会自动处理 OpenClaw 生成的图片（如浏览器截图）：

- **本地图片**（来自 `~/.openclaw/media/`）会自动进行 base64 编码，通过企业微信 `msg_item` API 发送
- **图片限制**：单张图片最大 2MB，支持 JPG 和 PNG 格式，每条消息最多 10 张图片
- **无需配置**：开箱即用，配合浏览器截图等工具自动生效
- 图片会在 AI 完成回复后显示（流式输出不支持增量发送图片）

**示例：**
```
用户："帮我截个 GitHub 首页的图"
AI：[执行截图] → 图片在企业微信中正常显示 ✅
```

如果图片处理失败（超出大小限制、格式不支持等），文本回复仍会正常发送，错误信息会记录在日志中。

### Q: OpenClaw 开放公网需要 auth token，企业微信回调如何配置？

**A:** 企业微信机器人**不需要**配置 OpenClaw 的 Gateway Auth Token。

- **Gateway Auth Token** (`gateway.auth.token`) 主要用于：
  - WebUI 访问认证
  - WebSocket 连接认证
  - CLI 远程连接认证

- **企业微信 Webhook** (`/webhooks/wecom`) 的认证机制：
  - 使用企业微信自己的签名验证（Token + EncodingAESKey）
  - 不需要 Gateway Auth Token
  - OpenClaw 插件系统会自动处理 webhook 路由

**部署建议：**
1. 如果使用反向代理（如 Nginx），可以为 `/webhooks/wecom` 路径配置豁免认证
2. 或者将 webhook 端点暴露在独立端口，不经过 Gateway Auth

### Q: EncodingAESKey 长度验证失败怎么办？

**A:** 常见原因和解决方法：

1. **检查配置键名**：确保使用正确的键名 `encodingAesKey`（注意大小写）
   ```json
   {
     "channels": {
       "wecom": {
         "encodingAesKey": "..."  // ✅ 正确
       }
     }
   }
   ```

2. **检查密钥长度**：EncodingAESKey 必须是 43 位字符
   ```bash
   # 检查长度
   echo -n "你的密钥" | wc -c
   ```

3. **检查是否有多余空格/换行**：确保密钥字符串前后没有空格或换行符

## 📂 项目结构

```
openclaw-plugin-wecom/
├── index.js              # 插件入口
├── webhook.js            # 企业微信 HTTP 通信处理
├── dynamic-agent.js      # 动态 Agent 分配逻辑
├── stream-manager.js     # 流式回复管理
├── crypto.js             # 企业微信加密算法
├── client.js             # 客户端逻辑
├── logger.js             # 日志模块
├── utils.js              # 工具函数
├── package.json          # npm 包配置
└── openclaw.plugin.json  # OpenClaw 插件清单
```

## 🤝 贡献规范

我们非常欢迎开发者参与贡献！如果你发现了 Bug 或有更好的功能建议，请提交 Issue 或 Pull Request。

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)

## 📄 开源协议

本项目采用 [ISC License](./LICENSE) 协议。
