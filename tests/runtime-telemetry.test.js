import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { wecomChannelPlugin } from "../wecom/channel-plugin.js";
import {
  forecastActiveSendQuota,
  forecastReplyQuota,
  getAccountTelemetry,
  markAccountDisplaced,
  recordActiveSend,
  recordInboundMessage,
  recordPassiveReply,
  resetRuntimeTelemetryForTesting,
} from "../wecom/runtime-telemetry.js";

describe("runtime telemetry", () => {
  beforeEach(() => {
    resetRuntimeTelemetryForTesting();
  });

  it("resets 24h reply quota when a new inbound message arrives", () => {
    const at = Date.UTC(2026, 2, 9, 0, 0, 0);

    recordInboundMessage({ accountId: "default", chatId: "lirui", at });
    recordPassiveReply({ accountId: "default", chatId: "lirui", at: at + 1_000 });
    recordPassiveReply({ accountId: "default", chatId: "lirui", at: at + 2_000 });

    let quota = forecastReplyQuota({ accountId: "default", chatId: "lirui", at: at + 2_500 });
    assert.equal(quota.windowActive, true);
    assert.equal(quota.used, 2);

    recordInboundMessage({ accountId: "default", chatId: "lirui", at: at + 10_000 });
    quota = forecastReplyQuota({ accountId: "default", chatId: "lirui", at: at + 10_500 });
    assert.equal(quota.windowActive, true);
    assert.equal(quota.used, 0);
    assert.equal(quota.remaining, 30);
  });

  it("prioritizes 24h reply quota for active sends, then falls back to daily active quota", () => {
    const at = Date.UTC(2026, 2, 9, 0, 0, 0);

    recordInboundMessage({ accountId: "default", chatId: "lirui", at });
    let forecast = forecastActiveSendQuota({ accountId: "default", chatId: "lirui", at: at + 1_000 });
    assert.equal(forecast.bucket, "reply24h");
    assert.equal(forecast.used, 0);

    for (let index = 0; index < 30; index += 1) {
      recordActiveSend({ accountId: "default", chatId: "lirui", at: at + 2_000 + index });
    }

    forecast = forecastActiveSendQuota({ accountId: "default", chatId: "lirui", at: at + 5_000 });
    assert.equal(forecast.bucket, "activeDaily");
    assert.equal(forecast.used, 0);

    recordActiveSend({ accountId: "default", chatId: "lirui", at: at + 6_000 });
    forecast = forecastActiveSendQuota({ accountId: "default", chatId: "lirui", at: at + 7_000 });
    assert.equal(forecast.bucket, "activeDaily");
    assert.equal(forecast.used, 1);
  });

  it("tracks displaced connections and quota pressure for status issues", () => {
    const at = Date.UTC(2026, 2, 9, 0, 0, 0);

    recordInboundMessage({ accountId: "default", chatId: "lirui", at });
    for (let index = 0; index < 30; index += 1) {
      recordPassiveReply({ accountId: "default", chatId: "lirui", at: at + index + 1 });
    }
    markAccountDisplaced({
      accountId: "default",
      reason: "taken over by another instance",
      at: at + 60_000,
    });

    const telemetry = getAccountTelemetry("default", { now: at + 61_000 });
    assert.equal(telemetry.connection.displaced, true);
    assert.equal(telemetry.quotas.exhaustedReplyChats, 1);

    const issues = wecomChannelPlugin.status.collectStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        wecomStatus: telemetry,
      },
    ], {
      cfg: {},
    });

    assert.ok(issues.some((issue) => issue.message.includes("长连接已被其他实例接管")));
    assert.ok(issues.some((issue) => issue.message.includes("配额已触顶")));
  });
});
