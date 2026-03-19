/**
 * Extract the WeCom account ID from a dynamic agent ID.
 *
 * Dynamic agent IDs follow the pattern produced by generateAgentId():
 *   wecom-dm-{peerId}                → default account (returns null)
 *   wecom-{accountId}-dm-{peerId}    → returns accountId
 *   wecom-group-{peerId}             → default account (returns null)
 *   wecom-{accountId}-group-{peerId} → returns accountId
 *
 * @param {string} agentIdOrAccountId - A dynamic agent ID or account ID
 * @returns {string|null} The extracted account ID, or null if not extractable
 */
export function extractParentAgentId(agentIdOrAccountId) {
  const id = String(agentIdOrAccountId ?? "").trim().toLowerCase();
  if (!id.startsWith("wecom-")) {
    return null;
  }

  const match = id.match(/^wecom-(?:(.+?)-)?(dm|group)-/);
  if (!match) {
    return null;
  }

  // group 1 is the account namespace; undefined means default account
  return match[1] || null;
}
