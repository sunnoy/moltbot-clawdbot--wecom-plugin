import { logger } from "./logger.js";
import { wecomChannelPlugin } from "./wecom/channel-plugin.js";
import { createWeComMcpTool } from "./wecom/mcp-tool.js";
import { createImageStudioTool } from "./wecom/image-studio-tool.js";
import { resolveQwenImageToolsConfig, wecomPluginConfigSchema } from "./wecom/plugin-config.js";
import { setOpenclawConfig, setRuntime } from "./wecom/state.js";
import { buildReplyMediaGuidance } from "./wecom/ws-monitor.js";
import { listAccountIds, resolveAccount } from "./wecom/accounts.js";
import { createCallbackHandler } from "./wecom/callback-inbound.js";

const plugin = {
  id: "wecom",
  name: "Enterprise WeChat",
  description: "Enterprise WeChat AI Bot channel plugin for OpenClaw",
  configSchema: wecomPluginConfigSchema,
  register(api) {
    logger.info("Registering WeCom WS plugin");
    setRuntime(api.runtime);
    setOpenclawConfig(api.config);
    api.registerChannel({ plugin: wecomChannelPlugin });
    api.registerTool(createWeComMcpTool(), { name: "wecom_mcp" });

    const qwenImageToolsConfig = resolveQwenImageToolsConfig(api.pluginConfig);
    if (qwenImageToolsConfig.enabled) {
      api.registerTool(createImageStudioTool(qwenImageToolsConfig), { name: "image_studio" });
      logger.info(
        `[image_studio] Registered with provider "${qwenImageToolsConfig.provider}" using qwen(generate=${qwenImageToolsConfig.models.qwen.generate}, edit=${qwenImageToolsConfig.models.qwen.edit}) wan(generate=${qwenImageToolsConfig.models.wan.generate}, edit=${qwenImageToolsConfig.models.wan.edit})`,
      );
    }

    // Register HTTP callback endpoints for all accounts that have callback config
    for (const accountId of listAccountIds(api.config)) {
      const account = resolveAccount(api.config, accountId);
      if (!account?.callbackConfig) continue;
      const { path: cbPath } = account.callbackConfig;
      logger.info(`[CB] Registering callback endpoint for account=${accountId} path=${cbPath}`);
      api.registerHttpRoute({
        path: cbPath,
        auth: "plugin",
        match: "prefix",
        handler: createCallbackHandler({ account, config: api.config, runtime: api.runtime }),
      });
    }

    api.on("before_prompt_build", (_event, ctx) => {
      if (ctx.channelId !== "wecom") {
        return;
      }
      const guidance = buildReplyMediaGuidance(api.config, ctx.agentId);
      return { appendSystemContext: guidance };
    });
  },
};

export default plugin;
export const register = (api) => plugin.register(api);
