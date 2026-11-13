import { expect, test, type Page } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, openShopping, quietErrors, start, typeWhileChangedElsewhere } from "./helpers";

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
  // On the role=tab label, as its description: the close button beside it has its own.
  await expect(tab.getByRole("tab")).toHaveAttribute("title", new RegExp(WRITE_FAILED));
  await expect(tab.getByRole("tab")).toHaveAccessibleDescription(new RegExp(WRITE_FAILED));
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

/** Makes the fake's memo writes (`writeMemo`, and `importMemo`, which keeps a conflict's 「내
 * 버전」) wait until the returned function is called: a write to a volume that stopped answering
 * does not end. */
async function holdWrites(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const backend = window.__tote.backend as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const held = new Promise<void>((resolve) => Object.assign(window, { releaseWrites: resolve }));
    for (const name of ["writeMemo", "importMemo"]) {
      const call = backend[name];
      backend[name] = async (...args) => {
        await held;
        return call.apply(backend, args);
      };
    }
  });
  return () =>
    page.evaluate(() => (window as unknown as { releaseWrites(): void }).releaseWrites());
}

const UNWRITTEN = "저장하지 못한 메모 1개";
const flushed = (page: Page) => page.evaluate(() => window.__tote.backend.data.flushed);
const saidWriting = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.flushWriting ?? []);

// The round's timeout and the question it ends with are Rust's
// (`a_window_still_writing_at_the_timeout_asks`, flush.rs). What the page owes them is to say what
// is only in memory before the write that may never end.
test("a flush says what is only in memory before a write that does not end", async ({ page }) => {
  await openShopping(page);
  const release = await holdWrites(page);
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 계란");
  await page.evaluate(() => window.__tote.backend.requestFlush(7, "close"));
  await expect.poll(() => saidWriting(page)).toEqual([{ id: 7, unwritten: UNWRITTEN }]);
  // Still writing: no answer, and the window has not let go of its tab — 「취소」 to the question
  // leaves it as it is.
  expect(await flushed(page)).toEqual([]);
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  await release();
  await expect.poll(() => flushed(page)).toEqual([{ id: 7 }]);
  // Taken back once the tabs were written, before the answer: what the window may still wait on
  // then (a tab being handed to it) holds no text.
  expect(await saidWriting(page)).toEqual([{ id: 7, unwritten: UNWRITTEN }, { id: 7 }]);
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("우유 계란");
});

test("a flush with nothing to write says nothing first", async ({ page }) => {
  await openShopping(page);
  await page.evaluate(() => window.__tote.backend.requestFlush(7, "close"));
  await expect.poll(() => flushed(page)).toEqual([{ id: 7 }]);
  expect(await saidWriting(page)).toEqual([]);
});

// The file holds the other app's text, and 「내 버전」 is in no file until the flush writes it as a
// new memo.
test("a flush counts a conflict nobody answered among what is only in memory", async ({ page }) => {
  await typeWhileChangedElsewhere(page);
  await expect(page.locator(".banner")).toBeVisible();
  const release = await holdWrites(page);
  await page.evaluate(() => window.__tote.backend.requestFlush(7));
  await expect.poll(() => saidWriting(page)).toEqual([{ id: 7, unwritten: UNWRITTEN }]);
  expect(await flushed(page)).toEqual([]);
  await release();
  await expect.poll(() => flushed(page)).toEqual([{ id: 7 }]);
  const text = (file: string) =>
    page.evaluate((f) => window.__tote.backend.memoTextByFile(f), file);
  expect(await text("장보기.md")).toBe("두유");
  expect(await text("장보기 2.md")).toBe("우유 계란");
});

// The watcher has not reported the other app's write, so no banner asks yet: the save the flush
// starts with is the first to meet it. A refused save is not a failed one — the round keeps both
// texts as it does for a conflict left open, and answers without a reason to ask about.
test("a flush whose save is the first to meet another app's text keeps both before it answers", async ({
  page,
}) => {
  await typeWhileChangedElsewhere(page, { heard: false });
  const release = await holdWrites(page);
  await page.evaluate(() => window.__tote.backend.requestFlush(7));
  await expect.poll(() => saidWriting(page)).toEqual([{ id: 7, unwritten: UNWRITTEN }]);
  // 「내 버전」 is in no file yet: no answer.
  expect(await flushed(page)).toEqual([]);
  await release();
  await expect.poll(() => flushed(page)).toEqual([{ id: 7 }]);
  expect(await saidWriting(page)).toEqual([{ id: 7, unwritten: UNWRITTEN }, { id: 7 }]);
  const text = (file: string) =>
    page.evaluate((f) => window.__tote.backend.memoTextByFile(f), file);
  expect(await text("장보기.md")).toBe("두유");
  expect(await text("장보기 2.md")).toBe("우유 계란");
});

// A draft that failed has left the scheduler's slot empty: nothing waits to be written, yet the
// edits are only in memory, and the flush tries once more.
test("a flush counts a tab whose save failed among what is only in memory", async ({ page }) => {
  await quietErrors(page, WRITE_FAILED);
  await start(page, { files: { "/x/a.sh": fakeFile("echo hi\n") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".cm-content")).toContainText("echo hi");
  await page.evaluate((message) => {
    window.__tote.backend.keepExternalDraft = () => Promise.reject(new Error(message));
  }, WRITE_FAILED);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("echo more");
  await expect(page.locator(".tab.active")).toHaveClass(/\bfailed\b/);
  // From here the draft's write does not end.
  await page.evaluate(() => {
    window.__tote.backend.keepExternalDraft = () => new Promise(() => {});
  });
  await page.evaluate(() => window.__tote.backend.requestFlush(7));
  await expect.poll(() => saidWriting(page)).toEqual([{ id: 7, unwritten: UNWRITTEN }]);
  expect(await flushed(page)).toEqual([]);
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

test("an external draft kept on a retry takes its error off the status bar", async ({ page }) => {
  await quietErrors(page, WRITE_FAILED);
  await start(page, { files: { "/x/a.sh": fakeFile("echo hi\n") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".cm-content")).toContainText("echo hi");
  await page.evaluate((message) => {
    const backend = window.__tote.backend;
    const keep = backend.keepExternalDraft.bind(backend);
    backend.keepExternalDraft = (path, bytes) =>
      window.__toteBroken ? Promise.reject(new Error(message)) : keep(path, bytes);
    window.__toteBroken = true;
  }, WRITE_FAILED);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("echo more");
  const message = page.locator(".status-message");
  await expect(page.locator(".tab.active")).toHaveClass(/\bfailed\b/);
  await expect(message).toHaveText(`오류: ${WRITE_FAILED}`);
  await page.evaluate(() => {
    window.__toteBroken = false;
  });
  await expect(page.locator(".tab.active")).not.toHaveClass(/\bfailed\b/, { timeout: 10_000 });
  await expect(message).toHaveText("");
});
