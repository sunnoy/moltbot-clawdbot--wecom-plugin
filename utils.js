/**
 * Utility functions and helpers for WxWork plugin
 */
export class TTLCache {
    options;
    cache = new Map();
    checkPeriod;
    cleanupTimer;
    constructor(options) {
        this.options = options;
        this.checkPeriod = options.checkPeriod || options.ttl;
        this.startCleanup();
    }
    set(key, value, ttl) {
        const expiresAt = Date.now() + (ttl || this.options.ttl);
        this.cache.set(key, { value, expiresAt });
    }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }
        return entry.value;
    }
    has(key) {
        return this.get(key) !== undefined;
    }
    delete(key) {
        return this.cache.delete(key);
    }
    clear() {
        this.cache.clear();
    }
    size() {
        this.cleanup();
        return this.cache.size;
    }
    cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
            }
        }
    }
    startCleanup() {
        this.cleanupTimer = setInterval(() => {
            this.cleanup();
        }, this.checkPeriod);
        // Don't prevent process from exiting
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }
    destroy() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        this.cache.clear();
    }
}
// ============================================================================
// Promise Lock (for preventing race conditions)
// ============================================================================
export class PromiseLock {
    pending = new Map();
    async acquire(key, fn) {
        // If there's already a pending operation, wait for it
        const existing = this.pending.get(key);
        if (existing) {
            return existing;
        }
        // Start new operation
        const promise = fn();
        this.pending.set(key, promise);
        try {
            const result = await promise;
            return result;
        }
        finally {
            this.pending.delete(key);
        }
    }
    clear(key) {
        if (key) {
            this.pending.delete(key);
        }
        else {
            this.pending.clear();
        }
    }
}
export async function withRetry(fn, options = {}) {
    const { retries = 3, minTimeout = 1000, maxTimeout = 10000, factor = 2, randomize = true, onRetry, } = options;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt === retries) {
                throw lastError;
            }
            // Calculate backoff delay
            let delay = Math.min(minTimeout * Math.pow(factor, attempt), maxTimeout);
            if (randomize) {
                delay = delay * (0.5 + Math.random() * 0.5);
            }
            if (onRetry) {
                onRetry(lastError, attempt + 1);
            }
            await sleep(delay);
        }
    }
    throw lastError;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ============================================================================
// Message Deduplication
// ============================================================================
export class MessageDeduplicator {
    seen = new TTLCache({ ttl: 300000 }); // 5 minutes
    isDuplicate(msgId) {
        if (this.seen.has(msgId)) {
            return true;
        }
        this.seen.set(msgId, true);
        return false;
    }
    markAsSeen(msgId) {
        this.seen.set(msgId, true);
    }
}
export function parseWxWorkError(errcode, errmsg) {
    // Reference: https://developer.work.weixin.qq.com/document/path/96213
    switch (errcode) {
        case -1:
            return {
                code: errcode,
                message: "System busy, retry later",
                retryable: true,
                category: "system",
            };
        case 0:
            return {
                code: errcode,
                message: "Success",
                retryable: false,
                category: "system",
            };
        case 40001:
        case 40014:
        case 42001:
        case 42007:
        case 42009:
            return {
                code: errcode,
                message: `Invalid or expired access_token: ${errmsg}`,
                retryable: true,
                category: "auth",
            };
        case 45009:
            return {
                code: errcode,
                message: "API rate limit exceeded",
                retryable: true,
                category: "rate_limit",
            };
        case 48002:
            return {
                code: errcode,
                message: "API concurrent call limit exceeded",
                retryable: true,
                category: "rate_limit",
            };
        case 40003:
        case 40013:
        case 40035:
            return {
                code: errcode,
                message: `Invalid parameter: ${errmsg}`,
                retryable: false,
                category: "invalid_input",
            };
        default:
            return {
                code: errcode,
                message: errmsg || "Unknown error",
                retryable: errcode >= 50000 && errcode < 60000, // System errors are retryable
                category: "unknown",
            };
    }
}
export function shouldRetryError(errcode) {
    const info = parseWxWorkError(errcode, "");
    return info.retryable;
}
// ============================================================================
// URL Helpers
// ============================================================================
export function buildApiUrl(path, params) {
    const base = `https://qyapi.weixin.qq.com${path}`;
    if (!params || Object.keys(params).length === 0) {
        return base;
    }
    const query = new URLSearchParams(params).toString();
    return `${base}?${query}`;
}
// ============================================================================
// Random String Generation
// ============================================================================
export function randomString(length) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
// ============================================================================
// Constants
// ============================================================================
export const CONSTANTS = {
    // Token settings
    TOKEN_REFRESH_MARGIN_MS: 300000, // 5 minutes before expiry
    TOKEN_CACHE_KEY: "access_token",
    // Response URL settings
    RESPONSE_URL_TTL_MS: 3600000, // 1 hour
    RESPONSE_URL_MAX_USES: 1,
    // Media settings
    MEDIA_ID_TTL_MS: 259200000, // 3 days
    // Rate limiting
    MESSAGE_RATE_LIMIT_PER_MINUTE: 20,
    // Timeouts
    API_TIMEOUT_MS: 10000, // 10 seconds
    WEBHOOK_RESPONSE_TIMEOUT_MS: 5000, // 5 seconds
    // Retry settings
    DEFAULT_RETRY_COUNT: 3,
    DEFAULT_RETRY_MIN_DELAY_MS: 1000,
    DEFAULT_RETRY_MAX_DELAY_MS: 10000,
    // AES/Crypto
    AES_BLOCK_SIZE: 32,
    AES_KEY_LENGTH: 43,
};
//# sourceMappingURL=utils.js.map