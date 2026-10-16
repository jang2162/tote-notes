import { describe, expect, it } from "vitest";

import { canSplit, MIN_PANE_PX, normalize, remove, resize, split } from "./layout";

function expectWidths(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((width, index) => expect(actual[index]).toBeCloseTo(width));
}

describe("pane widths", () => {
  it("split halves the pane and puts the new one right of it", () => {
    expectWidths(split([1], 0), [0.5, 0.5]);
    expectWidths(split([0.5, 0.5], 0), [0.25, 0.25, 0.5]);
  });

  it("canSplit needs MIN_PANE_PX on both halves", () => {
    expect(MIN_PANE_PX).toBe(320);
    expect(canSplit([1], 0, 639)).toBe(false);
    expect(canSplit([1], 0, 640)).toBe(true);
    expect(canSplit([0.25, 0.75], 0, 2000)).toBe(false);
  });

  it("remove gives the width to the left neighbour, the right one when leftmost", () => {
    expectWidths(remove([0.25, 0.25, 0.5], 1), [0.5, 0.5]);
    expectWidths(remove([0.25, 0.25, 0.5], 0), [0.5, 0.5]);
    expectWidths(remove([1], 0), [1]);
  });

  it("resize clamps both sides to MIN_PANE_PX", () => {
    expectWidths(resize([0.5, 0.5], 0, 1000, 1000), [0.68, 0.32]);
    expectWidths(resize([0.5, 0.5], 0, -1000, 1000), [0.32, 0.68]);
  });

  it("normalize keeps usable ratios and evens out unusable ones", () => {
    expectWidths(normalize([0.2, 0.3, 0.5]), [0.2, 0.3, 0.5]);
    expectWidths(normalize([2, 2]), [0.5, 0.5]);
    expectWidths(normalize([0, NaN]), [0.5, 0.5]);
  });
});
