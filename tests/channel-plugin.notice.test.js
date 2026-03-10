import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wecomChannelPluginTesting } from "../wecom/channel-plugin.js";

describe("buildUnsupportedMediaNotice", () => {
  it("uses the file delivery notice expected for agent fallback", () => {
    assert.equal(
      wecomChannelPluginTesting.buildUnsupportedMediaNotice({
        text: "附件如下",
        mediaType: "file",
        deliveredViaAgent: true,
      }),
      "附件如下\n\n由于当前企业微信bot不支持给用户发送文件，文件通过自建应用发送。",
    );
  });

  it("uses the image delivery notice expected for agent fallback", () => {
    assert.equal(
      wecomChannelPluginTesting.buildUnsupportedMediaNotice({
        text: "",
        mediaType: "image",
        deliveredViaAgent: true,
      }),
      "由于当前企业微信bot不支持直接发送图片，图片通过自建应用发送。",
    );
  });

  it("describes missing agent capability when no fallback is configured", () => {
    assert.equal(
      wecomChannelPluginTesting.buildUnsupportedMediaNotice({
        text: "附件如下",
        mediaType: "file",
        deliveredViaAgent: false,
      }),
      "附件如下\n\n由于当前企业微信bot不支持给用户发送文件，且当前未配置自建应用发送渠道。",
    );
  });
});
