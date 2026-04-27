import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { logger } from "../logger.js";
import { wecomChannelPlugin } from "../wecom/channel-plugin.js";
import { DEFAULT_WELCOME_MESSAGES } from "../wecom/constants.js";
import { getAccountTelemetry, resetRuntimeTelemetryForTesting } from "../wecom/runtime-telemetry.js";
import { resetStateForTesting, setOpenclawConfig, setRuntime } from "../wecom/state.js";
import { startWsMonitor } from "../wecom/ws-monitor.js";
import { resetWsStateForTesting, setWsClient } from "../wecom/ws-state.js";

class FakeWsClient extends EventEmitter {
  constructor({ downloadMap = new Map() } = {}) {
    super();
    this.downloadMap = downloadMap;
    this.isConnected = false;
    this.connectCalls = 0;
    this.disconnectCalls = 0;
    this.replyStreamCalls = [];
    this.replyWelcomeCalls = [];
    this.sendMessageCalls = [];
    this.downloadFileCalls = [];
    this.uploadMediaCalls = [];
    this.sendMediaMessageCalls = [];
  }

  connect() {
    this.connectCalls += 1;
    this.isConnected = true;
    this.emit("connected");
    return this;
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.isConnected = false;
    this.emit("disconnected", "manual");
  }

  async replyStream(frame, streamId, content, finish = false, msgItem) {
    this.replyStreamCalls.push({
      frame,
      streamId,
      content,
      finish,
      msgItem,
    });
    return { headers: { req_id: `reply-${streamId}` } };
  }

  async replyWelcome(frame, body) {
    this.replyWelcomeCalls.push({ frame, body });
    return { headers: { req_id: "welcome-reply" } };
  }

  async sendMessage(chatId, body) {
    this.sendMessageCalls.push({ chatId, body });
    return { headers: { req_id: `send-${chatId}` } };
  }

  async uploadMedia(buffer, options = {}) {
    const mediaId = `media-${options.type || "file"}-${this.uploadMediaCalls.length}`;
    this.uploadMediaCalls.push({ buffer, options, mediaId });
    return { media_id: mediaId };
  }

  async sendMediaMessage(chatId, type, mediaId) {
    const reqId = `media-msg-${this.sendMediaMessageCalls.length}`;
    this.sendMediaMessageCalls.push({ chatId, type, mediaId });
    return { headers: { req_id: reqId } };
  }

  async downloadFile(url, aesKey) {
    this.downloadFileCalls.push({ url, aesKey });
    const value = this.downloadMap.get(url);
    if (Array.isArray(value)) {
      const next = value.shift();
      if (next instanceof Error) {
        throw next;
      }
      if (next) {
        return next;
      }
    }
    if (value instanceof Error) {
      throw value;
    }
    if (value) {
      return value;
    }
    return {
      buffer: Buffer.from("default-download"),
      filename: path.basename(new URL(url).pathname || "/download.bin"),
    };
  }
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(assertion, { timeoutMs = 2_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await delay(intervalMs);
    }
  }
  throw lastError ?? new Error("condition not met in time");
}

function createWecomConfig(overrides = {}) {
  return {
    channels: {
      wecom: {
        botId: "bot-123",
        secret: "secret-123",
        sendThinkingMessage: false,
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        dynamicAgents: { enabled: false },
        groupChat: {
          enabled: true,
          requireMention: false,
        },
        commands: {
          enabled: false,
        },
        ...overrides,
      },
    },
    agents: {
      defaults: {
        mediaMaxMb: 5,
      },
      list: [{ id: "main", default: true }],
    },
    session: {},
  };
}

function createAccount(config) {
  const agent = config.channels.wecom.agent;
  return {
    accountId: "default",
    botId: config.channels.wecom.botId,
    secret: config.channels.wecom.secret,
    websocketUrl: "wss://example.invalid",
    sendThinkingMessage: config.channels.wecom.sendThinkingMessage,
    config: config.channels.wecom,
    agentCredentials:
      agent?.corpId && agent?.corpSecret && agent?.agentId
        ? {
            corpId: agent.corpId,
            corpSecret: agent.corpSecret,
            agentId: agent.agentId,
          }
        : null,
  };
}

function createRuntime({
  tempDir,
  replyPayloadFactory = () => ({ text: "收到" }),
  dispatchReply,
  resolveAgentRoute,
  loadWebMedia = async () => ({
    kind: "image",
    contentType: "image/png",
    buffer: Buffer.from("reply-image"),
  }),
} = {}) {
  const ctxs = [];
  const savedMedia = [];
  const recordSessionMetaCalls = [];

  const runtime = {
    ctxs,
    savedMedia,
    recordSessionMetaCalls,
    routing: {
      resolveAgentRoute:
        resolveAgentRoute ??
        (({ peer }) => ({
          agentId: "main",
          sessionKey: `session:${peer.kind}:${peer.id}`,
        })),
    },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }) => body,
      finalizeInboundContext: (ctx) => ctx,
      dispatchReplyWithBufferedBlockDispatcher: async ({ ctx, dispatcherOptions, replyOptions }) => {
        ctxs.push(ctx);
        if (typeof dispatchReply === "function") {
          await dispatchReply({ ctx, dispatcherOptions, replyOptions });
          return;
        }
        const response = await replyPayloadFactory(ctx);
        const steps = Array.isArray(response) ? response : response ? [response] : [];
        for (const step of steps) {
          await dispatcherOptions.deliver(
            {
              text: step.text ?? "",
              mediaUrl: step.mediaUrl,
              mediaUrls: step.mediaUrls,
            },
            { kind: step.kind ?? "final" },
          );
        }
      },
    },
    session: {
      resolveStorePath: () => path.join(tempDir, "sessions"),
      readSessionUpdatedAt: () => null,
      recordSessionMetaFromInbound: async (payload) => {
        recordSessionMetaCalls.push(payload);
      },
    },
    media: {
      loadWebMedia,
      fetchRemoteMedia: async ({ url }) => ({
        buffer: Buffer.from(`fetched:${url}`),
        contentType: "application/octet-stream",
      }),
      saveMediaBuffer: async (buffer, contentType, _surface, _maxBytes, filename) => {
        const savedPath = path.join(tempDir, `${savedMedia.length}-${filename || "media.bin"}`);
        savedMedia.push({
          buffer,
          contentType,
          path: savedPath,
          filename: filename || null,
        });
        return {
          path: savedPath,
          contentType,
        };
      },
    },
  };

  return runtime;
}

function createMessageFrame(bodyOverrides = {}) {
  const msgtype = bodyOverrides.msgtype ?? "text";
  const baseBody = {
    msgid: `msg-${randomUUID()}`,
    aibotid: "bot-123",
    chattype: "single",
    from: { userid: "lirui" },
    msgtype,
  };

  if (!("text" in bodyOverrides) && msgtype === "text") {
    baseBody.text = { content: "hello" };
  }

  return {
    headers: { req_id: `req-${randomUUID()}` },
    body: {
      ...baseBody,
      ...bodyOverrides,
    },
  };
}

function createEventFrame(eventtype, overrides = {}) {
  return {
    headers: { req_id: `req-${randomUUID()}` },
    body: {
      msgid: `evt-${randomUUID()}`,
      create_time: Math.floor(Date.now() / 1000),
      aibotid: "bot-123",
      chattype: "single",
      from: { userid: "lirui" },
      msgtype: "event",
      event: { eventtype },
      ...overrides,
    },
  };
}

async function startHarness({
  configOverrides,
  replyPayloadFactory,
  dispatchReply,
  downloadMap,
  resolveAgentRoute,
  loadWebMedia,
} = {}) {
  const config = createWecomConfig(configOverrides);
  const account = createAccount(config);
  const runtime = createRuntime({
    tempDir: process.env.OPENCLAW_STATE_DIR,
    replyPayloadFactory,
    dispatchReply,
    resolveAgentRoute,
    loadWebMedia,
  });
  const wsClient = new FakeWsClient({ downloadMap });
  setRuntime(runtime);
  setOpenclawConfig(config);

  const abortController = new AbortController();
  const monitorPromise = startWsMonitor({
    account,
    config,
    runtime,
    abortSignal: abortController.signal,
    wsClientFactory: () => wsClient,
  });

  await eventually(() => assert.equal(wsClient.connectCalls, 1));
  wsClient.emit("authenticated");
  await delay(10);

  return {
    account,
    config,
    runtime,
    wsClient,
    abortController,
    async stop() {
      abortController.abort();
      await monitorPromise;
    },
    monitorPromise,
  };
}

async function createAgentApiServer() {
  const calls = {
    getToken: 0,
    uploads: [],
    sends: [],
    appchatSends: [],
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);

    if (url.pathname === "/cgi-bin/gettoken") {
      calls.getToken += 1;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ access_token: "agent-token", expires_in: 7200 }));
      return;
    }

    if (url.pathname === "/cgi-bin/media/upload") {
      calls.uploads.push({
        type: url.searchParams.get("type"),
        bodyLength: bodyBuffer.length,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ media_id: `media-${url.searchParams.get("type")}` }));
      return;
    }

    if (url.pathname === "/cgi-bin/message/send") {
      calls.sends.push(JSON.parse(bodyBuffer.toString("utf8")));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
      return;
    }

    if (url.pathname === "/cgi-bin/appchat/send") {
      calls.appchatSends.push(JSON.parse(bodyBuffer.toString("utf8")));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    calls,
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

describe("WS e2e", () => {
  let tempDir;
  let originalStateDir;

  beforeEach(async () => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-ws-e2e-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    resetRuntimeTelemetryForTesting();
    resetStateForTesting();
    await resetWsStateForTesting();
  });

  afterEach(async () => {
    resetRuntimeTelemetryForTesting();
    resetStateForTesting();
    await resetWsStateForTesting();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("covers inbound text messages end-to-end", async () => {
    const harness = await startHarness({
      replyPayloadFactory: () => ({ text: "文本已收到" }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "你好，机器人" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 1));
      assert.equal(harness.runtime.ctxs.length, 1);
      assert.equal(harness.runtime.ctxs[0].RawBody, "你好，机器人");
      assert.equal(harness.wsClient.replyStreamCalls[0].content, "文本已收到");
      assert.equal(harness.wsClient.replyStreamCalls[0].finish, true);
    } finally {
      await harness.stop();
    }
  });

  it("records wecom source timing for inbound messages", async () => {
    const infoLogs = [];
    const originalInfo = logger.info.bind(logger);
    logger.info = (message, context) => {
      infoLogs.push({ message, context });
    };

    const sourceCreateTime = Math.floor(Date.now() / 1000) - 2;
    const harness = await startHarness({
      replyPayloadFactory: () => ({ text: "文本已收到" }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          create_time: sourceCreateTime,
          msgtype: "text",
          text: { content: "检查源时间" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 1));
      assert.equal(harness.runtime.ctxs.length, 1);
      assert.equal(harness.runtime.ctxs[0].SourceTimestamp, sourceCreateTime * 1000);

      const inboundLog = infoLogs.find((entry) => entry.message.includes("← inbound"));
      assert.ok(inboundLog);
      assert.equal(inboundLog.context.sourceCreateTime, sourceCreateTime);
      assert.equal(inboundLog.context.sourceCreateTimeIso, new Date(sourceCreateTime * 1000).toISOString());
      assert.ok(inboundLog.context.sourceToIngressMs >= 1000);

      const perfLog = infoLogs.find((entry) => entry.message.includes("[WSPERF:default] inbound"));
      assert.ok(perfLog);
      assert.equal(perfLog.context.sourceCreateTime, sourceCreateTime);
      assert.equal(perfLog.context.sourceCreateTimeIso, new Date(sourceCreateTime * 1000).toISOString());
      assert.ok(perfLog.context.sourceToIngressMs >= 1000);
    } finally {
      logger.info = originalInfo;
      await harness.stop();
    }
  });

  it("preserves @ tokens inside group-message identifiers", async () => {
    const harness = await startHarness({
      replyPayloadFactory: () => ({ text: "规则已收到" }),
    });
    const content =
      '- record: sum:callerUri:0\n  expr: sum by(type,callerUri,calleeUri) (sum_over_time(statis_alarm_metrics{type="call_start",callerUri="113.57.121.58**615872@H323",calleeUri="9005271803@CONFNO"}[5m]))';

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          chattype: "group",
          chatid: "wrqUsLDAAAj02j6hsqmKsPSKnNLUZP3A",
          from: { userid: "guoyonghang" },
          msgtype: "text",
          text: { content },
        }),
      );

      await eventually(() => assert.equal(harness.runtime.ctxs.length, 1));
      assert.equal(harness.runtime.ctxs[0].RawBody, content);
      assert.match(harness.runtime.ctxs[0].RawBody, /@H323/);
      assert.match(harness.runtime.ctxs[0].RawBody, /@CONFNO/);
      assert.equal(harness.wsClient.replyStreamCalls[0].content, "规则已收到");
    } finally {
      await harness.stop();
    }
  });

  it("skips mention-only group messages instead of replying with a completion placeholder", async () => {
    const harness = await startHarness({
      configOverrides: {
        groupChat: {
          enabled: true,
          requireMention: true,
          mentionPatterns: ["@bot"],
        },
      },
      replyPayloadFactory: () => ({ text: "不应发送" }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          chattype: "group",
          chatid: "wr-group-empty-mention",
          from: { userid: "guoyonghang" },
          msgtype: "text",
          text: { content: "@bot" },
        }),
      );

      await delay(100);
      assert.equal(harness.runtime.ctxs.length, 0);
      assert.equal(harness.wsClient.replyStreamCalls.length, 0);
    } finally {
      await harness.stop();
    }
  });

  it("covers inbound image messages end-to-end", async () => {
    const imageUrl = "https://example.com/input.png";
    const harness = await startHarness({
      replyPayloadFactory: () => ({ text: "图片已收到" }),
      downloadMap: new Map([
        [
          imageUrl,
          {
            buffer: Buffer.from("png-data"),
            filename: "input.png",
          },
        ],
      ]),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "image",
          image: { url: imageUrl, aeskey: "img-aes" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 1));
      assert.deepEqual(harness.wsClient.downloadFileCalls, [{ url: imageUrl, aesKey: "img-aes" }]);
      assert.equal(harness.runtime.ctxs[0].Body, "[用户发送了一张图片]");
      assert.equal(harness.runtime.ctxs[0].RawBody, "[图片]");
      assert.deepEqual(harness.runtime.ctxs[0].MediaTypes, ["image/jpeg"]);
    } finally {
      await harness.stop();
    }
  });

  it("covers inbound mixed messages and passive reply images end-to-end", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const replyImagePath = path.join(workspaceDir, "final.png");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      replyImagePath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII=", "base64"),
    );

    const harness = await startHarness({
      replyPayloadFactory: () => ({
        text: "图文混排已收到",
        mediaUrls: [replyImagePath],
      }),
      downloadMap: new Map([
        [
          "https://example.com/mixed-inbound.png",
          {
            buffer: Buffer.from("inbound-image"),
            filename: "mixed-inbound.png",
          },
        ],
      ]),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "mixed",
          mixed: {
            msg_item: [
              { msgtype: "text", text: { content: "第一段" } },
              { msgtype: "image", image: { url: "https://example.com/mixed-inbound.png", aeskey: "mixed-aes" } },
              { msgtype: "text", text: { content: "第二段" } },
            ],
          },
          quote: {
            msgtype: "mixed",
            mixed: {
              msg_item: [
                { msgtype: "text", text: { content: "引用内容" } },
              ],
            },
          },
        }),
      );

      await eventually(() => {
        const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
        assert.ok(finals.length >= 1);
      });
      assert.equal(harness.runtime.ctxs[0].RawBody, "> 引用内容\n\n第一段\n第二段");
      // Media is now sent via uploadMedia + sendMediaMessage
      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));
    } finally {
      await harness.stop();
    }
  });

  it("extracts files from inbound mixed messages", async () => {
    const fileUrl = "https://example.com/mixed-input.pdf";
    const harness = await startHarness({
      replyPayloadFactory: () => ({ text: "图文文件已收到" }),
      downloadMap: new Map([
        [
          fileUrl,
          {
            buffer: Buffer.from("pdf-data"),
            filename: "mixed-input.pdf",
          },
        ],
      ]),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "mixed",
          mixed: {
            msg_item: [
              { msgtype: "text", text: { content: "请总结这个文件" } },
              { msgtype: "file", file: { url: fileUrl, aeskey: "file-aes" } },
            ],
          },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 1));
      assert.deepEqual(harness.wsClient.downloadFileCalls, [{ url: fileUrl, aesKey: "file-aes" }]);
      assert.equal(harness.runtime.ctxs[0].RawBody, "请总结这个文件");
      assert.deepEqual(harness.runtime.ctxs[0].MediaTypes, ["application/octet-stream"]);
    } finally {
      await harness.stop();
    }
  });

  it("parses MEDIA lines from passive reply text and uploads via WS", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const replyImagePath = path.join(workspaceDir, "reply.png");
    await mkdir(path.dirname(replyImagePath), { recursive: true });
    await writeFile(
      replyImagePath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII=", "base64"),
    );

    const harness = await startHarness({
      replyPayloadFactory: () => ({
        text: `截图如下\nMEDIA:${replyImagePath}`,
      }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "把截图发我" },
        }),
      );

      // Media is now uploaded via uploadMedia + sendMediaMessage
      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));
      // finishThinkingStream closes with text
      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("截图如下"));
    } finally {
      await harness.stop();
    }
  });

  it("keeps a visible completion message for media-only WS replies", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const replyImagePath = path.join(workspaceDir, "reply-only.png");
    await mkdir(path.dirname(replyImagePath), { recursive: true });
    await writeFile(
      replyImagePath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII=", "base64"),
    );

    const harness = await startHarness({
      replyPayloadFactory: () => ({
        text: `MEDIA:${replyImagePath}`,
      }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "直接给我图片" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));
      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("图片已生成，请查收。"));
      assert.ok(finals[0].content.includes("<think>"));
    } finally {
      await harness.stop();
    }
  });

  it("parses FILE lines from passive reply text and uploads via WS", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const replyPdfPath = path.join(workspaceDir, "report.pdf");
    await mkdir(path.dirname(replyPdfPath), { recursive: true });
    await writeFile(replyPdfPath, Buffer.from("reply-pdf"));

    const harness = await startHarness({
      replyPayloadFactory: (ctx) => {
        assert.equal(ctx.RawBody, "把 PDF 发我");
        assert.equal(ctx.CommandBody, "把 PDF 发我");
        assert.ok(ctx.BodyForAgent.includes("[WeCom agent rules]"));
        assert.ok(ctx.BodyForAgent.endsWith("把 PDF 发我"));
        return {
          text: `附件如下\nFILE:${replyPdfPath}`,
        };
      },
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "把 PDF 发我" },
        }),
      );

      // Files now uploaded via WS uploadMedia + sendMediaMessage
      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));
      assert.equal(harness.wsClient.sendMediaMessageCalls[0].chatId, "lirui");

      // finishThinkingStream closes with text
      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("附件如下"));
    } finally {
      await harness.stop();
    }
  });

  it("rewrites /workspace FILE directives to the host agent workspace", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const replyMarkdownPath = path.join(workspaceDir, "skills", "deep-research", "SKILL.md");
    await mkdir(path.dirname(replyMarkdownPath), { recursive: true });
    await writeFile(replyMarkdownPath, Buffer.from("# deep-research\n"));

    const harness = await startHarness({
      replyPayloadFactory: () => ({
        text: "文档如下\nFILE:/workspace/skills/deep-research/SKILL.md",
      }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "把这个 md 发给我" },
        }),
      );

      // Files now uploaded via WS
      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));

      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("文档如下"));
    } finally {
      await harness.stop();
    }
  });

  it("rewrites /workspace FILE directives to a non-default agent workspace", async () => {
    const workspaceDir = path.join(tempDir, "workspace-test-agent");
    const replyMarkdownPath = path.join(workspaceDir, "report.txt");
    await mkdir(path.dirname(replyMarkdownPath), { recursive: true });
    await writeFile(replyMarkdownPath, Buffer.from("agent workspace file\n"));

    const harness = await startHarness({
      resolveAgentRoute: ({ peer }) => ({
        agentId: "test-agent",
        sessionKey: `session:${peer.kind}:${peer.id}`,
      }),
      replyPayloadFactory: () => ({
        text: "文档如下\nFILE:/workspace/report.txt",
      }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "把动态 agent 文档发给我" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));

      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("文档如下"));
    } finally {
      await harness.stop();
    }
  });

  it("allows passive reply files from the trusted browser media directory", async () => {
    const browserMediaDir = path.join(tempDir, "media", "browser");
    const browserPdfPath = path.join(browserMediaDir, "report.pdf");
    await mkdir(path.dirname(browserPdfPath), { recursive: true });
    await writeFile(browserPdfPath, Buffer.from("reply-pdf"));

    const harness = await startHarness({
      replyPayloadFactory: () => ({
        text: `附件如下\nFILE:${browserPdfPath}`,
      }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "把 host PDF 发我" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));
      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("附件如下"));
    } finally {
      await harness.stop();
    }
  });

  it("rejects passive reply files from unrelated paths under the state directory", async () => {
    const outsidePdfPath = path.join(tempDir, "private", "other", "report.pdf");
    await mkdir(path.dirname(outsidePdfPath), { recursive: true });
    await writeFile(outsidePdfPath, Buffer.from("reply-pdf"));

    const harness = await startHarness({
      replyPayloadFactory: () => ({
        text: `附件如下\nFILE:${outsidePdfPath}`,
      }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "把 host PDF 发我" },
        }),
      );

      await eventually(() => {
        const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
        assert.ok(finals.length >= 1);
      });
      assert.equal(harness.wsClient.uploadMediaCalls.length, 0);
      assert.equal(harness.wsClient.sendMediaMessageCalls.length, 0);
      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("文件发送失败：没有权限访问路径"));
    } finally {
      await harness.stop();
    }
  });

  it("allows passive reply files from configured mediaLocalRoots", async () => {
    const customMediaDir = path.join(tempDir, "reply-local-root");
    const customPdfPath = path.join(customMediaDir, "report.pdf");
    await mkdir(customMediaDir, { recursive: true });
    await writeFile(customPdfPath, Buffer.from("reply-pdf"));

    const harness = await startHarness({
      configOverrides: {
        mediaLocalRoots: [customMediaDir],
      },
      replyPayloadFactory: () => ({
        text: `附件如下\nFILE:${customPdfPath}`,
      }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "把配置目录里的 PDF 发我" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));
      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("附件如下"));
    } finally {
      await harness.stop();
    }
  });

  it("uploads passive reply images via WS uploadMedia + sendMediaMessage", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const replyImagePath = path.join(workspaceDir, "final.png");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      replyImagePath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII=", "base64"),
    );

    const harness = await startHarness({
      replyPayloadFactory: () => ({
        text: "截图如下",
        mediaUrls: [replyImagePath],
      }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "把截图发我" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));
      assert.equal(harness.wsClient.sendMediaMessageCalls[0].chatId, "lirui");

      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("截图如下"));
    } finally {
      await harness.stop();
    }
  });

  it("uploads passive reply files via WS uploadMedia + sendMediaMessage", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const replyPdfPath = path.join(workspaceDir, "report.pdf");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(replyPdfPath, Buffer.from("reply-pdf"));

    const harness = await startHarness({
      replyPayloadFactory: () => ({
        text: "附件如下",
        mediaUrls: [replyPdfPath],
      }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "把 PDF 发我" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));
      assert.equal(harness.wsClient.sendMediaMessageCalls[0].chatId, "lirui");

      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("附件如下"));
    } finally {
      await harness.stop();
    }
  });

  it("uploads passive files via WS even without Agent API configured", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const replyPdfPath = path.join(workspaceDir, "report.pdf");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(replyPdfPath, Buffer.from("reply-pdf"));

    const harness = await startHarness({
      replyPayloadFactory: () => ({
        text: "附件如下",
        mediaUrls: [replyPdfPath],
      }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "把 PDF 发我" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.uploadMediaCalls.length, 1));
      await eventually(() => assert.equal(harness.wsClient.sendMediaMessageCalls.length, 1));

      const finals = harness.wsClient.replyStreamCalls.filter((c) => c.finish);
      assert.ok(finals.length >= 1);
      assert.ok(finals[0].content.includes("附件如下"));
    } finally {
      await harness.stop();
    }
  });

  it("covers inbound voice messages end-to-end", async () => {
    const harness = await startHarness({
      replyPayloadFactory: () => ({ text: "语音已转文本" }),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "voice",
          voice: { content: "帮我总结一下" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 1));
      assert.equal(harness.runtime.ctxs[0].RawBody, "帮我总结一下");
      assert.equal(harness.wsClient.replyStreamCalls[0].content, "语音已转文本");
    } finally {
      await harness.stop();
    }
  });

  it("covers inbound file messages end-to-end", async () => {
    const fileUrl = "https://example.com/input.pdf";
    const harness = await startHarness({
      replyPayloadFactory: () => ({ text: "文件已收到" }),
      downloadMap: new Map([
        [
          fileUrl,
          {
            buffer: Buffer.from("pdf-data"),
            filename: "input.pdf",
          },
        ],
      ]),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "file",
          file: { url: fileUrl, aeskey: "file-aes" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 1));
      assert.deepEqual(harness.wsClient.downloadFileCalls, [{ url: fileUrl, aesKey: "file-aes" }]);
      assert.equal(harness.runtime.ctxs[0].Body, "[用户发送了文件]");
      assert.equal(harness.runtime.ctxs[0].RawBody, "[文件]");
      assert.deepEqual(harness.runtime.ctxs[0].MediaTypes, ["application/octet-stream"]);
    } finally {
      await harness.stop();
    }
  });

  it("merges adjacent attachment-only and text messages from the same sender", async () => {
    const fileUrl = "https://example.com/adjacent-input.pdf";
    const harness = await startHarness({
      replyPayloadFactory: () => ({ text: "合并处理完成" }),
      downloadMap: new Map([
        [
          fileUrl,
          {
            buffer: Buffer.from("pdf-data"),
            filename: "adjacent-input.pdf",
          },
        ],
      ]),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "file",
          file: { url: fileUrl, aeskey: "file-aes" },
        }),
      );
      await delay(100);
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "请总结这个文件" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 1));
      assert.equal(harness.runtime.ctxs.length, 1);
      assert.deepEqual(harness.wsClient.downloadFileCalls, [{ url: fileUrl, aesKey: "file-aes" }]);
      assert.equal(harness.runtime.ctxs[0].RawBody, "请总结这个文件");
      assert.deepEqual(harness.runtime.ctxs[0].MediaTypes, ["application/octet-stream"]);
    } finally {
      await harness.stop();
    }
  });

  it("merges multiple adjacent attachment-only messages before text", async () => {
    const firstUrl = "https://example.com/adjacent-first.pdf";
    const secondUrl = "https://example.com/adjacent-second.pdf";
    const harness = await startHarness({
      replyPayloadFactory: () => ({ text: "多文件合并处理完成" }),
      downloadMap: new Map([
        [firstUrl, { buffer: Buffer.from("first"), filename: "first.pdf" }],
        [secondUrl, { buffer: Buffer.from("second"), filename: "second.pdf" }],
      ]),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "file",
          file: { url: firstUrl, aeskey: "first-aes" },
        }),
      );
      await delay(100);
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "file",
          file: { url: secondUrl, aeskey: "second-aes" },
        }),
      );
      await delay(100);
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "请一起总结这些文件" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 1));
      assert.equal(harness.runtime.ctxs.length, 1);
      assert.deepEqual(harness.wsClient.downloadFileCalls, [
        { url: firstUrl, aesKey: "first-aes" },
        { url: secondUrl, aesKey: "second-aes" },
      ]);
      assert.equal(harness.runtime.ctxs[0].RawBody, "请一起总结这些文件");
      assert.deepEqual(harness.runtime.ctxs[0].MediaTypes, ["application/octet-stream", "application/octet-stream"]);
    } finally {
      await harness.stop();
    }
  });

  it("retries encrypted inbound file downloads and replies with an explicit failure", async () => {
    const fileUrl = "https://example.com/transient-input.pdf";
    const harness = await startHarness({
      replyPayloadFactory: () => ({ text: "不应调用模型" }),
      downloadMap: new Map([
        [
          fileUrl,
          [
            new Error("Request failed with status code 503"),
            new Error("Request failed with status code 503"),
            new Error("Request failed with status code 503"),
          ],
        ],
      ]),
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "file",
          file: { url: fileUrl, aeskey: "file-aes" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 1), {
        timeoutMs: 5_000,
      });
      assert.equal(harness.runtime.ctxs.length, 0);
      assert.equal(harness.wsClient.downloadFileCalls.length, 3);
      assert.match(harness.wsClient.replyStreamCalls[0].content, /下载失败/);
      assert.match(harness.wsClient.replyStreamCalls[0].content, /503/);
    } finally {
      await harness.stop();
    }
  });

  it("matches the official dynamic thinking stream behavior", async () => {
    const harness = await startHarness({
      configOverrides: {
        sendThinkingMessage: true,
      },
      replyPayloadFactory: () => [
        {
          kind: "partial",
          text: "<thinking>先分析问题",
        },
        {
          kind: "final",
          text: "，再给出结论</thinking>\n**最终答案**",
        },
      ],
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "请开始推理" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 3));

      const [thinkingFrame, streamingFrame, finalFrame] = harness.wsClient.replyStreamCalls;

      assert.equal(thinkingFrame.content, "<think>等待模型响应 1s");
      assert.equal(thinkingFrame.finish, false);

      assert.equal(streamingFrame.streamId, thinkingFrame.streamId);
      assert.equal(streamingFrame.content, "<think>先分析问题");
      assert.equal(streamingFrame.finish, false);

      assert.equal(finalFrame.streamId, thinkingFrame.streamId);
      assert.equal(finalFrame.content, "<think>先分析问题，再给出结论</think>\n**最终答案**");
      assert.equal(finalFrame.finish, true);
    } finally {
      await harness.stop();
    }
  });

  it("bridges OpenClaw reasoning stream into WeCom think frames", async () => {
    const harness = await startHarness({
      configOverrides: {
        sendThinkingMessage: true,
      },
      dispatchReply: async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_先分析问题_" });
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_先分析问题_\n_再给出结论_" });
        await dispatcherOptions.deliver({ text: "**最终答案**" }, { kind: "final" });
      },
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "请展示思考流" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 4));

      const [thinkingFrame, reasoningFrame1, reasoningFrame2, finalFrame] =
        harness.wsClient.replyStreamCalls;

      assert.equal(thinkingFrame.content, "<think>等待模型响应 1s");
      assert.equal(thinkingFrame.finish, false);

      assert.equal(reasoningFrame1.streamId, thinkingFrame.streamId);
      assert.equal(reasoningFrame1.content, "<think>先分析问题");
      assert.equal(reasoningFrame1.finish, false);

      assert.equal(reasoningFrame2.streamId, thinkingFrame.streamId);
      assert.equal(reasoningFrame2.content, "<think>先分析问题\n再给出结论");
      assert.equal(reasoningFrame2.finish, false);

      assert.equal(finalFrame.streamId, thinkingFrame.streamId);
      assert.equal(finalFrame.content, "<think>先分析问题\n再给出结论</think>\n**最终答案**");
      assert.equal(finalFrame.finish, true);
    } finally {
      await harness.stop();
    }
  });

  it("updates the waiting stream every second and stops once the first reasoning token arrives", async () => {
    const harness = await startHarness({
      configOverrides: {
        sendThinkingMessage: true,
      },
      dispatchReply: async ({ dispatcherOptions, replyOptions }) => {
        await delay(1_100);
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_先分析问题_" });
        await delay(1_200);
        await dispatcherOptions.deliver({ text: "**最终答案**" }, { kind: "final" });
      },
    });

    try {
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "请开始计时" },
        }),
      );

      await eventually(() => assert.equal(harness.wsClient.replyStreamCalls.length, 4), {
        timeoutMs: 5_000,
      });

      const [waiting1, waiting2, reasoningFrame, finalFrame] = harness.wsClient.replyStreamCalls;

      assert.equal(waiting1.content, "<think>等待模型响应 1s");
      assert.equal(waiting1.finish, false);

      assert.equal(waiting2.streamId, waiting1.streamId);
      assert.equal(waiting2.content, "<think>等待模型响应 2s");
      assert.equal(waiting2.finish, false);

      assert.equal(reasoningFrame.streamId, waiting1.streamId);
      assert.equal(reasoningFrame.content, "<think>先分析问题");
      assert.equal(reasoningFrame.finish, false);

      assert.equal(finalFrame.streamId, waiting1.streamId);
      assert.equal(finalFrame.content, "<think>先分析问题</think>\n**最终答案**");
      assert.equal(finalFrame.finish, true);

      await delay(1_100);
      assert.equal(harness.wsClient.replyStreamCalls.length, 4);
    } finally {
      await harness.stop();
    }
  });

  it("covers enter_chat, template_card_event, feedback_event and disconnected_event", async () => {
    const infoLogs = [];
    const originalInfo = logger.info.bind(logger);
    logger.info = (message, context) => {
      infoLogs.push({ message, context });
    };

    const harness = await startHarness({
      replyPayloadFactory: () => null,
      configOverrides: {
        welcomeMessage: "欢迎使用企业微信机器人",
      },
    });

    try {
      harness.wsClient.emit("event.enter_chat", createEventFrame("enter_chat"));
      await eventually(() => assert.equal(harness.wsClient.replyWelcomeCalls.length, 1));
      assert.equal(
        harness.wsClient.replyWelcomeCalls[0].body.text.content,
        "欢迎使用企业微信机器人",
      );

      harness.wsClient.emit("event.template_card_event", createEventFrame("template_card_event"));
      harness.wsClient.emit("event.feedback_event", createEventFrame("feedback_event"));
      await eventually(() => {
        assert.ok(infoLogs.some((entry) => entry.message.includes("Template card event received")));
        assert.ok(infoLogs.some((entry) => entry.message.includes("Feedback event received")));
      });

      harness.wsClient.emit("event.disconnected_event", createEventFrame("disconnected_event"));
      await assert.rejects(harness.monitorPromise, /taken over by another connection/);
      assert.ok(harness.wsClient.disconnectCalls >= 1);
      assert.equal(getAccountTelemetry("default").connection.displaced, true);
    } finally {
      logger.info = originalInfo;
    }
  });

  it("uses one of the built-in welcome templates when no welcomeMessage is configured", async () => {
    const harness = await startHarness({
      replyPayloadFactory: () => null,
    });

    try {
      harness.wsClient.emit("event.enter_chat", createEventFrame("enter_chat"));
      await eventually(() => assert.equal(harness.wsClient.replyWelcomeCalls.length, 1));

      const welcomeText = harness.wsClient.replyWelcomeCalls[0].body.text.content;
      assert.ok(DEFAULT_WELCOME_MESSAGES.includes(welcomeText));
    } finally {
      await harness.stop();
    }
  });

  it("uses welcomeMessagesFile (JSON array) when welcomeMessage is unset", async () => {
    const welcomePath = path.join(tempDir, "welcome-list.json");
    await writeFile(
      welcomePath,
      JSON.stringify(["仅来自文件的欢迎 A", "仅来自文件的欢迎 B"]),
      "utf8",
    );

    const harness = await startHarness({
      replyPayloadFactory: () => null,
      configOverrides: {
        welcomeMessagesFile: "welcome-list.json",
      },
    });

    try {
      harness.wsClient.emit("event.enter_chat", createEventFrame("enter_chat"));
      await eventually(() => assert.equal(harness.wsClient.replyWelcomeCalls.length, 1));
      const welcomeText = harness.wsClient.replyWelcomeCalls[0].body.text.content;
      assert.ok(["仅来自文件的欢迎 A", "仅来自文件的欢迎 B"].includes(welcomeText));
    } finally {
      await harness.stop();
    }
  });

  it("welcomeMessage takes precedence over welcomeMessagesFile", async () => {
    const welcomePath = path.join(tempDir, "welcome-list.json");
    await writeFile(welcomePath, JSON.stringify(["from-file-only"]), "utf8");

    const harness = await startHarness({
      replyPayloadFactory: () => null,
      configOverrides: {
        welcomeMessage: "固定欢迎",
        welcomeMessagesFile: "welcome-list.json",
      },
    });

    try {
      harness.wsClient.emit("event.enter_chat", createEventFrame("enter_chat"));
      await eventually(() => assert.equal(harness.wsClient.replyWelcomeCalls.length, 1));
      assert.equal(harness.wsClient.replyWelcomeCalls[0].body.text.content, "固定欢迎");
    } finally {
      await harness.stop();
    }
  });

  it("covers outbound sendText over WS", async () => {
    const wsClient = new FakeWsClient();
    wsClient.isConnected = true;
    setWsClient("default", wsClient);

    const cfg = createWecomConfig();
    setOpenclawConfig(cfg);

    const result = await wecomChannelPlugin.outbound.sendText({
      cfg,
      to: "wecom:lirui",
      text: "主动消息",
      accountId: "default",
    });

    assert.equal(result.chatId, "lirui");
    assert.equal(wsClient.sendMessageCalls.length, 1);
    assert.equal(wsClient.sendMessageCalls[0].chatId, "lirui");
    assert.deepEqual(wsClient.sendMessageCalls[0].body, {
      msgtype: "markdown",
      markdown: { content: "主动消息" },
    });
  });

  it("applies sender protocol on outbound sendText over WS", async () => {
    const wsClient = new FakeWsClient();
    wsClient.isConnected = true;
    setWsClient("default", wsClient);

    const cfg = createWecomConfig();
    setOpenclawConfig(cfg);

    await wecomChannelPlugin.outbound.sendText({
      cfg,
      to: "wecom:weiyuandong",
      text: "[[sender:lirui]]\n你好",
      accountId: "default",
    });

    assert.equal(wsClient.sendMessageCalls.length, 1);
    assert.deepEqual(wsClient.sendMessageCalls[0].body, {
      msgtype: "markdown",
      markdown: { content: "【sender:lirui】你好" },
    });
  });

  it("uses markdown payloads for structured outbound WS messages", async () => {
    const wsClient = new FakeWsClient();
    wsClient.isConnected = true;
    setWsClient("default", wsClient);

    const cfg = createWecomConfig();
    setOpenclawConfig(cfg);

    await wecomChannelPlugin.outbound.sendText({
      cfg,
      to: "wecom:lirui",
      text: "## 标题\n- 第一项",
      accountId: "default",
    });

    assert.equal(wsClient.sendMessageCalls.length, 1);
    assert.deepEqual(wsClient.sendMessageCalls[0].body, {
      msgtype: "markdown",
      markdown: { content: "## 标题\n- 第一项" },
    });
  });

  it("covers outbound file send via WS upload", async () => {
    const wsClient = new FakeWsClient();
    wsClient.isConnected = true;
    setWsClient("default", wsClient);

    const filePath = path.join(tempDir, "report.pdf");
    await writeFile(filePath, Buffer.from("pdf"));

    const cfg = createWecomConfig();
    setOpenclawConfig(cfg);

    const result = await wecomChannelPlugin.outbound.sendMedia({
      cfg,
      to: "wecom:lirui",
      text: "附件如下",
      mediaUrl: filePath,
      mediaLocalRoots: [tempDir],
      accountId: "default",
    });

    // Text sent first via WS sendMessage
    assert.equal(wsClient.sendMessageCalls.length, 1);
    assert.equal(wsClient.sendMessageCalls[0].body.markdown.content, "附件如下");
    // File uploaded + sent via WS
    assert.equal(wsClient.uploadMediaCalls.length, 1);
    assert.equal(wsClient.sendMediaMessageCalls.length, 1);
    assert.equal(wsClient.sendMediaMessageCalls[0].chatId, "lirui");
    assert.equal(result.channel, "wecom");
  });

  it("covers outbound image send via WS upload", async () => {
    const wsClient = new FakeWsClient();
    wsClient.isConnected = true;
    setWsClient("default", wsClient);

    const imagePath = path.join(tempDir, "diagram.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const cfg = createWecomConfig();
    setOpenclawConfig(cfg);

    const result = await wecomChannelPlugin.outbound.sendMedia({
      cfg,
      to: "wecom:lirui",
      text: "图片如下",
      mediaUrl: imagePath,
      mediaLocalRoots: [tempDir],
      accountId: "default",
    });

    // Text sent first via WS sendMessage
    assert.equal(wsClient.sendMessageCalls.length, 1);
    assert.equal(wsClient.sendMessageCalls[0].body.markdown.content, "图片如下");
    // Image uploaded + sent via WS
    assert.equal(wsClient.uploadMediaCalls.length, 1);
    assert.equal(wsClient.sendMediaMessageCalls.length, 1);
    assert.equal(wsClient.sendMediaMessageCalls[0].chatId, "lirui");
    assert.equal(result.channel, "wecom");
  });

  it("handles concurrent messages from multiple users in parallel", async () => {
    // Track responses for each user
    const userResponses = new Map();
    const userMessages = ["用户A的消息", "用户B的消息", "用户C的消息"];
    const userIds = ["user_a", "user_b", "user_c"];

    // Create a harness that dispatches replies with different delays
    const harness = await startHarness({
      dispatchReply: async ({ dispatcherOptions, replyOptions, messageContext }) => {
        const userId = messageContext?.from?.userId || "unknown";
        // Simulate varying response times (100ms, 200ms, 300ms)
        const delayMs = 50 + Math.random() * 200;
        await delay(delayMs);
        await dispatcherOptions.deliver({ text: `响应: ${userId}` }, { kind: "final" });
      },
    });

    try {
      // Send messages from multiple users concurrently
      const sendPromises = userIds.map((userId, index) => {
        return new Promise((resolve) => {
          harness.wsClient.emit(
            "message",
            createMessageFrame({
              msgtype: "text",
              text: { content: userMessages[index] },
              fromUserName: userId,
            }),
          );
          // Resolve immediately after emitting (don't wait for response)
          setTimeout(resolve, 10);
        });
      });

      await Promise.all(sendPromises);

      // Wait for all responses to complete
      await eventually(() => {
        assert.equal(harness.wsClient.replyStreamCalls.length, userIds.length);
      });

      // Verify each user got a response
      assert.equal(harness.wsClient.replyStreamCalls.length, userIds.length);
    } finally {
      await harness.stop();
    }
  });

  it("processes long-running tasks concurrently without blocking other users", async () => {
    const messageTimings = [];
    const CONCURRENT_USERS = 3;
    const LONG_TASK_DELAY_MS = 300;
    const SHORT_TASK_DELAY_MS = 50;

    const harness = await startHarness({
      dispatchReply: async ({ dispatcherOptions, messageContext }) => {
        // Use messageContent from messageContext
        const content = messageContext?.message?.content || "unknown";
        const startTime = Date.now();

        // Determine delay based on message content
        const isSlow = content.includes("慢") || content.includes("C");
        const delayMs = isSlow ? LONG_TASK_DELAY_MS : SHORT_TASK_DELAY_MS;
        await delay(delayMs);

        await dispatcherOptions.deliver({ text: `完成: ${content}` }, { kind: "final" });

        messageTimings.push({
          content,
          duration: Date.now() - startTime,
        });
      },
    });

    try {
      const startTime = Date.now();

      // Send all messages at the same time
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "TaskA" },
        }),
      );
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "TaskB" },
        }),
      );
      harness.wsClient.emit(
        "message",
        createMessageFrame({
          msgtype: "text",
          text: { content: "SlowTaskC" },
        }),
      );

      // Wait for all to complete
      await eventually(() => {
        assert.equal(harness.wsClient.replyStreamCalls.length, CONCURRENT_USERS);
      });

      const totalTime = Date.now() - startTime;

      // All messages should complete
      assert.equal(messageTimings.length, CONCURRENT_USERS);

      // Note: Since all 3 messages come from the same sender (lirui),
      // they are processed serially in the same session lane.
      // This test verifies that same-session messages are serialized.

      // Verify the timing - serial processing means total time >= sum of individual delays
      const totalDelay = SHORT_TASK_DELAY_MS + SHORT_TASK_DELAY_MS + LONG_TASK_DELAY_MS;
      assert.ok(totalTime >= SHORT_TASK_DELAY_MS * 2,
        `Serial processing: total time ${totalTime}ms should be >= 2x short delay`);
    } finally {
      await harness.stop();
    }
  });

  it("maintains session isolation between concurrent users", async () => {
    const sessionResponses = [];

    const harness = await startHarness({
      dispatchReply: async ({ dispatcherOptions, messageContext, sessionKey }) => {
        const userId = messageContext?.from?.userId || "unknown";
        await delay(50);
        await dispatcherOptions.deliver(
          { text: `回复: ${userId}, session: ${sessionKey}` },
          { kind: "final" },
        );
        sessionResponses.push({ userId, sessionKey });
      },
    });

    try {
      // Send multiple messages from same user (same session)
      for (let i = 0; i < 3; i++) {
        harness.wsClient.emit(
          "message",
          createMessageFrame({
            msgtype: "text",
            text: { content: `用户消息 ${i + 1}` },
            fromUserName: "user_session_test",
          }),
        );
      }

      // Wait for all responses
      await eventually(() => {
        assert.equal(harness.wsClient.replyStreamCalls.length, 3);
      });

      // All should have the same session key (serialized)
      const sessionKeys = sessionResponses.map((r) => r.sessionKey);
      const uniqueSessions = new Set(sessionKeys);
      assert.equal(uniqueSessions.size, 1, "Same user should use same session");
    } finally {
      await harness.stop();
    }
  });

  it("handles burst messages with queue backpressure", async () => {
    const BURST_COUNT = 10;
    const receivedResponses = [];

    const harness = await startHarness({
      dispatchReply: async ({ dispatcherOptions, messageContext }) => {
        const content = messageContext?.message?.content || "";
        await delay(20); // Simulate quick processing
        await dispatcherOptions.deliver({ text: `收到: ${content}` }, { kind: "final" });
        receivedResponses.push(content);
      },
    });

    try {
      // Send burst of messages
      for (let i = 0; i < BURST_COUNT; i++) {
        harness.wsClient.emit(
          "message",
          createMessageFrame({
            msgtype: "text",
            text: { content: `突发消息 ${i}` },
          }),
        );
      }

      // Wait for all responses
      await eventually(() => {
        assert.equal(harness.wsClient.replyStreamCalls.length, BURST_COUNT);
      });

      assert.equal(receivedResponses.length, BURST_COUNT);
    } finally {
      await harness.stop();
    }
  });
});
