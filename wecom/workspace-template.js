import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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

function expandTilde(p) {
  if (!p || !p.startsWith("~")) return p;
  return join(homedir(), p.slice(1));
}

// --- mtime caches for force-reseed ---
const _templateMtimeCache = new Map();   // templateDir → { maxMtimeMs, checkedAt }
const TEMPLATE_MTIME_CACHE_TTL_MS = 60_000;
const TEMPLATE_STATE_DIRNAME = ".openclaw";
const TEMPLATE_STATE_FILENAME = "wecom-template-state.json";
const TEMPLATE_STATE_VERSION = 1;

function getTemplateMaxMtimeMs(templateDir) {
  const now = Date.now();
  const cached = _templateMtimeCache.get(templateDir);
  if (cached && now - cached.checkedAt < TEMPLATE_MTIME_CACHE_TTL_MS) {
    return cached.maxMtimeMs;
  }

  let maxMtimeMs = 0;
  const files = readdirSync(templateDir);
  for (const file of files) {
    if (!BOOTSTRAP_FILENAMES.has(file)) continue;
    const st = statSync(join(templateDir, file));
    if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
  }

  _templateMtimeCache.set(templateDir, { maxMtimeMs, checkedAt: now });
  return maxMtimeMs;
}

export function clearTemplateMtimeCache({ agentSeedCache = true } = {}) {
  _templateMtimeCache.clear();
  void agentSeedCache;
}

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

function hasWorkspaceMemoryMarkers(workspaceDir) {
  return existsSync(join(workspaceDir, "memory")) || existsSync(join(workspaceDir, "MEMORY.md"));
}

function resolveTemplateStatePath(workspaceDir) {
  return join(workspaceDir, TEMPLATE_STATE_DIRNAME, TEMPLATE_STATE_FILENAME);
}

function readTemplateState(workspaceDir) {
  const statePath = resolveTemplateStatePath(workspaceDir);
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      version: parsed.version,
      seededAt: typeof parsed.seededAt === "string" ? parsed.seededAt : null,
      templateDir: typeof parsed.templateDir === "string" ? parsed.templateDir : null,
      seededFiles: Array.isArray(parsed.seededFiles)
        ? parsed.seededFiles.filter((file) => typeof file === "string")
        : [],
      templateMtimeMs:
        typeof parsed.templateMtimeMs === "number" && Number.isFinite(parsed.templateMtimeMs)
          ? parsed.templateMtimeMs
          : null,
      migratedFromLegacy: parsed.migratedFromLegacy === true,
    };
  } catch {
    return null;
  }
}

function writeTemplateState(workspaceDir, state) {
  const statePath = resolveTemplateStatePath(workspaceDir);
  const stateDir = join(workspaceDir, TEMPLATE_STATE_DIRNAME);
  mkdirSync(stateDir, { recursive: true });

  const payload = `${JSON.stringify(
    {
      version: TEMPLATE_STATE_VERSION,
      seededAt: state.seededAt,
      templateDir: state.templateDir,
      seededFiles: [...new Set(state.seededFiles)].sort(),
      templateMtimeMs: state.templateMtimeMs,
      migratedFromLegacy: state.migratedFromLegacy === true,
    },
    null,
    2,
  )}\n`;
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmpPath, payload, "utf8");
  renameSync(tmpPath, statePath);
}

function collectExistingSeededFiles(workspaceDir, templateFiles) {
  return templateFiles.filter((file) => existsSync(join(workspaceDir, file)));
}

/**
 * Copy selected template files into a dynamic agent workspace.
 * BOOTSTRAP.md may be synced only before user memory markers appear; once the
 * workspace has memory/ or MEMORY.md, bootstrap is treated as completed and is
 * never re-seeded by the plugin.
 * Silently skips if workspaceTemplate is not configured or directory is missing.
 *
 * @param {string} agentId
 * @param {object} config - OpenClaw config
 * @param {string} [overrideTemplateDir] - Optional per-account template directory
 */
export function seedAgentWorkspace(agentId, config, overrideTemplateDir) {
  const rawTemplateDir = overrideTemplateDir || getWorkspaceTemplateDir(config);
  const templateDir = expandTilde(rawTemplateDir);
  if (!templateDir) {
    return;
  }

  if (!existsSync(templateDir)) {
    logger.warn("WeCom: workspace template dir not found, skipping seed", { templateDir });
    return;
  }

  const workspaceDir = resolveAgentWorkspaceDirLocal(agentId);
  const workspaceExistedBefore = existsSync(workspaceDir);

  try {
    const templateMaxMtimeMs = getTemplateMaxMtimeMs(templateDir);
    mkdirSync(workspaceDir, { recursive: true });

    const templateFiles = readdirSync(templateDir).filter((file) => BOOTSTRAP_FILENAMES.has(file));
    let state = readTemplateState(workspaceDir);
    const isLegacyWorkspace = !state && workspaceExistedBefore;
    const isFirstSeed = !state && !workspaceExistedBefore;

    if (!state) {
      state = {
        version: TEMPLATE_STATE_VERSION,
        seededAt: new Date().toISOString(),
        templateDir,
        seededFiles: isLegacyWorkspace ? collectExistingSeededFiles(workspaceDir, templateFiles) : [],
        templateMtimeMs: templateMaxMtimeMs,
        migratedFromLegacy: isLegacyWorkspace,
      };
    }

    const bootstrapAllowed = !hasWorkspaceMemoryMarkers(workspaceDir);
    for (const file of templateFiles) {
      if (file === "BOOTSTRAP.md" && !bootstrapAllowed) {
        continue;
      }
      const src = join(templateDir, file);
      const dest = join(workspaceDir, file);
      if (existsSync(dest)) {
        if (!isFirstSeed) {
          continue;
        }
        copyFileSync(src, dest);
        logger.info("WeCom: re-seeded workspace file", { agentId, file, isFirstSeed });
      } else {
        copyFileSync(src, dest);
        logger.info("WeCom: seeded workspace file", { agentId, file });
      }
      state.seededFiles.push(file);
    }

    state.templateDir = templateDir;
    state.templateMtimeMs = templateMaxMtimeMs;
    writeTemplateState(workspaceDir, state);
  } catch (err) {
    logger.warn("WeCom: failed to seed agent workspace", {
      agentId,
      error: err?.message || String(err),
    });
  }
}

export function upsertAgentIdOnlyEntry(cfg, agentId, baseAgentId) {
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
  // Include heartbeat: {} so main inherits agents.defaults.heartbeat even when
  // dynamic agents also have explicit heartbeat entries (hasExplicitHeartbeatAgents).
  if (nextList.length === 0) {
    nextList.push({ id: "main", heartbeat: {} });
    existingIds.add("main");
    changed = true;
  }

  if (!existingIds.has(normalizedId)) {
    const entry = { id: normalizedId, heartbeat: {} };

    // Inherit inheritable properties from the base agent so the dynamic
    // agent retains model, subagents (spawn permissions), and tool config.
    if (baseAgentId) {
      const baseEntry = currentList.find(
        (e) => e && typeof e.id === "string" && e.id === baseAgentId,
      );
      if (baseEntry) {
        for (const key of ["model", "subagents", "tools"]) {
          if (baseEntry[key] != null) {
            entry[key] = JSON.parse(JSON.stringify(baseEntry[key]));
          }
        }
      }
    }

    nextList.push(entry);
    changed = true;
  } else if (baseAgentId) {
    // Backfill missing inheritable properties on existing entries that were
    // persisted before the inheritance logic was added.
    const existingEntry = nextList.find(
      (e) => e && typeof e.id === "string" && e.id.trim().toLowerCase() === normalizedId,
    );
    if (existingEntry) {
      const baseEntry = currentList.find(
        (e) => e && typeof e.id === "string" && e.id === baseAgentId,
      );
      if (baseEntry) {
        for (const key of ["model", "subagents", "tools"]) {
          if (existingEntry[key] == null && baseEntry[key] != null) {
            existingEntry[key] = JSON.parse(JSON.stringify(baseEntry[key]));
            changed = true;
          }
        }
      }
    }
  }

  if (changed) {
    cfg.agents.list = nextList;
  }

  return changed;
}

export async function ensureDynamicAgentListed(agentId, templateDir, baseAgentId) {
  const normalizedId = String(agentId || "")
    .trim()
    .toLowerCase();
  if (!normalizedId) {
    return;
  }

  const runtime = getRuntime();
  const configRuntime = runtime?.config;
  if (!configRuntime?.writeConfigFile) {
    return;
  }

  const queue = (getEnsureDynamicAgentWriteQueue() || Promise.resolve())
    .then(async () => {
      const openclawConfig = getOpenclawConfig();
      if (!openclawConfig || typeof openclawConfig !== "object") {
        return;
      }

      // Upsert into in-memory config so the running gateway sees it immediately.
      const changed = upsertAgentIdOnlyEntry(openclawConfig, normalizedId, baseAgentId);
      if (changed) {
        logger.info("WeCom: dynamic agent added to in-memory agents.list", { agentId: normalizedId });

        // Persist to disk so `openclaw agents list` (separate process) can see
        // the dynamic agent and it survives gateway restarts.
        // Safety check: refuse to write if critical config sections are missing,
        // which would indicate the in-memory snapshot is incomplete and writing
        // it would destroy the user's configuration (#136).
        const hasChannels = openclawConfig.channels && typeof openclawConfig.channels === "object";
        if (!hasChannels) {
          logger.warn("WeCom: skipping config write — in-memory config is missing 'channels' section", {
            agentId: normalizedId,
            keys: Object.keys(openclawConfig),
          });
        } else {
          try {
            await configRuntime.writeConfigFile(openclawConfig);
            logger.info("WeCom: dynamic agent persisted to config file", { agentId: normalizedId });
          } catch (writeErr) {
            logger.warn("WeCom: failed to persist dynamic agent to config file", {
              agentId: normalizedId,
              error: writeErr?.message || String(writeErr),
            });
          }
        }
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
