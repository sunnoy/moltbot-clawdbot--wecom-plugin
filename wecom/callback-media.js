/**
 * WeCom self-built app callback media downloader.
 *
 * Downloads inbound media (image/voice/file) from WeCom via the
 * Agent API `/cgi-bin/media/get` endpoint using the access token
 * obtained from the self-built app credentials.
 */

import path from "node:path";
import { logger } from "../logger.js";
import { getAccessToken } from "./agent-api.js";
import { wecomFetch } from "./http.js";
import { AGENT_API_ENDPOINTS, CALLBACK_MEDIA_DOWNLOAD_TIMEOUT_MS } from "./constants.js";

function resolveManagedCallbackMediaDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  const stateDir = override || path.join(process.env.HOME || "/tmp", ".openclaw");
  return path.join(stateDir, "media", "wecom");
}

/**
 * Download a WeCom media file (image / voice / file) by MediaId via the
 * self-built app access token and save it through the core media runtime.
 *
 * @param {object} params
 * @param {object} params.agent   - { corpId, corpSecret, agentId }
 * @param {string} params.mediaId - WeCom MediaId
 * @param {"image"|"voice"|"file"} params.type - media type hint
 * @param {object} [params.mediaRuntime] - OpenClaw media runtime (for saveMediaBuffer)
 * @param {object} params.config  - OpenClaw config (for mediaMaxMb)
 * @returns {Promise<{ path: string, contentType: string }>}
 */
export async function downloadCallbackMedia({ agent, mediaId, type, mediaRuntime, config }) {
  const token = await getAccessToken(agent);
  const url = `${AGENT_API_ENDPOINTS.DOWNLOAD_MEDIA}?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;

  const mediaMaxMb = config?.agents?.defaults?.mediaMaxMb ?? 5;
  const maxBytes = mediaMaxMb * 1024 * 1024;

  let response;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CALLBACK_MEDIA_DOWNLOAD_TIMEOUT_MS);
  try {
    response = await wecomFetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`WeCom media download failed: HTTP ${response.status} for mediaId=${mediaId}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType =
    response.headers.get("content-type") ||
    (type === "image" ? "image/jpeg" : "application/octet-stream");

  // Try to extract the filename from Content-Disposition
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename[*\s]*=\s*(?:UTF-8''|")?([^";]+)/i);
  const filename =
    filenameMatch?.[1]?.trim() ||
    (type === "image" ? `${mediaId}.jpg` : type === "voice" ? `${mediaId}.amr` : mediaId);

  // Save via core media runtime when available
  if (typeof mediaRuntime?.saveMediaBuffer === "function") {
    const saved = await mediaRuntime.saveMediaBuffer(buffer, contentType, "inbound", maxBytes, filename);
    return { path: saved.path, contentType: saved.contentType };
  }

  // Fallback: keep callback media under the managed OpenClaw media root so
  // stageSandboxMedia can safely copy it into the agent sandbox later.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const ext = path.extname(filename) || (type === "image" ? ".jpg" : ".bin");
  const mediaDir = resolveManagedCallbackMediaDir();
  const tempPath = path.join(
    mediaDir,
    `wecom-cb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  );
  await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  await writeFile(tempPath, buffer);
  logger.debug(`[CB] Media saved to managed path: ${tempPath}`);
  return { path: tempPath, contentType };
}
