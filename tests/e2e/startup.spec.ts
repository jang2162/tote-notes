import { expect, test } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { start } from "./helpers";

test("a failed memo listing at start keeps the session file as it was", async ({ page }) => {
  const session = JSON.stringify({
    version: 1,
    activeTab: 1,
    tabs: [
      { kind: "memo", memoId: "a" },
      { kind: "memo", memoId: "b" },
    ],
  });
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session,
    failListMemos: 1,
  });
  const message = page.locator(".status-message");
  await expect(message).toHaveText("오류: the workspace could not be read");
  await expect(message).toHaveClass(/error/);
  // A flush (window close, quit) and hiding the window are what write the session.
  await page.evaluate(() => window.__tote.backend.requestFlush(1));
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.flushed)).toEqual([1]);
  await page.evaluate(() => window.__tote.app.flushAll());
  expect(await page.evaluate(() => window.__tote.backend.data.session)).toBe(session);

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("나");
  await expect(message).not.toHaveClass(/error/);
  // From here on the session is written.
  await page.locator(".tab", { hasText: "가" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(window.__tote.backend.data.session ?? "null")?.activeTab),
    )
    .toBe(0);
});

test("a CLI failure shows in the status bar", async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.__tote.backend.notice("워크스페이스가 없습니다: 없는곳"));
  const message = page.locator(".status-message");
  await expect(message).toHaveText("워크스페이스가 없습니다: 없는곳");
  await expect(message).toHaveClass(/error/);
});
