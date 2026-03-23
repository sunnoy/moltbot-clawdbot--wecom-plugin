#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const DEFAULT_HOST = "ali-ai";

const REMOTE_NODE = String.raw`
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { WSClient, generateReqId } from "@wecom/aibot-node-sdk";

const DEFAULT_WS_URL = "wss://qyapi.weixin.qq.com/cgi-bin/assistant/get_ticket";
const DEFAULT_PLUGIN_VERSION = "1.0.12";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_ACCOUNT_ID = "default";
const MCP_GET_CONFIG_CMD = "aibot_get_mcp_config";
const MCP_CONFIG_FETCH_TIMEOUT_MS = 15000;
const HTTP_REQUEST_TIMEOUT_MS = 30000;
const UNSUPPORTED_BIZ_TYPE_ERRCODE = 846609;
const RESERVED_KEYS = new Set([
  "enabled",
  "name",
  "botId",
  "secret",
  "websocketUrl",
  "sendThinkingMessage",
  "welcomeMessage",
  "welcomeMessagesFile",
  "allowFrom",
  "dmPolicy",
  "groupPolicy",
  "groupAllowFrom",
  "groups",
  "commands",
  "dynamicAgents",
  "dm",
  "groupChat",
  "adminUsers",
  "workspaceTemplate",
  "agent",
  "webhooks",
  "network",
  "defaultAccount",
  "deliveryMode",
  "mediaLocalRoots",
]);
const SHARED_MULTI_ACCOUNT_KEYS = new Set([
  "enabled",
  "websocketUrl",
  "sendThinkingMessage",
  "welcomeMessage",
  "welcomeMessagesFile",
  "allowFrom",
  "dmPolicy",
  "groupPolicy",
  "groupAllowFrom",
  "groups",
  "commands",
  "dynamicAgents",
  "dm",
  "groupChat",
  "adminUsers",
  "workspaceTemplate",
  "agent",
  "webhooks",
  "network",
  "mediaLocalRoots",
]);

function parseCliArgs(argv) {
  const args = {
    account: "",
    category: "",
    method: "",
    toolArgs: "{}",
    pluginVersion: "",
    protocolVersion: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--account" && argv[index + 1]) {
      args.account = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--account=")) {
      args.account = current.split("=")[1].trim();
      continue;
    }
    if (current === "--category" && argv[index + 1]) {
      args.category = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--category=")) {
      args.category = current.split("=")[1].trim();
      continue;
    }
    if (current === "--method" && argv[index + 1]) {
      args.method = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--method=")) {
      args.method = current.split("=")[1].trim();
      continue;
    }
    if (current === "--args" && argv[index + 1]) {
      args.toolArgs = argv[index + 1];
      index += 1;
      continue;
    }
    if (current.startsWith("--args=")) {
      args.toolArgs = current.slice("--args=".length);
      continue;
    }
    if (current === "--pluginVersion" && argv[index + 1]) {
      args.pluginVersion = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--pluginVersion=")) {
      args.pluginVersion = current.split("=")[1].trim();
      continue;
    }
    if (current === "--protocolVersion" && argv[index + 1]) {
      args.protocolVersion = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--protocolVersion=")) {
      args.protocolVersion = current.split("=")[1].trim();
    }
  }
  return args;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAccountKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = cloneValue(item);
  }
  return next;
}

function mergeConfig(base, override) {
  const next = isPlainObject(base) ? cloneValue(base) : {};
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) {
      delete next[key];
      continue;
    }
    if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = mergeConfig(next[key], value);
      continue;
    }
    next[key] = cloneValue(value);
  }
  return next;
}

function getWecomConfig(config) {
  return isPlainObject(config?.channels?.wecom) ? config.channels.wecom : {};
}

function getAccountEntries(wecom) {
  const entries = [];
  for (const [key, value] of Object.entries(wecom ?? {})) {
    if (RESERVED_KEYS.has(key) || !isPlainObject(value)) {
      continue;
    }
    const accountId = normalizeAccountKey(key);
    if (!accountId) {
      continue;
    }
    entries.push({ key, accountId, value });
  }
  return entries;
}

function hasDictionaryAccounts(wecom) {
  return getAccountEntries(wecom).length > 0;
}

function getSharedMultiAccountConfig(wecom) {
  const shared = {};
  for (const [key, value] of Object.entries(wecom ?? {})) {
    if (SHARED_MULTI_ACCOUNT_KEYS.has(key)) {
      shared[key] = cloneValue(value);
    }
  }
  return shared;
}

function findEntryByAccountId(wecom, accountId) {
  return getAccountEntries(wecom).find((entry) => entry.accountId === accountId) ?? null;
}

function listAccountIds(config) {
  const entries = getAccountEntries(getWecomConfig(config));
  if (!entries.length) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...new Set(entries.map((entry) => entry.accountId))].sort((left, right) => left.localeCompare(right));
}

function resolveDefaultAccountId(config) {
  const wecom = getWecomConfig(config);
  const preferred = normalizeAccountKey(wecom.defaultAccount);
  const accountIds = listAccountIds(config);
  if (preferred && accountIds.includes(preferred)) {
    return preferred;
  }
  if (accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

function buildAccount(accountId, config) {
  const safeConfig = isPlainObject(config) ? cloneValue(config) : {};
  return {
    accountId,
    botId: String(safeConfig.botId ?? "").trim(),
    secret: String(safeConfig.secret ?? "").trim(),
    websocketUrl: String(safeConfig.websocketUrl ?? "").trim(),
  };
}

function resolveAccount(config, requestedAccountId) {
  const wecom = getWecomConfig(config);
  const accountId = normalizeAccountKey(requestedAccountId) || resolveDefaultAccountId(config);
  if (!hasDictionaryAccounts(wecom)) {
    return buildAccount(DEFAULT_ACCOUNT_ID, wecom);
  }
  const shared = getSharedMultiAccountConfig(wecom);
  const entry = findEntryByAccountId(wecom, accountId);
  if (!entry) {
    return buildAccount(accountId, {});
  }
  return buildAccount(accountId, mergeConfig(shared, entry.value));
}

function parseConfigFile(configPath) {
  const raw = fs.readFileSync(configPath, "utf8");
  return vm.runInNewContext("(" + raw + "\n)", Object.create(null), { filename: configPath });
}

function getConfigCandidates() {
  const home = os.homedir();
  const stateDir = String(process.env.OPENCLAW_STATE_DIR ?? "").trim();
  const explicitConfig = String(process.env.OPENCLAW_CONFIG_PATH ?? "").trim();
  return [
    explicitConfig,
    stateDir ? path.join(stateDir, "openclaw.json") : "",
    "/data/openclaw/state-root/openclaw.json",
    path.join(home, ".openclaw", "openclaw.json"),
  ].filter(Boolean);
}

function resolveConfigPath() {
  for (const candidate of getConfigCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("cannot locate openclaw.json");
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function createSdkLogger() {
  return {
    info: (...args) => console.error("[sdk:info]", ...args),
    warn: (...args) => console.error("[sdk:warn]", ...args),
    error: (...args) => console.error("[sdk:error]", ...args),
    debug: (...args) => console.error("[sdk:debug]", ...args),
  };
}

async function waitForAuthenticatedClient(account) {
  const wsClient = new WSClient({
    botId: account.botId,
    secret: account.secret,
    wsUrl: account.websocketUrl || DEFAULT_WS_URL,
    logger: createSdkLogger(),
  });

  return await new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      wsClient.removeAllListeners("authenticated");
      wsClient.removeAllListeners("error");
      wsClient.removeAllListeners("disconnected");
      wsClient.removeAllListeners("event.disconnected_event");
    };

    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn(value);
    };

    wsClient.on("authenticated", () => settle(resolve, wsClient));
    wsClient.on("error", (error) => settle(reject, error));
    wsClient.on("disconnected", (reason) => settle(reject, new Error("WS disconnected before auth: " + reason)));
    wsClient.on("event.disconnected_event", () => settle(reject, new Error("WS disconnected_event received")));

    try {
      wsClient.connect();
    } catch (error) {
      settle(reject, error);
    }
  });
}

function normalizeUnsupported(result, category, stage) {
  const errcode = Number(result?.errcode);
  const rawMessage =
    typeof result?.error === "string"
      ? result.error
      : typeof result?.errmsg === "string"
        ? result.errmsg
        : typeof result?.message === "string"
          ? result.message
          : "";
  return errcode === UNSUPPORTED_BIZ_TYPE_ERRCODE || /unsupported mcp biz type/i.test(rawMessage)
    ? {
        ok: false,
        category,
        stage,
        errcode: UNSUPPORTED_BIZ_TYPE_ERRCODE,
        errmsg: rawMessage || 'unsupported mcp biz type for category "' + category + '"',
      }
    : null;
}

function normalizeCallError(error, category, stage) {
  const unsupported = normalizeUnsupported(error, category, stage);
  if (unsupported) {
    return unsupported;
  }
  return {
    ok: false,
    category,
    stage,
    errcode: error?.errcode ?? error?.code ?? error?.statusCode ?? -1,
    errmsg: error?.errmsg ?? error?.message ?? String(error),
  };
}

function parseToolArgs(rawArgs) {
  const text = String(rawArgs ?? "").trim();
  if (!text) {
    return {};
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("args must be a JSON object");
  }
  return parsed;
}

async function fetchMcpConfig(wsClient, category, pluginVersion) {
  const reqId = generateReqId("mcp_call");
  const response = await withTimeout(
    wsClient.reply(
      { headers: { req_id: reqId } },
      { biz_type: category, plugin_version: pluginVersion || DEFAULT_PLUGIN_VERSION },
      MCP_GET_CONFIG_CMD,
    ),
    MCP_CONFIG_FETCH_TIMEOUT_MS,
    'Timed out fetching MCP config for category "' + category + '"',
  );

  const unsupported = normalizeUnsupported(response, category, "get_mcp_config");
  if (unsupported) {
    return unsupported;
  }

  if (response?.errcode !== undefined && response.errcode !== 0) {
    return {
      ok: false,
      stage: "get_mcp_config",
      errcode: response.errcode,
      errmsg: response.errmsg ?? "unknown",
      category,
    };
  }

  if (!response?.body?.url) {
    return {
      ok: false,
      stage: "get_mcp_config",
      errcode: -1,
      errmsg: "missing url in response body",
      category,
    };
  }

  return {
    ok: true,
    category,
    url: response.body.url,
    transportType:
      response.body.transport_type ??
      response.body.transportType ??
      response.body.config_type ??
      response.body.configType ??
      response.body.type ??
      "streamable-http",
    isAuthed: response.body.is_authed,
  };
}

async function parseSseResponse(response) {
  const text = await response.text();
  const lines = text.split("\n");
  let currentDataParts = [];
  let lastEventData = "";

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      currentDataParts.push(line.slice(6));
      continue;
    }
    if (line.startsWith("data:")) {
      currentDataParts.push(line.slice(5));
      continue;
    }
    if (line.trim() === "" && currentDataParts.length > 0) {
      lastEventData = currentDataParts.join("\n").trim();
      currentDataParts = [];
    }
  }

  if (currentDataParts.length > 0) {
    lastEventData = currentDataParts.join("\n").trim();
  }

  if (!lastEventData) {
    throw new Error("SSE response did not contain usable data");
  }

  const rpc = JSON.parse(lastEventData);
  if (rpc.error) {
    const error = new Error(rpc.error.message ?? "MCP RPC error");
    error.code = rpc.error.code;
    error.data = rpc.error.data;
    throw error;
  }

  return rpc.result;
}

async function sendRawJsonRpc(url, sessionId, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_REQUEST_TIMEOUT_MS);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const newSessionId = response.headers.get("mcp-session-id");
    if (!response.ok) {
      const error = new Error("HTTP " + response.status + " " + response.statusText);
      error.statusCode = response.status;
      throw error;
    }

    const contentLength = response.headers.get("content-length");
    if (response.status === 204 || contentLength === "0") {
      return { result: undefined, sessionId: newSessionId ?? sessionId };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const result = contentType.includes("text/event-stream")
      ? await parseSseResponse(response)
      : await response.json().then((rpc) => {
          if (rpc.error) {
            const error = new Error(rpc.error.message ?? "MCP RPC error");
            error.code = rpc.error.code;
            error.data = rpc.error.data;
            throw error;
          }
          return rpc.result;
        });

    return { result, sessionId: newSessionId ?? sessionId };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callTool(url, protocolVersion, method, toolArgs) {
  let sessionId = null;

  const init = await sendRawJsonRpc(url, sessionId, {
    jsonrpc: "2.0",
    id: generateReqId("mcp_init"),
    method: "initialize",
    params: {
      protocolVersion: protocolVersion || DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "wecom_mcp_remote_call", version: "1.0.0" },
    },
  });
  sessionId = init.sessionId;

  const initialized = await sendRawJsonRpc(url, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  sessionId = initialized.sessionId;

  const called = await sendRawJsonRpc(url, sessionId, {
    jsonrpc: "2.0",
    id: generateReqId("mcp_call"),
    method: "tools/call",
    params: {
      name: method,
      arguments: toolArgs,
    },
  });

  return called.result;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.category || !args.method) {
    throw new Error("category and method are required");
  }

  const configPath = resolveConfigPath();
  const config = parseConfigFile(configPath);
  const account = resolveAccount(config, args.account);
  if (!account.botId || !account.secret) {
    throw new Error(
      args.account
        ? 'account "' + args.account + '" is missing botId/secret'
        : "default WeCom account is missing botId/secret",
    );
  }

  const wsClient = await waitForAuthenticatedClient(account);
  let result;
  try {
    let mcpConfig;
    try {
      mcpConfig = await fetchMcpConfig(wsClient, args.category, args.pluginVersion);
    } catch (error) {
      result = normalizeCallError(error, args.category, "get_mcp_config");
    }
    if (result) {
      // Skip tool call when MCP config fetch already failed.
    } else if (!mcpConfig.ok) {
      result = mcpConfig;
    } else {
      try {
        const called = await callTool(mcpConfig.url, args.protocolVersion, args.method, parseToolArgs(args.toolArgs));
        result = {
          ok: true,
          category: args.category,
          method: args.method,
          url: mcpConfig.url,
          transportType: mcpConfig.transportType,
          isAuthed: mcpConfig.isAuthed,
          result: called,
        };
      } catch (error) {
        result = normalizeCallError(error, args.category, "tools/call");
      }
    }
  } finally {
    try {
      wsClient.disconnect();
    } catch {
      // Ignore disconnect failures on exit.
    }
  }

  console.log(JSON.stringify({
    ok: result?.ok !== false,
    config_path: configPath,
    account_id: account.accountId,
    category: args.category,
    method: args.method,
    call: result,
  }, null, 2));
  if (result?.ok === false) {
    process.exit(1);
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    stage: "bootstrap",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
`;

function parseArgs(argv) {
  const args = {
    host: DEFAULT_HOST,
    account: "",
    category: "",
    method: "",
    toolArgs: "{}",
    pluginVersion: "",
    protocolVersion: "",
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--host" && argv[index + 1]) {
      args.host = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--host=")) {
      args.host = current.split("=")[1].trim();
      continue;
    }
    if (current === "--account" && argv[index + 1]) {
      args.account = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--account=")) {
      args.account = current.split("=")[1].trim();
      continue;
    }
    if (current === "--category" && argv[index + 1]) {
      args.category = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--category=")) {
      args.category = current.split("=")[1].trim();
      continue;
    }
    if (current === "--method" && argv[index + 1]) {
      args.method = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--method=")) {
      args.method = current.split("=")[1].trim();
      continue;
    }
    if (current === "--args" && argv[index + 1]) {
      args.toolArgs = argv[index + 1];
      index += 1;
      continue;
    }
    if (current.startsWith("--args=")) {
      args.toolArgs = current.slice("--args=".length);
      continue;
    }
    if (current === "--pluginVersion" && argv[index + 1]) {
      args.pluginVersion = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--pluginVersion=")) {
      args.pluginVersion = current.split("=")[1].trim();
      continue;
    }
    if (current === "--protocolVersion" && argv[index + 1]) {
      args.protocolVersion = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (current.startsWith("--protocolVersion=")) {
      args.protocolVersion = current.split("=")[1].trim();
      continue;
    }
    if (current === "--json") {
      args.json = true;
    }
  }
  return args;
}

function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, `'\"'\"'`) + "'";
}

function runRemoteCall(options) {
  const remoteArgs = [
    "--category=" + options.category,
    "--method=" + options.method,
    "--args=" + options.toolArgs,
  ];
  if (options.account) {
    remoteArgs.push("--account=" + options.account);
  }
  if (options.pluginVersion) {
    remoteArgs.push("--pluginVersion=" + options.pluginVersion);
  }
  if (options.protocolVersion) {
    remoteArgs.push("--protocolVersion=" + options.protocolVersion);
  }

  const pluginDir = "/data/openclaw/state-root/extensions/wecom";
  const remoteCommand =
    "tmp=" +
    pluginDir +
    "/.cursor-wecom-mcp-remote-call-$$.mjs" +
    " && cat > \"$tmp\"" +
    " && cd " +
    pluginDir +
    " && node \"$tmp\" " +
    remoteArgs.map((arg) => quoteShellArg(arg)).join(" ") +
    "; rc=$?" +
    " && rm -f \"$tmp\"" +
    " && exit $rc";
  const result = spawnSync("ssh", [options.host, remoteCommand], {
    input: REMOTE_NODE,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? "";
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new Error("cannot parse ssh stdout as JSON: " + error.message + (stderr ? "\n" + stderr : ""));
    }
  }

  return {
    status: result.status ?? 1,
    stdout,
    stderr,
    parsed,
  };
}

function printHumanSummary(result, options) {
  const parsed = result.parsed ?? {};
  const call = parsed.call ?? {};
  const account = (parsed.account_id ?? options.account) || "default";

  console.log("host: " + options.host);
  console.log("account: " + account);
  console.log("config: " + (parsed.config_path ?? "-"));
  console.log("category: " + (parsed.category ?? options.category));
  console.log("method: " + (parsed.method ?? options.method));
  console.log("ok: " + (call.ok === true ? "yes" : "no"));
  if (call.ok === true) {
    console.log("mcp_url: " + (call.url ?? "-"));
    console.log("transport: " + (call.transportType ?? "-"));
    console.log("");
    console.log(JSON.stringify(call.result ?? {}, null, 2));
    return;
  }

  console.log(
    "error: stage=" +
      (call.stage ?? "unknown") +
      " errcode=" +
      String(call.errcode ?? "-") +
      " errmsg=" +
      (call.errmsg ?? "unknown"),
  );
  if (result.stderr) {
    console.log("remote_stderr:");
    console.log(result.stderr);
  }
}

function printUsage() {
  console.error(
    [
      "Usage:",
      "  node scripts/wecom-mcp-remote-call.js --category=msg --method=get_msg_chat_list --args='{\"begin_time\":\"2026-03-17 00:00:00\",\"end_time\":\"2026-03-20 23:59:59\"}'",
      "  node scripts/wecom-mcp-remote-call.js --account=default --category=doc --method=get_doc_content --args='{\"doc_id\":\"...\"}'",
      "",
      "Optional:",
      "  --host=" + DEFAULT_HOST,
      "  --account=<wecom account id>",
      "  --pluginVersion=<override plugin_version>",
      "  --protocolVersion=<override MCP protocol version>",
      "  --json",
    ].join("\n"),
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.category || !options.method) {
    printUsage();
    process.exit(1);
  }

  const result = runRemoteCall(options);
  if (!result.parsed) {
    throw new Error("ssh returned no JSON output" + (result.stderr ? "\n" + result.stderr : ""));
  }

  if (options.json) {
    console.log(JSON.stringify(result.parsed, null, 2));
  } else {
    printHumanSummary(result, options);
  }
  process.exit(result.status);
}

try {
  main();
} catch (error) {
  printUsage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
