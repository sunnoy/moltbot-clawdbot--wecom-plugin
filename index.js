import { WxWorkWebhook } from "./webhook.js";
import { logger } from "./logger.js";
import { streamManager } from "./stream-manager.js";


const DEFAULT_ACCOUNT_ID = "default";

// Runtime state (module-level singleton)
let _runtime = null;
let _moltbotConfig = null;

/**
 * Set the plugin runtime (called during plugin registration)
 */
function setRuntime(runtime) {
  _runtime = runtime;
}

function getRuntime() {
  if (!_runtime) {
    throw new Error("[wxwork] Runtime not initialized");
  }
  return _runtime;
}

// Webhook targets registry (similar to Google Chat)
const webhookTargets = new Map();

// Track active stream for each user, so outbound messages (like reset confirmation) 
// can be added to the correct stream instead of using response_url
const activeStreams = new Map();

function normalizeWxWorkAllowFromEntry(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  return trimmed.replace(/^(wxwork|wecom|wework):/i, "").replace(/^user:/i, "").toLowerCase();
}

function resolveWxWorkAllowFrom(cfg, accountId) {
  const wxwork = cfg?.channels?.wxwork;
  if (!wxwork) return [];

  const normalizedAccountId = String(accountId || DEFAULT_ACCOUNT_ID).trim().toLowerCase();
  const accounts = wxwork.accounts;
  const account =
    accounts && typeof accounts === "object"
      ? accounts[accountId] ??
      accounts[
      Object.keys(accounts).find((key) => key.toLowerCase() === normalizedAccountId) ?? ""
      ]
      : undefined;

  const allowFromRaw =
    account?.dm?.allowFrom ?? account?.allowFrom ?? wxwork.dm?.allowFrom ?? wxwork.allowFrom ?? [];

  if (!Array.isArray(allowFromRaw)) return [];

  return allowFromRaw
    .map(normalizeWxWorkAllowFromEntry)
    .filter((entry) => Boolean(entry));
}

function resolveWxWorkCommandAuthorized({ cfg, accountId, senderId }) {
  const sender = String(senderId ?? "").trim().toLowerCase();
  if (!sender) return false;

  const allowFrom = resolveWxWorkAllowFrom(cfg, accountId);
  if (allowFrom.includes("*") || allowFrom.length === 0) return true;
  return allowFrom.includes(sender);
}

function normalizeWebhookPath(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function registerWebhookTarget(target) {
  const key = normalizeWebhookPath(target.path);
  const existing = webhookTargets.get(key) ?? [];
  webhookTargets.set(key, [...existing, { ...target, path: key }]);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((e) => e !== target);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

// =============================================================================
// Channel Plugin Definition
// =============================================================================

const wxworkChannelPlugin = {
  id: "wxwork",
  meta: {
    id: "wxwork",
    label: "Enterprise WeChat",
    selectionLabel: "Enterprise WeChat (AI Bot)",
    docsPath: "/channels/wxwork",
    blurb: "Enterprise WeChat AI Bot channel plugin.",
    aliases: ["wecom", "wework"],
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true, // WxWork AI Bot uses stream response format
  },
  reload: { configPrefixes: ["channels.wxwork"] },
  config: {
    listAccountIds: (cfg) => {
      const wxwork = cfg?.channels?.wxwork;
      if (!wxwork || !wxwork.enabled) return [];
      return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
      const wxwork = cfg?.channels?.wxwork;
      if (!wxwork) return null;
      return {
        id: accountId || DEFAULT_ACCOUNT_ID,
        accountId: accountId || DEFAULT_ACCOUNT_ID,
        enabled: wxwork.enabled !== false,
        token: wxwork.token || "",
        encodingAesKey: wxwork.encodingAesKey || "",
        webhookPath: wxwork.webhookPath || "/webhooks/wxwork",
        config: wxwork,
      };
    },
    defaultAccountId: (cfg) => {
      const wxwork = cfg?.channels?.wxwork;
      if (!wxwork || !wxwork.enabled) return null;
      return DEFAULT_ACCOUNT_ID;
    },
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels.wxwork) cfg.channels.wxwork = {};
      cfg.channels.wxwork.enabled = enabled;
      return cfg;
    },
    deleteAccount: ({ cfg, accountId }) => {
      if (cfg.channels?.wxwork) delete cfg.channels.wxwork;
      return cfg;
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  // Outbound adapter: Send messages via stream (all messages go through stream now)
  outbound: {
    sendText: async ({ cfg, to, text, accountId }) => {
      // to格式: "wxwork:userid" 或 "userid"
      const userId = to.replace(/^wxwork:/, "");

      // 获取该用户当前活跃的 streamId
      const streamId = activeStreams.get(userId);

      if (streamId && streamManager.hasStream(streamId)) {
        logger.debug("Appending outbound text to stream", { userId, streamId, text: text.substring(0, 30) });
        // 使用 appendStream 追加内容，保留之前的内容
        const stream = streamManager.getStream(streamId);
        const separator = stream && stream.content.length > 0 ? "\n\n" : "";
        streamManager.appendStream(streamId, separator + text);

        return {
          channel: "wxwork",
          messageId: `msg_stream_${Date.now()}`,
        };
      }

      // 如果没有活跃的流，记录警告
      logger.warn("WxWork outbound: no active stream for user", { userId });

      return {
        channel: "wxwork",
        messageId: `fake_${Date.now()}`,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const userId = to.replace(/^wxwork:/, "");
      const streamId = activeStreams.get(userId);

      if (streamId && streamManager.hasStream(streamId)) {
        const content = text ? `${text}\n\n![image](${mediaUrl})` : `![image](${mediaUrl})`;
        logger.debug("Appending outbound media to stream", { userId, streamId, mediaUrl });
        // 使用 appendStream 追加内容
        const stream = streamManager.getStream(streamId);
        const separator = stream && stream.content.length > 0 ? "\n\n" : "";
        streamManager.appendStream(streamId, separator + content);

        return {
          channel: "wxwork",
          messageId: `msg_stream_${Date.now()}`,
        };
      }

      logger.warn("WxWork outbound sendMedia: no active stream", { userId });

      return {
        channel: "wxwork",
        messageId: `fake_${Date.now()}`,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      logger.info("WxWork gateway starting", { accountId: account.accountId, webhookPath: account.webhookPath });

      const unregister = registerWebhookTarget({
        path: account.webhookPath || "/webhooks/wxwork",
        account,
        config: ctx.cfg,
      });

      return {
        shutdown: async () => {
          logger.info("WxWork gateway shutting down");
          unregister();
        },
      };
    },
  },
};

// =============================================================================
// HTTP Webhook Handler
// =============================================================================

async function wxworkHttpHandler(req, res) {
  const url = new URL(req.url || "", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);

  if (!targets || targets.length === 0) {
    return false; // Not handled by this plugin
  }

  const query = Object.fromEntries(url.searchParams);
  logger.debug("WxWork HTTP request", { method: req.method, path });

  // GET: URL Verification
  if (req.method === "GET") {
    const target = targets[0]; // Use first target for verification
    if (!target) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("No webhook target configured");
      return true;
    }

    const webhook = new WxWorkWebhook({
      token: target.account.token,
      encodingAesKey: target.account.encodingAesKey,
    });

    const echo = webhook.handleVerify(query);
    if (echo) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(echo);
      logger.info("WxWork URL verification successful");
      return true;
    }

    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Verification failed");
    logger.warn("WxWork URL verification failed");
    return true;
  }

  // POST: Message handling
  if (req.method === "POST") {
    const target = targets[0];
    if (!target) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("No webhook target configured");
      return true;
    }

    // Read request body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf-8");
    logger.debug("WxWork message received", { bodyLength: body.length });

    const webhook = new WxWorkWebhook({
      token: target.account.token,
      encodingAesKey: target.account.encodingAesKey,
    });

    const result = await webhook.handleMessage(query, body);
    if (!result) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return true;
    }

    // Handle text message
    if (result.message) {
      const msg = result.message;
      const { timestamp, nonce } = result.query;
      const content = (msg.content || "").trim();

      // 统一使用流式回复处理所有消息（包括命令）
      // 企业微信 AI Bot 的 response_url 只能使用一次，
      // 所以必须通过流式来发送所有回复内容
      const streamId = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      streamManager.createStream(streamId);

      // 被动回复：返回流式消息ID (同步响应)
      const streamResponse = webhook.buildStreamResponse(
        streamId,
        "", // 初始内容为空
        false, // 未完成
        timestamp,
        nonce
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(streamResponse);

      logger.info("Stream initiated", { streamId, from: msg.fromUser, isCommand: content.startsWith("/") });
      // 异步处理消息 - 调用AI并更新流内容
      processInboundMessage({
        message: msg,
        streamId,
        timestamp,
        nonce,
        account: target.account,
        config: target.config,
      }).catch((err) => {
        logger.error("WxWork message processing failed", { error: err.message });
        // 即使失败也要标记流为完成
        streamManager.finishStream(streamId);
      });

      return true;
    }

    // Handle stream refresh - return current stream state
    if (result.stream) {
      const { timestamp, nonce } = result.query;
      const streamId = result.stream.id;

      // 获取流的当前状态
      const stream = streamManager.getStream(streamId);

      if (!stream) {
        // 流不存在或已过期,返回空的完成响应
        logger.warn("Stream not found for refresh", { streamId });
        const streamResponse = webhook.buildStreamResponse(
          streamId,
          "会话已过期",
          true,
          timestamp,
          nonce
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(streamResponse);
        return true;
      }

      // 返回当前流的内容
      const streamResponse = webhook.buildStreamResponse(
        streamId,
        stream.content,
        stream.finished,
        timestamp,
        nonce
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(streamResponse);

      logger.debug("Stream refresh response sent", {
        streamId,
        contentLength: stream.content.length,
        finished: stream.finished
      });

      // 如果流已完成,在一段时间后清理
      if (stream.finished) {
        setTimeout(() => {
          streamManager.deleteStream(streamId);
        }, 30 * 1000); // 30秒后清理
      }

      return true;
    }

    // Handle event
    if (result.event) {
      logger.info("WxWork event received", { event: result.event });

      // 处理进入会话事件 - 发送欢迎语
      if (result.event?.event_type === "enter_chat") {
        const { timestamp, nonce } = result.query;
        const fromUser = result.event?.from?.userid || "";

        // 欢迎语内容
        const welcomeMessage = `你好！👋 我是 AI 助手。

你可以使用下面的指令管理会话：
• **/new** - 新建会话（清空上下文）
• **/compact** - 压缩会话（保留上下文摘要）
• **/help** - 查看更多命令

有什么我可以帮你的吗？`;

        // 创建流并返回欢迎语
        const streamId = `welcome_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        streamManager.createStream(streamId);
        streamManager.appendStream(streamId, welcomeMessage);
        streamManager.finishStream(streamId);

        const streamResponse = webhook.buildStreamResponse(
          streamId,
          welcomeMessage,
          true,  // 直接完成
          timestamp,
          nonce
        );

        logger.info("Sending welcome message", { fromUser, streamId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(streamResponse);
        return true;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("success");
      return true;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("success");
    return true;
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method Not Allowed");
  return true;
}

// =============================================================================
// Inbound Message Processing (triggers AI response)
// =============================================================================

async function processInboundMessage({ message, streamId, timestamp, nonce, account, config }) {
  const runtime = getRuntime();
  const core = runtime.channel;

  const senderId = message.fromUser;
  const rawBody = message.content || "";
  const responseUrl = message.responseUrl;
  const conversationId = `wxwork:${senderId}`;

  // 设置用户当前活跃的 streamId，供 outbound.sendText 使用
  if (streamId) {
    activeStreams.set(senderId, streamId);
  }

  const commandAuthorized = resolveWxWorkCommandAuthorized({
    cfg: config,
    accountId: account.accountId,
    senderId,
  });

  if (!rawBody.trim()) {
    logger.debug("WxWork: empty message, skipping");
    return;
  }

  logger.info("WxWork processing message", { from: senderId, content: rawBody.substring(0, 50), streamId });

  // Resolve agent route
  const route = core.routing.resolveAgentRoute({
    cfg: config,
    channel: "wxwork",
    accountId: account.accountId,
    peer: {
      kind: "dm",
      id: senderId,
    },
  });

  // Build inbound context
  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = core.reply.formatAgentEnvelope({
    channel: "Enterprise WeChat",
    from: senderId,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `wxwork:${senderId}`,
    To: conversationId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: senderId,
    SenderName: senderId,
    SenderId: senderId,
    Provider: "wxwork",
    Surface: "wxwork",
    OriginatingChannel: "wxwork",
    OriginatingTo: conversationId,
    CommandAuthorized: commandAuthorized,
  });

  // Record session meta
  void core.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
  }).catch((err) => {
    logger.error("WxWork: failed updating session meta", { error: err.message });
  });

  // Dispatch reply with AI processing
  await core.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        logger.info("Dispatcher deliver called", {
          kind: info.kind,
          hasText: !!(payload.text && payload.text.trim()),
          textPreview: (payload.text || "").substring(0, 50),
        });

        await deliverWxWorkReply({
          payload,
          account,
          responseUrl,
          senderId,
          streamId,  // 传递streamId用于流式更新
        });

        // 如果是最终回复,标记流为完成
        if (streamId && info.kind === "final") {
          streamManager.finishStream(streamId);
          logger.info("WxWork stream finished", { streamId });
        }
      },
      onError: (err, info) => {
        logger.error("WxWork reply failed", { error: err.message, kind: info.kind });
        // 发生错误时也标记流为完成
        if (streamId) {
          streamManager.finishStream(streamId);
        }
      },
    },
  });

  // 确保在dispatch完成后标记流为完成（兜底机制）
  if (streamId) {
    streamManager.finishStream(streamId);
    activeStreams.delete(senderId);  // 清理活跃流映射
    logger.info("WxWork stream finished (dispatch complete)", { streamId });
  }
}

// =============================================================================
// Outbound Reply Delivery (Stream-only mode)
// =============================================================================

async function deliverWxWorkReply({ payload, account, responseUrl, senderId, streamId }) {
  const text = payload.text || "";

  logger.debug("deliverWxWorkReply called", {
    hasText: !!text.trim(),
    textPreview: text.substring(0, 50),
    streamId,
    senderId,
  });

  // 所有消息都通过流式发送
  if (!text.trim()) {
    logger.debug("WxWork: empty block, skipping stream update");
    return;
  }

  // 辅助函数：追加内容到流（带去重）
  const appendToStream = (targetStreamId, content) => {
    const stream = streamManager.getStream(targetStreamId);
    if (!stream) return false;

    // 去重：检查流内容是否已包含此消息（避免 block + final 重复）
    if (stream.content.includes(content.trim())) {
      logger.debug("WxWork: duplicate content, skipping", {
        streamId: targetStreamId,
        contentPreview: content.substring(0, 30)
      });
      return true;  // 返回 true 表示不需要再发送
    }

    const separator = stream.content.length > 0 ? "\n\n" : "";
    streamManager.appendStream(targetStreamId, separator + content);
    return true;
  };

  if (!streamId) {
    // 尝试从 activeStreams 获取
    const activeStreamId = activeStreams.get(senderId);
    if (activeStreamId && streamManager.hasStream(activeStreamId)) {
      appendToStream(activeStreamId, text);
      logger.debug("WxWork stream appended (via activeStreams)", {
        streamId: activeStreamId,
        contentLength: text.length,
      });
      return;
    }
    logger.warn("WxWork: no active stream for this message", { senderId });
    return;
  }

  if (!streamManager.hasStream(streamId)) {
    logger.warn("WxWork: stream not found, cannot update", { streamId });
    return;
  }

  appendToStream(streamId, text);
  logger.debug("WxWork stream appended", {
    streamId,
    contentLength: text.length,
    to: senderId
  });
}

// =============================================================================
// Plugin Registration
// =============================================================================

const plugin = {
  id: "wxwork",
  name: "Enterprise WeChat",
  description: "Enterprise WeChat AI Bot channel plugin for Moltbot",
  configSchema: { type: "object", additionalProperties: true, properties: {} },
  register(api) {
    logger.info("WxWork plugin registering...");

    // Save runtime for message processing
    setRuntime(api.runtime);
    _moltbotConfig = api.config;

    // Register channel
    api.registerChannel({ plugin: wxworkChannelPlugin });
    logger.info("WxWork channel registered");

    // Register HTTP handler for webhooks
    api.registerHttpHandler(wxworkHttpHandler);
    logger.info("WxWork HTTP handler registered");
  },
};

export default plugin;
export const register = (api) => plugin.register(api);
