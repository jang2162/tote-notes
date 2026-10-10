import { expect, test } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { menu, ready, start } from "./helpers";

test("a new memo is named after its first line once the cursor leaves it", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("# 회의 준비");
  await page.keyboard.press("Enter");
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["회의 준비"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("회의 준비");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("회의 준비.md")))
    .toBe("# 회의 준비\n");
});

test("closing an empty new memo leaves no file behind", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".tab")).toHaveCount(1);
  await menu(page, "close-tab");
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(window.__tote.backend.data.memos))).toEqual([]);
  await expect(page.locator(".editor-placeholder")).toHaveText("⌘N 으로 새 메모를 만드세요");
});

test("restoring a session reads only the active tab", async ({ page }) => {
  const session = {
    version: 1,
    activeTab: 1,
    tabs: [
      { kind: "memo", memoId: "a" },
      { kind: "memo", memoId: "b", selection: { ranges: [{ anchor: 1, head: 1 }], main: 0 } },
    ],
  };
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(session),
  });
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("나");
  expect(await page.evaluate(() => window.__tote.backend.data.reads)).toEqual({ b: 1 });
  expect(await page.evaluate(() => window.__tote.app.view.state.selection.main.head)).toBe(1);
  await page.locator(".tab", { hasText: "가" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.reads))
    .toEqual({ a: 1, b: 1 });
});

test("tabs, the active tab and the cursor come back after a restart", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째 줄\n둘째 줄") } });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await expect(page.locator(".cm-content")).toContainText("둘째 줄");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 6 } }));
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"anchor":6');
  await page.reload();
  await ready(page);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("가");
  expect(await page.evaluate(() => window.__tote.app.view.state.selection.main.head)).toBe(6);
});

test("a flush request writes pending edits and the title before answering", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("급히 끈다");
  await page.evaluate(() => window.__tote.backend.requestFlush(7));
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.flushed)).toEqual([7]);
  const files = await page.evaluate(() =>
    Object.values(window.__tote.backend.data.memos).map((m) => m.file),
  );
  expect(files).toEqual(["급히 끈다.md"]);
  expect(await page.evaluate(() => window.__tote.backend.memoTextByFile("급히 끈다.md"))).toBe(
    "급히 끈다",
  );
  expect(await page.evaluate(() => window.__tote.backend.data.session)).toContain('"kind":"memo"');
});

test("the memo list filters by name", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("회의록.md", ""), b: fakeMemo("장보기.md", "") } });
  await page.locator(".memo-filter").fill("회의");
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["회의록"]);
});

test("a memo the person renamed keeps that name", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("첫 줄");
  await menu(page, "rename");
  const input = page.locator(".modal input");
  await input.fill("목록.txt");
  await input.press("Enter");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("목록.txt");
  // Leaving the title line is when an automatic title would apply.
  await page.keyboard.press("Enter");
  await page.keyboard.type("둘째 줄");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("목록.txt")))
    .toBe("첫 줄\n둘째 줄");
  const files = await page.evaluate(() =>
    Object.values(window.__tote.backend.data.memos).map((m) => m.file),
  );
  expect(files).toEqual(["목록.txt"]);
});

test("a memo gone from disk says so, without 텍스트로 열기", async ({ page }) => {
  const session = {
    version: 1,
    activeTab: 0,
    tabs: [
      { kind: "memo", memoId: "a" },
      { kind: "memo", memoId: "b" },
    ],
  };
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(session),
  });
  // Deleted in Finder while its tab waited to be read.
  await page.evaluate(() => {
    delete window.__tote.backend.data.memos.b;
  });
  await page.locator(".tab", { hasText: "나" }).click();
  await expect(page.locator(".editor-placeholder p")).toHaveText("파일을 찾을 수 없습니다");
  await expect(page.getByRole("button", { name: "텍스트로 열기" })).toHaveCount(0);
});
