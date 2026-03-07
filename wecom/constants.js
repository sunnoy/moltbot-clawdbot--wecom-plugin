import { join } from "node:path";

export const DEFAULT_ACCOUNT_ID = "default";

// Placeholder shown while the LLM is processing or the message is queued.
export const THINKING_PLACEHOLDER = "思考中...";

// Image cache directory.
export const MEDIA_CACHE_DIR = join(process.env.HOME || "/tmp", ".openclaw", "media", "wecom");

// Slash commands that are allowed by default.
export const DEFAULT_COMMAND_ALLOWLIST = ["/new", "/compact", "/help", "/status"];
export const HIGH_PRIORITY_COMMANDS = new Set(["/stop", "/new"]);

// Default message shown when a command is blocked.
export const DEFAULT_COMMAND_BLOCK_MESSAGE = `⚠️ 该命令不可用。

支持的命令：
• **/new** - 新建会话
• **/compact** - 压缩会话（保留上下文摘要）
• **/help** - 查看帮助
• **/status** - 查看状态`;

// Files recognised by openclaw core as bootstrap files.
export const BOOTSTRAP_FILENAMES = new Set([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "system-prompt.md",
]);

// Per-user message debounce buffer.
// Collects messages arriving within DEBOUNCE_MS into a single dispatch.
export const DEBOUNCE_MS = 2000;

export const MAIN_RESPONSE_IDLE_CLOSE_MS = 30 * 1000;
export const SAFETY_NET_IDLE_CLOSE_MS = 90 * 1000;
export const RESPONSE_URL_ERROR_BODY_PREVIEW_MAX = 300;

// Default Agent API base URL (self-built application mode).
// Can be overridden via `channels.wecom.network.apiBaseUrl` config or
// `WECOM_API_BASE_URL` env var for users behind a reverse-proxy gateway
// that relays requests to qyapi.weixin.qq.com (issue #79).
const DEFAULT_API_BASE = "https://qyapi.weixin.qq.com";

let _apiBase = DEFAULT_API_BASE;

/**
 * Set the API base URL from plugin config (called during plugin load).
 * @param {string} url
 */
export function setApiBaseUrl(url) {
  const trimmed = (url || "").trim().replace(/\/+$/, "");
  _apiBase = trimmed || DEFAULT_API_BASE;
}

function apiBase() {
  // Env var takes precedence over config.
  const env = (process.env.WECOM_API_BASE_URL || "").trim().replace(/\/+$/, "");
  return env || _apiBase;
}

// Agent API endpoints (self-built application mode).
export const AGENT_API_ENDPOINTS = {
  get GET_TOKEN() { return `${apiBase()}/cgi-bin/gettoken`; },
  get SEND_MESSAGE() { return `${apiBase()}/cgi-bin/message/send`; },
  get SEND_APPCHAT() { return `${apiBase()}/cgi-bin/appchat/send`; },
  get UPLOAD_MEDIA() { return `${apiBase()}/cgi-bin/media/upload`; },
  get DOWNLOAD_MEDIA() { return `${apiBase()}/cgi-bin/media/get`; },
};

export const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
export const AGENT_API_REQUEST_TIMEOUT_MS = 15 * 1000;
export const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1 MB

// Webhook Bot endpoints (group robot notifications).
export const WEBHOOK_BOT_SEND_URL_DEFAULT = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send";
export const WEBHOOK_BOT_UPLOAD_URL_DEFAULT = "https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media";

// Dynamic getters so apiBaseUrl override applies to webhook bot too.
export function getWebhookBotSendUrl() {
  return `${apiBase()}/cgi-bin/webhook/send`;
}
export function getWebhookBotUploadUrl() {
  return `${apiBase()}/cgi-bin/webhook/upload_media`;
}
