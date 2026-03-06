/**
 * Unit tests for image URL merging logic in inbound-processor.js
 *
 * Bug 1 (processInboundMessage ~line 320):
 *   Old: const allImageUrls = imageUrl ? [imageUrl] : imageUrls;
 *   Fix: const allImageUrls = [imageUrl, ...imageUrls].filter(Boolean);
 *   Scenario: merged message has both imageUrl AND imageUrls populated —
 *   old code discarded imageUrls entirely.
 *
 * Bug 2 (flushMessageBuffer ~line 54):
 *   Old: singleImages only promoted when !primaryMsg.imageUrl (always false
 *        for first message), so second pure-image message was lost.
 *   Fix: collect all single + multi URLs first, then assign to primaryMsg.
 *   Scenario: two consecutive single-image messages within the 2s debounce
 *   window — old code kept only the first image URL.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Bug 1: processInboundMessage — allImageUrls combination
// The fixed expression is: [imageUrl, ...imageUrls].filter(Boolean)
// ---------------------------------------------------------------------------
describe("Bug 1 — processInboundMessage: allImageUrls combination", () => {
  function buildAllImageUrls(imageUrl, imageUrls) {
    return [imageUrl, ...imageUrls].filter(Boolean);
  }

  it("returns imageUrl when only imageUrl is set", () => {
    assert.deepEqual(buildAllImageUrls("url1", []), ["url1"]);
  });

  it("returns imageUrls when only imageUrls is set", () => {
    assert.deepEqual(buildAllImageUrls("", ["url2", "url3"]), ["url2", "url3"]);
  });

  it("combines imageUrl and imageUrls when both are present (the main bug)", () => {
    // This is the scenario where Bug 1 manifested:
    // after debounce merge, primaryMsg has imageUrl = "url1" AND imageUrls = ["url2"].
    // Old code: imageUrl ? [imageUrl] : imageUrls  → only ["url1"], losing "url2".
    // Fixed code: [imageUrl, ...imageUrls].filter(Boolean) → ["url1", "url2"].
    assert.deepEqual(buildAllImageUrls("url1", ["url2"]), ["url1", "url2"]);
  });

  it("returns empty array when both are empty", () => {
    assert.deepEqual(buildAllImageUrls("", []), []);
  });
});

// ---------------------------------------------------------------------------
// Bug 2: flushMessageBuffer — image URL merge across buffered messages
// The fixed logic collects all imageUrl + imageUrls from every message,
// then places the first into primaryMsg.imageUrl and the rest into imageUrls.
// ---------------------------------------------------------------------------
describe("Bug 2 — flushMessageBuffer: merge image URLs from buffered messages", () => {
  /**
   * Pure recreation of the fixed merge block (lines 53-63 of inbound-processor.js).
   * We accept an array of message objects and return the resulting primaryMsg fields.
   */
  function simulateMerge(messages) {
    const primaryMsg = { ...messages[0] };

    if (messages.length > 1) {
      const allSingleImageUrls = messages.map((m) => m.imageUrl).filter(Boolean);
      const allMultiImageUrls = messages.flatMap((m) => m.imageUrls || []);
      const mergedImageUrls = [...allSingleImageUrls, ...allMultiImageUrls];
      if (mergedImageUrls.length > 0) {
        primaryMsg.imageUrl = mergedImageUrls[0];
        if (mergedImageUrls.length > 1) {
          primaryMsg.imageUrls = mergedImageUrls.slice(1);
        }
      }
    }

    return primaryMsg;
  }

  it("preserves single image when only one message in buffer", () => {
    const result = simulateMerge([{ imageUrl: "url1", imageUrls: [] }]);
    assert.equal(result.imageUrl, "url1");
    assert.deepEqual(result.imageUrls, []);
  });

  it("merges two sequential single-image messages (the main bug)", () => {
    // User sends two images within the 2-second debounce window.
    // Old code: second imageUrl was lost because !primaryMsg.imageUrl was false.
    // Fixed: both imageUrls are collected.
    const result = simulateMerge([
      { imageUrl: "url1", imageUrls: [] },
      { imageUrl: "url2", imageUrls: [] },
    ]);
    assert.equal(result.imageUrl, "url1");
    assert.deepEqual(result.imageUrls, ["url2"]);
  });

  it("merges three sequential single-image messages", () => {
    const result = simulateMerge([
      { imageUrl: "url1", imageUrls: [] },
      { imageUrl: "url2", imageUrls: [] },
      { imageUrl: "url3", imageUrls: [] },
    ]);
    assert.equal(result.imageUrl, "url1");
    assert.deepEqual(result.imageUrls, ["url2", "url3"]);
  });

  it("merges single-image message followed by multi-image message", () => {
    const result = simulateMerge([
      { imageUrl: "url1", imageUrls: [] },
      { imageUrl: null, imageUrls: ["url2", "url3"] },
    ]);
    assert.equal(result.imageUrl, "url1");
    assert.deepEqual(result.imageUrls, ["url2", "url3"]);
  });

  it("merges multi-image message followed by single-image message", () => {
    const result = simulateMerge([
      { imageUrl: null, imageUrls: ["url1", "url2"] },
      { imageUrl: "url3", imageUrls: [] },
    ]);
    // Single images are collected first, then multi — but first message has no
    // single imageUrl; second has "url3". Multi from first: ["url1", "url2"].
    assert.equal(result.imageUrl, "url3");
    assert.deepEqual(result.imageUrls, ["url1", "url2"]);
  });

  it("handles messages with no images gracefully", () => {
    const result = simulateMerge([
      { imageUrl: null, imageUrls: [], content: "hello" },
      { imageUrl: null, imageUrls: [], content: "world" },
    ]);
    assert.equal(result.imageUrl, null);
    assert.deepEqual(result.imageUrls, []);
  });
});
