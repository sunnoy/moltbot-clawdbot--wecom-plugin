const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_SEND_LIMIT = 10;
const ACTIVE_SEND_WARN_THRESHOLD = 8;
const REPLY_LIMIT = 30;
const REPLY_WARN_THRESHOLD = 24;
const MAX_TRACKED_CHATS_PER_ACCOUNT = 500;

const accountStates = new Map();

function currentDayKey(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function ensureAccountState(accountId) {
  if (!accountStates.has(accountId)) {
    accountStates.set(accountId, {
      lastInboundAt: null,
      lastOutboundAt: null,
      displaced: false,
      lastDisplacedAt: null,
      lastDisplacedReason: null,
      chats: new Map(),
    });
  }
  return accountStates.get(accountId);
}

function ensureChatState(accountState, chatId) {
  const normalizedChatId = String(chatId ?? "").trim();
  if (!normalizedChatId) {
    return null;
  }
  if (!accountState.chats.has(normalizedChatId)) {
    accountState.chats.set(normalizedChatId, {
      chatId: normalizedChatId,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastTouchedAt: 0,
      replyCount24h: 0,
      activeSendDay: currentDayKey(Date.now()),
      activeSendCountToday: 0,
    });
  }
  return accountState.chats.get(normalizedChatId);
}

function touchChatState(chatState, at) {
  chatState.lastTouchedAt = Math.max(chatState.lastTouchedAt ?? 0, at);
}

function pruneChatState(chatState, at) {
  const dayKey = currentDayKey(at);
  if (chatState.activeSendDay !== dayKey) {
    chatState.activeSendDay = dayKey;
    chatState.activeSendCountToday = 0;
  }

  if (!chatState.lastInboundAt || at - chatState.lastInboundAt >= DAY_MS) {
    chatState.replyCount24h = 0;
  }
}

function pruneAccountState(accountState, at) {
  for (const [chatId, chatState] of accountState.chats.entries()) {
    pruneChatState(chatState, at);

    const lastRelevantAt = Math.max(
      chatState.lastTouchedAt ?? 0,
      chatState.lastInboundAt ?? 0,
      chatState.lastOutboundAt ?? 0,
    );
    const hasReplyWindow = chatState.lastInboundAt && at - chatState.lastInboundAt < DAY_MS;
    const hasDailyQuotaState = chatState.activeSendCountToday > 0;
    if (!hasReplyWindow && !hasDailyQuotaState && lastRelevantAt > 0 && at - lastRelevantAt >= DAY_MS) {
      accountState.chats.delete(chatId);
    }
  }

  if (accountState.chats.size <= MAX_TRACKED_CHATS_PER_ACCOUNT) {
    return;
  }

  const oldestFirst = [...accountState.chats.entries()].sort((left, right) => {
    const leftTouched = left[1].lastTouchedAt ?? 0;
    const rightTouched = right[1].lastTouchedAt ?? 0;
    return leftTouched - rightTouched;
  });
  const excess = accountState.chats.size - MAX_TRACKED_CHATS_PER_ACCOUNT;
  for (const [chatId] of oldestFirst.slice(0, excess)) {
    accountState.chats.delete(chatId);
  }
}

function describeReplyQuota(chatState, at) {
  pruneChatState(chatState, at);
  const windowActive = Boolean(chatState.lastInboundAt && at - chatState.lastInboundAt < DAY_MS);
  const used = windowActive ? chatState.replyCount24h : 0;
  const remaining = windowActive ? Math.max(0, REPLY_LIMIT - used) : REPLY_LIMIT;
  return {
    bucket: "reply24h",
    limit: REPLY_LIMIT,
    windowActive,
    used,
    remaining,
    exhausted: windowActive && used >= REPLY_LIMIT,
    nearLimit: windowActive && used >= REPLY_WARN_THRESHOLD,
  };
}

function describeActiveQuota(chatState, at) {
  pruneChatState(chatState, at);
  const used = chatState.activeSendCountToday;
  return {
    bucket: "activeDaily",
    limit: ACTIVE_SEND_LIMIT,
    used,
    remaining: Math.max(0, ACTIVE_SEND_LIMIT - used),
    exhausted: used >= ACTIVE_SEND_LIMIT,
    nearLimit: used >= ACTIVE_SEND_WARN_THRESHOLD,
  };
}

export function forecastReplyQuota({ accountId, chatId, at = Date.now() }) {
  const accountState = ensureAccountState(accountId);
  const chatState = ensureChatState(accountState, chatId);
  if (!chatState) {
    return {
      bucket: "reply24h",
      limit: REPLY_LIMIT,
      windowActive: false,
      used: 0,
      remaining: REPLY_LIMIT,
      exhausted: false,
      nearLimit: false,
    };
  }
  return describeReplyQuota(chatState, at);
}

export function forecastActiveSendQuota({ accountId, chatId, at = Date.now() }) {
  const accountState = ensureAccountState(accountId);
  const chatState = ensureChatState(accountState, chatId);
  if (!chatState) {
    return {
      bucket: "activeDaily",
      limit: ACTIVE_SEND_LIMIT,
      windowActive: false,
      used: 0,
      remaining: ACTIVE_SEND_LIMIT,
      exhausted: false,
      nearLimit: false,
    };
  }

  const replyQuota = describeReplyQuota(chatState, at);
  if (replyQuota.windowActive && !replyQuota.exhausted) {
    return replyQuota;
  }
  return describeActiveQuota(chatState, at);
}

export function recordInboundMessage({ accountId, chatId, at = Date.now() }) {
  const accountState = ensureAccountState(accountId);
  accountState.lastInboundAt = at;

  const chatState = ensureChatState(accountState, chatId);
  if (!chatState) {
    return;
  }

  chatState.lastInboundAt = at;
  chatState.replyCount24h = 0;
  touchChatState(chatState, at);
  pruneAccountState(accountState, at);
}

export function recordPassiveReply({ accountId, chatId, at = Date.now(), countQuota = true } = {}) {
  const accountState = ensureAccountState(accountId);
  accountState.lastOutboundAt = at;

  const chatState = ensureChatState(accountState, chatId);
  if (!chatState) {
    return {
      bucket: "reply24h",
      used: 0,
      limit: REPLY_LIMIT,
      remaining: REPLY_LIMIT,
      windowActive: false,
      exhausted: false,
      nearLimit: false,
    };
  }

  chatState.lastOutboundAt = at;
  touchChatState(chatState, at);
  const quota = describeReplyQuota(chatState, at);
  if (countQuota && quota.windowActive) {
    chatState.replyCount24h += 1;
  }
  pruneAccountState(accountState, at);
  return describeReplyQuota(chatState, at);
}

export function recordActiveSend({ accountId, chatId, at = Date.now() }) {
  const accountState = ensureAccountState(accountId);
  accountState.lastOutboundAt = at;

  const chatState = ensureChatState(accountState, chatId);
  if (!chatState) {
    return {
      bucket: "activeDaily",
      used: 0,
      limit: ACTIVE_SEND_LIMIT,
      remaining: ACTIVE_SEND_LIMIT,
      windowActive: false,
      exhausted: false,
      nearLimit: false,
    };
  }

  chatState.lastOutboundAt = at;
  touchChatState(chatState, at);
  const quota = forecastActiveSendQuota({ accountId, chatId, at });
  if (quota.bucket === "reply24h" && quota.windowActive) {
    chatState.replyCount24h += 1;
  } else {
    pruneChatState(chatState, at);
    chatState.activeSendCountToday += 1;
  }
  pruneAccountState(accountState, at);
  return forecastActiveSendQuota({ accountId, chatId, at });
}

export function recordOutboundActivity({ accountId, at = Date.now() }) {
  const accountState = ensureAccountState(accountId);
  accountState.lastOutboundAt = at;
}

export function markAccountDisplaced({ accountId, reason = null, at = Date.now() }) {
  const accountState = ensureAccountState(accountId);
  accountState.displaced = true;
  accountState.lastDisplacedAt = at;
  accountState.lastDisplacedReason = reason ? String(reason) : null;
}

export function clearAccountDisplaced(accountId) {
  const accountState = ensureAccountState(accountId);
  accountState.displaced = false;
}

export function getAccountTelemetry(accountId, { now = Date.now() } = {}) {
  const accountState = accountStates.get(accountId);
  if (!accountState) {
    return {
      lastInboundAt: null,
      lastOutboundAt: null,
      connection: {
        displaced: false,
        lastDisplacedAt: null,
        lastDisplacedReason: null,
      },
      quotas: {
        trackedChats: 0,
        replyWindowChats: 0,
        totalReplyCount24h: 0,
        nearLimitReplyChats: 0,
        exhaustedReplyChats: 0,
        activeDailyChats: 0,
        totalActiveSendCountToday: 0,
        nearLimitActiveChats: 0,
        exhaustedActiveChats: 0,
      },
    };
  }

  pruneAccountState(accountState, now);

  const summary = {
    trackedChats: 0,
    replyWindowChats: 0,
    totalReplyCount24h: 0,
    nearLimitReplyChats: 0,
    exhaustedReplyChats: 0,
    activeDailyChats: 0,
    totalActiveSendCountToday: 0,
    nearLimitActiveChats: 0,
    exhaustedActiveChats: 0,
  };

  for (const chatState of accountState.chats.values()) {
    summary.trackedChats += 1;

    const replyQuota = describeReplyQuota(chatState, now);
    if (replyQuota.windowActive) {
      summary.replyWindowChats += 1;
      summary.totalReplyCount24h += replyQuota.used;
      if (replyQuota.exhausted) {
        summary.exhaustedReplyChats += 1;
      } else if (replyQuota.nearLimit) {
        summary.nearLimitReplyChats += 1;
      }
    }

    const activeQuota = describeActiveQuota(chatState, now);
    if (activeQuota.used > 0) {
      summary.activeDailyChats += 1;
      summary.totalActiveSendCountToday += activeQuota.used;
      if (activeQuota.exhausted) {
        summary.exhaustedActiveChats += 1;
      } else if (activeQuota.nearLimit) {
        summary.nearLimitActiveChats += 1;
      }
    }
  }

  return {
    lastInboundAt: accountState.lastInboundAt,
    lastOutboundAt: accountState.lastOutboundAt,
    connection: {
      displaced: accountState.displaced,
      lastDisplacedAt: accountState.lastDisplacedAt,
      lastDisplacedReason: accountState.lastDisplacedReason,
    },
    quotas: summary,
  };
}

export function resetRuntimeTelemetryForTesting() {
  accountStates.clear();
}
