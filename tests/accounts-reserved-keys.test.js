/**
 * Tests for accounts.js RESERVED_KEYS — covering issue #79.
 * Ensures top-level config keys (network, commands, etc.) are NOT
 * treated as account IDs in dictionary mode.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listAccountIds, resolveAccount } from "../wecom/accounts.js";

describe("RESERVED_KEYS — dictionary mode (issue #79)", () => {
  it("does not treat 'network' as an account ID", () => {
    const cfg = {
      channels: {
        wecom: {
          bot1: {
            token: "tok-1",
            encodingAesKey: "a".repeat(43),
          },
          network: {
            egressProxyUrl: "http://proxy:8080",
            apiBaseUrl: "https://my-gateway.example.com",
          },
        },
      },
    };

    const ids = listAccountIds(cfg);
    assert.ok(!ids.includes("network"), "network should not be an account ID");
    assert.deepEqual(ids, ["bot1"]);
  });

  it("does not treat shared channel config keys as account IDs", () => {
    const cfg = {
      channels: {
        wecom: {
          mybot: {
            token: "tok-1",
            encodingAesKey: "a".repeat(43),
          },
          commands: { enabled: true, allowlist: ["/new"] },
          dynamicAgents: { enabled: true },
          dm: { createAgentOnFirstMessage: true },
          groupChat: { enabled: true },
          welcomeMessage: "hello",
          welcomeMessagesFile: "welcome.json",
          adminUsers: ["admin1"],
          workspaceTemplate: "/path/to/templates",
          workspaceTemplateExtraFiles: ["scripts/", "requirements.txt"],
          instances: [],
        },
      },
    };

    const ids = listAccountIds(cfg);
    assert.deepEqual(ids, ["mybot"]);
  });

  it("legacy config with network still works", () => {
    const cfg = {
      channels: {
        wecom: {
          token: "legacy-tok",
          encodingAesKey: "b".repeat(43),
          network: {
            egressProxyUrl: "http://proxy:8080",
          },
        },
      },
    };

    const ids = listAccountIds(cfg);
    assert.deepEqual(ids, ["default"]);

    const account = resolveAccount(cfg, "default");
    assert.equal(account.config.token, "legacy-tok");
  });
});
