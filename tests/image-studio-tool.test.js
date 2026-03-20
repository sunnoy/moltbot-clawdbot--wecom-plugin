import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import plugin from "../index.js";
import { createImageStudioTool, imageStudioToolTesting } from "../wecom/image-studio-tool.js";
import { resolveQwenImageToolsConfig } from "../wecom/plugin-config.js";

function createTestPluginApi(input = {}) {
  return {
    id: "wecom",
    name: "wecom",
    source: "/fake/wecom",
    config: {},
    pluginConfig: {},
    runtime: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    registerContextEngine() {},
    resolvePath(value) {
      return value;
    },
    on() {},
    ...input,
  };
}

describe("image_studio tool", () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      }),
    );
    tempDirs.length = 0;
  });

  it("registers image_studio only when enabled", () => {
    const registeredNames = [];
    const api = createTestPluginApi({
      pluginConfig: {
        qwenImageTools: {
          enabled: true,
        },
      },
      registerTool(_tool, opts) {
        registeredNames.push(opts?.name ?? "");
      },
    });

    plugin.register(api);

    assert.deepEqual(registeredNames, ["wecom_mcp", "image_studio"]);
  });

  it("builds a generate request using provider config from openclaw.json", async () => {
    const config = resolveQwenImageToolsConfig({
      qwenImageTools: {
        enabled: true,
        provider: "dashscope",
        models: {
          qwen: {
            generate: "qwen-image-2.0-pro",
            edit: "qwen-image-2.0-pro",
          },
          wan: {
            generate: "wan2.6-image",
            edit: "wan2.6-image",
          },
        },
      },
    });
    const tool = createImageStudioTool(config, {
      async fetchImpl(url, options) {
        assert.equal(
          url,
          "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        );
        assert.equal(options.method, "POST");
        assert.equal(options.headers.Authorization, "Bearer sk-test");
        const body = JSON.parse(options.body);
        assert.equal(body.model, "qwen-image-2.0-pro");
        assert.deepEqual(body.input.messages[0].content, [{ text: "画一只橘猫宇航员" }]);
        assert.equal(body.parameters.n, 1);
        assert.equal(body.parameters.size, "1920*1080");

        return new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: "https://dashscope.example/output-1.png" }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    })({
      config: {
        models: {
          providers: {
            dashscope: {
              baseUrl: "https://dashscope.aliyuncs.com/api/v1",
              apiKey: "sk-test",
            },
          },
        },
      },
      workspaceDir: "/workspace",
    });

    const result = await tool.execute("tool-1", {
      action: "generate",
      prompt: "画一只橘猫宇航员",
    });

    assert.match(result.content[0].text, /MEDIA:https:\/\/dashscope\.example\/output-1\.png/);
    assert.equal(result.details.model, "qwen-image-2.0-pro");
    assert.equal(result.details.modelFamily, "qwen");
    assert.deepEqual(result.details.mediaUrls, ["https://dashscope.example/output-1.png"]);
  });

  it("routes text-heavy architecture prompts to qwen landscape defaults", async () => {
    const config = resolveQwenImageToolsConfig({
      qwenImageTools: {
        enabled: true,
        provider: "dashscope",
      },
    });

    const tool = createImageStudioTool(config, {
      async fetchImpl(url, options) {
        assert.equal(
          url,
          "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        );
        const body = JSON.parse(options.body);
        assert.equal(body.model, "qwen-image-2.0-pro");
        assert.equal(body.parameters.size, "1920*1080");
        return new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: "https://dashscope.example/http-arch.png" }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    })({
      config: {
        models: {
          providers: {
            dashscope: {
              baseUrl: "https://dashscope.aliyuncs.com/api/v1",
              apiKey: "sk-test",
            },
          },
        },
      },
      workspaceDir: "/workspace",
    });

    const result = await tool.execute("tool-arch", {
      action: "generate",
      prompt: "生成一张HTTP架构图，包含清晰中文标签和箭头",
    });

    assert.equal(result.details.modelFamily, "qwen");
    assert.equal(result.details.size, "1920*1080");
  });

  it("routes photorealistic generate requests to wan async workflow", async () => {
    const calls = [];
    const config = resolveQwenImageToolsConfig({
      qwenImageTools: {
        enabled: true,
        provider: "dashscope",
      },
    });

    const tool = createImageStudioTool(config, {
      async fetchImpl(url, options = {}) {
        calls.push({ url, options });
        if (options.method === "POST") {
          assert.equal(url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation");
          assert.equal(options.headers.Authorization, "Bearer sk-test");
          assert.equal(options.headers["X-DashScope-Async"], "enable");
          const body = JSON.parse(options.body);
          assert.equal(body.model, "wan2.6-image");
          assert.equal(body.parameters.enable_interleave, true);
          assert.equal(body.parameters.max_images, 2);
          assert.equal(body.parameters.size, "1280*720");
          return new Response(
            JSON.stringify({
              output: {
                task_id: "task-123",
                task_status: "PENDING",
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        assert.equal(url, "https://dashscope.aliyuncs.com/api/v1/tasks/task-123");
        return new Response(
          JSON.stringify({
            output: {
              task_status: "SUCCEEDED",
              choices: [
                {
                  message: {
                    content: [{ image: "https://dashscope.example/photo.png" }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    })({
      config: {
        models: {
          providers: {
            dashscope: {
              baseUrl: "https://dashscope.aliyuncs.com/api/v1",
              apiKey: "sk-test",
            },
          },
        },
      },
      workspaceDir: "/workspace",
    });

    const result = await tool.execute("tool-photo", {
      action: "generate",
      prompt: "拍一张写实摄影风格的咖啡馆人像照片",
      aspect: "landscape",
      n: 2,
    });

    assert.equal(calls.length, 2);
    assert.equal(result.details.modelFamily, "wan");
    assert.equal(result.details.model, "wan2.6-image");
    assert.equal(result.details.size, "1280*720");
  });

  it("encodes workspace-local edit input as data URI", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "image-studio-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "source.png");
    await writeFile(
      filePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const config = resolveQwenImageToolsConfig({
      qwenImageTools: {
        enabled: true,
        provider: "dashscope",
      },
    });

    let capturedBody = null;
    const tool = createImageStudioTool(config, {
      async fetchImpl(_url, options) {
        capturedBody = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: "https://dashscope.example/edited.png" }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    })({
      config: {
        models: {
          providers: {
            dashscope: {
              baseUrl: "https://dashscope.aliyuncs.com/api/v1",
              apiKey: "sk-test",
            },
          },
        },
      },
      workspaceDir: dir,
    });

    const result = await tool.execute("tool-2", {
      action: "edit",
      prompt: "给图片加上蓝色边框",
      images: ["/workspace/source.png"],
      n: 1,
    });

    assert.equal(capturedBody.input.messages[0].content.length, 2);
    assert.match(capturedBody.input.messages[0].content[0].image, /^data:image\/png;base64,/);
    assert.match(result.content[0].text, /MEDIA:https:\/\/dashscope\.example\/edited\.png/);
    assert.equal(result.details.modelFamily, "qwen");
  });

  it("keeps wan editing for photorealistic edits when source model is wan", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "image-studio-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "source.png");
    await writeFile(
      filePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const config = resolveQwenImageToolsConfig({
      qwenImageTools: {
        enabled: true,
        provider: "dashscope",
      },
    });

    const tool = createImageStudioTool(config, {
      async fetchImpl(url, options = {}) {
        if (options.method === "POST") {
          assert.equal(url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation");
          const body = JSON.parse(options.body);
          assert.equal(body.model, "wan2.6-image");
          assert.equal(body.parameters.n, 1);
          assert.equal(body.parameters.size, "1280*1280");
          assert.equal(body.parameters.enable_interleave, undefined);
          return new Response(
            JSON.stringify({
              output: {
                task_id: "task-edit-1",
                task_status: "RUNNING",
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        return new Response(
          JSON.stringify({
            output: {
              task_status: "SUCCEEDED",
              choices: [
                {
                  message: {
                    content: [{ image: "https://dashscope.example/wan-edited.png" }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    })({
      config: {
        models: {
          providers: {
            dashscope: {
              baseUrl: "https://dashscope.aliyuncs.com/api/v1",
              apiKey: "sk-test",
            },
          },
        },
      },
      workspaceDir: dir,
    });

    const result = await tool.execute("tool-edit-wan", {
      action: "edit",
      prompt: "保留写实摄影质感，稍微提亮背景",
      images: ["/workspace/source.png"],
      source_model: "wan2.6-image",
    });

    assert.equal(result.details.modelFamily, "wan");
  });

  it("falls back to qwen when wan generate size is too large under auto routing", async () => {
    const config = resolveQwenImageToolsConfig({
      qwenImageTools: {
        enabled: true,
        provider: "dashscope",
      },
    });

    const tool = createImageStudioTool(config, {
      async fetchImpl(url, options) {
        assert.equal(
          url,
          "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        );
        const body = JSON.parse(options.body);
        assert.equal(body.model, "qwen-image-2.0-pro");
        assert.equal(body.parameters.size, "1920*1080");
        return new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: "https://dashscope.example/fallback.png" }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    })({
      config: {
        models: {
          providers: {
            dashscope: {
              baseUrl: "https://dashscope.aliyuncs.com/api/v1",
              apiKey: "sk-test",
            },
          },
        },
      },
      workspaceDir: "/workspace",
    });

    const result = await tool.execute("tool-fallback", {
      action: "generate",
      prompt: "生成一张写实摄影风格的城市夜景",
      size: "1920*1080",
    });

    assert.equal(result.details.modelFamily, "qwen");
    assert.equal(result.details.model, "qwen-image-2.0-pro");
  });

  it("normalizes legacy output.results URLs", () => {
    const urls = imageStudioToolTesting.extractImageUrls({
      output: {
        results: [{ url: "https://dashscope.example/a.png" }, { image: "https://dashscope.example/b.png" }],
      },
    });

    assert.deepEqual(urls, ["https://dashscope.example/a.png", "https://dashscope.example/b.png"]);
  });
});
