import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { openWindow, start, startWindows } from "./helpers";

// The sidebar's memo list (spec 2026-10-30 「메모 목록 기능 묶음」): renaming from a row's context
// menu, pins, the sort, previews and the filter that finds memos by their content.

const row = (page: Page, name: string) => page.locator(".memo-row", { hasText: name });
const names = (page: Page) => page.locator(".memo-scroller .memo-row .memo-name");
const lastMenu = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.popupMenus?.at(-1) ?? null);

async function renameFromRow(page: Page, from: string, to: string): Promise<void> {
  await row(page, from).click({ button: "right" });
  const input = page.locator(".modal input");
  await expect(input).toBeVisible();
  await input.fill(to);
  await input.press("Enter");
}

test("renaming a memo that is not open from its context menu", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }),
      b: fakeMemo("나.md", "둘째", { modifiedMs: 1, autoTitle: true }),
    },
    popupMenuPick: "rename",
  });
  await renameFromRow(page, "나", "다.md");
  await expect(names(page)).toHaveText(["가", "다"]);
  expect((await lastMenu(page))?.map((item) => item.text)[0]).toBe("이름 바꾸기…");
  const memo = await page.evaluate(() => window.__tote.backend.data.memos.b);
  expect(memo.file).toBe("다.md");
  expect(memo.autoTitle).toBe(false);
  await expect(page.locator(".tab")).toHaveCount(0);
});

test("renaming an open memo from the sidebar saves it first and renames its tab", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째") }, popupMenuPick: "rename" });
  await row(page, "가").click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 더");
  await renameFromRow(page, "가", "라.md");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("라");
  expect(await page.evaluate(() => window.__tote.backend.memoTextByFile("라.md"))).toBe("첫째 더");
});

test("a bad name from the sidebar shows the same error", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", ""), b: fakeMemo("나.md", "") },
    popupMenuPick: "rename",
  });
  await renameFromRow(page, "가", "나.md");
  await expect(page.locator(".status-message")).toHaveText("같은 이름이 이미 있습니다");
  await renameFromRow(page, "가", "a/b");
  await expect(page.locator(".status-message")).toHaveText("쓸 수 없는 이름입니다");
  expect(await page.evaluate(() => window.__tote.backend.data.memos.a.file)).toBe("가.md");
});

test("another window's rename reaches this window's open tab", async ({ context }) => {
  const first = await startWindows(context, {
    memos: { a: fakeMemo("가.md", "첫째", { autoTitle: true }) },
    popupMenuPick: "rename",
  });
  await row(first, "가").click();
  await expect(first.locator(".tab.active .tab-title")).toHaveText("가");
  const second = await openWindow(context, "ws-2");
  await renameFromRow(second, "가", "라.md");
  await expect(first.locator(".tab.active .tab-title")).toHaveText("라");
  // The first window's tab knows the name is the person's now: leaving it asks for no title.
  await first.locator(".cm-content").click();
  await first.keyboard.press("Enter");
  await first.keyboard.insertText("새 줄");
  await expect
    .poll(() => first.evaluate(() => window.__tote.backend.memoTextByFile("라.md")))
    .toBe("첫째\n새 줄");
});
