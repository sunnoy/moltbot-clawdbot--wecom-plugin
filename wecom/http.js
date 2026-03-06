/**
 * Unified HTTP client for WeCom API calls.
 *
 * Wraps `undici` fetch with optional proxy support (ProxyAgent) and
 * AbortSignal timeout merging.  All outbound requests to qyapi.weixin.qq.com
 * should go through `wecomFetch()` so that proxy / timeout behaviour is
 * consistent across the plugin.
 *
 * Proxy URL resolution order:
 *   1. Explicit `opts.proxyUrl` parameter
 *   2. Environment variable `WECOM_EGRESS_PROXY_URL`
 *   3. Config: `channels.wecom.network.egressProxyUrl`
 */

import { logger } from "../logger.js";
import { AGENT_API_REQUEST_TIMEOUT_MS } from "./constants.js";

// ── Lazy-loaded undici (optional dependency) ──────────────────────────

let _undici = null;

async function getUndici() {
  if (_undici) return _undici;
  try {
    _undici = await import("undici");
  } catch {
    _undici = null;
  }
  return _undici;
}

// ── ProxyAgent cache ──────────────────────────────────────────────────

const proxyDispatchers = new Map();

async function getProxyDispatcher(proxyUrl) {
  const existing = proxyDispatchers.get(proxyUrl);
  if (existing) return existing;

  const undici = await getUndici();
  if (!undici?.ProxyAgent) {
    throw new Error(
      "undici is required for proxy support. Install it with: npm install undici",
    );
  }

  const created = new undici.ProxyAgent(proxyUrl);
  proxyDispatchers.set(proxyUrl, created);
  return created;
}

// ── Signal merge helper ───────────────────────────────────────────────

function mergeAbortSignal({ signal, timeoutMs }) {
  const signals = [];
  if (signal) signals.push(signal);
  if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

// ── Proxy URL resolution ──────────────────────────────────────────────

let _configProxyUrl = "";
let _proxyWarningLogged = false;

/**
 * Set the proxy URL from plugin config (called once during plugin load).
 * @param {string} url
 */
export function setConfigProxyUrl(url) {
  _configProxyUrl = (url || "").trim();
}

/**
 * Resolve the effective proxy URL.
 * Priority: explicit > env > config.
 * @param {string} [explicit]
 * @returns {string}
 */
function resolveProxyUrl(explicit) {
  if (explicit?.trim()) return explicit.trim();
  const env = (
    process.env.WECOM_EGRESS_PROXY_URL || ""
  ).trim();
  if (env) return env;
  return _configProxyUrl;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Fetch wrapper with proxy and timeout support.
 *
 * @param {string | URL} input
 * @param {RequestInit} [init]
 * @param {{ proxyUrl?: string, timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<Response>}
 */
export async function wecomFetch(input, init, opts) {
  const proxyUrl = resolveProxyUrl(opts?.proxyUrl);
  const timeoutMs = opts?.timeoutMs ?? AGENT_API_REQUEST_TIMEOUT_MS;

  const signal = mergeAbortSignal({
    signal: opts?.signal ?? init?.signal,
    timeoutMs,
  });

  if (proxyUrl) {
    // Use undici fetch with ProxyAgent dispatcher
    const undici = await getUndici();
    if (undici?.fetch && undici?.ProxyAgent) {
      const dispatcher = await getProxyDispatcher(proxyUrl);
      return undici.fetch(input, {
        ...(init ?? {}),
        ...(signal ? { signal } : {}),
        dispatcher,
      });
    }
    // undici not available — log warning and fall through to native fetch (no proxy).
    // This is a common cause of proxy misconfiguration (issue #79).
    if (!_proxyWarningLogged) {
      _proxyWarningLogged = true;
      logger.error(
        "[wecom/http] Proxy configured but undici is not available — requests will go DIRECT without proxy. " +
        "Install undici (npm install undici) to enable proxy support.",
        { proxyUrl },
      );
    }
  }

  // Native fetch (no proxy)
  return fetch(input, {
    ...(init ?? {}),
    ...(signal ? { signal } : {}),
  });
}
