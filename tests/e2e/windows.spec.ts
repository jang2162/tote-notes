import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { parseSessionFile } from "../../src/core/session";
import { menu, nextWindow, openWindow, startWindows } from "./helpers";

// Windows of one workspace on the fake backend: each page is a window (`FakeHub`), sharing the
// fake's data and hearing what the native side would tell it.

const MOVE = "move-tab-to-new-window";

const memos = {
  a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }),
  b: fakeMemo("나.md", "둘째", { modifiedMs: 1 }),
};

const titles = (page: Page) => page.locator(".tab .tab-title");
const activeTitle = (page: Page) => page.locator(".tab.active .tab-title");

/** The memo tabs of each window in the session file, in its order. */
async function sessionWindows(page: Page): Promise<string[][]> {
  const text = await page.evaluate(() => window.__tote.backend.data.session);
  return parseSessionFile(text).windows.map((window) =>
    window.panes.flatMap((pane) =>
      pane.tabs.flatMap((tab) => (tab.kind === "memo" ? [tab.memoId] : [])),
    ),
  );
}

async function openMemo(page: Page, name: string): Promise<void> {
  await page.locator(".memo-row", { hasText: name }).click();
  await expect(activeTitle(page)).toHaveText(name);
}

test("a torn-off tab opens in the new window with its text", async ({ context }) => {
  const first = await startWindows(context, { memos });
  await openMemo(first, "가");
  await first.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await first.keyboard.insertText(" 더");
  const [second] = await Promise.all([nextWindow(first), menu(first, MOVE)]);
  expect(new URL(second.url()).searchParams.get("window")).toBe("ws-2");
  await expect(activeTitle(second)).toHaveText("가");
  await expect(second.locator(".cm-content")).toHaveText("첫째 더");
  await expect(first.locator(".tab")).toHaveCount(0);
  // The new window holds the tab: opening it from the first one brings the second forward.
  await first.locator(".memo-row", { hasText: "가" }).click();
  await expect(first.locator(".tab")).toHaveCount(0);
  await expect
    .poll(() => first.evaluate(() => window.__tote.backend.data.hub?.focused))
    .toBe("ws-2");
});

test("⌥⌘N opens an empty window of the same workspace", async ({ context }) => {
  const first = await startWindows(context, { memos });
  await openMemo(first, "가");
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  expect(new URL(second.url()).searchParams.get("window")).toBe("ws-2");
  await expect(second.locator(".tab")).toHaveCount(0);
  await expect(second.locator(".memo-row .memo-name")).toHaveText(["가", "나"]);
  await expect(titles(first)).toHaveText(["가"]);
});

test("a memo made in one window appears in the other's list", async ({ context }) => {
  const first = await startWindows(context, { memos });
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await menu(second, "new-memo");
  await expect(first.locator(".memo-row")).toHaveCount(3);
  // Leaving the first line names the memo after it.
  await second.keyboard.insertText("장보기");
  await second.keyboard.press("Enter");
  await expect(first.locator(".memo-row", { hasText: "장보기" })).toHaveCount(1);
});

test("opening a memo shown in the other window brings that window forward", async ({ context }) => {
  const first = await startWindows(context, {
    memos,
    session: JSON.stringify({
      version: 1,
      activeTab: 1,
      tabs: [
        { kind: "memo", memoId: "a" },
        { kind: "memo", memoId: "b" },
      ],
    }),
  });
  await expect(activeTitle(first)).toHaveText("나");
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await second.locator(".memo-row", { hasText: "가" }).click();
  await expect(activeTitle(first)).toHaveText("가");
  await expect(first.locator(".cm-content")).toHaveText("첫째");
  await expect(second.locator(".tab")).toHaveCount(0);
  expect(await second.evaluate(() => window.__tote.backend.data.hub?.focused)).toBe("ws-1");
});

test("two windows of one workspace come back after a restart", async ({ context }) => {
  const first = await startWindows(context, { memos });
  await openMemo(first, "가");
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await openMemo(second, "나");
  await expect.poll(() => sessionWindows(first)).toEqual([["a"], ["b"]]);
  await first.evaluate(() => window.__tote.backend.quit());
  await first.close();
  await second.close();

  const again = await openWindow(context, "ws-1");
  const againSecond = await openWindow(context, "ws-2");
  await expect(titles(again)).toHaveText(["가"]);
  await expect(again.locator(".cm-content")).toHaveText("첫째");
  await expect(titles(againSecond)).toHaveText(["나"]);
  await expect(againSecond.locator(".cm-content")).toHaveText("둘째");
});

test("closing one of two windows drops its layout; closing the last keeps it", async ({
  context,
}) => {
  const first = await startWindows(context, { memos });
  await openMemo(first, "가");
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await openMemo(second, "나");
  await expect.poll(() => sessionWindows(first)).toEqual([["a"], ["b"]]);
  // What the native side does once the window is gone.
  await second.evaluate(() => window.__tote.backend.closed());
  await second.close();
  expect(await sessionWindows(first)).toEqual([["a"]]);
  // Its tab is free to open here now.
  await openMemo(first, "나");
  await expect(titles(first)).toHaveText(["가", "나"]);
  await expect.poll(() => sessionWindows(first)).toEqual([["a", "b"]]);
  await first.evaluate(() => window.__tote.backend.closed());
  expect(await sessionWindows(first)).toEqual([["a", "b"]]);
});
