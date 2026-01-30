# OpenClaw 企业微信 (WeCom) AI 机器人插件

`openclaw-plugin-wxwork` 是一个专为 [OpenClaw](https://github.com/sunnoy/openclaw-wecom-plugin) 框架开发的企业微信（WeCom）集成插件。它允许你将强大的 AI 能力无缝接入企业微信，并支持多项高级功能。

## ✨ 核心特性

- 🌊 **流式输出 (Streaming)**: 基于企业微信最新的 AI 机器人流式分片机制，实现流畅的打字机式回复体验。
- 🤖 **动态 Agent 管理**: 自动为每位私聊用户和每个群聊创建独立的 Agent 实例。每个实例拥有独立的文件工作区、配置环境和对话上下文，确保数据隔离与安全。
- 👥 **群聊深度集成**: 支持群聊消息解析，可通过 @提及（At-mention）精准触发机器人响应。
- 🛠️ **指令增强**: 内置常用指令支持（如 `/new` 开启新会话、`/status` 查看状态等），并提供指令白名单配置功能。
- 🔒 **安全与认证**: 完整支持企业微信消息加解密、URL 验证及发送者身份校验。
- ⚡ **高性能异步处理**: 采用异步消息处理架构，确保即使在长耗时 AI 推理过程中，企业微信网关也能保持高响应性。

## 🚀 快速开始

### 1. 安装插件

在你的 OpenClaw 项目目录中运行：

```bash
npm install openclaw-plugin-wxwork
```

### 2. 配置插件

在 OpenClaw 的配置文件（如 `config.json`）中添加插件配置：

```json
{
  "channels": {
    "wxwork": {
      "enabled": true,
      "token": "你的 Token",
      "encodingAesKey": "你的 EncodingAESKey",
      "webhookPath": "/webhooks/wxwork",
      "accounts": {
        "default": {
          "allowFrom": ["*"]
        }
      },
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/status", "/help", "/compact"]
      },
      "dynamicAgent": {
        "enabled": true,
        "prefix": "wxwork-"
      }
    }
  }
}
```

### 3. 企业微信后台设置

1. 在企业微信管理后台创建一个“智能机器人”。
2. 将机器人的“接收消息配置”中的 URL 设置为你的服务地址（例如：`https://your-domain.com/webhooks/wxwork`）。
3. 填入对应的 Token 和 EncodingAESKey。

## 🛠️ 指令支持

插件内置了对以下指令的处理：

- `/new`: 重置当前对话，开启全新会话。
- `/compact`: 压缩当前会话上下文，保留关键摘要以节省 Token。
- `/help`: 查看帮助信息。
- `/status`: 查看当前 Agent 及插件状态。

## 📂 项目结构

- `index.js`: 插件入口，处理所有核心路由与生命周期管理。
- `webhook.js`: 处理企业微信 HTTP 通信、加解密及消息解析。
- `dynamic-agent.js`: 动态 Agent 分配逻辑。
- `stream-manager.js`: 管理流式回复的状态与数据分片。
- `crypto.js`: 企业微信加密算法实现。

## 🤝 贡献规范

我们非常欢迎开发者参与贡献！如果你发现了 Bug 或有更好的功能建议，请提交 Issue 或 Pull Request。

## 📄 开源协议

本项目采用 [ISC License](./LICENSE) 协议。
