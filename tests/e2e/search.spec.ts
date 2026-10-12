import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { menu, start } from "./helpers";

// The workspace search panel (spec 「워크스페이스 검색」) on the fake backend, whose search walks
// the memos in seed order — so the groups arrive in that order here, unlike the app's.

async function openSearch(page: Page): Promise<void> {
  await menu(page, "search-workspace");
  await expect(page.locator(".search-input")).toBeFocused();
}

const lastQuery = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.workspaceSearchCalls?.at(-1)?.query);

test("⇧⌘F shows the search panel and Esc brings the memo list back", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "foo") }, searchDelayMs: 300 });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".memo-pane")).toBeVisible();
  await expect(page.locator(".search-panel")).toBeHidden();
  await openSearch(page);
  await expect(page.locator(".search-panel")).toBeVisible();
  await expect(page.locator(".memo-pane")).toBeHidden();
  await page.keyboard.type("foo");
  await expect(page.locator(".search-status")).toHaveText("검색 중…");
  await page.keyboard.press("Escape");
  await expect(page.locator(".memo-pane")).toBeVisible();
  await expect(page.locator(".search-panel")).toBeHidden();
  await expect(page.locator(".cm-content")).toBeFocused();
  // The search still running stops: the panel is closed, nobody reads its results.
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.workspaceSearchCancelled ?? 0))
    .toBe(1);
  // Opened again, the panel runs the search it dropped.
  await openSearch(page);
  await expect(page.locator(".search-status")).toHaveText("1개 파일에서 1개");
  expect(await page.evaluate(() => window.__tote.backend.data.workspaceSearchCalls?.length)).toBe(
    2,
  );
});

test("results stream in grouped by memo and open at the match", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "foo one\nbar\nfoo two"),
      b: fakeMemo("나.md", "nothing here"),
      c: fakeMemo("다.txt", "x\nzz foo\ny\n  foo end"),
    },
  });
  await openSearch(page);
  await page.keyboard.type("foo");
  const groups = page.locator(".search-file");
  await expect(groups).toHaveCount(2);
  await expect(groups.locator(".search-file-title")).toHaveText(["가", "다.txt"]);
  await expect(page.locator(".search-status")).toHaveText("2개 파일에서 4개");
  // Each match shows its line number, its line and the lines around it. `y` is the context of
  // both of 다's matches but comes once, as the first one's: the group still reads like the file.
  const second = groups.nth(1).locator(".search-match").nth(1);
  await expect(second.locator(".search-line.hit .search-line-number")).toHaveText("4");
  await expect(second.locator(".search-line.hit .search-line-text")).toHaveText("  foo end");
  await expect(groups.nth(1).locator(".search-line-number")).toHaveText(["1", "2", "3", "4"]);
  await expect(groups.nth(1).locator(".search-line.context .search-line-text")).toHaveText([
    "x",
    "y",
  ]);
  await second.click();
  await expect(page.locator(".tab.active .tab-title")).toHaveText("다.txt");
  await expect(page.locator(".status-position")).toHaveText("줄 4, 열 3");
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("typing again cancels the previous search", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "fox"), b: fakeMemo("나.md", "foo") },
    searchDelayMs: 300,
  });
  await openSearch(page);
  await page.keyboard.type("fo");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.workspaceSearchCalls?.length), {
      intervals: [10],
    })
    .toBe(1);
  await page.keyboard.type("o");
  await expect(page.locator(".search-status")).toHaveText("1개 파일에서 1개");
  await expect(page.locator(".search-file-title")).toHaveText(["나"]);
  expect(await lastQuery(page)).toEqual({ query: "foo", caseSensitive: false, regex: false });
  expect(
    await page.evaluate(() => window.__tote.backend.data.workspaceSearchCancelled ?? 0),
  ).toBeGreaterThanOrEqual(1);
});

test("a bad regex says so and the next keystroke searches again", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "foo") } });
  await openSearch(page);
  await page.locator(".search-toggle-regex").click();
  await page.locator(".search-input").focus();
  await page.keyboard.type("(");
  await expect(page.locator(".search-status")).toHaveText("잘못된 정규식");
  await expect(page.locator(".search-file")).toHaveCount(0);
  await page.keyboard.type(")");
  await expect(page.locator(".search-file")).toHaveCount(1);
  await expect(page.locator(".search-status")).toHaveText("1개 파일에서 1개");
});

test("case and regex toggles change the query sent", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "Foo") } });
  await openSearch(page);
  await page.keyboard.type("Foo");
  await expect
    .poll(() => lastQuery(page))
    .toEqual({
      query: "Foo",
      caseSensitive: false,
      regex: false,
    });
  const caseToggle = page.locator(".search-toggle-case");
  await caseToggle.click();
  await expect(caseToggle).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => lastQuery(page))
    .toEqual({
      query: "Foo",
      caseSensitive: true,
      regex: false,
    });
  const regexToggle = page.locator(".search-toggle-regex");
  await regexToggle.click();
  await expect(regexToggle).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => lastQuery(page))
    .toEqual({
      query: "Foo",
      caseSensitive: true,
      regex: true,
    });
  await caseToggle.click();
  await expect(caseToggle).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() => lastQuery(page))
    .toEqual({
      query: "Foo",
      caseSensitive: false,
      regex: true,
    });
});

test("too many results say so", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", Array.from({ length: 2001 }, () => "foo").join("\n")) },
  });
  await openSearch(page);
  await page.keyboard.type("foo");
  await expect(page.locator(".search-status")).toHaveText("결과가 많아 일부만 보입니다");
  // The backend's cap of one file (`MAX_MATCHES_PER_FILE` in src-tauri/src/search/mod.rs).
  await expect(page.locator(".search-match")).toHaveCount(200);
});
