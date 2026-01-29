import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { CONSTANTS } from "./utils.js";
import { logger } from "./logger.js";

/**
 * Enterprise WeChat Intelligent Robot Crypto Implementation
 * Simplified for AI Bot mode (no corpId validation)
 */
export class WxWorkCrypto {
    token;
    encodingAesKey;
    aesKey;
    iv;

    constructor(token, encodingAesKey) {
        if (!encodingAesKey || encodingAesKey.length !== CONSTANTS.AES_KEY_LENGTH) {
            throw new Error(`EncodingAESKey invalid: length must be ${CONSTANTS.AES_KEY_LENGTH}`);
        }
        if (!token) {
            throw new Error("Token is required");
        }
        this.token = token;
        this.encodingAesKey = encodingAesKey;
        this.aesKey = Buffer.from(encodingAesKey + "=", "base64");
        this.iv = this.aesKey.subarray(0, 16);
        logger.debug("WxWorkCrypto initialized (AI Bot mode)");
    }

    getSignature(timestamp, nonce, encrypt) {
        const shasum = createHash("sha1");
        const arr = [this.token, timestamp, nonce, encrypt].sort();
        shasum.update(arr.join(""));
        return shasum.digest("hex");
    }

    decrypt(text) {
        let decipher;
        try {
            decipher = createDecipheriv("aes-256-cbc", this.aesKey, this.iv);
            decipher.setAutoPadding(false);
        } catch (e) {
            throw new Error(`Decrypt init failed: ${String(e)}`);
        }

        let deciphered = Buffer.concat([
            decipher.update(text, "base64"),
            decipher.final(),
        ]);

        deciphered = this.decodePkcs7(deciphered);

        // Format: 16 random bytes | 4 bytes msg_len | msg_content | appid
        const content = deciphered.subarray(16);
        const lenList = content.subarray(0, 4);
        const xmlLen = lenList.readUInt32BE(0);
        const xmlContent = content.subarray(4, 4 + xmlLen).toString("utf-8");
        // For AI Bot mode, corpId/appid is empty, skip validation

        return { message: xmlContent };
    }

    encrypt(text) {
        // For AI Bot mode, corpId is empty
        const random16 = randomBytes(16);
        const msgBuffer = Buffer.from(text);
        const lenBuffer = Buffer.alloc(4);
        lenBuffer.writeUInt32BE(msgBuffer.length, 0);

        const rawMsg = Buffer.concat([random16, lenBuffer, msgBuffer]);
        const encoded = this.encodePkcs7(rawMsg);

        const cipher = createCipheriv("aes-256-cbc", this.aesKey, this.iv);
        cipher.setAutoPadding(false);
        const ciphered = Buffer.concat([cipher.update(encoded), cipher.final()]);
        return ciphered.toString("base64");
    }

    encodePkcs7(buff) {
        const blockSize = CONSTANTS.AES_BLOCK_SIZE;
        const amountToPad = blockSize - (buff.length % blockSize);
        const pad = Buffer.alloc(amountToPad, amountToPad);
        return Buffer.concat([buff, pad]);
    }

    decodePkcs7(buff) {
        const pad = buff[buff.length - 1];
        if (pad < 1 || pad > CONSTANTS.AES_BLOCK_SIZE) {
            throw new Error(`Invalid PKCS7 padding: ${pad}`);
        }
        for (let i = buff.length - pad; i < buff.length; i++) {
            if (buff[i] !== pad) {
                throw new Error("Invalid PKCS7 padding: inconsistent padding bytes");
            }
        }
        return buff.subarray(0, buff.length - pad);
    }
}

export const xmlParser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false
});

export const xmlBuilder = new XMLBuilder({
    format: false,
    ignoreAttributes: true
});
