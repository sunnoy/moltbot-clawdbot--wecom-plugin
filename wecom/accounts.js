import { logger } from "../logger.js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_WS_URL } from "./constants.js";

const RESERVED_KEYS = new Set([
  "enabled",
  "name",
  "botId",
  "secret",
  "websocketUrl",
  "sendThinkingMessage",
  "welcomeMessage",
  "welcomeMessagesFile",
  "allowFrom",
  "dmPolicy",
  "groupPolicy",
  "groupAllowFrom",
  "groups",
  "commands",
  "dynamicAgents",
  "dm",
  "groupChat",
  "adminUsers",
  "workspaceTemplate",
  "workspaceTemplateExtraFiles",
  "agent",
  "webhooks",
  "network",
  "defaultAccount",
  "deliveryMode",
]);

const SHARED_MULTI_ACCOUNT_KEYS = new Set([
  "enabled",
  "websocketUrl",
  "sendThinkingMessage",
  "welcomeMessage",
  "welcomeMessagesFile",
  "allowFrom",
  "dmPolicy",
  "groupPolicy",
  "groupAllowFrom",
  "groups",
  "commands",
  "dynamicAgents",
  "dm",
  "groupChat",
  "adminUsers",
  "workspaceTemplate",
  "workspaceTemplateExtraFiles",
  "agent",
  "webhooks",
  "network",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAccountKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const cloned = {};
  for (const [key, entry] of Object.entries(value)) {
    cloned[key] = cloneValue(entry);
  }
  return cloned;
}

function pruneEmptyObjects(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneEmptyObjects(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    const pruned = pruneEmptyObjects(entry);
    if (pruned === undefined) {
      continue;
    }
    if (isPlainObject(pruned) && Object.keys(pruned).length === 0) {
      continue;
    }
    next[key] = pruned;
  }
  return next;
}

function mergeConfig(base, override) {
  const result = isPlainObject(base) ? cloneValue(base) : {};
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) {
      delete result[key];
      continue;
    }
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeConfig(result[key], value);
      continue;
    }
    result[key] = cloneValue(value);
  }
  return pruneEmptyObjects(result);
}

function getWecomConfig(cfg) {
  return isPlainObject(cfg?.channels?.wecom) ? cfg.channels.wecom : {};
}

function getAccountEntries(wecom) {
  const entries = [];
  for (const [key, value] of Object.entries(wecom ?? {})) {
    if (RESERVED_KEYS.has(key) || !isPlainObject(value)) {
      continue;
    }
    const accountId = normalizeAccountKey(key);
    if (!accountId) {
      continue;
    }
    entries.push({ key, accountId, value });
  }
  return entries;
}

function hasDictionaryAccounts(wecom) {
  return getAccountEntries(wecom).length > 0;
}

function getSharedMultiAccountConfig(wecom) {
  const shared = {};
  for (const [key, value] of Object.entries(wecom ?? {})) {
    if (SHARED_MULTI_ACCOUNT_KEYS.has(key)) {
      shared[key] = cloneValue(value);
    }
  }
  return shared;
}

function findEntryByAccountId(wecom, accountId) {
  return getAccountEntries(wecom).find((entry) => entry.accountId === accountId) ?? null;
}

function buildAccount(accountId, config, meta = {}) {
  const safeConfig = isPlainObject(config) ? cloneValue(config) : {};
  const agent = isPlainObject(safeConfig.agent) ? safeConfig.agent : {};
  const botId = String(safeConfig.botId ?? "").trim();
  const secret = String(safeConfig.secret ?? "").trim();
  const websocketUrl = String(safeConfig.websocketUrl ?? DEFAULT_WS_URL).trim() || DEFAULT_WS_URL;
  const enabled = safeConfig.enabled ?? Object.keys(safeConfig).length > 0;
  const configured = Boolean(botId && secret);
  const agentConfigured = Boolean(agent.corpId && agent.corpSecret && agent.agentId);

  const callbackRaw = isPlainObject(agent.callback) ? agent.callback : {};
  const callbackToken = String(callbackRaw.token ?? "").trim();
  const callbackAESKey = String(callbackRaw.encodingAESKey ?? "").trim();
  const callbackPath = String(callbackRaw.path ?? "").trim() || "/api/channels/wecom/callback";
  const callbackConfigured = Boolean(callbackToken && callbackAESKey && agent.corpId);
  // "markdown" enables WeCom markdown format for agent API replies; default "markdown"
  const agentReplyFormat = String(agent.replyFormat ?? "markdown").trim() === "text" ? "text" : "markdown";

  return {
    accountId,
    name: String(safeConfig.name ?? accountId ?? DEFAULT_ACCOUNT_ID).trim() || accountId,
    enabled,
    configured,
    botId,
    secret,
    websocketUrl,
    sendThinkingMessage: safeConfig.sendThinkingMessage !== false,
    config: safeConfig,
    configPath: meta.configPath ?? `channels.wecom.${accountId}`,
    storageMode: meta.storageMode ?? "dictionary",
    entryKey: meta.entryKey ?? accountId,
    agentConfigured,
    callbackConfigured,
    webhooksConfigured: isPlainObject(safeConfig.webhooks) && Object.keys(safeConfig.webhooks).length > 0,
    agentReplyFormat,
    agentCredentials: agentConfigured
      ? {
          corpId: String(agent.corpId),
          corpSecret: String(agent.corpSecret),
          agentId: agent.agentId,
        }
      : null,
    callbackConfig: callbackConfigured
      ? {
          token: callbackToken,
          encodingAESKey: callbackAESKey,
          path: callbackPath,
          corpId: String(agent.corpId),
        }
      : null,
  };
}

function buildDisabledAccount(accountId) {
  return buildAccount(
    accountId,
    { enabled: false },
    { configPath: `channels.wecom.${accountId}`, storageMode: "dictionary", entryKey: accountId },
  );
}

export function isDictionaryAccountConfig(cfg) {
  return hasDictionaryAccounts(getWecomConfig(cfg));
}

export function listAccountIds(cfg) {
  const entries = getAccountEntries(getWecomConfig(cfg));
  if (entries.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...new Set(entries.map((entry) => entry.accountId))].sort((left, right) => left.localeCompare(right));
}

export function resolveDefaultAccountId(cfg) {
  const preferred = normalizeAccountKey(getWecomConfig(cfg)?.defaultAccount);
  const ids = listAccountIds(cfg);
  if (preferred && ids.includes(preferred)) {
    return preferred;
  }
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function normalizeAccountId(accountId) {
  return normalizeAccountKey(accountId) || DEFAULT_ACCOUNT_ID;
}

export function resolveAccount(cfg, accountId) {
  const wecom = getWecomConfig(cfg);
  const requestedId = normalizeAccountKey(accountId) || resolveDefaultAccountId(cfg);

  if (!hasDictionaryAccounts(wecom)) {
    if (requestedId !== DEFAULT_ACCOUNT_ID) {
      return buildDisabledAccount(requestedId);
    }
    return buildAccount(DEFAULT_ACCOUNT_ID, wecom, {
      configPath: "channels.wecom",
      storageMode: "single",
      entryKey: DEFAULT_ACCOUNT_ID,
    });
  }

  const shared = getSharedMultiAccountConfig(wecom);
  const entry = findEntryByAccountId(wecom, requestedId);
  if (!entry) {
    return buildDisabledAccount(requestedId);
  }

  return buildAccount(requestedId, mergeConfig(shared, entry.value), {
    configPath: `channels.wecom.${entry.key}`,
    storageMode: "dictionary",
    entryKey: entry.key,
  });
}

export function resolveAllAccounts(cfg) {
  const accounts = new Map();
  for (const accountId of listAccountIds(cfg)) {
    accounts.set(accountId, resolveAccount(cfg, accountId));
  }
  return accounts;
}

export function resolveAgentConfigForAccount(cfg, accountId) {
  return resolveAccount(cfg, accountId)?.agentCredentials ?? null;
}

export function resolveAllowFromForAccount(cfg, accountId) {
  const account = resolveAccount(cfg, accountId);
  const allowFrom = account?.config?.allowFrom;
  return Array.isArray(allowFrom) ? allowFrom.map((entry) => String(entry)) : [];
}

export function detectAccountConflicts(cfg) {
  const conflicts = [];
  const botOwners = new Map();
  const agentOwners = new Map();

  for (const [accountId, account] of resolveAllAccounts(cfg)) {
    if (!account.enabled) {
      continue;
    }

    if (account.botId) {
      const botKey = account.botId.toLowerCase();
      if (botOwners.has(botKey)) {
        const owner = botOwners.get(botKey);
        conflicts.push({
          type: "duplicate_bot_id",
          accounts: [owner, accountId],
          message: `账号 "${accountId}" 与 "${owner}" 使用了相同的 botId。`,
        });
      } else {
        botOwners.set(botKey, accountId);
      }
    }

    if (account.agentCredentials) {
      const agentKey = `${account.agentCredentials.corpId}:${account.agentCredentials.agentId}`;
      if (agentOwners.has(agentKey)) {
        const owner = agentOwners.get(agentKey);
        conflicts.push({
          type: "duplicate_agent",
          accounts: [owner, accountId],
          message: `账号 "${accountId}" 与 "${owner}" 使用了相同的 Agent 配置 (${account.agentCredentials.corpId}/${account.agentCredentials.agentId})。`,
        });
      } else {
        agentOwners.set(agentKey, accountId);
      }
    }
  }

  return conflicts;
}

export function updateAccountConfig(cfg, accountId, patch, options = {}) {
  const normalizedId = normalizeAccountKey(accountId) || DEFAULT_ACCOUNT_ID;
  const wecom = getWecomConfig(cfg);
  const nextChannels = { ...(cfg?.channels ?? {}) };

  if (normalizedId === DEFAULT_ACCOUNT_ID && !hasDictionaryAccounts(wecom) && options.forceDictionary !== true) {
    nextChannels.wecom = mergeConfig(wecom, patch);
    return { ...cfg, channels: nextChannels };
  }

  const nextWecom = { ...wecom };
  const existingEntry = findEntryByAccountId(wecom, normalizedId);
  const entryKey = existingEntry?.key ?? normalizedId;
  const previousEntry = isPlainObject(nextWecom[entryKey]) ? nextWecom[entryKey] : {};
  const nextEntry = mergeConfig(previousEntry, patch);

  if (Object.keys(nextEntry).length > 0) {
    nextWecom[entryKey] = nextEntry;
  } else {
    delete nextWecom[entryKey];
  }

  nextChannels.wecom = nextWecom;
  return { ...cfg, channels: nextChannels };
}

export function setAccountConfig(cfg, accountId, patch, options = {}) {
  return updateAccountConfig(cfg, accountId, patch, options);
}

export function setAccountEnabled({ cfg, accountId = DEFAULT_ACCOUNT_ID, enabled }) {
  return updateAccountConfig(cfg, accountId, { enabled });
}

export function deleteAccount({ cfg, accountId = DEFAULT_ACCOUNT_ID }) {
  return deleteAccountConfig(cfg, accountId);
}

export function clearAccountCredentials({ cfg, accountId = DEFAULT_ACCOUNT_ID }) {
  return updateAccountConfig(
    cfg,
    accountId,
    {
      botId: "",
      secret: "",
      websocketUrl: undefined,
    },
    { forceDictionary: accountId !== DEFAULT_ACCOUNT_ID },
  );
}

export function resolveAccountBasePath(cfg, accountId) {
  const account = resolveAccount(cfg, accountId);
  return account?.configPath ?? "channels.wecom";
}

export function deleteAccountConfig(cfg, accountId) {
  const normalizedId = normalizeAccountKey(accountId) || DEFAULT_ACCOUNT_ID;
  const wecom = getWecomConfig(cfg);
  const nextChannels = { ...(cfg?.channels ?? {}) };

  if (normalizedId === DEFAULT_ACCOUNT_ID && !hasDictionaryAccounts(wecom)) {
    delete nextChannels.wecom;
    return { ...cfg, channels: nextChannels };
  }

  const nextWecom = { ...wecom };
  const existingEntry = findEntryByAccountId(wecom, normalizedId);
  if (existingEntry) {
    delete nextWecom[existingEntry.key];
  }
  nextChannels.wecom = nextWecom;
  return { ...cfg, channels: nextChannels };
}

export function describeAccount(account) {
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    botId: account.botId,
    websocketUrl: account.websocketUrl,
  };
}

export function logAccountConflicts(cfg) {
  for (const conflict of detectAccountConflicts(cfg)) {
    logger.error(`[wecom/accounts] ${conflict.message}`, {
      type: conflict.type,
      accounts: conflict.accounts,
    });
  }
}
