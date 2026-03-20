#!/usr/bin/env node

import { spawn } from "node:child_process";

const DEFAULT_HOST = "ali-ai";
const DEFAULT_STATE_ROOT = "/data/openclaw/state-root";

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
      "  node scripts/set-reasoning-stream-remote.js [--host=ali-ai] [--stateRoot=/data/openclaw/state-root] [--write]",
      "",
      "Behavior:",
      "  Default mode is dry-run: only reports which session entries are missing reasoningLevel.",
      "  Pass --write to back up and update only entries missing reasoningLevel -> stream.",
      "",
      "Options:",
      `  --host=${DEFAULT_HOST}`,
      `  --stateRoot=${DEFAULT_STATE_ROOT}`,
      "  --write",
      "  --no-backup",
      "  --help",
    ].join("\n"),
  );
}

function runRemotePython({ host, stateRoot, write, backup }) {
  const remoteArgs = ["python3", "-", "--state-root", stateRoot];
  if (write) {
    remoteArgs.push("--write");
  }
  if (!backup) {
    remoteArgs.push("--no-backup");
  }

  const pythonScript = `
import argparse
import glob
import json
import os
import shutil
import sys
from datetime import datetime

parser = argparse.ArgumentParser()
parser.add_argument("--state-root", required=True)
parser.add_argument("--write", action="store_true")
parser.add_argument("--no-backup", action="store_true")
args = parser.parse_args()

files = sorted(glob.glob(os.path.join(args.state_root, "agents", "*", "sessions", "sessions.json")))
ts = datetime.now().strftime("%Y%m%d-%H%M%S")

result = {
    "host_mode": "apply" if args.write else "dry-run",
    "state_root": args.state_root,
    "total_agents_with_sessions": len(files),
    "agents_need_change": 0,
    "session_entries_missing_reasoningLevel": 0,
    "changed_agents_count": 0,
    "changed_session_entries": 0,
    "details": [],
}

for path in files:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        continue

    missing_keys = []
    changed = False
    for session_key, entry in data.items():
        if not isinstance(entry, dict):
            continue
        if "reasoningLevel" in entry:
            continue
        missing_keys.append(session_key)
        if args.write:
            entry["reasoningLevel"] = "stream"
            changed = True

    if not missing_keys:
        continue

    agent_id = os.path.basename(os.path.dirname(os.path.dirname(path)))
    detail = {
        "agent": agent_id,
        "file": path,
        "missing_entries": len(missing_keys),
        "sessions": missing_keys,
    }
    result["details"].append(detail)
    result["agents_need_change"] += 1
    result["session_entries_missing_reasoningLevel"] += len(missing_keys)

    if not args.write:
        continue

    if changed:
        if not args.no_backup:
            backup = f"{path}.bak-{ts}"
            shutil.copy2(path, backup)
            detail["backup"] = backup

        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\\n")

        result["changed_agents_count"] += 1
        result["changed_session_entries"] += len(missing_keys)

json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
sys.stdout.write("\\n")
`.trimStart();

  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [host, ...remoteArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ssh exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(pythonScript);
  });
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  if (cliArgs.help === "true") {
    printUsage();
    process.exit(0);
  }

  const host = String(cliArgs.host ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const stateRoot = String(cliArgs.stateRoot ?? DEFAULT_STATE_ROOT).trim() || DEFAULT_STATE_ROOT;
  const write = cliArgs.write === "true";
  const backup = cliArgs["no-backup"] !== "true";

  try {
    const { stdout, stderr } = await runRemotePython({
      host,
      stateRoot,
      write,
      backup,
    });
    if (stderr.trim()) {
      process.stderr.write(`${stderr.trim()}\n`);
    }
    process.stdout.write(stdout);
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          host,
          stateRoot,
          mode: write ? "apply" : "dry-run",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

await main();
