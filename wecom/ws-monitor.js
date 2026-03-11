import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WSClient, generateReqId } from "@wecom/aibot-node-sdk";
import { agentSendMedia, agentSendText, agentUploadMedia } from "./agent-api.js";
import { prepareImageBufferForMsgItem } from "../image-processor.js";
import { logger } from "../logger.js";
import { normalizeThinkingTags } from "../think-parser.js";
import { MessageDeduplicator } from "../utils.js";
import {
  extractGroupMessageContent,
  generateAgentId,
  getDynamicAgentConfig,
  shouldTriggerGroupResponse,
  shouldUseDynamicAgent,
} from "../dynamic-agent.js";
import { resolveWecomCommandAuthorized } from "./allow-from.js";
import { checkCommandAllowlist, getCommandConfig, isWecomAdmin } from "./commands.js";
import {
  CHANNEL_ID,
  DEFAULT_MEDIA_MAX_MB,
  DEFAULT_WELCOME_MESSAGE,
  FILE_DOWNLOAD_TIMEOUT_MS,
  IMAGE_DOWNLOAD_TIMEOUT_MS,
  MEDIA_DOCUMENT_PLACEHOLDER,
  MEDIA_IMAGE_PLACEHOLDER,
  MESSAGE_PROCESS_TIMEOUT_MS,
  REPLY_SEND_TIMEOUT_MS,
  THINKING_MESSAGE,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_MAX_RECONNECT_ATTEMPTS,
  setApiBaseUrl,
} from "./constants.js";
import { setConfigProxyUrl } from "./http.js";
import { checkDmPolicy } from "./dm-policy.js";
import { checkGroupPolicy } from "./group-policy.js";
import {
  clearAccountDisplaced,
  forecastActiveSendQuota,
  forecastReplyQuota,
  markAccountDisplaced,
  recordActiveSend,
  recordInboundMessage,
  recordOutboundActivity,
  recordPassiveReply,
} from "./runtime-telemetry.js";
import { dispatchLocks, getRuntime, setOpenclawConfig, streamContext } from "./state.js";
import {
  cleanupWsAccount,
  deleteMessageState,
  drainPendingReplies,
  enqueuePendingReply,
  getWsClient,
  hasPendingReplies,
  setMessageState,
  setWsClient,
  startMessageStateCleanup,
} from "./ws-state.js";
import { ensureDynamicAgentListed } from "./workspace-template.js";

const DEFAULT_AGENT_ID = "main";
const DEFAULT_STATE_DIRNAME = ".openclaw";
const LEGACY_STATE_DIRNAMES = [".clawdbot", ".moldbot", ".moltbot"];
const MAX_REPLY_MSG_ITEMS = 10;
const MAX_REPLY_IMAGE_BYTES = 10 * 1024 * 1024;
const REASONING_STREAM_THROTTLE_MS = 800;
const VISIBLE_STREAM_THROTTLE_MS = 800;
// Reserve headroom below the SDK's per-reqId queue limit (100) so the final
// reply always has room.
const MAX_INTERMEDIATE_STREAM_MESSAGES = 85;
// Match MEDIA:/FILE: directives at line start, optionally preceded by markdown list markers.
const REPLY_MEDIA_DIRECTIVE_PATTERN = /^\s*(?:[-*•]\s+|\d+\.\s+)?(?:MEDIA|FILE)\s*:/im;
const WECOM_REPLY_MEDIA_GUIDANCE_HEADER = "[WeCom reply media rule]";
const inboundMessageDeduplicator = new MessageDeduplicator();

function withTimeout(promise, timeoutMs, message) {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message ?? `Timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  // Suppress unhandled rejection from the original promise if the timeout wins
  // the race. Without this, a later rejection from the underlying SDK call
  // becomes an unhandled promise rejection.
  promise.catch(() => {});

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function normalizeReasoningStreamText(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    return "";
  }

  const withoutPrefix = source.replace(/^Reasoning:\s*/i, "").trim();
  if (!withoutPrefix) {
    return "";
  }

  const lines = withoutPrefix
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([_*~`])(.*)\1$/);
      return match ? match[2].trim() : line;
    })
    .filter(Boolean);

  return lines.join("\n").trim();
}

function buildWsStreamContent({ reasoningText = "", visibleText = "", finish = false }) {
  const normalizedReasoning = String(reasoningText ?? "").trim();
  const normalizedVisible = String(visibleText ?? "").trim();

  if (!normalizedReasoning) {
    return normalizedVisible;
  }

  const shouldCloseThink = finish || Boolean(normalizedVisible);
  const thinkBlock = shouldCloseThink
    ? `<think>${normalizedReasoning}</think>`
    : `<think>${normalizedReasoning}`;

  return normalizedVisible ? `${thinkBlock}\n${normalizedVisible}` : thinkBlock;
}

function createSdkLogger(accountId) {
  return {
    debug: (message, ...args) => logger.debug(`[WS:${accountId}] ${message}`, ...args),
    info: (message, ...args) => logger.info(`[WS:${accountId}] ${message}`, ...args),
    warn: (message, ...args) => logger.warn(`[WS:${accountId}] ${message}`, ...args),
    error: (message, ...args) => logger.error(`[WS:${accountId}] ${message}`, ...args),
  };
}

function getRegisteredRuntimeOrNull() {
  try {
    return getRuntime();
  } catch {
    return null;
  }
}

function resolveChannelCore(runtime) {
  const registeredRuntime = getRegisteredRuntimeOrNull();
  const candidates = [runtime?.channel, runtime, registeredRuntime?.channel, registeredRuntime];

  for (const candidate of candidates) {
    if (candidate?.routing && candidate?.reply && candidate?.session) {
      return candidate;
    }
  }

  throw new Error("OpenClaw channel runtime is unavailable");
}

function resolveMediaRuntime(runtime) {
  const registeredRuntime = getRegisteredRuntimeOrNull();
  const candidates = [runtime, registeredRuntime];

  for (const candidate of candidates) {
    if (typeof candidate?.media?.loadWebMedia === "function") {
      return candidate;
    }
  }

  throw new Error("OpenClaw media runtime is unavailable");
}

function resolveUserPath(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("~")) {
    const homeDir = process.env.OPENCLAW_HOME?.trim() || process.env.HOME || os.homedir();
    return path.resolve(homeDir, trimmed.slice(1).replace(/^\/+/, ""));
  }
  return path.resolve(trimmed);
}

function resolveStateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }

  const homeDir = process.env.OPENCLAW_HOME?.trim() || process.env.HOME || os.homedir();
  const preferred = path.join(homeDir, DEFAULT_STATE_DIRNAME);
  if (existsSync(preferred)) {
    return preferred;
  }

  for (const legacyName of LEGACY_STATE_DIRNAMES) {
    const candidate = path.join(homeDir, legacyName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return preferred;
}

function normalizeAgentId(agentId) {
  return String(agentId ?? "")
    .trim()
    .toLowerCase() || DEFAULT_AGENT_ID;
}

function resolveDefaultAgentId(config) {
  const list = Array.isArray(config?.agents?.list) ? config.agents.list.filter(Boolean) : [];
  if (list.length === 0) {
    return DEFAULT_AGENT_ID;
  }

  const defaults = list.filter((entry) => entry?.default);
  return normalizeAgentId(defaults[0]?.id ?? list[0]?.id ?? DEFAULT_AGENT_ID);
}

function resolveAgentWorkspaceDir(config, agentId) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const list = Array.isArray(config?.agents?.list) ? config.agents.list.filter(Boolean) : [];
  const agentEntry = list.find((entry) => normalizeAgentId(entry?.id) === normalizedAgentId);
  const configuredWorkspace = String(agentEntry?.workspace ?? "").trim();

  if (configuredWorkspace) {
    return resolveUserPath(configuredWorkspace);
  }

  const stateDir = resolveStateDir();
  if (normalizedAgentId === resolveDefaultAgentId(config)) {
    const defaultWorkspace = String(config?.agents?.defaults?.workspace ?? "").trim();
    return defaultWorkspace ? resolveUserPath(defaultWorkspace) : path.join(stateDir, "workspace");
  }

  return path.join(stateDir, `workspace-${normalizedAgentId}`);
}

function resolveReplyMediaLocalRoots(config, agentId) {
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId || resolveDefaultAgentId(config));
  const browserMediaDir = path.join(resolveStateDir(), "media", "browser");
  return [...new Set([workspaceDir, browserMediaDir].map((entry) => path.resolve(entry)))];
}

function mergeReplyMediaUrls(...lists) {
  const seen = new Set();
  const merged = [];

  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      const normalized = typeof entry === "string" ? entry.trim() : "";
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      merged.push(normalized);
    }
  }

  return merged;
}

function buildReplyMediaGuidance(config, agentId) {
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId || resolveDefaultAgentId(config));
  const browserMediaDir = path.join(resolveStateDir(), "media", "browser");
  return [
    WECOM_REPLY_MEDIA_GUIDANCE_HEADER,
    `Only use FILE:/abs/path or MEDIA:/abs/path for files inside the current workspace: ${workspaceDir}`,
    `Browser-generated files are also allowed only under: ${browserMediaDir}`,
    "Never reference any other host path.",
    "Do NOT call message.send with local file paths. The sandbox will block it.",
    "Instead, in your final reply put each image on its own line as MEDIA:/abs/path",
    "and each non-image file on its own line as FILE:/abs/path.",
    "Each directive MUST be on its own line with no other text on that line.",
    "The plugin will automatically send the media to the user.",
  ].join("\n");
}

function buildBodyForAgent(body, config, agentId) {
  // Guidance is now injected via before_prompt_build hook into system prompt.
  // Keep buildBodyForAgent as a plain passthrough for the user message body.
  return typeof body === "string" && body.length > 0 ? body : "";
}

function splitReplyMediaFromText(text) {
  if (typeof text !== "string" || !REPLY_MEDIA_DIRECTIVE_PATTERN.test(text)) {
    return {
      text: typeof text === "string" ? text : "",
      mediaUrls: [],
    };
  }

  const mediaUrls = [];
  const keptLines = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (!REPLY_MEDIA_DIRECTIVE_PATTERN.test(trimmed)) {
      keptLines.push(line);
      continue;
    }

    // Strip optional markdown list prefix ("- ", "* ", "1. ") then the directive.
    const mediaUrl = trimmed
      .replace(/^(?:[-*•]\s+|\d+\.\s+)?/, "")
      .replace(/^(MEDIA|FILE)\s*:\s*/i, "")
      .trim()
      .replace(/^`(.+)`$/, "$1");
    if (mediaUrl) {
      mediaUrls.push(mediaUrl);
    }
  }

  return {
    text: keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    mediaUrls,
  };
}

function normalizeReplyPayload(payload) {
  const explicitMediaUrls = Array.isArray(payload?.mediaUrls)
    ? payload.mediaUrls.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const explicitMediaUrl = typeof payload?.mediaUrl === "string" && payload.mediaUrl.trim()
    ? [payload.mediaUrl.trim()]
    : [];
  const parsed = splitReplyMediaFromText(payload?.text);

  return {
    text: parsed.text,
    mediaUrls: mergeReplyMediaUrls(explicitMediaUrls, explicitMediaUrl, parsed.mediaUrls),
  };
}

function resolveReplyMediaUrls(payload) {
  return normalizeReplyPayload(payload).mediaUrls;
}

function applyAccountNetworkConfig(account) {
  const network = account?.config?.network ?? {};
  setConfigProxyUrl(network.egressProxyUrl ?? "");
  setApiBaseUrl(network.apiBaseUrl ?? "");
}

function resolveReplyMediaFilename(mediaUrl, loaded) {
  const candidateNames = [
    loaded?.fileName,
    loaded?.filename,
    loaded?.name,
    typeof loaded?.path === "string" ? path.basename(loaded.path) : "",
  ];

  for (const candidate of candidateNames) {
    const normalized = String(candidate ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }

  const normalizedUrl = String(mediaUrl ?? "").trim();
  if (!normalizedUrl) {
    return "attachment";
  }

  if (normalizedUrl.startsWith("/")) {
    return path.basename(normalizedUrl) || "attachment";
  }

  try {
    return path.basename(new URL(normalizedUrl).pathname) || "attachment";
  } catch {
    return path.basename(normalizedUrl) || "attachment";
  }
}

function resolveReplyMediaAgentType(mediaUrl, loaded) {
  const contentType = String(loaded?.contentType ?? "").toLowerCase();
  if (loaded?.kind === "image" || contentType.startsWith("image/")) {
    return "image";
  }
  const filename = resolveReplyMediaFilename(mediaUrl, loaded).toLowerCase();
  if (/\.(jpg|jpeg|png|gif|bmp|webp)$/.test(filename)) {
    return "image";
  }
  return "file";
}

async function prepareReplyMediaOutputs({ payload, runtime, config, agentId, mirrorImagesToAgent = false }) {
  const mediaUrls = resolveReplyMediaUrls(payload);
  if (mediaUrls.length === 0) {
    return { msgItems: [], agentMedia: [], mirroredAgentMedia: [] };
  }

  let mediaRuntime;
  try {
    mediaRuntime = resolveMediaRuntime(runtime);
  } catch (error) {
    logger.error(`[WS] Reply media runtime is unavailable: ${error.message}`);
    return { msgItems: [], agentMedia: [], mirroredAgentMedia: [] };
  }

  const localRoots = resolveReplyMediaLocalRoots(config, agentId);
  const msgItems = [];
  const agentMedia = [];
  const mirroredAgentMedia = [];

  for (const mediaUrl of mediaUrls) {
    try {
      const loaded = await mediaRuntime.media.loadWebMedia(mediaUrl, {
        maxBytes: MAX_REPLY_IMAGE_BYTES,
        localRoots,
      });
      const mediaType = resolveReplyMediaAgentType(mediaUrl, loaded);

      if (mediaType === "image") {
        if (msgItems.length >= MAX_REPLY_MSG_ITEMS) {
          logger.warn(`[WS] Reply contains more than ${MAX_REPLY_MSG_ITEMS} images; extra images were skipped`);
          continue;
        }
        const image = prepareImageBufferForMsgItem(loaded.buffer);
        msgItems.push({
          msgtype: "image",
          image: {
            base64: image.base64,
            md5: image.md5,
          },
        });
        if (mirrorImagesToAgent) {
          mirroredAgentMedia.push({
            mediaUrl,
            mediaType,
            buffer: loaded.buffer,
            filename: resolveReplyMediaFilename(mediaUrl, loaded),
          });
        }
        continue;
      }

      agentMedia.push({
        mediaUrl,
        mediaType,
        buffer: loaded.buffer,
        filename: resolveReplyMediaFilename(mediaUrl, loaded),
      });
    } catch (error) {
      logger.error(`[WS] Failed to prepare reply media ${mediaUrl}: ${error.message}`);
    }
  }

  return { msgItems, agentMedia, mirroredAgentMedia };
}

function buildPassiveMediaAgentTarget({ senderId, chatId, isGroupChat }) {
  return isGroupChat ? { chatId } : { toUser: senderId };
}

function buildPassiveMediaNotice(mediaType, { deliveredViaAgent = true } = {}) {
  if (mediaType === "file") {
    return deliveredViaAgent
      ? "由于当前企业微信bot不支持给用户发送文件，文件通过自建应用发送。"
      : "由于当前企业微信bot不支持给用户发送文件，且当前未配置自建应用发送渠道。";
  }
  if (mediaType === "image") {
    return deliveredViaAgent
      ? "由于当前企业微信bot不支持直接发送图片，图片通过自建应用发送。"
      : "由于当前企业微信bot不支持直接发送图片，且当前未配置自建应用发送渠道。";
  }
  return deliveredViaAgent
    ? "由于当前企业微信bot不支持直接发送媒体，媒体通过自建应用发送。"
    : "由于当前企业微信bot不支持直接发送媒体，且当前未配置自建应用发送渠道。";
}

function buildPassiveMediaNoticeBlock(mediaEntries, { deliveredViaAgent = true } = {}) {
  if (!Array.isArray(mediaEntries) || mediaEntries.length === 0) {
    return "";
  }

  const mediaTypes = [...new Set(mediaEntries.map((entry) => entry.mediaType).filter(Boolean))];
  return mediaTypes
    .map((mediaType) => buildPassiveMediaNotice(mediaType, { deliveredViaAgent }))
    .filter(Boolean)
    .join("\n\n");
}

async function deliverPassiveAgentMedia({
  account,
  senderId,
  chatId,
  isGroupChat,
  text,
  includeText = false,
  includeNotice = true,
  mediaEntries,
}) {
  if (!Array.isArray(mediaEntries) || mediaEntries.length === 0) {
    return;
  }

  if (!account?.agentCredentials) {
    logger.warn("[WS] Agent API is not configured; skipped passive non-image media delivery");
    return;
  }

  applyAccountNetworkConfig(account);

  const target = buildPassiveMediaAgentTarget({ senderId, chatId, isGroupChat });
  const noticeParts = [];
  if (includeText && text) {
    noticeParts.push(text);
  }
  if (includeNotice) {
    const noticeText = buildPassiveMediaNoticeBlock(mediaEntries);
    if (noticeText) {
      noticeParts.push(noticeText);
    }
  }
  if (noticeParts.length > 0) {
    await agentSendText({
      agent: account.agentCredentials,
      ...target,
      text: noticeParts.join("\n\n"),
    });
  }

  for (const entry of mediaEntries) {
    const mediaId = await agentUploadMedia({
      agent: account.agentCredentials,
      type: entry.mediaType,
      buffer: entry.buffer,
      filename: entry.filename,
    });
    await agentSendMedia({
      agent: account.agentCredentials,
      ...target,
      mediaId,
      mediaType: entry.mediaType,
    });
  }
}

function resolveWelcomeMessage(account) {
  const configured = String(account?.config?.welcomeMessage ?? "").trim();
  return configured || DEFAULT_WELCOME_MESSAGE;
}

function collectMixedMessageItems({ mixed, textParts, imageUrls, imageAesKeys }) {
  let hasImage = false;

  if (!Array.isArray(mixed?.msg_item)) {
    return { hasImage };
  }

  for (const item of mixed.msg_item) {
    if (item.msgtype === "text" && item.text?.content) {
      textParts.push(item.text.content);
    } else if (item.msgtype === "image" && item.image?.url) {
      hasImage = true;
      imageUrls.push(item.image.url);
      if (item.image.aeskey) {
        imageAesKeys.set(item.image.url, item.image.aeskey);
      }
    }
  }

  return { hasImage };
}

function parseMessageContent(body) {
  const textParts = [];
  const imageUrls = [];
  const imageAesKeys = new Map();
  const fileUrls = [];
  const fileAesKeys = new Map();
  let quoteContent;

  if (body?.msgtype === "mixed") {
    collectMixedMessageItems({
      mixed: body.mixed,
      textParts,
      imageUrls,
      imageAesKeys,
    });
  } else {
    if (body?.text?.content) {
      textParts.push(body.text.content);
    }
    if (body?.msgtype === "voice" && body?.voice?.content) {
      textParts.push(body.voice.content);
    }
    if (body?.image?.url) {
      imageUrls.push(body.image.url);
      if (body.image.aeskey) {
        imageAesKeys.set(body.image.url, body.image.aeskey);
      }
    }
    if (body?.msgtype === "file" && body?.file?.url) {
      fileUrls.push(body.file.url);
      if (body.file.aeskey) {
        fileAesKeys.set(body.file.url, body.file.aeskey);
      }
    }
  }

  if (body?.quote) {
    if (body.quote.msgtype === "text" && body.quote.text?.content) {
      quoteContent = body.quote.text.content;
    } else if (body.quote.msgtype === "voice" && body.quote.voice?.content) {
      quoteContent = body.quote.voice.content;
    } else if (body.quote.msgtype === "mixed") {
      const quoteTextParts = [];
      const { hasImage } = collectMixedMessageItems({
        mixed: body.quote.mixed,
        textParts: quoteTextParts,
        imageUrls,
        imageAesKeys,
      });
      quoteContent = quoteTextParts.join("\n").trim();
      if (!quoteContent && hasImage) {
        quoteContent = "[引用图文]";
      }
    } else if (body.quote.msgtype === "image" && body.quote.image?.url) {
      imageUrls.push(body.quote.image.url);
      if (body.quote.image.aeskey) {
        imageAesKeys.set(body.quote.image.url, body.quote.image.aeskey);
      }
    } else if (body.quote.msgtype === "file" && body.quote.file?.url) {
      fileUrls.push(body.quote.file.url);
      if (body.quote.file.aeskey) {
        fileAesKeys.set(body.quote.file.url, body.quote.file.aeskey);
      }
    }
  }

  return { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent };
}

async function downloadAndSaveMedia({ wsClient, urls, aesKeys, type, runtime, config }) {
  const core = resolveChannelCore(runtime);
  const timeoutMs = type === "image" ? IMAGE_DOWNLOAD_TIMEOUT_MS : FILE_DOWNLOAD_TIMEOUT_MS;
  const mediaMaxMb = config?.agents?.defaults?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const maxBytes = mediaMaxMb * 1024 * 1024;
  const mediaList = [];

  for (const url of urls) {
    try {
      let buffer;
      let filename;
      let contentType = type === "image" ? "image/jpeg" : "application/octet-stream";

      try {
        const result = await withTimeout(
          wsClient.downloadFile(url, aesKeys?.get(url)),
          timeoutMs,
          `${type} download timed out`,
        );
        buffer = result.buffer;
        filename = result.filename;
      } catch (error) {
        logger.debug(`[WS] SDK ${type} download failed, falling back to core media fetch: ${error.message}`);
        const fetched = await withTimeout(
          core.media.fetchRemoteMedia({ url }),
          timeoutMs,
          `${type} fallback download timed out`,
        );
        buffer = fetched.buffer;
        contentType = fetched.contentType ?? contentType;
      }

      const saved = await core.media.saveMediaBuffer(buffer, contentType, "inbound", maxBytes, filename);
      mediaList.push({ path: saved.path, contentType: saved.contentType });
    } catch (error) {
      logger.error(`[WS] Failed to download ${type}: ${error.message}`);
    }
  }

  return mediaList;
}

async function sendWsReply({ wsClient, frame, text, finish = true, streamId, msgItem, accountId }) {
  const normalizedText = normalizeThinkingTags(typeof text === "string" ? text : "");
  if (!normalizedText && (!Array.isArray(msgItem) || msgItem.length === 0)) {
    return streamId;
  }
  if (!wsClient?.isConnected) {
    throw new Error("WS client is not connected");
  }

  const chatId = frame?.body?.chatid || frame?.body?.from?.userid;
  if (finish && accountId && chatId) {
    const quota = forecastReplyQuota({ accountId, chatId });
    if (quota.windowActive && (quota.nearLimit || quota.exhausted)) {
      logger.warn(`[WS:${accountId}] Reply quota is ${quota.exhausted ? "exhausted" : "near limit"}`, {
        chatId,
        used: quota.used,
        limit: quota.limit,
        remaining: quota.remaining,
      });
    }
  }

  const resolvedStreamId = streamId || generateReqId("stream");

  await withTimeout(
    wsClient.replyStream(frame, resolvedStreamId, normalizedText, finish, msgItem),
    REPLY_SEND_TIMEOUT_MS,
    `Reply timed out (streamId=${resolvedStreamId})`,
  );

  if (finish && accountId && chatId) {
    recordPassiveReply({ accountId, chatId });
  }

  return resolvedStreamId;
}

function resolveOutboundChatId(to) {
  return String(to ?? "")
    .trim()
    .replace(/^wecom:/i, "")
    .replace(/^group:/i, "")
    .replace(/^user:/i, "");
}

export async function sendWsMessage({ to, content, accountId = "default" }) {
  const chatId = resolveOutboundChatId(to);
  const wsClient = getWsClient(accountId);

  if (!chatId) {
    throw new Error("Missing chat target for WeCom WS send");
  }
  if (!wsClient || !wsClient.isConnected) {
    throw new Error(`WS client is not connected for account ${accountId}`);
  }

  const quota = forecastActiveSendQuota({ accountId, chatId });
  if (quota.nearLimit || quota.exhausted) {
    logger.warn(`[WS:${accountId}] Active send quota is ${quota.exhausted ? "exhausted" : "near limit"}`, {
      chatId,
      bucket: quota.bucket,
      used: quota.used,
      limit: quota.limit,
      remaining: quota.remaining,
      replyWindowActive: quota.windowActive ?? false,
    });
  }

  const result = await wsClient.sendMessage(chatId, {
    msgtype: "markdown",
    markdown: { content },
  });

  recordActiveSend({ accountId, chatId });

  return {
    channel: CHANNEL_ID,
    messageId: result?.headers?.req_id ?? `wecom-ws-${Date.now()}`,
    chatId,
  };
}

/**
 * Flush pending replies via the Agent API after WS reconnection.
 * Called when the WS authenticates and there are queued unsent final replies.
 */
async function flushPendingRepliesViaAgentApi(account) {
  const entries = drainPendingReplies(account.accountId);
  if (entries.length === 0) {
    return;
  }

  logger.info(`[WS:${account.accountId}] Flushing ${entries.length} pending replies via Agent API`);
  applyAccountNetworkConfig(account);

  for (const entry of entries) {
    try {
      const target = entry.isGroupChat ? { chatId: entry.chatId } : { toUser: entry.senderId };
      await agentSendText({
        agent: account.agentCredentials,
        ...target,
        text: entry.text,
      });
      recordOutboundActivity({ accountId: account.accountId });
      logger.info(`[WS:${account.accountId}] Pending reply delivered via Agent API`, {
        chatId: entry.chatId,
        senderId: entry.senderId,
        textLength: entry.text.length,
      });
    } catch (sendError) {
      logger.error(`[WS:${account.accountId}] Failed to deliver pending reply via Agent API: ${sendError.message}`, {
        chatId: entry.chatId,
        senderId: entry.senderId,
      });
    }
  }
}

async function sendThinkingReply({ wsClient, frame, streamId }) {
  try {
    await sendWsReply({
      wsClient,
      frame,
      streamId,
      text: THINKING_MESSAGE,
      finish: false,
    });
  } catch (error) {
    logger.error(`[WS] Failed to send thinking reply: ${error.message}`);
  }
}

function buildInboundContext({
  runtime,
  config,
  account,
  frame,
  body,
  text,
  mediaList,
  route,
  senderId,
  chatId,
  isGroupChat,
}) {
  const core = resolveChannelCore(runtime);
  const storePath = core.session.resolveStorePath(config.session?.store, { agentId: route.agentId });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const senderLabel = isGroupChat ? `[${senderId}]` : senderId;
  const hasImages = mediaList.some((entry) => entry.contentType?.startsWith("image/"));
  const messageBody =
    text || (mediaList.length > 0 ? (hasImages ? MEDIA_IMAGE_PLACEHOLDER : MEDIA_DOCUMENT_PLACEHOLDER) : "");
  const formattedBody = core.reply.formatAgentEnvelope({
    channel: isGroupChat ? "Enterprise WeChat Group" : "Enterprise WeChat",
    from: senderLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: messageBody,
  });

  const context = {
    Body: formattedBody || messageBody,
    BodyForAgent: buildBodyForAgent(formattedBody || messageBody, config, route.agentId),
    RawBody: text || messageBody,
    CommandBody: text || messageBody,
    MessageSid: body.msgid,
    From: isGroupChat ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${senderId}`,
    To: isGroupChat ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${senderId}`,
    SenderId: senderId,
    SessionKey: route.sessionKey,
    AccountId: account.accountId,
    ChatType: isGroupChat ? "group" : "direct",
    ConversationLabel: isGroupChat ? `Group ${chatId}` : senderId,
    SenderName: senderId,
    GroupId: isGroupChat ? chatId : undefined,
    Timestamp: Date.now(),
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: isGroupChat ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${senderId}`,
    CommandAuthorized: true,
    ReqId: frame.headers.req_id,
    WeComFrame: frame,
  };

  if (mediaList.length > 0) {
    context.MediaPaths = mediaList.map((entry) => entry.path);
    context.MediaTypes = mediaList.map((entry) => entry.contentType).filter(Boolean);

    if (!text) {
      const imageCount = mediaList.filter((entry) => entry.contentType?.startsWith("image/")).length;
      context.Body =
        imageCount > 1 ? `[用户发送了${imageCount}张图片]` : imageCount === 1 ? "[用户发送了一张图片]" : "[用户发送了文件]";
      context.RawBody = imageCount > 0 ? "[图片]" : "[文件]";
      context.CommandBody = "";
    }
  }

  return { ctxPayload: core.reply.finalizeInboundContext(context), storePath };
}

async function processWsMessage({ frame, account, config, runtime, wsClient }) {
  const core = resolveChannelCore(runtime);
  const body = frame?.body ?? {};
  const senderId = body?.from?.userid;
  const chatId = body?.chatid || senderId;
  const messageId = body?.msgid;
  const reqId = frame?.headers?.req_id;
  const isGroupChat = body?.chattype === "group";

  if (!senderId || !chatId || !messageId || !reqId) {
    logger.warn("[WS] Ignoring malformed frame", {
      hasSender: Boolean(senderId),
      hasChatId: Boolean(chatId),
      hasMessageId: Boolean(messageId),
      hasReqId: Boolean(reqId),
    });
    return;
  }

  const dedupKey = `${account.accountId}:${messageId}`;
  if (inboundMessageDeduplicator.isDuplicate(dedupKey)) {
    logger.debug(`[WS:${account.accountId}] Ignoring duplicate inbound message`, {
      messageId,
      senderId,
      chatId,
    });
    return;
  }

  recordInboundMessage({ accountId: account.accountId, chatId });

  const { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent } = parseMessageContent(body);
  const originalText = textParts.join("\n").trim();
  let text = originalText;

  if (!text && quoteContent) {
    text = quoteContent;
  }

  if (body?.quote && quoteContent && text && quoteContent !== text) {
    const quoteLabel =
      body.quote.msgtype === "image"
        ? "[引用图片]"
        : body.quote.msgtype === "mixed" && quoteContent === "[引用图文]"
          ? "[引用图文]"
          : `> ${quoteContent}`;
    text = `${quoteLabel}\n\n${text}`;
  }

  if (!text && imageUrls.length === 0 && fileUrls.length === 0) {
    logger.debug("[WS] Ignoring empty message", { chatId, senderId, accountId: account.accountId });
    return;
  }

  if (isGroupChat) {
    const groupPolicyResult = checkGroupPolicy({ chatId, senderId, account, config });
    if (!groupPolicyResult.allowed) {
      return;
    }
  }

  const dmPolicyResult = await checkDmPolicy({
    senderId,
    isGroup: isGroupChat,
    account,
    wsClient,
    frame,
    core,
    sendReply: async ({ frame: replyFrame, text: replyText, finish, streamId }) => {
      await sendWsReply({
        wsClient,
        frame: replyFrame,
        text: replyText,
        finish,
        streamId,
        accountId: account.accountId,
      });
    },
  });
  if (!dmPolicyResult.allowed) {
    return;
  }

  if (isGroupChat) {
    if (!shouldTriggerGroupResponse(originalText, account.config)) {
      logger.debug("[WS] Group message ignored because mention gating was not satisfied", {
        accountId: account.accountId,
        chatId,
        senderId,
      });
      return;
    }
    text = extractGroupMessageContent(originalText, account.config);
  }

  const senderIsAdmin = isWecomAdmin(senderId, account.config);
  const commandAuthorized = resolveWecomCommandAuthorized({
    cfg: config,
    accountId: account.accountId,
    senderId,
  });
  const commandCheck = checkCommandAllowlist(text, account.config);
  if (commandCheck.isCommand && !commandCheck.allowed && !senderIsAdmin) {
    await sendWsReply({
      wsClient,
      frame,
      streamId: generateReqId("command"),
      text: getCommandConfig(account.config).blockMessage,
      finish: true,
      accountId: account.accountId,
    });
    return;
  }

  const [imageMediaList, fileMediaList] = await Promise.all([
    downloadAndSaveMedia({
      wsClient,
      urls: imageUrls,
      aesKeys: imageAesKeys,
      type: "image",
      runtime,
      config,
    }),
    downloadAndSaveMedia({
      wsClient,
      urls: fileUrls,
      aesKeys: fileAesKeys,
      type: "file",
      runtime,
      config,
    }),
  ]);
  const mediaList = [...imageMediaList, ...fileMediaList];

  const streamId = generateReqId("stream");
  const state = { accumulatedText: "", reasoningText: "", streamId, replyMediaUrls: [] };
  setMessageState(messageId, state);

  // Throttle reasoning and visible text stream updates to avoid exceeding
  // the SDK's per-reqId reply queue limit (100).
  let streamMessagesSent = 0;
  let lastReasoningSendAt = 0;
  let pendingReasoningTimer = null;
  let lastVisibleSendAt = 0;
  let pendingVisibleTimer = null;

  const canSendIntermediate = () => streamMessagesSent < MAX_INTERMEDIATE_STREAM_MESSAGES;

  const sendReasoningUpdate = async () => {
    if (!canSendIntermediate()) return;
    lastReasoningSendAt = Date.now();
    try {
      streamMessagesSent++;
      await sendWsReply({
        wsClient,
        frame,
        streamId: state.streamId,
        text: buildWsStreamContent({
          reasoningText: state.reasoningText,
          visibleText: state.accumulatedText,
          finish: false,
        }),
        finish: false,
        accountId: account.accountId,
      });
    } catch (error) {
      logger.warn(`[WS] Reasoning stream send failed (non-fatal): ${error.message}`);
    }
  };

  const sendVisibleUpdate = async () => {
    if (!canSendIntermediate()) return;
    lastVisibleSendAt = Date.now();
    try {
      streamMessagesSent++;
      await sendWsReply({
        wsClient,
        frame,
        streamId: state.streamId,
        text: buildWsStreamContent({
          reasoningText: state.reasoningText,
          visibleText: state.accumulatedText,
          finish: false,
        }),
        finish: false,
        accountId: account.accountId,
      });
    } catch (error) {
      logger.warn(`[WS] Visible stream send failed (non-fatal): ${error.message}`);
    }
  };

  const cancelPendingTimers = () => {
    if (pendingReasoningTimer) {
      clearTimeout(pendingReasoningTimer);
      pendingReasoningTimer = null;
    }
    if (pendingVisibleTimer) {
      clearTimeout(pendingVisibleTimer);
      pendingVisibleTimer = null;
    }
  };

  const cleanupState = () => {
    deleteMessageState(messageId);
    cancelPendingTimers();
  };

  if (account.sendThinkingMessage !== false) {
    await sendThinkingReply({ wsClient, frame, streamId });
  }

  const peerKind = isGroupChat ? "group" : "dm";
  const peerId = isGroupChat ? chatId : senderId;
  const dynamicConfig = getDynamicAgentConfig(account.config);
  const dynamicAgentId =
    dynamicConfig.enabled &&
    shouldUseDynamicAgent({ chatType: peerKind, config: account.config, senderIsAdmin })
      ? generateAgentId(peerKind, peerId, account.accountId)
      : null;

  if (dynamicAgentId) {
    await ensureDynamicAgentListed(dynamicAgentId, account.config.workspaceTemplate);
  }

  const route = core.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: peerKind, id: peerId },
  });

  const hasExplicitBinding =
    Array.isArray(config?.bindings) &&
    config.bindings.some(
      (binding) => binding.match?.channel === CHANNEL_ID && binding.match?.accountId === account.accountId,
    );

  if (dynamicAgentId && !hasExplicitBinding) {
    route.agentId = dynamicAgentId;
    route.sessionKey = `agent:${dynamicAgentId}:${peerKind}:${peerId}`;
  }

  const { ctxPayload, storePath } = buildInboundContext({
    runtime,
    config,
    account,
    frame,
    body,
    text,
    mediaList,
    route,
    senderId,
    chatId,
    isGroupChat,
  });
  ctxPayload.CommandAuthorized = commandAuthorized;

  void core.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((error) => logger.error(`[WS] Failed to record session metadata: ${error.message}`));

  const runDispatch = async () => {
    let cleanedUp = false;
    const safeCleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      cleanupState();
    };

    try {
      await streamContext.run(
        { streamId, streamKey: peerId, agentId: route.agentId, accountId: account.accountId },
        async () => {
          await core.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg: config,
            replyOptions: {
              disableBlockStreaming: false,
              onReasoningStream: async (payload) => {
                const nextReasoning = normalizeReasoningStreamText(payload?.text);
                if (!nextReasoning) {
                  return;
                }
                state.reasoningText = nextReasoning;

                // Throttle: skip if sent recently, schedule a trailing update instead.
                const elapsed = Date.now() - lastReasoningSendAt;
                if (elapsed < REASONING_STREAM_THROTTLE_MS) {
                  if (!pendingReasoningTimer) {
                    pendingReasoningTimer = setTimeout(async () => {
                      pendingReasoningTimer = null;
                      await sendReasoningUpdate();
                    }, REASONING_STREAM_THROTTLE_MS - elapsed);
                  }
                  return;
                }
                await sendReasoningUpdate();
              },
            },
            dispatcherOptions: {
              deliver: async (payload, info) => {
                const normalized = normalizeReplyPayload(payload);
                const chunk = normalized.text;
                const mediaUrls = normalized.mediaUrls;
                for (const mediaUrl of mediaUrls) {
                  if (!state.replyMediaUrls.includes(mediaUrl)) {
                    state.replyMediaUrls.push(mediaUrl);
                  }
                }

                state.accumulatedText += chunk;
                if (info.kind !== "final") {
                  // Throttle visible text stream updates to avoid exceeding
                  // the SDK queue limit together with reasoning updates.
                  const elapsed = Date.now() - lastVisibleSendAt;
                  if (elapsed < VISIBLE_STREAM_THROTTLE_MS) {
                    if (!pendingVisibleTimer) {
                      pendingVisibleTimer = setTimeout(async () => {
                        pendingVisibleTimer = null;
                        await sendVisibleUpdate();
                      }, VISIBLE_STREAM_THROTTLE_MS - elapsed);
                    }
                    return;
                  }
                  await sendVisibleUpdate();
                }
              },
              onError: (error, info) => {
                logger.error(`[WS] ${info.kind} reply failed: ${error.message}`);
              },
            },
          });
        },
      );

      // Cancel pending throttled timers before the final reply to prevent
      // non-final updates from being sent after finish=true.
      cancelPendingTimers();

      const preparedReplyMedia = await prepareReplyMediaOutputs({
        payload: { mediaUrls: state.replyMediaUrls },
        runtime,
        config,
        agentId: route.agentId,
        mirrorImagesToAgent: Boolean(account?.agentCredentials),
      });
      const msgItem = preparedReplyMedia.msgItems;
      const deferredMediaDeliveredViaAgent = Boolean(account?.agentCredentials);
      const finalReplyText = buildWsStreamContent({
        reasoningText: state.reasoningText,
        visibleText: state.accumulatedText,
        finish: true,
      });
      const passiveMediaNotice = buildPassiveMediaNoticeBlock(preparedReplyMedia.agentMedia, {
        deliveredViaAgent: deferredMediaDeliveredViaAgent,
      });
      const finalWsText = [finalReplyText, passiveMediaNotice].filter(Boolean).join("\n\n");

      if (preparedReplyMedia.agentMedia.length > 0 && !account?.agentCredentials) {
        logger.warn("[WS] Agent API is not configured; passive non-image media delivery was skipped");
      }

      // If dispatch returned no content at all (e.g. upstream empty_stream),
      // send a fallback so the user isn't left waiting in silence.
      const effectiveFinalText = finalWsText || (msgItem.length === 0 ? "模型暂时无法响应，请稍后重试。" : "");
      if (effectiveFinalText || msgItem.length > 0) {
        logger.info("[WS] Sending passive final reply", {
          accountId: account.accountId,
          agentId: route.agentId,
          streamId: state.streamId,
          textLength: effectiveFinalText.length,
          imageItemCount: msgItem.length,
          deferredAgentMediaCount: preparedReplyMedia.agentMedia.length,
          mirroredAgentImageCount: preparedReplyMedia.mirroredAgentMedia.length,
          emptyStreamFallback: !finalWsText,
        });
        try {
          await sendWsReply({
            wsClient,
            frame,
            streamId: state.streamId,
            text: effectiveFinalText,
            finish: true,
            msgItem,
            accountId: account.accountId,
          });
        } catch (sendError) {
          // WS disconnected or timed out — enqueue for retry via Agent API on reconnect.
          logger.warn(`[WS] Final reply send failed, enqueuing for retry: ${sendError.message}`, {
            accountId: account.accountId,
            chatId,
            senderId,
          });
          enqueuePendingReply(account.accountId, {
            text: effectiveFinalText,
            senderId,
            chatId,
            isGroupChat,
          });
        }
      }

      if (account?.agentCredentials && preparedReplyMedia.mirroredAgentMedia.length > 0) {
        await deliverPassiveAgentMedia({
          account,
          senderId,
          chatId,
          isGroupChat,
          text: state.accumulatedText,
          includeText: false,
          includeNotice: false,
          mediaEntries: preparedReplyMedia.mirroredAgentMedia,
        });
      }

      if (account?.agentCredentials && preparedReplyMedia.agentMedia.length > 0) {
        await deliverPassiveAgentMedia({
          account,
          senderId,
          chatId,
          isGroupChat,
          text: finalWsText,
          includeText: false,
          includeNotice: false,
          mediaEntries: preparedReplyMedia.agentMedia,
        });
      }
      safeCleanup();
    } catch (error) {
      logger.error(`[WS] Failed to dispatch reply: ${error.message}`);
      try {
        await sendWsReply({
          wsClient,
          frame,
          streamId: state.streamId,
          text: "处理消息时出错，请稍后再试。",
          finish: true,
          accountId: account.accountId,
        });
      } catch (retryError) {
        // If the error reply also fails (WS disconnected), enqueue accumulated text if any.
        if (state.accumulatedText) {
          enqueuePendingReply(account.accountId, {
            text: state.accumulatedText,
            senderId,
            chatId,
            isGroupChat,
          });
        }
      }
      safeCleanup();
    }
  };

  const lockKey = `${account.accountId}:${peerId}`;
  const previous = dispatchLocks.get(lockKey) ?? Promise.resolve();
  const current = previous.then(runDispatch, runDispatch);
  dispatchLocks.set(lockKey, current);
  current.finally(() => {
    if (dispatchLocks.get(lockKey) === current) {
      dispatchLocks.delete(lockKey);
    }
  });
}

export async function startWsMonitor({ account, config, runtime, abortSignal, wsClientFactory }) {
  if (!account.botId || !account.secret) {
    throw new Error(`Missing botId or secret for account ${account.accountId}`);
  }

  setOpenclawConfig(config);
  startMessageStateCleanup();

  const wsClient =
    typeof wsClientFactory === "function"
      ? wsClientFactory({
          account,
          config,
          runtime,
          createSdkLogger,
        })
      : new WSClient({
          botId: account.botId,
          secret: account.secret,
          wsUrl: account.websocketUrl,
          logger: createSdkLogger(account.accountId),
          heartbeatInterval: WS_HEARTBEAT_INTERVAL_MS,
          maxReconnectAttempts: WS_MAX_RECONNECT_ATTEMPTS,
        });

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = async () => {
      await cleanupWsAccount(account.accountId);
    };

    const settle = async ({ error = null } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      await cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    if (abortSignal?.aborted) {
      void settle();
      return;
    }

    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        async () => {
          logger.info(`[WS:${account.accountId}] Abort signal received`);
          await settle();
        },
        { once: true },
      );
    }

    wsClient.on("connected", () => {
      logger.info(`[WS:${account.accountId}] Connected`);
    });

    wsClient.on("authenticated", () => {
      logger.info(`[WS:${account.accountId}] Authenticated`);
      clearAccountDisplaced(account.accountId);
      setWsClient(account.accountId, wsClient);

      // Drain pending replies that failed due to prior WS disconnection.
      if (account?.agentCredentials && hasPendingReplies(account.accountId)) {
        void flushPendingRepliesViaAgentApi(account).catch((flushError) => {
          logger.error(`[WS:${account.accountId}] Failed to flush pending replies: ${flushError.message}`);
        });
      }
    });

    wsClient.on("disconnected", (reason) => {
      logger.info(`[WS:${account.accountId}] Disconnected: ${reason}`);
    });

    wsClient.on("reconnecting", (attempt) => {
      logger.info(`[WS:${account.accountId}] Reconnecting attempt ${attempt}`);
    });

    wsClient.on("error", (error) => {
      logger.error(`[WS:${account.accountId}] ${error.message}`);
      if (error.message.includes("Authentication failed")) {
        void settle({ error });
      }
    });

    wsClient.on("message", async (frame) => {
      try {
        await withTimeout(
          processWsMessage({ frame, account, config, runtime, wsClient }),
          MESSAGE_PROCESS_TIMEOUT_MS,
          `Message processing timed out (msgId=${frame?.body?.msgid ?? "unknown"})`,
        );
      } catch (error) {
        logger.error(`[WS:${account.accountId}] Failed to process inbound message: ${error.message}`);
      }
    });

    wsClient.on("event.enter_chat", async (frame) => {
      try {
        await wsClient.replyWelcome(frame, {
          msgtype: "text",
          text: {
            content: resolveWelcomeMessage(account),
          },
        });
        recordOutboundActivity({ accountId: account.accountId });
      } catch (error) {
        logger.error(`[WS:${account.accountId}] Failed to send welcome reply: ${error.message}`);
      }
    });

    wsClient.on("event.template_card_event", (frame) => {
      logger.info(`[WS:${account.accountId}] Template card event received`, {
        msgId: frame?.body?.msgid,
        chatId: frame?.body?.chatid,
        senderId: frame?.body?.from?.userid,
        event: frame?.body?.event,
      });
    });

    wsClient.on("event.feedback_event", (frame) => {
      logger.info(`[WS:${account.accountId}] Feedback event received`, {
        msgId: frame?.body?.msgid,
        chatId: frame?.body?.chatid,
        senderId: frame?.body?.from?.userid,
        event: frame?.body?.event,
      });
    });

    wsClient.on("event.disconnected_event", (frame) => {
      const takeoverError = new Error(
        `WeCom botId "${account.botId}" was taken over by another connection. Only one active connection per botId is allowed.`,
      );
      markAccountDisplaced({
        accountId: account.accountId,
        reason: takeoverError.message,
      });
      logger.error(`[WS:${account.accountId}] Received disconnected_event; stopping reconnects`, {
        msgId: frame?.body?.msgid,
        createTime: frame?.body?.create_time,
        botId: account.botId,
      });
      try {
        wsClient.disconnect();
      } catch {
        // Ignore secondary disconnect errors.
      }
      void settle({ error: takeoverError });
    });

    if (!settled) {
      wsClient.connect();
    }
  });
}

export const wsMonitorTesting = {
  processWsMessage,
  parseMessageContent,
  splitReplyMediaFromText,
  buildBodyForAgent,
  flushPendingRepliesViaAgentApi,
};

export { buildReplyMediaGuidance };
