import { describe, expect, it } from "vitest";

import type { ExtensionRegistry, LanguageInfo } from "../backend/types";
import { Registry } from "../extensions/registry";
import { colorCode, fenceLanguage, MAX_CODE_BLOCKS, MAX_CODE_CHARS, spansOf } from "./code-colors";

function language(id: string, aliases: string[], extensions: string[], grammar = true) {
  return {
    id,
    extension: "tote.languages",
    aliases,
    extensions,
    filenames: [],
    firstLine: null,
    configuration: null,
    grammar: grammar ? { scopeName: `source.${id}`, path: `${id}.json` } : null,
  } as LanguageInfo;
}

const registry = new Registry({
  extensions: [],
  languages: [
    language("typescript", ["TypeScript", "ts"], ["ts", "mts"]),
    language("python", ["Python", "py"], ["py"]),
    language("shellscript", ["Shell Script", "shell", "bash"], ["sh", "bash"]),
    language("plaintext", ["Plain Text", "text"], ["txt"], false),
  ],
  grammars: [],
  themes: [],
  viewers: [],
  problems: [],
} as unknown as ExtensionRegistry);

describe("fenceLanguage", () => {
  it("finds the language by id, then alias, then file extension, ignoring case", () => {
    expect(fenceLanguage(registry, "typescript")?.id).toBe("typescript");
    expect(fenceLanguage(registry, "TypeScript")?.id).toBe("typescript");
    expect(fenceLanguage(registry, "bash")?.id).toBe("shellscript");
    expect(fenceLanguage(registry, "Shell")?.id).toBe("shellscript");
    expect(fenceLanguage(registry, "mts")?.id).toBe("typescript");
    expect(fenceLanguage(registry, "PY")?.id).toBe("python");
  });

  it("finds nothing for a language it does not know or one with no grammar", () => {
    expect(fenceLanguage(registry, "cobol")).toBeUndefined();
    expect(fenceLanguage(registry, "text")).toBeUndefined();
    expect(fenceLanguage(registry, "")).toBeUndefined();
  });
});

describe("spansOf", () => {
  it("cuts each line at its tokens and names their colours and styles", () => {
    const lines = ["const a = 1;", "", "b"];
    const tokens = [
      Uint32Array.of(0, 1, 2, 5, 0, 0, 10, 2, 1),
      new Uint32Array(),
      Uint32Array.of(0, 3, 0),
    ];
    expect(spansOf(lines, tokens, ["#000000", "#0000ff", "#098658", "#ff0000"])).toEqual([
      [
        { text: "const", color: "#0000ff", fontStyle: 2 },
        { text: " a = ", color: "#000000", fontStyle: 0 },
        { text: "1;", color: "#098658", fontStyle: 1 },
      ],
      [],
      [{ text: "b", color: "#ff0000", fontStyle: 0 }],
    ]);
  });

  it("leaves a line the worker gave no tokens for whole and plain", () => {
    expect(spansOf(["긴 줄"], [new Uint32Array()], [])).toEqual([
      [{ text: "긴 줄", fontStyle: 0 }],
    ]);
    expect(spansOf(["x"], [], [])).toEqual([[{ text: "x", fontStyle: 0 }]]);
  });

  it("passes only hex colours: a theme's other strings go uncoloured", () => {
    const tokens = [Uint32Array.of(0, 0, 0, 1, 1, 0, 2, 2, 0, 3, 3, 0)];
    expect(spansOf(["abcd"], tokens, ["#abc", "red;x:y", "#12345678", "url(x)"])).toEqual([
      [
        { text: "a", color: "#abc", fontStyle: 0 },
        { text: "b", fontStyle: 0 },
        { text: "c", color: "#12345678", fontStyle: 0 },
        { text: "d", fontStyle: 0 },
      ],
    ]);
  });
});

/** A highlight client whose worker tokenizes every line as one token of colour 1. */
function fakeClient(colorMap = ["#000000", "#0000ff"]) {
  const opened: string[] = [];
  const closed: number[] = [];
  let next = 1;
  const texts = new Map<number, string>();
  return {
    opened,
    closed,
    colorMap,
    nextDocId: () => next++,
    open: async (doc: number, lang: LanguageInfo, text: () => string) => {
      opened.push(lang.id);
      texts.set(doc, text());
      return lang.id !== "python";
    },
    tokens: async (doc: number, from: number, to: number) =>
      texts
        .get(doc)!
        .split("\n")
        .slice(from, to)
        .map((line) => (line ? Uint32Array.of(0, 1, 0) : new Uint32Array())),
    close: (doc: number) => void closed.push(doc),
  };
}

describe("colorCode", () => {
  it("colours the blocks of known languages and closes every document it opened", async () => {
    const client = fakeClient();
    const result = await colorCode(client, registry, [
      { index: 0, lang: "ts", code: "let a;\n" },
      { index: 1, lang: "cobol", code: "MOVE A" },
      { index: 2, lang: "py", code: "x" },
      { index: 3, lang: "bash", code: "ls\necho" },
    ]);
    expect(result).toEqual([
      {
        index: 0,
        lines: [[{ text: "let a;", color: "#0000ff", fontStyle: 0 }], []],
      },
      {
        index: 3,
        lines: [
          [{ text: "ls", color: "#0000ff", fontStyle: 0 }],
          [{ text: "echo", color: "#0000ff", fontStyle: 0 }],
        ],
      },
    ]);
    expect(client.opened).toEqual(["typescript", "python", "shellscript"]);
    expect(client.closed).toEqual([1, 2, 3]);
  });

  it("sends no further block once the preview has drawn another text", async () => {
    const client = fakeClient();
    const blocks = [0, 1, 2].map((index) => ({ index, lang: "ts", code: "a" }));
    // Drawn anew while the first block was being coloured.
    const result = await colorCode(client, registry, blocks, () => client.opened.length > 0);
    expect(client.opened).toEqual(["typescript"]);
    expect(result.map((b) => b.index)).toEqual([0]);
    expect(client.closed).toEqual([1]);
  });

  it("stops at the block and character limits", async () => {
    const client = fakeClient();
    const many = Array.from({ length: MAX_CODE_BLOCKS + 5 }, (_, index) => ({
      index,
      lang: "ts",
      code: "a",
    }));
    expect(await colorCode(client, registry, many)).toHaveLength(MAX_CODE_BLOCKS);
    const big = [
      { index: 0, lang: "ts", code: "a".repeat(MAX_CODE_CHARS - 1) },
      { index: 1, lang: "ts", code: "bb" },
      { index: 2, lang: "ts", code: "c" },
    ];
    expect((await colorCode(fakeClient(), registry, big)).map((b) => b.index)).toEqual([0, 2]);
  });
});
