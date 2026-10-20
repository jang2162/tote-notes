import { expect, test, type Page } from "@playwright/test";

import { FAKE_STORAGE_KEY, fakeMemo, type FakeData } from "../../src/backend/fake";
import {
  parseSessionFile,
  parseWindowSession,
  sessionPanes,
  type WindowSession,
} from "../../src/core/session";
import {
  dragOut,
  menu,
  nextWindow,
  openWindow,
  panesByPosition,
  startWindows,
  writesSettled,
} from "./helpers";

// Windows of one workspace on the fake backend: each page is a window (`FakeHub`), sharing the
// fake's data and hearing what the native side would tell it.

const MOVE = "move-tab-to-new-window";

const memos = {
  a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }),
  b: fakeMemo("나.md", "둘째", { modifiedMs: 1 }),
};

const titles = (page: Page) => page.locator(".tab .tab-title");
const activeTitle = (page: Page) => page.locator(".tab.active .tab-title");

/** The memo tabs of a window's layout, in its order. */
const memoTabs = (window: WindowSession) =>
  sessionPanes(window.layout).flatMap((pane) =>
    pane.tabs.flatMap((tab) => (tab.kind === "memo" ? [tab.memoId] : [])),
  );

/** The memo tabs of each window in the session file, in its order. */
async function sessionWindows(page: Page): Promise<string[][]> {
  const text = await page.evaluate(() => window.__tote.backend.data.session);
  return parseSessionFile(text).windows.map(memoTabs);
}

/** The memo tabs of each open window in the layout the native side holds for it. */
async function hubWindows(page: Page): Promise<string[][]> {
  const layouts = await page.evaluate(
    () => window.__tote.backend.data.hub?.windows.map((each) => each.layout) ?? [],
  );
  return layouts.map((layout) => memoTabs(parseWindowSession(layout)));
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
  // Both windows' layouts are in before the quit: a write after it changes nothing.
  await expect.poll(() => hubWindows(first)).toEqual([["a"], ["b"]]);
  await expect.poll(() => sessionWindows(first)).toEqual([["a"], ["b"]]);
  await first.evaluate(() => window.__tote.backend.quit());
  await first.close();
  await second.close();

  const again = await openWindow(context, "ws-1");
  // The first window writes its layout before the second one's page starts, as a slow page at
  // launch lets it: the second window is reopened all the same and keeps its saved layout.
  await writesSettled(again);
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

// A tab dragged out of a window: the fake stands the other windows on the screen as
// `data.dropTargets`, in the screen points the page reports.

const fourMemos = {
  ...memos,
  c: fakeMemo("다.md", "셋째", { modifiedMs: 0 }),
  d: fakeMemo("라.md", "넷째", { modifiedMs: 0 }),
};

const tab = (page: Page, title: string) =>
  page.locator(".tab", { has: page.locator(".tab-title", { hasText: title }) });

/** Changes the fake's data that `page` and the other windows share, as a write of the fake does. */
async function share(page: Page, patch: Partial<FakeData>): Promise<void> {
  await page.evaluate(
    ({ key, patch }) => {
      const data = { ...window.__tote.backend.data, ...patch };
      localStorage.setItem(key, JSON.stringify(data));
    },
    { key: FAKE_STORAGE_KEY, patch },
  );
}

/** Window `label` stands on the screen so that the screen point `at` is (`inside`) in it, showing
 * `workspace` — this one unless given. The windows `inFront` stand in front of it, in the same
 * place. */
function standAt(
  page: Page,
  label: string,
  at: { x: number; y: number },
  inside: { x: number; y: number },
  { workspace, inFront = [] }: { workspace?: string; inFront?: string[] } = {},
): Promise<void> {
  const frame = { x: at.x - inside.x, y: at.y - inside.y, width: 1280, height: 720 };
  const target = workspace ? { label, ...frame, workspace } : { label, ...frame };
  return share(page, {
    dropTargets: [...inFront.map((each) => ({ label: each, ...frame })), target],
  });
}

test("a tab dropped on another window of the workspace joins it", async ({ context }) => {
  const first = await startWindows(context, { memos: fourMemos });
  await openMemo(first, "나");
  await openMemo(first, "가");
  await first.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await first.keyboard.insertText(" 더");
  await expect(first.locator(".cm-content")).toHaveText("첫째 더");
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await openMemo(second, "다");
  await openMemo(second, "라");
  // 다 on the left, 라 on the right, which has the focus.
  await menu(second, "split-pane");
  await expect(second.locator(".pane")).toHaveCount(2);
  const [left, right] = await panesByPosition(second);
  await expect(right).toHaveClass(/\bfocused\b/);
  const leftBox = (await left.locator(".cm-content").boundingBox())!;
  const inLeft = { x: leftBox.x + leftBox.width / 2, y: leftBox.y + leftBox.height / 2 };

  const at = await dragOut(first, tab(first, "가"), false);
  // A window closed since stands in front of it: only the open windows take a tab.
  await standAt(first, "ws-2", at, inLeft, { inFront: ["ws-9"] });
  await first.mouse.up();
  await expect(first.locator(".tab .tab-title")).toHaveText(["나"]);
  // The last tab of the pane it was let go over, shown and focused, with its text.
  await expect(left.locator(".tab .tab-title")).toHaveText(["다", "가"]);
  await expect(left.locator(".tab.active .tab-title")).toHaveText("가");
  await expect(left).toHaveClass(/\bfocused\b/);
  await expect(left.locator(".cm-content")).toHaveText("첫째 더");
  await expect(right.locator(".tab .tab-title")).toHaveText(["라"]);
  // The window it went to comes forward, and has its new tab in the session at once.
  expect(await first.evaluate(() => window.__tote.backend.data.hub?.focused)).toBe("ws-2");
  expect(await second.evaluate(() => window.__tote.backend.data.places)).toMatchObject({
    "memo:a": "ws-2",
  });
  // Before the session timer (1s) could have written it.
  await expect
    .poll(() => sessionWindows(first).then((windows) => windows.at(-1)), { timeout: 500 })
    .toEqual(["c", "a", "d"]);
  // The first window too: its tab is in the other's session now.
  await expect
    .poll(() => sessionWindows(first), { timeout: 500 })
    .toEqual([["b"], ["c", "a", "d"]]);
  expect(await first.evaluate(() => window.__tote.backend.data.tornOff)).toBeUndefined();
});

test("a tab dropped on a window of another workspace opens in a new window", async ({
  context,
}) => {
  const first = await startWindows(context, { memos: fourMemos });
  await openMemo(first, "가");
  await openMemo(first, "나");
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await openMemo(second, "다");
  const at = await dragOut(first, tab(first, "가"), false);
  await standAt(first, "ws-2", at, { x: 400, y: 300 }, { workspace: "/fake/다른" });
  const [third] = await Promise.all([nextWindow(first), first.mouse.up()]);
  expect(new URL(third.url()).searchParams.get("window")).toBe("ws-3");
  await expect(third.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect(first.locator(".tab .tab-title")).toHaveText(["나"]);
  await expect(second.locator(".tab .tab-title")).toHaveText(["다"]);
  const tornOff = await first.evaluate(() => window.__tote.backend.data.tornOff);
  expect(tornOff).toEqual([{ tab: expect.objectContaining({ memoId: "a" }), at }]);
});

test("a window holding a tab it never showed opens it when another asks", async ({ context }) => {
  const first = await startWindows(context, { memos });
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  // The second window's place, and no tab: it was moved there before its page listened.
  await share(first, { places: { "memo:a": "ws-2" } });
  await expect(second.locator(".tab")).toHaveCount(0);
  await first.locator(".memo-row", { hasText: "가" }).click();
  await expect(second.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect(second.locator(".cm-content")).toHaveText("첫째");
  await expect(first.locator(".tab")).toHaveCount(0);
});
