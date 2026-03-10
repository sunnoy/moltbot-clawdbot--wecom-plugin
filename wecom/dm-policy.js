import { generateReqId } from "@wecom/aibot-node-sdk";
import { logger } from "../logger.js";
import { isSenderAllowed } from "./group-policy.js";
import { getRuntime } from "./state.js";

async function readStoredAllowFrom(pairing, accountId) {
  const legacy = await pairing
    .readAllowFromStore("wecom", undefined, accountId)
    .catch(() => []);
  const current = await pairing
    .readAllowFromStore({ channel: "wecom", accountId })
    .catch(() => []);
  return [...legacy, ...current];
}

async function sendPairingReply({ wsClient, frame, text, sendReply }) {
  if (typeof sendReply === "function") {
    await sendReply({
      frame,
      text,
      finish: true,
      streamId: generateReqId("pairing"),
    });
    return;
  }

  const streamId = generateReqId("pairing");
  await wsClient.replyStream(frame, streamId, text, true);
}

export async function checkDmPolicy({ senderId, isGroup, account, wsClient, frame, core, sendReply }) {
  if (isGroup) {
    return { allowed: true };
  }

  let runtime = null;
  try {
    runtime = getRuntime();
  } catch {}
  const pairing = core?.pairing ?? runtime?.channel?.pairing ?? runtime?.pairing;
  const dmPolicy = account?.config?.dmPolicy ?? "pairing";
  const configAllowFrom = (account?.config?.allowFrom ?? []).map((entry) => String(entry));

  if (dmPolicy === "disabled") {
    return { allowed: false };
  }

  if (dmPolicy === "open") {
    return { allowed: true };
  }

  const storeAllowFrom = pairing ? await readStoredAllowFrom(pairing, account.accountId) : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  if (isSenderAllowed(senderId, effectiveAllowFrom)) {
    return { allowed: true };
  }

  if (dmPolicy === "pairing" && pairing) {
    const request = await pairing.upsertPairingRequest({
      channel: "wecom",
      id: senderId,
      accountId: account.accountId,
      meta: { name: senderId },
    });

    if (request?.created) {
      try {
        const replyText = pairing.buildPairingReply({
          channel: "wecom",
          idLine: `您的企业微信用户ID: ${senderId}`,
          code: request.code,
        });
        await sendPairingReply({
          wsClient,
          frame,
          text: replyText,
          sendReply,
        });
      } catch (error) {
        logger.warn(`[wecom] failed to send pairing reply: ${error.message}`);
      }
    }

    return {
      allowed: false,
      pairingSent: Boolean(request?.created),
    };
  }

  return { allowed: false };
}
