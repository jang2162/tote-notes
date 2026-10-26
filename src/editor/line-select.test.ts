import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { lineNumberGutter, selectLines, selectionAnchor, spanLines, spanOf } from "./line-select";

// Lines: "one" 0-3, "" 4-4, "three" 5-10, "four" 11-15 (the last, no line break after it).
const DOC = "one\n\nthree\nfour";

function state(anchor = 0, head = anchor): EditorState {
  return EditorState.create({
    doc: DOC,
    selection: { anchor, head },
    extensions: lineNumberGutter(),
  });
}

const line = (s: EditorState, n: number) => spanOf(s, s.doc.line(n));
const range = (s: EditorState) => [s.selection.main.anchor, s.selection.main.head];

describe("spanLines", () => {
  const s = state();
  const length = s.doc.length;

  it("selects one line up to the next line's start", () => {
    expect(spanLines(line(s, 1), line(s, 1), length)).toEqual({ anchor: 0, head: 4 });
    // An empty line is its line break.
    expect(spanLines(line(s, 2), line(s, 2), length)).toEqual({ anchor: 4, head: 5 });
  });

  it("takes the last line to its end, with no line break to take", () => {
    expect(spanLines(line(s, 4), line(s, 4), length)).toEqual({ anchor: 11, head: 15 });
    const one = EditorState.create({ doc: "only" });
    expect(spanLines(line(one, 1), line(one, 1), 4)).toEqual({ anchor: 0, head: 4 });
    // An empty last line has nothing to select: the cursor goes to its start.
    const empty = EditorState.create({ doc: "a\n" });
    expect(spanLines(line(empty, 2), line(empty, 2), 2)).toEqual({ anchor: 2, head: 2 });
  });

  it("goes down from the anchor's start and up from past its line break", () => {
    expect(spanLines(line(s, 2), line(s, 4), length)).toEqual({ anchor: 4, head: 15 });
    expect(spanLines(line(s, 3), line(s, 1), length)).toEqual({ anchor: 11, head: 0 });
  });

  it("from a point in the text, leaves the point where it is and takes the head by lines", () => {
    expect(spanLines(7, line(s, 1), length)).toEqual({ anchor: 7, head: 0 });
    expect(spanLines(7, line(s, 4), length)).toEqual({ anchor: 7, head: 15 });
    expect(spanLines(7, line(s, 2), length)).toEqual({ anchor: 7, head: 4 });
    // On the point's own line the head comes back to the point.
    expect(spanLines(7, line(s, 3), length)).toEqual({ anchor: 7, head: 7 });
    // At a line's end, the next line is below it; on an empty line, that line is its own.
    expect(spanLines(10, line(s, 4), length)).toEqual({ anchor: 10, head: 15 });
    expect(spanLines(4, line(s, 2), length)).toEqual({ anchor: 4, head: 4 });
  });

  it("keeps every line of an anchor that holds several", () => {
    const folded = spanOf(s, { from: 0, to: 5 });
    expect(folded).toEqual({ from: 0, to: 10 });
    expect(spanLines(folded, line(s, 1), length)).toEqual({ anchor: 0, head: 11 });
  });
});

describe("selectLines", () => {
  it("keeps the gutter's anchor for ⇧click while its selection stands", () => {
    let s = state(12);
    // Before any press, ⇧click goes on from the selection's anchor.
    expect(selectionAnchor(s)).toBe(12);
    s = selectLines(s, line(s, 3), line(s, 1)).state;
    expect(range(s)).toEqual([11, 0]);
    expect(selectionAnchor(s)).toEqual(line(s, 3));
    // ⇧click below: from line 3 down, not from where the upward selection's anchor sits (line 4).
    s = selectLines(s, selectionAnchor(s), line(s, 4)).state;
    expect(range(s)).toEqual([5, 15]);
  });

  it("forgets the anchor once the selection or the text changes otherwise", () => {
    const pressed = selectLines(state(), line(state(), 3), line(state(), 3)).state;
    const moved = pressed.update({ selection: { anchor: 1 } }).state;
    expect(selectionAnchor(moved)).toBe(1);
    const typed = pressed.update({ changes: { from: 0, insert: "x" } }).state;
    expect(selectionAnchor(typed)).toBe(typed.selection.main.anchor);
  });

  it("keeps the anchor through a transaction that leaves the selection and the text alone", () => {
    // Selected upward, whose anchor (past line 3's break) sits on line 4: kept, ⇧click goes on
    // from line 3; forgotten, it would go on from line 4.
    const up = selectLines(state(), line(state(), 3), line(state(), 1)).state;
    expect(selectionAnchor(up.update({}).state)).toEqual(line(up, 3));
  });

  it("is a pointer selection of one range", () => {
    const many = EditorState.create({
      doc: DOC,
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(6)]),
      extensions: [EditorState.allowMultipleSelections.of(true), lineNumberGutter()],
    });
    const tr = selectLines(many, line(many, 1), line(many, 2));
    expect(tr.isUserEvent("select.pointer")).toBe(true);
    expect(tr.state.selection.ranges).toHaveLength(1);
  });
});
