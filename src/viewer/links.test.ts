import { describe, expect, it } from "vitest";

import { classifyLink, isOpenableLink, MAX_URL_LENGTH, memoOfLink } from "./links";

describe("classifyLink", () => {
  it("opens http, https and mailto outside, whatever their case", () => {
    expect(classifyLink("https://example.com/a?b=1#c")).toEqual({
      kind: "web",
      url: "https://example.com/a?b=1#c",
    });
    expect(classifyLink("HTTP://example.com")).toEqual({ kind: "web", url: "HTTP://example.com" });
    expect(classifyLink("mailto:a@example.com")).toEqual({
      kind: "web",
      url: "mailto:a@example.com",
    });
    expect(classifyLink("  https://example.com  ")).toEqual({
      kind: "web",
      url: "https://example.com",
    });
  });

  it("refuses every other scheme, a scheme-relative address and an absolute path", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "file:///etc/passwd",
      "ftp://example.com",
      "data:text/html,x",
      "tote-file://x",
      "//example.com/a.md",
      "/Users/me/a.md",
      "",
      "   ",
      "?q=1",
    ]) {
      expect(classifyLink(href), href).toEqual({ kind: "refused" });
    }
  });

  it("keeps a fragment for the viewer, decoded", () => {
    expect(classifyLink("#%EC%A0%9C%EB%AA%A9")).toEqual({ kind: "anchor", fragment: "제목" });
    expect(classifyLink("#a-b")).toEqual({ kind: "anchor", fragment: "a-b" });
  });

  it("decodes a relative path and drops its query and fragment", () => {
    expect(classifyLink("%ED%9A%8C%EC%9D%98%20%EC%A4%80%EB%B9%84.md")).toEqual({
      kind: "file",
      path: "회의 준비.md",
    });
    expect(classifyLink("./a.md#제목")).toEqual({ kind: "file", path: "./a.md" });
    expect(classifyLink("a.md?x=1")).toEqual({ kind: "file", path: "a.md" });
    expect(classifyLink("%E0%A4%A.md")).toEqual({ kind: "refused" });
  });
});

describe("isOpenableLink", () => {
  it("takes the three schemes alone, as open_link does", () => {
    expect(isOpenableLink("https://example.com")).toBe(true);
    expect(isOpenableLink("Mailto:a@example.com")).toBe(true);
    expect(isOpenableLink("http://example.com/%20a")).toBe(true);
    expect(isOpenableLink("javascript:alert(1)")).toBe(false);
    expect(isOpenableLink("file:///etc/passwd")).toBe(false);
    expect(isOpenableLink("x-apple.systempreferences:")).toBe(false);
    expect(isOpenableLink("a.md")).toBe(false);
  });

  it("refuses a space, a control character or a URL past the limit", () => {
    expect(isOpenableLink("https://example.com/a b")).toBe(false);
    expect(isOpenableLink("https://example.com/\n-a")).toBe(false);
    expect(isOpenableLink("https://example.com/\u0000")).toBe(false);
    const base = "https://example.com/";
    expect(isOpenableLink(base + "a".repeat(MAX_URL_LENGTH - base.length))).toBe(true);
    expect(isOpenableLink(base + "a".repeat(MAX_URL_LENGTH - base.length + 1))).toBe(false);
  });
});

describe("memoOfLink", () => {
  const ws = "/Users/me/.tote/업무";

  it("names a file in the workspace folder from a memo, in NFC", () => {
    expect(memoOfLink("회의 준비.md", ws, ws)).toEqual({ kind: "memo", name: "회의 준비.md" });
    expect(memoOfLink("./a.md", ws, ws)).toEqual({ kind: "memo", name: "a.md" });
    expect(memoOfLink("회의.md".normalize("NFD"), ws, ws)).toEqual({
      kind: "memo",
      name: "회의.md",
    });
    expect(memoOfLink("sub/../a.md", ws, ws)).toEqual({ kind: "memo", name: "a.md" });
  });

  it("puts a sub folder, a parent folder or a folder itself outside the flat workspace", () => {
    expect(memoOfLink("../secret.md", ws, ws)).toEqual({ kind: "outside" });
    expect(memoOfLink("sub/a.md", ws, ws)).toEqual({ kind: "outside" });
    expect(memoOfLink(".tote/index.json", ws, ws)).toEqual({ kind: "outside" });
    expect(memoOfLink("sub/", ws, ws)).toEqual({ kind: "outside" });
    expect(memoOfLink("..", ws, ws)).toEqual({ kind: "outside" });
    expect(memoOfLink("../../../../../../a.md", ws, ws)).toEqual({ kind: "outside" });
  });

  it("reads an external file's link from its own folder", () => {
    expect(memoOfLink("업무/a.md", "/Users/me/.tote", ws)).toEqual({ kind: "memo", name: "a.md" });
    expect(memoOfLink("a.md", "/tmp", ws)).toEqual({ kind: "outside" });
    expect(memoOfLink("../a.md", `${ws}/sub`, ws)).toEqual({ kind: "memo", name: "a.md" });
  });

  it("matches the workspace folder however its path is written", () => {
    expect(memoOfLink("a.md", `${ws}/`, ws)).toEqual({ kind: "memo", name: "a.md" });
    expect(memoOfLink("a.md", ws.normalize("NFD"), ws)).toEqual({ kind: "memo", name: "a.md" });
  });
});
