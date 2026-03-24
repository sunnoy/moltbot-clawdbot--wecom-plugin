import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyOutboundSenderProtocol,
  ensureOutboundSenderProtocol,
  prepareWecomMessageToolParams,
  resolveOutboundSenderLabel,
} from "../wecom/outbound-sender-protocol.js";

describe("outbound sender protocol", () => {
  it("leaves normal content unchanged", () => {
    assert.deepEqual(applyOutboundSenderProtocol("你好"), {
      sender: "",
      content: "你好",
      usedProtocol: false,
    });
  });

  it("converts sender protocol to visible inline prefix", () => {
    assert.deepEqual(applyOutboundSenderProtocol("[[sender:lirui]]\n你好"), {
      sender: "lirui",
      content: "【sender:lirui】你好",
      usedProtocol: true,
    });
  });

  it("keeps multiline bodies readable", () => {
    assert.deepEqual(applyOutboundSenderProtocol("[[sender:lirui]]\n第一行\n第二行"), {
      sender: "lirui",
      content: "【sender:lirui】\n第一行\n第二行",
      usedProtocol: true,
    });
  });

  it("adds a protocol header when missing", () => {
    assert.equal(ensureOutboundSenderProtocol("你好", "lirui"), "[[sender:lirui]]\n你好");
  });
});

describe("resolveOutboundSenderLabel", () => {
  it("uses dm peer ids for dynamic dm agents", () => {
    assert.equal(resolveOutboundSenderLabel("wecom-dm-lirui"), "lirui");
    assert.equal(resolveOutboundSenderLabel("wecom-sales-dm-lirui"), "lirui");
  });

  it("uses explicit group labels for dynamic group agents", () => {
    assert.equal(resolveOutboundSenderLabel("wecom-group-wr123"), "group:wr123");
    assert.equal(resolveOutboundSenderLabel("wecom-sales-group-wr123"), "group:wr123");
  });

  it("falls back to normalized plain agent ids", () => {
    assert.equal(resolveOutboundSenderLabel("main"), "main");
    assert.equal(resolveOutboundSenderLabel(""), "main");
  });
});

describe("prepareWecomMessageToolParams", () => {
  it("injects sender protocol for cross-chat wecom sends from dynamic dm agents", () => {
    assert.deepEqual(
      prepareWecomMessageToolParams(
        {
          action: "send",
          channel: "wecom",
          target: "韦元栋",
          message: "你好",
        },
        "wecom-dm-lirui",
      ),
      {
        action: "send",
        channel: "wecom",
        target: "韦元栋",
        message: "[[sender:lirui]]\n你好",
      },
    );
  });

  it("does not inject for same-chat dm targets", () => {
    const params = {
      action: "send",
      channel: "wecom",
      target: "lirui",
      message: "你好",
    };
    assert.equal(prepareWecomMessageToolParams(params, "wecom-dm-lirui"), params);
  });

  it("does not inject for non-dynamic agents", () => {
    const params = {
      action: "send",
      channel: "wecom",
      target: "weiyuandong",
      message: "你好",
    };
    assert.equal(prepareWecomMessageToolParams(params, "main"), params);
  });
});
