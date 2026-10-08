import { describe, expect, it } from "vitest";

import { decodeText, encodeText, longestLine } from "./codec";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("decodeText", () => {
  it("reads UTF-8 and notes LF line endings", () => {
    expect(decodeText(utf8("가나\n다"))).toEqual({ text: "가나\n다", eol: "\n", bom: false });
    expect(decodeText(utf8("#!/bin/sh\necho a\r\necho b\n"))?.eol).toBe("\n");
  });

  it("keeps CRLF and the BOM so a save writes them back", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("a\r\nb")]);
    expect(decodeText(bytes)).toEqual({ text: "a\r\nb", eol: "\r\n", bom: true });
    expect(decodeText(utf8("a\r\nb\r\nc\n"))?.eol).toBe("\r\n");
    expect(decodeText(utf8("a\r\nb\n"))?.eol).toBe("\n");
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
    expect(decodeText(new Uint8Array([0xc3, 0x28]))).toBeNull();
  });

  it("treats a NUL byte near the start as binary", () => {
    expect(decodeText(new Uint8Array([0x41, 0x00, 0x42]))).toBeNull();
  });

  it("reads an empty file", () => {
    expect(decodeText(new Uint8Array())).toEqual({ text: "", eol: "\n", bom: false });
  });
});

describe("encodeText", () => {
  it("writes the BOM back only when the file had one", () => {
    expect([...encodeText("a", true)]).toEqual([0xef, 0xbb, 0xbf, 0x61]);
    expect([...encodeText("한", false)]).toEqual([0xed, 0x95, 0x9c]);
  });
});

describe("longestLine", () => {
  it("measures the longest line", () => {
    expect(longestLine("ab\nabcd\n")).toBe(4);
    expect(longestLine("")).toBe(0);
  });
});
