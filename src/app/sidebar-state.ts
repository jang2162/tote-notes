import type { WindowStart } from "../backend/types";
import { parseSidebarWidth } from "../core/sidebar-width";

// The page keeps its window's collapsed sidebar and the sidebar's width in `sessionStorage`, which outlives a reload — a
// workspace switch reloads the page and the state goes with the window, not the workspace (spec
// 「세션」). Keyed by the window's label: a window `window.open` makes gets a copy of the opener's.
// `storage` is a function because reading `window.sessionStorage` can itself throw.

const key = (label: string) => `tote.sidebarCollapsed.${label}`;
const widthKey = (label: string) => `tote.sidebarWidth.${label}`;

/** What the window's page last kept, or null for nothing, anything but "true"/"false", or a
 * storage that cannot be read. */
export function storedCollapsed(
  storage: () => Pick<Storage, "getItem"> | null,
  label: string,
): boolean | null {
  try {
    const value = storage()?.getItem(key(label));
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}

/** Keeps `collapsed` for the window's next page; a storage that cannot be written is let be. */
export function storeCollapsed(
  storage: () => Pick<Storage, "setItem"> | null,
  label: string,
  collapsed: boolean,
): void {
  try {
    storage()?.setItem(key(label), String(collapsed));
  } catch {
    // Private mode or a full storage: the window then starts from its saved layout.
  }
}

/** Whether the window's page starts collapsed: what an earlier page of it kept, else the value
 * the native side read from the window's saved layout. */
export function startsCollapsed(start: WindowStart, stored: boolean | null): boolean {
  return stored ?? start.sidebarCollapsed;
}

/** The width the window's page last kept, or null for nothing, a width the session would not take
 * (`parseSidebarWidth`), or a storage that cannot be read. */
export function storedWidth(
  storage: () => Pick<Storage, "getItem"> | null,
  label: string,
): number | null {
  try {
    const value = storage()?.getItem(widthKey(label));
    return value ? parseSidebarWidth(Number(value)) : null;
  } catch {
    return null;
  }
}

/** Keeps `width` for the window's next page; a storage that cannot be written is let be. */
export function storeWidth(
  storage: () => Pick<Storage, "setItem"> | null,
  label: string,
  width: number,
): void {
  try {
    storage()?.setItem(widthKey(label), String(width));
  } catch {
    // As `storeCollapsed`.
  }
}

/** The width the window's page starts with: what an earlier page of it kept, else the value the
 * native side read from the window's saved layout. */
export function startsWidth(start: WindowStart, stored: number | null): number {
  return stored ?? start.sidebarWidth;
}
