const DEFAULT_QWEN_IMAGE_TIMEOUT_MS = 180_000;
const DEFAULT_QWEN_IMAGE_ENDPOINT = "/services/aigc/multimodal-generation/generation";
const DEFAULT_WAN_IMAGE_ENDPOINT = "/services/aigc/image-generation/generation";
const DEFAULT_TASK_ENDPOINT = "/tasks/{task_id}";

const DEFAULT_QWEN_SIZE_PRESETS = Object.freeze({
  landscape: "1920*1080",
  square: "1536*1536",
  portrait: "1080*1920",
});

const DEFAULT_WAN_SIZE_PRESETS = Object.freeze({
  landscape: "1280*720",
  square: "1280*1280",
  portrait: "720*1280",
});

export const DEFAULT_QWEN_IMAGE_TOOLS_CONFIG = Object.freeze({
  enabled: false,
  provider: "dashscope",
  route: "auto",
  endpoints: Object.freeze({
    qwen: DEFAULT_QWEN_IMAGE_ENDPOINT,
    wan: DEFAULT_WAN_IMAGE_ENDPOINT,
    task: DEFAULT_TASK_ENDPOINT,
  }),
  timeoutMs: DEFAULT_QWEN_IMAGE_TIMEOUT_MS,
  models: Object.freeze({
    qwen: Object.freeze({
      generate: "qwen-image-2.0-pro",
      edit: "qwen-image-2.0-pro",
    }),
    wan: Object.freeze({
      generate: "wan2.6-image",
      edit: "wan2.6-image",
    }),
  }),
  defaults: Object.freeze({
    aspect: "landscape",
    n: 1,
    watermark: false,
    promptExtend: true,
    qwen: DEFAULT_QWEN_SIZE_PRESETS,
    wan: DEFAULT_WAN_SIZE_PRESETS,
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createIssue(path, message) {
  return { path, message };
}

function normalizeString(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeTimeout(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1_000, Math.trunc(value));
}

function normalizePositiveInt(value, fallback, minimum = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(value));
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeRoute(value, fallback) {
  const normalized = normalizeString(value, fallback).toLowerCase();
  return normalized === "auto" || normalized === "qwen" || normalized === "wan" ? normalized : fallback;
}

function normalizeAspect(value, fallback) {
  const normalized = normalizeString(value, fallback).toLowerCase();
  return normalized === "landscape" || normalized === "square" || normalized === "portrait" ? normalized : fallback;
}

function normalizeSizePresets(value, fallback, legacySize = "") {
  const source = isPlainObject(value) ? value : {};
  const fallbackSize = normalizeString(legacySize, "");
  return {
    landscape: normalizeString(source.landscape, fallbackSize || fallback.landscape),
    square: normalizeString(source.square, fallbackSize || fallback.square),
    portrait: normalizeString(source.portrait, fallbackSize || fallback.portrait),
  };
}

export function resolveQwenImageToolsConfig(pluginConfig) {
  const root = isPlainObject(pluginConfig) ? pluginConfig : {};
  const raw = isPlainObject(root.qwenImageTools) ? root.qwenImageTools : {};
  const rawEndpoints = isPlainObject(raw.endpoints) ? raw.endpoints : {};
  const rawModels = isPlainObject(raw.models) ? raw.models : {};
  const rawDefaults = isPlainObject(raw.defaults) ? raw.defaults : {};
  const rawQwenModels = isPlainObject(rawModels.qwen) ? rawModels.qwen : {};
  const rawWanModels = isPlainObject(rawModels.wan) ? rawModels.wan : {};
  const rawQwenDefaults = isPlainObject(rawDefaults.qwen) ? rawDefaults.qwen : {};
  const rawWanDefaults = isPlainObject(rawDefaults.wan) ? rawDefaults.wan : {};
  const legacySize = normalizeString(rawDefaults.size, "");

  return {
    enabled: raw.enabled === true,
    provider: normalizeString(raw.provider, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.provider),
    route: normalizeRoute(raw.route, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.route),
    endpoint: normalizeString(raw.endpoint, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.endpoints.qwen),
    endpoints: {
      qwen: normalizeString(rawEndpoints.qwen ?? raw.endpoint, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.endpoints.qwen),
      wan: normalizeString(rawEndpoints.wan, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.endpoints.wan),
      task: normalizeString(rawEndpoints.task, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.endpoints.task),
    },
    timeoutMs: normalizeTimeout(raw.timeoutMs, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.timeoutMs),
    models: {
      qwen: {
        generate: normalizeString(
          rawQwenModels.generate ?? rawModels.generate,
          DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.models.qwen.generate,
        ),
        edit: normalizeString(rawQwenModels.edit ?? rawModels.edit, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.models.qwen.edit),
      },
      wan: {
        generate: normalizeString(rawWanModels.generate, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.models.wan.generate),
        edit: normalizeString(rawWanModels.edit, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.models.wan.edit),
      },
    },
    defaults: {
      size: normalizeString(legacySize, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.qwen.square),
      aspect: normalizeAspect(rawDefaults.aspect, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.aspect),
      n: normalizePositiveInt(rawDefaults.n, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.n),
      watermark: normalizeBoolean(rawDefaults.watermark, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.watermark),
      promptExtend: normalizeBoolean(
        rawDefaults.promptExtend,
        DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.promptExtend,
      ),
      qwen: normalizeSizePresets(rawQwenDefaults, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.qwen, legacySize),
      wan: normalizeSizePresets(rawWanDefaults, DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.wan),
    },
  };
}

export const wecomPluginConfigSchema = {
  safeParse(value) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    if (!isPlainObject(value)) {
      return { success: false, error: { issues: [createIssue([], "expected config object")] } };
    }

    const issues = [];
    if (value.qwenImageTools !== undefined) {
      if (!isPlainObject(value.qwenImageTools)) {
        issues.push(createIssue(["qwenImageTools"], "qwenImageTools must be an object"));
      } else {
        const qwenImageTools = value.qwenImageTools;
        if (qwenImageTools.enabled !== undefined && typeof qwenImageTools.enabled !== "boolean") {
          issues.push(createIssue(["qwenImageTools", "enabled"], "enabled must be a boolean"));
        }
        if (qwenImageTools.provider !== undefined && typeof qwenImageTools.provider !== "string") {
          issues.push(createIssue(["qwenImageTools", "provider"], "provider must be a string"));
        }
        if (qwenImageTools.route !== undefined && typeof qwenImageTools.route !== "string") {
          issues.push(createIssue(["qwenImageTools", "route"], "route must be a string"));
        }
        if (qwenImageTools.endpoint !== undefined && typeof qwenImageTools.endpoint !== "string") {
          issues.push(createIssue(["qwenImageTools", "endpoint"], "endpoint must be a string"));
        }
        if (qwenImageTools.endpoints !== undefined) {
          if (!isPlainObject(qwenImageTools.endpoints)) {
            issues.push(createIssue(["qwenImageTools", "endpoints"], "endpoints must be an object"));
          } else {
            if (qwenImageTools.endpoints.qwen !== undefined && typeof qwenImageTools.endpoints.qwen !== "string") {
              issues.push(createIssue(["qwenImageTools", "endpoints", "qwen"], "qwen must be a string"));
            }
            if (qwenImageTools.endpoints.wan !== undefined && typeof qwenImageTools.endpoints.wan !== "string") {
              issues.push(createIssue(["qwenImageTools", "endpoints", "wan"], "wan must be a string"));
            }
            if (qwenImageTools.endpoints.task !== undefined && typeof qwenImageTools.endpoints.task !== "string") {
              issues.push(createIssue(["qwenImageTools", "endpoints", "task"], "task must be a string"));
            }
          }
        }
        if (qwenImageTools.timeoutMs !== undefined) {
          if (typeof qwenImageTools.timeoutMs !== "number" || !Number.isFinite(qwenImageTools.timeoutMs)) {
            issues.push(createIssue(["qwenImageTools", "timeoutMs"], "timeoutMs must be a number"));
          } else if (qwenImageTools.timeoutMs < 1_000) {
            issues.push(createIssue(["qwenImageTools", "timeoutMs"], "timeoutMs must be at least 1000"));
          }
        }

        if (qwenImageTools.models !== undefined) {
          if (!isPlainObject(qwenImageTools.models)) {
            issues.push(createIssue(["qwenImageTools", "models"], "models must be an object"));
          } else {
            if (
              qwenImageTools.models.generate !== undefined &&
              typeof qwenImageTools.models.generate !== "string"
            ) {
              issues.push(createIssue(["qwenImageTools", "models", "generate"], "generate must be a string"));
            }
            if (qwenImageTools.models.edit !== undefined && typeof qwenImageTools.models.edit !== "string") {
              issues.push(createIssue(["qwenImageTools", "models", "edit"], "edit must be a string"));
            }
            if (qwenImageTools.models.qwen !== undefined) {
              if (!isPlainObject(qwenImageTools.models.qwen)) {
                issues.push(createIssue(["qwenImageTools", "models", "qwen"], "qwen must be an object"));
              } else {
                if (
                  qwenImageTools.models.qwen.generate !== undefined &&
                  typeof qwenImageTools.models.qwen.generate !== "string"
                ) {
                  issues.push(
                    createIssue(["qwenImageTools", "models", "qwen", "generate"], "generate must be a string"),
                  );
                }
                if (
                  qwenImageTools.models.qwen.edit !== undefined &&
                  typeof qwenImageTools.models.qwen.edit !== "string"
                ) {
                  issues.push(
                    createIssue(["qwenImageTools", "models", "qwen", "edit"], "edit must be a string"),
                  );
                }
              }
            }
            if (qwenImageTools.models.wan !== undefined) {
              if (!isPlainObject(qwenImageTools.models.wan)) {
                issues.push(createIssue(["qwenImageTools", "models", "wan"], "wan must be an object"));
              } else {
                if (
                  qwenImageTools.models.wan.generate !== undefined &&
                  typeof qwenImageTools.models.wan.generate !== "string"
                ) {
                  issues.push(
                    createIssue(["qwenImageTools", "models", "wan", "generate"], "generate must be a string"),
                  );
                }
                if (
                  qwenImageTools.models.wan.edit !== undefined &&
                  typeof qwenImageTools.models.wan.edit !== "string"
                ) {
                  issues.push(
                    createIssue(["qwenImageTools", "models", "wan", "edit"], "edit must be a string"),
                  );
                }
              }
            }
          }
        }

        if (qwenImageTools.defaults !== undefined) {
          if (!isPlainObject(qwenImageTools.defaults)) {
            issues.push(createIssue(["qwenImageTools", "defaults"], "defaults must be an object"));
          } else {
            if (qwenImageTools.defaults.size !== undefined && typeof qwenImageTools.defaults.size !== "string") {
              issues.push(createIssue(["qwenImageTools", "defaults", "size"], "size must be a string"));
            }
            if (qwenImageTools.defaults.aspect !== undefined && typeof qwenImageTools.defaults.aspect !== "string") {
              issues.push(createIssue(["qwenImageTools", "defaults", "aspect"], "aspect must be a string"));
            }
            if (qwenImageTools.defaults.n !== undefined) {
              if (typeof qwenImageTools.defaults.n !== "number" || !Number.isFinite(qwenImageTools.defaults.n)) {
                issues.push(createIssue(["qwenImageTools", "defaults", "n"], "n must be a number"));
              } else if (qwenImageTools.defaults.n < 1) {
                issues.push(createIssue(["qwenImageTools", "defaults", "n"], "n must be at least 1"));
              }
            }
            if (
              qwenImageTools.defaults.watermark !== undefined &&
              typeof qwenImageTools.defaults.watermark !== "boolean"
            ) {
              issues.push(createIssue(["qwenImageTools", "defaults", "watermark"], "watermark must be a boolean"));
            }
            if (
              qwenImageTools.defaults.promptExtend !== undefined &&
              typeof qwenImageTools.defaults.promptExtend !== "boolean"
            ) {
              issues.push(
                createIssue(["qwenImageTools", "defaults", "promptExtend"], "promptExtend must be a boolean"),
              );
            }
            for (const family of ["qwen", "wan"]) {
              const familyDefaults = qwenImageTools.defaults[family];
              if (familyDefaults === undefined) {
                continue;
              }
              if (!isPlainObject(familyDefaults)) {
                issues.push(createIssue(["qwenImageTools", "defaults", family], `${family} must be an object`));
                continue;
              }
              for (const aspect of ["landscape", "square", "portrait"]) {
                if (familyDefaults[aspect] !== undefined && typeof familyDefaults[aspect] !== "string") {
                  issues.push(
                    createIssue(["qwenImageTools", "defaults", family, aspect], `${aspect} must be a string`),
                  );
                }
              }
            }
          }
        }
      }
    }

    if (issues.length > 0) {
      return { success: false, error: { issues } };
    }
    return { success: true, data: value };
  },
  jsonSchema: {
    type: "object",
    additionalProperties: true,
    properties: {
      qwenImageTools: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: {
            type: "boolean",
            default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.enabled,
            description: "Register the image_studio tool backed by DashScope Qwen image APIs.",
          },
          provider: {
            type: "string",
            default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.provider,
            description: "Provider alias under models.providers to use for DashScope credentials.",
          },
          route: {
            type: "string",
            default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.route,
            enum: ["auto", "qwen", "wan"],
            description: "Default model routing strategy for image_studio.",
          },
          endpoint: {
            type: "string",
            default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.endpoints.qwen,
            description: "Legacy alias for the Qwen endpoint path.",
          },
          endpoints: {
            type: "object",
            additionalProperties: false,
            properties: {
              qwen: {
                type: "string",
                default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.endpoints.qwen,
              },
              wan: {
                type: "string",
                default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.endpoints.wan,
              },
              task: {
                type: "string",
                default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.endpoints.task,
              },
            },
          },
          timeoutMs: {
            type: "integer",
            default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.timeoutMs,
            minimum: 1000,
            description: "Image generation timeout in milliseconds.",
          },
          models: {
            type: "object",
            additionalProperties: false,
            properties: {
              generate: {
                type: "string",
                default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.models.qwen.generate,
              },
              edit: {
                type: "string",
                default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.models.qwen.edit,
              },
              qwen: {
                type: "object",
                additionalProperties: false,
                properties: {
                  generate: {
                    type: "string",
                    default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.models.qwen.generate,
                  },
                  edit: {
                    type: "string",
                    default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.models.qwen.edit,
                  },
                },
              },
              wan: {
                type: "object",
                additionalProperties: false,
                properties: {
                  generate: {
                    type: "string",
                    default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.models.wan.generate,
                  },
                  edit: {
                    type: "string",
                    default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.models.wan.edit,
                  },
                },
              },
            },
          },
          defaults: {
            type: "object",
            additionalProperties: false,
            properties: {
              size: {
                type: "string",
                default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.qwen.square,
              },
              aspect: {
                type: "string",
                default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.aspect,
                enum: ["landscape", "square", "portrait"],
              },
              n: {
                type: "integer",
                default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.n,
                minimum: 1,
              },
              watermark: {
                type: "boolean",
                default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.watermark,
              },
              promptExtend: {
                type: "boolean",
                default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.promptExtend,
              },
              qwen: {
                type: "object",
                additionalProperties: false,
                properties: {
                  landscape: {
                    type: "string",
                    default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.qwen.landscape,
                  },
                  square: {
                    type: "string",
                    default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.qwen.square,
                  },
                  portrait: {
                    type: "string",
                    default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.qwen.portrait,
                  },
                },
              },
              wan: {
                type: "object",
                additionalProperties: false,
                properties: {
                  landscape: {
                    type: "string",
                    default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.wan.landscape,
                  },
                  square: {
                    type: "string",
                    default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.wan.square,
                  },
                  portrait: {
                    type: "string",
                    default: DEFAULT_QWEN_IMAGE_TOOLS_CONFIG.defaults.wan.portrait,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
