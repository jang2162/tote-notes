import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { quietErrors, start } from "./helpers";

const WRITE_FAILED = "no space left on device";

/** Opens 장보기 with every memo write failing and types behind its text. */
async function typeWhileWritesFail(page: Page): Promise<void> {
  await quietErrors(page, WRITE_FAILED);
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") }, failWrites: 1000 });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toContainText("우유");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 계란");
}

test("a failing save marks the tab and keeps the text", async ({ page }) => {
  await typeWhileWritesFail(page);
  const tab = page.locator(".tab.active");
  await expect(tab).toHaveClass(/\bfailed\b/);
  const marker = () =>
    tab.locator(".tab-title").evaluate((el) => getComputedStyle(el, "::after").content);
  expect(await marker()).toBe('" ⚠"');
  await expect(tab).toHaveAttribute("title", new RegExp(WRITE_FAILED));
  const message = page.locator(".status-message");
  await expect(message).toHaveText(`오류: ${WRITE_FAILED}`);
  await expect(message).toHaveClass(/error/);
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("우유");
});

// Asking before the quit, and 「취소」 keeping tote running, happen in Rust's dialog, which the fake
// backend cannot reach: `a_blocked_round_ends_with_a_cancel` (flush.rs) pins the round, and the
// safety-net smoke's 「저장 실패·종료 경고」 row checks the dialog in the app.
test("a flush with a failed save answers with the reason", async ({ page }) => {
  await typeWhileWritesFail(page);
  await expect(page.locator(".tab.active")).toHaveClass(/\bfailed\b/);
  await page.evaluate(() => window.__tote.backend.requestFlush(7));
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed))
    .toEqual([{ id: 7, blocked: "저장하지 못한 메모 1개" }]);
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
});

test("a flush with everything saved answers without a reason", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toContainText("우유");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 계란");
  await page.evaluate(() => window.__tote.backend.requestFlush(7));
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed))
    .toEqual([{ id: 7 }]);
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("우유 계란");
  await expect(page.locator(".tab.active")).not.toHaveClass(/\bfailed\b/);
});
