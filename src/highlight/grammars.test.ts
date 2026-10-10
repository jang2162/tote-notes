import { describe, expect, it } from "vitest";

import type { ExtensionRegistry, LanguageInfo } from "../backend/types";
import { Registry } from "../extensions/registry";
import { collectGrammars, collectIncludes } from "./grammars";

describe("collectIncludes", () => {
  it("finds external scopes anywhere in the grammar and skips local references", () => {
    const grammar = {
      scopeName: "source.a",
      patterns: [
        { include: "#x" },
        { include: "$self" },
        { include: "source.b" },
        { include: "text.c#frag" },
      ],
      repository: {
        x: {
          patterns: [
            { include: "source.b" },
            { begin: "a", end: "b", patterns: [{ include: "source.d" }] },
          ],
        },
      },
    };
    expect(collectIncludes(grammar)).toEqual(["source.b", "text.c", "source.d"]);
  });
});

describe("collectGrammars", () => {
  const registry = new Registry({
    extensions: [],
    languages: [],
    grammars: [
      {
        extension: "e",
        language: "a",
        scopeName: "source.a",
        path: "a.json",
        embeddedLanguages: {},
      },
      {
        extension: "e",
        language: null,
        scopeName: "source.b",
        path: "b.json",
        embeddedLanguages: {},
      },
      {
        extension: "e",
        language: "c",
        scopeName: "source.c",
        path: "c.json",
        embeddedLanguages: {},
      },
    ],
    themes: [],
    viewers: [],
    problems: [],
  } as ExtensionRegistry);
  const lang: LanguageInfo = {
    id: "a",
    extension: "e",
    aliases: ["A"],
    extensions: ["a"],
    filenames: [],
    firstLine: null,
    configuration: null,
    grammar: { scopeName: "source.a", path: "a.json", embeddedLanguages: {} },
  };
  const files: Record<string, string> = {
    "e/a.json": JSON.stringify({
      scopeName: "source.a",
      patterns: [{ include: "source.b" }, { include: "source.nobody" }],
    }),
    "e/b.json": JSON.stringify({ scopeName: "source.b", patterns: [{ include: "source.c" }] }),
    "e/c.json": JSON.stringify({ scopeName: "source.c", patterns: [{ include: "source.a" }] }),
  };
  const read = async (ext: string, path: string) => {
    const text = files[`${ext}/${path}`];
    if (text === undefined) throw new Error(`${ext}/${path}`);
    return new TextEncoder().encode(text);
  };

  it("loads the grammar and, transitively, the included ones the registry knows", async () => {
    const sources = await collectGrammars(registry, lang, read);
    expect(sources.map((s) => s.scopeName)).toEqual(["source.a", "source.b", "source.c"]);
  });

  it("an include of a scope nobody provides is ignored", async () => {
    const sources = await collectGrammars(registry, lang, read);
    expect(sources.some((s) => s.scopeName === "source.nobody")).toBe(false);
  });

  it("fails when the language's own grammar cannot be read, not when an included one cannot", async () => {
    await expect(
      collectGrammars(registry, lang, async () => Promise.reject(new Error("io"))),
    ).rejects.toThrow();
    const partial = async (ext: string, path: string) =>
      path === "c.json" ? Promise.reject(new Error("io")) : read(ext, path);
    const sources = await collectGrammars(registry, lang, partial);
    expect(sources.map((s) => s.scopeName)).toEqual(["source.a", "source.b"]);
  });

  it("a language without a grammar gives nothing", async () => {
    expect(await collectGrammars(registry, { ...lang, grammar: null }, read)).toEqual([]);
  });
});
