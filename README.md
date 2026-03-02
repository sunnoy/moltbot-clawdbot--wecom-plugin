# OpenClaw 企业微信 (WeCom) AI 机器人插件

`openclaw-plugin-wecom` 是一个专为 [OpenClaw](https://github.com/openclaw/openclaw) 框架开发的企业微信（WeCom）集成插件。它允许你将强大的 AI 能力无缝接入企业微信，支持 AI 机器人模式和自建应用模式，并具备多层消息投递回退机制。

## 核心特性

### 消息模式支持
- **AI 机器人模式 (Bot Mode)**: 基于企业微信最新的 AI 机器人流式分片机制，实现流畅的打字机式回复体验。支持 JSON 格式的回调消息。
- **自建应用模式 (Agent Mode)**: 支持企业微信自建应用，可处理 XML 格式的回调消息，支持收发消息、上传下载媒体文件。
- **Webhook Bot 模式**: 支持通过 Webhook 发送消息到群聊，适用于群通知场景。

### 智能消息投递
- **四层投递回退机制**: 确保消息可靠送达
  1. **流式通道**: 优先通过活跃流式通道发送
  2. **Response URL 回退**: 流式通道关闭后，使用企业微信 response_url 发送
  3. **Webhook Bot 回退**: 支持通过 Webhook 发送到指定群聊
  4. **Agent API 回退**: 通过自建应用 API 主动推送消息
- **消息防抖合并**: 同一用户在短时间内（2 秒内）连续发送的多条消息自动合并为一次 AI 请求。
- **内存自动清理**: 定期清理过期的流元数据和响应 URL，防止内存泄漏。

### 动态 Agent 与隔离
- **动态 Agent 管理**: 默认按"每个私聊用户 / 每个群聊"自动创建独立 Agent。每个 Agent 拥有独立的工作区与对话上下文，实现更强的数据隔离。
- **群聊深度集成**: 支持群聊消息解析，可通过 @提及（At-mention）精准触发机器人响应。
- **管理员用户**: 可配置管理员列表，绕过指令白名单和动态 Agent 路由限制。
- **指令白名单**: 内置常用指令支持（如 `/new`、`/status`），并提供指令白名单配置功能。

### 多媒体支持
- **丰富消息类型**: 支持文本、图片、语音、图文混排、文件、位置、链接等消息类型。
- **入站媒体处理**: 自动解密企业微信 AES-256-CBC 加密的图片，下载并保存语音、视频、文件等媒体供 AI 分析。
- **出站图片发送**: 支持通过 `msg_item` API 发送 base64 编码图片，单张最大 2MB，每条消息最多 10 张。
- **文件上传下载**: Agent 模式下支持上传临时媒体文件和下载用户发送的媒体文件。

### 安全与扩展
- **安全与认证**: 完整支持企业微信消息加解密、URL 验证及发送者身份校验。
- **高性能异步处理**: 采用异步消息处理架构，确保即使在长耗时 AI 推理过程中，企业微信网关也能保持高响应性。
- **模块化架构**: 清晰的代码组织结构，易于维护和扩展。

## 前置要求

- 已安装 [OpenClaw](https://github.com/openclaw/openclaw) (版本 2026.1.30+)
- 企业微信管理后台权限，可创建智能机器人应用或自建应用
- 可从企业微信访问的服务器地址（HTTP/HTTPS）

## 安装

```bash
openclaw plugins install @sunnoy/wecom
```

此命令会自动：
- 从 npm 下载插件
- 安装到 `~/.openclaw/extensions/` 目录
- 更新 OpenClaw 配置
- 注册插件

### 运行测试

```bash
npm test
```

运行单元测试（使用 Node.js 内置测试运行器）。

### 运行真实 E2E 测试（远程 OpenClaw）

本项目新增了真实联调 e2e 用例（`tests/e2e/remote-wecom.e2e.test.js`），会对真实 `/webhooks/wecom` 做加密请求、验证握手、发送消息并轮询 stream 直到结束。

1. 使用你当前环境的 `ssh ali-ai` 一键执行（自动读取远程 `~/.openclaw/openclaw.json`，并建立本地隧道）：

```bash
npm run test:e2e:ali-ai
```

2. 或者手动指定环境变量执行：

```bash
E2E_WECOM_BASE_URL=http://127.0.0.1:28789 \
E2E_WECOM_TOKEN=xxx \
E2E_WECOM_ENCODING_AES_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
E2E_WECOM_WEBHOOK_PATH=/webhooks/wecom \
npm run test:e2e
```

可选变量：
- `E2E_WECOM_TEST_USER`（默认 `wecom-e2e-user`）
- `E2E_WECOM_TEST_COMMAND`（默认 `/status`）
- `E2E_WECOM_POLL_INTERVAL_MS`（默认 `1200`）
- `E2E_WECOM_STREAM_TIMEOUT_MS`（默认 `90000`）
- `E2E_WECOM_ENABLE_BROWSER_CASE`（默认 `1`，设置 `0` 可跳过浏览器场景）
- `E2E_WECOM_BROWSER_TIMEOUT_MS`（默认 `180000`）
- `E2E_WECOM_BROWSER_REQUIRE_IMAGE`（默认 `0`，设置 `1` 强制断言 `msg_item` 图片出站）
- `E2E_WECOM_BROWSER_PROMPT`（浏览器场景自定义提示词）
- `E2E_WECOM_BROWSER_BING_PDF_PROMPT`（Bing + 保存 PDF 场景提示词）
- `E2E_WECOM_ENABLE_BROWSER_BING_PDF_CASE`（默认 `1`）
- `E2E_BROWSER_PREPARE_MODE`（`check`/`install`/`off`，默认 `check`）
- `E2E_BROWSER_REQUIRE_READY`（默认 `0`，设置 `1` 时浏览器环境不满足则中止）
- `E2E_COLLECT_BROWSER_PDF`（默认 `1`，执行后自动收集远程 sandbox 中的 PDF）
- `E2E_PDF_OUTPUT_DIR`（默认 `tests/e2e/artifacts`）

> 说明：`test:e2e:ali-ai` 会消耗远程实例的真实 LLM token，并覆盖多种真实入站/出站场景（含浏览器相关场景）。
> 说明：执行 `test:e2e:ali-ai` 会先做 browser sandbox 准备检查（`prepare-browser-sandbox.sh`），测试后会尝试抓取 PDF 产物（`collect-browser-pdf.sh`）供用户下载。
> 说明：当 browser sandbox 未就绪（缺浏览器二进制或缺 `browser` skill）时，Bing+PDF case 会自动跳过，并在准备检查输出中标记 `STATUS=MISSING`。

## 配置

在 OpenClaw 配置文件（`~/.openclaw/openclaw.json`）中添加：

```json
{
  "plugins": {
    "entries": {
      "wecom": {
        "enabled": true
      }
    }
  },
  "channels": {
    "wecom": {
      "enabled": true,
      "token": "你的 Bot Token",
      "encodingAesKey": "你的 Bot EncodingAESKey",
      "adminUsers": ["管理员userid"],
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/status", "/help", "/compact"]
      },
      "agent": {
        "corpId": "企业 CorpID",
        "corpSecret": "应用 Secret",
        "agentId": 1000002,
        "token": "回调 Token (Agent 模式)",
        "encodingAesKey": "回调 EncodingAESKey (Agent 模式)"
      },
      "webhooks": {
        "ops-group": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
        "dev-group": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=yyy"
      }
    }
  }
}
```

### 配置说明

#### 基础配置

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `plugins.entries.wecom.enabled` | boolean | 是 | 启用插件 |
| `channels.wecom.token` | string | 是* | 企业微信机器人 Token (*Bot 模式必填) |
| `channels.wecom.encodingAesKey` | string | 是* | 消息加密密钥（43 位）(*Bot 模式必填) |
| `channels.wecom.adminUsers` | array | 否 | 管理员用户 ID 列表（绕过指令白名单和动态路由） |
| `channels.wecom.commands.enabled` | boolean | 否 | 是否启用指令白名单过滤（默认 true） |
| `channels.wecom.commands.allowlist` | array | 否 | 允许的指令白名单 |

#### 动态 Agent 配置

配置按人/按群隔离的 Agent 管理：

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `channels.wecom.dynamicAgents.enabled` | boolean | 否 | 是否启用动态 Agent（默认 true） |
| `channels.wecom.dm.createAgentOnFirstMessage` | boolean | 否 | 私聊时为每个用户创建独立 Agent（默认 true） |
| `channels.wecom.groupChat.enabled` | boolean | 否 | 是否启用群聊处理（默认 true） |
| `channels.wecom.groupChat.requireMention` | boolean | 否 | 群聊是否必须 @ 提及才响应（默认 true） |

#### 工作区模板配置 (可选)

配置工作区模板目录，为动态创建的 Agent 工作区预置初始化文件：

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `channels.wecom.workspaceTemplate` | string | 否 | 模板目录路径，支持 AGENTS.md、BOOTSTRAP.md 等 bootstrap 文件 |

当动态 Agent 首次创建时，会自动从模板目录复制 bootstrap 文件到对应的工作区。详细说明请参考[动态 Agent 路由](#动态-agent-路由)章节。

#### Agent 模式配置 (可选)

配置自建应用以实现更强大的消息收发能力：

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `channels.wecom.agent.corpId` | string | 是 | 企业 CorpID |
| `channels.wecom.agent.corpSecret` | string | 是 | 应用 Secret |
| `channels.wecom.agent.agentId` | number | 是 | 应用 Agent ID |
| `channels.wecom.agent.token` | string | 是 | 回调 Token (用于验证签名) |
| `channels.wecom.agent.encodingAesKey` | string | 是 | 回调 EncodingAESKey (43 位) |

#### Webhook 配置 (可选)

配置 Webhook Bot 用于群通知：

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `channels.wecom.webhooks` | object | 否 | Webhook URL 映射 (key: 名称, value: URL) |

## 企业微信后台配置

### 方式一：创建 AI 机器人 (Bot 模式)

AI 机器人模式适用于简单的问答场景，支持流式输出。

> 📖 **官方文档**：[企业微信 AI 机器人开发指南](https://developer.work.weixin.qq.com/document/path/101039)

**创建步骤：**

1. 登录[企业微信管理后台](https://work.weixin.qq.com/)
2. 进入「应用管理」→「应用」→ 下拉找到「智能机器人」→ 点击「创建应用」
3. **关键步骤**：在创建页面底部，选择 **「API 模式创建」**，而非「标准模式创建」
   > ⚠️ **必须选择 API 模式**。标准模式下回调消息为 XML 格式，API 模式为 JSON 格式，本插件的 Bot 模式仅支持 JSON。
4. 填写机器人名称、头像等基本信息，点击「创建」
5. 创建完成后，进入机器人详情页：
   - 复制 `Token`（用于验证消息签名）
   - 复制 `EncodingAESKey`（43位字符，用于消息加解密）
6. 点击「接收消息」区域的「设置」：
   - **URL**: `https://your-domain.com/webhooks/wecom`
   - **Token**: 填入上一步复制的 Token
   - **EncodingAESKey**: 填入上一步复制的 EncodingAESKey
7. 保存配置并启用消息接收

### 方式二：创建自建应用 (Agent 模式)

自建应用模式提供更完整的消息收发能力，支持 XML 回调、主动推送、媒体文件处理。

> 📖 **官方文档**：[企业微信自建应用开发指南](https://developer.work.weixin.qq.com/document/path/90226)、[接收消息服务器配置](https://developer.work.weixin.qq.com/document/path/90238)

**创建步骤：**

1. 登录[企业微信管理后台](https://work.weixin.qq.com/)
2. 进入「应用管理」→「应用」→ 点击「创建应用」
3. 填写应用信息：
   - 应用名称：如 "AI 助手"
   - 应用头像：上传应用图标
   - 可见成员：选择可使用该应用的成员
4. 点击「创建应用」，记录以下信息：
   - `AgentId`：应用 ID（数字）
   - `Secret`：应用凭证（点击「查看」获取）
5. 在「接收消息」区域点击「设置 API 接收」：
   - **URL**: `https://your-domain.com/webhooks/app`
   - **Token**: 点击「随机生成」获取
   - **EncodingAESKey**: 点击「随机生成」获取（43位字符）
   - 点击「保存」时，企业微信会发送验证请求到上述 URL 进行域名校验
   > ⚠️ **注意**：保存前请确保服务已部署并可访问，否则校验会失败。如果遇到「回调 URL 校验失败」，请检查：
   > - 服务器是否可以从公网访问
   > - URL 路径是否正确（`/webhooks/app`）
   > - Token 和 EncodingAESKey 是否已正确配置到插件
   > - 防火墙是否放行了企业微信服务器 IP 段
6. 获取企业 CorpID：
   - 进入「我的企业」页面
   - 复制页面底部的「企业ID」
7. 配置应用可见范围（确保需要使用 AI 助手的成员在可见范围内）

### 方式三：配置群机器人 (Webhook 模式)

Webhook Bot 用于向群聊发送通知消息。

> 📖 **官方文档**：[企业微信群机器人开发指南](https://developer.work.weixin.qq.com/document/path/99110)

**创建步骤：**

1. 在手机或电脑端打开目标群聊
2. 点击群聊右上角「···」→「群机器人」→「添加机器人」
3. 选择「新建机器人」，填写机器人名称
4. 复制 Webhook 地址（格式：`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx`）
5. 将 Webhook 地址配置到 `openclaw.json` 的 `webhooks` 中

**注意事项：**
- Webhook Bot 仅支持发送消息，不支持接收消息
- 每个群聊可添加多个机器人
- Webhook 地址请妥善保管，避免泄露

## 支持的消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| 文本 (text) | 收/发 | 纯文本消息 |
| 图片 (image) | 收/发 | 入站图片自动解密；出站通过 `msg_item` base64 发送 |
| 语音 (voice) | 收 | 企业微信自动转文字后处理（仅限私聊） |
| 图文混排 (mixed) | 收 | 文本 + 图片混合消息 |
| 文件 (file) | 收 | 文件附件（下载后传给 AI 分析） |
| 位置 (location) | 收 | 位置分享（转换为文本描述） |
| 链接 (link) | 收 | 分享链接（提取标题、描述、URL 为文本） |

## 管理员用户

管理员用户可以绕过指令白名单限制，并跳过动态 Agent 路由（直接路由到主 Agent）。

```json
{
  "channels": {
    "wecom": {
      "adminUsers": ["user1", "user2"]
    }
  }
}
```

管理员用户 ID 不区分大小写，匹配企业微信的 `userid` 字段。

## 动态 Agent 路由

本插件实现"按人/按群隔离"的 Agent 管理：

### 工作原理

1. 企业微信消息到达后，插件生成确定性的 `agentId`：
   - **私聊**: `wecom-dm-<userId>`
   - **群聊**: `wecom-group-<chatId>`
2. OpenClaw 自动创建/复用对应的 Agent 工作区
3. 每个用户/群聊拥有独立的对话历史和上下文
4. **管理员用户**跳过动态路由，直接使用主 Agent

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

### 工作区模板

可以为动态创建的 Agent 工作区预置初始化文件。当新 Agent 首次创建时，会自动从模板目录复制 bootstrap 文件。

```json
{
  "channels": {
    "wecom": {
      "workspaceTemplate": "/path/to/template-dir"
    }
  }
}
```

**支持的模板文件：**
- `AGENTS.md` - Agent 列表配置
- `BOOTSTRAP.md` - 初始化引导文档
- `CLAUDE.md` - Claude Code 指令集
- 其他自定义文件

模板目录中的文件会复制到动态 Agent 的工作区（`~/.openclaw/workspace-<agentId>/`），仅当目标文件不存在时才会复制。

## 支持的目标格式

插件支持多种目标格式，用于消息路由和 Webhook 发送：

| 格式 | 示例 | 说明 |
|------|------|------|
| `webhook:<name>` | `webhook:ops-group` | 发送到配置的 Webhook 群 |
| `wecom:<userId>` | `wecom:zhangsan` | 企业微信用户 ID |
| `party:<id>` | `party:2` | 部门 ID（数字） |
| `tag:<name>` | `tag:Developers` | 标签名称 |
| `group:<chatId>` | `group:wr123456` | 群聊 ID |
| `chatId` | `wr123456` | 以 `wr` 或 `wc` 开头的群聊 ID |

### 使用示例

通过 OpenClaw 向企业微信发送消息时，可以使用上述格式指定目标：

```bash
# 发送给指定用户
openclaw send "wecom:zhangsan" "Hello!"

# 发送到 Webhook 群
openclaw send "webhook:dev-group" "部署成功！"

# 发送给部门
openclaw send "party:2" "全体员工通知"
```

## 指令白名单

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
| `/new` | 重置当前对话，开启全新会话 | 用户级 |
| `/compact` | 压缩当前会话上下文 | 用户级 |
| `/help` | 查看帮助信息 | 用户级 |
| `/status` | 查看当前 Agent 状态 | 用户级 |

> **安全提示**：不要将 `/gateway`、`/plugins` 等管理指令添加到白名单，避免普通用户获得 Gateway 实例的管理权限。配置在 `adminUsers` 中的管理员不受此限制。

## 消息防抖合并

当用户在短时间内（2 秒内）连续发送多条消息时，插件会自动将它们合并为一次 AI 请求。这样可以避免同一用户触发多个并发的 LLM 调用，提供更连贯的回复。

- 第一条消息的流式通道接收 AI 回复
- 后续被合并的消息会显示已合并的提示
- 指令消息（以 `/` 开头）不参与防抖，会立即处理

## 常见问题 (FAQ)

### Q: 回调报错 `Unexpected token '<', "..." is not valid JSON` 怎么办？

**A:** 这是企业微信机器人**创建模式**选错导致的。企业微信提供两种机器人创建方式：

- **标准模式**：回调消息为 **XML 格式**，本插件不支持
- **API 模式**：回调消息为 **JSON 格式**，本插件所需

**解决方法**：删除当前机器人，重新创建时在页面底部选择 **"API 模式创建"**。

### Q: 入站图片是怎么处理的？

**A:** 企业微信使用 AES-256-CBC 加密用户发送的图片。插件会自动：
1. 从企业微信的 URL 下载加密图片
2. 使用配置的 `encodingAesKey` 解密
3. 保存到本地并传给 AI 进行视觉分析

图文混排消息也完全支持——文本和图片会一起提取并发送给 AI。

### Q: 出站图片发送是如何工作的？

**A:** 插件会自动处理 OpenClaw 生成的图片（如浏览器截图）：

- **本地图片**（来自 `~/.openclaw/media/`）会自动进行 base64 编码，通过企业微信 `msg_item` API 发送
- **图片限制**：单张图片最大 2MB，支持 JPG 和 PNG 格式，每条消息最多 10 张图片
- **无需配置**：开箱即用，配合浏览器截图等工具自动生效
- 图片会在 AI 完成回复后显示（流式输出不支持增量发送图片）

如果图片处理失败（超出大小限制、格式不支持等），文本回复仍会正常发送，错误信息会记录在日志中。

### Q: 机器人支持语音消息吗？

**A:** 支持！私聊中的语音消息会被企业微信自动转录为文字并作为文本处理，无需额外配置。

### Q: 机器人支持文件消息吗？

**A:** 支持。用户发送的文件会被下载并作为附件传给 AI。AI 可以分析文件内容（如读取 PDF 或解析代码文件）。MIME 类型根据文件扩展名自动检测。

### Q: 如何配置自建应用 (Agent) 模式？

**A:** Agent 模式提供更强大的消息收发能力，包括主动推送消息和接收 XML 格式回调。

**配置步骤：**

1. 在企业微信管理后台创建"自建应用"
2. 获取应用凭证：
   - `corpId`: 企业 ID（在"我的企业"页面）
   - `agentId`: 应用 ID
   - `corpSecret`: 应用 Secret
3. 设置接收消息：
   - 获取 `token` 和 `encodingAesKey`（随机生成）
   - 回调 URL: `https://your-domain.com/webhooks/app`

4. 在 `openclaw.json` 中添加 Agent 配置：
   ```json
   {
     "channels": {
       "wecom": {
         "agent": {
           "corpId": "wwxxxxxxxxxxxxxxxx",
           "corpSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
           "agentId": 1000002,
           "token": "your_callback_token",
           "encodingAesKey": "your_43_char_encoding_aes_key"
         }
       }
     }
   }
   ```

**Agent 模式与 Bot 模式的区别：**

| 特性 | Bot 模式 | Agent 模式 |
|------|----------|------------|
| 创建方式 | 智能机器人 | 自建应用 |
| 回调格式 | JSON | XML |
| 主动推送 | 不支持 | 支持 |
| 媒体下载 | 不支持 | 支持 |
| 文件消息 | 不支持 | 支持 |

### Q: 如何使用 Webhook Bot 发送群通知？

**A:** Webhook Bot 适用于向群聊发送通知消息。

**配置步骤：**

1. 在企业微信群聊中添加"群机器人"
2. 复制 Webhook URL（包含 key 参数）
3. 在配置中添加 webhook 映射：
   ```json
   {
     "channels": {
       "wecom": {
         "webhooks": {
           "ops-group": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
           "dev-group": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=yyy"
         }
       }
     }
   }
   ```

4. 使用 `webhook:` 前缀作为目标：
   - 文本：`webhook:ops-group`
   - 支持 Markdown、图片、文件等多种消息类型

### Q: 四层消息投递回退是如何工作的？

**A:** 插件采用四层回退机制确保消息可靠送达：

| 层级 | 条件 | 说明 |
|------|------|------|
| **Layer 1** | 活跃流式通道 | 正常对话时，消息通过流式通道实时推送 |
| **Layer 2** | response_url | 流式通道关闭后 1 小时内，可通过 response_url 发送 |
| **Layer 3a** | Webhook Bot | 目标以 `webhook:` 开头时，使用 Webhook 发送 |
| **Layer 3b** | Agent API | 配置了 Agent 时，通过自建应用 API 主动推送 |

当上一层级不可用时，自动回退到下一层级。这种设计确保了即使在流式通道关闭的情况下，AI 生成的异步消息（如定时任务、子 Agent 输出）仍能送达。

### Q: OpenClaw 开放公网需要 auth token，企业微信回调如何配置？

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
         "encodingAesKey": "..."
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

## 项目结构

```
openclaw-plugin-wecom/
├── index.js                 # 插件入口
├── package.json             # npm 包配置
├── openclaw.plugin.json     # OpenClaw 插件清单
├── crypto.js                # 企业微信加密算法（消息 + 媒体）
├── logger.js                # 日志模块
├── utils.js                 # 工具函数（TTL 缓存、消息去重）
├── stream-manager.js        # 流式回复管理
├── image-processor.js       # 图片编码/校验（msg_item）
├── webhook.js               # 企业微信 Bot 模式 HTTP 通信处理
├── dynamic-agent.js         # 动态 Agent 分配逻辑
├── wecom/                   # 核心模块目录
│   ├── channel-plugin.js    # 主频道插件逻辑
│   ├── http-handler.js      # HTTP 请求处理器
│   ├── agent-api.js         # Agent API 客户端（AccessToken 缓存、消息发送）
│   ├── agent-inbound.js     # Agent 模式入站处理器（XML 回调）
│   ├── webhook-bot.js       # Webhook Bot 客户端
│   ├── inbound-processor.js # 入站消息处理器
│   ├── xml-parser.js        # XML 解析器（Agent 模式）
│   ├── target.js            # 目标解析器（支持多种目标格式）
│   ├── commands.js          # 命令处理
│   ├── constants.js         # 常量定义
│   ├── state.js             # 状态管理
│   ├── stream-utils.js      # 流式处理工具
│   ├── response-url.js      # response_url 处理
│   ├── allow-from.js        # 权限控制
│   ├── media.js             # 媒体文件处理
│   ├── webhook-targets.js   # Webhook 目标管理
│   └── workspace-template.js # 工作区模板
├── tests/                   # 测试目录
│   ├── e2e/
│   │   ├── remote-wecom.e2e.test.js # 真实远程 E2E（加密请求 + stream 轮询）
│   │   └── run-ali-ai.sh    # ssh ali-ai 一键联调脚本
│   │   ├── prepare-browser-sandbox.sh # browser sandbox 环境检查/准备
│   │   └── collect-browser-pdf.sh # 收集并下载 PDF 测试产物
│   ├── outbound.test.js     # 出站投递回退逻辑测试
│   ├── target.test.js       # 目标解析器测试
│   └── xml-parser.test.js   # XML 解析器测试
├── README.md                # 本文档
├── CONTRIBUTING.md          # 贡献指南
└── LICENSE                  # 开源协议
```

## 贡献规范

我们非常欢迎开发者参与贡献！如果你发现了 Bug 或有更好的功能建议，请提交 Issue 或 Pull Request。

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)

## 开源协议

本项目采用 [ISC License](./LICENSE) 协议。

## 配置示例参考

以下是一个生产环境的脱敏配置示例，供参考：

```json
{
  "meta": {
    "lastTouchedVersion": "2026.2.25",
    "lastTouchedAt": "2026-02-28T03:14:11.564Z"
  },
  "wizard": {
    "lastRunAt": "2026-02-26T09:29:04.028Z",
    "lastRunVersion": "2026.2.25",
    "lastRunCommand": "onboard",
    "lastRunMode": "local"
  },
  "logging": {
    "level": "info",
    "consoleLevel": "debug",
    "consoleStyle": "pretty"
  },
  "models": {
    "mode": "merge",
    "providers": {
      "bailian": {
        "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
        "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxx",
        "api": "openai-completions",
        "models": [
          { "id": "qwen3.5-plus", "name": "qwen3.5-plus", "reasoning": false, "input": ["text", "image"], "contextWindow": 1000000, "maxTokens": 65536 },
          { "id": "MiniMax-M2.5", "name": "MiniMax-M2.5", "reasoning": false, "input": ["text"], "contextWindow": 1000000, "maxTokens": 65536 },
          { "id": "glm-5", "name": "glm-5", "reasoning": false, "input": ["text"], "contextWindow": 202752, "maxTokens": 16384 },
          { "id": "glm-4.7", "name": "glm-4.7", "reasoning": false, "input": ["text"], "contextWindow": 202752, "maxTokens": 16384 },
          { "id": "kimi-k2.5", "name": "kimi-k2.5", "reasoning": false, "input": ["text", "image"], "contextWindow": 262144, "maxTokens": 32768 }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "bailian/kimi-k2.5" },
      "models": {
        "bailian/qwen3.5-plus": {},
        "bailian/MiniMax-M2.5": {},
        "bailian/glm-5": {},
        "bailian/glm-4.7": {},
        "bailian/kimi-k2.5": {}
      },
      "workspace": "/path/to/workspace",
      "userTimezone": "Asia/Shanghai",
      "timeFormat": "24",
      "compaction": {
        "mode": "safeguard",
        "reserveTokensFloor": 20000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000
        }
      },
      "thinkingDefault": "medium",
      "verboseDefault": "on",
      "heartbeat": {
        "every": "10m",
        "target": "last",
        "directPolicy": "allow"
      },
      "sandbox": {
        "mode": "all",
        "workspaceAccess": "rw",
        "scope": "agent",
        "docker": {
          "image": "your-registry.com/openclaw-agent:v2026.x.x",
          "readOnlyRoot": false,
          "network": "bridge",
          "extraHosts": [
            "your-domain.internal:xxx.xxx.xxx.xxx"
          ],
          "binds": [
            "/path/to/skills:/workspace/skills:ro"
          ],
          "dangerouslyAllowReservedContainerTargets": true,
          "dangerouslyAllowExternalBindSources": true
        },
        "prune": {
          "idleHours": 87600,
          "maxAgeDays": 3650
        }
      }
    },
    "list": [
      { "id": "main" },
      { "id": "wecom-dm-xxxxxx" }
    ]
  },
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true,
    "ownerDisplay": "raw"
  },
  "session": {
    "dmScope": "per-channel-peer"
  },
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "boot-md": { "enabled": true },
        "command-logger": { "enabled": true },
        "session-memory": { "enabled": true },
        "bootstrap-extra-files": { "enabled": true }
      }
    }
  },
  "channels": {
    "wecom": {
      "enabled": true,
      "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "encodingAesKey": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "commands": {
        "enabled": true,
        "allowlist": ["/help", "/commands", "/status", "/context", "/whoami", "/new", "/compact", "/stop", "/reset", "/usage", "/think", "/thinking", "/t", "/verbose", "/v", "/reasoning", "/reason", "/model", "/models", "/skill"]
      },
      "dynamicAgents": { "enabled": true },
      "dm": { "createAgentOnFirstMessage": true },
      "groupChat": { "enabled": true, "requireMention": true },
      "adminUsers": ["admin_userid"],
      "workspaceTemplate": "/path/to/workspace-template",
      "agent": {
        "corpId": "wwxxxxxxxxxxxxxxxx",
        "corpSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "agentId": 1000002,
        "token": "xxxxxxxxxxxxxxx",
        "encodingAesKey": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "lan",
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "allowInsecureAuth": true
    },
    "auth": {
      "mode": "token",
      "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    },
    "tailscale": {
      "mode": "off",
      "resetOnExit": false
    }
  },
  "skills": {
    "allowBundled": ["_none_"],
    "load": {
      "extraDirs": ["/path/to/skills"],
      "watch": true,
      "watchDebounceMs": 250
    },
    "install": { "nodeManager": "npm" }
  },
  "plugins": {
    "allow": ["wecom"],
    "entries": { "wecom": { "enabled": true } }
  }
}
```

## 自定义 Skills 配合沙箱使用实践

OpenClaw 支持自定义 Skills 并通过沙箱（Docker）隔离执行，以下是生产环境的实践配置：


### 沙箱配置关键点

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "workspaceAccess": "rw",
        "scope": "agent",
        "docker": {
          "image": "your-registry.com/openclaw-agent:v2026.x.x",
          "readOnlyRoot": false,
          "network": "bridge",
          "extraHosts": [
            "your-domain.internal:xxx.xxx.xxx.xxx"
          ],
          "binds": [
            "/path/to/skills:/workspace/skills:ro"
          ],
          "dangerouslyAllowReservedContainerTargets": true,
          "dangerouslyAllowExternalBindSources": true
        },
        "prune": {
          "idleHours": 87600,
          "maxAgeDays": 3650
        }
      }
    }
  },
  "skills": {
    "allowBundled": ["_none_"],
    "load": {
      "extraDirs": ["/path/to/skills"],
      "watch": true,
      "watchDebounceMs": 250
    }
  }
}
```

### 配置说明

| 配置项 | 说明 |
|--------|------|
| `sandbox.mode` | 沙箱模式：`all` 所有操作都走沙箱 |
| `sandbox.workspaceAccess` | 工作区访问权限：`rw` 读写 |
| `sandbox.scope` | 沙箱作用域：`agent` 每个 Agent 独立沙箱 |
| `sandbox.docker.image` | 沙箱使用的 Docker 镜像 |
| `sandbox.docker.readOnlyRoot` | 是否只读根文件系统 |
| `sandbox.docker.network` | 网络模式：`bridge` 桥接网络 |
| `sandbox.docker.binds` | 挂载目录：将宿主机 skills 目录映射到沙箱内 `/workspace/skills`（只读） |
| `sandbox.docker.extraHosts` | 添加额外 hosts，解决内网服务域名解析 |
| `sandbox.docker.dangerouslyAllowReservedContainerTargets` | 允许容器访问保留目标 |
| `sandbox.docker.dangerouslyAllowExternalBindSources` | 允许外部绑定源 |
| `sandbox.prune.idleHours` | 空闲容器清理时间（小时） |
| `sandbox.prune.maxAgeDays` | 容器最大存活天数 |
| `skills.allowBundled` | 允许的内置 skills（`["_none_"]` 表示禁用所有内置） |
| `skills.load.extraDirs` | 自定义 skills 加载目录 |
| `skills.load.watch` | 启用热加载，修改 skill 无需重启 |
| `skills.load.watchDebounceMs` | 热加载防抖时间（毫秒） |

### 使用流程

1. 在宿主机创建自定义 skill 目录
2. 配置 `binds` 将目录映射到沙箱
3. 在 `skills.load.extraDirs` 指定加载路径
4. Agent 在沙箱中可通过 `/workspace/skills` 访问自定义 skills
5. 使用 `/skill` 命令查看和管理 skills
