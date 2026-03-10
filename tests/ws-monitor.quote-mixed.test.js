import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wsMonitorTesting } from "../wecom/ws-monitor.js";

describe("parseMessageContent quote.mixed", () => {
  it("extracts quoted mixed text and images", () => {
    const result = wsMonitorTesting.parseMessageContent({
      msgtype: "text",
      text: { content: "新的问题" },
      quote: {
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "被引用的说明" } },
            { msgtype: "image", image: { url: "https://example.com/quoted.png", aeskey: "quoted-aes" } },
          ],
        },
      },
    });

    assert.deepEqual(result.textParts, ["新的问题"]);
    assert.equal(result.quoteContent, "被引用的说明");
    assert.deepEqual(result.imageUrls, ["https://example.com/quoted.png"]);
    assert.equal(result.imageAesKeys.get("https://example.com/quoted.png"), "quoted-aes");
  });

  it("uses a placeholder when quoted mixed content only contains images", () => {
    const result = wsMonitorTesting.parseMessageContent({
      msgtype: "text",
      text: { content: "看看这个" },
      quote: {
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "image", image: { url: "https://example.com/quoted-only-image.png", aeskey: "img-aes" } },
          ],
        },
      },
    });

    assert.equal(result.quoteContent, "[引用图文]");
    assert.deepEqual(result.imageUrls, ["https://example.com/quoted-only-image.png"]);
    assert.equal(result.imageAesKeys.get("https://example.com/quoted-only-image.png"), "img-aes");
  });
});
