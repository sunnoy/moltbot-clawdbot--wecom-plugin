import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { WSClient, generateReqId } from "@wecom/aibot-node-sdk";
import { uploadAndSendMedia, buildMediaErrorSummary } from "./media-uploader.js";
import { createPersistentReqIdStore } from "./reqid-store.js";
import { agentSendMedia, agentSendText, agentUploadMedia } from "./agent-api.js";
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
  DEFAULT_WELCOME_MESSAGES,
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
import { fetchAndSaveMcpConfig } from "./mcp-config.js";
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
const WAITING_MODEL_TICK_MS = 1_000;
const REASONING_STREAM_THROTTLE_MS = 800;
const VISIBLE_STREAM_THROTTLE_MS = 800;
// Reserve headroom below the SDK's per-reqId queue limit (100) so the final
// reply always has room.
const MAX_INTERMEDIATE_STREAM_MESSAGES = 85;
// WeCom stream messages expire if not updated within 6 minutes. Send a
// keepalive update every 4 minutes to keep the stream alive during long runs.
const STREAM_KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;
// Match MEDIA:/FILE: directives at line start, optionally preceded by markdown list markers.
const REPLY_MEDIA_DIRECTIVE_PATTERN = /^\s*(?:[-*•]\s+|\d+\.\s+)?(?:MEDIA|FILE)\s*:/im;
const WECOM_REPLY_MEDIA_GUIDANCE_HEADER = "[WeCom reply media rule]";
const inboundMessageDeduplicator = new MessageDeduplicator();
const sessionReasoningInitLocks = new Map();

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

function buildWaitingModelContent(seconds) {
  const normalizedSeconds = Math.max(1, Number.parseInt(String(seconds ?? 1), 10) || 1);
  const lines = [];
  for (let current = 1; current <= normalizedSeconds; current += 1) {
    lines.push(`等待模型响应 ${current}s`);
  }
  return `<think>${lines.join("\n")}`;
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

function normalizeWecomCreateTimeMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.trunc(seconds * 1000);
}

function getWecomSourceTiming(createTime, now = Date.now()) {
  const sourceCreateTimeMs = normalizeWecomCreateTimeMs(createTime);
  if (!sourceCreateTimeMs) {
    return {
      sourceCreateTime: undefined,
      sourceCreateTimeIso: undefined,
      sourceToIngressMs: undefined,
    };
  }

  return {
    sourceCreateTime: createTime,
    sourceCreateTimeIso: new Date(sourceCreateTimeMs).toISOString(),
    sourceToIngressMs: Math.max(0, now - sourceCreateTimeMs),
  };
}

function resolveWsKeepaliveContent({ reasoningText = "", visibleText = "", lastStreamText = "" }) {
  const currentContent = buildWsStreamContent({
    reasoningText,
    visibleText,
    finish: false,
  });
  return currentContent || String(lastStreamText ?? "").trim() || THINKING_MESSAGE;
}

function normalizeSessionStoreKey(sessionKey) {
  return String(sessionKey ?? "").trim().toLowerCase();
}

async function withSessionReasoningInitLock(storePath, task) {
  const lockKey = path.resolve(String(storePath ?? ""));
  const previous = sessionReasoningInitLocks.get(lockKey) ?? Promise.resolve();
  const current = previous.then(task, task);
  sessionReasoningInitLocks.set(lockKey, current);
  return await current.finally(() => {
    if (sessionReasoningInitLocks.get(lockKey) === current) {
      sessionReasoningInitLocks.delete(lockKey);
    }
  });
}

async function ensureDefaultSessionReasoningLevel({
  core,
  storePath,
  sessionKey,
  ctx,
  reasoningLevel = "stream",
  channelTag = "WS",
}) {
  const normalizedSessionKey = normalizeSessionStoreKey(sessionKey);
  if (!storePath || !normalizedSessionKey || !ctx || !core?.session?.recordSessionMetaFromInbound) {
    return null;
  }

  try {
    const recorded = await core.session.recordSessionMetaFromInbound({
      storePath,
      sessionKey: normalizedSessionKey,
      ctx,
    });
    if (!recorded || recorded.reasoningLevel != null) {
      return recorded;
    }

    return await withSessionReasoningInitLock(storePath, async () => {
      let store;
      try {
        store = JSON.parse(await readFile(storePath, "utf8"));
      } catch (error) {
        logger.warn(`[${channelTag}] Failed to read session store for reasoning default: ${error.message}`);
        return recorded;
      }

      const resolvedKey = Object.keys(store).find((key) => normalizeSessionStoreKey(key) === normalizedSessionKey);
      if (!resolvedKey) {
        return recorded;
      }

      const existing = store[resolvedKey];
      if (!existing || typeof existing !== "object" || existing.reasoningLevel != null) {
        return existing ?? recorded;
      }

      store[resolvedKey] = { ...existing, reasoningLevel };
      await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`);
      logger.info(`[${channelTag}] Initialized session reasoningLevel default`, {
        sessionKey: resolvedKey,
        reasoningLevel,
      });
      return store[resolvedKey];
    });
  } catch (error) {
    logger.warn(`[${channelTag}] Failed to initialize session reasoning default: ${error.message}`);
    return null;
  }
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

function resolveConfiguredReplyMediaLocalRoots(config) {
  const roots = Array.isArray(config?.channels?.[CHANNEL_ID]?.mediaLocalRoots)
    ? config.channels[CHANNEL_ID].mediaLocalRoots
    : [];
  return roots.map((entry) => resolveUserPath(entry)).filter(Boolean);
}

function resolveReplyMediaLocalRoots(config, agentId) {
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId || resolveDefaultAgentId(config));
  const browserMediaDir = path.join(resolveStateDir(), "media", "browser");
  const configuredRoots = resolveConfiguredReplyMediaLocalRoots(config);
  return [...new Set([workspaceDir, browserMediaDir, ...configuredRoots].map((entry) => path.resolve(entry)))];
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
  const configuredRoots = resolveConfiguredReplyMediaLocalRoots(config);
  const guidance = [
    WECOM_REPLY_MEDIA_GUIDANCE_HEADER,
    `Local reply files are allowed only under the current workspace: ${workspaceDir}`,
    "Inside the agent sandbox, that same workspace is visible as /workspace.",
    `Browser-generated files are also allowed only under: ${browserMediaDir}`,
    "Do NOT call message.send or message.sendAttachment to deliver files back to the current WeCom chat/user; use MEDIA: or FILE: directives instead.",
    "For images: put each image path on its own line as MEDIA:/abs/path.",
    "If a local file is in the current sandbox workspace, use its /workspace/... path directly.",
    "For every non-image file (PDF, MD, DOC, DOCX, XLS, XLSX, CSV, ZIP, MP4, TXT, etc.): put it on its own line as FILE:/abs/path.",
    "Example: FILE:/workspace/skills/deep-research/SKILL.md",
    "CRITICAL: Never use MEDIA: for non-image files. PDF must always use FILE:, never MEDIA:.",
    "CRITICAL: If a tool already returned a path prefixed with FILE: (e.g. FILE:/abs/path.pdf), keep the FILE: prefix exactly as-is. Do NOT change it to MEDIA:.",
    "Each directive MUST be on its own line with no other text on that line.",
    "The plugin will automatically send the media to the user.",
  ];

  if (configuredRoots.length > 0) {
    guidance.push(`Additional configured host roots are also allowed: ${configuredRoots.join(", ")}`);
  }

  guidance.push("Never reference any other host path.");
  return guidance.join("\n");
}

function normalizeReplyMediaUrlForLoad(mediaUrl, config, agentId) {
  let normalized = String(mediaUrl ?? "").trim();
  if (!normalized) {
    return "";
  }

  if (/^file:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol === "file:") {
        normalized = fileURLToPath(parsed);
      }
    } catch {
      return normalized;
    }
  }

  if (/^sandbox:\/{0,2}/i.test(normalized)) {
    normalized = normalized.replace(/^sandbox:\/{0,2}/i, "/");
  }

  if (normalized === "/workspace" || normalized.startsWith("/workspace/")) {
    const workspaceDir = resolveAgentWorkspaceDir(config, agentId || resolveDefaultAgentId(config));
    const rel = normalized === "/workspace" ? "" : normalized.slice("/workspace/".length);
    const resolved = rel
      ? path.resolve(workspaceDir, ...rel.split("/").filter(Boolean))
      : path.resolve(workspaceDir);
    // Prevent path traversal outside workspace directory
    const normalizedWorkspace = path.resolve(workspaceDir) + path.sep;
    if (resolved !== path.resolve(workspaceDir) && !resolved.startsWith(normalizedWorkspace)) {
      logger.warn(`[WS] Blocked path traversal attempt: ${mediaUrl} resolved to ${resolved}`);
      return "";
    }
    return resolved;
  }

  return normalized;
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

function stripThinkTags(text) {
  return String(text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function sendMediaBatch({ wsClient, frame, state, account, runtime, config, agentId }) {
  const body = frame?.body ?? {};
  const chatId = body.chatid || body.from?.userid;
  const mediaLocalRoots = resolveReplyMediaLocalRoots(config, agentId);

  for (const mediaUrl of state.pendingMediaUrls) {
    const normalizedUrl = normalizeReplyMediaUrlForLoad(mediaUrl, config, agentId);
    if (!normalizedUrl) {
      state.hasMediaFailed = true;
      logger.error(`[WS] Media send failed: url=${mediaUrl}, reason=invalid_local_path`);
      const summary = buildMediaErrorSummary(mediaUrl, {
        ok: false,
        rejectReason: "invalid_local_path",
        error: "reply media path resolved outside allowed roots",
      });
      state.mediaErrorSummary = state.mediaErrorSummary
        ? `${state.mediaErrorSummary}\n\n${summary}`
        : summary;
      continue;
    }
    const result = await uploadAndSendMedia({
      wsClient,
      mediaUrl: normalizedUrl,
      chatId,
      mediaLocalRoots,
      includeDefaultMediaLocalRoots: false,
      log: (...args) => logger.info(...args),
      errorLog: (...args) => logger.error(...args),
    });

    if (result.ok) {
      state.hasMedia = true;
      if (result.downgraded) {
        logger.info(`[WS] Media downgraded: ${result.downgradeNote}`);
      }
    } else {
      state.hasMediaFailed = true;
      logger.error(`[WS] Media send failed: url=${mediaUrl}, reason=${result.rejectReason || result.error}`);
      const summary = buildMediaErrorSummary(mediaUrl, result);
      state.mediaErrorSummary = state.mediaErrorSummary
        ? `${state.mediaErrorSummary}\n\n${summary}`
        : summary;
    }
  }
  state.pendingMediaUrls = [];
}

async function finishThinkingStream({ wsClient, frame, state, accountId }) {
  const visibleText = stripThinkTags(state.accumulatedText);
  let finishText;

  if (visibleText) {
    let finalVisibleText = state.accumulatedText;
    if (state.hasMediaFailed && state.mediaErrorSummary) {
      finalVisibleText += `\n\n${state.mediaErrorSummary}`;
    }
    finishText = buildWsStreamContent({
      reasoningText: state.reasoningText,
      visibleText: finalVisibleText,
      finish: true,
    });
  } else if (state.hasMedia) {
    finishText = "文件已发送，请查收。";
  } else if (state.hasMediaFailed && state.mediaErrorSummary) {
    finishText = state.mediaErrorSummary;
  } else {
    finishText = "处理完成。";
  }

  await sendWsReply({
    wsClient,
    frame,
    streamId: state.streamId,
    text: finishText,
    finish: true,
    accountId,
  });
}

function resolveWelcomeMessage(account) {
  const configured = String(account?.config?.welcomeMessage ?? "").trim();
  if (configured) {
    return configured;
  }

  const index = Math.floor(Math.random() * DEFAULT_WELCOME_MESSAGES.length);
  return DEFAULT_WELCOME_MESSAGES[index] || DEFAULT_WELCOME_MESSAGE;
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

async function sendThinkingReply({ wsClient, frame, streamId, text = THINKING_MESSAGE }) {
  try {
    await sendWsReply({
      wsClient,
      frame,
      streamId,
      text,
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
    SourceTimestamp: normalizeWecomCreateTimeMs(body?.create_time) || undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: isGroupChat ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${senderId}`,
    CommandAuthorized: true,
    // frame is null for callback-inbound path; use body.msgid as fallback
    ReqId: frame?.headers?.req_id ?? body?.msgid ?? "",
    WeComFrame: frame ?? null,
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

async function processWsMessage({ frame, account, config, runtime, wsClient, reqIdStore }) {
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

  const perfStartedAt = Date.now();
  const sourceTiming = getWecomSourceTiming(body?.create_time, perfStartedAt);
  const perfState = {
    firstReasoningReceivedAt: 0,
    firstReasoningForwardedAt: 0,
    firstVisibleReceivedAt: 0,
    firstVisibleForwardedAt: 0,
    thinkingSentAt: 0,
    finalReplySentAt: 0,
  };
  const logPerf = (stage, extra = {}) => {
    logger.info(`[WSPERF:${account.accountId}] ${stage}`, {
      messageId,
      senderId,
      chatId,
      isGroupChat,
      elapsedMs: Date.now() - perfStartedAt,
      ...extra,
    });
  };

  recordInboundMessage({ accountId: account.accountId, chatId });

  const { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent } = parseMessageContent(body);
  const originalText = textParts.join("\n").trim();
  let text = originalText;

  logger.info(`[WS:${account.accountId}] ← inbound`, {
    senderId,
    chatId,
    isGroupChat,
    messageId,
    ...sourceTiming,
    textLength: originalText.length,
    imageCount: imageUrls.length,
    fileCount: fileUrls.length,
    preview: originalText.slice(0, 80) || (imageUrls.length ? "[image]" : fileUrls.length ? "[file]" : ""),
  });
  logPerf("inbound", sourceTiming);

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
    if (!text.trim() && imageUrls.length === 0 && fileUrls.length === 0) {
      logger.debug("[WS] Group message mention stripped to empty content; skipping reply", {
        accountId: account.accountId,
        chatId,
        senderId,
      });
      return;
    }
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
  logPerf("media_ready", {
    imageCount: imageMediaList.length,
    fileCount: fileMediaList.length,
  });

  const streamId = reqIdStore?.getSync(chatId) ?? generateReqId("stream");
  if (reqIdStore) reqIdStore.set(chatId, streamId);
  const state = {
    accumulatedText: "",
    reasoningText: "",
    streamId,
    replyMediaUrls: [],
    pendingMediaUrls: [],
    hasMedia: false,
    hasMediaFailed: false,
    mediaErrorSummary: "",
    deliverCalled: false,
  };
  setMessageState(messageId, state);

  // Throttle reasoning and visible text stream updates to avoid exceeding
  // the SDK's per-reqId reply queue limit (100).
  let streamMessagesSent = 0;
  let lastReasoningSendAt = 0;
  let pendingReasoningTimer = null;
  let lastVisibleSendAt = 0;
  let pendingVisibleTimer = null;
  let lastStreamSentAt = 0;
  let lastNonEmptyStreamText = "";
  let lastForwardedVisibleText = "";
  let keepaliveTimer = null;
  let waitingModelTimer = null;
  let waitingModelSeconds = 0;
  let waitingModelActive = false;

  const canSendIntermediate = () => streamMessagesSent < MAX_INTERMEDIATE_STREAM_MESSAGES;

  const stopWaitingModelUpdates = () => {
    waitingModelActive = false;
    if (waitingModelTimer) {
      clearTimeout(waitingModelTimer);
      waitingModelTimer = null;
    }
  };

  const sendWaitingModelUpdate = async (seconds) => {
    const waitingText = buildWaitingModelContent(seconds);
    lastStreamSentAt = Date.now();
    lastNonEmptyStreamText = waitingText;
    try {
      streamMessagesSent++;
      await sendWsReply({
        wsClient,
        frame,
        streamId: state.streamId,
        text: waitingText,
        finish: false,
        accountId: account.accountId,
      });
      logPerf("waiting_model_forwarded", {
        seconds,
        streamMessagesSent,
        chars: waitingText.length,
      });
    } catch (error) {
      logger.warn(`[WS] Waiting-model stream send failed (non-fatal): ${error.message}`);
    }
  };

  const scheduleWaitingModelUpdate = () => {
    if (!waitingModelActive) {
      return;
    }
    if (waitingModelTimer) {
      clearTimeout(waitingModelTimer);
    }
    waitingModelTimer = setTimeout(async () => {
      waitingModelTimer = null;
      if (!waitingModelActive || !canSendIntermediate()) {
        return;
      }
      waitingModelSeconds += 1;
      await sendWaitingModelUpdate(waitingModelSeconds);
      scheduleWaitingModelUpdate();
    }, WAITING_MODEL_TICK_MS);
  };

  const sendReasoningUpdate = async () => {
    if (!canSendIntermediate()) return;
    lastReasoningSendAt = Date.now();
    lastStreamSentAt = lastReasoningSendAt;
    const streamText = buildWsStreamContent({
      reasoningText: state.reasoningText,
      visibleText: state.accumulatedText,
      finish: false,
    });
    if (streamText) {
      lastNonEmptyStreamText = streamText;
    }
    try {
      streamMessagesSent++;
      await sendWsReply({
        wsClient,
        frame,
        streamId: state.streamId,
        text: streamText,
        finish: false,
        accountId: account.accountId,
      });
      if (!perfState.firstReasoningForwardedAt) {
        perfState.firstReasoningForwardedAt = Date.now();
        logPerf("first_reasoning_forwarded", {
          streamMessagesSent,
          chars: streamText.length,
        });
      }
    } catch (error) {
      logger.warn(`[WS] Reasoning stream send failed (non-fatal): ${error.message}`);
    }
  };

  const sendVisibleUpdate = async () => {
    if (!canSendIntermediate()) return;
    lastVisibleSendAt = Date.now();
    lastStreamSentAt = lastVisibleSendAt;
    const visibleText = state.accumulatedText;
    const streamText = buildWsStreamContent({
      reasoningText: state.reasoningText,
      visibleText,
      finish: false,
    });
    if (streamText) {
      lastNonEmptyStreamText = streamText;
    }
    lastForwardedVisibleText = visibleText;
    try {
      streamMessagesSent++;
      await sendWsReply({
        wsClient,
        frame,
        streamId: state.streamId,
        text: streamText,
        finish: false,
        accountId: account.accountId,
      });
      if (!perfState.firstVisibleForwardedAt) {
        perfState.firstVisibleForwardedAt = Date.now();
        logPerf("first_visible_forwarded", {
          streamMessagesSent,
          chars: streamText.length,
        });
      }
    } catch (error) {
      logger.warn(`[WS] Visible stream send failed (non-fatal): ${error.message}`);
    }
  };

  const flushPendingStreamUpdates = async () => {
    const hadPendingReasoning = Boolean(pendingReasoningTimer);
    const hadPendingVisible = Boolean(pendingVisibleTimer);

    if (pendingReasoningTimer) {
      clearTimeout(pendingReasoningTimer);
      pendingReasoningTimer = null;
    }
    if (pendingVisibleTimer) {
      clearTimeout(pendingVisibleTimer);
      pendingVisibleTimer = null;
    }

    if (hadPendingReasoning) {
      const visibleText = hadPendingVisible ? state.accumulatedText : lastForwardedVisibleText;
      const streamText = buildWsStreamContent({
        reasoningText: state.reasoningText,
        visibleText,
        finish: false,
      });
      if (!streamText || streamText === lastNonEmptyStreamText) {
        return;
      }
      lastReasoningSendAt = Date.now();
      lastStreamSentAt = lastReasoningSendAt;
      lastNonEmptyStreamText = streamText;
      if (hadPendingVisible) {
        lastForwardedVisibleText = visibleText;
      }
      try {
        streamMessagesSent++;
        await sendWsReply({
          wsClient,
          frame,
          streamId: state.streamId,
          text: streamText,
          finish: false,
          accountId: account.accountId,
        });
        if (!perfState.firstReasoningForwardedAt) {
          perfState.firstReasoningForwardedAt = Date.now();
          logPerf("first_reasoning_forwarded", {
            streamMessagesSent,
            chars: streamText.length,
          });
        }
      } catch (error) {
        logger.warn(`[WS] Reasoning stream send failed (non-fatal): ${error.message}`);
      }
      return;
    }
    if (hadPendingVisible) {
      await sendVisibleUpdate();
    }
  };

  const scheduleKeepalive = () => {
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    keepaliveTimer = setTimeout(async () => {
      keepaliveTimer = null;
      if (!canSendIntermediate()) return;
      const idle = Date.now() - lastStreamSentAt;
      if (idle < STREAM_KEEPALIVE_INTERVAL_MS) {
        // A real update was sent recently; wait remaining time then send immediately.
        const remaining = STREAM_KEEPALIVE_INTERVAL_MS - idle;
        keepaliveTimer = setTimeout(async () => {
          keepaliveTimer = null;
          if (!canSendIntermediate()) return;
          logger.debug(`[WS] Sending stream keepalive after deferred wait (idle ${Math.round((Date.now() - lastStreamSentAt) / 1000)}s)`);
          lastStreamSentAt = Date.now();
          const keepaliveText = resolveWsKeepaliveContent({
            reasoningText: state.reasoningText,
            visibleText: state.accumulatedText,
            lastStreamText: lastNonEmptyStreamText,
          });
          if (keepaliveText) {
            lastNonEmptyStreamText = keepaliveText;
          }
          try {
            streamMessagesSent++;
            await sendWsReply({
              wsClient,
              frame,
              streamId: state.streamId,
              text: keepaliveText,
              finish: false,
              accountId: account.accountId,
            });
          } catch (err) {
            logger.warn(`[WS] Keepalive send failed (non-fatal): ${err.message}`);
          }
          scheduleKeepalive();
        }, remaining);
        return;
      }
      logger.debug(`[WS] Sending stream keepalive (idle ${Math.round(idle / 1000)}s)`);
      lastStreamSentAt = Date.now();
      const keepaliveText = resolveWsKeepaliveContent({
        reasoningText: state.reasoningText,
        visibleText: state.accumulatedText,
        lastStreamText: lastNonEmptyStreamText,
      });
      if (keepaliveText) {
        lastNonEmptyStreamText = keepaliveText;
      }
      try {
        streamMessagesSent++;
        await sendWsReply({
          wsClient,
          frame,
          streamId: state.streamId,
          text: keepaliveText,
          finish: false,
          accountId: account.accountId,
        });
      } catch (error) {
        logger.warn(`[WS] Stream keepalive send failed (non-fatal): ${error.message}`);
      }
      scheduleKeepalive();
    }, STREAM_KEEPALIVE_INTERVAL_MS);
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
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
    stopWaitingModelUpdates();
  };

  const cleanupState = () => {
    deleteMessageState(messageId);
    cancelPendingTimers();
  };

  if (account.sendThinkingMessage !== false) {
    waitingModelActive = true;
    waitingModelSeconds = 1;
    await sendThinkingReply({
      wsClient,
      frame,
      streamId,
      text: buildWaitingModelContent(waitingModelSeconds),
    });
    lastNonEmptyStreamText = buildWaitingModelContent(waitingModelSeconds);
    perfState.thinkingSentAt = Date.now();
    logPerf("thinking_sent", { streamId });
    scheduleWaitingModelUpdate();
  }
  lastStreamSentAt = Date.now();
  scheduleKeepalive();

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

  await ensureDefaultSessionReasoningLevel({
    core,
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    channelTag: "WS",
  });

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
      logPerf("dispatch_start", {
        routeAgentId: route.agentId,
        sessionKey: route.sessionKey,
        mediaCount: mediaList.length,
        ...sourceTiming,
      });
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
                stopWaitingModelUpdates();
                state.reasoningText = nextReasoning;
                if (!perfState.firstReasoningReceivedAt) {
                  perfState.firstReasoningReceivedAt = Date.now();
                  logPerf("first_reasoning_received", {
                    chars: nextReasoning.length,
                  });
                }

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
                state.deliverCalled = true;
                const normalized = normalizeReplyPayload(payload);
                const chunk = normalized.text;
                const mediaUrls = normalized.mediaUrls;

                if (chunk) {
                  stopWaitingModelUpdates();
                  state.accumulatedText += chunk;
                }

                for (const mediaUrl of mediaUrls) {
                  if (!state.replyMediaUrls.includes(mediaUrl)) {
                    state.replyMediaUrls.push(mediaUrl);
                    state.pendingMediaUrls.push(mediaUrl);
                  }
                }

                if (state.pendingMediaUrls.length > 0) {
                  try {
                    await sendMediaBatch({
                      wsClient, frame, state, account, runtime, config,
                      agentId: route.agentId,
                    });
                  } catch (mediaErr) {
                    state.hasMediaFailed = true;
                    const errMsg = String(mediaErr);
                    const summary = `文件发送失败：内部处理异常，请升级 openclaw 到最新版本后重试。\n错误详情：${errMsg}`;
                    state.mediaErrorSummary = state.mediaErrorSummary
                      ? `${state.mediaErrorSummary}\n\n${summary}`
                      : summary;
                    logger.error(`[WS] sendMediaBatch threw: ${errMsg}`);
                  }
                }

                if (!perfState.firstVisibleReceivedAt && chunk?.trim()) {
                  perfState.firstVisibleReceivedAt = Date.now();
                  logPerf("first_visible_received", {
                    chars: chunk.length,
                  });
                }

                if (info.kind !== "final") {
                  const hasText = stripThinkTags(state.accumulatedText);
                  if (hasText) {
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
                }
              },
              onError: (error, info) => {
                logger.error(`[WS] ${info.kind} reply failed: ${error.message}`);
              },
            },
          });
        },
      );

      // Flush the latest throttled snapshot before finish=true so reasoning
      // and visible deltas are not collapsed away by the final frame.
      await flushPendingStreamUpdates();

      // Cancel pending throttled timers before the final reply to prevent
      // non-final updates from being sent after finish=true.
      cancelPendingTimers();

      try {
        await finishThinkingStream({
          wsClient,
          frame,
          state,
          accountId: account.accountId,
        });
        perfState.finalReplySentAt = Date.now();
        logPerf("final_reply_sent", {
          textLength: state.accumulatedText.length,
          hasMedia: state.hasMedia,
          hasMediaFailed: state.hasMediaFailed,
        });
      } catch (sendError) {
        logger.warn(`[WS] Final reply send failed, enqueuing for retry: ${sendError.message}`, {
          accountId: account.accountId,
          chatId,
          senderId,
        });
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
      logPerf("dispatch_complete", {
        hadReasoning: Boolean(perfState.firstReasoningReceivedAt),
        hadVisibleText: Boolean(perfState.firstVisibleReceivedAt),
        totalOutputChars: state.accumulatedText.length,
        replyMediaCount: state.replyMediaUrls.length,
      });
    } catch (error) {
      logger.error(`[WS] Failed to dispatch reply: ${error.message}`);
      logPerf("dispatch_failed", {
        error: error.message,
      });
      try {
        // Ensure the user sees an error message, not "处理完成。"
        if (!stripThinkTags(state.accumulatedText) && !state.hasMedia) {
          state.accumulatedText = `⚠️ 处理出错：${error.message}`;
        }
        await finishThinkingStream({
          wsClient,
          frame,
          state,
          accountId: account.accountId,
        });
      } catch (finishErr) {
        logger.error(`[WS] Failed to finish thinking stream after dispatch error: ${finishErr.message}`);
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
  const queuedAt = Date.now();
  const previous = dispatchLocks.get(lockKey) ?? Promise.resolve();
  const current = previous.then(
    async () => {
      const queueWaitMs = Date.now() - queuedAt;
      if (queueWaitMs >= 50) {
        logPerf("dispatch_lock_acquired", { queueWaitMs });
      }
      return await runDispatch();
    },
    async () => {
      const queueWaitMs = Date.now() - queuedAt;
      if (queueWaitMs >= 50) {
        logPerf("dispatch_lock_acquired", { queueWaitMs, previousFailed: true });
      }
      return await runDispatch();
    },
  );
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

  const reqIdStore = createPersistentReqIdStore(account.accountId);
  await reqIdStore.warmup();

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = async () => {
      try {
        await reqIdStore.flush();
      } catch (flushErr) {
        logger.warn(`[WS:${account.accountId}] Failed to flush reqId store on cleanup: ${flushErr.message}`);
      }
      reqIdStore.destroy();
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

      void fetchAndSaveMcpConfig(wsClient, account.accountId, runtime);

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
          processWsMessage({ frame, account, config, runtime, wsClient, reqIdStore }),
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
  buildWsStreamContent,
  ensureDefaultSessionReasoningLevel,
  resolveWsKeepaliveContent,
  processWsMessage,
  parseMessageContent,
  splitReplyMediaFromText,
  buildBodyForAgent,
  normalizeReplyMediaUrlForLoad,
  flushPendingRepliesViaAgentApi,
  stripThinkTags,
  finishThinkingStream,
};

export { buildReplyMediaGuidance, ensureDefaultSessionReasoningLevel, normalizeReplyMediaUrlForLoad };

// Shared internals used by callback-inbound.js
export {
  buildInboundContext,
  resolveChannelCore,
  normalizeReplyPayload,
  resolveReplyMediaLocalRoots,
};
