import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { start } from "./helpers";

const LISTING_FAILED = "the workspace could not be read";

/** The app logs each error it reports; the ones a test makes on purpose stay out of the output.
 * Vite's client wraps `console.error` to forward it to the dev server's log, so the filter stays
 * outermost: whatever is assigned later goes under it. */
async function quietErrors(page: Page, ...expected: string[]): Promise<void> {
  await page.addInitScript((expected) => {
    let inner = console.error.bind(console);
    const filtered = (...args: unknown[]) => {
      if (!args.some((arg) => expected.some((text) => String(arg).includes(text)))) inner(...args);
    };
    Object.defineProperty(console, "error", {
      configurable: true,
      get: () => filtered,
      set: (next: typeof console.error) => {
        inner = next;
      },
    });
  }, expected);
}

const twoTabSession = JSON.stringify({
  version: 1,
  activeTab: 1,
  tabs: [
    { kind: "memo", memoId: "a" },
    { kind: "memo", memoId: "b" },
  ],
});

test("a failed memo listing at start keeps the session file as it was", async ({ page }) => {
  const session = twoTabSession;
  await quietErrors(page, LISTING_FAILED);
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session,
    failListMemos: 1,
  });
  const message = page.locator(".status-message");
  await expect(message).toHaveText(`오류: ${LISTING_FAILED}`);
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

test("a deferred restore that fails is tried again by the next listing", async ({ page }) => {
  await quietErrors(page, LISTING_FAILED, "the session could not be read");
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: twoTabSession,
    failListMemos: 1,
  });
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const read = backend.readSession.bind(backend);
    let failures = 1;
    backend.readSession = async () => {
      if (failures-- > 0) throw new Error("the session could not be read");
      return read();
    };
  });
  const message = page.locator(".status-message");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(message).toHaveText("오류: the session could not be read");
  await expect(page.locator(".tab")).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await page.locator(".tab", { hasText: "가" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(window.__tote.backend.data.session ?? "null")?.activeTab),
    )
    .toBe(0);
});

test("a CLI failure stays in the status bar after the opens of the same request", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째") } });
  // `tote -i 없는.txt 가.md`: the failure is queued first, the memo it made after it.
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    backend.data.pending.push(
      { kind: "notice", message: "/없는.txt 를 가져오지 못했습니다: not found" },
      { kind: "memo", id: "a" },
    );
    backend.poke();
  });
  await expect(page.locator(".cm-content")).toHaveText("첫째");
  const message = page.locator(".status-message");
  await expect(message).toHaveText("/없는.txt 를 가져오지 못했습니다: not found");
  await expect(message).toHaveClass(/error/);
});
