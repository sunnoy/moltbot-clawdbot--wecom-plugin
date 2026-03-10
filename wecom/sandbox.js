import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Resolve the allowed sandbox roots for outbound file access.
 *
 * @param {object} params
 * @param {Function} params.resolveAgentWorkspaceDir - (config, agentId) => string
 * @param {Function} params.resolveDefaultAgentId - (config) => string
 * @param {Function} params.resolveStateDir - () => string
 * @param {object} params.config - OpenClaw configuration
 * @param {string} [params.agentId] - Agent identifier
 * @returns {string[]} Deduplicated list of resolved absolute root paths.
 */
export function resolveSandboxRoots({ resolveAgentWorkspaceDir, resolveDefaultAgentId, resolveStateDir, config, agentId }) {
  const effectiveAgentId = agentId || resolveDefaultAgentId(config);
  const workspaceDir = resolveAgentWorkspaceDir(config, effectiveAgentId);
  const stateDir = resolveStateDir();
  const mediaCacheDir = path.join(stateDir, "media");
  const browserMediaDir = path.join(stateDir, "media", "browser");

  return [...new Set([workspaceDir, mediaCacheDir, browserMediaDir].map((p) => path.resolve(p)))];
}

/**
 * Validate that a file path falls within one of the allowed sandbox roots.
 *
 * Uses `fs.realpath` to resolve symlinks before checking, preventing
 * symlink-based escapes. Falls back to `path.resolve` if `realpath` fails
 * (e.g. file does not exist yet), which still catches `..` traversal.
 *
 * @param {string} filePath - The absolute file path to validate.
 * @param {string[]} allowedRoots - List of allowed root directories.
 * @throws {Error} If the path escapes all sandbox roots.
 */
export async function assertPathInsideSandbox(filePath, allowedRoots) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("Sandbox violation: empty file path");
  }

  const resolved = path.resolve(filePath);

  // Resolve symlinks when possible; fall back to lexical resolve.
  let real;
  try {
    real = await realpath(resolved);
  } catch {
    real = resolved;
  }

  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(root);
    // Ensure trailing separator so "/workspace-x" doesn't match "/workspace-xyz".
    if (real === resolvedRoot || real.startsWith(resolvedRoot + path.sep)) {
      return;
    }
  }

  throw new Error(`Sandbox violation: path "${filePath}" escapes allowed roots`);
}
