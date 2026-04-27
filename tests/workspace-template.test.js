import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  upsertAgentIdOnlyEntry,
  seedAgentWorkspace,
  clearTemplateMtimeCache,
  resolveAgentWorkspaceDirLocal,
} from "../wecom/workspace-template.js";

describe("upsertAgentIdOnlyEntry", () => {
  it("adds heartbeat config when creating a dynamic agent entry", () => {
    const cfg = { agents: { list: [{ id: "main" }] } };
    const changed = upsertAgentIdOnlyEntry(cfg, "wecom-dm-lirui");

    assert.equal(changed, true);
    assert.deepEqual(cfg.agents.list, [
      { id: "main" },
      { id: "wecom-dm-lirui", heartbeat: {} },
    ]);
  });

  it("creates agents.list with main and new dynamic agent heartbeat config", () => {
    const cfg = {};
    const changed = upsertAgentIdOnlyEntry(cfg, "wecom-dm-lirui");

    assert.equal(changed, true);
    assert.deepEqual(cfg.agents.list, [
      { id: "main", heartbeat: {} },
      { id: "wecom-dm-lirui", heartbeat: {} },
    ]);
  });

  it("does not overwrite existing entries", () => {
    const cfg = {
      agents: {
        list: [{ id: "main" }, { id: "wecom-dm-lirui", heartbeat: { every: "5m" } }],
      },
    };
    const changed = upsertAgentIdOnlyEntry(cfg, "wecom-dm-lirui");

    assert.equal(changed, false);
    assert.deepEqual(cfg.agents.list, [
      { id: "main" },
      { id: "wecom-dm-lirui", heartbeat: { every: "5m" } },
    ]);
  });

  it("inherits model/subagents/tools from base agent for new entries", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            model: "claude-sonnet-4-20250514",
            subagents: { allow: ["researcher"] },
            tools: { allow: ["web-search"] },
          },
        ],
      },
    };
    const changed = upsertAgentIdOnlyEntry(cfg, "wecom-dm-user1", "main");

    assert.equal(changed, true);
    const newEntry = cfg.agents.list.find((e) => e.id === "wecom-dm-user1");
    assert.equal(newEntry.model, "claude-sonnet-4-20250514");
    assert.deepEqual(newEntry.subagents, { allow: ["researcher"] });
    assert.deepEqual(newEntry.tools, { allow: ["web-search"] });
  });

  it("backfills missing properties on existing empty entries", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            model: "claude-sonnet-4-20250514",
            subagents: { allow: ["researcher"] },
            tools: { allow: ["web-search"] },
          },
          { id: "wecom-dm-user2", heartbeat: {} },
        ],
      },
    };
    const changed = upsertAgentIdOnlyEntry(cfg, "wecom-dm-user2", "main");

    assert.equal(changed, true);
    const entry = cfg.agents.list.find((e) => e.id === "wecom-dm-user2");
    assert.equal(entry.model, "claude-sonnet-4-20250514");
    assert.deepEqual(entry.subagents, { allow: ["researcher"] });
    assert.deepEqual(entry.tools, { allow: ["web-search"] });
  });

  it("preserves user customizations when backfilling existing entries", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            model: "claude-sonnet-4-20250514",
            subagents: { allow: ["researcher"] },
            tools: { allow: ["web-search"] },
          },
          { id: "wecom-dm-user3", heartbeat: {}, model: "claude-haiku-4-20250506" },
        ],
      },
    };
    const changed = upsertAgentIdOnlyEntry(cfg, "wecom-dm-user3", "main");

    assert.equal(changed, true);
    const entry = cfg.agents.list.find((e) => e.id === "wecom-dm-user3");
    // User's custom model preserved
    assert.equal(entry.model, "claude-haiku-4-20250506");
    // Missing properties backfilled from base
    assert.deepEqual(entry.subagents, { allow: ["researcher"] });
    assert.deepEqual(entry.tools, { allow: ["web-search"] });
  });

  it("returns false for fully populated existing entry", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            model: "claude-sonnet-4-20250514",
            subagents: { allow: ["researcher"] },
            tools: { allow: ["web-search"] },
          },
          {
            id: "wecom-dm-user4",
            heartbeat: {},
            model: "claude-haiku-4-20250506",
            subagents: { allow: [] },
            tools: { deny: ["dangerous"] },
          },
        ],
      },
    };
    const changed = upsertAgentIdOnlyEntry(cfg, "wecom-dm-user4", "main");

    assert.equal(changed, false);
    const entry = cfg.agents.list.find((e) => e.id === "wecom-dm-user4");
    // All original values preserved
    assert.equal(entry.model, "claude-haiku-4-20250506");
    assert.deepEqual(entry.subagents, { allow: [] });
    assert.deepEqual(entry.tools, { deny: ["dangerous"] });
  });
});

describe("seedAgentWorkspace", () => {
  let originalStateDir;
  let stateDir;
  let templateDir;

  beforeEach(() => {
    clearTemplateMtimeCache();
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = mkdtempSync(join(tmpdir(), "seed-state-"));
    templateDir = mkdtempSync(join(tmpdir(), "seed-tpl-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(templateDir, { recursive: true, force: true });
  });

  it("copies system-prompt.md from template to agent workspace", () => {
    const content = "You are IT小刘, a helpful IT assistant.";
    writeFileSync(join(templateDir, "system-prompt.md"), content);

    seedAgentWorkspace("wecom-dm-test", {}, templateDir);

    const dest = join(stateDir, "workspace-wecom-dm-test", "system-prompt.md");
    assert.equal(existsSync(dest), true);
    assert.equal(readFileSync(dest, "utf8"), content);
  });

  it("uses agents.defaults.workspace as the base for non-default agents", () => {
    const configuredRoot = join(stateDir, "configured-workspaces");
    const cfg = {
      agents: {
        defaults: { workspace: configuredRoot },
        list: [{ id: "main" }, { id: "wecom-dm-testcfg" }],
      },
    };
    writeFileSync(join(templateDir, "system-prompt.md"), "configured root");

    seedAgentWorkspace("wecom-dm-testcfg", cfg, templateDir);

    const dest = join(configuredRoot, "wecom-dm-testcfg", "system-prompt.md");
    assert.equal(existsSync(dest), true);
    assert.equal(readFileSync(dest, "utf8"), "configured root");
  });

  it("copies IDENTITY.md alongside system-prompt.md", () => {
    writeFileSync(join(templateDir, "system-prompt.md"), "system prompt");
    writeFileSync(join(templateDir, "IDENTITY.md"), "identity");
    writeFileSync(join(templateDir, "CLAUDE.md"), "claude");

    seedAgentWorkspace("wecom-dm-test2", {}, templateDir);

    const wsDir = join(stateDir, "workspace-wecom-dm-test2");
    assert.equal(existsSync(join(wsDir, "system-prompt.md")), true);
    assert.equal(existsSync(join(wsDir, "IDENTITY.md")), true);
    assert.equal(existsSync(join(wsDir, "CLAUDE.md")), true);
    assert.equal(existsSync(join(wsDir, ".openclaw", "wecom-template-state.json")), true);
  });

  it("skips non-bootstrap files in template directory", () => {
    writeFileSync(join(templateDir, "system-prompt.md"), "sp");
    writeFileSync(join(templateDir, "random-notes.txt"), "notes");

    seedAgentWorkspace("wecom-dm-test3", {}, templateDir);

    const wsDir = join(stateDir, "workspace-wecom-dm-test3");
    assert.equal(existsSync(join(wsDir, "system-prompt.md")), true);
    assert.equal(existsSync(join(wsDir, "random-notes.txt")), false);
  });

  it("does not fail when template has no system-prompt.md (backward compat)", () => {
    writeFileSync(join(templateDir, "IDENTITY.md"), "identity only");

    seedAgentWorkspace("wecom-dm-test4", {}, templateDir);

    const wsDir = join(stateDir, "workspace-wecom-dm-test4");
    assert.equal(existsSync(join(wsDir, "IDENTITY.md")), true);
    assert.equal(existsSync(join(wsDir, "system-prompt.md")), false);
  });

  it("seeds BOOTSTRAP.md before memory markers exist", () => {
    writeFileSync(join(templateDir, "BOOTSTRAP.md"), "plugin bootstrap");
    writeFileSync(join(templateDir, "IDENTITY.md"), "identity");

    seedAgentWorkspace("wecom-dm-bootstrap", {}, templateDir);

    const wsDir = join(stateDir, "workspace-wecom-dm-bootstrap");
    assert.equal(existsSync(join(wsDir, "IDENTITY.md")), true);
    assert.equal(readFileSync(join(wsDir, "BOOTSTRAP.md"), "utf8"), "plugin bootstrap");
  });

  it("does not seed BOOTSTRAP.md when memory directory exists", () => {
    writeFileSync(join(templateDir, "BOOTSTRAP.md"), "plugin bootstrap");
    const wsDir = join(stateDir, "workspace-wecom-dm-no-bootstrap-memory-dir");
    mkdirSync(join(wsDir, "memory"), { recursive: true });

    seedAgentWorkspace("wecom-dm-no-bootstrap-memory-dir", {}, templateDir);

    assert.equal(existsSync(join(wsDir, "BOOTSTRAP.md")), false);
  });

  it("does not seed BOOTSTRAP.md when MEMORY.md exists", () => {
    writeFileSync(join(templateDir, "BOOTSTRAP.md"), "plugin bootstrap");
    const wsDir = join(stateDir, "workspace-wecom-dm-no-bootstrap-memory-file");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "MEMORY.md"), "# long-term memory");

    seedAgentWorkspace("wecom-dm-no-bootstrap-memory-file", {}, templateDir);

    assert.equal(existsSync(join(wsDir, "BOOTSTRAP.md")), false);
  });

  it("does not overwrite workspace file after state exists", () => {
    writeFileSync(join(templateDir, "system-prompt.md"), "template");

    seedAgentWorkspace("wecom-dm-nochange", {}, templateDir);
    const dest = join(stateDir, "workspace-wecom-dm-nochange", "system-prompt.md");

    writeFileSync(dest, "user modified");
    writeFileSync(join(templateDir, "system-prompt.md"), "template updated");

    seedAgentWorkspace("wecom-dm-nochange", {}, templateDir);
    assert.equal(readFileSync(dest, "utf8"), "user modified");
  });

  it("migrates legacy workspace to state without overwriting existing files", () => {
    const wsDir = join(stateDir, "workspace-wecom-dm-legacy");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "IDENTITY.md"), "legacy identity");
    writeFileSync(join(templateDir, "IDENTITY.md"), "template identity");

    seedAgentWorkspace("wecom-dm-legacy", {}, templateDir);

    assert.equal(readFileSync(join(wsDir, "IDENTITY.md"), "utf8"), "legacy identity");
    assert.equal(existsSync(join(wsDir, ".openclaw", "wecom-template-state.json")), true);
  });

  it("fills missing files after state exists without overwriting existing ones", () => {
    writeFileSync(join(templateDir, "system-prompt.md"), "sp-original");
    writeFileSync(join(templateDir, "IDENTITY.md"), "id-original");

    seedAgentWorkspace("wecom-dm-partial", {}, templateDir);
    const wsDir = join(stateDir, "workspace-wecom-dm-partial");
    writeFileSync(join(wsDir, "IDENTITY.md"), "id-user-edit");
    rmSync(join(wsDir, "system-prompt.md"));
    writeFileSync(join(templateDir, "system-prompt.md"), "sp-updated");

    seedAgentWorkspace("wecom-dm-partial", {}, templateDir);

    assert.equal(readFileSync(join(wsDir, "system-prompt.md"), "utf8"), "sp-updated");
    assert.equal(readFileSync(join(wsDir, "IDENTITY.md"), "utf8"), "id-user-edit");
  });

  it("copies configured extra template files and directories", () => {
    mkdirSync(join(templateDir, "scripts"), { recursive: true });
    writeFileSync(join(templateDir, "scripts", "helper.py"), "print('ok')\n");
    writeFileSync(join(templateDir, "requirements.txt"), "requests\n");
    writeFileSync(join(templateDir, "system-prompt.md"), "sp");

    seedAgentWorkspace(
      "wecom-dm-extra",
      {
        channels: {
          wecom: {
            workspaceTemplateExtraFiles: ["scripts/", "requirements.txt"],
          },
        },
      },
      templateDir,
    );

    const wsDir = join(stateDir, "workspace-wecom-dm-extra");
    assert.equal(readFileSync(join(wsDir, "scripts", "helper.py"), "utf8"), "print('ok')\n");
    assert.equal(readFileSync(join(wsDir, "requirements.txt"), "utf8"), "requests\n");
    assert.equal(readFileSync(join(wsDir, "system-prompt.md"), "utf8"), "sp");
  });

  it("skips unsafe extra template entries", () => {
    writeFileSync(join(templateDir, "system-prompt.md"), "sp");
    writeFileSync(join(templateDir, ".env"), "SECRET=1");

    seedAgentWorkspace(
      "wecom-dm-unsafe-extra",
      {
        channels: {
          wecom: {
            workspaceTemplateExtraFiles: [".env", "../outside.py"],
          },
        },
      },
      templateDir,
    );

    const wsDir = join(stateDir, "workspace-wecom-dm-unsafe-extra");
    assert.equal(existsSync(join(wsDir, ".env")), false);
    assert.equal(existsSync(join(wsDir, "outside.py")), false);
    assert.equal(readFileSync(join(wsDir, "system-prompt.md"), "utf8"), "sp");
  });
});

describe("resolveAgentWorkspaceDirLocal", () => {
  it("keeps legacy state-dir fallback when no default workspace is configured", () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR || join(process.env.HOME || "/root", ".openclaw");
    const resolved = resolveAgentWorkspaceDirLocal("wecom-dm-test");
    assert.equal(resolved, join(stateDir, "workspace-wecom-dm-test"));
  });

  it("matches openclaw core by nesting non-default agents under agents.defaults.workspace", () => {
    const resolved = resolveAgentWorkspaceDirLocal("wecom-dm-lirui", {
      agents: {
        defaults: { workspace: "/data/openclaw/workspace" },
        list: [{ id: "main" }, { id: "wecom-dm-lirui" }],
      },
    });
    assert.equal(resolved, "/data/openclaw/workspace/wecom-dm-lirui");
  });
});
