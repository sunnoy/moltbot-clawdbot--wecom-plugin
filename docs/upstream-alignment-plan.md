# WeCom 插件上游规范对齐备忘（v1.x 历史参考）

> 基于 OpenClaw 主仓库（extensions/feishu、extensions/synology-chat、extensions/googlechat 等）的实现模式，
> 梳理 `openclaw-plugin-wecom` 需要调整的四个方面。

---

## 状态更新（2026-03-09）

该文档仅保留为 v1.x / HTTP callback 分支的历史参考，主线设计已切换到：

- [docs/v2-refactoring-plan.md](/home/lr/Downloads/open-code/openclaw-plugin-wecom/docs/v2-refactoring-plan.md)

当前状态如下：

| 项目 | 状态 | 说明 |
|------|------|------|
| `deliveryMode: "direct"` | 已完成 | 当前代码已补齐 |
| plugin-level `configSchema` | 已完成 | 当前 `index.js` 已使用 `safeParse()` 风格空 schema |
| Webhook 路由对齐 SDK | 已过时 | v2 主线不再保留 HTTP callback，因此不再推进该章节 |
| `index.js` 顶层副作用清理 | 已完成 / 将随 v2 进一步简化 | v2 中 `responseUrls` / `streamMeta` 也会整体移除 |

如果继续推进主线，请直接以 `docs/v2-refactoring-plan.md` 为准，不再按照本文的 HTTP 路由章节实施。

---

## 一、补充 `deliveryMode: "direct"`

### 问题

`ChannelOutboundAdapter` 类型定义（`src/channels/plugins/types.adapters.ts`）中
`deliveryMode` 是必填字段，取值为 `"direct" | "gateway" | "hybrid"`。
当前 `wecom/channel-plugin.js` 的 `outbound` 对象缺少该声明。

```typescript
// openclaw 核心 — ChannelOutboundAdapter
export type ChannelOutboundAdapter = {
  deliveryMode: "direct" | "gateway" | "hybrid";   // ← 必填
  sendText?: ...;
  sendMedia?: ...;
  ...
};
```

所有官方频道插件均显式声明了该字段：

| 插件 | deliveryMode |
|------|-------------|
| Feishu | `"direct"` |
| Telegram | `"direct"` |
| Slack | `"direct"` |
| Synology Chat | `"direct"` |
| WhatsApp | `"gateway"` |

### 改动

`wecom/channel-plugin.js`，`outbound` 对象第一行添加：

```diff
  outbound: {
+   deliveryMode: "direct",
    sendText: async ({ cfg: _cfg, to, text, accountId: _accountId }) => {
```

WeCom 插件自行调用企微 API 投递消息，不经 OpenClaw Gateway 中转，与 Feishu 等一致。

### 影响范围

- `wecom/channel-plugin.js` — 1 行

---

## 二、Plugin-level `configSchema` 改用 `emptyPluginConfigSchema()`

### 问题

`index.js` 中的 `plugin.configSchema` 控制 `plugins.entries.wecom.config` 的校验。
当前使用裸 JSON Schema 对象：

```javascript
configSchema: { type: "object", additionalProperties: true, properties: {} }
```

OpenClaw 期望此字段是一个带 `safeParse()` 方法的对象（类似 Zod schema），
官方插件统一使用 `emptyPluginConfigSchema()`：

```typescript
// Feishu
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
const plugin = {
  configSchema: emptyPluginConfigSchema(),
  ...
};

// Synology Chat — 同上
// Google Chat  — 同上
// Discord      — 同上
```

`emptyPluginConfigSchema()` 的实现（`src/plugins/config-schema.ts`）：

```typescript
export function emptyPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown): SafeParseResult {
      if (value === undefined) return { success: true, data: undefined };
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return error("expected config object");
      }
      if (Object.keys(value as Record<string, unknown>).length > 0) {
        return error("config must be empty");
      }
      return { success: true, data: value };
    },
  };
}
```

### 改动

```diff
+ import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

  const plugin = {
    id: "wecom",
    name: "Enterprise WeChat",
    description: "Enterprise WeChat AI Bot channel plugin for OpenClaw",
-   configSchema: { type: "object", additionalProperties: true, properties: {} },
+   configSchema: emptyPluginConfigSchema(),
    register(api) {
```

### 备选方案

若外部 npm 包在运行时无法解析 `openclaw/plugin-sdk`（peerDependency 路径问题），
可内联实现：

```javascript
function emptyPluginConfigSchema() {
  return {
    safeParse(value) {
      if (value === undefined) return { success: true, data: undefined };
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { success: false, error: { message: "expected config object" } };
      }
      return { success: true, data: value };
    },
  };
}
```

### Channel-level configSchema 无需改动

`wecom/channel-plugin.js` 中的 `configSchema: { schema: { ... }, uiHints: { ... } }`
已经是正确的 `ChannelConfigSchema` 格式，与飞书手写 JSON Schema 的方式一致。
官方插件有两种写法：

- Zod → `buildChannelConfigSchema(zodSchema)` 自动转换（Synology Chat）
- 手写 JSON Schema → `{ schema: { $schema, type, properties, ... } }`（Feishu）

WeCom 使用后者，完全合规，保持不变。

### 影响范围

- `index.js` — 2 行（import + 替换）

---

## 三、Webhook 注册改用 SDK `registerPluginHttpRoute`

### 问题

当前插件自建了一套 webhook 路由管理：

1. `wecom/webhook-targets.js` — 自实现 `normalizeWebhookPath()` 和 `registerWebhookTarget()`
2. `wecom/state.js` — `webhookTargets` Map 作为路由表
3. `index.js` — 在 `register()` 中调用 `api.registerHttpRoute()` 注册全局 `/webhooks` prefix handler
4. `wecom/http-handler.js` — `wecomHttpHandler` 通过遍历 `webhookTargets` Map 分发请求

官方插件使用的两种模式：

**模式 A — `registerPluginHttpRoute`（Synology Chat）**

```typescript
import { registerPluginHttpRoute } from "openclaw/plugin-sdk";

// 在 gateway.startAccount 中，按账号注册精确路由
const unregister = registerPluginHttpRoute({
  path: account.webhookPath,
  auth: "plugin",
  replaceExisting: true,
  pluginId: CHANNEL_ID,
  accountId: account.accountId,
  handler,
});
```

**模式 B — `registerWebhookTargetWithPluginRoute`（Google Chat、BlueBubbles）**

```typescript
import { registerWebhookTargetWithPluginRoute } from "openclaw/plugin-sdk";

// 在 gateway.startAccount 中
return registerWebhookTargetWithPluginRoute({
  targetsByPath: webhookTargets,
  target,
  route: {
    auth: "plugin",
    match: "exact",
    pluginId: "googlechat",
    source: "googlechat-webhook",
    accountId: target.account.accountId,
    handler: async (req, res) => { ... },
  },
}).unregister;
```

两种模式的共同点：

- 路由在 `gateway.startAccount` 中注册（不是在 `register()` 中）
- 按账号注册精确路由（不是全局 prefix）
- 使用 SDK 提供的函数（不是自建）
- 返回 `unregister` 函数用于 shutdown 清理

### 改动方案

建议采用**模式 A**（Synology Chat 模式），更直观且 WeCom 不需要多 target 匹配。

#### 3.1 删除 `index.js` 中的全局路由注册

```diff
  register(api) {
    logger.info("WeCom plugin registering...");
    setRuntime(api.runtime);
    setOpenclawConfig(api.config);

    api.registerChannel({ plugin: wecomChannelPlugin });
    logger.info("WeCom channel registered");

-   api.registerHttpRoute({
-     path: "/webhooks",
-     handler: wecomHttpHandler,
-     auth: "plugin",
-     match: "prefix",
-   });
-   logger.info("WeCom HTTP route registered (auth: plugin, match: prefix)");
  },
```

#### 3.2 改造 `gateway.startAccount`

从 SDK 导入 `registerPluginHttpRoute` 和 `normalizeWebhookPath`，在 `startAccount`
中按账号注册精确路由：

```javascript
import {
  registerPluginHttpRoute,
  normalizeWebhookPath,
} from "openclaw/plugin-sdk";

gateway: {
  startAccount: async (ctx) => {
    const account = ctx.account;
    // ... 现有的 proxy/apiBase/conflict 检测逻辑不变 ...

    let unregisterBot;
    const botPath = account.webhookPath;
    if (botPath) {
      const normalizedBotPath = normalizeWebhookPath(botPath);

      // 将 account 信息通过闭包传入 handler
      const botHandler = createBotRouteHandler({
        account,
        config: ctx.cfg,
      });

      unregisterBot = registerPluginHttpRoute({
        path: normalizedBotPath,
        auth: "plugin",
        match: "exact",
        replaceExisting: true,
        pluginId: "wecom",
        source: "wecom-bot-webhook",
        accountId: account.accountId,
        handler: botHandler,
      });

      logger.info("WeCom Bot webhook route registered", {
        path: normalizedBotPath,
        accountId: account.accountId,
      });
    }

    let unregisterAgent;
    if (account.agentInboundConfigured) {
      const agentInboundPath = account.accountId === DEFAULT_ACCOUNT_ID
        ? "/webhooks/app"
        : `/webhooks/app/${account.accountId}`;
      const normalizedAgentPath = normalizeWebhookPath(agentInboundPath);

      if (botPath === agentInboundPath) {
        logger.error("Agent inbound path conflicts with Bot path, skipping", {
          path: agentInboundPath,
        });
      } else {
        const agentHandler = createAgentRouteHandler({
          account,
          config: ctx.cfg,
        });

        unregisterAgent = registerPluginHttpRoute({
          path: normalizedAgentPath,
          auth: "plugin",
          match: "exact",
          replaceExisting: true,
          pluginId: "wecom",
          source: "wecom-agent-inbound",
          accountId: account.accountId,
          handler: agentHandler,
        });

        logger.info("WeCom Agent inbound route registered", {
          path: normalizedAgentPath,
        });
      }
    }

    // shutdown / abortSignal 逻辑中调用 unregisterBot() / unregisterAgent()
    const shutdown = async () => {
      // ... 现有清理逻辑 ...
      unregisterBot?.();
      unregisterAgent?.();
    };
    // ... abortSignal 处理同现有逻辑 ...
  },
},
```

#### 3.3 新增 handler 工厂函数

在 `wecom/http-handler.js` 中新增（或改造现有函数）：

```javascript
/**
 * 创建 Bot 模式的精确路由 handler。
 * account/config 通过闭包绑定，不再从全局 webhookTargets Map 查找。
 */
export function createBotRouteHandler({ account, config }) {
  return async (req, res) => {
    const url = new URL(req.url || "", "http://localhost");
    const query = Object.fromEntries(url.searchParams);
    // 复用现有的 handleWecomRequest，
    // 但 targets 从闭包参数构造而非从全局 Map 查找
    const targets = [{ account, config }];
    await handleWecomRequest(req, res, targets, query, url.pathname);
  };
}

/**
 * 创建 Agent 模式的精确路由 handler。
 */
export function createAgentRouteHandler({ account, config }) {
  return async (req, res) => {
    await handleAgentInbound({
      req,
      res,
      agentAccount: account.agentInbound,
      config,
    });
  };
}
```

#### 3.4 简化或删除 `wecom/webhook-targets.js`

SDK 已提供 `normalizeWebhookPath`，自建版本可删除。
`registerWebhookTarget` 不再需要（改为 SDK 的 `registerPluginHttpRoute`）。

如果仍有其他模块引用 `normalizeWebhookPath`，改为从 SDK 导入：

```diff
- import { normalizeWebhookPath } from "./webhook-targets.js";
+ import { normalizeWebhookPath } from "openclaw/plugin-sdk";
```

#### 3.5 调整 `state.js`

`webhookTargets` Map 不再作为路由表使用，可以删除或仅保留为内部查找表
（如果需要通过 path → account 反查）。

```diff
- export const webhookTargets = new Map();
```

#### 3.6 保留 `wecomHttpHandler` 作为兼容层

`wecomHttpHandler` 保留但标注为 deprecated，仅用于不支持 `registerPluginHttpRoute`
的旧版 OpenClaw：

```javascript
/**
 * @deprecated 仅用于 OpenClaw < 3.x 兼容。
 * 新版本通过 registerPluginHttpRoute 在 startAccount 中注册精确路由。
 */
export async function wecomHttpHandler(req, res) { ... }
```

### 影响范围

| 文件 | 改动类型 |
|------|---------|
| `index.js` | 删除 `registerHttpRoute` 调用 |
| `wecom/channel-plugin.js` | `gateway.startAccount` 改用 SDK 注册 |
| `wecom/http-handler.js` | 新增 `createBotRouteHandler` / `createAgentRouteHandler` |
| `wecom/webhook-targets.js` | 删除或仅保留导出转发 |
| `wecom/state.js` | 删除 `webhookTargets` |
| `wecom/http-handler-state.js` | 如有引用需同步调整 |

---

## 四、移除 `index.js` 顶层副作用

### 问题

`index.js` 模块顶层有一个 `setInterval` 定时器：

```javascript
// 模块加载时立即执行
setInterval(() => {
  // 清理 streamMeta 和 responseUrls
  ...
}, 60 * 1000).unref();
```

官方插件遵循「加载不产生副作用」原则——所有定时器、监听器都在
`register()` 或 `gateway.startAccount()` 中启动。

### 改动

将定时器启动移入 `register()`，并在 shutdown 时清除：

```diff
+ let cleanupTimer = null;

  const plugin = {
    id: "wecom",
    // ...
    register(api) {
      logger.info("WeCom plugin registering...");
      setRuntime(api.runtime);
      setOpenclawConfig(api.config);

+     // 启动周期清理（原 index.js 顶层 setInterval）
+     if (cleanupTimer) clearInterval(cleanupTimer);
+     cleanupTimer = setInterval(() => {
+       const now = Date.now();
+       for (const streamId of streamMeta.keys()) {
+         if (!streamManager.hasStream(streamId)) {
+           streamMeta.delete(streamId);
+         }
+       }
+       for (const [key, entry] of responseUrls.entries()) {
+         if (now > entry.expiresAt) {
+           responseUrls.delete(key);
+         }
+       }
+     }, 60_000);
+     cleanupTimer.unref();

      api.registerChannel({ plugin: wecomChannelPlugin });
      // ...
    },
  };

- setInterval(() => { ... }, 60 * 1000).unref();
```

### 影响范围

- `index.js` — 移动约 15 行代码

---

## 执行计划

| 阶段 | 内容 | 优先级 | 复杂度 | 风险 |
|------|------|--------|--------|------|
| Phase 1 | 补 `deliveryMode: "direct"` | P0 | 极低 | 无 |
| Phase 1 | 移除顶层 `setInterval` 副作用 | P1 | 低 | 无 |
| Phase 2 | `configSchema` 改用 `emptyPluginConfigSchema()` | P1 | 低 | 低 |
| Phase 3 | Webhook 注册改用 SDK `registerPluginHttpRoute` | P2 | 中高 | 中 |

### Phase 1（可立即执行）

两处改动互相独立，风险极低，改完跑现有测试即可验证。

### Phase 2（需验证 peerDep）

先确认外部 npm 包运行时能正确 `import { emptyPluginConfigSchema } from "openclaw/plugin-sdk"`。
若不能，使用内联实现。

### Phase 3（需充分测试）

涉及 webhook 路由生命周期的根本性改造，需要：

1. 单元测试：验证 `createBotRouteHandler` / `createAgentRouteHandler` 的请求分发
2. 集成测试：验证多账号场景下路由注册/注销/热重载
3. E2E 测试：验证 Bot 签名校验 + Agent 回调完整流程
4. 向后兼容测试：确认旧版 OpenClaw（无 `registerPluginHttpRoute`）的降级路径

### 不需要改动的部分

- `channel-plugin.js` 中的 `configSchema`（channel-level）— 已经是正确的
  `{ schema, uiHints }` 格式
- `crypto.js` — 加密实现与插件规范无关
- `stream-manager.js` — 流管理与插件规范无关
- `accounts.js` — 多账号逻辑与插件规范无关（`DEFAULT_ACCOUNT_ID` 可选择从 SDK
  导入，但当前自定义值 `"default"` 与 SDK 一致，无实际差异）
