import { expect, test, type Locator, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { boxOf, centre, menu, paneSession, panesByPosition, start } from "./helpers";

// The window's top line on macOS (spec 「창 틀 (macOS)」·「맨 윗줄 배치」·「창 끌기」): room for the
// traffic lights, the app's name, and the free space there that drags the window — the sidebar's
// top row, the tab bars of the panes on that line and the lead — while the sidebar's top row alone
// zooms it on a double click. The fake lays the window out for macOS only when seeded with
// `macTitlebar`; it counts the drags and zooms it is asked for, in the handler of the press that
// asks, so a count read after a press has it.

const mac = { macTitlebar: true };
const COLLAPSE = "사이드바 접기";
const EXPAND = "사이드바 펼치기";

const memos = {
  a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }),
  b: fakeMemo("나.md", "둘째", { modifiedMs: 1 }),
};
const twoTabs = {
  memos,
  session: paneSession([
    [
      { kind: "memo", memoId: "a" },
      { kind: "memo", memoId: "b" },
    ],
  ]),
};

const drags = (page: Page) => page.evaluate(() => window.__tote.backend.data.windowDrags ?? 0);
const zooms = (page: Page) => page.evaluate(() => window.__tote.backend.data.windowZooms ?? 0);
const toggle = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const head = (page: Page) => page.locator(".sidebar-head");
const titles = (page: Page) => page.locator(".tab .tab-title");

/** Waits for the column to have slid to `width` (0 collapsed, 240 expanded): the panes, their tab
 * bars and the lead move with it until then. */
async function slid(page: Page, width: number): Promise<void> {
  await expect
    .poll(() => page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().width))
    .toBe(width);
}

/** A point of the sidebar's top row with nothing under it: between the app's name (or, where it is
 * not shown, the row's left edge) and the collapse button. */
async function sidebarFree(page: Page): Promise<{ x: number; y: number }> {
  const row = await boxOf(head(page));
  const button = await boxOf(head(page).locator(".sidebar-toggle"));
  const name = page.locator(".sidebar-head .app-name");
  const from = (await name.isVisible())
    ? await name.boundingBox().then((box) => box!.x + box!.width)
    : row.x;
  return { x: (from + button.x) / 2, y: row.y + row.height / 2 };
}

/** A point of `tabBar` with no tab under it: right of its last tab, or its middle when it has none. */
async function tabBarFree(tabBar: Locator): Promise<{ x: number; y: number }> {
  const bar = await boxOf(tabBar);
  const tabs = tabBar.locator(".tab");
  const count = await tabs.count();
  const from = count ? await boxOf(tabs.nth(count - 1)).then((box) => box.x + box.width) : bar.x;
  expect(bar.x + bar.width - from).toBeGreaterThan(40);
  return { x: (from + bar.x + bar.width) / 2, y: bar.y + bar.height / 2 };
}

async function press(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
}

test("on macOS the top row leaves the traffic lights their room and names the app", async ({
  page,
}) => {
  await start(page, { ...mac, ...twoTabs });
  await expect(titles(page)).toHaveText(["가", "나"]);
  await expect(page.locator("html")).toHaveClass(/\bmac-titlebar\b/);
  const name = page.locator(".sidebar-head .app-name");
  await expect(name).toBeVisible();
  await expect(name).toHaveText("Tote Notes");
  expect(Number(await name.evaluate((el) => getComputedStyle(el).fontWeight))).toBeGreaterThan(599);
  expect((await boxOf(name)).x).toBeGreaterThanOrEqual(80);
  const rows = await Promise.all([boxOf(head(page)), boxOf(page.locator(".pane-head"))]);
  expect(rows.map((row) => row.height)).toEqual([36, 36]);

  await toggle(page, COLLAPSE).click();
  await slid(page, 0);
  const expand = page.locator(".tab-lead").getByRole("button", { name: EXPAND, exact: true });
  await expect(expand).toBeVisible();
  const button = await boxOf(expand);
  expect(button.x).toBeGreaterThanOrEqual(80);
  expect((await boxOf(page.locator(".tab").first())).x).toBeGreaterThanOrEqual(
    button.x + button.width,
  );
});

test("a press on the top row's free space drags the window, and nowhere else", async ({ page }) => {
  await start(page, { ...mac, ...twoTabs });
  await expect(titles(page)).toHaveText(["가", "나"]);
  await press(page, await sidebarFree(page));
  await expect.poll(() => drags(page)).toBe(1);
  await press(page, await centre(page.locator(".sidebar-head .app-name")));
  await expect.poll(() => drags(page)).toBe(2);
  await toggle(page, COLLAPSE).click();
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  expect(await drags(page)).toBe(2);

  await toggle(page, EXPAND).click();
  await slid(page, 240);
  await press(page, await tabBarFree(page.locator(".tabbar")));
  await expect.poll(() => drags(page)).toBe(3);
  await press(page, await centre(page.locator(".tab-label", { hasText: "나" })));
  await expect(page.locator(".tab.active .tab-title")).toHaveText("나");
  await press(page, await centre(page.locator(".cm-content")));
  await press(page, await centre(page.locator(".statusbar")));
  expect(await drags(page)).toBe(3);
});

test("pressing the tab bar's free space still focuses that pane", async ({ page }) => {
  await start(page, { ...mac, ...twoTabs });
  await expect(titles(page)).toHaveText(["가", "나"]);
  await menu(page, "split-pane");
  const [left, right] = await panesByPosition(page);
  await expect(right).toHaveClass(/\bfocused\b/);
  await press(page, await tabBarFree(left.locator(".tabbar")));
  await expect(left).toHaveClass(/\bfocused\b/);
  await expect(right).not.toHaveClass(/\bfocused\b/);
  await expect.poll(() => drags(page)).toBe(1);
});

test("a lower pane's tab bar does not drag the window", async ({ page }) => {
  await start(page, { ...mac, ...twoTabs });
  await expect(titles(page)).toHaveText(["가", "나"]);
  await menu(page, "split-pane-down");
  const [upper, lower] = await panesByPosition(page);
  await expect(lower).toHaveClass(/\bfocused\b/);
  await press(page, await tabBarFree(lower.locator(".tabbar")));
  await expect(lower).toHaveClass(/\bfocused\b/);
  expect(await drags(page)).toBe(0);
  await press(page, await tabBarFree(upper.locator(".tabbar")));
  await expect(upper).toHaveClass(/\bfocused\b/);
  await expect.poll(() => drags(page)).toBe(1);

  // The upper pane is focused: it is the one split, and its right half is on the top line too.
  await menu(page, "split-pane");
  await expect(page.locator(".pane")).toHaveCount(3);
  const [, upperRight] = await panesByPosition(page);
  await press(page, await tabBarFree(upperRight.locator(".tabbar")));
  await expect.poll(() => drags(page)).toBe(2);
});

test("the lead's free space drags the window and its button does not", async ({ page }) => {
  await start(page, { ...mac, ...twoTabs });
  await expect(titles(page)).toHaveText(["가", "나"]);
  await toggle(page, COLLAPSE).click();
  await slid(page, 0);
  const room = page.locator(".tab-lead .traffic-lights-room");
  await expect(room).toBeVisible();
  await press(page, await centre(room));
  await expect.poll(() => drags(page)).toBe(1);
  await press(page, await centre(toggle(page, EXPAND)));
  await expect(page.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);
  expect(await drags(page)).toBe(1);
});

test("a tab dragged across the free space moves the tab, not the window", async ({ page }) => {
  await start(page, { ...mac, ...twoTabs });
  await expect(titles(page)).toHaveText(["가", "나"]);
  const end = await tabBarFree(page.locator(".tabbar"));
  const first = await centre(page.locator(".tab").first());
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  await expect(titles(page)).toHaveText(["나", "가"]);
  expect(await drags(page)).toBe(0);
});

test("double-clicking the sidebar's top row zooms; double-clicking the tab bar's free space opens a tab and does not zoom", async ({
  page,
}) => {
  await start(page, { ...mac, ...twoTabs });
  await expect(titles(page)).toHaveText(["가", "나"]);
  const row = await sidebarFree(page);
  await page.mouse.dblclick(row.x, row.y);
  await expect.poll(() => zooms(page)).toBe(1);

  const bar = await tabBarFree(page.locator(".tabbar"));
  await page.mouse.dblclick(bar.x, bar.y);
  await expect(titles(page)).toHaveCount(3);
  expect(await zooms(page)).toBe(1);
  await expect(page.locator("[data-tauri-drag-region]")).toHaveCount(0);

  // Moved between the second press and its release: no zoom, as Tauri's drag.js has it.
  await page.mouse.move(row.x, row.y);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(row.x + 5, row.y);
  await page.mouse.up({ clickCount: 2 });
  expect(await zooms(page)).toBe(1);
});

test("not on macOS nothing drags or zooms the window", async ({ page }) => {
  await start(page, twoTabs);
  await expect(titles(page)).toHaveText(["가", "나"]);
  await expect(page.locator("html")).not.toHaveClass(/\bmac-titlebar\b/);
  await press(page, await sidebarFree(page));
  await press(page, await tabBarFree(page.locator(".tabbar")));
  const row = await sidebarFree(page);
  await page.mouse.dblclick(row.x, row.y);
  const bar = await tabBarFree(page.locator(".tabbar"));
  await page.mouse.dblclick(bar.x, bar.y);
  await expect(titles(page)).toHaveCount(3);
  expect(await drags(page)).toBe(0);
  expect(await zooms(page)).toBe(0);
});
