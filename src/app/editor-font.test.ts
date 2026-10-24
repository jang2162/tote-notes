import { describe, expect, it } from "vitest";

import { editorFontStack } from "./editor-font";

describe("editorFontStack", () => {
  it("puts the default stack after the family the settings name", () => {
    expect(editorFontStack("Menlo")).toBe("Menlo, var(--large-text-font)");
    expect(editorFontStack("NoSuchFont Zz")).toBe("NoSuchFont Zz, var(--large-text-font)");
    expect(editorFontStack("나눔고딕코딩")).toBe("나눔고딕코딩, var(--large-text-font)");
  });

  it("keeps a list a list, and quoted names and generic families as they are", () => {
    expect(editorFontStack(' "Fira Code" ,  monospace ')).toBe(
      '"Fira Code", monospace, var(--large-text-font)',
    );
    expect(editorFontStack("'A, B', C")).toBe("'A, B', C, var(--large-text-font)");
  });

  it("quotes a name CSS cannot read bare", () => {
    expect(editorFontStack("3270 Nope")).toBe('"3270 Nope", var(--large-text-font)');
    expect(editorFontStack('Odd "Name\\')).toBe('"Odd \\"Name\\\\", var(--large-text-font)');
    expect(editorFontStack("initial")).toBe('"initial", var(--large-text-font)');
  });

  it("is empty for no family, so the default stack stands", () => {
    expect(editorFontStack("")).toBe("");
    expect(editorFontStack(" , ")).toBe("");
  });
});
