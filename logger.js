/**
 * Structured logging for WxWork plugin
 */
export class Logger {
    prefix;
    constructor(prefix = "[wxwork]") {
        this.prefix = prefix;
    }
    log(level, message, context) {
        const timestamp = new Date().toISOString();
        const contextStr = context ? ` ${JSON.stringify(context)}` : "";
        const logMessage = `${timestamp} ${level.toUpperCase()} ${this.prefix} ${message}${contextStr}`;
        switch (level) {
            case "debug":
                console.debug(logMessage);
                break;
            case "info":
                console.info(logMessage);
                break;
            case "warn":
                console.warn(logMessage);
                break;
            case "error":
                console.error(logMessage);
                break;
        }
    }
    debug(message, context) {
        this.log("debug", message, context);
    }
    info(message, context) {
        this.log("info", message, context);
    }
    warn(message, context) {
        this.log("warn", message, context);
    }
    error(message, context) {
        this.log("error", message, context);
    }
    child(subPrefix) {
        return new Logger(`${this.prefix}:${subPrefix}`);
    }
}
// Default logger instance
export const logger = new Logger();
//# sourceMappingURL=logger.js.map