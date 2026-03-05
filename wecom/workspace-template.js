import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import { BOOTSTRAP_FILENAMES } from "./constants.js";
import {
  getEnsureDynamicAgentWriteQueue,
  getEnsuredDynamicAgentIds,
  getOpenclawConfig,
  getRuntime,
  setEnsureDynamicAgentWriteQueue,
  setOpenclawConfig,
} from "./state.js";

/**
 * Resolve the agent workspace directory for a given agentId.
 * Mirrors openclaw core's resolveAgentWorkspaceDir logic for non-default agents:
 *   stateDir/workspace-{agentId}
 */
export function resolveAgentWorkspaceDirLocal(agentId) {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    join(process.env.HOME || "/root", ".openclaw");
  return join(stateDir, `workspace-${agentId}`);
}

/**
 * Read the workspace template dir from plugin config.
 * Config key: channels.wecom.workspaceTemplate
 */
export function getWorkspaceTemplateDir(config) {
  return config?.channels?.wecom?.workspaceTemplate?.trim() || null;
}

/**
 * Copy template files into a newly created agent's workspace directory.
 * Only copies files that don't already exist (writeFileIfMissing semantics).
 * Silently skips if workspaceTemplate is not configured or directory is missing.
 *
 * @param {string} agentId
 * @param {object} config - OpenClaw config
 * @param {string} [overrideTemplateDir] - Optional per-account template directory
 */
export function seedAgentWorkspace(agentId, config, overrideTemplateDir) {
  const templateDir = overrideTemplateDir || getWorkspaceTemplateDir(config);
  if (!templateDir) {
    return;
  }

  if (!existsSync(templateDir)) {
    logger.warn("WeCom: workspace template dir not found, skipping seed", { templateDir });
    return;
  }

  const workspaceDir = resolveAgentWorkspaceDirLocal(agentId);

  try {
    mkdirSync(workspaceDir, { recursive: true });

    const files = readdirSync(templateDir);
    for (const file of files) {
      if (!BOOTSTRAP_FILENAMES.has(file)) {
        continue;
      }
      const dest = join(workspaceDir, file);
      if (existsSync(dest)) {
        continue;
      }
      copyFileSync(join(templateDir, file), dest);
      logger.info("WeCom: seeded workspace file", { agentId, file });
    }
  } catch (err) {
    logger.warn("WeCom: failed to seed agent workspace", {
      agentId,
      error: err?.message || String(err),
    });
  }
}

export function upsertAgentIdOnlyEntry(cfg, agentId) {
  const normalizedId = String(agentId || "")
    .trim()
    .toLowerCase();
  if (!normalizedId) {
    return false;
  }

  if (!cfg.agents || typeof cfg.agents !== "object") {
    cfg.agents = {};
  }

  const currentList = Array.isArray(cfg.agents.list) ? cfg.agents.list : [];
  const existingIds = new Set(
    currentList
      .map((entry) => (entry && typeof entry.id === "string" ? entry.id.trim().toLowerCase() : ""))
      .filter(Boolean),
  );

  let changed = false;
  const nextList = [...currentList];

  // Keep "main" as the explicit default when creating agents.list for the first time.
  if (nextList.length === 0) {
    nextList.push({ id: "main" });
    existingIds.add("main");
    changed = true;
  }

  if (!existingIds.has(normalizedId)) {
    nextList.push({ id: normalizedId, heartbeat: {} });
    changed = true;
  }

  if (changed) {
    cfg.agents.list = nextList;
  }

  return changed;
}

export async function ensureDynamicAgentListed(agentId, templateDir) {
  const normalizedId = String(agentId || "")
    .trim()
    .toLowerCase();
  if (!normalizedId) {
    return;
  }

  const runtime = getRuntime();
  const configRuntime = runtime?.config;
  if (!configRuntime?.loadConfig || !configRuntime?.writeConfigFile) {
    return;
  }

  const queue = (getEnsureDynamicAgentWriteQueue() || Promise.resolve())
    .then(async () => {
      const openclawConfig = getOpenclawConfig();
      if (!openclawConfig || typeof openclawConfig !== "object") {
        return;
      }

      // Upsert into memory only. Writing to config file is dangerous and can wipe user settings.
      const changed = upsertAgentIdOnlyEntry(openclawConfig, normalizedId);
      if (changed) {
        logger.info("WeCom: dynamic agent added to in-memory agents.list", { agentId: normalizedId });
      }
      
      // Always attempt seeding so recreated/cleaned dynamic agents can recover
      // template files.
      seedAgentWorkspace(normalizedId, openclawConfig, templateDir);

      getEnsuredDynamicAgentIds().add(normalizedId);
    })
    .catch((err) => {
      logger.warn("WeCom: failed to sync dynamic agent into agents.list", {
        agentId: normalizedId,
        error: err?.message || String(err),
      });
    });

  setEnsureDynamicAgentWriteQueue(queue);
  await queue;
}
