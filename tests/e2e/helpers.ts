import type { BrowserContext, Locator, Page } from "@playwright/test";

import { defaultFakeData, FAKE_STORAGE_KEY, type FakeData } from "../../src/backend/fake";
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

/** A version 2 session of one window whose panes hold `tabs` side by side, each pane's first tab
 * active and `focusedPane` focused. */
export function paneSession(tabs: object[][], focusedPane = 0): string {
  return JSON.stringify({
    version: 2,
    windows: [
      {
        panes: tabs.map((each) => ({
          tabs: each,
          activeTab: each.length ? 0 : -1,
          width: 1 / tabs.length,
        })),
        focusedPane,
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
 * Vite's client wraps `console.error` to forward it to the dev server's log, so the filter stays
 * outermost: whatever is assigned later goes under it. */
export async function quietErrors(page: Page, ...expected: string[]): Promise<void> {
  await page.addInitScript((expected) => {
    let inner = console.error.bind(console);
    const filtered = (...args: unknown[]) => {
      if (!args.some((arg) => expected.some((text) => String(arg).includes(text)))) inner(...args);
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
