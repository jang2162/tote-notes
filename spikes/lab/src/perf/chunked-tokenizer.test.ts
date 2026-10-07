import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { beforeAll, describe, expect, it } from "vitest";

import { ChunkedTokenizer } from "./chunked-tokenizer";

let hl: HighlighterCore;

beforeAll(async () => {
  hl = await createHighlighterCore({
    themes: [import("@shikijs/themes/github-dark")],
    langs: [import("@shikijs/langs/typescript")],
    engine: createJavaScriptRegexEngine(),
  });
});

const OPTS = { lang: "typescript", theme: "github-dark", chunkLines: 2 };
// With chunkLines 2 the comment opens in chunk 0 (line 1) and continues into chunk 1 (lines 2-3).
const DOC = ["const a = 1;", "/* start", "still comment", "end */", "const b = 2;"].join("\n");

function firstColor(tk: ChunkedTokenizer, line: number): string | undefined {
  return tk.tokens(line, line + 1)[0][0].color;
}

describe("ChunkedTokenizer", () => {
  it("keeps a block comment's color across a chunk boundary", () => {
    const tk = new ChunkedTokenizer(hl, DOC, OPTS);
    const commentColor = firstColor(tk, 1);
    expect(firstColor(tk, 2)).toBe(commentColor);
    expect(firstColor(tk, 4)).not.toBe(commentColor);
  });

  it("recomputes later chunks after an edit removes the comment opener", () => {
    const tk = new ChunkedTokenizer(hl, DOC, OPTS);
    const commentColor = firstColor(tk, 1);
    expect(firstColor(tk, 2)).toBe(commentColor);
    tk.edit(1, 2, ["// line comment"]);
    expect(firstColor(tk, 2)).not.toBe(commentColor);
  });

  it("recomputes later chunks after an edit that changes the line count", () => {
    const tk = new ChunkedTokenizer(hl, DOC, OPTS);
    const commentColor = firstColor(tk, 1);
    // Line 4 is code before the edit; caching its chunk state makes a stale state observable.
    expect(firstColor(tk, 4)).not.toBe(commentColor);
    tk.edit(1, 2, ["a", "/* x", "y"]);
    expect(tk.lineCount).toBe(7);
    expect(firstColor(tk, 1)).not.toBe(commentColor);
    expect(firstColor(tk, 4)).toBe(commentColor);
    expect(firstColor(tk, 6)).not.toBe(commentColor);
  });

  it("keeps cached states of chunks before the edited one", () => {
    const tk = new ChunkedTokenizer(hl, DOC, OPTS);
    tk.tokens(4, 5);
    expect(tk.cachedChunkCount).toBe(3);
    tk.edit(4, 5, ["const c = 3;"]);
    expect(tk.cachedChunkCount).toBe(3);
    tk.edit(2, 3, ["still"]);
    expect(tk.cachedChunkCount).toBe(2);
  });

  it("does not tokenize lines longer than the limit", () => {
    // Splits into many tokens when tokenized, so a single token can only mean it was skipped.
    const text = "a + 1; ".repeat(4_000);
    const unlimited = new ChunkedTokenizer(hl, text, { ...OPTS, maxLineLength: 0 });
    expect(unlimited.tokens(0, 1)[0].length).toBeGreaterThan(1);

    const tk = new ChunkedTokenizer(hl, text, { ...OPTS, maxLineLength: 20_000 });
    const [line] = tk.tokens(0, 1);
    expect(line).toHaveLength(1);
    expect(line[0].content).toHaveLength(28_000);
    expect(line[0].color).toBeUndefined();
  });

  it("tokenizes lines up to the limit and skips only longer ones", () => {
    const tokensFor = (length: number) => {
      const text = "a + 1; ".repeat(3_000).slice(0, length);
      return new ChunkedTokenizer(hl, text, { ...OPTS, maxLineLength: 20_000 }).tokens(0, 1)[0];
    };
    for (const length of [19_999, 20_000]) {
      const line = tokensFor(length);
      expect(line.length).toBeGreaterThan(1);
      expect(line.every((t) => t.color !== undefined)).toBe(true);
    }
    const skipped = tokensFor(20_001);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].color).toBeUndefined();
  });

  it("passes the per-line time limit to shiki, where 0 lifts it", () => {
    // No length limit, so only the time limit can cut this line short.
    const text = "a + 1; ".repeat(10_000);
    const count = (timeLimit: number) =>
      new ChunkedTokenizer(hl, text, { ...OPTS, maxLineLength: 0, timeLimit }).tokens(0, 1)[0]
        .length;
    expect(count(1)).toBeLessThan(count(0));
  });

  it("reports offsets relative to the line start", () => {
    const tk = new ChunkedTokenizer(hl, "x\nconst value = 42;", OPTS);
    const [line] = tk.tokens(1, 2);
    let expected = 0;
    for (const t of line) {
      expect(t.offset).toBe(expected);
      expected += t.content.length;
    }
    expect(expected).toBe("const value = 42;".length);
  });
});
