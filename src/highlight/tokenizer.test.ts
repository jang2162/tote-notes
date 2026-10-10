import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import { Registry, type IGrammar, type IOnigLib, type IRawGrammar } from "@shikijs/vscode-textmate";
import { beforeAll, describe, expect, it } from "vitest";

import { LineTokenizer, MAX_TOKENIZED_LINE_LENGTH } from "./tokenizer";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/fixtures/vsix-src/extension/syntaxes/tote.tmLanguage.json",
);

let grammar: IGrammar;
let colorMap: string[];
// The registry's colour map spells colours in upper case.
const COMMENT = "#808080";
const KEYWORD = "#FF9966";
const STRING = "#CE9178";
const BASE = "#F0F0F0";

beforeAll(async () => {
  const engine = await createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined"));
  const onigLib: IOnigLib = {
    createOnigScanner: (sources) => engine.createScanner(sources),
    createOnigString: (s) => engine.createString(s),
  };
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as IRawGrammar;
  const registry = new Registry({
    onigLib,
    loadGrammar: (scope) => (scope === "source.tote" ? raw : null),
    theme: {
      settings: [
        { settings: { foreground: BASE } },
        { scope: "comment", settings: { foreground: COMMENT, fontStyle: "italic" } },
        { scope: "keyword", settings: { foreground: KEYWORD } },
        { scope: "string", settings: { foreground: STRING } },
      ],
    },
  });
  grammar = registry.loadGrammar("source.tote")!;
  colorMap = registry.getColorMap();
});

/** `[start, colour, italic?]` per token, colours resolved through the colour map. */
function decode(line: Uint32Array): [number, string, boolean][] {
  const out: [number, string, boolean][] = [];
  for (let i = 0; i < line.length; i += 3)
    out.push([line[i], colorMap[line[i + 1]], (line[i + 2] & 1) === 1]);
  return out;
}

describe("LineTokenizer", () => {
  it("colours keywords and comments and carries a string across lines", () => {
    const t = new LineTokenizer(grammar, 'let x = "multi\nline" # note\nfn');
    const lines = t.tokens(0, 3);
    expect(decode(lines[0])).toEqual([
      [0, KEYWORD, false],
      [3, BASE, false],
      [8, STRING, false],
    ]);
    // Line 2 starts inside the string the first line opened.
    expect(decode(lines[1])[0]).toEqual([0, STRING, false]);
    expect(decode(lines[1]).at(-1)).toEqual([6, COMMENT, true]);
    expect(decode(lines[2])).toEqual([[0, KEYWORD, false]]);
    expect(t.cachedLines).toBe(3);
  });

  it("tokenizes forward only as far as asked and keeps what it did", () => {
    const t = new LineTokenizer(
      grammar,
      Array.from({ length: 10 }, (_, i) => `fn f${i}`).join("\n"),
    );
    expect(t.cachedLines).toBe(0);
    t.tokens(4, 6);
    expect(t.cachedLines).toBe(6);
    t.tokens(2, 3); // already cached: nothing new
    expect(t.cachedLines).toBe(6);
  });

  it("an edit drops the cache from the edited line on, and only from there", () => {
    const t = new LineTokenizer(grammar, "let a\nlet b\nlet c\nlet d");
    t.tokens(0, 4);
    t.edit(2, 3, ["# now a comment", "let e"]);
    expect(t.lineCount).toBe(5);
    expect(t.cachedLines).toBe(2);
    const lines = t.tokens(0, 5);
    expect(decode(lines[2])[0][1]).toBe(COMMENT);
    expect(decode(lines[3])[0][1]).toBe(KEYWORD);
    expect(decode(lines[4])[0][1]).toBe(KEYWORD);
  });

  it("leaves a line over the limit without tokens and carries the state past it", () => {
    const long = "x".repeat(MAX_TOKENIZED_LINE_LENGTH + 1);
    const t = new LineTokenizer(grammar, `"open\n${long}\nstill string" fn`);
    const lines = t.tokens(0, 3);
    expect(lines[1].length).toBe(0);
    expect(decode(lines[2])[0][1]).toBe(STRING);
    expect(t.cachedLines).toBe(3);
  });

  it("advance works ahead in slices until the whole document is cached", () => {
    const t = new LineTokenizer(
      grammar,
      Array.from({ length: 300 }, () => "let x = 1 # c").join("\n"),
    );
    let done = false;
    let rounds = 0;
    while (!done && rounds < 1000) {
      done = t.advance(1);
      rounds++;
    }
    expect(done).toBe(true);
    expect(t.cachedLines).toBe(300);
    expect(t.advance(1)).toBe(true);
    t.reset();
    expect(t.cachedLines).toBe(0);
  });

  it("an empty document has one empty line, with one token at its start", () => {
    const t = new LineTokenizer(grammar, "");
    expect(t.lineCount).toBe(1);
    const lines = t.tokens(0, 1);
    expect(lines).toHaveLength(1);
    expect(decode(lines[0])).toEqual([[0, BASE, false]]);
  });
});
