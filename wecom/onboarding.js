import { addWildcardAllowFrom } from "openclaw/plugin-sdk/setup";
import { DEFAULT_WS_URL, DEFAULT_ACCOUNT_ID } from "./constants.js";
import { resolveAccount, updateAccountConfig } from "./accounts.js";

const CHANNEL_ID = "wecom";

function resolveWizardAccountId(accountId) {
  return String(accountId || DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
}

function resolveOnboardingAccountId(params) {
  return resolveWizardAccountId(params?.accountId);
}

function setWecomDmPolicy(cfg, accountId, dmPolicy) {
  const account = resolveAccount(cfg, accountId);
  const existingAllowFrom = Array.isArray(account.config.allowFrom) ? account.config.allowFrom : [];
  const nextAllowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(existingAllowFrom.map((entry) => String(entry)))
      : existingAllowFrom.map((entry) => String(entry));

  return updateAccountConfig(cfg, accountId, {
    dmPolicy,
    allowFrom: nextAllowFrom,
  });
}

async function promptBotId(prompter, account) {
  return String(
    await prompter.text({
      message: "企业微信机器人 Bot ID",
      initialValue: account?.botId ?? "",
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();
}

async function promptSecret(prompter, account) {
  return String(
    await prompter.text({
      message: "企业微信机器人 Secret",
      initialValue: account?.secret ?? "",
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();
}

async function promptWebsocketUrl(prompter, account) {
  return String(
    await prompter.text({
      message: "企业微信 WebSocket 地址（留空使用官方默认地址）",
      initialValue: account?.websocketUrl ?? DEFAULT_WS_URL,
    }),
  ).trim();
}

const dmPolicy = {
  label: "企业微信",
  channel: CHANNEL_ID,
  policyKey: "channels.wecom.dmPolicy",
  allowFromKey: "channels.wecom.allowFrom",
  getCurrent: (cfg, accountId) => resolveAccount(cfg, resolveWizardAccountId(accountId)).config.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy, accountId) => setWecomDmPolicy(cfg, resolveWizardAccountId(accountId), policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const resolvedAccountId = resolveOnboardingAccountId({ accountId });
    const account = resolveAccount(cfg, resolvedAccountId);
    const existingAllowFrom = Array.isArray(account.config.allowFrom) ? account.config.allowFrom : [];
    const input = await prompter.text({
      message: "企业微信 allowFrom（用户ID，每行一个）",
      initialValue: existingAllowFrom.join("\n"),
      placeholder: "user_a\nuser_b",
    });

    const allowFrom = String(input ?? "")
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

    return updateAccountConfig(cfg, resolvedAccountId, { allowFrom });
  },
};

export const wecomOnboardingAdapter = {
  channel: CHANNEL_ID,
  getStatus: async ({ cfg, accountId }) => {
    const account = resolveAccount(cfg, resolveOnboardingAccountId({ accountId }));
    const configured = Boolean(account.botId && account.secret);
    return {
      channel: CHANNEL_ID,
      configured,
      statusLines: [`企业微信: ${configured ? "已配置" : "需要 Bot ID 和 Secret"}`],
      selectionHint: configured ? "已配置" : "需要设置",
    };
  },
  configure: async ({ cfg, prompter, accountId }) => {
    const resolvedAccountId = resolveWizardAccountId(accountId);
    const account = resolveAccount(cfg, resolvedAccountId);
    const botId = await promptBotId(prompter, account);
    const secret = await promptSecret(prompter, account);
    const websocketUrl = await promptWebsocketUrl(prompter, account);

    const nextCfg = updateAccountConfig(cfg, resolvedAccountId, {
      enabled: true,
      botId,
      secret,
      websocketUrl: websocketUrl || DEFAULT_WS_URL,
      sendThinkingMessage: account.sendThinkingMessage !== false,
      dmPolicy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
    });

    return { cfg: nextCfg };
  },
  dmPolicy,
  disable: (cfg, accountId) => updateAccountConfig(cfg, resolveWizardAccountId(accountId), { enabled: false }),
};
