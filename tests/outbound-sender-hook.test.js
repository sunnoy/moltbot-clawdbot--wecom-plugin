import assert from "node:assert/strict";
import { describe, it } from "node:test";
import plugin from "../index.js";

function createTestPluginApi(input = {}) {
  const hooks = new Map();
  return {
    id: "wecom",
    name: "wecom",
    source: "/fake/wecom",
    config: {},
    pluginConfig: {},
    runtime: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    registerContextEngine() {},
    resolvePath(value) {
      return value;
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
    hooks,
    ...input,
  };
}

describe("before_tool_call sender injection", () => {
  it("rewrites cross-chat wecom message sends with a sender protocol header", () => {
    const api = createTestPluginApi();
    plugin.register(api);

    const hook = api.hooks.get("before_tool_call");
    assert.equal(typeof hook, "function");

    const result = hook(
      {
        toolName: "message",
        params: {
          action: "send",
          channel: "wecom",
          target: "韦元栋",
          message: "你好",
        },
      },
      {
        agentId: "wecom-dm-lirui",
        toolName: "message",
      },
    );

    assert.deepEqual(result, {
      params: {
        action: "send",
        channel: "wecom",
        target: "韦元栋",
        message: "[[sender:lirui]]\n你好",
      },
    });
  });
});
