import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldUseDynamicAgent } from "../dynamic-agent.js";

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
