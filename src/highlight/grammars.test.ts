import { describe, expect, it } from "vitest";

import type { ExtensionRegistry, LanguageInfo } from "../backend/types";
import { Registry } from "../extensions/registry";
import { collectGrammars, collectIncludes } from "./grammars";
import type { GrammarSource } from "./protocol";

// The worker runs this on every grammar it is sent (src/highlight/worker.ts).
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
  /** Stands in for the worker: it parses what it is sent and names the includes it lacks. */
  function worker() {
    const held = new Set<string>();
    const batches: GrammarSource[][] = [];
    const send = async (batch: GrammarSource[]) => {
      batches.push(batch);
      for (const source of batch) held.add(source.scopeName);
      const includes = batch.flatMap((source) => collectIncludes(JSON.parse(source.text)));
      return includes.filter((scope) => !held.has(scope));
    };
    return { send, batches };
  }

  it("loads the grammar and, transitively, the included ones the registry knows", async () => {
    const { send, batches } = worker();
    const sent = await collectGrammars(registry, lang, read, send);
    expect(sent).toEqual(["source.a", "source.b", "source.c"]);
    // As text, one batch per round of includes.
    expect(batches.map((b) => b.map((s) => s.scopeName))).toEqual([
      ["source.a"],
      ["source.b"],
      ["source.c"],
    ]);
    expect(batches[0][0].text).toBe(files["e/a.json"]);
  });

  it("an include of a scope nobody provides is ignored", async () => {
    const sent = await collectGrammars(registry, lang, read, worker().send);
    expect(sent).not.toContain("source.nobody");
  });

  it("fails when the language's own grammar cannot be read, not when an included one cannot", async () => {
    await expect(
      collectGrammars(registry, lang, async () => Promise.reject(new Error("io")), worker().send),
    ).rejects.toThrow();
    const partial = async (ext: string, path: string) =>
      path === "c.json" ? Promise.reject(new Error("io")) : read(ext, path);
    const sent = await collectGrammars(registry, lang, partial, worker().send);
    expect(sent).toEqual(["source.a", "source.b"]);
  });

  it("a language without a grammar gives nothing", async () => {
    const { send, batches } = worker();
    expect(await collectGrammars(registry, { ...lang, grammar: null }, read, send)).toEqual([]);
    expect(batches).toEqual([]);
  });
});
