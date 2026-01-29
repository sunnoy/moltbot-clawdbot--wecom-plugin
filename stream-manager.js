import { logger } from "./logger.js";

/**
 * 流式消息状态管理器
 * 管理所有活跃的流式消息会话,支持企业微信的流式刷新机制
 */
class StreamManager {
    constructor() {
        // streamId -> { content: string, finished: boolean, updatedAt: number, feedbackId: string|null, msgItem: Array }
        this.streams = new Map();

        // 自动清理过期的流 (10分钟未更新)
        setInterval(() => this.cleanup(), 60 * 1000);
    }

    /**
     * 创建新的流式会话
     * @param {string} streamId - 流ID
     * @param {object} options - 可选配置
     * @param {string} options.feedbackId - 反馈追踪ID (最长256字节)
     */
    createStream(streamId, options = {}) {
        logger.debug("Creating stream", { streamId, feedbackId: options.feedbackId });
        this.streams.set(streamId, {
            content: "",
            finished: false,
            updatedAt: Date.now(),
            feedbackId: options.feedbackId || null,  // 用户反馈追踪
            msgItem: [],  // 图文混排消息列表
        });
        return streamId;
    }

    /**
     * 更新流的内容 (增量或全量)
     * @param {string} streamId - 流ID
     * @param {string} content - 消息内容 (最长20480字节)
     * @param {boolean} finished - 是否完成
     * @param {object} options - 可选配置
     * @param {Array} options.msgItem - 图文混排列表 (仅finish=true时有效)
     */
    updateStream(streamId, content, finished = false, options = {}) {
        const stream = this.streams.get(streamId);
        if (!stream) {
            logger.warn("Stream not found for update", { streamId });
            return false;
        }

        // 检查内容长度 (企业微信限制20480字节)
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (contentBytes > 20480) {
            logger.warn("Stream content exceeds 20480 bytes, truncating", {
                streamId,
                bytes: contentBytes
            });
            // 截断到20480字节
            content = Buffer.from(content, 'utf8').slice(0, 20480).toString('utf8');
        }

        stream.content = content;
        stream.finished = finished;
        stream.updatedAt = Date.now();

        // 图文混排仅在完成时支持
        if (finished && options.msgItem && options.msgItem.length > 0) {
            stream.msgItem = options.msgItem.slice(0, 10);  // 最多10个
        }

        logger.debug("Stream updated", {
            streamId,
            contentLength: content.length,
            contentBytes,
            finished,
            hasMsgItem: stream.msgItem.length > 0
        });

        return true;
    }

    /**
     * 追加内容到流 (用于流式生成)
     */
    appendStream(streamId, chunk) {
        const stream = this.streams.get(streamId);
        if (!stream) {
            logger.warn("Stream not found for append", { streamId });
            return false;
        }

        stream.content += chunk;
        stream.updatedAt = Date.now();

        logger.debug("Stream appended", {
            streamId,
            chunkLength: chunk.length,
            totalLength: stream.content.length
        });

        return true;
    }

    /**
     * 标记流为完成状态
     */
    finishStream(streamId) {
        const stream = this.streams.get(streamId);
        if (!stream) {
            logger.warn("Stream not found for finish", { streamId });
            return false;
        }

        stream.finished = true;
        stream.updatedAt = Date.now();

        logger.info("Stream finished", {
            streamId,
            contentLength: stream.content.length
        });

        return true;
    }

    /**
     * 获取流的当前状态
     */
    getStream(streamId) {
        return this.streams.get(streamId);
    }

    /**
     * 检查流是否存在
     */
    hasStream(streamId) {
        return this.streams.has(streamId);
    }

    /**
     * 删除流
     */
    deleteStream(streamId) {
        const deleted = this.streams.delete(streamId);
        if (deleted) {
            logger.debug("Stream deleted", { streamId });
        }
        return deleted;
    }

    /**
     * 清理超过10分钟未更新的流
     */
    cleanup() {
        const now = Date.now();
        const timeout = 10 * 60 * 1000; // 10 minutes
        let cleaned = 0;

        for (const [streamId, stream] of this.streams.entries()) {
            if (now - stream.updatedAt > timeout) {
                this.streams.delete(streamId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.info("Cleaned up expired streams", { count: cleaned });
        }
    }

    /**
     * 获取统计信息
     */
    getStats() {
        const total = this.streams.size;
        let finished = 0;
        let active = 0;

        for (const stream of this.streams.values()) {
            if (stream.finished) {
                finished++;
            } else {
                active++;
            }
        }

        return { total, finished, active };
    }
}

// 单例实例
export const streamManager = new StreamManager();
