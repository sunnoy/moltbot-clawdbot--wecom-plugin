import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { logger } from "./logger.js";
import { wecomChannelPlugin } from "./wecom/channel-plugin.js";
import { setOpenclawConfig, setRuntime } from "./wecom/state.js";
import { buildReplyMediaGuidance } from "./wecom/ws-monitor.js";

const plugin = {
  id: "wecom",
  name: "Enterprise WeChat",
  description: "Enterprise WeChat AI Bot channel plugin for OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    logger.info("Registering WeCom WS plugin");
    setRuntime(api.runtime);
    setOpenclawConfig(api.config);
    api.registerChannel({ plugin: wecomChannelPlugin });

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
