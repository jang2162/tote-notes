import { describe, expect, it } from "vitest";

import {
  languageData,
  parseLanguageConfiguration,
  wordCharsFor,
  type LanguageConfiguration,
} from "./language-config";

describe("parseLanguageConfiguration", () => {
  it("reads VS Code's JSONC shape with both pair notations", () => {
    const config = parseLanguageConfiguration(`{
      // generated
      "comments": { "lineComment": "#", "blockComment": ["/*", "*/"] },
      "brackets": [["(", ")"], ["{", "}"]],
      "autoClosingPairs": [{ "open": "(", "close": ")" }, ["{", "}"], { "open": "\\"", "close": "\\"", "notIn": ["string"] }],
      "wordPattern": "[A-Za-z0-9_$-]+",
    }`);
    expect(languageData(config)).toEqual({
      commentTokens: { line: "#", block: { open: "/*", close: "*/" } },
      closeBrackets: { brackets: ["(", "{", '"'] },
      wordChars: "$-",
    });
  });

  it("takes a wordPattern object and leaves out what the file does not say", () => {
    const config = parseLanguageConfiguration(
      `{ "wordPattern": { "pattern": "[\\\\w-]+", "flags": "u" } }`,
    );
    expect(languageData(config)).toEqual({ wordChars: "-" });
    expect(languageData(parseLanguageConfiguration("{}"))).toEqual({});
  });

  it("ignores a wordPattern that is not a valid expression", () => {
    expect(languageData(parseLanguageConfiguration(`{ "wordPattern": "[" }`))).toEqual({});
  });
});

describe("a malformed language configuration", () => {
  // An installed extension's file is anybody's JSON; it must never stop a file from opening.
  it("parses to the plain configuration when it is not a JSON object", () => {
    expect(parseLanguageConfiguration("{ not json")).toEqual({});
    expect(parseLanguageConfiguration('[["(", ")"]]')).toEqual({});
    expect(parseLanguageConfiguration('"#"')).toEqual({});
  });

  it("gives no language data for values of the wrong shape, without throwing", () => {
    const odd: unknown[] = [
      { comments: "#" },
      { comments: { lineComment: 1, blockComment: [1, 2] } },
      { brackets: "()" },
      { autoClosingPairs: { open: "(", close: ")" } },
      { autoClosingPairs: [null, 3, "(", { open: 1 }, [2, 3], {}] },
      { wordPattern: 5 },
      { wordPattern: { pattern: "\\w+", flags: 5 } },
    ];
    for (const config of odd)
      expect(languageData(config as LanguageConfiguration), JSON.stringify(config)).toEqual({});
  });

  it("keeps the well-formed entries next to malformed ones", () => {
    const config = { autoClosingPairs: [null, ["(", ")"], { open: "[", close: "]" }] };
    expect(languageData(config as LanguageConfiguration)).toEqual({
      closeBrackets: { brackets: ["(", "["] },
    });
  });
});

describe("wordCharsFor", () => {
  it("names the ASCII punctuation the pattern counts as part of a word", () => {
    expect(wordCharsFor(/[\w-]+/)).toBe("-");
    expect(wordCharsFor(/(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/)).toBe("$");
    expect(wordCharsFor(/\w+/)).toBe("");
  });
});
