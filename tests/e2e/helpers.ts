import type { Page } from "@playwright/test";

import { defaultFakeData, FAKE_STORAGE_KEY, type FakeData } from "../../src/backend/fake";

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

/** What the native menu would send. */
export function menu(page: Page, id: string): Promise<void> {
  return page.evaluate((menuId) => window.__tote.backend.menu(menuId), id);
}
