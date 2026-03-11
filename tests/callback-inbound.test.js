/**
 * Unit tests for callback-inbound.js
 *
 * Tests the XML parser and the HTTP handler factory (security checks & routing).
 * The `processCallbackMessage` dispatch path exercises the full OpenClaw core
 * and is tested through integration tests; here we test only the request
 * validation and parsing logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { parseCallbackMessageXml, createCallbackHandler } from "../wecom/callback-inbound.js";

// ---------------------------------------------------------------------------
// Crypto helpers (mirror callback-crypto.js internals for test data creation)
// ---------------------------------------------------------------------------

function computeSignature({ token, timestamp, nonce, msgEncrypt }) {
  const items = [token, timestamp, nonce, msgEncrypt].sort();
  return crypto.createHash("sha1").update(items.join("")).digest("hex");
}

function makeTestKey() {
  const keyBuf = crypto.randomBytes(32);
  const encodingAESKey = keyBuf.toString("base64").replace(/=+$/, "");
  const iv = keyBuf.subarray(0, 16);
  return { keyBuf, iv, encodingAESKey };
}

function encryptForCallback({ keyBuf, iv, xml, corpId }) {
  const plainBuf = Buffer.from(xml, "utf8");
  const random = crypto.randomBytes(16);
  const msgLen = Buffer.allocUnsafe(4);
  msgLen.writeUInt32BE(plainBuf.length, 0);
  const corpBuf = Buffer.from(corpId, "utf8");
  const content = Buffer.concat([random, msgLen, plainBuf, corpBuf]);
  const blockSize = 32;
  const padLen = blockSize - (content.length % blockSize);
  const padded = Buffer.concat([content, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", keyBuf, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function wrapInOuterXml(msgEncrypt) {
  return `<xml><Encrypt><![CDATA[${msgEncrypt}]]></Encrypt></xml>`;
}

// ---------------------------------------------------------------------------
// Mock HTTP request / response helpers
// ---------------------------------------------------------------------------

function makeMockReq({ method, url, body = "" }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  // Emit data asynchronously (mirrors real readable stream behaviour)
  process.nextTick(() => {
    if (body) req.emit("data", Buffer.from(body, "utf8"));
    req.emit("end");
  });
  return req;
}

function makeMockRes() {
  const res = {
    status: null,
    headers: {},
    body: "",
    writeHead(code, hdrs = {}) {
      this.status = code;
      Object.assign(this.headers, hdrs);
    },
    end(data = "") {
      this.body = String(data);
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Test account factory
// ---------------------------------------------------------------------------

function makeAccount(overrides = {}) {
  const { keyBuf, iv, encodingAESKey } = makeTestKey();
  const corpId = "wxTESTCORPID0001";

  return {
    accountId: "test",
    callbackConfig: {
      token: "testToken123",
      encodingAESKey,
      corpId,
      path: "/api/channels/wecom/callback",
    },
    agentCredentials: { corpId, corpSecret: "secret", agentId: 100001 },
    config: {},
    // Expose raw key material so callers can construct valid test messages
    _keyBuf: keyBuf,
    _iv: iv,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseCallbackMessageXml
// ---------------------------------------------------------------------------

describe("parseCallbackMessageXml", () => {
  it("returns null for an event message", () => {
    const xml = `<xml>
      <ToUserName><![CDATA[toUser]]></ToUserName>
      <FromUserName><![CDATA[fromUser001]]></FromUserName>
      <MsgType><![CDATA[event]]></MsgType>
      <Event><![CDATA[enter_chat]]></Event>
    </xml>`;
    assert.equal(parseCallbackMessageXml(xml), null);
  });

  it("returns null when FromUserName is empty", () => {
    const xml = `<xml>
      <FromUserName><![CDATA[]]></FromUserName>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[hello]]></Content>
      <MsgId>12345</MsgId>
    </xml>`;
    assert.equal(parseCallbackMessageXml(xml), null);
  });

  it("parses a text message", () => {
    const xml = `<xml>
      <FromUserName><![CDATA[lisi]]></FromUserName>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[你好世界]]></Content>
      <MsgId>88888888</MsgId>
    </xml>`;
    const msg = parseCallbackMessageXml(xml);
    assert.ok(msg);
    assert.equal(msg.senderId, "lisi");
    assert.equal(msg.text, "你好世界");
    assert.equal(msg.msgId, "88888888");
    assert.equal(msg.isGroupChat, false);
    assert.equal(msg.mediaId, null);
  });

  it("parses an image message", () => {
    const xml = `<xml>
      <FromUserName><![CDATA[userABC]]></FromUserName>
      <MsgType><![CDATA[image]]></MsgType>
      <MediaId><![CDATA[MEDIA_ID_001]]></MediaId>
      <MsgId>99999</MsgId>
    </xml>`;
    const msg = parseCallbackMessageXml(xml);
    assert.ok(msg);
    assert.equal(msg.senderId, "userABC");
    assert.equal(msg.mediaId, "MEDIA_ID_001");
    assert.equal(msg.mediaType, "image");
    assert.equal(msg.text, null);
  });

  it("parses a voice message and prefers Recognition as text", () => {
    const xml = `<xml>
      <FromUserName><![CDATA[voiceUser]]></FromUserName>
      <MsgType><![CDATA[voice]]></MsgType>
      <MediaId><![CDATA[VOICE_MEDIA]]></MediaId>
      <Recognition><![CDATA[今天天气怎么样]]></Recognition>
      <MsgId>55555</MsgId>
    </xml>`;
    const msg = parseCallbackMessageXml(xml);
    assert.ok(msg);
    assert.equal(msg.mediaType, "voice");
    assert.equal(msg.voiceRecognition, "今天天气怎么样");
    assert.equal(msg.text, "今天天气怎么样");
  });

  it("parses a file message", () => {
    const xml = `<xml>
      <FromUserName><![CDATA[fileUser]]></FromUserName>
      <MsgType><![CDATA[file]]></MsgType>
      <MediaId><![CDATA[FILE_MEDIA_123]]></MediaId>
      <MsgId>11111</MsgId>
    </xml>`;
    const msg = parseCallbackMessageXml(xml);
    assert.ok(msg);
    assert.equal(msg.mediaType, "file");
    assert.equal(msg.mediaId, "FILE_MEDIA_123");
  });

  it("returns null for an unknown MsgType", () => {
    const xml = `<xml>
      <FromUserName><![CDATA[u1]]></FromUserName>
      <MsgType><![CDATA[location]]></MsgType>
      <MsgId>22222</MsgId>
    </xml>`;
    assert.equal(parseCallbackMessageXml(xml), null);
  });
});

// ---------------------------------------------------------------------------
// createCallbackHandler — GET (URL verification)
// ---------------------------------------------------------------------------

describe("createCallbackHandler GET", () => {
  it("returns 403 when the GET signature is invalid", async () => {
    const account = makeAccount();
    const { token, path } = account.callbackConfig;

    const echostrCipher = "INVALIDCIPHERTEXT==";
    // Deliberately compute signature with wrong token
    const signature = computeSignature({
      token: "wrongToken",
      timestamp: "1700000000",
      nonce: "nonce1",
      msgEncrypt: echostrCipher,
    });

    const url =
      `${path}?msg_signature=${signature}&timestamp=1700000000&nonce=nonce1&echostr=${encodeURIComponent(echostrCipher)}`;
    const req = makeMockReq({ method: "GET", url });
    const res = makeMockRes();

    const handler = createCallbackHandler({ account, config: {}, runtime: {} });
    await handler(req, res);

    assert.equal(res.status, 403);
  });

  it("returns 400 when GET has no echostr query param", async () => {
    const account = makeAccount();
    const { path } = account.callbackConfig;

    const url = `${path}?msg_signature=abc&timestamp=1700000000&nonce=nonce1`;
    const req = makeMockReq({ method: "GET", url });
    const res = makeMockRes();

    const handler = createCallbackHandler({ account, config: {}, runtime: {} });
    await handler(req, res);

    assert.equal(res.status, 400);
  });

  it("returns 200 with the decrypted echostr for a valid GET", async () => {
    const account = makeAccount();
    const { token, encodingAESKey, corpId, path } = account.callbackConfig;
    const { _keyBuf: keyBuf, _iv: iv } = account;

    // The echostr is itself just a random string, but WeCom wraps it the same
    // way as a message (xml = random_plain_echostr, corpId = corpId).
    const plainEchostr = String(Math.random());
    const echostrCipher = encryptForCallback({ keyBuf, iv, xml: plainEchostr, corpId });
    const timestamp = "1700000000";
    const nonce = "nonce42";
    const signature = computeSignature({ token, timestamp, nonce, msgEncrypt: echostrCipher });

    const url =
      `${path}?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostrCipher)}`;
    const req = makeMockReq({ method: "GET", url });
    const res = makeMockRes();

    const handler = createCallbackHandler({ account, config: {}, runtime: {} });
    await handler(req, res);

    assert.equal(res.status, 200);
    assert.equal(res.body, plainEchostr);
  });
});

// ---------------------------------------------------------------------------
// createCallbackHandler — POST (message callback)
// ---------------------------------------------------------------------------

describe("createCallbackHandler POST", () => {
  it("returns 405 for non-GET/POST methods", async () => {
    const account = makeAccount();
    const req = makeMockReq({ method: "PUT", url: account.callbackConfig.path });
    const res = makeMockRes();

    const handler = createCallbackHandler({ account, config: {}, runtime: {} });
    await handler(req, res);
    assert.equal(res.status, 405);
  });

  it("returns 403 when timestamp is too old", async () => {
    const account = makeAccount();
    const { token, encodingAESKey, corpId, path } = account.callbackConfig;
    const { _keyBuf: keyBuf, _iv: iv } = account;

    const innerXml = "<xml><MsgType><![CDATA[text]]></MsgType><FromUserName><![CDATA[u1]]></FromUserName><Content><![CDATA[hi]]></Content><MsgId>1</MsgId></xml>";
    const msgEncrypt = encryptForCallback({ keyBuf, iv, xml: innerXml, corpId });
    // Use a timestamp from 10 minutes ago (well outside the 5-minute tolerance)
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 700);
    const nonce = "nonce1";
    const signature = computeSignature({ token, timestamp: oldTimestamp, nonce, msgEncrypt });

    const body = wrapInOuterXml(msgEncrypt);
    const url = `${path}?msg_signature=${signature}&timestamp=${oldTimestamp}&nonce=${nonce}`;
    const req = makeMockReq({ method: "POST", url, body });
    const res = makeMockRes();

    const handler = createCallbackHandler({ account, config: {}, runtime: {} });
    await handler(req, res);
    assert.equal(res.status, 403);
  });

  it("returns 403 when the POST signature is invalid", async () => {
    const account = makeAccount();
    const { corpId, path } = account.callbackConfig;
    const { _keyBuf: keyBuf, _iv: iv } = account;

    const innerXml = "<xml><MsgType><![CDATA[text]]></MsgType><FromUserName><![CDATA[u1]]></FromUserName><Content><![CDATA[hi]]></Content><MsgId>1</MsgId></xml>";
    const msgEncrypt = encryptForCallback({ keyBuf, iv, xml: innerXml, corpId });
    const nowTs = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce2";
    // Deliberately wrong signature
    const signature = "0000000000000000000000000000000000000000";

    const body = wrapInOuterXml(msgEncrypt);
    const url = `${path}?msg_signature=${signature}&timestamp=${nowTs}&nonce=${nonce}`;
    const req = makeMockReq({ method: "POST", url, body });
    const res = makeMockRes();

    const handler = createCallbackHandler({ account, config: {}, runtime: {} });
    await handler(req, res);
    assert.equal(res.status, 403);
  });

  it("returns 403 when corpId in decrypted message does not match accountconfig", async () => {
    const account = makeAccount();
    const { token, path } = account.callbackConfig;
    const { _keyBuf: keyBuf, _iv: iv } = account;

    const innerXml = "<xml><MsgType><![CDATA[text]]></MsgType><FromUserName><![CDATA[u1]]></FromUserName><Content><![CDATA[hi]]></Content><MsgId>2</MsgId></xml>";
    // Encrypt with a different corpId so the integrity check fails
    const wrongCorpId = "wxWRONGCORPID9999";
    const msgEncrypt = encryptForCallback({ keyBuf, iv, xml: innerXml, corpId: wrongCorpId });
    const nowTs = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce3";
    const signature = computeSignature({ token, timestamp: nowTs, nonce, msgEncrypt });

    const body = wrapInOuterXml(msgEncrypt);
    const url = `${path}?msg_signature=${signature}&timestamp=${nowTs}&nonce=${nonce}`;
    const req = makeMockReq({ method: "POST", url, body });
    const res = makeMockRes();

    const handler = createCallbackHandler({ account, config: {}, runtime: {} });
    await handler(req, res);
    assert.equal(res.status, 403);
  });

  it("returns 200 and skips dispatch for an event message", async () => {
    const account = makeAccount();
    const { token, corpId, path } = account.callbackConfig;
    const { _keyBuf: keyBuf, _iv: iv } = account;

    const innerXml =
      "<xml><FromUserName><![CDATA[u1]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[enter_chat]]></Event></xml>";
    const msgEncrypt = encryptForCallback({ keyBuf, iv, xml: innerXml, corpId });
    const nowTs = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce4";
    const signature = computeSignature({ token, timestamp: nowTs, nonce, msgEncrypt });

    const body = wrapInOuterXml(msgEncrypt);
    const url = `${path}?msg_signature=${signature}&timestamp=${nowTs}&nonce=${nonce}`;
    const req = makeMockReq({ method: "POST", url, body });
    const res = makeMockRes();

    const handler = createCallbackHandler({ account, config: {}, runtime: {} });
    await handler(req, res);
    // Event messages still get an immediate 200 "success" response
    assert.equal(res.status, 200);
    assert.equal(res.body, "success");
  });
});
