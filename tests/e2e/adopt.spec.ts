import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { paneSession, quietErrors, sessionPane, start } from "./helpers";

// A tab another window of the workspace let go over this one (`onAdopt`), on the fake backend:
// the other window is not there, so a test does what it and the native side would — the place
// becomes this window's (`FakeHub.moveTo`), then the page hears the tab.

const LISTING_FAILED = "the workspace could not be read";
const NOT_FOUND = "메모를 찾을 수 없습니다";

/** Hands memo `id`'s tab to the window as the native side would, its place this window's first. */
function adopt(page: Page, id: string): Promise<void> {
  return page.evaluate((memoId) => {
    const { backend } = window.__tote;
    (backend.data.places ??= {})[`memo:${memoId}`] = "ws-1";
    backend.adopt(JSON.stringify({ kind: "memo", memoId }), 10, 10);
  }, id);
}

/** Makes `readWindowLayout` — a restore's first read, before it makes any tab — wait until the
 * page's `releaseLayout` is called; `layoutReads` counts the reads held meanwhile. */
async function holdLayoutRead(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const read = backend.readWindowLayout.bind(backend);
    const held = new Promise<void>((resolve) =>
      Object.assign(window, { releaseLayout: resolve, layoutReads: 0 }),
    );
    backend.readWindowLayout = async () => {
      (window as unknown as { layoutReads: number }).layoutReads += 1;
      await held;
      return read();
    };
  });
  return () =>
    page.evaluate(() => (window as unknown as { releaseLayout(): void }).releaseLayout());
}

// Review Focus 1. A restore under way neither shows a tab nor writes the session: a tab adopted
// meanwhile waits for the restore, then is shown and written like any other.
test("a tab adopted while restoring is shown and saved after the restore", async ({ page }) => {
  await quietErrors(page, LISTING_FAILED);
  // The first listing fails: the window restores at the next one, which the test brings about.
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: paneSession([[{ kind: "memo", memoId: "a" }]]),
    failListMemos: 1,
  });
  await expect(page.locator(".status-message")).toHaveText(`오류: ${LISTING_FAILED}`);
  const release = await holdLayoutRead(page);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  // The restore has begun and made no tab yet. Shown now, the tab would end up behind the session's
  // and hidden by the restore showing 가.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { layoutReads: number }).layoutReads))
    .toBe(1);

  await adopt(page, "b");
  await release();
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("나");
  await expect(page.locator(".cm-content")).toHaveText("둘째");
  await expect
    .poll(async () => sessionPane(page))
    .toMatchObject({
      tabs: [
        { kind: "memo", memoId: "a" },
        { kind: "memo", memoId: "b" },
      ],
      activeTab: 1,
    });
});

test("an adopt whose memo is gone gives its place back", async ({ page }) => {
  await quietErrors(page, NOT_FOUND);
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째") },
    session: paneSession([[{ kind: "memo", memoId: "a" }]]),
  });
  await expect(page.locator(".cm-content")).toHaveText("첫째");
  // Deleted in another app as it was handed over: listed nowhere, here or after a listing again.
  await adopt(page, "gone");
  await expect(page.locator(".status-message")).toHaveText(`오류: ${NOT_FOUND}`);
  await expect(page.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.places?.["memo:gone"]))
    .toBeUndefined();
  expect(await page.evaluate(() => window.__tote.backend.data.places)).toEqual({
    "memo:a": "ws-1",
  });
});
