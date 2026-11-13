import { expect, test, type Page } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, paneSession, start } from "./helpers";

// 빠른 열기 (⌘P) and the command palette (spec 2026-11-14), opened by the menu item's id: e2e
// cannot press a menu shortcut (docs/guides/development.md 「e2e 는 메뉴 단축키를 누르지 못한다」).

const memos = {
  a: fakeMemo("가계부.md", "첫째"),
  b: fakeMemo("회의록.md", "둘째"),
  c: fakeMemo("장보기.md", "셋째"),
};
const memoTab = (memoId: string) => ({ kind: "memo", memoId });

const box = (page: Page) => page.getByRole("dialog", { name: "빠른 열기" });
const input = (page: Page) => box(page).getByRole("combobox");
const rows = (page: Page) => box(page).getByRole("option");
const panes = (page: Page) => page.locator(".pane");
const pane = (page: Page, index: number) => panes(page).nth(index);
const activeTitle = (page: Page, index: number) =>
  pane(page, index).locator(".tab.active .tab-title");

async function openQuick(page: Page): Promise<void> {
  await menu(page, "quick-open");
  await expect(input(page)).toBeFocused();
}

test("the menu item opens it; typed and Enter, the memo opens in the focused pane", async ({
  page,
}) => {
  await start(page, { memos, session: paneSession([[memoTab("a")]]) });
  await expect(activeTitle(page, 0)).toHaveText("가계부");
  await openQuick(page);
  await input(page).fill("회의");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveText("회의록.md");
  await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(rows(page).first().locator("b")).toHaveText(["회의"]);
  await input(page).press("Enter");
  await expect(box(page)).toHaveCount(0);
  await expect(pane(page, 0).locator(".tab .tab-title")).toHaveText(["가계부", "회의록"]);
  await expect(activeTitle(page, 0)).toHaveText("회의록");
  await expect(pane(page, 0).locator(".cm-content")).toHaveText("둘째");
  await expect(pane(page, 0).locator(".cm-content")).toBeFocused();
});

test("a memo open in another pane is shown there, not opened again", async ({ page }) => {
  await start(page, {
    memos,
    session: paneSession([[memoTab("a")], [memoTab("b")]], { focusedPane: 0 }),
  });
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
  await openQuick(page);
  await input(page).fill("회의");
  await input(page).press("Enter");
  await expect(box(page)).toHaveCount(0);
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(pane(page, 0).locator(".tab .tab-title")).toHaveText(["가계부"]);
  await expect(pane(page, 1).locator(".tab .tab-title")).toHaveText(["회의록"]);
  await expect(pane(page, 1).locator(".cm-content")).toBeFocused();
});

test("an external file open in another window is listed with its folder, and shown there", async ({
  page,
}) => {
  await start(page, {
    memos,
    files: { "/srv/deploy/run.sh": fakeFile("echo hi\n") },
    places: { "external:/srv/deploy/run.sh": "ws-9" },
  });
  await openQuick(page);
  await input(page).fill("run");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator(".quick-open-name")).toHaveText("run.sh");
  await expect(rows(page).first().locator(".quick-open-detail")).toHaveText("/srv/deploy");
  await input(page).press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.reveals))
    .toEqual([{ label: "ws-9", tab: { kind: "external", path: "/srv/deploy/run.sh" } }]);
  await expect(page.locator(".tab")).toHaveCount(0);
});

test("a row clicked opens its memo", async ({ page }) => {
  await start(page, { memos });
  await openQuick(page);
  await rows(page).filter({ hasText: "장보기" }).click();
  await expect(box(page)).toHaveCount(0);
  await expect(activeTitle(page, 0)).toHaveText("장보기");
  await expect(page.locator(".cm-content")).toHaveText("셋째");
});

test("Escape closes it and gives the keys back to the editor", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a")]]) });
  await page.locator(".cm-content").click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await openQuick(page);
  await input(page).fill("회의");
  await input(page).press("Escape");
  await expect(box(page)).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".tab .tab-title")).toHaveText(["가계부"]);
});

test("Enter that finishes a composition does not open", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a")]]) });
  await openQuick(page);
  await input(page).fill("회의");
  await input(page).dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(box(page)).toHaveCount(1);
  // WebKit's real case: the composition already ended, only the key code says so.
  await input(page).dispatchEvent("keydown", { key: "Enter", isComposing: false, keyCode: 229 });
  await expect(box(page)).toHaveCount(1);
  await expect(page.locator(".tab .tab-title")).toHaveText(["가계부"]);
  await input(page).press("Enter");
  await expect(box(page)).toHaveCount(0);
  await expect(activeTitle(page, 0)).toHaveText("회의록");
});

test("with nothing typed, the memos most recently viewed come first; ↓ and Enter opens", async ({
  page,
}) => {
  await start(page, {
    memos: {
      a: { ...memos.a, viewedMs: 5 },
      b: { ...memos.b, viewedMs: 9 },
      // Never viewed: counts as viewed when it was last modified.
      c: { ...memos.c, modifiedMs: 7 },
    },
  });
  await openQuick(page);
  await expect(rows(page)).toHaveText(["회의록.md", "장보기.md", "가계부.md"]);
  await input(page).press("ArrowDown");
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "false");
  await input(page).press("ArrowUp");
  await input(page).press("ArrowUp");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await input(page).press("ArrowDown");
  await input(page).press("Enter");
  await expect(activeTitle(page, 0)).toHaveText("장보기");
});

test("nothing matching says so in one line", async ({ page }) => {
  await start(page, { memos });
  await openQuick(page);
  await input(page).fill("없는메모");
  await expect(rows(page)).toHaveCount(0);
  await expect(box(page).locator(".quick-open-none")).toHaveText("일치하는 메모가 없습니다");
  await input(page).press("Enter");
  await expect(box(page)).toHaveCount(1);
  await input(page).fill(">없는명령");
  await expect(box(page).locator(".quick-open-none")).toHaveText("일치하는 명령이 없습니다");
  await input(page).fill("가");
  await expect(box(page).locator(".quick-open-none")).toBeHidden();
});

test("> lists the app commands with their keys, and Enter runs one as its menu item", async ({
  page,
}) => {
  await start(page, { memos, session: paneSession([[memoTab("a")]]) });
  await openQuick(page);
  await input(page).fill(">");
  const all = await rows(page).locator(".quick-open-name").allTextContents();
  expect(all).toContain("새 메모");
  expect(all).toContain("탭을 새 창으로 옮기기");
  expect(all).not.toContain("빠른 열기…");
  await input(page).fill("> 새메모");
  const first = rows(page).first();
  await expect(first.locator(".quick-open-name")).toHaveText("새 메모");
  await expect(first.locator(".quick-open-detail")).toHaveText("파일");
  await expect(first.locator(".quick-open-keys")).toHaveText("⌘N");
  await input(page).press("Enter");
  await expect(box(page)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.menuCommandRuns))
    .toEqual(["new-memo"]);
  await expect(page.locator(".tab")).toHaveCount(2);
});

test("the menu item again while it is open does nothing", async ({ page }) => {
  await start(page, { memos });
  await openQuick(page);
  await input(page).fill("회의");
  await menu(page, "quick-open");
  await expect(box(page)).toHaveCount(1);
  await expect(input(page)).toHaveValue("회의");
});
