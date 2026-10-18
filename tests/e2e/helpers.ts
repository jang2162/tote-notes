import type { BrowserContext, Page } from "@playwright/test";

import { defaultFakeData, FAKE_STORAGE_KEY, type FakeData } from "../../src/backend/fake";
import { parseSessionFile, type PaneSession } from "../../src/core/session";

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

/** Pane `pane` of window `window` in the fake's session file, as the app reads it back; an empty
 * pane while the file has none, so a poll waits for it. */
export async function sessionPane(page: Page, window = 0, pane = 0): Promise<PaneSession> {
  // `self`: the browser's window, which the `window` parameter hides here.
  const text = await page.evaluate(() => self.__tote.backend.data.session);
  return (
    parseSessionFile(text).windows[window]?.panes[pane] ?? { tabs: [], activeTab: -1, width: 1 }
  );
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
