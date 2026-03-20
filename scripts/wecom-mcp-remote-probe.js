#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const DEFAULT_HOST = "ali-ai";
const DEFAULT_CATEGORIES = ["doc", "contact", "todo", "meeting", "schedule"];

const REMOTE_PYTHON = String.raw`
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

UNSUPPORTED_ERRCODE = 846609
DEFAULT_CATEGORIES = ["doc", "contact", "todo", "meeting", "schedule"]
CONFIG_PATHS = [
    "/data/openclaw/state-root/wecomConfig/config.json",
    os.path.expanduser("~/.openclaw/wecomConfig/config.json"),
]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--categories", default=",".join(DEFAULT_CATEGORIES))
    return parser.parse_args()


def load_config():
    for path in CONFIG_PATHS:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                return path, json.load(fh)
    return None, None


def parse_mcp_payload(raw_text):
    raw_text = raw_text.strip()
    if not raw_text:
        return {}
    if raw_text.startswith("data:"):
        chunks = []
        current = []
        for line in raw_text.splitlines():
            if line.startswith("data: "):
                current.append(line[6:])
                continue
            if line.startswith("data:"):
                current.append(line[5:])
                continue
            if not line.strip() and current:
                chunks.append("\n".join(current).strip())
                current = []
        if current:
            chunks.append("\n".join(current).strip())
        if chunks:
            raw_text = chunks[-1]
    return json.loads(raw_text)


def is_not_opened_error(code, message):
    text = str(message or "")
    return code == UNSUPPORTED_ERRCODE or "unsupported mcp biz type" in text.lower() or "846609" in text


def redact_url(url):
    if not url:
        return url
    try:
        parsed = urllib.parse.urlsplit(url)
        pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        redacted = []
        for key, value in pairs:
            lowered = key.lower()
            if lowered in ("apikey", "access_token", "token", "secret", "key"):
                redacted.append((key, "***"))
            else:
                redacted.append((key, value))
        query = urllib.parse.urlencode(redacted)
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))
    except Exception:
        return url


def list_tools(url):
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "wecom-mcp-remote-probe",
    }
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": {},
    }).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=20) as response:
        content = response.read().decode("utf-8", errors="replace")
    payload = parse_mcp_payload(content)
    if isinstance(payload, dict) and payload.get("error"):
        error = payload["error"]
        message = error.get("message") if isinstance(error, dict) else str(error)
        code = error.get("code") if isinstance(error, dict) else None
        return {
            "ok": False,
            "code": code,
            "message": message,
        }
    tools = ((payload or {}).get("result") or {}).get("tools") or []
    return {
        "ok": True,
        "tools": [
            {
                "name": tool.get("name"),
                "description": tool.get("description") or "",
            }
            for tool in tools
        ],
    }


def main():
    args = parse_args()
    categories = [item.strip() for item in str(args.categories).split(",") if item.strip()]
    if not categories:
        categories = list(DEFAULT_CATEGORIES)

    config_path, config = load_config()
    if not config:
        print(json.dumps({
            "ok": False,
            "stage": "load_config",
            "error": "wecom runtime config not found",
            "checked_paths": CONFIG_PATHS,
        }, ensure_ascii=False, indent=2))
        return 1

    mcp_config = (config.get("mcpConfig") or {})
    result = {
        "ok": True,
        "config_path": config_path,
        "configured_categories": sorted(list(mcp_config.keys())),
        "opened": [],
        "not_opened": [],
        "tools": {},
        "errors": {},
        "urls": {},
    }

    for category in categories:
        category_config = mcp_config.get(category) or {}
        url = category_config.get("url")
        if category_config:
            result["urls"][category] = {
                "type": category_config.get("type") or "streamable-http",
                "url": redact_url(url),
            }
        if not url:
            result["not_opened"].append(category)
            result["errors"][category] = "missing url in config"
            continue

        try:
            listed = list_tools(url)
            if listed["ok"]:
                result["opened"].append(category)
                result["tools"][category] = listed["tools"]
                continue
            if is_not_opened_error(listed.get("code"), listed.get("message")):
                result["not_opened"].append(category)
            else:
                result["opened"].append(category)
            result["errors"][category] = {
                "code": listed.get("code"),
                "message": listed.get("message"),
            }
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")
            if is_not_opened_error(error.code, raw):
                result["not_opened"].append(category)
            else:
                result["opened"].append(category)
            result["errors"][category] = {
                "http_status": error.code,
                "body": raw[:500],
            }
        except Exception as error:
            result["opened"].append(category)
            result["errors"][category] = str(error)

    for key in ("opened", "not_opened"):
        deduped = []
        for item in result[key]:
            if item not in deduped:
                deduped.append(item)
        result[key] = deduped

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


sys.exit(main())
`;

function parseCliArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) {
      continue;
    }
    const body = raw.slice(2);
    const index = body.indexOf("=");
    if (index === -1) {
      args[body] = "true";
      continue;
    }
    const key = body.slice(0, index);
    const value = body.slice(index + 1);
    args[key] = value;
  }
  return args;
}

function printUsage() {
  console.error(
    [
      "Usage:",
      `  node scripts/wecom-mcp-remote-probe.js [--host=${DEFAULT_HOST}] [--categories=doc,contact,todo,meeting,schedule] [--json]`,
      "",
      "Examples:",
      "  node scripts/wecom-mcp-remote-probe.js",
      "  node scripts/wecom-mcp-remote-probe.js --host=ali-ai --json",
      "  node scripts/wecom-mcp-remote-probe.js --categories=doc,contact",
    ].join("\n"),
  );
}

function formatError(error) {
  if (typeof error === "string") {
    return error;
  }
  if (!error || typeof error !== "object") {
    return String(error);
  }
  if (typeof error.message === "string") {
    return error.message;
  }
  if (typeof error.body === "string") {
    return `HTTP ${error.http_status ?? "?"}: ${error.body}`;
  }
  return JSON.stringify(error);
}

function printSummary(host, result) {
  console.log(`Target host: ${host}`);
  console.log(`Config path: ${result.config_path}`);
  console.log("");

  console.log("Configured categories:");
  if ((result.configured_categories ?? []).length === 0) {
    console.log("- (none)");
  } else {
    for (const category of result.configured_categories) {
      console.log(`- ${category}`);
    }
  }
  console.log("");

  console.log("Opened categories:");
  if ((result.opened ?? []).length === 0) {
    console.log("- (none)");
  } else {
    for (const category of result.opened) {
      console.log(`- ${category}`);
    }
  }
  console.log("");

  console.log("Not opened categories:");
  if ((result.not_opened ?? []).length === 0) {
    console.log("- (none)");
  } else {
    for (const category of result.not_opened) {
      console.log(`- ${category}`);
    }
  }

  for (const category of result.opened ?? []) {
    console.log("");
    console.log(`${category} tools:`);
    const tools = result.tools?.[category] ?? [];
    if (tools.length === 0) {
      console.log("- (none)");
      continue;
    }
    for (const tool of tools) {
      console.log(`- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`);
    }
  }

  const errorEntries = Object.entries(result.errors ?? {});
  if (errorEntries.length > 0) {
    console.log("");
    console.log("Errors:");
    for (const [category, error] of errorEntries) {
      console.log(`- ${category}: ${formatError(error)}`);
    }
  }
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help === "true" || args.h === "true") {
    printUsage();
    return 0;
  }

  const host = String(args.host ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const categories = String(args.categories ?? DEFAULT_CATEGORIES.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const wantJson = args.json === "true";

  const sshArgs = [host, "python3", "-", `--categories=${categories.join(",")}`];
  const child = spawnSync("ssh", sshArgs, {
    input: REMOTE_PYTHON,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });

  if (child.error) {
    console.error(`Failed to execute ssh: ${child.error.message}`);
    return 1;
  }
  if (child.status !== 0) {
    process.stderr.write(child.stderr ?? "");
    process.stdout.write(child.stdout ?? "");
    return child.status ?? 1;
  }

  let result;
  try {
    result = JSON.parse(child.stdout);
  } catch (error) {
    process.stderr.write(child.stderr ?? "");
    process.stdout.write(child.stdout ?? "");
    console.error(`Failed to parse remote probe output: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (wantJson) {
    console.log(JSON.stringify({ host, ...result }, null, 2));
    return result.ok ? 0 : 1;
  }

  printSummary(host, result);
  return result.ok ? 0 : 1;
}

process.exit(main());
