/**
 * WeCom Target Resolver
 *
 * Parses an OpenClaw `to` field (raw target string) into a concrete WeCom
 * recipient object ({ toUser, toParty, toTag, chatId }).
 *
 * Supports explicit prefixes (party:, tag:, etc.) and heuristic fallback.
 */

import { readdirSync } from "node:fs";
import { pinyin } from "pinyin-pro";
import { resolveStateDir } from "./openclaw-compat.js";

let knownUserIdsCache = {
  loadedAt: 0,
  stateDir: "",
  userIds: [],
};

function getKnownWecomUserIds() {
  const now = Date.now();
  const stateDir = resolveStateDir();
  if (knownUserIdsCache.stateDir === stateDir && now - knownUserIdsCache.loadedAt < 5_000) {
    return knownUserIdsCache.userIds;
  }

  try {
    const agentDirs = readdirSync(`${stateDir}/agents`, { withFileTypes: true });
    const userIds = [];
    for (const entry of agentDirs) {
      if (!entry.isDirectory()) {
        continue;
      }
      const match = entry.name.match(/^wecom-(?:(.+?)-)?dm-(.+)$/);
      if (match?.[2]) {
        userIds.push(match[2].toLowerCase());
      }
    }
    knownUserIdsCache = {
      loadedAt: now,
      stateDir,
      userIds: [...new Set(userIds)],
    };
  } catch {
    knownUserIdsCache = {
      loadedAt: now,
      stateDir,
      userIds: [],
    };
  }

  return knownUserIdsCache.userIds;
}

function transliterateChineseNameToUserId(value) {
  const collapsed = String(value ?? "").replace(/[\s·•・]/g, "");
  if (!collapsed || !/^\p{Script=Han}+$/u.test(collapsed)) {
    return "";
  }

  return pinyin(collapsed, { toneType: "none", type: "array" }).join("").toLowerCase();
}

function resolveKnownWecomUserId(value) {
  const needle = String(value ?? "").trim().toLowerCase();
  if (!needle) {
    return "";
  }

  const candidates = getKnownWecomUserIds();
  if (candidates.length === 0) {
    return "";
  }

  if (candidates.includes(needle)) {
    return needle;
  }

  const suffixMatches = candidates.filter((candidate) => candidate.endsWith(needle));
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }

  const containsMatches = candidates.filter((candidate) => candidate.includes(needle));
  if (containsMatches.length === 1) {
    return containsMatches[0];
  }

  return "";
}

/**
 * @param {string|undefined} raw
 * @returns {{ webhook?: string, toUser?: string, toParty?: string, toTag?: string, chatId?: string } | undefined}
 */
export function resolveWecomTarget(raw) {
  if (!raw?.trim()) return undefined;

  // 0. Webhook bot target (before namespace stripping).
  if (/^webhook:/i.test(raw.trim())) {
    return { webhook: raw.trim().replace(/^webhook:/i, "").trim() };
  }

  // 1. Remove standard namespace prefixes.
  let clean = raw.trim().replace(/^(wecom-agent|wecom|wechatwork|wework|qywx):/i, "");

  // 2. Explicit type prefixes.
  if (/^party:/i.test(clean)) {
    return { toParty: clean.replace(/^party:/i, "").trim() };
  }
  if (/^dept:/i.test(clean)) {
    return { toParty: clean.replace(/^dept:/i, "").trim() };
  }
  if (/^tag:/i.test(clean)) {
    return { toTag: clean.replace(/^tag:/i, "").trim() };
  }
  if (/^group:/i.test(clean)) {
    return { chatId: clean.replace(/^group:/i, "").trim() };
  }
  if (/^chat:/i.test(clean)) {
    return { chatId: clean.replace(/^chat:/i, "").trim() };
  }
  if (/^user:/i.test(clean)) {
    return { toUser: clean.replace(/^user:/i, "").trim() };
  }

  // 3. Heuristics (no explicit prefix).
  // Chat IDs typically start with "wr" (external) or "wc".
  if (/^(wr|wc)/i.test(clean)) {
    return { chatId: clean };
  }
  // Short pure-digit strings (≤6 digits) are department (party) IDs.
  // Longer digit strings (phone numbers, external IDs) fall through to toUser.
  if (/^\d{1,6}$/.test(clean)) {
    return { toParty: clean };
  }

  const pinyinUserId = transliterateChineseNameToUserId(clean);
  if (pinyinUserId) {
    return { toUser: resolveKnownWecomUserId(pinyinUserId) || pinyinUserId };
  }

  // Default: treat as user ID.
  return { toUser: resolveKnownWecomUserId(clean) || clean };
}
