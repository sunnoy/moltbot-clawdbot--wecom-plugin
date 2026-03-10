import { AsyncLocalStorage } from "node:async_hooks";
import { getWebhookBotSendUrl } from "./constants.js";
import { resolveAgentConfigForAccount, resolveDefaultAccountId, resolveAccount } from "./accounts.js";

const runtimeState = {
  runtime: null,
  openclawConfig: null,
  ensuredDynamicAgentIds: new Set(),
  ensureDynamicAgentWriteQueue: Promise.resolve(),
};

export const dispatchLocks = new Map();
export const streamContext = new AsyncLocalStorage();

export function setRuntime(runtime) {
  runtimeState.runtime = runtime;
}

export function getRuntime() {
  if (!runtimeState.runtime) {
    throw new Error("[wecom] Runtime not initialized");
  }
  return runtimeState.runtime;
}

export function setOpenclawConfig(config) {
  runtimeState.openclawConfig = config;
}

export function getOpenclawConfig() {
  return runtimeState.openclawConfig;
}

export function getEnsuredDynamicAgentIds() {
  return runtimeState.ensuredDynamicAgentIds;
}

export function getEnsureDynamicAgentWriteQueue() {
  return runtimeState.ensureDynamicAgentWriteQueue;
}

export function setEnsureDynamicAgentWriteQueue(queuePromise) {
  runtimeState.ensureDynamicAgentWriteQueue = queuePromise;
}

function resolveEffectiveAccountId(accountId) {
  if (accountId) {
    return accountId;
  }
  const contextual = streamContext.getStore()?.accountId;
  if (contextual) {
    return contextual;
  }
  return resolveDefaultAccountId(getOpenclawConfig());
}

export function resolveAgentConfig(accountId) {
  return resolveAgentConfigForAccount(getOpenclawConfig(), resolveEffectiveAccountId(accountId));
}

export function resolveAccountConfig(accountId) {
  return resolveAccount(getOpenclawConfig(), resolveEffectiveAccountId(accountId));
}

export function resolveWebhookUrl(name, accountId) {
  const account = resolveAccountConfig(accountId);
  const value = account?.config?.webhooks?.[name];
  if (!value) {
    return null;
  }
  if (String(value).startsWith("http")) {
    return String(value);
  }
  return `${getWebhookBotSendUrl()}?key=${value}`;
}

export function resetStateForTesting() {
  runtimeState.runtime = null;
  runtimeState.openclawConfig = null;
  runtimeState.ensuredDynamicAgentIds = new Set();
  runtimeState.ensureDynamicAgentWriteQueue = Promise.resolve();
  dispatchLocks.clear();
}
