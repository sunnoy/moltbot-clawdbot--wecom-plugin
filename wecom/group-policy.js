import { normalizeWecomAllowFromEntry } from "./allow-from.js";

function normalizeGroupEntry(entry) {
  const trimmed = String(entry ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed.replace(/^wecom:/i, "").replace(/^(group|chat):/i, "").trim().toLowerCase();
}

function resolveGroupConfig(accountConfig, groupId) {
  const groups = accountConfig?.groups;
  if (!groups || typeof groups !== "object") {
    return null;
  }

  const normalizedGroupId = String(groupId ?? "").trim().toLowerCase();
  if (!normalizedGroupId) {
    return groups["*"] ?? null;
  }

  for (const [key, value] of Object.entries(groups)) {
    if (String(key).trim().toLowerCase() === normalizedGroupId) {
      return value;
    }
  }

  return groups["*"] ?? null;
}

function isGroupAllowed(groupId, allowFrom, policy) {
  if (policy === "disabled") {
    return false;
  }
  if (policy === "open") {
    return true;
  }

  const normalizedGroupId = String(groupId ?? "").trim().toLowerCase();
  const normalizedAllowFrom = (allowFrom ?? []).map(normalizeGroupEntry).filter(Boolean);
  if (normalizedAllowFrom.includes("*")) {
    return true;
  }
  return normalizedAllowFrom.includes(normalizedGroupId);
}

export function isSenderAllowed(senderId, allowFrom) {
  const normalizedSender = normalizeWecomAllowFromEntry(senderId);
  const normalizedAllowFrom = (allowFrom ?? []).map(normalizeWecomAllowFromEntry).filter(Boolean);

  if (normalizedAllowFrom.includes("*")) {
    return true;
  }

  return normalizedAllowFrom.includes(normalizedSender);
}

export function checkGroupPolicy({ chatId, senderId, account, config }) {
  const groupPolicy =
    account?.config?.groupPolicy ??
    config?.channels?.wecom?.groupPolicy ??
    "open";

  const groupAllowFrom =
    account?.config?.groupAllowFrom ??
    config?.channels?.wecom?.groupAllowFrom ??
    [];

  if (!isGroupAllowed(chatId, groupAllowFrom, groupPolicy)) {
    return { allowed: false };
  }

  const groupConfig = resolveGroupConfig(account?.config, chatId);
  const senderAllowFrom = Array.isArray(groupConfig?.allowFrom) ? groupConfig.allowFrom : [];
  if (senderAllowFrom.length === 0) {
    return { allowed: true };
  }

  return {
    allowed: isSenderAllowed(senderId, senderAllowFrom),
  };
}
