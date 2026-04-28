# OpenClaw Plugin Issue Findings

Generated: deterministic
Status: PASS

## Triage Summary

| Metric               | Value |
| -------------------- | ----- |
| Issue findings       | 5     |
| P0                   | 0     |
| P1                   | 2     |
| Live issues          | 0     |
| Live P0 issues       | 0     |
| Compat gaps          | 0     |
| Deprecation warnings | 0     |
| Inspector gaps       | 5     |
| Upstream metadata    | 0     |
| Contract probes      | 5     |

## Triage Overview

| Class               | Count | P0 | Meaning                                                                                                         |
| ------------------- | ----- | -- | --------------------------------------------------------------------------------------------------------------- |
| live-issue          | 0     | 0  | Potential runtime breakage in the target OpenClaw/plugin pair. P0 only when it is not a deprecated compat seam. |
| compat-gap          | 0     | -  | Compatibility behavior is needed but missing from the target OpenClaw compat registry.                          |
| deprecation-warning | 0     | -  | Plugin uses a supported but deprecated compatibility seam; keep it wired while migration exists.                |
| inspector-gap       | 5     | -  | Plugin Inspector needs stronger capture/probe evidence before making contract judgments.                        |
| upstream-metadata   | 0     | -  | Plugin package or manifest metadata should improve upstream; not a target OpenClaw live break by itself.        |
| fixture-regression  | 0     | -  | Fixture no longer exposes an expected seam; investigate fixture pin or scanner drift.                           |

## P0 Live Issues

_none_

## Live Issues

_none_

## Compat Gaps

_none_

## Deprecation Warnings

_none_

## Inspector Proof Gaps

- P1 **wecom** `inspector-gap` `inspector-follow-up`
  - **before-tool-call-probe**: wecom: before_tool_call needs terminal/block/approval probes
  - state: open · compat:none
  - evidence:
    - before_tool_call @ index.js:76

- P1 **wecom** `inspector-gap` `inspector-follow-up`
  - **registration-capture-gap**: wecom: runtime registrations need capture before contract judgment
  - state: open · compat:none
  - evidence:
    - registerChannel @ index.js:27
    - registerHttpRoute @ index.js:56

- P2 **wecom** `inspector-gap` `inspector-follow-up`
  - **channel-contract-probe**: wecom: channel runtime needs envelope/config probes
  - state: open · compat:none
  - evidence:
    - registerChannel @ index.js:27

- P2 **wecom** `inspector-gap` `inspector-follow-up`
  - **package-dependency-install-required**: wecom: cold import requires isolated dependency installation
  - state: open · compat:none
  - evidence:
    - @wecom/aibot-node-sdk @ package.json
    - file-type @ package.json
    - pinyin-pro @ package.json
    - openclaw @ package.json
    - undici @ package.json

- P2 **wecom** `inspector-gap` `inspector-follow-up`
  - **runtime-tool-capture**: wecom: runtime tool schema needs registration capture
  - state: open · compat:none
  - evidence:
    - registerTool @ index.js:28
    - registerTool @ index.js:40
    - registerTool @ index.js:44

## Upstream Metadata Issues

_none_

## Issues

- P1 **wecom** `inspector-gap` `inspector-follow-up`
  - **before-tool-call-probe**: wecom: before_tool_call needs terminal/block/approval probes
  - state: open · compat:none
  - evidence:
    - before_tool_call @ index.js:76

- P1 **wecom** `inspector-gap` `inspector-follow-up`
  - **registration-capture-gap**: wecom: runtime registrations need capture before contract judgment
  - state: open · compat:none
  - evidence:
    - registerChannel @ index.js:27
    - registerHttpRoute @ index.js:56

- P2 **wecom** `inspector-gap` `inspector-follow-up`
  - **channel-contract-probe**: wecom: channel runtime needs envelope/config probes
  - state: open · compat:none
  - evidence:
    - registerChannel @ index.js:27

- P2 **wecom** `inspector-gap` `inspector-follow-up`
  - **package-dependency-install-required**: wecom: cold import requires isolated dependency installation
  - state: open · compat:none
  - evidence:
    - @wecom/aibot-node-sdk @ package.json
    - file-type @ package.json
    - pinyin-pro @ package.json
    - openclaw @ package.json
    - undici @ package.json

- P2 **wecom** `inspector-gap` `inspector-follow-up`
  - **runtime-tool-capture**: wecom: runtime tool schema needs registration capture
  - state: open · compat:none
  - evidence:
    - registerTool @ index.js:28
    - registerTool @ index.js:40
    - registerTool @ index.js:44

## Contract Probe Backlog

- P1 **wecom** `inspector-capture-api`
  - contract: External inspector capture records service, route, gateway, command, and interactive registrations.
  - id: `api.capture.runtime-registrars:wecom`
  - evidence:
    - registerChannel @ index.js:27
    - registerHttpRoute @ index.js:56

- P1 **wecom** `hook-runner`
  - contract: Hook returns preserve terminal, block, and approval semantics.
  - id: `hook.before_tool_call.terminal-block-approval:wecom`
  - evidence:
    - before_tool_call @ index.js:76

- P2 **wecom** `channel-runtime`
  - contract: Channel setup, message envelope, sender metadata, and config schema remain stable.
  - id: `channel.runtime.envelope-config-metadata:wecom`
  - evidence:
    - registerChannel @ index.js:27

- P2 **wecom** `package-loader`
  - contract: Inspector installs package dependencies in an isolated workspace before cold import.
  - id: `package.entrypoint.isolated-dependency-install:wecom`
  - evidence:
    - @wecom/aibot-node-sdk @ package.json
    - file-type @ package.json
    - pinyin-pro @ package.json
    - openclaw @ package.json
    - undici @ package.json

- P2 **wecom** `tool-runtime`
  - contract: Registered runtime tools expose stable names, input schemas, and result metadata.
  - id: `tool.registration.schema-capture:wecom`
  - evidence:
    - registerTool @ index.js:28
    - registerTool @ index.js:40
    - registerTool @ index.js:44
