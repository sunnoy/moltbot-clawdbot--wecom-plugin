import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { logger } from "../logger.js";
import { streamManager } from "../stream-manager.js";
import { agentSendText, agentUploadMedia, agentSendMedia } from "./agent-api.js";
import { parseResponseUrlResult } from "./response-url.js";
import { resolveAgentConfig, responseUrls, streamContext } from "./state.js";
import { resolveActiveStream } from "./stream-utils.js";
import { THINKING_PLACEHOLDER } from "./constants.js";

export async function deliverWecomReply({ payload, senderId, streamId }) {
  const text = payload.text || "";

  logger.debug("deliverWecomReply called", {
    hasText: !!text.trim(),
    textPreview: text.substring(0, 50),
    streamId,
    senderId,
  });

  // Handle absolute-path MEDIA lines manually; OpenClaw rejects these paths upstream.
  const mediaRegex = /^MEDIA:\s*(.+)$/gm;
  const mediaMatches = [];
  let match;
  while ((match = mediaRegex.exec(text)) !== null) {
    const mediaPath = match[1].trim();
    // Only intercept absolute filesystem paths.
    if (mediaPath.startsWith("/")) {
      mediaMatches.push({
        fullMatch: match[0],
        path: mediaPath,
      });
      logger.debug("Detected absolute path MEDIA line", {
        streamId,
        mediaPath,
        line: match[0],
      });
    }
  }

  // Queue absolute-path images; send non-image files via Agent DM.
  const mediaImageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp"]);
  let processedText = text;
  if (mediaMatches.length > 0 && streamId) {
    for (const media of mediaMatches) {
      const mediaExt = media.path.split(".").pop()?.toLowerCase() || "";
      if (mediaImageExts.has(mediaExt)) {
        // Image: queue for delivery when stream finishes.
        const queued = streamManager.queueImage(streamId, media.path);
        if (queued) {
          processedText = processedText.replace(media.fullMatch, "").trim();
          logger.info("Queued absolute path image for stream", {
            streamId,
            imagePath: media.path,
          });
        }
      } else {
        // Non-image file: WeCom Bot stream API does not support files.
        // Send via Agent DM and replace the MEDIA line with a hint.
        const mediaFilename = basename(media.path);
        const agentCfgMedia = resolveAgentConfig();
        if (agentCfgMedia && senderId) {
          try {
            const mediaBuf = await readFile(media.path);
            const uploadedMediaId = await agentUploadMedia({
              agent: agentCfgMedia,
              type: "file",
              buffer: mediaBuf,
              filename: mediaFilename,
            });
            await agentSendMedia({
              agent: agentCfgMedia,
              toUser: senderId,
              mediaId: uploadedMediaId,
              mediaType: "file",
            });
            processedText = processedText
              .replace(media.fullMatch, `📎 文件已通过私信发送给您：${mediaFilename}`)
              .trim();
            logger.info("Sent non-image file via Agent DM (MEDIA line)", {
              streamId,
              filename: mediaFilename,
              senderId,
            });
          } catch (mediaErr) {
            processedText = processedText
              .replace(media.fullMatch, `⚠️ 文件发送失败（${mediaFilename}）：${mediaErr.message}`)
              .trim();
            logger.error("Failed to send non-image file via Agent DM (MEDIA line)", {
              streamId,
              filename: mediaFilename,
              error: mediaErr.message,
            });
          }
        } else {
          // No agent configured or no sender — just strip the MEDIA line.
          processedText = processedText
            .replace(media.fullMatch, `⚠️ 无法发送文件 ${mediaFilename}（未配置 Agent API）`)
            .trim();
        }
      }
    }
  }

  // Handle payload.mediaUrl / payload.mediaUrls from OpenClaw core dispatcher.
  // These are local file paths or remote URLs that the LLM wants to deliver as media.
  const payloadMediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);
  if (payloadMediaUrls.length > 0) {
    const payloadImageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]);
    for (const mediaPath of payloadMediaUrls) {
      // Normalize sandbox: prefix
      let absPath = mediaPath;
      if (absPath.startsWith("sandbox:")) {
        absPath = absPath.replace(/^sandbox:\/{0,2}/, "");
        if (!absPath.startsWith("/")) absPath = "/" + absPath;
      }

      const isLocal = absPath.startsWith("/");
      const mediaFilename = isLocal ? basename(absPath) : (basename(new URL(mediaPath).pathname) || "file");
      const ext = mediaFilename.split(".").pop()?.toLowerCase() || "";

      if (isLocal && payloadImageExts.has(ext) && streamId) {
        // Image: queue for delivery via stream msg_item when stream finishes.
        const queued = streamManager.queueImage(streamId, absPath);
        if (queued) {
          logger.info("Queued payload image for stream", { streamId, imagePath: absPath });
        }
      } else {
        // Non-image file (or image without active stream): send via Agent DM.
        const agentCfgPayload = resolveAgentConfig();
        if (agentCfgPayload && senderId) {
          try {
            let fileBuf;
            if (isLocal) {
              fileBuf = await readFile(absPath);
            } else {
              const res = await fetch(mediaPath, { signal: AbortSignal.timeout(30_000) });
              if (!res.ok) throw new Error(`download failed: ${res.status}`);
              fileBuf = Buffer.from(await res.arrayBuffer());
            }

            // Determine upload type based on content type
            let uploadType = "file";
            if (payloadImageExts.has(ext)) uploadType = "image";

            const uploadedId = await agentUploadMedia({
              agent: agentCfgPayload,
              type: uploadType,
              buffer: fileBuf,
              filename: mediaFilename,
            });
            await agentSendMedia({
              agent: agentCfgPayload,
              toUser: senderId,
              mediaId: uploadedId,
              mediaType: uploadType,
            });

            // Add hint in stream text
            const hint = `📎 文件已通过私信发送给您：${mediaFilename}`;
            if (streamId && streamManager.hasStream(streamId)) {
              streamManager.appendStream(streamId, `\n\n${hint}`);
            } else {
              processedText = processedText ? `${processedText}\n\n${hint}` : hint;
            }
            logger.info("Sent payload media via Agent DM", {
              streamId,
              filename: mediaFilename,
              senderId,
            });
          } catch (payloadMediaErr) {
            logger.error("Failed to send payload media via Agent DM", {
              streamId,
              mediaPath: mediaPath.substring(0, 80),
              error: payloadMediaErr.message,
            });
            const errHint = `⚠️ 文件发送失败（${mediaFilename}）：${payloadMediaErr.message}`;
            if (streamId && streamManager.hasStream(streamId)) {
              streamManager.appendStream(streamId, `\n\n${errHint}`);
            } else {
              processedText = processedText ? `${processedText}\n\n${errHint}` : errHint;
            }
          }
        } else {
          const noAgentHint = `⚠️ 无法发送文件 ${mediaFilename}（未配置 Agent API）`;
          if (streamId && streamManager.hasStream(streamId)) {
            streamManager.appendStream(streamId, `\n\n${noAgentHint}`);
          } else {
            processedText = processedText ? `${processedText}\n\n${noAgentHint}` : noAgentHint;
          }
        }
      }
    }
  }

  // All outbound content is sent via stream updates.
  if (!processedText.trim()) {
    logger.debug("WeCom: empty block after processing, skipping stream update");
    return;
  }

  // Helper: append content with duplicate suppression and placeholder awareness.
  const appendToStream = (targetStreamId, content) => {
    const stream = streamManager.getStream(targetStreamId);
    if (!stream) {
      return false;
    }

    // If stream still has the placeholder, replace it entirely.
    if (stream.content.trim() === THINKING_PLACEHOLDER.trim()) {
      streamManager.replaceIfPlaceholder(targetStreamId, content, THINKING_PLACEHOLDER);
      return true;
    }

    // Skip duplicate chunks (for example, block + final overlap).
    if (stream.content.includes(content.trim())) {
      logger.debug("WeCom: duplicate content, skipping", {
        streamId: targetStreamId,
        contentPreview: content.substring(0, 30),
      });
      return true;
    }

    const separator = stream.content.length > 0 ? "\n\n" : "";
    streamManager.appendStream(targetStreamId, separator + content);
    return true;
  };

  if (!streamId) {
    // Try async context first, then fallback to active stream map.
    const ctx = streamContext.getStore();
    const contextStreamId = ctx?.streamId;
    const activeStreamId = contextStreamId ?? resolveActiveStream(senderId);

    if (activeStreamId && streamManager.hasStream(activeStreamId)) {
      appendToStream(activeStreamId, processedText);
      logger.debug("WeCom stream appended (via context/activeStreams)", {
        streamId: activeStreamId,
        source: contextStreamId ? "asyncContext" : "activeStreams",
        contentLength: processedText.length,
      });
      return;
    }
    logger.warn("WeCom: no active stream for this message", { senderId });
    return;
  }

  if (!streamManager.hasStream(streamId)) {
    logger.warn("WeCom: stream not found, attempting response_url fallback", { streamId, senderId });

    // Layer 2: Fallback via response_url (stream closed, but response_url may still be valid)
    const saved = responseUrls.get(senderId);
    if (saved && !saved.used && Date.now() < saved.expiresAt) {
      try {
        const response = await fetch(saved.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "text", text: { content: processedText } }),
        });
        const responseBody = await response.text().catch(() => "");
        const result = parseResponseUrlResult(response, responseBody);
        if (!result.accepted) {
          logger.error("WeCom: response_url fallback rejected (deliverWecomReply)", {
            senderId,
            status: response.status,
            statusText: response.statusText,
            errcode: result.errcode,
            errmsg: result.errmsg,
            bodyPreview: result.bodyPreview,
          });
        } else {
          saved.used = true;
          logger.info("WeCom: sent via response_url fallback (deliverWecomReply)", {
            senderId,
            status: response.status,
            errcode: result.errcode,
            contentPreview: processedText.substring(0, 50),
          });
          return;
        }
      } catch (err) {
        logger.error("WeCom: response_url fallback failed", {
          senderId,
          error: err.message,
        });
      }
    }

    // Layer 3: Agent API fallback (stream closed + response_url unavailable)
    const agentConfig = resolveAgentConfig();
    if (agentConfig) {
      try {
        await agentSendText({ agent: agentConfig, toUser: senderId, text: processedText });
        logger.info("WeCom: sent via Agent API fallback (deliverWecomReply)", {
          senderId,
          contentPreview: processedText.substring(0, 50),
        });
        return;
      } catch (err) {
        logger.error("WeCom: Agent API fallback failed", { senderId, error: err.message });
      }
    }
    logger.warn("WeCom: unable to deliver message (all layers exhausted)", {
      senderId,
      contentPreview: processedText.substring(0, 50),
    });
    return;
  }

  appendToStream(streamId, processedText);
  logger.debug("WeCom stream appended", {
    streamId,
    contentLength: processedText.length,
    to: senderId,
  });
}
