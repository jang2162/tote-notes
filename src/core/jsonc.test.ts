import { describe, expect, it } from "vitest";

import { parseJsonc, stripJsonc } from "./jsonc";

describe("parseJsonc", () => {
  it("drops comments and trailing commas but keeps strings whole", () => {
    const text = `{
  // comment with "quotes"
  "a": "// not a comment, /* nor this */",
  "b": [1, 2, /* in-line */ 3,],
  "c": "escaped \\" quote", /* block
  comment */
}`;
    expect(parseJsonc(text)).toEqual({
      a: "// not a comment, /* nor this */",
      b: [1, 2, 3],
      c: 'escaped " quote',
    });
    expect(parseJsonc("[1, // last\n]")).toEqual([1]);
    expect(parseJsonc('{"이름": "메모" /* 주석 */}')).toEqual({ 이름: "메모" });
  });

  it("parses plain JSON as it is", () => {
    expect(parseJsonc('{"a": "// kept", "b": [1, 2]}')).toEqual({ a: "// kept", b: [1, 2] });
  });

  it("leaves plain JSON untouched", () => {
    expect(stripJsonc('{"a": [1, 2], "b": "x/y"}')).toBe('{"a": [1, 2], "b": "x/y"}');
  });
});
