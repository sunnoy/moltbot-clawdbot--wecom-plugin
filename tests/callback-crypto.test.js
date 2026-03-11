/**
 * Unit tests for callback-crypto.js
 *
 * Tests the WeCom callback signature-verification and AES-256-CBC
 * decryption helpers without any external dependencies.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyCallbackSignature, decryptCallbackMessage } from "../wecom/callback-crypto.js";

// ---------------------------------------------------------------------------
// Helpers shared across test cases
// ---------------------------------------------------------------------------

/**
 * Compute the expected WeCom `msg_signature`.
 * SHA1(sort([token, timestamp, nonce, msgEncrypt]).join(""))
 */
function computeSignature({ token, timestamp, nonce, msgEncrypt }) {
  const items = [token, timestamp, nonce, msgEncrypt].sort();
  return crypto.createHash("sha1").update(items.join("")).digest("hex");
}

/**
 * Generate a 43-char `encodingAESKey` compatible with WeCom protocol and
 * return the underlying key buffer together with the IV (first 16 bytes).
 */
function makeTestKey() {
  const keyBuf = crypto.randomBytes(32);
  // WeCom encodingAESKey = base64 of 32 bytes without trailing "=" padding
  const encodingAESKey = keyBuf.toString("base64").replace(/=+$/, "");
  const iv = keyBuf.subarray(0, 16);
  return { keyBuf, iv, encodingAESKey };
}

/**
 * Encrypt a callback message the same way WeCom does:
 * [ 16 random bytes | 4-byte msgLen BE | msgXml | corpId ]
 * padded with PKCS7 (block size 32) and encrypted with AES-256-CBC.
 */
function encryptForCallback({ keyBuf, iv, xml, corpId }) {
  const plainBuf = Buffer.from(xml, "utf8");
  const random = crypto.randomBytes(16);
  const msgLen = Buffer.allocUnsafe(4);
  msgLen.writeUInt32BE(plainBuf.length, 0);
  const corpBuf = Buffer.from(corpId, "utf8");
  const content = Buffer.concat([random, msgLen, plainBuf, corpBuf]);

  // PKCS7 padding (block size 32)
  const blockSize = 32;
  const padLen = blockSize - (content.length % blockSize);
  const padded = Buffer.concat([content, Buffer.alloc(padLen, padLen)]);

  const cipher = crypto.createCipheriv("aes-256-cbc", keyBuf, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

// ---------------------------------------------------------------------------
// verifyCallbackSignature
// ---------------------------------------------------------------------------

describe("verifyCallbackSignature", () => {
  it("returns true for a correctly computed signature", () => {
    const token = "myCallbackToken";
    const timestamp = "1700000000";
    const nonce = "randomNonce42";
    const msgEncrypt = "AAABBBCCC==";

    const signature = computeSignature({ token, timestamp, nonce, msgEncrypt });
    assert.equal(
      verifyCallbackSignature({ token, timestamp, nonce, msgEncrypt, signature }),
      true,
    );
  });

  it("returns false when the token is wrong", () => {
    const timestamp = "1700000000";
    const nonce = "randomNonce42";
    const msgEncrypt = "AAABBBCCC==";

    const signature = computeSignature({ token: "correct", timestamp, nonce, msgEncrypt });
    assert.equal(
      verifyCallbackSignature({ token: "wrong", timestamp, nonce, msgEncrypt, signature }),
      false,
    );
  });

  it("returns false when msgEncrypt is tampered", () => {
    const token = "myCallbackToken";
    const timestamp = "1700000000";
    const nonce = "randomNonce42";
    const msgEncrypt = "original==";

    const signature = computeSignature({ token, timestamp, nonce, msgEncrypt });
    assert.equal(
      verifyCallbackSignature({ token, timestamp, nonce, msgEncrypt: "tampered==", signature }),
      false,
    );
  });

  it("returns false for an empty signature", () => {
    const token = "t";
    const timestamp = "0";
    const nonce = "n";
    const msgEncrypt = "c";
    assert.equal(
      verifyCallbackSignature({ token, timestamp, nonce, msgEncrypt, signature: "" }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// decryptCallbackMessage
// ---------------------------------------------------------------------------

describe("decryptCallbackMessage", () => {
  it("correctly decrypts an encrypted text message", () => {
    const { keyBuf, iv, encodingAESKey } = makeTestKey();
    const xml = "<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content></xml>";
    const corpId = "wxa1b2c3d4e5f6";

    const encrypted = encryptForCallback({ keyBuf, iv, xml, corpId });
    const result = decryptCallbackMessage({ encodingAESKey, encrypted });

    assert.equal(result.xml, xml);
    assert.equal(result.corpId, corpId);
  });

  it("handles the maximum WeCom XML message size (~2 KB) without corruption", () => {
    const { keyBuf, iv, encodingAESKey } = makeTestKey();
    const longContent = "a".repeat(1900);
    const xml = `<xml><Content><![CDATA[${longContent}]]></Content></xml>`;
    const corpId = "wxCORPID00000001";

    const encrypted = encryptForCallback({ keyBuf, iv, xml, corpId });
    const { xml: gotXml, corpId: gotCorpId } = decryptCallbackMessage({ encodingAESKey, encrypted });

    assert.equal(gotXml, xml);
    assert.equal(gotCorpId, corpId);
  });

  it("preserves UTF-8 multi-byte characters in xml", () => {
    const { keyBuf, iv, encodingAESKey } = makeTestKey();
    const xml = "<xml><Content><![CDATA[你好 世界 🌍]]></Content></xml>";
    const corpId = "wxUTF8TEST";

    const encrypted = encryptForCallback({ keyBuf, iv, xml, corpId });
    const { xml: gotXml } = decryptCallbackMessage({ encodingAESKey, encrypted });
    assert.equal(gotXml, xml);
  });

  it("throws for invalid PKCS7 padding (pad byte = 0)", () => {
    const { keyBuf, iv, encodingAESKey } = makeTestKey();

    // Build a 32-byte block where the last byte is 0 — invalid PKCS7
    const badBuf = Buffer.alloc(32, 0);
    const cipher = crypto.createCipheriv("aes-256-cbc", keyBuf, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(badBuf), cipher.final()]).toString("base64");

    assert.throws(
      () => decryptCallbackMessage({ encodingAESKey, encrypted }),
      /Invalid PKCS7/,
    );
  });

  it("throws for padding byte greater than 32", () => {
    const { keyBuf, iv, encodingAESKey } = makeTestKey();

    const badBuf = Buffer.alloc(32, 33); // every byte = 33, which is > 32 (invalid PKCS7)
    const cipher = crypto.createCipheriv("aes-256-cbc", keyBuf, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(badBuf), cipher.final()]).toString("base64");

    assert.throws(
      () => decryptCallbackMessage({ encodingAESKey, encrypted }),
      /Invalid PKCS7/,
    );
  });
});
