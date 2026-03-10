import {
  MESSAGE_STATE_CLEANUP_INTERVAL_MS,
  MESSAGE_STATE_MAX_SIZE,
  MESSAGE_STATE_TTL_MS,
  PENDING_REPLY_MAX_SIZE,
  PENDING_REPLY_TTL_MS,
} from "./constants.js";

const wsClientInstances = new Map();
const messageStates = new Map();

/**
 * Pending final replies that failed to send due to WS disconnection.
 * Keyed by accountId → array of { text, senderId, chatId, isGroupChat, createdAt }.
 * @type {Map<string, Array<{text: string, senderId: string, chatId: string, isGroupChat: boolean, createdAt: number}>>}
 */
const pendingReplies = new Map();

let cleanupTimer = null;
let cleanupUsers = 0;

function pruneMessageStates() {
  const currentTime = Date.now();
  for (const [messageId, entry] of messageStates.entries()) {
    if (currentTime - entry.createdAt >= MESSAGE_STATE_TTL_MS) {
      messageStates.delete(messageId);
    }
  }

  if (messageStates.size <= MESSAGE_STATE_MAX_SIZE) {
    return;
  }

  const oldestFirst = [...messageStates.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (const [messageId] of oldestFirst.slice(0, messageStates.size - MESSAGE_STATE_MAX_SIZE)) {
    messageStates.delete(messageId);
  }
}

export function getWsClient(accountId) {
  return wsClientInstances.get(accountId) ?? null;
}

export function setWsClient(accountId, client) {
  wsClientInstances.set(accountId, client);
}

export function removeWsClient(accountId) {
  const client = wsClientInstances.get(accountId);
  if (client) {
    try {
      client.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
  wsClientInstances.delete(accountId);
}

export function startMessageStateCleanup() {
  cleanupUsers += 1;
  if (cleanupTimer) {
    return;
  }

  cleanupTimer = setInterval(pruneMessageStates, MESSAGE_STATE_CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

export function stopMessageStateCleanup() {
  cleanupUsers = Math.max(0, cleanupUsers - 1);
  if (cleanupUsers > 0 || !cleanupTimer) {
    return;
  }

  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

export function setMessageState(messageId, state) {
  messageStates.set(messageId, {
    state,
    createdAt: Date.now(),
  });
}

export function getMessageState(messageId) {
  const entry = messageStates.get(messageId);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.createdAt >= MESSAGE_STATE_TTL_MS) {
    messageStates.delete(messageId);
    return undefined;
  }
  return entry.state;
}

export function deleteMessageState(messageId) {
  messageStates.delete(messageId);
}

/**
 * Enqueue a final reply that failed to send due to WS disconnection.
 */
export function enqueuePendingReply(accountId, entry) {
  let queue = pendingReplies.get(accountId);
  if (!queue) {
    queue = [];
    pendingReplies.set(accountId, queue);
  }
  queue.push({ ...entry, createdAt: Date.now() });
  // Evict oldest if over capacity.
  while (queue.length > PENDING_REPLY_MAX_SIZE) {
    queue.shift();
  }
}

/**
 * Drain all pending replies for an account, removing expired entries.
 * @returns {Array<{text: string, senderId: string, chatId: string, isGroupChat: boolean, createdAt: number}>}
 */
export function drainPendingReplies(accountId) {
  const queue = pendingReplies.get(accountId);
  if (!queue || queue.length === 0) {
    return [];
  }
  pendingReplies.delete(accountId);
  const now = Date.now();
  return queue.filter((entry) => now - entry.createdAt < PENDING_REPLY_TTL_MS);
}

/**
 * Check if there are pending replies for an account.
 */
export function hasPendingReplies(accountId) {
  const queue = pendingReplies.get(accountId);
  return Boolean(queue && queue.length > 0);
}

export async function cleanupWsAccount(accountId) {
  removeWsClient(accountId);
}

export async function resetWsStateForTesting() {
  for (const accountId of [...wsClientInstances.keys()]) {
    removeWsClient(accountId);
  }

  messageStates.clear();
  pendingReplies.clear();

  cleanupUsers = 0;
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
