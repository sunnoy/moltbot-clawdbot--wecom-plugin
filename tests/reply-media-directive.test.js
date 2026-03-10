import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wsMonitorTesting, buildReplyMediaGuidance } from "../wecom/ws-monitor.js";

const { splitReplyMediaFromText, buildBodyForAgent } = wsMonitorTesting;

describe("splitReplyMediaFromText", () => {
  it("extracts MEDIA: on its own line", () => {
    const result = splitReplyMediaFromText("截图如下\nMEDIA:/root/.openclaw/media/browser/abc.jpg");
    assert.deepEqual(result.mediaUrls, ["/root/.openclaw/media/browser/abc.jpg"]);
    assert.equal(result.text, "截图如下");
  });

  it("extracts FILE: on its own line", () => {
    const result = splitReplyMediaFromText("附件如下\nFILE:/workspace/report.pdf");
    assert.deepEqual(result.mediaUrls, ["/workspace/report.pdf"]);
    assert.equal(result.text, "附件如下");
  });

  it("extracts both MEDIA: and FILE: directives", () => {
    const input = "Here are the files:\nMEDIA:/img/shot.jpg\nFILE:/docs/report.pdf\nDone.";
    const result = splitReplyMediaFromText(input);
    assert.deepEqual(result.mediaUrls, ["/img/shot.jpg", "/docs/report.pdf"]);
    assert.equal(result.text, "Here are the files:\nDone.");
  });

  it("handles markdown dash list prefix: - MEDIA:", () => {
    const input = "Files:\n- MEDIA:/root/.openclaw/media/browser/shot.jpg\n- FILE:/root/.openclaw/media/browser/report.pdf";
    const result = splitReplyMediaFromText(input);
    assert.deepEqual(result.mediaUrls, [
      "/root/.openclaw/media/browser/shot.jpg",
      "/root/.openclaw/media/browser/report.pdf",
    ]);
    assert.equal(result.text, "Files:");
  });

  it("handles markdown asterisk list prefix: * FILE:", () => {
    const result = splitReplyMediaFromText("* FILE:/workspace/data.csv");
    assert.deepEqual(result.mediaUrls, ["/workspace/data.csv"]);
    assert.equal(result.text, "");
  });

  it("handles numbered list prefix: 1. MEDIA:", () => {
    const input = "1. MEDIA:/img/a.png\n2. FILE:/docs/b.pdf";
    const result = splitReplyMediaFromText(input);
    assert.deepEqual(result.mediaUrls, ["/img/a.png", "/docs/b.pdf"]);
    assert.equal(result.text, "");
  });

  it("handles bullet prefix: • MEDIA:", () => {
    const result = splitReplyMediaFromText("• MEDIA:/img/shot.png");
    assert.deepEqual(result.mediaUrls, ["/img/shot.png"]);
    assert.equal(result.text, "");
  });

  it("strips backtick-wrapped paths", () => {
    const result = splitReplyMediaFromText("MEDIA:`/img/shot.png`");
    assert.deepEqual(result.mediaUrls, ["/img/shot.png"]);
  });

  it("handles case-insensitive directives", () => {
    const result = splitReplyMediaFromText("media:/img/a.png\nFile:/docs/b.pdf");
    assert.deepEqual(result.mediaUrls, ["/img/a.png", "/docs/b.pdf"]);
  });

  it("returns empty for text without directives", () => {
    const result = splitReplyMediaFromText("just some text\nwith multiple lines");
    assert.deepEqual(result.mediaUrls, []);
    assert.equal(result.text, "just some text\nwith multiple lines");
  });

  it("returns empty for null/undefined input", () => {
    assert.deepEqual(splitReplyMediaFromText(null).mediaUrls, []);
    assert.deepEqual(splitReplyMediaFromText(undefined).mediaUrls, []);
    assert.deepEqual(splitReplyMediaFromText("").mediaUrls, []);
  });

  it("handles leading whitespace before directive", () => {
    const result = splitReplyMediaFromText("  MEDIA:/img/shot.jpg");
    assert.deepEqual(result.mediaUrls, ["/img/shot.jpg"]);
  });
});

describe("buildBodyForAgent", () => {
  it("returns plain message body without injected guidance", () => {
    const result = buildBodyForAgent("hello world", {}, "test-agent");
    assert.equal(result, "hello world");
  });

  it("returns empty string for empty body", () => {
    assert.equal(buildBodyForAgent("", {}, "test"), "");
    assert.equal(buildBodyForAgent(null, {}, "test"), "");
    assert.equal(buildBodyForAgent(undefined, {}, "test"), "");
  });
});

describe("buildReplyMediaGuidance", () => {
  it("contains expected guidance sections", () => {
    const guidance = buildReplyMediaGuidance({}, "test-agent");
    assert.ok(guidance.includes("[WeCom reply media rule]"));
    assert.ok(guidance.includes("MEDIA:/abs/path"));
    assert.ok(guidance.includes("FILE:/abs/path"));
    assert.ok(guidance.includes("Do NOT call message.send"));
    assert.ok(guidance.includes("its own line"));
  });
});
