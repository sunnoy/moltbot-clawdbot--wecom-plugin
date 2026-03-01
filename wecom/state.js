import { AsyncLocalStorage } from "node:async_hooks";
import { WEBHOOK_BOT_SEND_URL } from "./constants.js";

const runtimeState = {
  runtime: null,
  openclawConfig: null,
  ensuredDynamicAgentIds: new Set(),
  ensureDynamicAgentWriteQueue: Promise.resolve(),
};

export const dispatchLocks = new Map();
export const messageBuffers = new Map();
export const webhookTargets = new Map();
export const activeStreams = new Map();
export const activeStreamHistory = new Map();
export const streamMeta = new Map();
export const responseUrls = new Map();
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

/**
 * Extract Agent API config from the runtime openclaw config.
 * Returns null when Agent mode is not configured.
 */
export function resolveAgentConfig() {
  const config = getOpenclawConfig();
  const wecom = config?.channels?.wecom;
  const agent = wecom?.agent;
  if (!agent?.corpId || !agent?.corpSecret || !agent?.agentId) return null;
  return {
    corpId: agent.corpId,
    corpSecret: agent.corpSecret,
    agentId: agent.agentId,
  };
}

/**
 * Resolve a webhook name to a full webhook URL.
 * Supports both full URLs and bare keys in config.
 * Returns null when the webhook name is not configured.
 *
 * @param {string} name - Webhook name from the `to` field (e.g. "ops-group")
 * @returns {string|null}
 */
export function resolveWebhookUrl(name) {
  const config = getOpenclawConfig();
  const webhooks = config?.channels?.wecom?.webhooks;
  if (!webhooks || !webhooks[name]) return null;
  const value = webhooks[name];
  if (value.startsWith("http")) return value;
  return `${WEBHOOK_BOT_SEND_URL}?key=${value}`;
}
