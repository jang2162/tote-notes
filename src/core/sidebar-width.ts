/** The sidebar's width in CSS pixels (spec 「사이드바 너비 조절」). `max` is also never more than half
 * the window (`sidebarMaxWidth`); a drag below `min` holds at `min` until it goes below
 * `collapseBelow` (150), which collapses the sidebar. */
export const SIDEBAR_WIDTH = { default: 240, min: 200, max: 480, collapseBelow: 150 } as const;

/** A saved width, or null for anything but a number from `min` to `max` — as the native side reads
 * it (`layout_sidebar_width`, src-tauri/src/session/mod.rs). */
export function parseSidebarWidth(value: unknown): number | null {
  return typeof value === "number" && value >= SIDEBAR_WIDTH.min && value <= SIDEBAR_WIDTH.max
    ? value
    : null;
}

/** The widest the sidebar is in a window `windowWidth` wide: half of it up to `max`, never less
 * than `min`. */
export function sidebarMaxWidth(windowWidth: number): number {
  return Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, Math.floor(windowWidth / 2)));
}

/** The width shown for the stored `width`: as much of it as the window allows. The stored width
 * stays, so a window made wide again shows it all. */
export function shownSidebarWidth(width: number, windowWidth: number): number {
  return Math.min(width, sidebarMaxWidth(windowWidth));
}

/** What a drag to `pointer` (the width the pointer points at) makes of the sidebar: collapsed
 * below `collapseBelow`, otherwise the pointer's width held from `min` to the window's max. */
export function draggedSidebar(
  pointer: number,
  windowWidth: number,
): { collapsed: true } | { collapsed: false; width: number } {
  if (pointer < SIDEBAR_WIDTH.collapseBelow) return { collapsed: true };
  const width = Math.max(SIDEBAR_WIDTH.min, Math.round(pointer));
  return { collapsed: false, width: Math.min(width, sidebarMaxWidth(windowWidth)) };
}
