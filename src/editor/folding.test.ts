import { foldable, foldedRanges, foldEffect } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { HIGHLIGHT_LIMIT_CHARS } from "../highlight/extension";
import { FOLD_SCAN_LINES, foldsAt, indentFold } from "./folding";
import { editorExtensions, type EditorOptions } from "./setup";

function state(doc: string, options: Partial<EditorOptions> = {}) {
  return EditorState.create({
    doc,
    extensions: editorExtensions({
      fileName: "a.txt",
      wrap: true,
      lineNumbers: false,
      onUpdate: () => {},
      ...options,
    }),
  });
}

/** The range folding line `n` of `s` would hide, as the text it hides. */
function foldAt(s: EditorState, n: number): string | null {
  const line = s.doc.line(n);
  const range = foldable(s, line.from, line.to);
  return range && s.sliceDoc(range.from, range.to);
}

describe("indentFold", () => {
  it("folds the lines indented deeper than the line, to the last of them", () => {
    const s = state("if x:\n  a\n    b\n  c\nd");
    expect(foldAt(s, 1)).toBe("\n  a\n    b\n  c");
    expect(foldAt(s, 2)).toBe("\n    b");
    expect(foldAt(s, 3)).toBeNull();
    expect(foldAt(s, 5)).toBeNull();
  });

  it("looks past blank lines in the block and leaves the blank lines after it", () => {
    const s = state("a\n  b\n\n  c\n\n\nd");
    expect(foldAt(s, 1)).toBe("\n  b\n\n  c");
    // A blank line folds nothing, nor does a line whose next one is not deeper.
    expect(foldAt(s, 3)).toBeNull();
    expect(foldAt(state("a\nb"), 1)).toBeNull();
    // Up to the end of the document.
    expect(foldAt(state("a\n  b\n  c"), 1)).toBe("\n  b\n  c");
  });

  it("measures a tab as the tab size", () => {
    expect(foldAt(state("a\n\tb\n    c\nd"), 1)).toBe("\n\tb\n    c");
    // Four spaces and a tab are as deep: the tab line ends the block of the spaced one.
    expect(foldAt(state("    a\n\tb"), 1)).toBeNull();
  });

  it("gives up on a block it cannot end within the scan", () => {
    const block = (n: number) => `a\n${"  x\n".repeat(n)}b`;
    expect(foldAt(state(block(FOLD_SCAN_LINES - 1)), 1)).not.toBeNull();
    expect(foldAt(state(block(FOLD_SCAN_LINES + 1)), 1)).toBeNull();
  });

  it("is the service the editor folds with in every language", () => {
    const s = state("a\n  b", { fileName: "a.py" });
    expect(indentFold(s, 0, 1)).toEqual({ from: 1, to: 5 });
    expect(foldAt(s, 1)).toBe("\n  b");
  });
});

describe("Markdown folding", () => {
  it("folds a heading's section up to the next heading as high", () => {
    const s = state("# A\ntext\n## B\nmore\n# C\nlast", { fileName: "a.md" });
    expect(foldAt(s, 1)).toBe("\ntext\n## B\nmore");
    expect(foldAt(s, 3)).toBe("\nmore");
    expect(foldAt(s, 5)).toBe("\nlast");
  });

  it("folds a nested list by its indentation", () => {
    const s = state("- a\n  - b\n  - c\n- d", { fileName: "a.md" });
    expect(foldAt(s, 1)).toBe("\n  - b\n  - c");
  });
});

describe("the folding limit", () => {
  it("folds up to the highlighting limit and not past it", () => {
    expect(foldsAt(HIGHLIGHT_LIMIT_CHARS)).toBe(true);
    expect(foldsAt(HIGHLIGHT_LIMIT_CHARS + 1)).toBe(false);
  });

  it("drops a fold in a state that does not fold, whatever asks for it", () => {
    const fold = (s: EditorState) =>
      foldedRanges(s.update({ effects: foldEffect.of({ from: 1, to: 5 }) }).state).size;
    expect(fold(state("a\n  b"))).toBe(1);
    const off = state("a\n  b", { foldFits: false });
    expect(foldAt(off, 1)).toBeNull();
    expect(fold(off)).toBe(0);
    // Markdown's own folds too.
    const md = state("# A\ntext", { fileName: "a.md", foldFits: false });
    expect(foldedRanges(md.update({ effects: foldEffect.of({ from: 3, to: 8 }) }).state).size).toBe(
      0,
    );
  });
});
