import { history, isolateHistory, undo } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  Text,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  compositionCommit,
  mainFirst,
  mirrorReplacement,
  multiRangeIme,
  redoRestores,
  undoRestores,
  undoWithCursors,
  type Composition,
} from "./ime";

const cursors = (...positions: number[]) =>
  EditorSelection.create(positions.map((p) => EditorSelection.cursor(p)));
const rangesOf = (tr: Transaction) => tr.newSelection.ranges.map((r) => [r.from, r.to]);
// Without allowMultipleSelections, EditorState.create keeps the main range only.
const state = (doc: string, selection: EditorSelection) =>
  EditorState.create({
    doc,
    selection,
    extensions: [EditorState.allowMultipleSelections.of(true), multiRangeIme],
  });

/** A state with history and the input-method fields, behind as much of an EditorView as the
 * history commands use. `compose` replays a composition as the editor sees it: the collapse to the
 * main range, the syllable at the main range (`compose.start` opens a history group; plain
 * `compose` always joins the last one), then the commit to the waiting cursors. */
function composer(doc: string, selection: EditorSelection) {
  let s = EditorState.create({
    doc,
    selection,
    extensions: [EditorState.allowMultipleSelections.of(true), history(), multiRangeIme],
  });
  const view = {
    get state() {
      return s;
    },
    dispatch(tr: Transaction | TransactionSpec) {
      s = tr instanceof Transaction ? tr.state : s.update(tr).state;
    },
  } as unknown as EditorView;
  const compose = (syllable: string) => {
    const before = s.selection;
    const { main } = before;
    s = s.update({
      selection: EditorSelection.create([main]),
      annotations: isolateHistory.of("full"),
    }).state;
    const typed = s.update({
      changes: { from: main.from, insert: syllable },
      selection: EditorSelection.cursor(main.from + syllable.length),
      userEvent: "input.type.compose.start",
    });
    s = typed.state;
    const current: Composition = {
      from: main.from,
      taken: "",
      others: before.ranges.filter((r) => r !== main).map((r) => r.map(typed.changes)),
      before,
      startDoc: typed.startState.doc,
    };
    s = s.update(compositionCommit(s, current)).state;
  };
  return { view, compose };
}

describe("mainFirst", () => {
  it("moves the main range to the first of several", () => {
    const next = mainFirst(
      EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(6)], 1),
    );
    expect(next?.mainIndex).toBe(0);
    expect(next?.ranges.map((r) => r.head)).toEqual([2, 6]);
  });

  it("leaves a selection whose main range is already first, or single, alone", () => {
    expect(mainFirst(cursors(2, 6))).toBeNull();
    expect(mainFirst(EditorSelection.single(3))).toBeNull();
  });
});

describe("mirrorReplacement", () => {
  // Three cursors after a direct-path ㄱ; the input method rewrites the ㄱ before the main one.
  const s = state("사과ㄱ\n배ㄱ\n귤ㄱ", cursors(3, 6, 9));

  it("rewrites the same text before every other cursor", () => {
    const tr = s.update(mirrorReplacement(s, 2, 3, "가", EditorSelection.cursor(3))!);
    expect(tr.newDoc.toString()).toBe("사과가\n배가\n귤가");
    expect(rangesOf(tr)).toEqual([
      [3, 3],
      [6, 6],
      [9, 9],
    ]);
  });

  it("leaves a cursor alone when the text before it differs", () => {
    const other = state("사과ㄱ\n배\n귤ㄱ", cursors(3, 5, 8));
    const tr = other.update(mirrorReplacement(other, 2, 3, "가", EditorSelection.cursor(3))!);
    expect(tr.newDoc.toString()).toBe("사과가\n배\n귤가");
    expect(rangesOf(tr)).toEqual([
      [3, 3],
      [5, 5],
      [8, 8],
    ]);
  });

  it("replaces across both ⌘D selections after the direct path turned them into ㄱ", () => {
    const two = state("ㄱ ㄱ", cursors(1, 3));
    const tr = two.update(mirrorReplacement(two, 0, 1, "가", EditorSelection.cursor(1))!);
    expect(tr.newDoc.toString()).toBe("가 가");
    expect(rangesOf(tr)).toEqual([
      [1, 1],
      [3, 3],
    ]);
  });

  it("is not for a change inside the main range, a single cursor, or one ending elsewhere", () => {
    expect(mirrorReplacement(s, 3, 3, "나", EditorSelection.cursor(4))).toBeNull();
    expect(mirrorReplacement(s, 2, 2, "x", EditorSelection.cursor(4))).toBeNull();
    expect(
      mirrorReplacement(state("ㄱ", cursors(1)), 0, 1, "가", EditorSelection.cursor(1)),
    ).toBeNull();
  });
});

describe("compositionCommit", () => {
  const waiting = (doc: string, main: [number, number]) =>
    state(doc, EditorSelection.create([EditorSelection.range(...main)]));

  it("puts the composed syllable at every waiting cursor and brings the cursors back", () => {
    // Cursors at 4 and 6 before the composition, mapped through the 가 inserted at 2.
    const current: Composition = {
      from: 2,
      taken: "",
      others: [EditorSelection.cursor(5), EditorSelection.cursor(7)],
      before: EditorSelection.single(0),
      startDoc: Text.of([""]),
    };
    const s = waiting("사과가\n배\n귤", [3, 3]);
    const tr = s.update(compositionCommit(s, current));
    expect(tr.newDoc.toString()).toBe("사과가\n배가\n귤가");
    expect(rangesOf(tr)).toEqual([
      [3, 3],
      [6, 6],
      [9, 9],
    ]);
    expect(tr.isUserEvent("input.type.compose")).toBe(true);
  });

  it("replaces a waiting selection the way the main one was replaced (recording 2)", () => {
    // `test test`, both selected; the composition replaced the first with 가, so the other,
    // mapped through that change, is at 2..6.
    const current: Composition = {
      from: 0,
      taken: "",
      others: [EditorSelection.range(2, 6)],
      before: EditorSelection.single(0),
      startDoc: Text.of(["test test"]),
    };
    const s = waiting("가 test", [1, 1]);
    const tr = s.update(compositionCommit(s, current));
    expect(tr.newDoc.toString()).toBe("가 가");
    expect(rangesOf(tr)).toEqual([
      [1, 1],
      [3, 3],
    ]);
  });

  it("takes from the others the same text the composition took before the caret", () => {
    // A direct-path ㄱ at every cursor, then a composition that rewrote the main one's ㄱ to 가.
    const current: Composition = {
      from: 2,
      taken: "ㄱ",
      others: [EditorSelection.cursor(6), EditorSelection.cursor(9)],
      before: EditorSelection.single(0),
      startDoc: Text.of([""]),
    };
    const s = waiting("사과가\n배ㄱ\n귤ㄱ", [3, 3]);
    const tr = s.update(compositionCommit(s, current));
    expect(tr.newDoc.toString()).toBe("사과가\n배가\n귤가");
    expect(rangesOf(tr)).toEqual([
      [3, 3],
      [6, 6],
      [9, 9],
    ]);
  });

  it("leaves a waiting cursor alone when the text before it is not what was taken", () => {
    const current: Composition = {
      from: 2,
      taken: "ㄱ",
      others: [EditorSelection.cursor(6), EditorSelection.cursor(9)],
      before: EditorSelection.single(0),
      startDoc: Text.of([""]),
    };
    const s = waiting("사과가\n배ㄴ\n귤ㄱ", [3, 3]);
    const tr = s.update(compositionCommit(s, current));
    expect(tr.newDoc.toString()).toBe("사과가\n배ㄴ\n귤가");
    expect(rangesOf(tr)).toEqual([
      [3, 3],
      [6, 6],
      [9, 9],
    ]);
  });

  it("leaves nothing anywhere after a cancelled composition", () => {
    const current: Composition = {
      from: 2,
      taken: "",
      others: [EditorSelection.cursor(4), EditorSelection.cursor(6)],
      before: EditorSelection.single(0),
      startDoc: Text.of([""]),
    };
    const s = waiting("사과\n배\n귤", [2, 2]);
    const tr = s.update(compositionCommit(s, current));
    expect(tr.docChanged).toBe(false);
    expect(rangesOf(tr)).toEqual([
      [2, 2],
      [4, 4],
      [6, 6],
    ]);
  });
});

describe("undoRestores", () => {
  it("remembers the document and selection a composition started from", () => {
    const start = state("사과\n배\n귤", cursors(2, 4, 6));
    const current: Composition = {
      from: 2,
      taken: "",
      others: [EditorSelection.cursor(4), EditorSelection.cursor(6)],
      before: start.selection,
      startDoc: start.doc,
    };
    // After composing 가 at the main range only.
    const composed = state("사과가\n배\n귤", cursors(3));
    const tr = composed.update(compositionCommit(composed, current));
    const records = tr.state.field(undoRestores);
    expect(records).toHaveLength(1);
    expect(records[0].doc.toString()).toBe("사과\n배\n귤");
    expect(records[0].selection.ranges.map((r) => r.head)).toEqual([2, 4, 6]);
  });

  it("drops the records past an undo", () => {
    const { view, compose } = composer("사과\n배\n귤", cursors(2, 4, 6));
    compose("가");
    compose("나");
    expect(view.state.doc.toString()).toBe("사과가나\n배가나\n귤가나");
    expect(view.state.field(undoRestores)).toHaveLength(2);
    undo(view);
    expect(view.state.doc.toString()).toBe("사과가\n배가\n귤가");
    const records = view.state.field(undoRestores);
    expect(records).toHaveLength(1);
    expect(records[0].doc.toString()).toBe("사과\n배\n귤");
  });
});

describe("redoRestores", () => {
  it("drops what ⇧⌘Z would put back once a new edit comes", () => {
    const { view, compose } = composer("사과\n배\n귤", cursors(2, 4, 6));
    compose("가");
    undoWithCursors(view);
    expect(view.state.field(redoRestores)).toHaveLength(1);
    view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    expect(view.state.field(redoRestores)).toHaveLength(0);
  });
});
