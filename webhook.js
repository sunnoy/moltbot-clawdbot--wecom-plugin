import { WxWorkCrypto } from "./crypto.js";
import { logger } from "./logger.js";
import { MessageDeduplicator, randomString } from "./utils.js";

/**
 * WxWork AI Bot Webhook Handler
 * Based on official demo: https://developer.work.weixin.qq.com/document/path/101039
 *
 * Key differences from legacy mode:
 * - Messages are JSON format, not XML
 * - receiveid is empty string for AI Bot
 * - Response uses stream message format
 */
export class WxWorkWebhook {
    config;
    crypto;
    deduplicator = new MessageDeduplicator();

    constructor(config) {
        this.config = config;
        this.crypto = new WxWorkCrypto(config.token, config.encodingAesKey);
        logger.debug("WxWorkWebhook initialized (AI Bot mode)");
    }

    // =========================================================================
    // URL Verification (GET request)
    // =========================================================================
    handleVerify(query) {
        const signature = query.msg_signature;
        const timestamp = query.timestamp;
        const nonce = query.nonce;
        const echostr = query.echostr;

        if (!signature || !timestamp || !nonce || !echostr) {
            logger.warn("Missing parameters in verify request", { query });
            return null;
        }

        logger.debug("Handling verify request", { timestamp, nonce });

        const calcSignature = this.crypto.getSignature(timestamp, nonce, echostr);
        if (calcSignature !== signature) {
            logger.error("Signature mismatch in verify", {
                expected: signature,
                calculated: calcSignature,
            });
            return null;
        }

        try {
            const result = this.crypto.decrypt(echostr);
            logger.info("URL verification successful");
            return result.message;
        }
        catch (e) {
            logger.error("Decrypt failed in verify", {
                error: e instanceof Error ? e.message : String(e),
            });
            return null;
        }
    }

    // =========================================================================
    // Message Handling (POST request)
    // AI Bot uses JSON format, not XML
    // =========================================================================
    async handleMessage(query, body) {
        const signature = query.msg_signature;
        const timestamp = query.timestamp;
        const nonce = query.nonce;

        if (!signature || !timestamp || !nonce) {
            logger.warn("Missing parameters in message request", { query });
            return null;
        }

        // 1. Parse JSON body to get encrypt field
        let encrypt;
        try {
            const jsonBody = JSON.parse(body);
            encrypt = jsonBody.encrypt;
            logger.debug("Parsed request body", { hasEncrypt: !!encrypt });
        }
        catch (e) {
            logger.error("Failed to parse request body as JSON", {
                error: e instanceof Error ? e.message : String(e),
                body: body.substring(0, 200),
            });
            return null;
        }

        if (!encrypt) {
            logger.error("No encrypt field in body");
            return null;
        }

        // 2. Verify signature
        const calcSignature = this.crypto.getSignature(timestamp, nonce, encrypt);
        if (calcSignature !== signature) {
            logger.error("Signature mismatch in message", {
                expected: signature,
                calculated: calcSignature,
            });
            return null;
        }

        // 3. Decrypt
        let decryptedContent;
        try {
            const result = this.crypto.decrypt(encrypt);
            decryptedContent = result.message;
            logger.debug("Decrypted content", { content: decryptedContent.substring(0, 300) });
        }
        catch (e) {
            logger.error("Message decrypt failed", {
                error: e instanceof Error ? e.message : String(e),
            });
            return null;
        }

        // 4. Parse decrypted JSON content (AI Bot format)
        let data;
        try {
            data = JSON.parse(decryptedContent);
            logger.debug("Parsed message data", { msgtype: data.msgtype, keys: Object.keys(data), text: JSON.stringify(data.text) });
        }
        catch (e) {
            logger.error("Failed to parse decrypted content as JSON", {
                error: e instanceof Error ? e.message : String(e),
                content: decryptedContent.substring(0, 200),
            });
            return null;
        }

        // 5. Process based on message type
        const msgtype = data.msgtype;

        if (msgtype === "text") {
            // AI Bot format: text.content
            const content = data.text?.content || "";
            const msgId = data.msgid || `msg_${Date.now()}`;
            const fromUser = data.from?.userid || "";  // Note: "userid" not "user_id"
            const responseUrl = data.response_url || "";
            const chatType = data.chattype || "single";  // "single" 或 "group"
            const chatId = data.chatid || "";  // 群聊 ID（仅群聊时存在）
            const aibotId = data.aibotid || "";  // 机器人 ID

            // 解析引用消息（可选）
            const quote = data.quote ? {
                msgType: data.quote.msgtype,
                content: data.quote.text?.content || data.quote.image?.url || "",
            } : null;

            // Check for duplicates
            if (this.deduplicator.isDuplicate(msgId)) {
                logger.debug("Duplicate message ignored", { msgId });
                return null;
            }

            logger.info("Received text message", {
                fromUser,
                chatType,
                chatId: chatId || "(private)",
                content: content.substring(0, 50)
            });

            return {
                message: {
                    msgId,
                    msgType: "text",
                    content,
                    fromUser,
                    chatType,
                    chatId,        // 群聊 ID
                    aibotId,       // 机器人 ID
                    quote,         // 引用消息
                    responseUrl,   // For async response
                },
                query: { timestamp, nonce },
            };
        }
        else if (msgtype === "stream") {
            // Stream continuation request from WxWork
            const streamId = data.stream?.id;
            logger.debug("Received stream refresh request", { streamId });
            return {
                stream: {
                    id: streamId,
                },
                query: { timestamp, nonce },
                rawData: data,  // 保留完整数据用于调试
            };
        }
        else if (msgtype === "image") {
            const imageUrl = data.image?.url;
            const msgId = data.msgid || `msg_${Date.now()}`;
            const fromUser = data.from?.userid || "";
            const responseUrl = data.response_url || "";
            logger.info("Received image message", { fromUser, imageUrl });

            return {
                message: {
                    msgId,
                    msgType: "image",
                    imageUrl,
                    fromUser,
                    responseUrl,
                },
                query: { timestamp, nonce },
            };
        }
        else if (msgtype === "event") {
            logger.info("Received event", { event: data.event });
            return {
                event: data.event,
                query: { timestamp, nonce },
            };
        }
        else if (msgtype === "mixed") {
            logger.warn("Mixed message type not fully supported", { data });
            return null;
        }
        else {
            logger.warn("Unknown message type", { msgtype });
            return null;
        }
    }

    // =========================================================================
    // Build Stream Response (AI Bot format)
    // 完整支持企业微信流式消息所有字段
    // =========================================================================
    buildStreamResponse(streamId, content, finish, timestamp, nonce, options = {}) {
        const stream = {
            id: streamId,
            finish: finish,
            content: content,  // 最长20480字节,utf8编码
        };

        // 可选: 图文混排消息列表 (仅在finish=true时支持image)
        if (options.msgItem && options.msgItem.length > 0) {
            stream.msg_item = options.msgItem;
        }

        // 可选: 用户反馈追踪ID (首次回复时设置,最长256字节)
        if (options.feedbackId) {
            stream.feedback = { id: options.feedbackId };
        }

        const plain = {
            msgtype: "stream",
            stream: stream,
        };

        const plainStr = JSON.stringify(plain);
        const encrypted = this.crypto.encrypt(plainStr);
        const signature = this.crypto.getSignature(timestamp, nonce, encrypted);

        return JSON.stringify({
            encrypt: encrypted,
            msgsignature: signature,
            timestamp: timestamp,
            nonce: nonce,
        });
    }

    /**
     * Build success acknowledgment (no reply)
     */
    buildSuccessAck() {
        return "success";
    }
}
