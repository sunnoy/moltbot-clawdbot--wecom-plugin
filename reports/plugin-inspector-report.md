# OpenClaw Plugin Compatibility Report

Generated: deterministic
Status: PASS

## Summary

| Metric                    | Value |
| ------------------------- | ----- |
| Fixtures                  | 1     |
| High-priority fixtures    | 1     |
| Hard breakages            | 0     |
| Warnings                  | 0     |
| Compatibility suggestions | 5     |
| Issue findings            | 5     |
| P0 issues                 | 0     |
| P1 issues                 | 2     |
| Live issues               | 0     |
| Live P0 issues            | 0     |
| Compat gaps               | 0     |
| Deprecation warnings      | 0     |
| Inspector gaps            | 5     |
| Upstream metadata         | 0     |
| Contract probes           | 5     |
| Decision rows             | 5     |

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

## Hard Breakages

_none_

## Target OpenClaw Compat Records

| Metric                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configured path          | /Users/vincentkoc/GIT/_Perso/openclaw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Status                   | ok                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Compat registry          | ../../openclaw/src/plugins/compat/registry.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Compat records           | 56                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Compat status counts     | active:13, deprecated:43                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Record ids               | activation-agent-harness-hint, activation-capability-hint, activation-channel-hint, activation-command-hint, activation-config-path-hint, activation-provider-hint, activation-route-hint, agent-harness-id-alias, agent-harness-sdk-alias, agent-tool-result-harness-alias, approval-capability-approvals-alias, bundled-channel-config-schema-legacy, bundled-plugin-allowlist, bundled-plugin-enablement, bundled-plugin-load-path-aliases, bundled-plugin-vitest-defaults, channel-env-vars, channel-exposure-legacy-aliases, channel-mention-gating-legacy-helpers, channel-native-message-schema-helpers, channel-route-key-aliases, channel-runtime-sdk-alias, channel-target-comparable-aliases, clawdbot-config-type-alias, command-auth-status-builders, disable-persisted-plugin-registry-env, embedded-harness-config-alias, generated-bundled-channel-config-fallback, hook-only-plugin-shape, legacy-before-agent-start, legacy-extension-api-import, legacy-implicit-startup-sidecar, legacy-root-sdk-import, memory-split-registration, openclaw-schema-type-alias, plugin-activate-entrypoint-alias, plugin-install-config-ledger, plugin-owned-web-fetch-config, plugin-owned-web-search-config, plugin-owned-x-search-config, plugin-registry-install-migration-env, plugin-sdk-test-utils-alias, plugin-sdk-testing-barrel, provider-auth-env-vars, provider-discovery-hook-alias, provider-discovery-type-aliases, provider-external-oauth-profiles-hook, provider-static-capabilities-bag, provider-thinking-policy-hooks, provider-web-search-core-wrapper, runtime-config-load-write, runtime-inbound-envelope-alias, runtime-stt-alias, runtime-subagent-get-session-alias, runtime-taskflow-legacy-alias, setup-runtime-fallback |
| Hook registry            | ../../openclaw/src/plugins/hook-types.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Hook names               | 35                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| API builder              | ../../openclaw/src/plugins/api-builder.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| API registrars           | 48                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Captured registration    | ../../openclaw/src/plugins/captured-registration.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Captured registrars      | 26                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Package metadata         | ../../openclaw/package.json                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Plugin SDK exports       | 292                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Manifest types           | ../../openclaw/src/plugins/manifest.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Manifest fields          | 35                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Manifest contract fields | 17                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Warnings

_none_

## Suggestions To OpenClaw Compat Layer

| Fixture | Code                                | Level      | Message                                                                                                      | Evidence                                                                                                                                  | Compat record |
| ------- | ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| wecom   | package-dependency-install-required | suggestion | package declares runtime dependencies that must be installed before cold import                              | @wecom/aibot-node-sdk @ package.json, file-type @ package.json, pinyin-pro @ package.json, openclaw @ package.json, undici @ package.json | -             |
| wecom   | registration-capture-gap            | suggestion | future inspector capture API should record lifecycle, route, gateway, command, and interactive registrations | registerChannel @ index.js:27, registerHttpRoute @ index.js:56                                                                            | -             |
| wecom   | before-tool-call-probe              | suggestion | add contract probes for before_tool_call terminal, block, and approval semantics                             | before_tool_call @ index.js:76                                                                                                            | -             |
| wecom   | channel-contract-probe              | suggestion | add channel envelope, config-schema, and runtime metadata probes                                             | registerChannel @ index.js:27                                                                                                             | -             |
| wecom   | runtime-tool-capture                | suggestion | tool shape is only visible after runtime registration capture                                                | registerTool @ index.js:28, registerTool @ index.js:40, registerTool @ index.js:44                                                        | -             |

## Issue Findings

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

## Fixture Seam Inventory

| Fixture | Priority | Seams          | Hooks                                                                                             | Registrations                                    | Manifest contracts |
| ------- | -------- | -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------ |
| wecom   | high     | plugin-runtime | before_prompt_build, before_tool_call, subagent_delivery_target, subagent_ended, subagent_spawned | registerChannel, registerHttpRoute, registerTool | -                  |

## Decision Matrix

| Fixture | Decision            | Seam                 | Action                                                                                               | Evidence                                                       |
| ------- | ------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| wecom   | inspector-follow-up | cold-import          | Install runtime dependencies in an isolated workspace before executing this fixture entrypoint.      | @wecom/aibot-node-sdk, file-type, pinyin-pro, openclaw, undici |
| wecom   | inspector-follow-up | registration-capture | Expose or mirror a full public API capture shim before treating these runtime-only seams as covered. | registerChannel, registerHttpRoute                             |
| wecom   | inspector-follow-up | tool-policy          | Probe before_tool_call return shapes before changing tool-call approval or block behavior.           | before_tool_call                                               |
| wecom   | inspector-follow-up | channel-runtime      | Probe channel setup and message envelope contracts before changing channel runtime payloads.         | registerChannel                                                |
| wecom   | inspector-follow-up | tool-schema          | Capture registered tool schemas from plugin register() before judging tool compatibility.            | registerTool without manifest contracts.tools                  |

## Raw Logs

| Fixture | Code                    | Level | Message                                                                          | Evidence                                                                                                                                                                                                            | Compat record |
| ------- | ----------------------- | ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| wecom   | seam-inventory          | log   | observed 5 hooks, 3 registrations, and 0 manifest contracts                      | hook:before_prompt_build, hook:before_tool_call, hook:subagent_delivery_target, hook:subagent_ended, hook:subagent_spawned, registration:registerChannel, registration:registerHttpRoute, registration:registerTool | -             |
| wecom   | hook-names-present      | log   | all observed hooks exist in the target OpenClaw hook registry                    | before_prompt_build, before_tool_call, subagent_delivery_target, subagent_ended, subagent_spawned                                                                                                                   | -             |
| wecom   | api-registrars-present  | log   | all observed api.register* calls exist in the target OpenClaw plugin API builder | registerChannel, registerHttpRoute, registerTool                                                                                                                                                                    | -             |
| wecom   | sdk-exports-present     | log   | all observed plugin SDK imports exist in target OpenClaw package exports         | openclaw/plugin-sdk/core, openclaw/plugin-sdk/media-runtime, openclaw/plugin-sdk/setup, openclaw/plugin-sdk/status-helpers                                                                                          | -             |
| wecom   | manifest-fields-checked | log   | plugin manifest fields were compared with target OpenClaw manifest types         | openclaw.plugin.json                                                                                                                                                                                                | -             |
| wecom   | package-metadata        | log   | selected package metadata for plugin contract checks                             | package.json, @sunnoy/wecom, version:3.2.0                                                                                                                                                                          | -             |
