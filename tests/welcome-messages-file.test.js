import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  clearWelcomeMessagesFileCacheForTesting,
  loadWelcomeMessagesFromFile,
  resolveWelcomeMessagesFilePath,
} from "../wecom/welcome-messages-file.js";

describe("welcome-messages-file", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    clearWelcomeMessagesFileCacheForTesting();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("resolveWelcomeMessagesFilePath returns empty when unset", () => {
    assert.equal(resolveWelcomeMessagesFilePath({}), "");
    assert.equal(resolveWelcomeMessagesFilePath(undefined), "");
  });

  it("resolveWelcomeMessagesFilePath joins relative paths to OPENCLAW_STATE_DIR", () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "wecom-welcome-state-"));
    process.env.OPENCLAW_STATE_DIR = state;
    const resolved = resolveWelcomeMessagesFilePath({ welcomeMessagesFile: "my/welcome.json" });
    assert.equal(resolved, path.join(state, "my/welcome.json"));
  });

  it("loadWelcomeMessagesFromFile reads JSON string array and caches by mtime", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wecom-welcome-json-"));
    const filePath = path.join(dir, "list.json");
    writeFileSync(filePath, JSON.stringify(["hello", "world"]), "utf8");

    const list = loadWelcomeMessagesFromFile({ welcomeMessagesFile: filePath });
    assert.deepEqual(list, ["hello", "world"]);

    writeFileSync(filePath, JSON.stringify(["next"]), "utf8");
    const reloaded = loadWelcomeMessagesFromFile({ welcomeMessagesFile: filePath });
    assert.deepEqual(reloaded, ["next"]);
  });

  it("loadWelcomeMessagesFromFile returns null for invalid JSON shape", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wecom-welcome-bad-"));
    const filePath = path.join(dir, "bad.json");
    writeFileSync(filePath, JSON.stringify({ messages: "not-an-array" }), "utf8");

    assert.equal(loadWelcomeMessagesFromFile({ welcomeMessagesFile: filePath }), null);
  });

  it("loadWelcomeMessagesFromFile joins line arrays and accepts { messages: [...] }", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wecom-welcome-lines-"));
    const filePath = path.join(dir, "list.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        messages: [["a", "", "b"], "plain", ["single"]],
      }),
      "utf8",
    );

    const list = loadWelcomeMessagesFromFile({ welcomeMessagesFile: filePath });
    assert.deepEqual(list, ["a\n\nb", "plain", "single"]);
  });

  it("loadWelcomeMessagesFromFile returns null when file missing", () => {
    assert.equal(
      loadWelcomeMessagesFromFile({ welcomeMessagesFile: "/nonexistent/wecom-welcome.json" }),
      null,
    );
  });
});
