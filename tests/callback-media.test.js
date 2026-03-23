import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { downloadCallbackMedia } from "../wecom/callback-media.js";
import { setApiBaseUrl } from "../wecom/constants.js";

async function startWecomTestServer() {
  const pngBody = Buffer.from("fake-png-body");
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/cgi-bin/gettoken") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "test-token", expires_in: 7200 }));
      return;
    }
    if (url.pathname === "/cgi-bin/media/get") {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Disposition": 'attachment; filename="callback.png"',
      });
      res.end(pngBody);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }

  return {
    pngBody,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("downloadCallbackMedia", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const createdDirs = [];

  afterEach(async () => {
    setApiBaseUrl("");
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }

    while (createdDirs.length > 0) {
      await rm(createdDirs.pop(), { recursive: true, force: true });
    }
  });

  it("prefers the provided media runtime store", async () => {
    const server = await startWecomTestServer();
    setApiBaseUrl(server.baseUrl);

    try {
      let called = false;
      const result = await downloadCallbackMedia({
        agent: { corpId: `corp-${Date.now()}`, corpSecret: "secret", agentId: 100001 },
        mediaId: "MEDIA_001",
        type: "image",
        mediaRuntime: {
          async saveMediaBuffer(buffer, contentType, direction, maxBytes, filename) {
            called = true;
            assert.equal(buffer.toString("utf8"), server.pngBody.toString("utf8"));
            assert.equal(contentType, "image/png");
            assert.equal(direction, "inbound");
            assert.equal(maxBytes, 5 * 1024 * 1024);
            assert.equal(filename, "callback.png");
            return { path: "/managed/media/callback.png", contentType };
          },
        },
        config: {},
      });

      assert.equal(called, true);
      assert.deepEqual(result, {
        path: "/managed/media/callback.png",
        contentType: "image/png",
      });
    } finally {
      await server.close();
    }
  });

  it("falls back to the managed OpenClaw media directory instead of /tmp", async () => {
    const server = await startWecomTestServer();
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "wecom-callback-state-"));
    createdDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    setApiBaseUrl(server.baseUrl);

    try {
      const result = await downloadCallbackMedia({
        agent: { corpId: `corp-${Date.now()}-fallback`, corpSecret: "secret", agentId: 100002 },
        mediaId: "MEDIA_002",
        type: "image",
        config: {},
      });

      const expectedPrefix = path.join(stateDir, "media", "wecom") + path.sep;
      assert.ok(
        result.path.startsWith(expectedPrefix),
        `expected ${result.path} to start with ${expectedPrefix}`,
      );
      await access(result.path);
      const content = await readFile(result.path);
      assert.equal(content.toString("utf8"), server.pngBody.toString("utf8"));
      assert.equal(result.contentType, "image/png");
    } finally {
      await server.close();
    }
  });
});
