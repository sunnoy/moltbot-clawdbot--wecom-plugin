import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractGroupMessageContent, shouldUseDynamicAgent } from "../dynamic-agent.js";

describe("shouldUseDynamicAgent", () => {
  it("uses dynamic agent for admin when adminBypass is disabled", () => {
    const config = {
      dynamicAgents: { enabled: true, adminBypass: false },
      dm: { createAgentOnFirstMessage: true },
    };
    const useDynamic = shouldUseDynamicAgent({
      chatType: "dm",
      config,
      senderIsAdmin: true,
    });
    assert.equal(useDynamic, true);
  });

  it("bypasses dynamic agent for admin when adminBypass is enabled", () => {
    const config = {
      dynamicAgents: { enabled: true, adminBypass: true },
      dm: { createAgentOnFirstMessage: true },
    };
    const useDynamic = shouldUseDynamicAgent({
      chatType: "dm",
      config,
      senderIsAdmin: true,
    });
    assert.equal(useDynamic, false);
  });

  it("keeps non-admin routing unchanged when adminBypass is enabled", () => {
    const config = {
      dynamicAgents: { enabled: true, adminBypass: true },
      dm: { createAgentOnFirstMessage: true },
    };
    const useDynamic = shouldUseDynamicAgent({
      chatType: "dm",
      config,
      senderIsAdmin: false,
    });
    assert.equal(useDynamic, true);
  });
});

describe("extractGroupMessageContent", () => {
  it("strips standalone group mentions", () => {
    const content = "@wecom 分析一下这个规则";
    assert.equal(extractGroupMessageContent(content, {}), "分析一下这个规则");
  });

  it("preserves embedded @ tokens inside identifiers", () => {
    const content =
      '分析 callerUri="113.57.121.58**615872@H323", calleeUri="9005271803@CONFNO" 这条规则';
    assert.equal(extractGroupMessageContent(content, {}), content);
  });

  it("removes mentions without truncating @ tokens in the body", () => {
    const content =
      '@wecom 分析 callerUri="113.57.121.58**615872@H323", calleeUri="9005271803@CONFNO"';
    assert.equal(
      extractGroupMessageContent(content, {}),
      '分析 callerUri="113.57.121.58**615872@H323", calleeUri="9005271803@CONFNO"',
    );
  });
});
