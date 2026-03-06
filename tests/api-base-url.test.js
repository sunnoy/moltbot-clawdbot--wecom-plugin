/**
 * Tests for constants.js apiBaseUrl override — covering issue #79.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AGENT_API_ENDPOINTS, setApiBaseUrl, getWebhookBotSendUrl, getWebhookBotUploadUrl } from "../wecom/constants.js";

describe("apiBaseUrl override (issue #79)", () => {
  afterEach(() => {
    // Reset to default.
    setApiBaseUrl("");
    delete process.env.WECOM_API_BASE_URL;
  });

  it("uses default qyapi.weixin.qq.com when not configured", () => {
    setApiBaseUrl("");
    assert.match(AGENT_API_ENDPOINTS.GET_TOKEN, /qyapi\.weixin\.qq\.com/);
    assert.match(AGENT_API_ENDPOINTS.SEND_MESSAGE, /qyapi\.weixin\.qq\.com/);
    assert.match(getWebhookBotSendUrl(), /qyapi\.weixin\.qq\.com/);
    assert.match(getWebhookBotUploadUrl(), /qyapi\.weixin\.qq\.com/);
  });

  it("overrides base URL via setApiBaseUrl", () => {
    setApiBaseUrl("https://my-proxy.example.com");
    assert.equal(AGENT_API_ENDPOINTS.GET_TOKEN, "https://my-proxy.example.com/cgi-bin/gettoken");
    assert.equal(AGENT_API_ENDPOINTS.SEND_MESSAGE, "https://my-proxy.example.com/cgi-bin/message/send");
    assert.equal(AGENT_API_ENDPOINTS.UPLOAD_MEDIA, "https://my-proxy.example.com/cgi-bin/media/upload");
    assert.equal(getWebhookBotSendUrl(), "https://my-proxy.example.com/cgi-bin/webhook/send");
  });

  it("strips trailing slashes from base URL", () => {
    setApiBaseUrl("https://my-proxy.example.com///");
    assert.equal(AGENT_API_ENDPOINTS.GET_TOKEN, "https://my-proxy.example.com/cgi-bin/gettoken");
  });

  it("env var WECOM_API_BASE_URL takes precedence over config", () => {
    setApiBaseUrl("https://config-url.example.com");
    process.env.WECOM_API_BASE_URL = "https://env-url.example.com";
    assert.equal(AGENT_API_ENDPOINTS.GET_TOKEN, "https://env-url.example.com/cgi-bin/gettoken");
  });

  it("falls back to config when env var is empty", () => {
    setApiBaseUrl("https://config-url.example.com");
    process.env.WECOM_API_BASE_URL = "";
    assert.equal(AGENT_API_ENDPOINTS.GET_TOKEN, "https://config-url.example.com/cgi-bin/gettoken");
  });
});
