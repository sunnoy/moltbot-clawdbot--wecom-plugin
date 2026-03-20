import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  wsMonitorTesting,
  buildReplyMediaGuidance,
  resolveReplyMediaLocalRoots,
} from "../wecom/ws-monitor.js";

const { splitReplyMediaFromText, buildBodyForAgent, normalizeReplyMediaUrlForLoad } = wsMonitorTesting;

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
    assert.ok(guidance.includes("message.sendAttachment"));
    assert.ok(guidance.includes("PDF must always use FILE:"));
    assert.ok(guidance.includes("/workspace"));
    assert.ok(guidance.includes("SKILL.md"));
    assert.ok(guidance.includes("path prefixed with FILE:"));
    assert.ok(guidance.includes("its own line"));
    assert.ok(!guidance.includes("[WeCom image_studio rule]"));
  });

  it("includes configured host media roots in guidance", () => {
    const guidance = buildReplyMediaGuidance(
      {
        channels: {
          wecom: {
            mediaLocalRoots: ["/tmp/reply-media"],
          },
        },
      },
      "test-agent",
    );
    assert.ok(guidance.includes("Additional configured host roots are also allowed: /tmp/reply-media"));
  });

  it("injects image_studio guidance only when qwenImageTools is enabled", () => {
    const guidance = buildReplyMediaGuidance(
      {
        plugins: {
          entries: {
            wecom: {
              config: {
                qwenImageTools: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
      "test-agent",
    );
    assert.ok(guidance.includes("[WeCom image_studio rule]"));
    assert.ok(guidance.includes('action="generate"'));
    assert.ok(guidance.includes('action="edit"'));
    assert.ok(guidance.includes("/workspace/..."));
    assert.ok(guidance.includes('aspect="landscape"'));
    assert.ok(guidance.includes('model_preference="qwen"'));
  });
});

describe("resolveReplyMediaLocalRoots", () => {
  it("merges configured mediaLocalRoots with workspace and browser roots", () => {
    const roots = resolveReplyMediaLocalRoots(
      {
        channels: {
          wecom: {
            mediaLocalRoots: ["/tmp/reply-media"],
          },
        },
      },
      "test-agent",
    );
    assert.ok(roots.includes("/tmp/reply-media"));
    assert.ok(roots.includes(path.join(os.homedir(), ".openclaw", "workspace-test-agent")));
    assert.ok(roots.includes(path.join(os.homedir(), ".openclaw", "media", "browser")));
  });

  it("merges account-level mediaLocalRoots in multi-account mode", () => {
    const roots = resolveReplyMediaLocalRoots(
      {
        channels: {
          wecom: {
            defaultAccount: "main",
            main: {
              botId: "bot1",
              secret: "sec1",
              mediaLocalRoots: ["/tmp/account-media"],
            },
          },
        },
      },
      "test-agent",
    );
    assert.ok(roots.includes("/tmp/account-media"), `expected /tmp/account-media in ${roots}`);
  });

  it("includes account-level mediaLocalRoots in guidance (multi-account mode)", () => {
    const guidance = buildReplyMediaGuidance(
      {
        channels: {
          wecom: {
            defaultAccount: "main",
            main: {
              botId: "bot1",
              secret: "sec1",
              mediaLocalRoots: ["/tmp/account-media"],
            },
          },
        },
      },
      "test-agent",
    );
    assert.ok(
      guidance.includes("/tmp/account-media"),
      `expected /tmp/account-media in guidance`,
    );
  });
});

describe("normalizeReplyMediaUrlForLoad", () => {
  it("rewrites /workspace paths into the agent workspace dir", () => {
    const expected = path.join(os.homedir(), ".openclaw", "workspace-test-agent", "skills", "deep-research", "SKILL.md");
    const normalized = normalizeReplyMediaUrlForLoad("FILE:/workspace/skills/deep-research/SKILL.md".replace(/^FILE:/, ""), {}, "test-agent");
    assert.equal(normalized, expected);
  });

  it("rewrites sandbox:/workspace paths into the agent workspace dir", () => {
    const expected = path.join(os.homedir(), ".openclaw", "workspace-test-agent", "report.pdf");
    const normalized = normalizeReplyMediaUrlForLoad("sandbox:/workspace/report.pdf", {}, "test-agent");
    assert.equal(normalized, expected);
  });

  it("rejects /workspace traversal attempts", () => {
    const normalized = normalizeReplyMediaUrlForLoad("/workspace/../secret.txt", {}, "test-agent");
    assert.equal(normalized, "");
  });
});
