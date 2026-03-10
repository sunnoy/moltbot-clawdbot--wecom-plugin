import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { prepareImageBufferForMsgItem } from "../image-processor.js";

describe("prepareImageBufferForMsgItem", () => {
  it("encodes a PNG buffer into msg_item fields", () => {
    const buffer = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("openclaw-wecom"),
    ]);

    const result = prepareImageBufferForMsgItem(buffer);

    assert.equal(result.format, "PNG");
    assert.equal(result.size, buffer.length);
    assert.equal(result.base64, buffer.toString("base64"));
    assert.equal(result.md5, createHash("md5").update(buffer).digest("hex"));
  });
});
