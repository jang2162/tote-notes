import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { menu, start } from "./helpers";

// The row at the foot of the sidebar: the settings button always, the update button beside it
// when there is a newer version. What the update button does is update.spec.ts's.

const settingsButton = (page: Page) => page.getByRole("button", { name: "설정", exact: true });
const updateButton = (page: Page) => page.locator(".update-button");
const settingsScreen = (page: Page) => page.locator(".modal.settings");
const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;
const announce = (page: Page, version = "0.2.0") =>
  page.evaluate(
    (version) => window.__tote.backend.announceUpdate({ version, current: "0.1.0", notes: "" }),
    version,
  );

test("the settings button sits at the window's bottom left with no update, and opens the settings", async ({
  page,
}) => {
  await start(page);
  await expect(updateButton(page)).toBeHidden();
  await expect(settingsButton(page)).toBeVisible();
  // The shortcut is the fixed one, from the shortcut table.
  await expect(settingsButton(page)).toHaveAttribute("title", "설정 (⌘,)");
  const own = (await settingsButton(page).boundingBox())!;
  const sidebar = await box(page, ".sidebar");
  expect(own.x).toBeGreaterThanOrEqual(sidebar.x);
  expect(own.x + own.width).toBeLessThan(sidebar.x + sidebar.width / 2);
  expect(page.viewportSize()!.height - (own.y + own.height)).toBeLessThan(20);

  await settingsButton(page).click();
  await expect(settingsScreen(page)).toBeVisible();
  await expect(settingsScreen(page).locator("[role=tab][aria-selected=true]")).toHaveText("일반");
  await page.keyboard.press("Escape");
  await expect(settingsScreen(page)).toHaveCount(0);
});

test("the settings button is reached with Tab and pressed with Enter", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  await page.locator(".memo-filter").focus();
  for (let presses = 0; presses < 20; presses++) {
    if (await settingsButton(page).evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(settingsButton(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(settingsScreen(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settingsScreen(page)).toHaveCount(0);
});

test("the settings button opens one screen however often it is pressed", async ({ page }) => {
  await start(page);
  await settingsButton(page).click();
  await expect(settingsScreen(page)).toBeVisible();
  // The menu's ⌘, while the button's screen is up: the same guard holds.
  await menu(page, "settings");
  await settingsButton(page).dispatchEvent("click");
  await expect(settingsScreen(page)).toHaveCount(1);
});

test("an update puts its button beside the settings button, and the foot keeps its height", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  const before = await box(page, ".sidebar-footer");
  const listBefore = await box(page, ".memo-pane");
  await announce(page);
  await expect(updateButton(page)).toHaveText("업데이트 0.2.0");

  // The row's set height keeps these, and so does the buttons' one height: either alone does, so
  // this fails only when both are gone. The set height's room for the focus ring is
  // focus-rings.spec.ts's.
  expect(await box(page, ".sidebar-footer")).toEqual(before);
  expect(await box(page, ".memo-pane")).toEqual(listBefore);
  const settings = (await settingsButton(page).boundingBox())!;
  const update = await box(page, ".update-button");
  // One row: the update button to the right, filling it to the sidebar's edge but for the padding.
  expect(update.x).toBeGreaterThanOrEqual(settings.x + settings.width);
  expect(update.y + update.height / 2).toBeCloseTo(settings.y + settings.height / 2, 0);
  expect(update.x + update.width).toBeGreaterThan(before.x + before.width - 16);
  expect(update.x + update.width).toBeLessThanOrEqual(before.x + before.width);
  await expect(settingsButton(page)).toBeVisible();
});

test("the foot stays as it is with the search panel in the memo list's place", async ({ page }) => {
  await start(page);
  await announce(page);
  await expect(updateButton(page)).toBeVisible();
  const before = await box(page, ".sidebar-footer");
  await menu(page, "search-workspace");
  await expect(page.locator(".search-panel")).toBeVisible();
  await expect(page.locator(".memo-pane")).toBeHidden();
  expect(await box(page, ".sidebar-footer")).toEqual(before);
  await expect(settingsButton(page)).toBeVisible();
  await expect(updateButton(page)).toBeVisible();
  await settingsButton(page).click();
  await expect(settingsScreen(page)).toBeVisible();
});

test("a version too long for the row is cut short on the button and whole in its title", async ({
  page,
}) => {
  const version = "0.2.0-beta.1+build.20261029.abcdef1234567";
  await start(page);
  const before = await box(page, ".sidebar-footer");
  await announce(page, version);
  await expect(updateButton(page)).toHaveText(`업데이트 ${version}`);
  await expect(updateButton(page)).toHaveAttribute("title", `업데이트 ${version}`);
  // Cut, not wrapped: the row stays one line high.
  expect(await updateButton(page).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await box(page, ".sidebar-footer")).toEqual(before);
});
