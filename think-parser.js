/**
 * Parse <think>...</think> tags from LLM output.
 *
 * Handles WeCom thinking tags in streamed LLM output:
 * - normalize tag variants to <think></think> for outbound WS content
 * - split visible/thinking text for analysis and tests
 * - ignore tags inside code blocks
 */

const QUICK_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought)\b/i;
const THINK_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought)\b[^<>]*>/gi;

/**
 * Find code regions (``` blocks and `inline`) to avoid processing think tags
 * that appear inside code.
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function findCodeRegions(text) {
  const regions = [];
  // Fenced code blocks (triple backtick).
  const blockRe = /```[\s\S]*?```/g;
  for (const m of text.matchAll(blockRe)) {
    regions.push([m.index, m.index + m[0].length]);
  }
  // Inline code (single backtick, same line).
  const inlineRe = /`[^`\n]+`/g;
  for (const m of text.matchAll(inlineRe)) {
    if (!isInsideRegion(m.index, regions)) {
      regions.push([m.index, m.index + m[0].length]);
    }
  }
  return regions;
}

/**
 * @param {number} pos
 * @param {Array<[number, number]>} regions
 */
function isInsideRegion(pos, regions) {
  for (const [start, end] of regions) {
    if (pos >= start && pos < end) return true;
  }
  return false;
}

/**
 * Normalize think tag variants to the canonical <think></think> form that
 * WeCom clients recognize, while leaving code blocks untouched.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeThinkingTags(text) {
  if (!text) {
    return "";
  }

  if (!QUICK_TAG_RE.test(text)) {
    return String(text);
  }

  const source = String(text);
  const codeRegions = findCodeRegions(source);
  const normalized = [];
  let lastIndex = 0;

  THINK_TAG_RE.lastIndex = 0;
  for (const match of source.matchAll(THINK_TAG_RE)) {
    const idx = match.index;
    if (isInsideRegion(idx, codeRegions)) {
      continue;
    }

    normalized.push(source.slice(lastIndex, idx));
    normalized.push(match[1] === "/" ? "</think>" : "<think>");
    lastIndex = idx + match[0].length;
  }

  normalized.push(source.slice(lastIndex));
  return normalized.join("");
}

/**
 * Parse thinking content from text that may contain <think>...</think> tags.
 *
 * @param {string} text - Raw accumulated stream text
 * @returns {{ visibleContent: string, thinkingContent: string, isThinking: boolean }}
 *   - visibleContent: text with think blocks removed
 *   - thinkingContent: concatenated thinking text
 *   - isThinking: true when an unclosed <think> tag is present (streaming)
 */
export function parseThinkingContent(text) {
  if (!text) {
    return { visibleContent: "", thinkingContent: "", isThinking: false };
  }

  const source = String(text);

  // Fast path: no think tags at all.
  if (!QUICK_TAG_RE.test(source)) {
    return { visibleContent: source, thinkingContent: "", isThinking: false };
  }

  const codeRegions = findCodeRegions(source);

  const visibleParts = [];
  const thinkingParts = [];
  let lastIndex = 0;
  let inThinking = false;

  THINK_TAG_RE.lastIndex = 0;
  for (const match of source.matchAll(THINK_TAG_RE)) {
    const idx = match.index;
    const isClose = match[1] === "/";

    // Skip tags inside code blocks.
    if (isInsideRegion(idx, codeRegions)) {
      continue;
    }

    const segment = source.slice(lastIndex, idx);

    if (!inThinking) {
      if (!isClose) {
        // Opening <think>: preceding text is visible.
        visibleParts.push(segment);
        inThinking = true;
      } else {
        // Stray </think> without opening: treat as visible text.
        visibleParts.push(segment);
      }
    } else {
      if (isClose) {
        // Closing </think>: text since opening is thinking content.
        thinkingParts.push(segment);
        inThinking = false;
      }
      // Nested or duplicate opening tag inside thinking: ignore.
    }

    lastIndex = idx + match[0].length;
  }

  // Remaining text after the last tag.
  const remaining = source.slice(lastIndex);
  if (inThinking) {
    // Unclosed <think>: remaining text is part of thinking (streaming state).
    thinkingParts.push(remaining);
  } else {
    visibleParts.push(remaining);
  }

  return {
    visibleContent: visibleParts.join("").trim(),
    thinkingContent: thinkingParts.join("\n").trim(),
    isThinking: inThinking,
  };
}
