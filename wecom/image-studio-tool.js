import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";
import { loadOutboundMediaFromUrl } from "./openclaw-compat.js";

const DEFAULT_QWEN_ENDPOINT_PATH = "/services/aigc/multimodal-generation/generation";
const DEFAULT_WAN_ENDPOINT_PATH = "/services/aigc/image-generation/generation";
const DEFAULT_WAN_TASK_ENDPOINT = "/tasks/{task_id}";
const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_IMAGES = 6;
const ACTIONS = new Set(["generate", "edit"]);
const ASPECTS = new Set(["landscape", "square", "portrait"]);
const MODEL_FAMILIES = new Set(["qwen", "wan"]);
const WAN_GENERATE_MAX_PIXELS = 1280 * 1280;

const QWEN_PRIORITY_PATTERNS = [
  /架构图/u,
  /架构/u,
  /流程图/u,
  /时序图/u,
  /拓扑/u,
  /\bdiagram\b/iu,
  /\bworkflow\b/iu,
  /\bflowchart\b/iu,
  /\binfographic\b/iu,
  /\bwireframe\b/iu,
  /\bui\b/iu,
  /\bux\b/iu,
  /海报/u,
  /文字/u,
  /文案/u,
  /标签/u,
  /标题/u,
  /箭头/u,
  /表格/u,
  /\btext\b/iu,
  /\blabel\b/iu,
  /\btitle\b/iu,
  /\bposter\b/iu,
];

const WAN_PRIORITY_PATTERNS = [
  /写实/u,
  /摄影/u,
  /照片/u,
  /人像/u,
  /棚拍/u,
  /电影感/u,
  /镜头/u,
  /景深/u,
  /胶片/u,
  /光影/u,
  /商品图/u,
  /写真人像/u,
  /\bphoto\b/iu,
  /\bphotography\b/iu,
  /\bphotoreal/i,
  /\brealistic\b/iu,
  /\bcinematic\b/iu,
  /\bportrait\b/iu,
  /\bproduct shot\b/iu,
];

const LANDSCAPE_PATTERNS = [
  /架构图/u,
  /流程图/u,
  /拓扑/u,
  /时序图/u,
  /横版/u,
  /宽屏/u,
  /\b16:9\b/iu,
  /\blandscape\b/iu,
  /\bbanner\b/iu,
  /\bheader\b/iu,
];

const PORTRAIT_PATTERNS = [
  /竖版/u,
  /手机壁纸/u,
  /封面/u,
  /海报/u,
  /\b9:16\b/iu,
  /\bportrait\b/iu,
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textResult(text, details) {
  return {
    content: [{ type: "text", text }],
    ...(details !== undefined ? { details } : {}),
  };
}

function errorResult(message, extra = {}) {
  return textResult(JSON.stringify({ error: message, ...extra }, null, 2), {
    error: message,
    ...extra,
  });
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeImageList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function isRemoteImageRef(value) {
  return /^https?:\/\//i.test(value) || /^oss:\/\//i.test(value);
}

function toAbsoluteEndpoint(baseUrl, endpoint) {
  const normalizedEndpoint = normalizeString(endpoint) || DEFAULT_QWEN_ENDPOINT_PATH;
  if (/^https?:\/\//i.test(normalizedEndpoint)) {
    return normalizedEndpoint;
  }

  const normalizedBase = normalizeString(baseUrl);
  if (!normalizedBase) {
    throw new Error("Configured provider is missing baseUrl.");
  }

  const root = normalizedBase.replace(/\/+$/, "");
  const suffix = normalizedEndpoint.startsWith("/") ? normalizedEndpoint : `/${normalizedEndpoint}`;
  if (/\/services\/aigc\/multimodal-generation\/generation$/u.test(root)) {
    return root;
  }
  return `${root}${suffix}`;
}

function patternMatched(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeModelFamily(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized.includes("qwen")) {
    return "qwen";
  }
  if (normalized.includes("wan")) {
    return "wan";
  }
  return "";
}

function normalizeAspect(value, fallback = "square") {
  const normalized = normalizeString(value, fallback).toLowerCase();
  return ASPECTS.has(normalized) ? normalized : fallback;
}

function parseImageSize(size) {
  const match = normalizeString(size).match(/^(\d+)\s*[x*]\s*(\d+)$/i);
  if (!match) {
    return null;
  }
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function isWanGenerateSizeCompatible(size) {
  const parsed = parseImageSize(size);
  if (!parsed) {
    return true;
  }
  return parsed.width * parsed.height <= WAN_GENERATE_MAX_PIXELS;
}

function resolveAspect(prompt, requestedAspect, fallbackAspect = "square") {
  if (normalizeString(requestedAspect)) {
    return normalizeAspect(requestedAspect, fallbackAspect);
  }
  if (patternMatched(LANDSCAPE_PATTERNS, prompt)) {
    return "landscape";
  }
  if (patternMatched(PORTRAIT_PATTERNS, prompt)) {
    return "portrait";
  }
  return fallbackAspect;
}

function resolveDefaultSize(pluginConfig, family, aspect) {
  const familyDefaults = pluginConfig?.defaults?.[family];
  const requestedAspect = normalizeAspect(aspect, pluginConfig?.defaults?.aspect ?? "square");
  if (familyDefaults?.[requestedAspect]) {
    return familyDefaults[requestedAspect];
  }
  return pluginConfig?.defaults?.size ?? "1024*1024";
}

function resolveRouteFamily({ input, prompt, action, pluginConfig }) {
  const explicit = normalizeModelFamily(input?.model_preference ?? input?.modelPreference);
  if (explicit) {
    return explicit;
  }

  const configured = normalizeModelFamily(pluginConfig?.route);
  if (configured) {
    return configured;
  }

  const sourceFamily = normalizeModelFamily(input?.source_model ?? input?.sourceModel);
  const qwenPreferred = patternMatched(QWEN_PRIORITY_PATTERNS, prompt);
  const wanPreferred = patternMatched(WAN_PRIORITY_PATTERNS, prompt);

  if (qwenPreferred && !wanPreferred) {
    return "qwen";
  }
  if (wanPreferred && !qwenPreferred) {
    return "wan";
  }
  if (action === "edit" && sourceFamily) {
    return sourceFamily;
  }
  return "qwen";
}

function getProviderConfig(openclawConfig, providerAlias) {
  const providers = openclawConfig?.models?.providers;
  if (!isPlainObject(providers)) {
    throw new Error("OpenClaw models.providers is not configured.");
  }

  const provider = providers[providerAlias];
  if (!isPlainObject(provider)) {
    throw new Error(`OpenClaw provider "${providerAlias}" is not configured.`);
  }

  const apiKey = normalizeString(provider.apiKey);
  if (!apiKey) {
    throw new Error(`OpenClaw provider "${providerAlias}" is missing apiKey.`);
  }

  const headers = {};
  if (isPlainObject(provider.headers)) {
    for (const [key, value] of Object.entries(provider.headers)) {
      if (typeof value === "string" && value.trim()) {
        headers[key] = value;
      }
    }
  }

  return {
    baseUrl: normalizeString(provider.baseUrl),
    apiKey,
    headers,
    authHeader: provider.authHeader !== false,
  };
}

function assertWithinWorkspace(workspaceDir, filePath) {
  const workspaceRoot = resolve(workspaceDir);
  const absolutePath = resolve(filePath);
  const rel = relative(workspaceRoot, absolutePath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return absolutePath;
  }
  throw new Error(`Local image path escapes workspace: ${filePath}`);
}

function resolveWorkspacePath(source, workspaceDir) {
  const trimmed = normalizeString(source);
  if (!trimmed) {
    throw new Error("Image path is empty.");
  }
  if (!workspaceDir) {
    throw new Error("Local image paths require an agent workspace.");
  }

  if (trimmed.startsWith("file://")) {
    return assertWithinWorkspace(workspaceDir, fileURLToPath(trimmed));
  }

  if (trimmed === "/workspace") {
    return resolve(workspaceDir);
  }

  if (trimmed.startsWith("/workspace/")) {
    return assertWithinWorkspace(workspaceDir, resolve(workspaceDir, `.${trimmed.slice("/workspace".length)}`));
  }

  if (isAbsolute(trimmed)) {
    return assertWithinWorkspace(workspaceDir, trimmed);
  }

  return assertWithinWorkspace(workspaceDir, resolve(workspaceDir, trimmed));
}

async function normalizeInputImage(source, ctx) {
  if (isRemoteImageRef(source)) {
    return source;
  }

  const workspaceDir = normalizeString(ctx.workspaceDir);
  const resolvedPath = resolveWorkspacePath(source, workspaceDir);
  const loaded = await loadOutboundMediaFromUrl(resolvedPath, {
    maxBytes: MAX_INPUT_IMAGE_BYTES,
    mediaLocalRoots: [workspaceDir],
    includeDefaultMediaLocalRoots: false,
  });
  const contentType = normalizeString(loaded.contentType);
  if (!contentType.startsWith("image/")) {
    throw new Error(`Local file is not an image: ${source}`);
  }
  return `data:${contentType};base64,${loaded.buffer.toString("base64")}`;
}

function buildQwenRequestBody(params) {
  const content = [];
  for (const image of params.images) {
    content.push({ image });
  }
  content.push({ text: params.prompt });

  const body = {
    model: params.model,
    input: {
      messages: [
        {
          role: "user",
          content,
        },
      ],
    },
    parameters: {
      n: params.n,
      prompt_extend: params.promptExtend,
      watermark: params.watermark,
      size: params.size,
    },
  };

  if (params.negativePrompt) {
    body.parameters.negative_prompt = params.negativePrompt;
  }
  if (Number.isInteger(params.seed) && params.seed >= 0) {
    body.parameters.seed = params.seed;
  }

  return body;
}

function buildWanRequestBody(params) {
  const content = [];
  for (const image of params.images) {
    content.push({ image });
  }
  content.push({ text: params.prompt });

  const body = {
    model: params.model,
    input: {
      messages: [
        {
          role: "user",
          content,
        },
      ],
    },
    parameters: {
      size: params.size,
      watermark: params.watermark,
    },
  };

  if (params.action === "generate") {
    body.parameters.enable_interleave = true;
    body.parameters.max_images = params.n;
  } else {
    body.parameters.n = params.n;
    body.parameters.prompt_extend = params.promptExtend;
  }

  if (params.negativePrompt) {
    body.parameters.negative_prompt = params.negativePrompt;
  }
  if (Number.isInteger(params.seed) && params.seed >= 0) {
    body.parameters.seed = params.seed;
  }

  return body;
}

function extractImageUrls(payload) {
  const results = [];
  const contents = payload?.output?.choices?.[0]?.message?.content;
  if (Array.isArray(contents)) {
    for (const item of contents) {
      if (typeof item?.image === "string" && item.image.trim()) {
        results.push(item.image.trim());
      }
    }
  }

  const legacyResults = payload?.output?.results;
  if (Array.isArray(legacyResults)) {
    for (const item of legacyResults) {
      if (typeof item?.url === "string" && item.url.trim()) {
        results.push(item.url.trim());
      } else if (typeof item?.image === "string" && item.image.trim()) {
        results.push(item.image.trim());
      }
    }
  }

  return [...new Set(results)];
}

async function callDashScope(params, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this runtime.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);
  const headers = {
    "Content-Type": "application/json",
    ...params.headers,
  };
  if (params.authHeader && !headers.Authorization) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }

  try {
    const response = await fetchImpl(params.url, {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    const rawText = await response.text();
    const payload = rawText ? JSON.parse(rawText) : {};
    if (!response.ok) {
      throw new Error(
        payload?.message ||
          payload?.error ||
          `DashScope request failed: ${response.status} ${response.statusText}`,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`DashScope image request timed out after ${params.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function pollDashScopeTask(params, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this runtime.");
  }

  const headers = {
    ...params.headers,
  };
  if (params.authHeader && !headers.Authorization) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }

  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > params.timeoutMs) {
      throw new Error(`DashScope task timed out after ${params.timeoutMs}ms`);
    }

    const response = await fetchImpl(params.url, {
      method: "GET",
      headers,
    });
    const rawText = await response.text();
    const payload = rawText ? JSON.parse(rawText) : {};
    if (!response.ok) {
      throw new Error(
        payload?.message ||
          payload?.error ||
          `DashScope task poll failed: ${response.status} ${response.statusText}`,
      );
    }

    const status = normalizeString(payload?.output?.task_status ?? payload?.task_status).toUpperCase();
    if (status === "SUCCEEDED") {
      return payload;
    }
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(payload?.output?.message || payload?.message || `DashScope task ${status.toLowerCase()}.`);
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, params.intervalMs));
  }
}

async function callWanAsync(params, deps = {}) {
  const createPayload = await callDashScope(
    {
      url: params.url,
      apiKey: params.apiKey,
      headers: {
        ...params.headers,
        "X-DashScope-Async": "enable",
      },
      authHeader: params.authHeader,
      timeoutMs: params.timeoutMs,
      body: params.body,
    },
    deps,
  );

  const taskId = normalizeString(
    createPayload?.output?.task_id ?? createPayload?.task_id ?? createPayload?.output?.id ?? createPayload?.id,
  );
  if (!taskId) {
    throw new Error("DashScope async response did not include task_id.");
  }

  const taskUrl = toAbsoluteEndpoint(params.baseUrl, params.taskEndpoint.replace("{task_id}", taskId));
  return pollDashScopeTask(
    {
      url: taskUrl,
      apiKey: params.apiKey,
      headers: params.headers,
      authHeader: params.authHeader,
      timeoutMs: params.timeoutMs,
      intervalMs: 1500,
    },
    deps,
  );
}

async function executeImageStudio(input, ctx, pluginConfig, deps = {}) {
  const action = normalizeString(input?.action).toLowerCase();
  if (!ACTIONS.has(action)) {
    return errorResult('action must be "generate" or "edit".', { action });
  }

  const prompt = normalizeString(input?.prompt);
  if (!prompt) {
    return errorResult("prompt is required.");
  }

  const images = normalizeImageList(input?.images);
  if (action === "edit" && images.length === 0) {
    return errorResult("images is required for edit.");
  }

  let family = resolveRouteFamily({ input, prompt, action, pluginConfig });
  const aspect = resolveAspect(prompt, input?.aspect ?? input?.layout, pluginConfig.defaults.aspect);
  const n = Math.max(1, Math.min(MAX_OUTPUT_IMAGES, Math.trunc(Number(input?.n ?? pluginConfig.defaults.n) || 1)));
  const requestedSize = normalizeString(input?.size);
  if (!requestedSize && family === "wan" && action === "generate") {
    family = "wan";
  }
  if (!requestedSize && !MODEL_FAMILIES.has(family)) {
    family = "qwen";
  }
  if (family === "wan" && action === "generate" && requestedSize && !isWanGenerateSizeCompatible(requestedSize)) {
    const explicitFamily = normalizeModelFamily(input?.model_preference ?? input?.modelPreference);
    if (explicitFamily === "wan") {
      return errorResult(`size ${requestedSize} exceeds wan2.6-image generate limits; choose a smaller size or use qwen.`, {
        action,
        modelFamily: family,
      });
    }
    family = "qwen";
  }

  const size = requestedSize || resolveDefaultSize(pluginConfig, family, aspect);
  const watermark =
    typeof input?.watermark === "boolean" ? input.watermark : pluginConfig.defaults.watermark;
  const promptExtend =
    typeof input?.prompt_extend === "boolean"
      ? input.prompt_extend
      : typeof input?.promptExtend === "boolean"
        ? input.promptExtend
        : pluginConfig.defaults.promptExtend;
  const negativePrompt = normalizeString(input?.negative_prompt ?? input?.negativePrompt);
  const seed = Number.isInteger(input?.seed) ? input.seed : undefined;
  const model = action === "edit" ? pluginConfig.models[family].edit : pluginConfig.models[family].generate;

  try {
    const openclawConfig = ctx.config;
    const provider = getProviderConfig(openclawConfig, pluginConfig.provider);
    const normalizedImages = [];
    for (const image of images) {
      normalizedImages.push(await normalizeInputImage(image, ctx));
    }

    const bodyBuilder = family === "wan" ? buildWanRequestBody : buildQwenRequestBody;
    const body = bodyBuilder({
      action,
      model,
      prompt,
      images: normalizedImages,
      n,
      size,
      watermark,
      promptExtend,
      negativePrompt,
      seed,
    });
    const endpoint = family === "wan" ? pluginConfig.endpoints.wan : pluginConfig.endpoints.qwen;
    const url = toAbsoluteEndpoint(provider.baseUrl, endpoint);
    logger.info(`[image_studio] invoking ${action} with model=${model} family=${family} provider=${pluginConfig.provider}`);
    const response =
      family === "wan"
        ? await callWanAsync(
            {
              url,
              baseUrl: provider.baseUrl,
              taskEndpoint: pluginConfig.endpoints.task || DEFAULT_WAN_TASK_ENDPOINT,
              apiKey: provider.apiKey,
              headers: provider.headers,
              authHeader: provider.authHeader,
              timeoutMs: pluginConfig.timeoutMs,
              body,
            },
            deps,
          )
        : await callDashScope(
            {
              url,
              apiKey: provider.apiKey,
              headers: provider.headers,
              authHeader: provider.authHeader,
              timeoutMs: pluginConfig.timeoutMs,
              body,
            },
            deps,
          );
    const mediaUrls = extractImageUrls(response);
    if (mediaUrls.length === 0) {
      return errorResult("DashScope response did not include image URLs.", {
        action,
        model,
        modelFamily: family,
        provider: pluginConfig.provider,
        response,
      });
    }

    const lines = [`Generated ${mediaUrls.length} image(s) with ${model}.`];
    for (const mediaUrl of mediaUrls) {
      lines.push(`MEDIA:${mediaUrl}`);
    }

    return textResult(lines.join("\n"), {
      action,
      model,
      modelFamily: family,
      aspect,
      size,
      provider: pluginConfig.provider,
      mediaUrls,
      response,
    });
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error), {
      action,
      model,
      modelFamily: family,
      provider: pluginConfig.provider,
    });
  }
}

export function createImageStudioTool(pluginConfig, deps = {}) {
  return (ctx) => ({
    name: "image_studio",
    label: "Qwen Image Studio",
    description: "Generate or edit images with DashScope Qwen and Wan image models.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["generate", "edit"],
          description: "Whether to generate a new image or edit existing image inputs.",
        },
        prompt: {
          type: "string",
          description: "Instruction describing the desired image or edit.",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "Input image URLs or workspace-local image paths. Required for edit.",
        },
        aspect: {
          type: "string",
          enum: ["landscape", "square", "portrait"],
          description: "Preferred output framing when size is omitted.",
        },
        size: {
          type: "string",
          description: 'Target output size, for example "1024*1024".',
        },
        model_preference: {
          type: "string",
          enum: ["auto", "qwen", "wan"],
          description: "Optional routing override. qwen is best for text-heavy diagrams, wan for photorealism.",
        },
        source_model: {
          type: "string",
          description: "Optional source image model hint such as qwen-image-2.0-pro or wan2.6-image.",
        },
        n: {
          type: "integer",
          minimum: 1,
          maximum: MAX_OUTPUT_IMAGES,
          description: "Number of images to generate.",
        },
        negative_prompt: {
          type: "string",
          description: "Optional negative prompt.",
        },
        seed: {
          type: "integer",
          minimum: 0,
          description: "Optional random seed.",
        },
        watermark: {
          type: "boolean",
          description: "Whether to keep DashScope watermark enabled.",
        },
        prompt_extend: {
          type: "boolean",
          description: "Whether DashScope may automatically expand the prompt.",
        },
      },
      required: ["action", "prompt"],
      additionalProperties: false,
    },
    async execute(_toolCallId, input) {
      return executeImageStudio(input, ctx, pluginConfig, deps);
    },
  });
}

export const imageStudioToolTesting = {
  executeImageStudio,
  buildQwenRequestBody,
  buildWanRequestBody,
  extractImageUrls,
  toAbsoluteEndpoint,
  normalizeInputImage,
  resolveRouteFamily,
  resolveAspect,
  resolveDefaultSize,
  isWanGenerateSizeCompatible,
};
