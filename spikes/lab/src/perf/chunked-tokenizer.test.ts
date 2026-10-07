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

  it("does not tokenize lines longer than the limit", () => {
    const tk = new ChunkedTokenizer(hl, "x".repeat(30_000), { ...OPTS, maxLineLength: 20_000 });
    const [line] = tk.tokens(0, 1);
    expect(line).toHaveLength(1);
    expect(line[0].content).toHaveLength(30_000);
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
