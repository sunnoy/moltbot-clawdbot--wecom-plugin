import crypto from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
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
import { getRuntime, setOpenclawConfig } from "./state.js";
import { resolveWecomTarget } from "./target.js";
import { webhookSendFile, webhookSendImage, webhookSendMarkdown, webhookUploadFile } from "./webhook-bot.js";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_WS_URL,
  TEXT_CHUNK_LIMIT,
  getWebhookBotSendUrl,
  setApiBaseUrl,
} from "./constants.js";
import { sendWsMessage, startWsMonitor } from "./ws-monitor.js";

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

async function loadMediaPayload(mediaUrl, { mediaLocalRoots } = {}) {
  const normalized = normalizeMediaPath(mediaUrl);
  if (normalized.startsWith("/")) {
    // Prefer core's loadWebMedia with sandbox enforcement when available.
    const runtime = getRuntime();
    if (typeof runtime?.media?.loadWebMedia === "function" && Array.isArray(mediaLocalRoots) && mediaLocalRoots.length > 0) {
      const loaded = await runtime.media.loadWebMedia(normalized, { localRoots: mediaLocalRoots });
      return {
        buffer: loaded.buffer,
        filename: loaded.fileName || basename(normalized) || "file",
        contentType: loaded.contentType || "",
      };
    }
    const buffer = await readFile(normalized);
    return {
      buffer,
      filename: basename(normalized) || "file",
      contentType: "",
    };
  }

  const response = await wecomFetch(normalized);
  if (!response.ok) {
    throw new Error(`failed to download media: ${response.status}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    filename: basename(new URL(normalized).pathname) || "file",
    contentType: response.headers.get("content-type") || "",
  };
}

async function loadResolvedMedia(mediaUrl, { mediaLocalRoots } = {}) {
  const media = await loadMediaPayload(mediaUrl, { mediaLocalRoots });
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

function resolveWsNoticeTarget(target, rawTo) {
  if (target?.webhook || target?.toParty || target?.toTag) {
    return null;
  }
  const fallback = String(rawTo ?? "").trim();
  return target?.chatId || target?.toUser || fallback || null;
}

function buildUnsupportedMediaNotice({ text, mediaType, deliveredViaAgent }) {
  let notice;
  if (mediaType === "file") {
    notice = deliveredViaAgent
      ? "由于当前企业微信bot不支持给用户发送文件，文件通过自建应用发送。"
      : "由于当前企业微信bot不支持给用户发送文件，且当前未配置自建应用发送渠道。";
  } else if (mediaType === "image") {
    notice = deliveredViaAgent
      ? "由于当前企业微信bot不支持直接发送图片，图片通过自建应用发送。"
      : "由于当前企业微信bot不支持直接发送图片，且当前未配置自建应用发送渠道。";
  } else {
    notice = deliveredViaAgent
      ? "由于当前企业微信bot不支持直接发送媒体，媒体通过自建应用发送。"
      : "由于当前企业微信bot不支持直接发送媒体，且当前未配置自建应用发送渠道。";
  }

  return [text, notice].filter(Boolean).join("\n\n");
}

async function sendUnsupportedMediaNoticeViaWs({ to, text, mediaType, accountId }) {
  return sendWsMessage({
    to,
    content: buildUnsupportedMediaNotice({
      text,
      mediaType,
      deliveredViaAgent: true,
    }),
    accountId,
  });
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

  const { buffer, filename, mediaType } = preparedMedia ?? (await loadResolvedMedia(mediaUrl));

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

  const { buffer, filename, mediaType } = preparedMedia ?? (await loadResolvedMedia(mediaUrl));
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
      },
    },
    uiHints: {
      botId: { label: "Bot ID" },
      secret: { label: "Secret", sensitive: true },
      websocketUrl: { label: "WebSocket URL", placeholder: DEFAULT_WS_URL },
      welcomeMessage: { label: "Welcome Message" },
      "agent.corpSecret": { sensitive: true, label: "Application Secret" },
    },
  },
  config: {
    listAccountIds,
    resolveAccount,
    defaultAccountId: (cfg) => resolveDefaultAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => updateAccountConfig(cfg, accountId, { enabled }),
    deleteAccount: ({ cfg, accountId }) => deleteAccountConfig(cfg, accountId),
    isConfigured: (account) => Boolean(account.botId && account.secret),
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
      return trimmed || undefined;
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
    deliveryMode: "direct",
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
          return await sendWsMessage({
            to: wsTarget,
            content: text,
            accountId: resolvedAccountId,
          });
        }
      } catch (error) {
        logger.warn(`[wecom] WS sendText failed, falling back to Agent API: ${error.message}`);
      }

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
      const wsNoticeTarget = resolveWsNoticeTarget(target, to);

      if (target.webhook) {
        const preparedMedia = mediaUrl ? await loadResolvedMedia(mediaUrl, { mediaLocalRoots }) : undefined;
        return sendViaWebhook({
          cfg,
          accountId: resolvedAccountId,
          webhookName: target.webhook,
          text,
          mediaUrl,
          preparedMedia,
        });
      }

      const agentTarget =
        target.toParty || target.toTag
          ? target
          : target.chatId
            ? { chatId: target.chatId }
            : { toUser: target.toUser || String(to).replace(/^wecom:/i, "") };
      const preparedMedia = await loadResolvedMedia(mediaUrl, { mediaLocalRoots });

      if (target.toParty || target.toTag) {
        if (!account?.agentCredentials) {
          throw new Error("Agent API is required for party/tag media delivery");
        }
        return sendViaAgent({
          cfg,
          accountId: resolvedAccountId,
          target: agentTarget,
          text,
          mediaUrl,
          preparedMedia,
        });
      }

      if (account?.agentCredentials) {
        const agentResult = await sendViaAgent({
          cfg,
          accountId: resolvedAccountId,
          target: agentTarget,
          text: wsNoticeTarget ? undefined : text,
          mediaUrl,
          preparedMedia,
        });

        if (wsNoticeTarget) {
          try {
            await sendUnsupportedMediaNoticeViaWs({
              to: wsNoticeTarget,
              text,
              mediaType: preparedMedia.mediaType,
              accountId: resolvedAccountId,
            });
          } catch (error) {
            logger.warn(`[wecom] WS media notice failed, falling back to Agent text delivery: ${error.message}`);
            if (text) {
              await sendViaAgent({
                cfg,
                accountId: resolvedAccountId,
                target: agentTarget,
                text,
              });
            }
          }
        }

        return agentResult;
      }

      if (wsNoticeTarget) {
        logger.warn("[wecom] Agent API is not configured for unsupported WS media; sending notice only");
        return sendWsMessage({
          to: wsNoticeTarget,
          content: buildUnsupportedMediaNotice({
            text,
            mediaType: preparedMedia.mediaType,
            deliveredViaAgent: false,
          }),
          accountId: resolvedAccountId,
        });
      }

      throw new Error("Agent API is not configured for unsupported WeCom media delivery");
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
};

export const wecomChannelPluginTesting = {
  buildUnsupportedMediaNotice,
};
