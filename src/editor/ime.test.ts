import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { compositionSelection } from "./ime";

describe("compositionSelection", () => {
  it("keeps only the main range of several", () => {
    const sel = EditorSelection.create(
      [EditorSelection.cursor(2), EditorSelection.range(4, 6), EditorSelection.cursor(9)],
      1,
    );
    expect(compositionSelection(sel)?.ranges.map((r) => [r.from, r.to])).toEqual([[4, 6]]);
  });

  it("leaves a single cursor alone", () => {
    expect(compositionSelection(EditorSelection.single(3))).toBeNull();
  });
});
