import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { upsertAgentIdOnlyEntry, seedAgentWorkspace, clearTemplateMtimeCache } from "../wecom/workspace-template.js";

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

  it("copies IDENTITY.md alongside system-prompt.md", () => {
    writeFileSync(join(templateDir, "system-prompt.md"), "system prompt");
    writeFileSync(join(templateDir, "IDENTITY.md"), "identity");

    seedAgentWorkspace("wecom-dm-test2", {}, templateDir);

    const wsDir = join(stateDir, "workspace-wecom-dm-test2");
    assert.equal(existsSync(join(wsDir, "system-prompt.md")), true);
    assert.equal(existsSync(join(wsDir, "IDENTITY.md")), true);
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

  it("re-seeds workspace file when template is updated", () => {
    const original = "original content";
    const updated = "updated content";
    writeFileSync(join(templateDir, "system-prompt.md"), original);

    seedAgentWorkspace("wecom-dm-reseed", {}, templateDir);
    const dest = join(stateDir, "workspace-wecom-dm-reseed", "system-prompt.md");
    assert.equal(readFileSync(dest, "utf8"), original);

    // Update template content and push mtime forward
    clearTemplateMtimeCache();
    const futureTime = Date.now() / 1000 + 10;
    writeFileSync(join(templateDir, "system-prompt.md"), updated);
    utimesSync(join(templateDir, "system-prompt.md"), futureTime, futureTime);

    seedAgentWorkspace("wecom-dm-reseed", {}, templateDir);
    assert.equal(readFileSync(dest, "utf8"), updated);
  });

  it("does not overwrite workspace file when template is unchanged", () => {
    writeFileSync(join(templateDir, "system-prompt.md"), "template");

    seedAgentWorkspace("wecom-dm-nochange", {}, templateDir);
    const dest = join(stateDir, "workspace-wecom-dm-nochange", "system-prompt.md");

    // Manually modify workspace file
    writeFileSync(dest, "user modified");
    // Push dest mtime forward so it's newer than template
    const futureTime = Date.now() / 1000 + 10;
    utimesSync(dest, futureTime, futureTime);

    clearTemplateMtimeCache({ agentSeedCache: false });
    seedAgentWorkspace("wecom-dm-nochange", {}, templateDir);
    assert.equal(readFileSync(dest, "utf8"), "user modified");
  });

  it("overwrites core defaults on first seed even when dest is newer", () => {
    // Simulate core writing a default IDENTITY.md with a newer mtime
    const wsDir = join(stateDir, "workspace-wecom-dm-firstseed");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "IDENTITY.md"), "core default identity");
    const futureTime = Date.now() / 1000 + 60;
    utimesSync(join(wsDir, "IDENTITY.md"), futureTime, futureTime);

    // Template has older mtime but correct content
    writeFileSync(join(templateDir, "IDENTITY.md"), "IT小刘 identity");

    seedAgentWorkspace("wecom-dm-firstseed", {}, templateDir);

    assert.equal(readFileSync(join(wsDir, "IDENTITY.md"), "utf8"), "IT小刘 identity");
  });

  it("only re-seeds the changed template file, leaves others intact", () => {
    writeFileSync(join(templateDir, "system-prompt.md"), "sp-original");
    writeFileSync(join(templateDir, "IDENTITY.md"), "id-original");

    seedAgentWorkspace("wecom-dm-partial", {}, templateDir);
    const wsDir = join(stateDir, "workspace-wecom-dm-partial");
    assert.equal(readFileSync(join(wsDir, "system-prompt.md"), "utf8"), "sp-original");
    assert.equal(readFileSync(join(wsDir, "IDENTITY.md"), "utf8"), "id-original");

    // Modify workspace IDENTITY.md and push its mtime forward (simulates user edit)
    writeFileSync(join(wsDir, "IDENTITY.md"), "id-user-edit");
    const futureWs = Date.now() / 1000 + 20;
    utimesSync(join(wsDir, "IDENTITY.md"), futureWs, futureWs);

    // Update only system-prompt.md template and push its mtime forward
    clearTemplateMtimeCache({ agentSeedCache: false });
    const futureTpl = Date.now() / 1000 + 30;
    writeFileSync(join(templateDir, "system-prompt.md"), "sp-updated");
    utimesSync(join(templateDir, "system-prompt.md"), futureTpl, futureTpl);

    seedAgentWorkspace("wecom-dm-partial", {}, templateDir);

    assert.equal(readFileSync(join(wsDir, "system-prompt.md"), "utf8"), "sp-updated");
    assert.equal(readFileSync(join(wsDir, "IDENTITY.md"), "utf8"), "id-user-edit");
  });
});
