import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";

import {
  defaultFakeData,
  FAKE_STORAGE_KEY,
  fakeFile,
  fakeMemo,
  type FakeData,
} from "../../src/backend/fake";
import type { OutsideChange } from "../../src/backend/types";
import {
  isSessionPane,
  parseSessionFile,
  sessionPanes,
  type PaneSession,
  type SessionNode,
} from "../../src/core/session";

/** Opens the app on the fake backend seeded with `patch`. The seed is written once per test, so
 * reloading keeps the fake's data — that is how these specs simulate a restart. */
export async function start(page: Page, patch: Partial<FakeData> = {}): Promise<void> {
  const seed = JSON.stringify({ ...defaultFakeData(), ...patch });
  await page.addInitScript(
    ([key, json]) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, json);
    },
    [FAKE_STORAGE_KEY, seed] as const,
  );
  await page.goto("/");
  await ready(page);
}

/** Opens the app as windows of one workspace on the fake backend seeded with `patch` (`FakeHub`),
 * and returns the first window. The seed is written once per context, so a window opened later
 * — or after the others closed, as at a restart — shares the data. */
export async function startWindows(
  context: BrowserContext,
  patch: Partial<FakeData> = {},
): Promise<Page> {
  const seed = JSON.stringify({ ...defaultFakeData(), ...patch });
  await context.addInitScript(
    ([key, json]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, json);
    },
    [FAKE_STORAGE_KEY, seed] as const,
  );
  return openWindow(context, "ws-1");
}

/** Opens window `label` as the app reopens one at launch. */
export async function openWindow(context: BrowserContext, label: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?window=${label}`);
  await ready(page);
  return page;
}

/** The window `page` opens next — a torn-off tab's, ⌥⌘N's — once it is ready. */
export async function nextWindow(page: Page): Promise<Page> {
  const popup = await page.waitForEvent("popup");
  await ready(popup);
  return popup;
}

export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__tote?.ready === true);
}

/** Opens memo 장보기 (우유) on the fake backend seeded with `seed`. */
export async function openShopping(page: Page, seed: Partial<FakeData> = {}): Promise<void> {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") }, ...seed });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toHaveText("우유");
}

/** Opens 장보기 (우유), types 「 계란」 behind 우유, and another app writes 두유 and is heard — in one
 * go. Between steps the save's timer can run out under load, and the save then writes the typed
 * text over 두유 before the change is heard: there would be no other app's text left to choose. */
export async function typeWhileChangedElsewhere(page: Page): Promise<void> {
  await openShopping(page);
  const change: OutsideChange = { kind: "workspace", changes: [{ kind: "modified", id: "a" }] };
  await page.evaluate(
    ([data, heard]) => {
      const { app, backend } = window.__tote;
      app.view.dispatch({
        changes: { from: 2, insert: " 계란" },
        selection: { anchor: 5 },
        userEvent: "input.type",
      });
      Object.assign(backend.data.memos.a, { data, modifiedMs: 900 });
      backend.outside(heard);
    },
    [fakeFile("두유"), change] as const,
  );
}

/** Every write the window has scheduled — memo saves, its session — has run (`WriteScheduler`):
 * a save a key or an edit scheduled has gone out by now, so what `memoWrites` says is final. */
export async function writesSettled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__tote.app.writes.pending())).toBe(0);
}

/** How many saves of memo `id` the fake has written. */
export function memoWrites(page: Page, id: string): Promise<number> {
  return page.evaluate((memo) => window.__tote.backend.data.memoWrites[memo] ?? 0, id);
}

/** A version 2 session of one window whose panes hold `tabs` side by side, each pane's first tab
 * active. `focusedPane` is focused (the first by default); `widths` are the panes' shares (equal
 * by default). */
export function paneSession(
  tabs: object[][],
  options: { focusedPane?: number; widths?: number[] } = {},
): string {
  const widths = options.widths ?? tabs.map(() => 1 / tabs.length);
  return JSON.stringify({
    version: 2,
    windows: [
      {
        panes: tabs.map((each, index) => ({
          tabs: each,
          activeTab: each.length ? 0 : -1,
          width: widths[index],
        })),
        focusedPane: options.focusedPane ?? 0,
      },
    ],
  });
}

/** A version 2 session of one window with the layout tree `layout` (`{ axis, shares, children }`
 * branches over `{ tabs, activeTab }` panes) and `focusedPane` focused, counted depth first. */
export function layoutSession(layout: object, focusedPane = 0): string {
  return JSON.stringify({ version: 2, windows: [{ layout, focusedPane }] });
}

async function sessionLayout(page: Page, window: number): Promise<SessionNode | undefined> {
  // `self`: the browser's window, which the `window` parameter hides here.
  const text = await page.evaluate(() => self.__tote.backend.data.session);
  return parseSessionFile(text).windows[window]?.layout;
}

/** Pane `pane` (depth first) of window `window` in the fake's session file, as the app reads it
 * back; an empty pane while the file has none, so a poll waits for it. */
export async function sessionPane(page: Page, window = 0, pane = 0): Promise<PaneSession> {
  const layout = await sessionLayout(page, window);
  return (layout && sessionPanes(layout)[pane]) ?? { tabs: [], activeTab: -1 };
}

/** How many panes window `window` has in the fake's session file; 0 while the file has none. */
export async function sessionPaneCount(page: Page, window = 0): Promise<number> {
  const layout = await sessionLayout(page, window);
  return layout ? sessionPanes(layout).length : 0;
}

/** The share of the editing area's width that pane `pane` has in a row of panes; 1 for a lone
 * pane, NaN while the file has no such pane. */
export async function sessionWidth(page: Page, window = 0, pane = 0): Promise<number> {
  const layout = await sessionLayout(page, window);
  if (!layout || isSessionPane(layout)) return layout ? 1 : Number.NaN;
  return layout.shares[pane] ?? Number.NaN;
}

/** Holds the fake at `gate` — set on it now, taken by its next switch or tear-off — until the
 * returned function is called: the test acts while the backend is busy, without a timer. */
export async function hold(
  page: Page,
  gate: "switchGate" | "tearOffGate",
): Promise<() => Promise<void>> {
  await page.evaluate((name) => {
    window.__tote.backend[name] = new Promise<void>((resolve) =>
      Object.assign(window, { [`release-${name}`]: resolve }),
    );
  }, gate);
  return () =>
    page.evaluate(
      (name) => (window as unknown as Record<string, () => void>)[`release-${name}`](),
      gate,
    );
}

/** The window's panes from the top down, left to right on one level. A split leaves the panes'
 * elements where they are, so their order in the DOM is not the layout's. Read once: a pane opened
 * or closed after the call shifts what these point at. */
export async function panesByPosition(page: Page): Promise<Locator[]> {
  const all = page.locator(".pane");
  const places = await all.evaluateAll((els) =>
    els.map((el) => {
      const { top, left } = el.getBoundingClientRect();
      return { top: Math.round(top), left: Math.round(left) };
    }),
  );
  return places
    .map((place, index) => ({ ...place, index }))
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .map(({ index }) => all.nth(index));
}

/** `locator`'s box. `boundingBox` does not wait, and right after a restore the tab bar is drawn
 * again: a box read while its tabs are being replaced is null, so it is read until there is one. */
export async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  await expect.poll(async () => (box = await locator.boundingBox())).not.toBeNull();
  return box!;
}

/** The middle of `locator`'s box. */
export async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await boxOf(locator);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Past the window's left edge, in client coordinates. WebKit goes on sending the pointer's moves
 * and its release there, as the app's webview is to (Task 1 of the free splits plan). */
export const OUTSIDE = { x: -80, y: 300 };

/** Presses on `tab`'s middle and moves out of the window (`OUTSIDE`) in steps; lets go there
 * unless `release` is false. Returns the screen point of the last move: where a drop there is
 * let go of, as the page hands it to `tearOffTab`. */
export async function dragOut(
  page: Page,
  tab: Locator,
  release = true,
): Promise<{ x: number; y: number }> {
  let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  // `boundingBox` does not wait: right after a restore the tab bar may be drawn again.
  while (!(box = await tab.boundingBox())) await page.waitForTimeout(20);
  await page.evaluate(() =>
    window.addEventListener("pointermove", (event) => {
      window.lastScreenPoint = { x: event.screenX, y: event.screenY };
    }),
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(OUTSIDE.x, OUTSIDE.y, { steps: 8 });
  const at = await page.evaluate(() => window.lastScreenPoint!);
  if (release) await page.mouse.up();
  return at;
}

/** What the native menu would send. */
export function menu(page: Page, id: string): Promise<void> {
  return page.evaluate((menuId) => window.__tote.backend.menu(menuId), id);
}

/** The app logs each error it reports; the ones a test makes on purpose stay out of the output.
 * Vite's client wraps `console.error` to forward it to the dev server's log (`forwardConsole`, on
 * when Vite sees an agent run it), so the filter stays outermost: whatever is assigned later goes
 * under it. That wrapper calls the `console.error` it read — the filter — so a call that comes back
 * into the filter goes straight to the browser's own. A page keeps one filter: a later call adds
 * its words to it. */
export async function quietErrors(
  page: Page | BrowserContext,
  ...expected: string[]
): Promise<void> {
  await page.addInitScript((expected) => {
    if (window.__quietErrors) {
      window.__quietErrors.push(...expected);
      return;
    }
    const words = (window.__quietErrors = [...expected]);
    const own = console.error.bind(console);
    let inner = own;
    let inside = false;
    const filtered = (...args: unknown[]) => {
      if (args.some((arg) => words.some((text) => String(arg).includes(text)))) return;
      if (inside) return own(...args);
      inside = true;
      try {
        inner(...args);
      } finally {
        inside = false;
      }
    };
    Object.defineProperty(console, "error", {
      configurable: true,
      get: () => filtered,
      set: (next: typeof console.error) => {
        inner = next;
      },
    });
  }, expected);
}
