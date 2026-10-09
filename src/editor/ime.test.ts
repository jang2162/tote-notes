import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { compositionCommit, mainFirst, mirrorReplacement, type Composition } from "./ime";

const cursors = (...positions: number[]) =>
  EditorSelection.create(positions.map((p) => EditorSelection.cursor(p)));
const rangesOf = (tr: Transaction) => tr.newSelection.ranges.map((r) => [r.from, r.to]);
// Without allowMultipleSelections, EditorState.create keeps the main range only.
const state = (doc: string, selection: EditorSelection) =>
  EditorState.create({ doc, selection, extensions: EditorState.allowMultipleSelections.of(true) });

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
      anchor: 2,
      others: [EditorSelection.cursor(5), EditorSelection.cursor(7)],
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
    const current: Composition = { from: 0, anchor: 0, others: [EditorSelection.range(2, 6)] };
    const s = waiting("가 test", [1, 1]);
    const tr = s.update(compositionCommit(s, current));
    expect(tr.newDoc.toString()).toBe("가 가");
    expect(rangesOf(tr)).toEqual([
      [1, 1],
      [3, 3],
    ]);
  });

  it("takes from the others what the composition took before the caret", () => {
    // A direct-path ㄱ at every cursor, then a composition that rewrote the main one's ㄱ to 가.
    const current: Composition = {
      from: 2,
      anchor: 3,
      others: [EditorSelection.cursor(6), EditorSelection.cursor(9)],
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

  it("leaves nothing anywhere after a cancelled composition", () => {
    const current: Composition = {
      from: 2,
      anchor: 2,
      others: [EditorSelection.cursor(4), EditorSelection.cursor(6)],
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
