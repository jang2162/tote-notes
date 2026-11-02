import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import { Registry, type IOnigLib, type IRawGrammar } from "@shikijs/vscode-textmate";
import { beforeAll, describe, expect, it } from "vitest";

// The grammars as the app ships them (pnpm sync:bundled): each language's grammar is looked up
// the way the worker does it, by scope through the manifest, and an include nobody provides
// is answered with null, as the worker answers it (src/highlight/grammars.ts).
const BUNDLE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/resources/extensions/tote.languages",
);
const manifest = JSON.parse(readFileSync(join(BUNDLE, "package.json"), "utf8")) as {
  contributes: { grammars: { language?: string; scopeName: string; path: string }[] };
};

let onigLib: IOnigLib;

beforeAll(async () => {
  const engine = await createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined"));
  onigLib = {
    createOnigScanner: (sources) => engine.createScanner(sources),
    createOnigString: (s) => engine.createString(s),
  };
});

/** Each token of `text` as `[text, scopes]`, tokenized with the bundled grammar of `language`,
 * plus the included scopes the bundle does not hold. */
function tokenize(language: string, text: string) {
  const missing: string[] = [];
  const registry = new Registry({
    onigLib,
    loadGrammar: (scope) => {
      const ref = manifest.contributes.grammars.find((g) => g.scopeName === scope);
      if (!ref) {
        missing.push(scope);
        return null;
      }
      return JSON.parse(readFileSync(join(BUNDLE, ref.path), "utf8")) as IRawGrammar;
    },
  });
  const ref = manifest.contributes.grammars.find((g) => g.language === language);
  if (!ref) throw new Error(`no bundled grammar for ${language}`);
  const grammar = registry.loadGrammar(ref.scopeName)!;
  const tokens: [string, string][] = [];
  let state = null;
  for (const line of text.split("\n")) {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    for (const t of result.tokens)
      tokens.push([line.slice(t.startIndex, t.endIndex), t.scopes.join(" ")]);
  }
  return { tokens, missing };
}

/** The scopes of the first token that reads exactly `text`. */
function scopesOf(tokens: [string, string][], text: string): string {
  const token = tokens.find(([t]) => t === text);
  if (!token) throw new Error(`no token reads ${JSON.stringify(text)}`);
  return token[1];
}

describe("the bundled grammars of the languages added after the first pack", () => {
  it.each([
    ["kotlin", 'fun main() {\n  val x = "hi" // c\n}', "fun", /\bkeyword\./],
    ["kotlin", 'val x = "hi" // c', "//", /\bcomment\./],
    ["swift", "let x: Int = 1 // c", "let", /\bkeyword\./],
    ["swift", "let x: Int = 1 // c", "//", /\bcomment\./],
    ["ruby", "# c\ndef f\nend", "def", /\bkeyword\.control\.def\.ruby/],
    ["ruby", "# c\ndef f\nend", "#", /\bcomment\./],
    ["lua", '-- c\nlocal x = "s"', "local", /\bkeyword\./],
    ["lua", '-- c\nlocal x = "s"', "--", /\bcomment\./],
    ["csharp", 'class A { string s = "x"; } // c', "class", /\bstorage\.type\.class\.cs/],
    ["csharp", 'class A { string s = "x"; } // c', "//", /\bcomment\./],
    ["csv", 'a,b,c\n1,"x",3', "b,", /\brainbow2\b/],
    ["tsv", "a\tb\tc", "b\t", /\brainbow2\b/],
  ])("%s colours %j: %j", (language, text, token, scope) => {
    expect(scopesOf(tokenize(language, text).tokens, token)).toMatch(scope);
  });

  it("ruby colours a heredoc with the bundled SQL grammar and passes over includes nobody ships", () => {
    const { tokens, missing } = tokenize("ruby", "x = <<~SQL\n  SELECT 1\nSQL");
    expect(scopesOf(tokens, "SELECT")).toMatch(/\bsource\.sql\b.*\bkeyword\./);
    // Haml and GraphQL are not in the pack: the text inside them stays uncoloured, nothing fails.
    expect(missing).toEqual(expect.arrayContaining(["text.haml", "source.graphql"]));
  });
});
