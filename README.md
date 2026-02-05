# OpenClaw WeCom (Enterprise WeChat) AI Bot Plugin

[English](https://github.com/sunnoy/openclaw-plugin-wecom/blob/main/README.md) | [简体中文](https://github.com/sunnoy/openclaw-plugin-wecom/blob/main/README_ZH.md)

`openclaw-plugin-wecom` is an Enterprise WeChat (WeCom) integration plugin developed for the [OpenClaw](https://github.com/openclaw/openclaw) framework. It enables seamless AI capabilities in Enterprise WeChat with advanced features.

## ✨ Key Features

- 🌊 **Streaming Output**: Built on WeCom's latest AI bot streaming mechanism for smooth typewriter-style responses.
- 🤖 **Dynamic Agent Management**: Automatically creates isolated agents per direct message user or group chat, with independent workspaces and conversation contexts.
- 👥 **Deep Group Chat Integration**: Supports group message parsing with @mention triggering.
- 🖼️ **Image Support**: Automatic base64 encoding and sending of local images (screenshots, generated images) without requiring additional configuration.
- 🛠️ **Command Enhancement**: Built-in commands (e.g., `/new` for new sessions, `/status` for status) with allowlist configuration.
- 🔒 **Security & Authentication**: Full support for WeCom message encryption/decryption, URL verification, and sender validation.
- ⚡ **High-Performance Async Processing**: Asynchronous message architecture ensures responsive gateway even during long AI inference.

## 📋 Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed (version 2026.1.30+)
- Enterprise WeChat admin access to create intelligent robot applications
- Server address accessible from Enterprise WeChat (HTTP/HTTPS)

## 🚀 Installation

### Method 1: Using OpenClaw CLI (Recommended)

```bash
openclaw plugins install openclaw-plugin-wecom
```

### Method 2: Using npm

```bash
npm install openclaw-plugin-wecom
```

## ⚙️ Configuration

Add to your OpenClaw configuration file (`~/.openclaw/openclaw.json`):

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
      "token": "Your Token",
      "encodingAesKey": "Your EncodingAESKey",
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/status", "/help", "/compact"]
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `plugins.entries.openclaw-plugin-wecom.enabled` | boolean | Yes | Enable the plugin |
| `channels.wecom.token` | string | Yes | WeCom bot Token |
| `channels.wecom.encodingAesKey` | string | Yes | WeCom message encryption key (43 chars) |
| `channels.wecom.commands.allowlist` | array | No | Command allowlist |

## 🔌 Enterprise WeChat Configuration

1. Log in to [Enterprise WeChat Admin Console](https://work.weixin.qq.com/)
2. Navigate to "Application Management" → "Applications" → "Create Application" → Select "Intelligent Robot"
3. Configure "Receive Messages":
   - **URL**: `https://your-domain.com/webhooks/wecom`
   - **Token**: Match `channels.wecom.token`
   - **EncodingAESKey**: Match `channels.wecom.encodingAesKey`
4. Save and enable message receiving

## 🤖 Dynamic Agent Routing

The plugin implements per-user/per-group agent isolation:

### How It Works

1. When a WeCom message arrives, the plugin generates a deterministic `agentId`:
   - **Direct Messages**: `wecom-dm-<userId>`
   - **Group Chats**: `wecom-group-<chatId>`
2. OpenClaw automatically creates/reuses the corresponding agent workspace
3. Each user/group has independent conversation history and context

### Advanced Configuration

Configure under `channels.wecom`:

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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dynamicAgents.enabled` | boolean | `true` | Enable dynamic agents |
| `dm.createAgentOnFirstMessage` | boolean | `true` | Use dynamic agents for DMs |
| `groupChat.enabled` | boolean | `true` | Enable group chat processing |
| `groupChat.requireMention` | boolean | `true` | Require @mention in groups |

### Disable Dynamic Agents

To route all messages to the default agent:

```json
{
  "channels": {
    "wecom": {
      "dynamicAgents": { "enabled": false }
    }
  }
}
```

## 🛠️ Command Allowlist

Prevent regular users from executing sensitive Gateway management commands through WeCom messages.

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

### Recommended Allowlist Commands

| Command | Description | Safety Level |
|---------|-------------|--------------|
| `/new` | Reset conversation, start new session | ✅ User-level |
| `/compact` | Compress current session context | ✅ User-level |
| `/help` | Show help information | ✅ User-level |
| `/status` | Show Agent status | ✅ User-level |

> ⚠️ **Security Note**: Do not add `/gateway`, `/plugins`, or other management commands to the allowlist to prevent regular users from gaining Gateway instance admin privileges.

## ❓ FAQ

### Q: What plugin ID should I use in the configuration file?

**A:** Use the **complete plugin ID** in `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-plugin-wecom": { "enabled": true }  // ✅ Correct
    }
  }
}
```

**Do not** use the channel id:
```json
{
  "plugins": {
    "entries": {
      "wecom": { "enabled": true }  // ❌ Incorrect
    }
  }
}
```

### Q: Why does `openclaw doctor` report warnings?

**A:** If you see configuration warnings, run:

```bash
openclaw doctor --fix
```

This will automatically fix common configuration issues.

### Q: How does image sending work?

**A:** The plugin automatically handles images generated by OpenClaw (such as browser screenshots):

- **Local images** (from `~/.openclaw/media/`) are automatically encoded to base64 and sent via WeCom's `msg_item` API
- **Image constraints**: Max 2MB per image, supports JPG and PNG formats, up to 10 images per message
- **No configuration needed**: Works out of the box with tools like browser screenshot
- Images appear when the AI completes its response (streaming doesn't support incremental image sending)

**Example:**
```
User: "Take a screenshot of GitHub homepage"
AI: [Takes screenshot] → Image displays properly in WeCom ✅
```

If an image fails to process (size limit, invalid format), the text response will still be delivered and an error will be logged.

### Q: How to configure auth token for public-facing OpenClaw with WeCom callbacks?

**A:** WeCom bot **does not need** OpenClaw's Gateway Auth Token.

- **Gateway Auth Token** (`gateway.auth.token`) is used for:
  - WebUI access authentication
  - WebSocket connection authentication
  - CLI remote connection authentication

- **WeCom Webhook** (`/webhooks/wecom`) authentication:
  - Uses WeCom's own signature verification (Token + EncodingAESKey)
  - Does not require Gateway Auth Token
  - OpenClaw plugin system automatically handles webhook routing

**Deployment suggestions:**
1. If using a reverse proxy (e.g., Nginx), configure authentication exemption for `/webhooks/wecom` path
2. Or expose the webhook endpoint on a separate port without Gateway Auth

### Q: How to fix EncodingAESKey length validation failure?

**A:** Common causes and solutions:

1. **Check configuration key name**: Ensure correct key name `encodingAesKey` (case-sensitive)
   ```json
   {
     "channels": {
       "wecom": {
         "encodingAesKey": "..."  // ✅ Correct
       }
     }
   }
   ```

2. **Check key length**: EncodingAESKey must be exactly 43 characters
   ```bash
   # Check length
   echo -n "your-key" | wc -c
   ```

3. **Check for extra spaces/newlines**: Ensure no leading/trailing whitespace in the key string

## 📂 Project Structure

```
openclaw-plugin-wecom/
├── index.js              # Plugin entry point
├── webhook.js            # WeCom HTTP communication handler
├── dynamic-agent.js      # Dynamic agent routing logic
├── stream-manager.js     # Streaming response manager
├── crypto.js             # WeCom encryption algorithms
├── client.js             # Client logic
├── logger.js             # Logging module
├── utils.js              # Utility functions
├── package.json          # npm package config
└── openclaw.plugin.json  # OpenClaw plugin manifest
```

## 🤝 Contributing

We welcome contributions! Please submit Issues or Pull Requests for bugs or feature suggestions.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## 📄 License

This project is licensed under the [ISC License](./LICENSE).
