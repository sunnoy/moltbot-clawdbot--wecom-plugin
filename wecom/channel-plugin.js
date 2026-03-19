import crypto from "node:crypto";
import { basename } from "node:path";
import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  formatPairingApproveHint,
} from "openclaw/plugin-sdk";
import { logger } from "../logger.js";
import { splitTextByByteLimit } from "../utils.js";
import {
  deleteAccountConfig,
  describeAccount,
  detectAccountConflicts,
  listAccountIds,
  logAccountConflicts,
  resolveAccount,
  resolveAllowFromForAccount,
  resolveDefaultAccountId,
  updateAccountConfig,
} from "./accounts.js";
import { agentSendMedia, agentSendText, agentUploadMedia } from "./agent-api.js";
import { setConfigProxyUrl, wecomFetch } from "./http.js";
import { wecomOnboardingAdapter } from "./onboarding.js";
import { getAccountTelemetry, recordOutboundActivity } from "./runtime-telemetry.js";
import { getOpenclawConfig, getRuntime, setOpenclawConfig } from "./state.js";
import { resolveWecomTarget } from "./target.js";
import { webhookSendFile, webhookSendImage, webhookSendMarkdown, webhookUploadFile } from "./webhook-bot.js";
import { loadOutboundMediaFromUrl as loadOutboundMediaFromUrlCompat } from "./openclaw-compat.js";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_WS_URL,
  TEXT_CHUNK_LIMIT,
  getWebhookBotSendUrl,
  setApiBaseUrl,
} from "./constants.js";
import { uploadAndSendMedia } from "./media-uploader.js";
import { getExtendedMediaLocalRoots } from "./openclaw-compat.js";
import { extractParentAgentId } from "./parent-resolver.js";
import { sendWsMessage, startWsMonitor } from "./ws-monitor.js";
import { getWsClient } from "./ws-state.js";

function normalizePairingEntry(entry) {
  return String(entry ?? "")
    .trim()
    .replace(/^(wecom|wework):/i, "")
    .replace(/^user:/i, "");
}

function normalizeAllowFromEntries(allowFrom) {
  return allowFrom
    .map((entry) => normalizePairingEntry(entry))
    .filter(Boolean);
}

function buildConfigPath(account, field) {
  return field ? `${account.configPath}.${field}` : account.configPath;
}

function resolveRuntimeTextChunker(text, limit) {
  let runtime = null;
  try {
    runtime = getRuntime();
  } catch {}
  const chunker = runtime?.channel?.text?.chunkMarkdownText;
  if (typeof chunker === "function") {
    return chunker(text, limit);
  }
  return splitTextByByteLimit(text, limit);
}

function normalizeMediaPath(mediaUrl) {
  let value = String(mediaUrl ?? "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("sandbox:")) {
    value = value.replace(/^sandbox:\/{0,2}/, "");
    if (!value.startsWith("/")) {
      value = `/${value}`;
    }
  }
  return value;
}

async function loadMediaPayload(mediaUrl, { accountConfig, mediaLocalRoots } = {}) {
  const normalized = normalizeMediaPath(mediaUrl);
  let runtime = null;
  try {
    runtime = getRuntime();
  } catch {}

  const loaded = await loadOutboundMediaFromUrlCompat(normalized, {
    accountConfig,
    fetchImpl: wecomFetch,
    mediaLocalRoots,
    runtimeLoadMedia:
      typeof runtime?.media?.loadWebMedia === "function"
        ? (path, options) => runtime.media.loadWebMedia(path, options)
        : undefined,
  });

  return {
    buffer: loaded.buffer,
    filename: loaded.fileName || basename(normalized) || "file",
    contentType: loaded.contentType || "",
  };
}

async function loadResolvedMedia(mediaUrl, { accountConfig, mediaLocalRoots } = {}) {
  const media = await loadMediaPayload(mediaUrl, { accountConfig, mediaLocalRoots });
  return {
    ...media,
    mediaType: resolveAgentMediaType(media.filename, media.contentType),
  };
}

function resolveAgentMediaType(filename, contentType) {
  if (String(contentType).toLowerCase().startsWith("image/")) {
    return "image";
  }
  const ext = String(filename ?? "")
    .split(".")
    .pop()
    ?.toLowerCase();
  return new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]).has(ext) ? "image" : "file";
}

export function resolveAgentMediaTypeFromFilename(filename) {
  return resolveAgentMediaType(filename, "");
}

function resolveOutboundAccountId(cfg, accountId) {
  return accountId || resolveDefaultAccountId(cfg);
}

function applyNetworkConfig(cfg, accountId) {
  const account = resolveAccount(cfg, accountId);
  const network = account?.config?.network ?? {};
  setConfigProxyUrl(network.egressProxyUrl ?? "");
  setApiBaseUrl(network.apiBaseUrl ?? "");
  return account;
}

async function sendViaWebhook({ cfg, accountId, webhookName, text, mediaUrl, preparedMedia }) {
  const account = resolveAccount(cfg, accountId);
  const raw = account?.config?.webhooks?.[webhookName];
  const url = raw ? (String(raw).startsWith("http") ? String(raw) : `${getWebhookBotSendUrl()}?key=${raw}`) : null;
  if (!url) {
    throw new Error(`unknown webhook target: ${webhookName}`);
  }

  if (!mediaUrl) {
    await webhookSendMarkdown({ url, content: text });
    recordOutboundActivity({ accountId });
    return { channel: CHANNEL_ID, messageId: `wecom-webhook-${Date.now()}` };
  }

  const { buffer, filename, mediaType } =
    preparedMedia ?? (await loadResolvedMedia(mediaUrl, { accountConfig: account?.config }));

  if (text) {
    await webhookSendMarkdown({ url, content: text });
  }

  if (mediaType === "image") {
    await webhookSendImage({
      url,
      base64: buffer.toString("base64"),
      md5: crypto.createHash("md5").update(buffer).digest("hex"),
    });
  } else {
    const mediaId = await webhookUploadFile({ url, buffer, filename });
    await webhookSendFile({ url, mediaId });
  }

  recordOutboundActivity({ accountId });
  return { channel: CHANNEL_ID, messageId: `wecom-webhook-${Date.now()}` };
}

async function sendViaAgent({ cfg, accountId, target, text, mediaUrl, preparedMedia }) {
  const agent = resolveAccount(cfg, accountId)?.agentCredentials;
  if (!agent) {
    throw new Error("Agent API is not configured for this account");
  }

  if (text) {
    for (const chunk of splitTextByByteLimit(text)) {
      await agentSendText({ agent, ...target, text: chunk });
    }
  }

  if (!mediaUrl) {
    recordOutboundActivity({ accountId });
    return { channel: CHANNEL_ID, messageId: `wecom-agent-${Date.now()}` };
  }

  const { buffer, filename, mediaType } =
    preparedMedia ?? (await loadResolvedMedia(mediaUrl, { accountConfig: resolveAccount(cfg, accountId)?.config }));
  const mediaId = await agentUploadMedia({
    agent,
    type: mediaType,
    buffer,
    filename,
  });
  await agentSendMedia({
    agent,
    ...target,
    mediaId,
    mediaType,
  });

  recordOutboundActivity({ accountId });
  return { channel: CHANNEL_ID, messageId: `wecom-agent-${Date.now()}` };
}

export const wecomChannelPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Enterprise WeChat",
    selectionLabel: "Enterprise WeChat (AI Bot)",
    docsPath: `/channels/${CHANNEL_ID}`,
    docsLabel: CHANNEL_ID,
    blurb: "Enterprise WeChat AI Bot over WebSocket.",
    aliases: ["wecom", "wework"],
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "wecomUserId",
    normalizeAllowEntry: normalizePairingEntry,
    notifyApproval: async ({ cfg, id, accountId }) => {
      try {
        await sendWsMessage({
          to: id,
          content: "配对已通过，可以开始发送消息。",
          accountId: resolveOutboundAccountId(cfg, accountId),
        });
      } catch (error) {
        logger.warn(`[wecom] failed to notify pairing approval: ${error.message}`);
      }
    },
  },
  onboarding: wecomOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        enabled: { type: "boolean" },
        defaultAccount: { type: "string" },
        botId: { type: "string" },
        secret: { type: "string" },
        websocketUrl: { type: "string" },
        sendThinkingMessage: { type: "boolean" },
        welcomeMessage: { type: "string" },
        dmPolicy: { enum: ["pairing", "allowlist", "open", "disabled"] },
        allowFrom: { type: "array", items: { type: "string" } },
        groupPolicy: { enum: ["open", "allowlist", "disabled"] },
        groupAllowFrom: { type: "array", items: { type: "string" } },
        deliveryMode: { enum: ["direct", "gateway"] },
        mediaLocalRoots: { type: "array", items: { type: "string" } },
        agent: {
          type: "object",
          additionalProperties: true,
          properties: {
            replyFormat: { enum: ["text", "markdown"] },
            callback: {
              type: "object",
              additionalProperties: false,
              properties: {
                token: { type: "string" },
                encodingAESKey: { type: "string" },
                path: { type: "string" },
              },
            },
          },
        },
      },
    },
    uiHints: {
      botId: { label: "Bot ID" },
      secret: { label: "Secret", sensitive: true },
      websocketUrl: { label: "WebSocket URL", placeholder: DEFAULT_WS_URL },
      welcomeMessage: { label: "Welcome Message" },
      "agent.corpSecret": { sensitive: true, label: "Application Secret" },
      "agent.replyFormat": { label: "Reply Format", placeholder: "text" },
      "agent.callback.token": { label: "Callback Token" },
      "agent.callback.encodingAESKey": { label: "Callback Encoding AES Key", sensitive: true },
      "agent.callback.path": { label: "Callback Path", placeholder: "/api/channels/wecom/callback" },
    },
  },
  config: {
    listAccountIds,
    resolveAccount,
    defaultAccountId: (cfg) => resolveDefaultAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => updateAccountConfig(cfg, accountId, { enabled }),
    deleteAccount: ({ cfg, accountId }) => deleteAccountConfig(cfg, accountId),
    isConfigured: (account) =>
      Boolean((account.botId && account.secret) || account.callbackConfigured),
    describeAccount,
    resolveAllowFrom: ({ cfg, accountId }) => resolveAllowFromForAccount(cfg, accountId),
    formatAllowFrom: ({ allowFrom }) => normalizeAllowFromEntries(allowFrom.map((entry) => String(entry))),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: buildConfigPath(account, "dmPolicy"),
      allowFromPath: buildConfigPath(account, "allowFrom"),
      approveHint: formatPairingApproveHint(CHANNEL_ID),
      normalizeEntry: normalizePairingEntry,
    }),
    collectWarnings: ({ account }) => {
      const warnings = [];
      const allowFrom = Array.isArray(account.config.allowFrom) ? account.config.allowFrom.map((entry) => String(entry)) : [];

      if ((account.config.dmPolicy ?? "pairing") === "open" && !allowFrom.includes("*")) {
        warnings.push(
          `- ${account.accountId}: dmPolicy="open" 但 allowFrom 未包含 "*"; 建议同时显式配置 ${buildConfigPath(account, "allowFrom")}=["*"]。`,
        );
      }

      if ((account.config.groupPolicy ?? "open") === "open") {
        warnings.push(
          `- ${account.accountId}: groupPolicy="open" 会允许所有群聊触发；如需收敛，请配置 ${buildConfigPath(account, "groupPolicy")}="allowlist"。`,
        );
      }

      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = String(target ?? "").trim();
      if (!trimmed) {
        return undefined;
      }
      const resolved = resolveWecomTarget(trimmed);
      if (!resolved) {
        return undefined;
      }
      if (resolved.webhook) {
        return `webhook:${resolved.webhook}`;
      }
      if (resolved.toParty) {
        return `party:${resolved.toParty}`;
      }
      if (resolved.toTag) {
        return `tag:${resolved.toTag}`;
      }
      if (resolved.chatId) {
        return `chat:${resolved.chatId}`;
      }
      if (resolved.toUser) {
        return `user:${resolved.toUser}`;
      }
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (value) => Boolean(String(value ?? "").trim()),
      hint: "<userId|groupId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  outbound: {
    get deliveryMode() {
      try {
        const cfg = getOpenclawConfig();
        const mode = cfg?.channels?.wecom?.deliveryMode;
        if (mode === "direct" || mode === "gateway") return mode;
      } catch {}
      return "gateway";
    },
    chunker: (text, limit) => resolveRuntimeTextChunker(text, limit),
    textChunkLimit: TEXT_CHUNK_LIMIT,
    sendText: async ({ cfg, to, text, accountId }) => {
      const resolvedAccountId = resolveOutboundAccountId(cfg, accountId);
      setOpenclawConfig(cfg);
      applyNetworkConfig(cfg, resolvedAccountId);
      const target = resolveWecomTarget(to) ?? {};

      if (target.webhook) {
        return sendViaWebhook({
          cfg,
          accountId: resolvedAccountId,
          webhookName: target.webhook,
          text,
        });
      }

      try {
        if (!target.toParty && !target.toTag) {
          const wsTarget = target.chatId || target.toUser || to;
          logger.debug(`[wecom] sendText: trying WS accountId=${resolvedAccountId} target=${wsTarget}`);
          return await sendWsMessage({
            to: wsTarget,
            content: text,
            accountId: resolvedAccountId,
          });
        }
      } catch (error) {
        logger.warn(`[wecom] WS sendText failed (accountId=${resolvedAccountId}), falling back: ${error.message}`);
      }

      // Webhook fallback for accounts without Agent API (e.g. WS bot mode)
      const account = resolveAccount(cfg, resolvedAccountId);
      if (!account?.agentCredentials && account?.config?.webhooks?.default) {
        logger.debug(`[wecom] sendText: Agent API unavailable, using webhook fallback accountId=${resolvedAccountId}`);
        return sendViaWebhook({ cfg, accountId: resolvedAccountId, webhookName: "default", text });
      }

      logger.debug(`[wecom] sendText: trying Agent API accountId=${resolvedAccountId}`);
      return sendViaAgent({
        cfg,
        accountId: resolvedAccountId,
        target: target.toParty || target.toTag ? target : target.chatId ? { chatId: target.chatId } : { toUser: target.toUser || String(to).replace(/^wecom:/i, "") },
        text,
      });
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId }) => {
      const resolvedAccountId = resolveOutboundAccountId(cfg, accountId);
      setOpenclawConfig(cfg);
      const account = applyNetworkConfig(cfg, resolvedAccountId);
      const target = resolveWecomTarget(to) ?? {};

      if (target.webhook) {
        const preparedMedia = mediaUrl
          ? await loadResolvedMedia(mediaUrl, { accountConfig: account?.config, mediaLocalRoots })
          : undefined;
        return sendViaWebhook({
          cfg,
          accountId: resolvedAccountId,
          webhookName: target.webhook,
          text,
          mediaUrl,
          preparedMedia,
        });
      }

      if (target.toParty || target.toTag) {
        if (!account?.agentCredentials) {
          throw new Error("Agent API is required for party/tag media delivery");
        }
        return sendViaAgent({
          cfg,
          accountId: resolvedAccountId,
          target,
          text,
          mediaUrl,
          preparedMedia: await loadResolvedMedia(mediaUrl, { accountConfig: account?.config, mediaLocalRoots }),
        });
      }

      const chatId = target.chatId || target.toUser || String(to).replace(/^wecom:/i, "");
      const wsClient = getWsClient(resolvedAccountId);

      let textAlreadySent = false;
      if (wsClient?.isConnected && mediaUrl) {
        if (text) {
          try {
            await sendWsMessage({ to: chatId, content: text, accountId: resolvedAccountId });
            textAlreadySent = true;
          } catch (textErr) {
            logger.warn(`[wecom] WS text send failed before media upload: ${textErr.message}`);
          }
        }

        const extendedRoots = await getExtendedMediaLocalRoots({
          accountConfig: account?.config,
          mediaLocalRoots,
        });
        const result = await uploadAndSendMedia({
          wsClient,
          mediaUrl,
          chatId,
          mediaLocalRoots: extendedRoots,
          log: (...args) => logger.info(...args),
          errorLog: (...args) => logger.error(...args),
        });

        if (result.ok) {
          recordOutboundActivity({ accountId: resolvedAccountId });
          return { channel: CHANNEL_ID, messageId: result.messageId, chatId };
        }
        logger.warn(`[wecom] WS media upload failed, falling back: ${result.error || result.rejectReason}`);
      }

      const agentTarget = target.chatId
        ? { chatId: target.chatId }
        : { toUser: target.toUser || String(to).replace(/^wecom:/i, "") };

      if (account?.agentCredentials) {
        return sendViaAgent({
          cfg,
          accountId: resolvedAccountId,
          target: agentTarget,
          text: textAlreadySent ? undefined : text,
          mediaUrl,
          preparedMedia: await loadResolvedMedia(mediaUrl, { accountConfig: account?.config, mediaLocalRoots }),
        });
      }

      throw new Error("No media delivery channel available: WS upload failed and Agent API is not configured");
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    collectStatusIssues: (accounts, ctx = {}) =>
      accounts.flatMap((entry) => {
        if (entry.enabled === false) {
          return [];
        }

        const issues = [];
        if (!entry.configured) {
          issues.push({
            channel: CHANNEL_ID,
            accountId: entry.accountId,
            kind: "config",
            message: "企业微信 botId 或 secret 未配置",
            fix: "Run: openclaw channels add wecom --bot-id <id> --secret <secret>",
          });
        }

        for (const conflict of detectAccountConflicts(ctx.cfg ?? {})) {
          if (conflict.accounts.includes(entry.accountId)) {
            issues.push({
              channel: CHANNEL_ID,
              accountId: entry.accountId,
              kind: "config",
              message: conflict.message,
            });
          }
        }

        const telemetry = entry.wecomStatus ?? {};
        const displacedAt = telemetry.connection?.lastDisplacedAt;
        if (telemetry.connection?.displaced) {
          issues.push({
            channel: CHANNEL_ID,
            accountId: entry.accountId,
            kind: "runtime",
            message: `企业微信长连接已被其他实例接管${displacedAt ? `（${new Date(displacedAt).toISOString()}）` : ""}。`,
            fix: "检查是否有多个实例同时使用相同 botId；保留一个活跃连接即可。",
          });
        }

        const quotas = telemetry.quotas ?? {};
        if ((quotas.exhaustedReplyChats ?? 0) > 0 || (quotas.exhaustedActiveChats ?? 0) > 0) {
          issues.push({
            channel: CHANNEL_ID,
            accountId: entry.accountId,
            kind: "runtime",
            message: `企业微信配额已触顶：24h 回复窗口触顶 ${quotas.exhaustedReplyChats ?? 0} 个会话，主动发送日配额触顶 ${quotas.exhaustedActiveChats ?? 0} 个会话。`,
          });
        } else if ((quotas.nearLimitReplyChats ?? 0) > 0 || (quotas.nearLimitActiveChats ?? 0) > 0) {
          issues.push({
            channel: CHANNEL_ID,
            accountId: entry.accountId,
            kind: "runtime",
            message: `企业微信配额接近上限：24h 回复窗口接近上限 ${quotas.nearLimitReplyChats ?? 0} 个会话，主动发送日配额接近上限 ${quotas.nearLimitActiveChats ?? 0} 个会话。`,
          });
        }

        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => buildBaseChannelStatusSummary(snapshot),
    probeAccount: async () => ({ ok: true, status: 200 }),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const telemetry = getAccountTelemetry(account.accountId);
      return {
        ...buildBaseAccountStatusSnapshot({
          account,
          runtime: {
            ...runtime,
            lastInboundAt: telemetry.lastInboundAt ?? runtime?.lastInboundAt ?? null,
            lastOutboundAt: telemetry.lastOutboundAt ?? runtime?.lastOutboundAt ?? null,
          },
          probe,
        }),
        wecomStatus: telemetry,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      setOpenclawConfig(ctx.cfg);
      logAccountConflicts(ctx.cfg);

      const network = ctx.account.config.network ?? {};
      setConfigProxyUrl(network.egressProxyUrl ?? "");
      setApiBaseUrl(network.apiBaseUrl ?? "");

      return startWsMonitor({
        account: ctx.account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
    logoutAccount: async ({ cfg, accountId }) => {
      const current = resolveAccount(cfg, accountId);
      const cleared = Boolean(current.botId || current.secret);
      const nextCfg = cleared
        ? updateAccountConfig(cfg, accountId, {
            botId: undefined,
            secret: undefined,
          })
        : cfg;
      const runtime = getRuntime();
      if (cleared && runtime?.config?.writeConfigFile) {
        await runtime.config.writeConfigFile(nextCfg);
      }
      const resolved = resolveAccount(nextCfg, accountId);
      return {
        cleared,
        envToken: false,
        loggedOut: !resolved.botId && !resolved.secret,
      };
    },
  },
  hooks: {
    /**
     * Ensure announce delivery uses a valid WeCom channel accountId.
     *
     * When a dynamic agent (e.g. wecom-yoyo-dm-xxx) spawns a sub-agent,
     * the announce delivery may reference the dynamic agent ID as accountId.
     * This hook resolves it to the actual WeCom account (e.g. yoyo) so the
     * outbound sendText can find valid WS/Agent API credentials.
     */
    subagent_delivery_target: async (event, ctx) => {
      const origin = event.requesterOrigin;
      if (!origin?.channel || origin.channel !== CHANNEL_ID) return;

      const cfg = ctx?.cfg ?? getOpenclawConfig();

      // Check whether current accountId already resolves to a valid account
      const currentAccount = resolveAccount(cfg, origin.accountId);
      if (currentAccount?.enabled) return;

      // Try to extract the base account from a dynamic agent ID
      const baseId = extractParentAgentId(origin.accountId);
      if (baseId && baseId !== origin.accountId) {
        const baseAccount = resolveAccount(cfg, baseId);
        if (baseAccount?.enabled) {
          logger.info(`[wecom] subagent_delivery_target: ${origin.accountId} → ${baseId}`);
          return { origin: { ...origin, accountId: baseId } };
        }
      }

      // Fallback to default account
      const defaultId = resolveDefaultAccountId(cfg);
      if (defaultId && defaultId !== origin.accountId) {
        logger.info(`[wecom] subagent_delivery_target: fallback → ${defaultId}`);
        return { origin: { ...origin, accountId: defaultId } };
      }
    },

    subagent_spawned: async (event) => {
      logger.info(
        `[wecom] subagent spawned: child=${event.childSessionKey} requester=${event.requesterSessionKey}`,
      );
    },

    subagent_ended: async (event) => {
      logger.info(
        `[wecom] subagent ended: target=${event.targetSessionKey} reason=${event.reason} outcome=${event.outcome}`,
      );
    },
  },
};

export const wecomChannelPluginTesting = {};
