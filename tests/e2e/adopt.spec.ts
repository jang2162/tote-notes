import { expect, test, type Page } from "@playwright/test";

import { fakeMemo, type FakeData } from "../../src/backend/fake";
import { parseWindowSession, sessionPanes } from "../../src/core/session";
import { paneSession, quietErrors, sessionPane, start, startWindows } from "./helpers";

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

/** Makes the next `readWindowLayout` — a restore's first read, before it makes any tab — wait
 * until the page's `releaseLayout` is called; `layoutReads` counts the reads since. Later reads go
 * through. */
async function holdLayoutRead(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const read = backend.readWindowLayout.bind(backend);
    const held = new Promise<void>((resolve) =>
      Object.assign(window, { releaseLayout: resolve, layoutReads: 0 }),
    );
    backend.readWindowLayout = async () => {
      const reads = ((window as unknown as { layoutReads: number }).layoutReads += 1);
      if (reads === 1) await held;
      return read();
    };
  });
  return () =>
    page.evaluate(() => (window as unknown as { releaseLayout(): void }).releaseLayout());
}

const memos = {
  a: fakeMemo("가.md", "첫째"),
  b: fakeMemo("나.md", "둘째"),
  c: fakeMemo("다.md", "셋째"),
};
const sessionOfA = paneSession([[{ kind: "memo", memoId: "a" }]]);

/** Opens the window on `seed` with its restore held at its first read (`holdRestore`). Returns
 * what lets the restore go on. */
async function restoreHeld(page: Page, seed: Partial<FakeData>): Promise<() => Promise<void>> {
  await start(page, { ...seed, failListMemos: 1 });
  return holdRestore(page);
}

/** Holds the restore of a window opened with `failListMemos: 1` at its first read
 * (`holdLayoutRead`): the first listing failed, so the window restores at the next one, which this
 * brings about. Returns what lets the restore go on. */
async function holdRestore(page: Page): Promise<() => Promise<void>> {
  await expect(page.locator(".status-message")).toHaveText(`오류: ${LISTING_FAILED}`);
  const release = await holdLayoutRead(page);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  // The restore has begun and made no tab yet. A tab shown now would end up behind the session's
  // and hidden by the restore showing its own.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { layoutReads: number }).layoutReads))
    .toBe(1);
  return release;
}

// Review Focus 1. A restore under way neither shows a tab nor writes the session: a tab adopted
// meanwhile waits for the restore, then is shown and written like any other — at once, not on the
// session's timer, which a test clock holds here: the other window has written its session without
// the tab, and an app quitting before the timer would lose its place.
test("a tab adopted while restoring is shown and saved after the restore", async ({ page }) => {
  await quietErrors(page, LISTING_FAILED);
  await page.clock.install();
  const release = await restoreHeld(page, { memos, session: sessionOfA });
  await page.clock.pauseAt(Date.now() + 60_000);
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

test("tabs adopted while restoring keep their order and the session's own is not doubled", async ({
  page,
}) => {
  await quietErrors(page, LISTING_FAILED);
  const release = await restoreHeld(page, { memos, session: sessionOfA });
  // 가 is the session's own tab: the restore makes it, and its adopt shows that one.
  await adopt(page, "b");
  await adopt(page, "a");
  await adopt(page, "c");
  await release();
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나", "다"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("다");
  await expect
    .poll(async () => (await sessionPane(page)).tabs.map((tab) => "memoId" in tab && tab.memoId))
    .toEqual(["a", "b", "c"]);
});

test("an adopt held while restoring whose memo is gone gives its place back", async ({ page }) => {
  await quietErrors(page, LISTING_FAILED, NOT_FOUND);
  const release = await restoreHeld(page, { memos, session: sessionOfA });
  await adopt(page, "gone");
  await release();
  await expect(page.locator(".status-message")).toHaveText(`오류: ${NOT_FOUND}`);
  await expect(page.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.places?.["memo:gone"]))
    .toBeUndefined();
});

/** The first pane of the layout the native side has for window `label` (the fake's `FakeHub`): its
 * tabs' memo IDs and its active tab. */
async function hubPane(
  page: Page,
  label: string,
): Promise<{ tabs: (string | false)[]; activeTab: number }> {
  const json = await page.evaluate(
    (window) =>
      JSON.stringify(
        self.__tote.backend.data.hub?.windows.find((each) => each.label === window)?.layout ?? null,
      ),
    label,
  );
  const [pane] = sessionPanes(parseWindowSession(JSON.parse(json)).layout);
  return { tabs: pane.tabs.map((tab) => "memoId" in tab && tab.memoId), activeTab: pane.activeTab };
}

// Tabs handed to a window still restoring wait for the restore (`pendingAdopts`), and a restore
// under way writes no layout. A window closed or quit then would leave the tabs in no layout while
// their places are its own: a round writes them behind the window's own tabs, into the layout the
// native side has for it.
test("a window closed before its restore keeps the tabs it was handed", async ({ context }) => {
  await quietErrors(context, LISTING_FAILED);
  const page = await startWindows(context, { memos, session: sessionOfA, failListMemos: 1 });
  const release = await holdRestore(page);
  // 가 is the window's own tab already: it is not written twice.
  await adopt(page, "b");
  await adopt(page, "a");
  await adopt(page, "c");
  await page.evaluate(() => window.__tote.backend.requestFlush(1, "quit"));
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed))
    .toEqual([{ id: 1 }]);
  // The last one handed over is in front, as adopting it would have shown it.
  expect(await hubPane(page, "ws-1")).toEqual({ tabs: ["a", "b", "c"], activeTab: 2 });
  // The restore, let go on, makes them once: they are in the layout it reads now.
  await release();
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나", "다"]);
});

test("a window with no layout yet keeps the tabs it was handed in a pane of their own", async ({
  page,
}) => {
  await quietErrors(page, LISTING_FAILED);
  await restoreHeld(page, { memos });
  await adopt(page, "b");
  await adopt(page, "c");
  await page.evaluate(() => window.__tote.backend.requestFlush(1, "close"));
  await expect
    .poll(async () => (await sessionPane(page)).tabs.map((tab) => "memoId" in tab && tab.memoId))
    .toEqual(["b", "c"]);
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed))
    .toEqual([{ id: 1 }]);
});

// A tab handed over whose memo this window has not listed yet waits for a listing (`adoptTab`). A
// round answered meanwhile would write the window's tabs without it and close the window over it.
test("a close round waits for a tab still being adopted", async ({ page }) => {
  await start(page, { memos: { a: memos.a }, session: sessionOfA });
  await expect(page.locator(".cm-content")).toHaveText("첫째");
  await page.evaluate((memo) => {
    const { backend } = window.__tote;
    // Made in another window a moment ago: listed only by the next listing, which waits.
    backend.data.memos.b = memo;
    const list = backend.listMemos.bind(backend);
    const held = new Promise<void>((resolve) => Object.assign(window, { releaseList: resolve }));
    backend.listMemos = async () => {
      await held;
      return list();
    };
    const events: string[] = [];
    Object.assign(window, { events });
    const write = backend.writeWindowLayout.bind(backend);
    backend.writeWindowLayout = (json) => {
      events.push(json.includes('"memoId":"b"') ? "layout with 나" : "layout");
      return write(json);
    };
    const done = backend.flushDone.bind(backend);
    backend.flushDone = (id, blocked) => {
      events.push("answer");
      return done(id, blocked);
    };
  }, memos.b);
  await adopt(page, "b");
  await page.evaluate(() => window.__tote.backend.requestFlush(1, "close"));
  await page.evaluate(() => (window as unknown as { releaseList(): void }).releaseList());
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { events: string[] }).events))
    .toContain("answer");
  const events = await page.evaluate(() => (window as unknown as { events: string[] }).events);
  expect(events.indexOf("layout with 나")).toBeGreaterThanOrEqual(0);
  expect(events.indexOf("layout with 나")).toBeLessThan(events.indexOf("answer"));
});

// The native side sends a tab let go over the window from the moment its page has started (the
// page's first call, `workspaceInfo`). The page listens before it makes that call: a tab sent
// before the page heard of anything else waits for the restore like any other.
test("a tab let go over the window as its page starts is adopted after the restore", async ({
  page,
}) => {
  await start(page, {
    memos,
    session: sessionOfA,
    places: { "memo:b": "ws-1" },
    adoptOnStart: { tab: JSON.stringify({ kind: "memo", memoId: "b" }), x: 10, y: 10 },
  });
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("나");
  expect(await page.evaluate(() => window.__tote.backend.data.adoptOnStart)).toBeUndefined();
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
