import { expect, test } from "vitest";

import {
  canSplitRect,
  dividersOf,
  dropZone,
  heirOf,
  leaf,
  leafIds,
  MIN_PANE_HEIGHT_PX,
  MIN_PANE_PX,
  neighbor,
  rectsOf,
  removeLeaf,
  resizeAt,
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

test("heirOf is the first pane of the sibling removeLeaf gives the share to", () => {
  const tree = row(
    [col([leaf("a"), leaf("b")], [0.5, 0.5]), row([leaf("c"), leaf("d")], [0.5, 0.5])],
    [0.5, 0.5],
  );
  // The one before it in its branch, a branch's first pane included.
  expect(heirOf(tree, "b")).toBe("a");
  expect(heirOf(row([leaf("a"), leaf("b"), leaf("c")], [0.3, 0.3, 0.4]), "b")).toBe("a");
  // Not the pane before it depth first: that one is in another branch.
  expect(heirOf(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]), "b")).toBe(
    "c",
  );
  expect(heirOf(row([col([leaf("a"), leaf("b")], [0.5, 0.5]), leaf("c")], [0.5, 0.5]), "c")).toBe(
    "a",
  );
  // The one after it when it is first.
  expect(heirOf(tree, "a")).toBe("b");
  expect(heirOf(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]), "a")).toBe(
    "b",
  );
  expect(heirOf(leaf("a"), "a")).toBeNull();
  expect(heirOf(tree, "x")).toBeNull();
});

test("a pane is kept at least 320px wide and 160px high", () => {
  expect(MIN_PANE_PX).toBe(320);
  expect(MIN_PANE_HEIGHT_PX).toBe(160);
});
