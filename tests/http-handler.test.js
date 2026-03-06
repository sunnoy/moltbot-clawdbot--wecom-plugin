/**
 * Tests for http-handler.js — covering issue #81 (SPA redirect when no targets).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webhookTargets } from "../wecom/state.js";
import { wecomHttpHandler, createWecomRouteHandler } from "../wecom/http-handler.js";

function mockReq(method, url) {
  return {
    method,
    url: url || "/webhooks/wecom",
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true }) };
    },
  };
}

function mockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, headers) {
      res.statusCode = code;
      res.headers = headers || {};
    },
    end(body) {
      res.body = body || "";
    },
  };
  return res;
}

describe("wecomHttpHandler — no targets registered (issue #81)", () => {
  beforeEach(() => {
    webhookTargets.clear();
  });

  afterEach(() => {
    webhookTargets.clear();
  });

  it("returns true (handled) and 404 when no targets match — prevents SPA fallback", async () => {
    const req = mockReq("GET", "/webhooks/wecom");
    const res = mockRes();

    const handled = await wecomHttpHandler(req, res);

    assert.equal(handled, true, "should return true to prevent SPA fallback");
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /No WeCom webhook target configured/);
  });

  it("returns true and 404 for POST when no targets", async () => {
    const req = mockReq("POST", "/webhooks/wecom");
    const res = mockRes();

    const handled = await wecomHttpHandler(req, res);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 404);
  });

  it("returns true and 404 for unknown sub-path", async () => {
    const req = mockReq("GET", "/webhooks/unknown-account");
    const res = mockRes();

    const handled = await wecomHttpHandler(req, res);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 404);
  });
});

describe("createWecomRouteHandler — no targets registered", () => {
  beforeEach(() => {
    webhookTargets.clear();
  });

  afterEach(() => {
    webhookTargets.clear();
  });

  it("returns 503 when no targets for route path", async () => {
    const handler = createWecomRouteHandler("/webhooks/wecom");
    const req = mockReq("GET", "/webhooks/wecom");
    const res = mockRes();

    await handler(req, res);

    assert.equal(res.statusCode, 503);
    assert.match(res.body, /No webhook target configured/);
  });
});
