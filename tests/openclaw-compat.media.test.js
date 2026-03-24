import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { getExtendedMediaLocalRoots, loadOutboundMediaFromUrl } from "../wecom/openclaw-compat.js";

describe("openclaw media compat", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const createdDirs = [];

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }

    while (createdDirs.length > 0) {
      await rm(createdDirs.pop(), { recursive: true, force: true });
    }
  });

  it("builds extended local roots from defaults, state dir, and configured roots", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "wecom-compat-state-"));
    createdDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const accountRoot = path.join(stateDir, "account-root");
    const explicitRoot = path.join(stateDir, "explicit-root");
    const roots = await getExtendedMediaLocalRoots({
      accountConfig: { mediaLocalRoots: [accountRoot] },
      mediaLocalRoots: [explicitRoot],
    });

    assert.ok(roots.includes(path.join(stateDir, "media")));
    assert.ok(roots.includes(path.join(stateDir, "workspace")));
    assert.ok(roots.includes(path.join(stateDir, "sandboxes")));
    // stateDir itself should NOT be in roots (only its subdirectories) to prevent path traversal
    assert.ok(!roots.includes(stateDir));
    assert.ok(roots.includes(accountRoot));
    assert.ok(roots.includes(explicitRoot));
  });

  it("loads a local file without requiring runtime initialization", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wecom-compat-local-"));
    createdDirs.push(dir);
    const filePath = path.join(dir, "report.pdf");
    await writeFile(filePath, Buffer.from("%PDF-1.4\n"));

    const loaded = await loadOutboundMediaFromUrl(filePath);

    assert.equal(loaded.fileName, "report.pdf");
    assert.equal(loaded.contentType, "application/pdf");
    assert.equal(loaded.buffer.toString("utf8"), "%PDF-1.4\n");
  });

  it("prefers runtime media loading when explicit local roots are provided", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wecom-compat-runtime-"));
    createdDirs.push(dir);
    const filePath = path.join(dir, "diagram.png");
    await writeFile(filePath, Buffer.from("png"));

    let runtimeCalled = false;
    const loaded = await loadOutboundMediaFromUrl(filePath, {
      mediaLocalRoots: [dir],
      runtimeLoadMedia: async (mediaUrl, options) => {
        runtimeCalled = true;
        assert.equal(mediaUrl, filePath);
        assert.ok(options.localRoots.includes(dir));
        return {
          buffer: Buffer.from("runtime-image"),
          contentType: "image/png",
          fileName: "runtime.png",
        };
      },
    });

    assert.equal(runtimeCalled, true);
    assert.equal(loaded.fileName, "runtime.png");
    assert.equal(loaded.contentType, "image/png");
    assert.equal(loaded.buffer.toString("utf8"), "runtime-image");
  });
});
