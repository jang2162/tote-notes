import { expect, test, type Locator, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { menu, paneSession, start } from "./helpers";

// How the tab bar meets the editor (사용자 결정(2026-11-18): UI 점검 시안): no focus ring round the
// editor, a line under the bar that the active tab covers, and a line on top of the active tab.

const memos = {
  a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }),
  b: fakeMemo("나.md", "둘째", { modifiedMs: 1 }),
};
const twoTabs = paneSession([
  [
    { kind: "memo", memoId: "a" },
    { kind: "memo", memoId: "b" },
  ],
]);

/** What `value` (a colour, `var(--accent)` say) comes to on this page, as computed styles say it. */
function colour(page: Page, value: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.body.appendChild(document.createElement("div"));
    probe.style.color = value;
    const got = getComputedStyle(probe).color;
    probe.remove();
    return got;
  }, value);
}

const style = (locator: Locator, property: string) =>
  locator.evaluate((el, property) => getComputedStyle(el).getPropertyValue(property), property);

/** A computed `box-shadow` of one inset line: its colour, then its x and y offsets. */
const insetLine = (rgb: string, y: number) => `${rgb} 0px ${y}px 0px 0px inset`;

for (const scheme of ["light", "dark"] as const) {
  test(`the focused editor has no ring and the active tab runs into it (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await start(page, { memos, session: twoTabs });
    const editor = page.locator(".cm-editor");
    await page.locator(".cm-content").click();
    await expect(editor).toHaveClass(/\bcm-focused\b/);
    expect(await style(editor, "outline-style")).toBe("none");

    const border = await colour(page, "var(--border)");
    const accent = await colour(page, "var(--accent)");
    const bar = page.locator(".tabbar");
    const active = page.locator(".tab.active");
    const other = page.locator(".tab:not(.active)");
    expect(await style(bar, "box-shadow")).toBe(insetLine(border, -1));
    expect(await style(active, "box-shadow")).toBe(insetLine(accent, 2));
    // The line shows under the other tab, and the active one covers it down to the bar's foot.
    expect(await style(other, "background-color")).toBe("rgba(0, 0, 0, 0)");
    expect(await style(active, "background-color")).toBe(await colour(page, "var(--bg)"));
    const [barBox, tabBox] = await Promise.all([bar.boundingBox(), active.boundingBox()]);
    expect(tabBox!.y + tabBox!.height).toBeCloseTo(barBox!.y + barBox!.height, 1);
    // The head row has no border under the bar, which no tab could cover.
    expect(await style(page.locator(".pane-head"), "border-bottom-width")).toBe("0px");
  });
}

test("an inactive tab takes the text colour under the pointer", async ({ page }) => {
  await start(page, { memos, session: twoTabs });
  const other = page.locator(".tab:not(.active)");
  expect(await style(other, "color")).toBe(await colour(page, "var(--muted)"));
  await other.hover();
  await expect.poll(() => style(other, "color")).toBe(await colour(page, "var(--fg)"));
});

test("with panes side by side only the focused pane's active tab has the line", async ({
  page,
}) => {
  await start(page, { memos, session: twoTabs });
  await menu(page, "split-pane");
  const panes = page.locator(".pane");
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1)).toHaveClass(/\bfocused\b/);
  const accent = await colour(page, "var(--accent)");
  expect(await style(panes.nth(1).locator(".tab.active"), "box-shadow")).toBe(insetLine(accent, 2));
  expect(await style(panes.nth(0).locator(".tab.active"), "box-shadow")).toBe("none");
});

test("a bar's drop mark and a dragged tab keep their lines over the bar's", async ({ page }) => {
  await start(page, { memos, session: twoTabs });
  const border = await colour(page, "var(--border)");
  const accent = await colour(page, "var(--accent)");
  const bar = page.locator(".tabbar");
  // The classes the drag sets (`TabBar`), set here: what is looked at is the cascade, not the drag.
  await bar.evaluate((el) => el.classList.add("drop-into"));
  expect(await style(bar, "box-shadow")).toBe(insetLine(accent, -2));
  const other = page.locator(".tab:not(.active)");
  await other.evaluate((el) => el.classList.add("dragging"));
  expect(await style(other, "background-color")).toBe(await colour(page, "var(--sidebar-bg)"));
  expect(await style(other, "box-shadow")).toBe(insetLine(border, -1));
});
