import type { Page } from "@playwright/test";

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

export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__tote?.ready === true);
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
