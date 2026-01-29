import { z } from "zod";
export const WxWorkConfigSchema = z.object({
    enabled: z.boolean().default(false),
    corpId: z.string().describe("Enterprise ID (CorpID)"),
    agentId: z.string().describe("Agent ID (Application ID)"),
    secret: z.string().describe("Application Secret"),
    token: z.string().describe("Webhook Token"),
    encodingAesKey: z.string().describe("Webhook EncodingAESKey"),
    webhookPath: z.string().default("/webhooks/wxwork").describe("Webhook URL path"),
});
//# sourceMappingURL=config.js.map