import { join } from "node:path";

export const CHANNEL_ID = "wecom";
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_WEBSOCKET_URL = "wss://openws.work.weixin.qq.com";
export const DEFAULT_WS_URL = DEFAULT_WEBSOCKET_URL;

export const THINKING_MESSAGE = "<think></think>";
export const MEDIA_IMAGE_PLACEHOLDER = "<media:image>";
export const MEDIA_DOCUMENT_PLACEHOLDER = "<media:document>";

export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
export const FILE_DOWNLOAD_TIMEOUT_MS = 60_000;
export const REPLY_SEND_TIMEOUT_MS = 15_000;
export const MESSAGE_PROCESS_TIMEOUT_MS = 5 * 60 * 1000;
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
export const WS_MAX_RECONNECT_ATTEMPTS = 100;

export const MESSAGE_STATE_TTL_MS = 10 * 60 * 1000;
export const MESSAGE_STATE_CLEANUP_INTERVAL_MS = 60_000;
export const MESSAGE_STATE_MAX_SIZE = 500;
export const REQID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REQID_MAX_SIZE = 200;
export const REQID_FLUSH_DEBOUNCE_MS = 1_000;

export const PENDING_REPLY_TTL_MS = 5 * 60 * 1000;
export const PENDING_REPLY_MAX_SIZE = 50;

export const DEFAULT_MEDIA_MAX_MB = 5;
export const TEXT_CHUNK_LIMIT = 4000;
export const DEFAULT_WELCOME_MESSAGES = [
  [
    "新的一天，元气满满！🌞",
    "",
    "你可以通过斜杠指令管理会话：",
    "/new 新建对话",
    "/compact 压缩对话",
    "/help 帮助",
    "/status 查看状态",
    "/reasoning stream 打开思考动画",
  ].join("\n"),
  [
    "终于唤醒我啦，我已经准备就绪！😄",
    "",
    "试试这些常用指令：",
    "/new 新建对话",
    "/compact 压缩对话",
    "/help 帮助",
    "/status 查看状态",
    "/reasoning stream 打开思考动画",
  ].join("\n"),
  [
    "欢迎回来，准备开始今天的工作吧！✨",
    "",
    "会话管理指令：",
    "/new 新建对话",
    "/compact 压缩对话",
    "/help 帮助",
    "/status 查看状态",
    "/reasoning stream 打开思考动画",
  ].join("\n"),
  [
    "嗨，我已经在线！🤖",
    "",
    "你可以先试试这些命令：",
    "/new 新建对话",
    "/compact 压缩对话",
    "/help 帮助",
    "/status 查看状态",
    "/reasoning stream 打开思考动画",
  ].join("\n"),
  [
    "今天也一起高效开工吧！🚀",
    "",
    "先来看看这些指令：",
    "/new 新建对话",
    "/compact 压缩对话",
    "/help 帮助",
    "/status 查看状态",
    "/reasoning stream 打开思考动画",
  ].join("\n"),
  [
    "叮咚，你的数字助手已就位！🎉",
    "",
    "常用操作给你备好了：",
    "/new 新建对话",
    "/compact 压缩对话",
    "/help 帮助",
    "/status 查看状态",
    "/reasoning stream 打开思考动画",
  ].join("\n"),
  [
    "灵感加载完成，随时可以开聊！💡",
    "",
    "你可以这样开始：",
    "/new 新建对话",
    "/compact 压缩对话",
    "/help 帮助",
    "/status 查看状态",
    "/reasoning stream 打开思考动画",
  ].join("\n"),
];
export const DEFAULT_WELCOME_MESSAGE = DEFAULT_WELCOME_MESSAGES[0];

export const MEDIA_CACHE_DIR = join(process.env.HOME || "/tmp", ".openclaw", "media", "wecom");

export const DEFAULT_COMMAND_ALLOWLIST = ["/new", "/compact", "/help", "/status"];
export const HIGH_PRIORITY_COMMANDS = new Set(["/stop", "/new"]);
export const DEFAULT_COMMAND_BLOCK_MESSAGE = `⚠️ 该命令不可用。

支持的命令：
• **/new** - 新建会话
• **/compact** - 压缩会话
• **/help** - 查看帮助
• **/status** - 查看状态`;

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

const DEFAULT_API_BASE = "https://qyapi.weixin.qq.com";
let apiBaseUrl = DEFAULT_API_BASE;

export function setApiBaseUrl(url) {
  const trimmed = String(url ?? "").trim().replace(/\/+$/, "");
  apiBaseUrl = trimmed || DEFAULT_API_BASE;
}

function resolveApiBaseUrl() {
  const env = String(process.env.WECOM_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return env || apiBaseUrl;
}

export const AGENT_API_ENDPOINTS = {
  get GET_TOKEN() {
    return `${resolveApiBaseUrl()}/cgi-bin/gettoken`;
  },
  get SEND_MESSAGE() {
    return `${resolveApiBaseUrl()}/cgi-bin/message/send`;
  },
  get SEND_APPCHAT() {
    return `${resolveApiBaseUrl()}/cgi-bin/appchat/send`;
  },
  get UPLOAD_MEDIA() {
    return `${resolveApiBaseUrl()}/cgi-bin/media/upload`;
  },
  get DOWNLOAD_MEDIA() {
    return `${resolveApiBaseUrl()}/cgi-bin/media/get`;
  },
};

export const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
export const AGENT_API_REQUEST_TIMEOUT_MS = 15 * 1000;
export const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

// Callback (self-built app HTTP inbound) constants
export const CALLBACK_INBOUND_MAX_BODY_BYTES = 1 * 1024 * 1024;
export const CALLBACK_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
export const CALLBACK_TIMESTAMP_TOLERANCE_S = 300;

export function getWebhookBotSendUrl() {
  return `${resolveApiBaseUrl()}/cgi-bin/webhook/send`;
}

export function getWebhookBotUploadUrl() {
  return `${resolveApiBaseUrl()}/cgi-bin/webhook/upload_media`;
}
