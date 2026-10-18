import { expect, test, type Page } from "@playwright/test";

import { LONG_LINE_LIMIT } from "../../src/app/docs";
import { fakeMemo } from "../../src/backend/fake";
import { menu, paneSession, start } from "./helpers";

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

test("a cancelled search's late results stay out of the new one", async ({ page }) => {
  // As in the app: the memo a search had taken when the next one came is still sent.
  await start(page, {
    memos: { a: fakeMemo("가.md", "fox"), b: fakeMemo("나.md", "foo") },
    searchDelayMs: 300,
    searchFinishesTakenMemo: true,
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
  // The first search did send 가 after the second began; the panel left it out.
  expect(await page.evaluate(() => window.__tote.backend.data.workspaceSearchLateFiles ?? 0)).toBe(
    1,
  );
});

test("a result opens from the keyboard", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "foo one"), c: fakeMemo("다.txt", "x\n  foo end") },
  });
  await openSearch(page);
  await page.keyboard.type("foo");
  const row = page.locator(".search-file").nth(1).locator(".search-match");
  await expect(row).toHaveAttribute("role", "button");
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("다.txt");
  await expect(page.locator(".status-position")).toHaveText("줄 2, 열 3");
});

test("a result in a memo shown in preview puts the cursor there for ⇧⌘V", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "# 제목\n\n둘째 foo") } });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await menu(page, "toggle-preview");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  await openSearch(page);
  await page.keyboard.type("foo");
  await page.locator(".search-match").click();
  // The preview stays; the editor opens at the match.
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  await menu(page, "toggle-preview");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  await expect(page.locator(".status-position")).toHaveText("줄 3, 열 4");
});

test("a result in a memo the large text viewer shows opens at its line", async ({ page }) => {
  const rows = Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n");
  await start(page, {
    memos: { a: fakeMemo("long.txt", `${"L".repeat(LONG_LINE_LIMIT + 1)}\n${rows}\nneedle here`) },
  });
  await openSearch(page);
  await page.keyboard.type("needle");
  const result = page.locator(".search-match");
  // The viewer opens after the click is handled, as in the app where a scan takes its time: the
  // line waits for it.
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const scan = backend.scanText.bind(backend);
    backend.scanText = async (source) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return scan(source);
    };
  });
  await result.click();
  const current = page.locator(".large-text .large-text-line.current");
  await expect(current).toHaveText("needle here");
  // Already on show, the viewer moves at once.
  await page.evaluate(() => window.__tote.app.largeText!.viewer.goToLine(0));
  await expect(current).not.toHaveText("needle here");
  await result.click();
  await expect(current).toHaveText("needle here");
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

test("a found line opens in the pane the tab lands in", async ({ page }) => {
  const rows = Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n");
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "첫째", { modifiedMs: 3 }),
      b: fakeMemo("나.md", "둘째", { modifiedMs: 2 }),
      long: fakeMemo("long.txt", `${"L".repeat(LONG_LINE_LIMIT + 1)}\n${rows}\nneedle here`),
    },
    session: paneSession([[{ kind: "memo", memoId: "a" }], [{ kind: "memo", memoId: "b" }]]),
  });
  await expect(page.locator(".pane")).toHaveCount(2);
  await openSearch(page);
  await page.keyboard.type("needle");
  const result = page.locator(".search-match");
  await expect(result).toHaveCount(1);
  // The claim is on its way when the person picks the other pane: the tab lands there.
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const claim = backend.claimTabs.bind(backend);
    backend.claimTabs = async (tabs, reveal) => {
      await new Promise<void>((resolve) => Object.assign(window, { releaseClaim: resolve }));
      return claim(tabs, reveal);
    };
  });
  await result.click();
  await page.locator(".pane").nth(1).locator(".cm-content").click();
  await expect(page.locator(".pane.focused")).toHaveCount(1);
  await expect(page.locator(".pane").nth(1)).toHaveClass(/\bfocused\b/);
  // The claim is held once the fake has been asked for it.
  await expect.poll(() => page.evaluate(() => "releaseClaim" in window)).toBe(true);
  await page.evaluate(() => (window as unknown as { releaseClaim: () => void }).releaseClaim());
  await expect(
    page.locator(".pane").nth(1).locator(".large-text .large-text-line.current"),
  ).toHaveText("needle here");
  // Nothing is left waiting in the pane it was asked from.
  expect(await page.evaluate(() => window.__tote.app.panes[0].pendingLine)).toBeNull();
});
