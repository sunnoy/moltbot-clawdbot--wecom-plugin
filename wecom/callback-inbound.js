/**
 * WeCom self-built app HTTP callback inbound channel.
 *
 * Registers an HTTP endpoint that:
 *   - Answers WeCom's GET URL-verification requests
 *   - Receives POST message callbacks, decrypts them, and dispatches to the LLM
 *
 * Reply is sent via the Agent API (agentSendText / agentSendMedia) instead of
 * the WebSocket, so this path works independently of the AI Bot WS connection.
 */

import path from "node:path";
import { logger } from "../logger.js";
import { agentSendText, agentUploadMedia, agentSendMedia } from "./agent-api.js";
import { checkDmPolicy } from "./dm-policy.js";
import { checkGroupPolicy } from "./group-policy.js";
import { resolveWecomCommandAuthorized } from "./allow-from.js";
import { checkCommandAllowlist, getCommandConfig, isWecomAdmin } from "./commands.js";
import {
  extractGroupMessageContent,
  generateAgentId,
  getDynamicAgentConfig,
  shouldTriggerGroupResponse,
  shouldUseDynamicAgent,
} from "../dynamic-agent.js";
import { ensureDynamicAgentListed } from "./workspace-template.js";
import { normalizeThinkingTags } from "../think-parser.js";
import { MessageDeduplicator, splitTextByByteLimit } from "../utils.js";
import { recordInboundMessage, recordOutboundActivity } from "./runtime-telemetry.js";
import { setConfigProxyUrl } from "./http.js";
import { setApiBaseUrl } from "./constants.js";
import { dispatchLocks, streamContext } from "./state.js";
import {
  CHANNEL_ID,
  CALLBACK_INBOUND_MAX_BODY_BYTES,
  CALLBACK_TIMESTAMP_TOLERANCE_S,
  TEXT_CHUNK_LIMIT,
  MESSAGE_PROCESS_TIMEOUT_MS,
  MEDIA_IMAGE_PLACEHOLDER,
  MEDIA_DOCUMENT_PLACEHOLDER,
} from "./constants.js";
import { verifyCallbackSignature, decryptCallbackMessage } from "./callback-crypto.js";
import { downloadCallbackMedia } from "./callback-media.js";
import {
  buildInboundContext,
  resolveChannelCore,
  normalizeReplyPayload,
  resolveReplyMediaLocalRoots,
} from "./ws-monitor.js";

const callbackDeduplicator = new MessageDeduplicator();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withCallbackTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label ?? `timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Read the POST body up to maxBytes. Returns null if the body exceeded the limit.
 */
async function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let oversize = false;

    req.on("data", (chunk) => {
      if (oversize) return;
      total += chunk.length;
      if (total > maxBytes) {
        oversize = true;
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!oversize) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });

    req.on("error", () => resolve(null));
  });
}

/**
 * Extract a CDATA or plain element value from a simple WeCom XML string.
 * WeCom callback XML is well-defined; a full parser is not required.
 */
function extractXmlValue(xml, tag) {
  const cdata = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`));
  if (cdata) return cdata[1];
  const plain = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return plain ? plain[1] ?? null : null;
}

/**
 * Parse a decrypted WeCom callback XML message into a normalised structure.
 * Returns null for event frames (enter_chat, etc.) that carry no user content.
 *
 * @param {string} xml - Decrypted inner XML
 * @returns {{ msgId, senderId, chatId, isGroupChat, text, mediaId, mediaType, voiceRecognition } | null}
 */
export function parseCallbackMessageXml(xml) {
  const msgType = extractXmlValue(xml, "MsgType");

  // Events (subscribe, click, enter_chat …) are not user messages
  if (!msgType || msgType === "event") {
    return null;
  }

  const msgId = extractXmlValue(xml, "MsgId") ?? String(Date.now());
  const senderId = extractXmlValue(xml, "FromUserName") ?? "";
  if (!senderId) return null;

  // Self-built app basic callback: group chats are not natively supported;
  // treat every message as a direct message.
  const isGroupChat = false;
  const chatId = senderId;

  let text = null;
  let mediaId = null;
  let mediaType = null;
  let voiceRecognition = null;

  if (msgType === "text") {
    text = extractXmlValue(xml, "Content") ?? "";
  } else if (msgType === "image") {
    mediaId = extractXmlValue(xml, "MediaId");
    mediaType = "image";
  } else if (msgType === "voice") {
    mediaId = extractXmlValue(xml, "MediaId");
    mediaType = "voice";
    // `Recognition` is populated when WeCom ASR is enabled for the app
    voiceRecognition = extractXmlValue(xml, "Recognition");
    text = voiceRecognition || null;
  } else if (msgType === "file") {
    mediaId = extractXmlValue(xml, "MediaId");
    mediaType = "file";
  } else if (msgType === "video") {
    mediaId = extractXmlValue(xml, "MediaId");
    mediaType = "file"; // treat video as generic file attachment
  } else {
    // Unknown type: log and skip
    logger.debug(`[CB] Unsupported callback MsgType="${msgType}", ignoring`);
    return null;
  }

  return { msgId, senderId, chatId, isGroupChat, text, mediaId, mediaType, voiceRecognition };
}

// ---------------------------------------------------------------------------
// Load a local reply-media file (LLM-generated MEDIA:/FILE: directives)
// ---------------------------------------------------------------------------

async function loadLocalReplyMedia(mediaUrl, config, agentId, runtime) {
  const normalized = String(mediaUrl ?? "").trim();
  if (!normalized.startsWith("/") && !normalized.startsWith("sandbox:")) {
    throw new Error(`Unsupported callback reply media URL scheme: ${mediaUrl}`);
  }

  if (typeof runtime?.media?.loadWebMedia === "function") {
    const localRoots = resolveReplyMediaLocalRoots(config, agentId);
    const loaded = await runtime.media.loadWebMedia(normalized.replace(/^sandbox:\/{0,2}/, "/"), { localRoots });
    const filename = loaded.fileName || path.basename(normalized.replace(/^sandbox:\/+/, "")) || "file";
    return { buffer: loaded.buffer, filename, contentType: loaded.contentType || "" };
  }

  // Fallback when runtime.media is unavailable
  const { readFile } = await import("node:fs/promises");
  const localPath = normalized.replace(/^sandbox:\/{0,2}/, "");
  const buffer = await readFile(localPath);
  return { buffer, filename: path.basename(localPath) || "file", contentType: "" };
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

/**
 * Process a parsed callback message: route, dispatch to LLM, and reply via
 * Agent API.
 *
 * @param {object} params
 * @param {object} params.parsedMsg  - Output of parseCallbackMessageXml()
 * @param {object} params.account    - Resolved account object (from accounts.js)
 * @param {object} params.config     - Full OpenClaw config
 * @param {object} params.runtime    - OpenClaw runtime
 */
async function processCallbackMessage({ parsedMsg, account, config, runtime }) {
  const { msgId, senderId, chatId, isGroupChat, text: rawText, mediaId, mediaType } = parsedMsg;
  const core = resolveChannelCore(runtime);

  // Deduplication (separate namespace from WS deduplicator to avoid cross-path conflicts)
  const dedupKey = `cb:${account.accountId}:${msgId}`;
  if (callbackDeduplicator.isDuplicate(dedupKey)) {
    logger.debug(`[CB:${account.accountId}] Duplicate message ignored`, { msgId, senderId });
    return;
  }

  recordInboundMessage({ accountId: account.accountId, chatId });

  logger.info(`[CB:${account.accountId}] ← inbound`, {
    senderId,
    chatId,
    msgId,
    mediaType: mediaId ? mediaType : null,
    textLength: rawText?.length ?? 0,
    preview: rawText?.slice(0, 80) || (mediaId ? `[${mediaType}]` : ""),
  });

  // --- Policy checks ---

  if (isGroupChat) {
    const groupResult = checkGroupPolicy({ chatId, senderId, account, config });
    if (!groupResult.allowed) return;
  }

  const dmResult = await checkDmPolicy({
    senderId,
    isGroup: isGroupChat,
    account,
    wsClient: null,
    frame: null,
    core,
    sendReply: async ({ text }) => {
      if (account.agentCredentials) {
        await agentSendText({ agent: account.agentCredentials, toUser: senderId, text }).catch((err) =>
          logger.warn(`[CB:${account.accountId}] DM policy reply failed: ${err.message}`),
        );
      }
    },
  });
  if (!dmResult.allowed) return;

  let text = rawText ?? "";

  // Group mention gating (not typically reached since isGroupChat=false, but kept for future)
  if (isGroupChat) {
    if (!shouldTriggerGroupResponse(text, account.config)) {
      return;
    }
    text = extractGroupMessageContent(text, account.config);
  }

  // --- Command allowlist ---
  const senderIsAdmin = isWecomAdmin(senderId, account.config);
  const commandAuthorized = resolveWecomCommandAuthorized({
    cfg: config,
    accountId: account.accountId,
    senderId,
  });
  const commandCheck = checkCommandAllowlist(text, account.config);
  if (commandCheck.isCommand && !commandCheck.allowed && !senderIsAdmin) {
    if (account.agentCredentials) {
      const blockMsg = getCommandConfig(account.config).blockMessage;
      await agentSendText({ agent: account.agentCredentials, toUser: senderId, text: blockMsg }).catch(
        (err) => logger.warn(`[CB:${account.accountId}] Command block reply failed: ${err.message}`),
      );
    }
    return;
  }

  // --- Inbound media download ---
  const mediaList = [];
  if (mediaId && account.agentCredentials) {
    try {
      const downloaded = await downloadCallbackMedia({
        agent: account.agentCredentials,
        mediaId,
        type: mediaType === "image" ? "image" : mediaType === "voice" ? "voice" : "file",
        runtime,
        config,
      });
      mediaList.push(downloaded);
    } catch (error) {
      logger.error(`[CB:${account.accountId}] Inbound media download failed: ${error.message}`);
    }
  }

  const effectiveText = text;

  // --- Route resolution ---
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
      (b) => b.match?.channel === CHANNEL_ID && b.match?.accountId === account.accountId,
    );
  if (dynamicAgentId && !hasExplicitBinding) {
    route.agentId = dynamicAgentId;
    route.sessionKey = `agent:${dynamicAgentId}:${peerKind}:${peerId}`;
  }

  // Build a body object that mirrors the WS frame.body structure expected by
  // buildInboundContext, so we can reuse that shared helper directly.
  const syntheticBody = {
    msgid: msgId,
    from: { userid: senderId },
    chatid: isGroupChat ? chatId : senderId,
    chattype: isGroupChat ? "group" : "single",
    text: effectiveText ? { content: effectiveText } : undefined,
  };

  const { ctxPayload, storePath } = buildInboundContext({
    runtime,
    config,
    account,
    frame: null, // no WS frame on callback path
    body: syntheticBody,
    text: effectiveText,
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
    .catch((err) => logger.error(`[CB] Session meta record failed: ${err.message}`));

  // --- Dispatch ---
  const state = { accumulatedText: "", replyMediaUrls: [] };
  const streamId = `cb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const runDispatch = async () => {
    try {
      await streamContext.run(
        { streamId, streamKey: peerId, agentId: route.agentId, accountId: account.accountId },
        async () => {
          await core.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg: config,
            // Disable block-streaming since Agent API replies are sent atomically
            replyOptions: { disableBlockStreaming: true },
            dispatcherOptions: {
              deliver: async (payload) => {
                const normalized = normalizeReplyPayload(payload);
                state.accumulatedText += normalized.text;
                for (const mediaUrl of normalized.mediaUrls) {
                  if (!state.replyMediaUrls.includes(mediaUrl)) {
                    state.replyMediaUrls.push(mediaUrl);
                  }
                }
              },
              onError: (error, info) => {
                logger.error(`[CB] ${info.kind} reply block failed: ${error.message}`);
              },
            },
          });
        },
      );

      const finalText = normalizeThinkingTags(state.accumulatedText.trim()) || "模型暂时无法响应，请稍后重试。";

      if (!account.agentCredentials) {
        logger.warn(`[CB:${account.accountId}] No agent credentials configured; callback reply skipped`);
        return;
      }

      const target = isGroupChat ? { chatId } : { toUser: senderId };

      // Send reply text (chunked to stay within WeCom message size limits)
      const chunks = splitTextByByteLimit(finalText, TEXT_CHUNK_LIMIT);
      logger.info(`[CB:${account.accountId}] → outbound`, {
        senderId,
        chatId,
        format: account.agentReplyFormat,
        chunks: chunks.length,
        totalLength: finalText.length,
        preview: finalText.slice(0, 80),
      });
      for (const chunk of chunks) {
        await agentSendText({
          agent: account.agentCredentials,
          ...target,
          text: chunk,
          format: account.agentReplyFormat,
        });
      }
      recordOutboundActivity({ accountId: account.accountId });

      // Send any LLM-generated media (MEDIA:/FILE: directives in reply)
      for (const mediaUrl of state.replyMediaUrls) {
        try {
          const { buffer, filename, contentType } = await loadLocalReplyMedia(
            mediaUrl,
            config,
            route.agentId,
            runtime,
          );
          const agentMediaType = contentType.startsWith("image/") ? "image" : "file";
          const uploadedMediaId = await agentUploadMedia({
            agent: account.agentCredentials,
            type: agentMediaType,
            buffer,
            filename,
          });
          await agentSendMedia({
            agent: account.agentCredentials,
            ...target,
            mediaId: uploadedMediaId,
            mediaType: agentMediaType,
          });
          recordOutboundActivity({ accountId: account.accountId });
        } catch (mediaError) {
          logger.error(`[CB:${account.accountId}] Failed to send reply media: ${mediaError.message}`);
        }
      }
    } catch (error) {
      logger.error(`[CB:${account.accountId}] Dispatch error: ${error.message}`);
      if (account.agentCredentials) {
        const target = isGroupChat ? { chatId } : { toUser: senderId };
        try {
          await agentSendText({
            agent: account.agentCredentials,
            ...target,
            text: "处理消息时出错，请稍后再试。",
            format: "text",
          });
        } catch (sendErr) {
          logger.error(`[CB:${account.accountId}] Error fallback reply failed: ${sendErr.message}`);
        }
      }
    }
  };

  // Serialise per-sender to prevent concurrent replies to the same user
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

// ---------------------------------------------------------------------------
// HTTP handler factory
// ---------------------------------------------------------------------------

/**
 * Create an HTTP handler for a single WeCom account's callback endpoint.
 *
 * The handler is registered via `api.registerHttpRoute({ auth: "plugin" })` so
 * WeCom's servers can POST to it directly without gateway authentication.
 *
 * @param {object} params
 * @param {object} params.account  - Resolved account object with callbackConfig
 * @param {object} params.config   - Full OpenClaw config
 * @param {object} params.runtime  - OpenClaw runtime
 * @returns {Function} HTTP handler: (req, res) => Promise<boolean|void>
 */
export function createCallbackHandler({ account, config, runtime }) {
  const { token, encodingAESKey, corpId } = account.callbackConfig;

  // Apply network config so wecomFetch uses the right proxy/base URL
  const network = account.config.network ?? {};
  setConfigProxyUrl(network.egressProxyUrl ?? "");
  setApiBaseUrl(network.apiBaseUrl ?? "");

  return async function callbackHandler(req, res) {
    const rawUrl = req.url ?? "/";
    const urlObj = new URL(rawUrl, "http://localhost");

    const signature = urlObj.searchParams.get("msg_signature") ?? "";
    const timestamp = urlObj.searchParams.get("timestamp") ?? "";
    const nonce = urlObj.searchParams.get("nonce") ?? "";

    // --- GET: WeCom URL ownership verification ---
    if (req.method === "GET") {
      const echostrCipher = urlObj.searchParams.get("echostr") ?? "";
      if (!echostrCipher) {
        res.writeHead(400);
        res.end("missing echostr");
        return true;
      }
      if (!verifyCallbackSignature({ token, timestamp, nonce, msgEncrypt: echostrCipher, signature })) {
        logger.warn(`[CB:${account.accountId}] GET signature mismatch`);
        res.writeHead(403);
        res.end("forbidden");
        return true;
      }
      try {
        const { xml: plainEchostr } = decryptCallbackMessage({ encodingAESKey, encrypted: echostrCipher });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(plainEchostr);
      } catch (err) {
        logger.error(`[CB:${account.accountId}] GET echostr decrypt failed: ${err.message}`);
        res.writeHead(500);
        res.end("error");
      }
      return true;
    }

    // --- POST: message callback ---
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("method not allowed");
      return true;
    }

    const body = await readBody(req, CALLBACK_INBOUND_MAX_BODY_BYTES);
    if (body === null) {
      res.writeHead(413);
      res.end("request body too large");
      return true;
    }

    // Extract the encrypted payload from the outer XML wrapper
    const encryptMatch = body.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/);
    const msgEncrypt = encryptMatch?.[1];
    if (!msgEncrypt) {
      logger.warn(`[CB:${account.accountId}] No <Encrypt> field in POST body`);
      res.writeHead(400);
      res.end("bad request");
      return true;
    }

    // Replay-attack protection: reject requests older than 5 minutes
    const tsNum = Number(timestamp);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > CALLBACK_TIMESTAMP_TOLERANCE_S) {
      logger.warn(`[CB:${account.accountId}] Timestamp out of tolerance`, { timestamp });
      res.writeHead(403);
      res.end("forbidden");
      return true;
    }

    // Signature verification
    if (!verifyCallbackSignature({ token, timestamp, nonce, msgEncrypt, signature })) {
      logger.warn(`[CB:${account.accountId}] POST signature mismatch`);
      res.writeHead(403);
      res.end("forbidden");
      return true;
    }

    // Decrypt
    let decryptedXml;
    let callbackCorpId;
    try {
      const result = decryptCallbackMessage({ encodingAESKey, encrypted: msgEncrypt });
      decryptedXml = result.xml;
      callbackCorpId = result.corpId;
    } catch (err) {
      logger.error(`[CB:${account.accountId}] Decryption failed: ${err.message}`);
      res.writeHead(400);
      res.end("bad request");
      return true;
    }

    // CorpId integrity check
    if (callbackCorpId !== corpId) {
      logger.warn(`[CB:${account.accountId}] CorpId mismatch (expected=${corpId} got=${callbackCorpId})`);
      res.writeHead(403);
      res.end("forbidden");
      return true;
    }

    // Respond to WeCom immediately (WeCom requires a fast HTTP response)
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("success");

    // Process asynchronously so we don't block the HTTP response
    const parsedMsg = parseCallbackMessageXml(decryptedXml);
    if (!parsedMsg) {
      // Event frame or unsupported type, already logged in parseCallbackMessageXml
      return true;
    }

    withCallbackTimeout(
      processCallbackMessage({ parsedMsg, account, config, runtime }),
      MESSAGE_PROCESS_TIMEOUT_MS,
      `Callback message processing timed out (msgId=${parsedMsg.msgId})`,
    ).catch((err) => {
      logger.error(`[CB:${account.accountId}] Failed to process callback message: ${err.message}`);
    });

    return true;
  };
}
