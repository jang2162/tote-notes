import { describe, expect, it, test } from "vitest";

import {
  canSplit,
  canSplitRect,
  dividersOf,
  dropZone,
  leaf,
  leafIds,
  MIN_PANE_PX,
  neighbor,
  normalize,
  rectsOf,
  remove,
  removeLeaf,
  resize,
  resizeAt,
  split,
  splitAt,
} from "./layout";
import type { LayoutNode, SplitNode } from "./layout";

const row = (children: LayoutNode[], shares: number[]): SplitNode => ({
  kind: "split",
  axis: "row",
  children,
  shares,
});
const col = (children: LayoutNode[], shares: number[]): SplitNode => ({
  kind: "split",
  axis: "column",
  children,
  shares,
});

test("splitting a lone pane to the right makes a row of two halves", () =>
  expect(splitAt(leaf("a"), "a", "right", "b")).toEqual(row([leaf("a"), leaf("b")], [0.5, 0.5])));
test("splitting down inside a row nests a column", () =>
  expect(splitAt(row([leaf("a"), leaf("b")], [0.5, 0.5]), "b", "bottom", "c")).toEqual(
    row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]),
  ));
test("splitting left along the same axis adds a sibling sharing the pane's share", () =>
  expect(splitAt(row([leaf("a"), leaf("b")], [0.5, 0.5]), "a", "left", "c")).toEqual(
    row([leaf("c"), leaf("a"), leaf("b")], [0.25, 0.25, 0.5]),
  ));
test("a removed pane's share goes to the one before it", () =>
  expect(removeLeaf(row([leaf("c"), leaf("a"), leaf("b")], [0.25, 0.25, 0.5]), "a")).toEqual(
    row([leaf("c"), leaf("b")], [0.5, 0.5]),
  ));
test("a branch left with one child becomes that child", () =>
  expect(
    removeLeaf(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]), "c"),
  ).toEqual(row([leaf("a"), leaf("b")], [0.5, 0.5])));
test("a branch left on its parent's axis is spread into the parent", () =>
  expect(
    removeLeaf(
      row(
        [leaf("a"), col([leaf("b"), row([leaf("c"), leaf("d")], [0.5, 0.5])], [0.5, 0.5])],
        [0.5, 0.5],
      ),
      "b",
    ),
  ).toEqual(row([leaf("a"), leaf("c"), leaf("d")], [0.5, 0.25, 0.25])));
test("the last pane is never removed", () => expect(removeLeaf(leaf("a"), "a")).toEqual(leaf("a")));
test("rects cover the area", () => {
  const rects = rectsOf(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]));
  expect(rects.get("a")).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
  expect(rects.get("c")).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
});
test("leaf ids go depth first", () =>
  expect(leafIds(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]))).toEqual([
    "a",
    "b",
    "c",
  ]));
test("a boundary moves by the dragged pixels", () =>
  expect(
    (
      resizeAt(row([leaf("a"), leaf("b")], [0.5, 0.5]), [], 0, 100, {
        width: 1000,
        height: 800,
      }) as SplitNode
    ).shares,
  ).toEqual([0.6, 0.4]));
test("a boundary stops where a pane would go under its minimum", () =>
  expect(
    (
      resizeAt(row([leaf("a"), leaf("b")], [0.5, 0.5]), [], 0, 400, {
        width: 1000,
        height: 800,
      }) as SplitNode
    ).shares,
  ).toEqual([0.68, 0.32]));
test("a column boundary keeps 160px", () =>
  expect(
    (
      resizeAt(col([leaf("a"), leaf("b")], [0.5, 0.5]), [], 0, 300, {
        width: 1000,
        height: 800,
      }) as SplitNode
    ).shares,
  ).toEqual([0.8, 0.2]));
test("a pair with only one side under the minimum can still grow that side", () => {
  const area = { width: 640, height: 800 };
  const pair = row([leaf("a"), leaf("b")], [0.8, 0.2]);
  const [first, second] = (resizeAt(pair, [], 0, -100, area) as SplitNode).shares;
  expect(first).toBeCloseTo(412 / 640);
  expect(second).toBeCloseTo(228 / 640);
  const [stayed] = (resizeAt(pair, [], 0, 50, area) as SplitNode).shares;
  expect(stayed).toBeCloseTo(0.8);
});
test("a nested boundary is measured in its parent's height", () => {
  const tree = col(
    [leaf("x"), row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5])],
    [0.5, 0.5],
  );
  const moved = resizeAt(tree, [1, 1], 0, 100, { width: 1000, height: 800 }) as SplitNode;
  const inner = (moved.children[1] as SplitNode).children[1] as SplitNode;
  expect(inner.shares[0]).toBeCloseTo(0.6);
  expect(inner.shares[1]).toBeCloseTo(0.4);
});
test("a pane splits only when both halves keep the minimum", () => {
  expect(canSplitRect({ x: 0, y: 0, width: 640, height: 320 }, "right")).toBe(true);
  expect(canSplitRect({ x: 0, y: 0, width: 639, height: 320 }, "left")).toBe(false);
  expect(canSplitRect({ x: 0, y: 0, width: 640, height: 319 }, "bottom")).toBe(false);
});
test("zones are the outer quarters, the nearest side in a corner", () => {
  const r = { x: 0, y: 0, width: 400, height: 400 };
  expect(dropZone(r, 50, 200)).toBe("left");
  expect(dropZone(r, 200, 200)).toBe("center");
  expect(dropZone(r, 200, 350)).toBe("bottom");
  expect(dropZone(r, 380, 395)).toBe("bottom");
  expect(dropZone(r, 390, 390)).toBe("right");
});
test("the neighbour is the touching pane that overlaps most", () => {
  const rects = rectsOf(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]));
  expect(neighbor(rects, "a", "right")).toBe("b");
  expect(neighbor(rects, "c", "left")).toBe("a");
  expect(neighbor(rects, "b", "bottom")).toBe("c");
  expect(neighbor(rects, "a", "left")).toBeNull();
});
test("the neighbour on an overlap tie is the left one", () => {
  const rects = rectsOf(col([leaf("top"), row([leaf("l"), leaf("r")], [0.5, 0.5])], [0.5, 0.5]));
  expect(neighbor(rects, "top", "bottom")).toBe("l");
});
test("dividers sit on the boundaries", () =>
  expect(dividersOf(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]))).toEqual(
    [
      { path: [], index: 0, axis: "row", rect: { x: 0.5, y: 0, width: 0, height: 1 } },
      { path: [1], index: 0, axis: "column", rect: { x: 0.5, y: 0.5, width: 0.5, height: 0 } },
    ],
  ));

function expectWidths(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((width, index) => expect(actual[index]).toBeCloseTo(width));
}

describe("old row helpers", () => {
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
