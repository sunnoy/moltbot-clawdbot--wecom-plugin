import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../logger.js";

const DEFAULT_STATE_DIRNAME = ".openclaw";
const LEGACY_STATE_DIRNAMES = [".clawdbot", ".moldbot", ".moltbot"];

/** @type {Map<string, { mtimeMs: number; size: number; list: string[] }>} */
const welcomeMessagesFileCache = new Map();

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

function resolveOpenclawStateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
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

export function resolveWelcomeMessagesFilePath(config) {
  const raw = String(config?.welcomeMessagesFile ?? "").trim();
  if (!raw) {
    return "";
  }
  if (raw.startsWith("~")) {
    return resolveUserPath(raw);
  }
  if (path.isAbsolute(raw)) {
    return path.normalize(raw);
  }
  return path.join(resolveOpenclawStateDir(), raw);
}

function normalizeWelcomeEntry(item) {
  if (typeof item === "string") {
    const t = item.trim();
    return t || null;
  }
  if (Array.isArray(item)) {
    if (!item.every((line) => line === null || ["string", "number", "boolean"].includes(typeof line))) {
      return null;
    }
    const joined = item.map((line) => String(line ?? "")).join("\n");
    const t = joined.trim();
    return t || null;
  }
  return null;
}

function parseWelcomeMessagesJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  let list = data;
  if (!Array.isArray(data) && data && typeof data === "object" && Array.isArray(data.messages)) {
    list = data.messages;
  }
  if (!Array.isArray(list)) {
    return null;
  }

  const messages = [];
  for (const item of list) {
    const normalized = normalizeWelcomeEntry(item);
    if (normalized) {
      messages.push(normalized);
    }
  }
  return messages.length > 0 ? messages : null;
}

/**
 * Load welcome message candidates from welcomeMessagesFile.
 * Accepts: JSON array of strings; array of string arrays (lines joined with \\n); or { "messages": same }.
 * Uses mtime cache so file edits apply without restarting OpenClaw or reloading channel config.
 * @param {Record<string, unknown> | undefined} config
 * @returns {string[] | null}
 */
export function loadWelcomeMessagesFromFile(config) {
  const filePath = resolveWelcomeMessagesFilePath(config);
  if (!filePath) {
    return null;
  }

  let st;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) {
    return null;
  }

  const mtimeMs = st.mtimeMs;
  const size = st.size;
  const cached = welcomeMessagesFileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.list;
  }

  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[wecom] welcomeMessagesFile read failed (${filePath}): ${message}`);
    return null;
  }

  const list = parseWelcomeMessagesJson(text);
  if (!list) {
    logger.warn(
      `[wecom] welcomeMessagesFile invalid JSON (expect a non-empty array or { "messages": [...] }): ${filePath}`,
    );
    return null;
  }

  welcomeMessagesFileCache.set(filePath, { mtimeMs, size, list });
  return list;
}

export function clearWelcomeMessagesFileCacheForTesting() {
  welcomeMessagesFileCache.clear();
}
