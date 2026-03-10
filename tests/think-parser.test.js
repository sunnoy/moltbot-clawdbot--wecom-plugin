import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeThinkingTags, parseThinkingContent } from "../think-parser.js";

describe("parseThinkingContent", () => {
  it("returns empty for empty input", () => {
    const r = parseThinkingContent("");
    assert.equal(r.visibleContent, "");
    assert.equal(r.thinkingContent, "");
    assert.equal(r.isThinking, false);
  });

  it("returns text as-is when no think tags", () => {
    const text = "Hello **world**! This is markdown.";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, text);
    assert.equal(r.thinkingContent, "");
    assert.equal(r.isThinking, false);
  });

  it("extracts complete <think>...</think> block", () => {
    const text = "<think>Let me consider this...</think>Here is my answer.";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, "Here is my answer.");
    assert.equal(r.thinkingContent, "Let me consider this...");
    assert.equal(r.isThinking, false);
  });

  it("handles <thinking>...</thinking> variant", () => {
    const text = "<thinking>Analyzing the problem</thinking>\n\nThe result is 42.";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, "The result is 42.");
    assert.equal(r.thinkingContent, "Analyzing the problem");
    assert.equal(r.isThinking, false);
  });

  it("handles <thought>...</thought> variant", () => {
    const text = "<thought>Deep analysis</thought>Answer here.";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, "Answer here.");
    assert.equal(r.thinkingContent, "Deep analysis");
    assert.equal(r.isThinking, false);
  });

  it("handles streaming: unclosed <think> tag", () => {
    const text = "<think>I need to figure out";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, "");
    assert.equal(r.thinkingContent, "I need to figure out");
    assert.equal(r.isThinking, true);
  });

  it("handles text before unclosed <think> tag", () => {
    const text = "Starting...\n<think>Processing this request";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, "Starting...");
    assert.equal(r.thinkingContent, "Processing this request");
    assert.equal(r.isThinking, true);
  });

  it("handles multiple think blocks", () => {
    const text =
      "<think>First thought</think>Part 1. <think>Second thought</think>Part 2.";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, "Part 1. Part 2.");
    assert.equal(r.thinkingContent, "First thought\nSecond thought");
    assert.equal(r.isThinking, false);
  });

  it("preserves markdown in visible content", () => {
    const text =
      "<think>Let me think</think>\n\n# Header\n\n- **bold** item\n- `code` item\n\n```js\nconsole.log('hi');\n```";
    const r = parseThinkingContent(text);
    assert.ok(r.visibleContent.includes("# Header"));
    assert.ok(r.visibleContent.includes("**bold**"));
    assert.ok(r.visibleContent.includes("```js"));
    assert.equal(r.thinkingContent, "Let me think");
  });

  it("ignores think tags inside fenced code blocks", () => {
    const text = "Look at this code:\n```\n<think>not a tag</think>\n```\nEnd.";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, text);
    assert.equal(r.thinkingContent, "");
    assert.equal(r.isThinking, false);
  });

  it("ignores think tags inside inline code", () => {
    const text = "Use `<think>` for reasoning display.";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, text);
    assert.equal(r.thinkingContent, "");
    assert.equal(r.isThinking, false);
  });

  it("handles stray closing tag gracefully", () => {
    const text = "Hello</think> world";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, "Hello world");
    assert.equal(r.thinkingContent, "");
    assert.equal(r.isThinking, false);
  });

  it("handles case-insensitive tags", () => {
    const text = "<Think>Reasoning</Think>Result.";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, "Result.");
    assert.equal(r.thinkingContent, "Reasoning");
  });

  it("handles whitespace in tags", () => {
    const text = "< think >Some thought</ think >Visible.";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, "Visible.");
    assert.equal(r.thinkingContent, "Some thought");
  });

  it("handles null input", () => {
    const r = parseThinkingContent(null);
    assert.equal(r.visibleContent, "");
    assert.equal(r.thinkingContent, "");
    assert.equal(r.isThinking, false);
  });

  it("handles multiline thinking content", () => {
    const text = `<think>
Step 1: Parse the input.
Step 2: Process.
Step 3: Return result.
</think>
The answer is **42**.`;
    const r = parseThinkingContent(text);
    assert.ok(r.thinkingContent.includes("Step 1:"));
    assert.ok(r.thinkingContent.includes("Step 3:"));
    assert.ok(r.visibleContent.includes("The answer is **42**."));
    assert.equal(r.isThinking, false);
  });

  it("returns just thinking placeholder as visible when content is plain text", () => {
    const text = "思考中...";
    const r = parseThinkingContent(text);
    assert.equal(r.visibleContent, "思考中...");
    assert.equal(r.thinkingContent, "");
    assert.equal(r.isThinking, false);
  });
});

describe("normalizeThinkingTags", () => {
  it("normalizes supported think tag variants", () => {
    const text = "<thinking>Step 1</thinking>\nDone\n<thought>Step 2</thought>";
    assert.equal(
      normalizeThinkingTags(text),
      "<think>Step 1</think>\nDone\n<think>Step 2</think>",
    );
  });

  it("keeps code regions unchanged", () => {
    const text = "```html\n<thinking>demo</thinking>\n```\n<thought>real</thought>";
    assert.equal(
      normalizeThinkingTags(text),
      "```html\n<thinking>demo</thinking>\n```\n<think>real</think>",
    );
  });
});
