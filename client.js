/**
 * WxWork AI Bot Client
 * 智能机器人专用 - 只使用 response_url 回复，不需要 access_token
 * https://developer.work.weixin.qq.com/document/path/101039
 */

import { logger } from "./logger.js";
import { withRetry, parseWxWorkError, CONSTANTS } from "./utils.js";

/**
 * 通过 response_url 主动回复消息
 * https://developer.work.weixin.qq.com/document/path/101138
 */
export async function sendReplyMessage(responseUrl, message) {
    if (!responseUrl) {
        throw new Error("response_url is required");
    }

    logger.debug("Sending reply via response_url", { msgtype: message.msgtype });

    return await withRetry(async () => {
        const res = await fetch(responseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(CONSTANTS.WEBHOOK_RESPONSE_TIMEOUT_MS),
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        if (data.errcode !== 0) {
            const errorInfo = parseWxWorkError(data.errcode, data.errmsg);
            throw new Error(`Response failed: [${data.errcode}] ${errorInfo.message}`);
        }

        logger.info("Reply sent successfully via response_url");
        return data;
    }, {
        retries: 2,
        minTimeout: 500,
        maxTimeout: 2000,
        onRetry: (error, attempt) => {
            logger.warn(`Reply retry ${attempt}/2`, { error: error.message });
        },
    });
}

/**
 * 发送 Markdown 消息
 */
export async function sendMarkdownReply(responseUrl, content) {
    return sendReplyMessage(responseUrl, {
        msgtype: "markdown",
        markdown: { content },
    });
}

/**
 * 发送文本消息
 */
export async function sendTextReply(responseUrl, content) {
    return sendReplyMessage(responseUrl, {
        msgtype: "text",
        text: { content },
    });
}

/**
 * 发送流式响应片段
 * https://developer.work.weixin.qq.com/document/path/101031#流式消息回复
 * 
 * @param responseUrl - 回调中返回的 response_url
 * @param streamId - 流ID，同一轮对话保持一致
 * @param content - 本次消息内容 (markdown 格式)
 * @param isFinished - 是否结束流式响应
 */
export async function sendStreamChunk(responseUrl, streamId, content, isFinished = false) {
    if (!responseUrl) {
        throw new Error("response_url is required for streaming");
    }

    const message = {
        msgtype: "stream",
        stream: {
            id: streamId,
            finish: isFinished,
            content: content,
            // msg_item: [], // 可选：图片等
            // feedback: { id: "feedid" } // 可选：反馈ID
        },
    };

    logger.debug("Sending stream chunk", { streamId, isFinished, length: content.length });

    const res = await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(CONSTANTS.WEBHOOK_RESPONSE_TIMEOUT_MS),
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (data.errcode !== 0) {
        const errorInfo = parseWxWorkError(data.errcode, data.errmsg);
        throw new Error(`Stream response failed: [${data.errcode}] ${errorInfo.message}`);
    }

    return data;
}

/**
 * 发送模板卡片消息
 * https://developer.work.weixin.qq.com/document/path/101061
 */
export async function sendTemplateCardReply(responseUrl, card) {
    return sendReplyMessage(responseUrl, {
        msgtype: "template_card",
        template_card: card,
    });
}

// 兼容旧代码 - 保留 WxWorkClient 类名但简化实现
export class WxWorkClient {
    constructor(config) {
        logger.warn("WxWorkClient is deprecated for AI Bot, use sendReplyMessage directly");
    }

    // 保留兼容方法
    async sendStreamResponse(responseUrl, message) {
        return sendReplyMessage(responseUrl, message);
    }
}