// A window's panes as a split tree: leaves are panes, branches lay their children out along one
// axis by shares that sum to 1.

import { normalizeWidths } from "../core/session";

export type Axis = "row" | "column";
export type Side = "left" | "right" | "top" | "bottom";
export type Zone = Side | "center";

export interface LeafNode {
  kind: "pane";
  id: string;
}

export interface SplitNode {
  kind: "split";
  axis: Axis;
  children: LayoutNode[];
  shares: number[];
}

export type LayoutNode = LeafNode | SplitNode;

/** In fractions of the area (0..1) unless said otherwise. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Divider {
  /** Child numbers from the root down to the branch the boundary is in. */
  path: number[];
  /** The child number just before the boundary. */
  index: number;
  axis: Axis;
  rect: Rect;
}

const EPSILON = 1e-9;
const WHOLE: Rect = { x: 0, y: 0, width: 1, height: 1 };

/** The narrowest a pane is made by a split or by dragging a boundary. A window made narrower
 * shrinks its panes by their ratios, below this too. */
export const MIN_PANE_PX = 320;
/** The same for height, for panes stacked in a column. */
export const MIN_PANE_HEIGHT_PX = 160;

export function leaf(id: string): LeafNode {
  return { kind: "pane", id };
}

/** The pane ids, depth first. */
export function leafIds(root: LayoutNode): string[] {
  if (root.kind === "pane") return [root.id];
  return root.children.flatMap(leafIds);
}

function axisOf(side: Side): Axis {
  return side === "left" || side === "right" ? "row" : "column";
}

function isLeaf(node: LayoutNode, id: string): boolean {
  return node.kind === "pane" && node.id === id;
}

/** Puts a new pane `newId` on `side` of pane `id`. */
export function splitAt(root: LayoutNode, id: string, side: Side, newId: string): LayoutNode {
  const axis = axisOf(side);
  const before = side === "left" || side === "top";
  const fresh = leaf(newId);
  if (root.kind === "pane") {
    if (root.id !== id) return root;
    return {
      kind: "split",
      axis,
      children: before ? [fresh, root] : [root, fresh],
      shares: [0.5, 0.5],
    };
  }
  const at = root.children.findIndex((child) => isLeaf(child, id));
  if (at >= 0 && root.axis === axis) {
    const half = root.shares[at] / 2;
    const children = [...root.children];
    const shares = [...root.shares];
    children.splice(before ? at : at + 1, 0, fresh);
    shares.splice(at, 1, half, half);
    return { ...root, children, shares };
  }
  return { ...root, children: root.children.map((child) => splitAt(child, id, side, newId)) };
}

/** A branch with its same-axis branches spread into it, and a lone child in its place. */
function tidy(axis: Axis, children: LayoutNode[], shares: number[]): LayoutNode {
  const flatChildren: LayoutNode[] = [];
  const flatShares: number[] = [];
  children.forEach((child, index) => {
    if (child.kind === "split" && child.axis === axis) {
      child.children.forEach((inner, innerIndex) => {
        flatChildren.push(inner);
        flatShares.push(shares[index] * child.shares[innerIndex]);
      });
    } else {
      flatChildren.push(child);
      flatShares.push(shares[index]);
    }
  });
  if (flatChildren.length === 1) return flatChildren[0];
  return { kind: "split", axis, children: flatChildren, shares: flatShares };
}

/** Takes pane `id` out; its share goes to the pane before it, the one after when it is first.
 * The root itself is never removed. */
export function removeLeaf(root: LayoutNode, id: string): LayoutNode {
  if (root.kind === "pane") return root;
  const at = root.children.findIndex((child) => isLeaf(child, id));
  if (at >= 0) {
    const children = [...root.children];
    const shares = [...root.shares];
    shares[at > 0 ? at - 1 : at + 1] += shares[at];
    children.splice(at, 1);
    shares.splice(at, 1);
    return tidy(root.axis, children, shares);
  }
  return tidy(
    root.axis,
    root.children.map((child) => removeLeaf(child, id)),
    root.shares,
  );
}

function childRects(node: SplitNode, area: Rect): Rect[] {
  let offset = 0;
  return node.children.map((_, index) => {
    const share = node.shares[index];
    const rect: Rect =
      node.axis === "row"
        ? { x: area.x + offset, y: area.y, width: area.width * share, height: area.height }
        : { x: area.x, y: area.y + offset, width: area.width, height: area.height * share };
    offset += (node.axis === "row" ? area.width : area.height) * share;
    return rect;
  });
}

/** Where each pane lies in `area`. */
export function rectsOf(root: LayoutNode, area: Rect = WHOLE): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const walk = (node: LayoutNode, within: Rect): void => {
    if (node.kind === "pane") {
      rects.set(node.id, within);
      return;
    }
    const inner = childRects(node, within);
    node.children.forEach((child, index) => walk(child, inner[index]));
  };
  walk(root, area);
  return rects;
}

/** The boundaries between siblings, parents before their children. */
export function dividersOf(root: LayoutNode, area: Rect = WHOLE): Divider[] {
  const dividers: Divider[] = [];
  const walk = (node: LayoutNode, within: Rect, path: number[]): void => {
    if (node.kind === "pane") return;
    const inner = childRects(node, within);
    for (let index = 0; index < inner.length - 1; index += 1) {
      const before = inner[index];
      dividers.push({
        path,
        index,
        axis: node.axis,
        rect:
          node.axis === "row"
            ? { x: before.x + before.width, y: within.y, width: 0, height: within.height }
            : { x: within.x, y: before.y + before.height, width: within.width, height: 0 },
      });
    }
    node.children.forEach((child, index) => walk(child, inner[index], [...path, index]));
  };
  walk(root, area, []);
  return dividers;
}

/** Moves the boundary after child `index` of the branch at `path` by `deltaPx`; both sides stay
 * at the minimum size (`MIN_PANE_PX` wide, `MIN_PANE_HEIGHT_PX` high) or more. */
export function resizeAt(
  root: LayoutNode,
  path: number[],
  index: number,
  deltaPx: number,
  areaPx: { width: number; height: number },
): LayoutNode {
  if (root.kind === "pane") return root;
  if (path.length > 0) {
    const [head, ...tail] = path;
    const inner = childRects(root, { x: 0, y: 0, ...areaPx });
    const children = [...root.children];
    children[head] = resizeAt(root.children[head], tail, index, deltaPx, inner[head]);
    return { ...root, children };
  }
  const extent = root.axis === "row" ? areaPx.width : areaPx.height;
  const min = root.axis === "row" ? MIN_PANE_PX : MIN_PANE_HEIGHT_PX;
  const pair = (root.shares[index] + root.shares[index + 1]) * extent;
  const firstPx = root.shares[index] * extent;
  const secondPx = pair - firstPx;
  // A side already under the minimum (a window made small) is not shrunk further, but it can grow.
  const lo = Math.min(min, firstPx);
  const hi = pair - Math.min(min, secondPx);
  const first = Math.min(Math.max(firstPx + deltaPx, lo), hi);
  const shares = [...root.shares];
  shares[index] = first / extent;
  shares[index + 1] = (pair - first) / extent;
  return { ...root, shares };
}

/** Whether a pane of `rectPx` is big enough for both halves to keep the minimum when split
 * toward `side`. */
export function canSplitRect(rectPx: Rect, side: Side): boolean {
  return axisOf(side) === "row"
    ? rectPx.width / 2 >= MIN_PANE_PX
    : rectPx.height / 2 >= MIN_PANE_HEIGHT_PX;
}

/** The outer quarters of a pane are its sides, the nearest one in a corner; the rest is the
 * center. */
export function dropZone(rectPx: Rect, x: number, y: number): Zone {
  const candidates: [Side, number][] = [
    ["left", (x - rectPx.x) / rectPx.width],
    ["right", (rectPx.x + rectPx.width - x) / rectPx.width],
    ["top", (y - rectPx.y) / rectPx.height],
    ["bottom", (rectPx.y + rectPx.height - y) / rectPx.height],
  ];
  let best: [Side, number] | null = null;
  for (const candidate of candidates) {
    if (candidate[1] < 0.25 && (best === null || candidate[1] < best[1])) best = candidate;
  }
  return best ? best[0] : "center";
}

/** The pane touching `id` on `side` that overlaps it most; the upper or left one on a tie. */
export function neighbor(rects: Map<string, Rect>, id: string, side: Side): string | null {
  const from = rects.get(id);
  if (!from) return null;
  let best: { id: string; gap: number; overlap: number; rect: Rect } | null = null;
  for (const [otherId, rect] of rects) {
    if (otherId === id) continue;
    const gap =
      side === "right"
        ? rect.x - (from.x + from.width)
        : side === "left"
          ? from.x - (rect.x + rect.width)
          : side === "bottom"
            ? rect.y - (from.y + from.height)
            : from.y - (rect.y + rect.height);
    if (gap < -EPSILON) continue;
    const overlap =
      axisOf(side) === "row"
        ? Math.min(from.y + from.height, rect.y + rect.height) - Math.max(from.y, rect.y)
        : Math.min(from.x + from.width, rect.x + rect.width) - Math.max(from.x, rect.x);
    if (overlap <= EPSILON) continue;
    const better =
      best === null ||
      gap < best.gap - EPSILON ||
      (Math.abs(gap - best.gap) <= EPSILON &&
        (overlap > best.overlap + EPSILON ||
          (Math.abs(overlap - best.overlap) <= EPSILON &&
            (rect.y < best.rect.y - EPSILON ||
              (Math.abs(rect.y - best.rect.y) <= EPSILON && rect.x < best.rect.x)))));
    if (better) best = { id: otherId, gap, overlap, rect };
  }
  return best ? best.id : null;
}

// The row-only helpers below stay until the controller stops using them.

/** Whether pane `at` is wide enough for both its halves to be `MIN_PANE_PX` in an area of
 * `areaPx`. */
export function canSplit(widths: number[], at: number, areaPx: number): boolean {
  return (widths[at] * areaPx) / 2 >= MIN_PANE_PX;
}

/** Pane `at` gives the right half of its width to a new pane inserted at `at + 1`. */
export function split(widths: number[], at: number): number[] {
  const half = widths[at] / 2;
  return [...widths.slice(0, at), half, half, ...widths.slice(at + 1)];
}

/** Pane `at`'s width goes to its left neighbour, the right one when it is leftmost. */
export function remove(widths: number[], at: number): number[] {
  if (widths.length < 2) return [1];
  const next = [...widths];
  next[at > 0 ? at - 1 : at + 1] += widths[at];
  next.splice(at, 1);
  return next;
}

/** Moves the boundary after pane `boundary` by `dxPx`; both sides stay at MIN_PANE_PX or more. */
export function resize(widths: number[], boundary: number, dxPx: number, areaPx: number): number[] {
  const pair = (widths[boundary] + widths[boundary + 1]) * areaPx;
  // Two panes already too narrow for the minimum (a window made small) stay as they are.
  if (pair < 2 * MIN_PANE_PX) return widths;
  const left = Math.min(
    Math.max(widths[boundary] * areaPx + dxPx, MIN_PANE_PX),
    pair - MIN_PANE_PX,
  );
  const next = [...widths];
  next[boundary] = left / areaPx;
  next[boundary + 1] = (pair - left) / areaPx;
  return next;
}

export { normalizeWidths as normalize };
