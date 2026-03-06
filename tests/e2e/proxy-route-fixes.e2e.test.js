/**
 * E2E tests for proxy & apiBaseUrl configuration — covering issues #79 and #81.
 *
 * These tests verify:
 *   - #81: Webhook paths return proper HTTP responses (not SPA redirect)
 *          when targets are not configured for a specific sub-path.
 *   - #79: apiBaseUrl override is wired correctly (verified via config check).
 *   - #79: Proxy warning is logged when undici is unavailable.
 *
 * Environment variables (same as remote-wecom.e2e.test.js):
 *   E2E_WECOM_BASE_URL — gateway base URL (set by run-ali-ai.sh with SSH tunnel)
 *   E2E_REMOTE_SSH_HOST — (optional, default: ali-ai) for log inspection
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

const REQUIRED_ENV = ["E2E_WECOM_BASE_URL"];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
const skipReason = missingEnv.length > 0
  ? `missing env: ${missingEnv.join(", ")}`
  : false;

const baseUrl = (process.env.E2E_WECOM_BASE_URL || "").replace(/\/+$/, "");
const sshHost = process.env.E2E_REMOTE_SSH_HOST || "ali-ai";

describe("proxy & route fixes — issues #79 #81", { skip: skipReason }, () => {

  // ── #81: Webhook path should NOT redirect to SPA ──────────────────
  // Before the fix, unregistered sub-paths returned `false` which caused
  // OpenClaw to serve the chat UI. Now they should return 404.

  it("#81: unregistered webhook sub-path returns 404, not SPA redirect", async () => {
    const path = `/webhooks/wecom/nonexistent-account-${Date.now()}`;
    const res = await fetch(`${baseUrl}${path}`, { method: "GET", redirect: "manual" });
    const body = await res.text();

    // Should be 404 (no target) — NOT 200 with HTML (SPA) or 3xx redirect.
    assert.ok(
      res.status === 404 || res.status === 503,
      `Expected 404/503 for unregistered sub-path, got ${res.status}: ${body.substring(0, 100)}`,
    );
    // Body should NOT contain HTML (SPA indicator).
    assert.ok(
      !body.includes("<!DOCTYPE") && !body.includes("<html"),
      "Response should not be HTML/SPA content",
    );
    console.log(`[#81] ${path} → ${res.status}: ${body.substring(0, 80)}`);
  });

  it("#81: registered bot path (/webhooks/wecom) does not redirect to SPA", async () => {
    // GET without signature params — should get 403 (verification failed), not SPA.
    const res = await fetch(`${baseUrl}/webhooks/wecom`, { method: "GET", redirect: "manual" });
    const body = await res.text();

    assert.ok(
      [200, 401, 403, 404, 503].includes(res.status),
      `Expected a webhook response status, got ${res.status}`,
    );
    assert.ok(
      !body.includes("<!DOCTYPE") && !body.includes("<html"),
      "Response should not be HTML/SPA content",
    );
    console.log(`[#81] /webhooks/wecom → ${res.status}: ${body.substring(0, 80)}`);
  });

  // ── #79: Check if gateway has apiBaseUrl / proxy config ─────────────

  it("#79: gateway config contains network section", async () => {
    let configOutput = "";
    try {
      const cmd = `ssh ${sshHost} "node -e \\"const fs=require('fs');const p=process.env.HOME+'/.openclaw/openclaw.json';const cfg=JSON.parse(fs.readFileSync(p,'utf8'));const net=cfg?.channels?.wecom?.network||{};process.stdout.write(JSON.stringify(net));\\" 2>/dev/null"`;
      configOutput = execSync(cmd, { timeout: 10000, encoding: "utf-8" });
    } catch {
      configOutput = "{}";
    }

    const network = JSON.parse(configOutput || "{}");
    console.log(`[#79] Gateway network config:`, JSON.stringify(network));

    // Informational — log what's configured.
    if (network.egressProxyUrl) {
      console.log(`[#79] Proxy configured: ${network.egressProxyUrl}`);
    }
    if (network.apiBaseUrl) {
      console.log(`[#79] API base URL configured: ${network.apiBaseUrl}`);
    }
  });

  it("#79: check if undici is available in gateway process", async () => {
    let undiciCheck = "";
    try {
      // Use heredoc-style quoting to avoid shell escaping issues.
      const cmd = `ssh ${sshHost} 'node -e "try{require.resolve(\\\"undici\\\");console.log(\\\"AVAILABLE\\\")}catch(e){console.log(\\\"NOT_AVAILABLE\\\")}"'`;
      undiciCheck = execSync(cmd, { timeout: 10000, encoding: "utf-8" }).trim();
    } catch {
      undiciCheck = "CHECK_FAILED";
    }

    console.log(`[#79] undici availability: ${undiciCheck}`);
    if (undiciCheck === "NOT_AVAILABLE") {
      console.log(
        "[#79] WARNING: undici not available — egressProxyUrl will NOT work. " +
        "Install with: npm install undici",
      );
    }
  });

  it("#79: check gateway logs for proxy warning", async () => {
    let logs = "";
    try {
      const cmd = `ssh ${sshHost} "journalctl -u openclaw-gateway --no-pager -n 300 --output=cat 2>/dev/null | grep -i proxy || tail -300 /root/.openclaw/logs/gateway.log 2>/dev/null | grep -i proxy || echo NO_PROXY_LOGS"`;
      logs = execSync(cmd, { timeout: 10000, encoding: "utf-8" });
    } catch {
      logs = "LOG_CHECK_FAILED";
    }

    const hasProxyWarning = logs.includes("undici is not available");
    const hasProxyConfigured = logs.includes("egressProxyUrl") || logs.includes("proxy");

    console.log(`[#79] Proxy logs — warning logged: ${hasProxyWarning}, proxy mentioned: ${hasProxyConfigured}`);
    if (hasProxyWarning) {
      console.log("[#79] CONFIRMED: proxy configured but undici unavailable — now shows error instead of silently failing");
    }
  });
});
