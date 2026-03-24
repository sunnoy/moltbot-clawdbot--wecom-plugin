import { resolveWecomTarget } from "./target.js";

const OUTBOUND_SENDER_PROTOCOL_PATTERN = /^\s*\[\[\s*sender\s*:\s*([^\]\r\n]+?)\s*\]\]\s*(?:\r?\n)?/i;

function sanitizeSenderLabel(value) {
  return String(value ?? "")
    .replace(/[\[\]\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildVisibleContent(sender, body) {
  const normalizedSender = sanitizeSenderLabel(sender);
  if (!normalizedSender) {
    return String(body ?? "");
  }

  const normalizedBody = String(body ?? "").replace(/^\r?\n/, "");
  if (!normalizedBody.trim()) {
    return `【sender:${normalizedSender}】`;
  }
  if (normalizedBody.includes("\n")) {
    return `【sender:${normalizedSender}】\n${normalizedBody}`;
  }
  return `【sender:${normalizedSender}】${normalizedBody.trimStart()}`;
}

function resolveDynamicSender(agentId) {
  const normalized = String(agentId ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const dmMatch = normalized.match(/^wecom-(?:(.+?)-)?dm-(.+)$/);
  if (dmMatch?.[2]) {
    return {
      kind: "user",
      id: dmMatch[2],
      label: dmMatch[2],
    };
  }

  const groupMatch = normalized.match(/^wecom-(?:(.+?)-)?group-(.+)$/);
  if (groupMatch?.[2]) {
    return {
      kind: "group",
      id: groupMatch[2],
      label: `group:${groupMatch[2]}`,
    };
  }

  return null;
}

export function resolveOutboundSenderLabel(agentId) {
  const sender = resolveDynamicSender(agentId);
  if (sender?.label) {
    return sender.label;
  }

  const normalized = String(agentId ?? "").trim().toLowerCase();
  return normalized || "main";
}

export function ensureOutboundSenderProtocol(content, sender) {
  const raw = String(content ?? "");
  const normalizedSender = sanitizeSenderLabel(sender);
  if (!normalizedSender || OUTBOUND_SENDER_PROTOCOL_PATTERN.test(raw)) {
    return raw;
  }
  return raw ? `[[sender:${normalizedSender}]]\n${raw}` : `[[sender:${normalizedSender}]]`;
}

export function prepareWecomMessageToolParams(params, agentId) {
  const action = String(params?.action ?? "").trim().toLowerCase();
  if (action !== "send" && action !== "sendattachment") {
    return params;
  }

  const channel = String(params?.channel ?? "").trim().toLowerCase();
  const sender = resolveDynamicSender(agentId);
  if ((!channel && !sender) || (channel && channel !== "wecom")) {
    return params;
  }

  const target = typeof params?.target === "string" ? params.target.trim() : "";
  const message = typeof params?.message === "string" ? params.message : "";
  if (!sender || !target || !message) {
    return params;
  }

  const resolvedTarget = resolveWecomTarget(target);
  const normalizedSenderId = sender.id.toLowerCase();
  const isSameDirectTarget =
    sender.kind === "user" &&
    typeof resolvedTarget?.toUser === "string" &&
    resolvedTarget.toUser.trim().toLowerCase() === normalizedSenderId;
  const isSameGroupTarget =
    sender.kind === "group" &&
    typeof resolvedTarget?.chatId === "string" &&
    resolvedTarget.chatId.trim().toLowerCase() === normalizedSenderId;
  if (isSameDirectTarget || isSameGroupTarget) {
    return params;
  }

  const nextMessage = ensureOutboundSenderProtocol(message, sender.label);
  if (nextMessage === message) {
    return params;
  }

  return {
    ...params,
    message: nextMessage,
  };
}

export function applyOutboundSenderProtocol(content) {
  const raw = String(content ?? "");
  const match = raw.match(OUTBOUND_SENDER_PROTOCOL_PATTERN);
  if (!match) {
    return {
      sender: "",
      content: raw,
      usedProtocol: false,
    };
  }

  const sender = sanitizeSenderLabel(match[1]);
  if (!sender) {
    return {
      sender: "",
      content: raw,
      usedProtocol: false,
    };
  }

  return {
    sender,
    content: buildVisibleContent(sender, raw.slice(match[0].length)),
    usedProtocol: true,
  };
}
