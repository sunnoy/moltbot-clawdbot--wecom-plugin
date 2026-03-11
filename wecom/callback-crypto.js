/**
 * WeCom self-built app callback cryptography utilities.
 *
 * Implements the signature verification and AES-256-CBC decryption required
 * by the WeCom callback protocol:
 *   https://developer.work.weixin.qq.com/document/path/90239
 */

import crypto from "node:crypto";

/**
 * Verify a WeCom callback request signature.
 *
 * Signature algorithm:
 *   SHA1( sort([token, timestamp, nonce, msgEncrypt]).join("") )
 * The result must equal the `msg_signature` query parameter.
 *
 * @param {object} params
 * @param {string} params.token          - Callback token from account config
 * @param {string} params.timestamp      - `timestamp` query parameter
 * @param {string} params.nonce          - `nonce` query parameter
 * @param {string} params.msgEncrypt     - The ciphertext extracted from the XML body
 * @param {string} params.signature      - `msg_signature` query parameter to verify against
 * @returns {boolean}
 */
export function verifyCallbackSignature({ token, timestamp, nonce, msgEncrypt, signature }) {
  const items = [String(token), String(timestamp), String(nonce), String(msgEncrypt)].sort();
  const digest = crypto.createHash("sha1").update(items.join("")).digest("hex");
  return digest === String(signature);
}

/**
 * Decrypt a WeCom AES-256-CBC encrypted callback message.
 *
 * Key derivation:
 *   key = Base64Decode(encodingAESKey + "=")  → 32 bytes
 *   iv  = key.slice(0, 16)
 *
 * Plaintext layout (after PKCS7 unpad):
 *   [ 16 random bytes | 4-byte msgLen (big-endian) | msgXml | corpId ]
 *
 * @param {object} params
 * @param {string} params.encodingAESKey - 43-char key from WeCom config
 * @param {string} params.encrypted      - Base64-encoded ciphertext
 * @returns {{ xml: string, corpId: string }}
 */
export function decryptCallbackMessage({ encodingAESKey, encrypted }) {
  const key = Buffer.from(encodingAESKey + "=", "base64"); // 32 bytes
  const iv = key.subarray(0, 16);
  const ciphertext = Buffer.from(encrypted, "base64");

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Strip PKCS7 padding
  const padLen = decrypted[decrypted.length - 1];
  if (padLen < 1 || padLen > 32) {
    throw new Error(`Invalid PKCS7 padding byte: ${padLen}`);
  }
  const content = decrypted.subarray(0, decrypted.length - padLen);

  // Strip 16-byte random prefix
  const withoutRandom = content.subarray(16);

  // Read 4-byte big-endian message length
  if (withoutRandom.length < 4) {
    throw new Error("Decrypted content too short");
  }
  const msgLen = withoutRandom.readUInt32BE(0);

  if (withoutRandom.length < 4 + msgLen) {
    throw new Error(`Decrypted content shorter than declared msgLen (${msgLen})`);
  }

  const xml = withoutRandom.subarray(4, 4 + msgLen).toString("utf8");
  const corpId = withoutRandom.subarray(4 + msgLen).toString("utf8");

  return { xml, corpId };
}
