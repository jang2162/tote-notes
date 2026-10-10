import { describe, expect, it } from "vitest";

import { languageData, parseLanguageConfiguration, wordCharsFor } from "./language-config";

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

describe("wordCharsFor", () => {
  it("names the ASCII punctuation the pattern counts as part of a word", () => {
    expect(wordCharsFor(/[\w-]+/)).toBe("-");
    expect(wordCharsFor(/(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/)).toBe("$");
    expect(wordCharsFor(/\w+/)).toBe("");
  });
});
