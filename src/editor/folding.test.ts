import { foldable, foldAll, foldCode, foldedRanges } from "@codemirror/language";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { HIGHLIGHT_LIMIT_CHARS } from "../highlight/extension";
import { FOLD_LOOKAHEAD_LINES, foldsAt, indentFold, probeFold } from "./folding";
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

  it("folds a block however long, and not a head whose next text is too far below", () => {
    const block = `a\n${"  x\n".repeat(FOLD_LOOKAHEAD_LINES * 20)}b`;
    expect(foldAt(state(block), 1)).toBe(
      `\n${"  x\n".repeat(FOLD_LOOKAHEAD_LINES * 20).slice(0, -1)}`,
    );
    const gap = (blank: number) => `a\n${"\n".repeat(blank)}  x`;
    expect(foldAt(state(gap(FOLD_LOOKAHEAD_LINES - 2)), 1)).not.toBeNull();
    expect(foldAt(state(gap(FOLD_LOOKAHEAD_LINES)), 1)).toBeNull();
  });

  it("tells the gutter a line folds without looking for its block's end", () => {
    const s = state(`a\n  b\n${"    c\n".repeat(50_000)}d`);
    expect(indentFold(s, 0, 1)).toEqual({ from: 1, to: s.doc.line(50_002).to });
    // As the gutter asks: the range stops at the first deeper line, nothing below it is read.
    expect(probeFold(s, 0, 1)).toEqual({ from: 1, to: 5 });
    // It agrees with the whole range on what folds.
    for (const doc of ["a\nb", "a\n\n  b", "  a\nb", "a\n  b\n\nc", "", "a", "# A\ntext"])
      for (const fileName of ["a.txt", "a.md"]) {
        const t = state(doc, { fileName });
        for (let n = 1; n <= t.doc.lines; n++) {
          const line = t.doc.line(n);
          expect(probeFold(t, line.from, line.to) !== null, `${fileName} ${doc} ${n}`).toBe(
            foldAt(t, n) !== null,
          );
        }
      }
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
    // As the keys run it: `foldCode` adds the folding state field to a state that lacks it.
    const fold = (s: EditorState, run: Command = foldCode) => {
      let state = s.update({ selection: { anchor: 0 } }).state;
      const at = state;
      run({
        state: at,
        // One line a block: nothing wraps or is folded yet.
        lineBlockAt: (pos: number) => at.doc.lineAt(pos),
        dispatch: (spec: TransactionSpec) => {
          state = at.update(spec).state;
        },
      } as unknown as EditorView);
      return foldedRanges(state).size;
    };
    expect(fold(state("a\n  b"))).toBe(1);
    const off = state("a\n  b", { foldFits: false });
    expect(foldAt(off, 1)).toBeNull();
    expect(fold(off)).toBe(0);
    expect(fold(off, foldAll)).toBe(0);
    // Markdown's own folds too.
    const md = (foldFits: boolean) => state("# A\ntext", { fileName: "a.md", foldFits });
    expect(fold(md(true))).toBe(1);
    expect(fold(md(false))).toBe(0);
  });
});
