import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractParentAgentId } from "../wecom/parent-resolver.js";

describe("extractParentAgentId", () => {
  it("extracts accountId from wecom-{account}-dm-{peer}", () => {
    assert.equal(extractParentAgentId("wecom-yoyo-dm-user123"), "yoyo");
  });

  it("extracts accountId from wecom-{account}-group-{peer}", () => {
    assert.equal(extractParentAgentId("wecom-yoyo-group-chat456"), "yoyo");
  });

  it("returns null for default account dm pattern", () => {
    assert.equal(extractParentAgentId("wecom-dm-user123"), null);
  });

  it("returns null for default account group pattern", () => {
    assert.equal(extractParentAgentId("wecom-group-chat456"), null);
  });

  it("handles multi-segment accountId", () => {
    assert.equal(extractParentAgentId("wecom-sales-team-dm-user123"), "sales-team");
  });

  it("returns null for non-wecom prefix", () => {
    assert.equal(extractParentAgentId("slack-dm-user123"), null);
  });

  it("returns null for plain accountId", () => {
    assert.equal(extractParentAgentId("yoyo"), null);
  });

  it("returns null for empty/null input", () => {
    assert.equal(extractParentAgentId(""), null);
    assert.equal(extractParentAgentId(null), null);
    assert.equal(extractParentAgentId(undefined), null);
  });

  it("normalizes to lowercase", () => {
    assert.equal(extractParentAgentId("WECOM-YoYo-DM-User123"), "yoyo");
  });

  it("returns null for wecom- prefix without dm/group segment", () => {
    assert.equal(extractParentAgentId("wecom-something"), null);
  });
});
