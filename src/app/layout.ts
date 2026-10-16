// The widths of a window's panes: shares of the editing area's width, left to right, summing to 1.

import { normalizeWidths } from "../core/session";

/** The narrowest a pane is made by a split or by dragging a boundary. A window made narrower
 * shrinks its panes by their ratios, below this too. */
export const MIN_PANE_PX = 320;

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
