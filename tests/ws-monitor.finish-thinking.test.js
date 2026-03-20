import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wsMonitorTesting } from "../wecom/ws-monitor.js";

const { finishThinkingStream } = wsMonitorTesting;

describe("finishThinkingStream", () => {
  it("closes a reasoning-only stream instead of sending a generic completion stub", async () => {
    const calls = [];
    const wsClient = {
      isConnected: true,
      async replyStream(frame, streamId, content, finish, msgItem) {
        calls.push({ frame, streamId, content, finish, msgItem });
      },
    };
    const frame = {
      body: {
        from: { userid: "lirui" },
      },
    };

    await finishThinkingStream({
      wsClient,
      frame,
      accountId: "default",
      state: {
        accumulatedText: "",
        reasoningText: "先分析问题\n再给出结论",
        streamId: "stream-1",
        hasMedia: false,
        hasMediaFailed: false,
        mediaErrorSummary: "",
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      frame,
      streamId: "stream-1",
      content: "<think>先分析问题\n再给出结论</think>",
      finish: true,
      msgItem: undefined,
    });
  });

  it("closes a media-only image reply with visible completion text", async () => {
    const calls = [];
    const wsClient = {
      isConnected: true,
      async replyStream(frame, streamId, content, finish, msgItem) {
        calls.push({ frame, streamId, content, finish, msgItem });
      },
    };
    const frame = {
      body: {
        from: { userid: "lirui" },
      },
    };

    await finishThinkingStream({
      wsClient,
      frame,
      accountId: "default",
      state: {
        accumulatedText: "",
        reasoningText: "",
        streamId: "stream-2",
        hasMedia: true,
        hasImageMedia: true,
        hasFileMedia: false,
        hasMediaFailed: false,
        mediaErrorSummary: "",
        waitingModelSeconds: 31,
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      frame,
      streamId: "stream-2",
      content: "<think>等待模型响应 31s</think>\n图片已生成，请查收。",
      finish: true,
      msgItem: undefined,
    });
  });
});
