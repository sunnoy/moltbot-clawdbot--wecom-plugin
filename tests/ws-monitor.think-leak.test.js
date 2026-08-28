/**
 * Regression tests: model thinking (<think>...) content must never leak into
 * the visible text sent to WeCom users via the WS streaming path.
 *
 * Two thinking sources exist:
 * - a dedicated reasoning stream (state.reasoningText)
 * - thinking blocks echoed into the visible text stream (accumulatedText)
 *
 * When BOTH are present, the visible-stream thinking blocks are redundant and
 * MUST be stripped to avoid nested <think> tags and content leaks. When only
 * the visible stream carries thinking (no reasoning stream), the blocks are
 * preserved so the WeCom client renders them as a collapsed "已完成思考" block
 * (the official dynamic thinking stream behavior).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wsMonitorTesting } from "../wecom/ws-monitor.js";

const { buildWsStreamContent, finishThinkingStream, stripThinkTags } = wsMonitorTesting;

describe("finishThinkingStream — thinking content must not leak", () => {
  it("strips redundant thinking blocks from the visible reply when a reasoning stream exists", async () => {
    const calls = [];
    const wsClient = {
      isConnected: true,
      async replyStream(frame, streamId, content, finish, msgItem) {
        calls.push({ frame, streamId, content, finish, msgItem });
      },
    };
    const frame = {
      body: {
        from: { userid: "alice" },
      },
    };

    // The model reported reasoning via the reasoning stream (English) AND
    // echoed thinking into the visible text stream (Chinese). The visible
    // thinking blocks must not be forwarded (issue #187).
    await finishThinkingStream({
      wsClient,
      frame,
      accountId: "default",
      state: {
        accumulatedText: "The user said something.\n<think>我在思考 step3</think>\n好的，现在更新 step3 和 step6。",
        reasoningText: "The user said ok",
        streamId: "stream-1",
        hasMedia: false,
        hasMediaFailed: false,
        mediaErrorSummary: "",
      },
    });

    assert.equal(calls.length, 1);
    const content = calls[0].content;
    assert.match(content, /好的，现在更新 step3 和 step6。/);
    assert.doesNotMatch(content, /我在思考 step3/);
    // Exactly one top-level thinking block (the official reasoning stream).
    assert.match(content, /^<think>The user said ok<\/think>/);
  });

  it("keeps thinking blocks when the model writes them directly into the visible stream", async () => {
    const calls = [];
    const wsClient = {
      isConnected: true,
      async replyStream(frame, streamId, content, finish, msgItem) {
        calls.push({ frame, streamId, content, finish, msgItem });
      },
    };
    const frame = {
      body: {
        from: { userid: "bob" },
      },
    };

    // No reasoning stream: the official dynamic thinking stream behavior is
    // to keep <thinking> and let the WeCom client collapse it.
    await finishThinkingStream({
      wsClient,
      frame,
      accountId: "default",
      state: {
        accumulatedText: "<thinking>先分析问题，再给出结论</thinking>\n**最终答案**",
        reasoningText: "",
        streamId: "stream-2",
        hasMedia: false,
        hasMediaFailed: false,
        mediaErrorSummary: "",
      },
    });

    assert.equal(calls.length, 1);
    const content = calls[0].content;
    assert.equal(content, "<think>先分析问题，再给出结论</think>\n**最终答案**");
  });
});

describe("buildWsStreamContent — visible text sanitization", () => {
  it("keeps reasoning wrapped and appends pre-stripped visible text", () => {
    const content = buildWsStreamContent({
      reasoningText: "推理",
      visibleText: "真正的内容",
      finish: true,
    });
    assert.equal(content, "<think>推理</think>\n真正的内容");
  });

  it("stripThinkTags remains available as a fallback helper", () => {
    assert.equal(stripThinkTags("A<think>B</think>C"), "AC");
  });
});
