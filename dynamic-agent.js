import { logger } from "./logger.js";

/**
 * Dynamic Agent Manager (Minimal Version)
 * 
 * 极简版：插件只负责生成 AgentId
 * 所有 Workspace 创建和 Bootstrap 文件由 OpenClaw 主程序自动处理
 * 
 * 流程：
 * 1. 插件收到消息 → generateAgentId() 生成 agentId
 * 2. 插件构造 SessionKey → `agent:{agentId}:{peerKind}:{peerId}`
 * 3. OpenClaw 解析 SessionKey → 提取 agentId
 * 4. OpenClaw 调用 resolveAgentWorkspaceDir() → fallback 到 ~/.openclaw/workspace-{agentId}
 * 5. OpenClaw 调用 ensureAgentWorkspace() → 自动创建目录和 Bootstrap 文件
 */

/**
 * 生成 AgentId
 * 规范：wecom-dm-{userId} 或 wecom-group-{groupId}
 * 
 * @param {string} chatType - "dm" 或 "group"
 * @param {string} peerId - userId 或 groupId
 * @returns {string} agentId
 */
export function generateAgentId(chatType, peerId) {
    const sanitizedId = String(peerId).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (chatType === "group") {
        return `wecom-group-${sanitizedId}`;
    }
    return `wecom-dm-${sanitizedId}`;
}

/**
 * 获取动态 Agent 配置
 */
export function getDynamicAgentConfig(config) {
    const wecom = config?.channels?.wecom || {};
    return {
        enabled: wecom.dynamicAgents?.enabled !== false,
        
        // 主账号列表（这些用户不走动态 Agent，直接路由到 main）
        mainUsers: wecom.dynamicAgents?.mainUsers || [],

        // 私聊配置
        dmCreateAgent: wecom.dm?.createAgentOnFirstMessage !== false,

        // 群聊配置
        groupEnabled: wecom.groupChat?.enabled !== false,
        groupRequireMention: wecom.groupChat?.requireMention !== false,
        groupMentionPatterns: wecom.groupChat?.mentionPatterns || ["@"],
        groupCreateAgent: wecom.groupChat?.createAgentOnFirstMessage !== false,
        groupHistoryLimit: wecom.groupChat?.historyLimit || 10,
    };
}

/**
 * 检查用户是否在主账号列表中（不走动态 Agent）
 * 
 * @param {string} userId - 用户ID
 * @param {Object} config - openclaw 配置
 * @returns {boolean}
 */
export function isMainUser(userId, config) {
    const dynamicConfig = getDynamicAgentConfig(config);
    const mainUsers = dynamicConfig.mainUsers;
    
    if (!Array.isArray(mainUsers) || mainUsers.length === 0) {
        return false;
    }
    
    const normalizedUserId = String(userId).toLowerCase().trim();
    return mainUsers.some(u => String(u).toLowerCase().trim() === normalizedUserId);
}

/**
 * 检查是否应该为此消息创建/使用动态 Agent
 * 
 * @param {Object} options
 * @param {string} options.chatType - "dm" 或 "group"
 * @param {string} options.userId - 发送者用户ID
 * @param {Object} options.config - openclaw 配置
 * @returns {boolean}
 */
export function shouldUseDynamicAgent({ chatType, userId, config }) {
    const dynamicConfig = getDynamicAgentConfig(config);

    if (!dynamicConfig.enabled) {
        return false;
    }
    
    // 主账号列表中的用户不走动态 Agent
    if (userId && isMainUser(userId, config)) {
        logger.info("User in mainUsers list, skipping dynamic agent", { userId });
        return false;
    }

    if (chatType === "dm") {
        return dynamicConfig.dmCreateAgent;
    }

    if (chatType === "group") {
        return dynamicConfig.groupCreateAgent;
    }

    return false;
}

/**
 * 检查群聊消息是否满足触发条件（@提及）
 */
export function shouldTriggerGroupResponse(content, config) {
    const dynamicConfig = getDynamicAgentConfig(config);

    if (!dynamicConfig.groupEnabled) {
        return false;
    }

    if (!dynamicConfig.groupRequireMention) {
        return true; // 不需要 @，所有消息都触发
    }

    // 检查是否包含 @提及
    const patterns = dynamicConfig.groupMentionPatterns;
    for (const pattern of patterns) {
        if (content.includes(pattern)) {
            return true;
        }
    }

    return false;
}

/**
 * 从群聊消息中提取实际内容（移除 @提及）
 */
export function extractGroupMessageContent(content, config) {
    const dynamicConfig = getDynamicAgentConfig(config);
    let cleanContent = content;

    // 移除 @提及 pattern
    const patterns = dynamicConfig.groupMentionPatterns;
    for (const pattern of patterns) {
        // 移除 @xxx 格式的提及（包括后面可能的空格）
        const regex = new RegExp(`${pattern}\\S*\\s*`, "g");
        cleanContent = cleanContent.replace(regex, "");
    }

    return cleanContent.trim();
}
