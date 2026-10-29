import { expect, test, type Page } from "@playwright/test";

import { defaultFakeData, fakeMemo } from "../../src/backend/fake";
import { boxOf, centre, menu, start } from "./helpers";

// Collapsing the sidebar and bringing it back (spec 「사이드바 접기」): the button at the right end
// of the sidebar's top row, the one in front of the top left pane's tab bar while it is collapsed
// (the lead), and the menu's toggle-sidebar. Laid out as not on macOS: the fake opens no macOS
// window unless seeded with `macTitlebar`.

const COLLAPSE = "사이드바 접기";
const EXPAND = "사이드바 펼치기";

const toggle = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const lead = (page: Page) => page.locator(".tab-lead");
const leadButton = (page: Page) => lead(page).locator("button");
const sidebarWidth = (page: Page) =>
  page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().width);
/** The x of the pane furthest left. */
const firstPaneX = (page: Page) =>
  page
    .locator(".pane")
    .evaluateAll((els) => Math.min(...els.map((el) => el.getBoundingClientRect().x)));
const titles = (page: Page) => page.locator(".tab .tab-title");

const memos = {
  a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }),
  b: fakeMemo("나.md", "둘째", { modifiedMs: 1 }),
};

async function open(page: Page, title: string): Promise<void> {
  await page.locator(".memo-row", { hasText: title }).click();
  await expect(page.locator(".tab.active .tab-title")).toHaveText(title);
}

async function expectCollapsed(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
  await expect.poll(() => sidebarWidth(page)).toBe(0);
  await expect.poll(() => firstPaneX(page)).toBe(0);
  await expect(lead(page)).toBeVisible();
  await expect(lead(page).getByRole("button", { name: EXPAND, exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
}

async function expectExpanded(page: Page): Promise<void> {
  await expect(page.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);
  await expect(page.locator(".sidebar")).not.toHaveAttribute("inert");
  await expect.poll(() => sidebarWidth(page)).toBe(240);
  await expect(lead(page)).toBeHidden();
  await expect(toggle(page, COLLAPSE)).toHaveAttribute("aria-expanded", "true");
}

/** The pane holding the lead, as rounded x and y, and how many leads there are. */
const leadPlace = (page: Page) =>
  page.evaluate(() => {
    const leads = document.querySelectorAll(".tab-lead");
    const box = leads[0]?.closest(".pane")?.getBoundingClientRect();
    return {
      leads: leads.length,
      x: box ? Math.round(box.x) : null,
      y: box ? Math.round(box.y) : null,
    };
  });

test("the toggle collapses the sidebar to nothing and the lead's button brings it back", async ({
  page,
}) => {
  await start(page);
  await expectExpanded(page);
  await toggle(page, COLLAPSE).click();
  await expectCollapsed(page);
  await toggle(page, EXPAND).click();
  await expectExpanded(page);
});

test("the menu's toggle collapses and expands", async ({ page }) => {
  await start(page);
  await menu(page, "toggle-sidebar");
  await expectCollapsed(page);
  await menu(page, "toggle-sidebar");
  await expectExpanded(page);
});

test("collapsing takes the keys out of the sidebar to the focused pane", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  // No tab open: the pane itself takes them.
  await page.locator(".memo-filter").focus();
  await expect(page.locator(".memo-filter")).toBeFocused();
  await menu(page, "toggle-sidebar");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.matches(".pane.focused") ?? false))
    .toBe(true);
  await menu(page, "toggle-sidebar");
  await expectExpanded(page);

  await open(page, "장보기");
  await page.locator(".memo-filter").focus();
  await expect(page.locator(".memo-filter")).toBeFocused();
  await menu(page, "toggle-sidebar");
  await expect(page.locator(".cm-content")).toBeFocused();
  // Out of reach while collapsed.
  await page.locator(".memo-filter").evaluate((el: HTMLElement) => el.focus());
  await expect(page.locator(".memo-filter")).not.toBeFocused();
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("expanding with the keys on the lead's button puts them on the sidebar's toggle", async ({
  page,
}) => {
  await start(page);
  await menu(page, "toggle-sidebar");
  await expectCollapsed(page);
  await leadButton(page).focus();
  await page.keyboard.press("Enter");
  await expectExpanded(page);
  await expect(toggle(page, COLLAPSE)).toBeFocused();
});

test("expanding by the menu with the keys on the lead's button puts them on the sidebar's toggle", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  await open(page, "장보기");
  await menu(page, "toggle-sidebar");
  await expectCollapsed(page);
  await leadButton(page).focus();
  await menu(page, "toggle-sidebar");
  await expectExpanded(page);
  await expect(toggle(page, COLLAPSE)).toBeFocused();

  // Anywhere else, expanding leaves the keys where they are.
  await page.locator(".cm-content").focus();
  await menu(page, "toggle-sidebar");
  await expectCollapsed(page);
  await expect(page.locator(".cm-content")).toBeFocused();
  await menu(page, "toggle-sidebar");
  await expectExpanded(page);
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("the toggles name the shortcut they have", async ({ page, context }) => {
  await start(page);
  await expect(toggle(page, COLLAPSE)).toHaveAttribute("title", "사이드바 접기 (⌘B)");
  await menu(page, "toggle-sidebar");
  await expect(toggle(page, EXPAND)).toHaveAttribute("title", "사이드바 펼치기 (⌘B)");

  // ⌘B saved for another command keeps it: the toggle starts with no key.
  const other = await context.newPage();
  await start(other, {
    settings: { ...defaultFakeData().settings, shortcuts: { rename: "CmdOrCtrl+B" } },
  });
  await expect(toggle(other, COLLAPSE)).toHaveAttribute("title", "사이드바 접기");
  await menu(other, "toggle-sidebar");
  await expect(toggle(other, EXPAND)).toHaveAttribute("title", "사이드바 펼치기");
});

test("the top row is one height in the sidebar and in the tab bar", async ({ page }) => {
  await start(page);
  const head = await boxOf(page.locator(".sidebar-head"));
  const paneHead = await boxOf(page.locator(".pane-head"));
  expect([head.height, head.y]).toEqual([36, 0]);
  expect([paneHead.height, paneHead.y]).toEqual([36, 0]);
});

test("not on macOS there is no app name and no room for the traffic lights", async ({ page }) => {
  await start(page);
  await expect(page.locator("html")).not.toHaveClass(/\bmac-titlebar\b/);
  await expect(page.locator(".app-name")).toBeHidden();
  const head = await boxOf(page.locator(".sidebar-head"));
  const own = await boxOf(toggle(page, COLLAPSE));
  expect(head.x + head.width - (own.x + own.width)).toBeLessThanOrEqual(12);

  await menu(page, "toggle-sidebar");
  await expectCollapsed(page);
  const expand = await boxOf(leadButton(page));
  expect(expand.x - (await firstPaneX(page))).toBeLessThanOrEqual(8);
});

test("the lead stays in the top left pane as the panes change", async ({ page }) => {
  await start(page, { memos });
  await open(page, "가");
  await menu(page, "toggle-sidebar");
  await expectCollapsed(page);

  await menu(page, "split-pane");
  await expect(page.locator(".pane")).toHaveCount(2);
  expect(await leadPlace(page)).toEqual({ leads: 1, x: 0, y: 0 });

  // The left pane goes: the one that was right of it is the top left one now.
  await menu(page, "focus-pane-left");
  await menu(page, "close-tab");
  await menu(page, "close-tab");
  await expect(page.locator(".pane")).toHaveCount(1);
  await expect.poll(() => leadPlace(page)).toEqual({ leads: 1, x: 0, y: 0 });
  await expect(page.locator(".pane").locator(".tab-lead")).toHaveCount(1);

  await menu(page, "split-pane-down");
  await expect(page.locator(".pane")).toHaveCount(2);
  expect(await leadPlace(page)).toEqual({ leads: 1, x: 0, y: 0 });
});

test("a tab dropped on the lead goes before the first tab", async ({ page }) => {
  await start(page, { memos });
  await open(page, "가");
  await open(page, "나");
  await expect(titles(page)).toHaveText(["가", "나"]);
  await menu(page, "toggle-sidebar");
  await expectCollapsed(page);

  const from = await centre(page.locator(".tab", { hasText: "나" }));
  const to = await centre(lead(page));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await expect(titles(page)).toHaveText(["나", "가"]);
  await expect(page.locator(".pane")).toHaveCount(1);
});

test("the lead is no tab: the tab list holds tabs and their close buttons only", async ({
  page,
}) => {
  await start(page, { memos });
  await open(page, "가");
  await menu(page, "toggle-sidebar");
  await expectCollapsed(page);
  await expect(page.locator(".tabbar .tab-lead")).toHaveCount(0);
  await expect(page.locator("[role=tablist] button:not(.tab-close)")).toHaveCount(0);
});

test("the column slides for 0.16s, at once with reduced motion, and not at the start", async ({
  page,
  context,
}) => {
  const duration = (on: Page) =>
    on.evaluate(() => getComputedStyle(document.body).transitionDuration);
  await start(page);
  expect(await duration(page)).toBe("0s");
  await menu(page, "toggle-sidebar");
  expect(await duration(page)).toBe("0.16s");

  const reduced = await context.newPage();
  await reduced.emulateMedia({ reducedMotion: "reduce" });
  await start(reduced);
  const after = await reduced.evaluate(() => {
    window.__tote.backend.menu("toggle-sidebar");
    return {
      duration: getComputedStyle(document.body).transitionDuration,
      width: document.querySelector(".sidebar")!.getBoundingClientRect().width,
    };
  });
  expect(after).toEqual({ duration: "0s", width: 0 });
});

test("searching the workspace expands a collapsed sidebar, which stays so after the search closes", async ({
  page,
}) => {
  await start(page);
  await menu(page, "toggle-sidebar");
  await expectCollapsed(page);
  await menu(page, "search-workspace");
  await expectExpanded(page);
  await expect(page.locator(".search-panel")).toBeVisible();
  await expect(page.locator(".search-panel .search-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".memo-pane")).toBeVisible();
  await expectExpanded(page);
});

test("a collapsed narrow window keeps the lead whole and the tab bar scrolling", async ({
  page,
}) => {
  const many = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `m${index}`,
      fakeMemo(`메모 ${index + 1}.md`, String(index), { modifiedMs: 8 - index }),
    ]),
  );
  await page.setViewportSize({ width: 1100, height: 600 });
  await start(page, { memos: many });
  for (let index = 1; index <= 8; index++) await open(page, `메모 ${index}`);
  await menu(page, "toggle-sidebar");
  await expectCollapsed(page);
  const wide = (await boxOf(lead(page))).width;

  await page.setViewportSize({ width: 480, height: 600 });
  await expect.poll(async () => (await boxOf(lead(page))).width).toBe(wide);
  const middle = await centre(leadButton(page));
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? null,
      middle,
    ),
  ).toBe(EXPAND);
  expect(
    await page.locator(".pane-head .tabbar").evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
});

test("two toggles in a row end in the last state", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.__tote.backend.menu("toggle-sidebar");
    window.__tote.backend.menu("toggle-sidebar");
  });
  await expectExpanded(page);
});
