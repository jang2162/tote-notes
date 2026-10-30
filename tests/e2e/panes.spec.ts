import { expect, test, type Page } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import type { OutsideChange } from "../../src/backend/types";
import {
  layoutSession,
  menu,
  paneSession,
  panesByPosition,
  ready,
  sessionPane,
  sessionPaneCount,
  sessionWidth,
  start,
} from "./helpers";

// The panes of one window, split side by side and stacked (⌘\, ⇧⌘\, ⌥⌘ and an arrow), on the fake
// backend. The sidebar is 240px, so the editing area is the viewport's width less 240.

const EMPTY_TITLE = "새 메모를 만드세요";
const EMPTY_HINT = "메모 목록에서 메모를 열거나 ⌘N 을 누르세요";
const TOO_NARROW = "창이 좁아 나눌 수 없습니다";

const panes = (page: Page) => page.locator(".pane");
const pane = (page: Page, index: number) => panes(page).nth(index);
const titles = (page: Page, index: number) => pane(page, index).locator(".tab .tab-title");
const activeTitle = (page: Page, index: number) =>
  pane(page, index).locator(".tab.active .tab-title");
const editor = (page: Page, index: number) => pane(page, index).locator(".cm-content");
const memoTab = (memoId: string, selection?: number) =>
  selection === undefined
    ? { kind: "memo", memoId }
    : {
        kind: "memo",
        memoId,
        selection: { ranges: [{ anchor: selection, head: selection }], main: 0 },
      };

const memos = {
  a: fakeMemo("가.md", "첫째", { modifiedMs: 4 }),
  b: fakeMemo("나.md", "둘째", { modifiedMs: 3 }),
  c: fakeMemo("다.md", "셋째", { modifiedMs: 2 }),
  d: fakeMemo("라.md", "넷째", { modifiedMs: 1 }),
};

/** The panes' widths on screen, as shares of the editing area. */
async function shares(page: Page): Promise<number[]> {
  const widths = await panes(page).evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().width),
  );
  const total = widths.reduce((sum, width) => sum + width, 0);
  return widths.map((width) => width / total);
}

async function sessionWidths(page: Page, count: number): Promise<number[]> {
  const widths: number[] = [];
  for (let index = 0; index < count; index++) widths.push(await sessionWidth(page, 0, index));
  return widths;
}

/** The first pane's editor has let go of the keys: typing reaches neither it nor memo a. */
async function expectKeysStayOut(page: Page): Promise<void> {
  await expect(editor(page, 0)).not.toBeFocused();
  await page.keyboard.type("XYZ");
  await expect(editor(page, 0)).toHaveText("첫째");
  await page.evaluate(() => window.__tote.app.flushAll());
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("첫째");
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Each pane's box on screen, in the order of the panes' elements. */
function boxes(page: Page): Promise<Box[]> {
  return panes(page).evaluateAll((els) =>
    els.map((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

async function areaBox(page: Page): Promise<Box> {
  return (await page.locator(".panes").boundingBox())!;
}

/** The same places, whichever pane holds each: a restart lays the panes' elements out in the
 * layout's order, which a split need not have kept. */
function expectBoxes(actual: Box[], expected: Box[]): void {
  const byPlace = (boxes: Box[]) =>
    [...boxes].sort((a, b) => Math.round(a.x) - Math.round(b.x) || a.y - b.y);
  const [got, want] = [byPlace(actual), byPlace(expected)];
  expect(got).toHaveLength(want.length);
  want.forEach((box, index) => {
    for (const key of ["x", "y", "width", "height"] as const)
      expect(got[index][key]).toBeCloseTo(box[key], 0);
  });
}

/** The memo ids of pane `index` (depth first) in the fake's session file. */
async function sessionMemos(page: Page, index: number): Promise<(string | false)[]> {
  return (await sessionPane(page, 0, index)).tabs.map((tab) => tab.kind === "memo" && tab.memoId);
}

/** A pane of the session tree holding `tabs`, its first tab active. */
const leafOf = (tabs: object[]) => ({ tabs, activeTab: tabs.length ? 0 : -1 });

function expectClose(actual: number[], expected: number[], digits = 2): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits));
}

test("⌘\\ moves the active tab into a new pane on the right", async ({ page }) => {
  await start(page, {
    memos,
    session: JSON.stringify({ version: 1, activeTab: 1, tabs: [memoTab("a"), memoTab("b")] }),
  });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await menu(page, "split-pane");
  await expect(panes(page)).toHaveCount(2);
  await expect(titles(page, 1)).toHaveText(["나"]);
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(pane(page, 0)).not.toHaveClass(/\bfocused\b/);
  await expect(editor(page, 1)).toHaveText("둘째");
  await expect(editor(page, 1)).toBeFocused();
  await expect(titles(page, 0)).toHaveText(["가"]);
  await expect(editor(page, 0)).toHaveText("첫째");
});

test("⌘\\ with one tab opens an empty pane and focuses it", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a")]]) });
  await expect(titles(page, 0)).toHaveText(["가"]);
  await menu(page, "split-pane");
  await expect(panes(page)).toHaveCount(2);
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(pane(page, 1).locator(".editor-placeholder")).toContainText(EMPTY_TITLE);
  await expect(titles(page, 1)).toHaveCount(0);
  await expect(titles(page, 0)).toHaveText(["가"]);
  await expectKeysStayOut(page);
});

test("⌘\\ in a narrow window says so and does nothing", async ({ page }) => {
  // An editing area of 572px: two halves of 286px are under the minimum.
  await page.setViewportSize({ width: 812, height: 720 });
  await start(page, {
    memos,
    session: JSON.stringify({ version: 1, activeTab: 1, tabs: [memoTab("a"), memoTab("b")] }),
  });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await menu(page, "split-pane");
  await expect(page.locator(".status-message")).toHaveText(TOO_NARROW);
  await expect(panes(page)).toHaveCount(1);
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
});

test("closing the last tab of a pane closes the pane", async ({ page }) => {
  await start(page, {
    memos,
    session: paneSession([[memoTab("a")], [memoTab("b")], [memoTab("c")]], {
      focusedPane: 1,
      widths: [0.25, 0.25, 0.5],
    }),
  });
  await expect(panes(page)).toHaveCount(3);
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await menu(page, "close-tab");
  await expect(panes(page)).toHaveCount(2);
  // The width went to the left neighbour, and so did the focus.
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
  await expect(titles(page, 0)).toHaveText(["가"]);
  await expect(titles(page, 1)).toHaveText(["다"]);
  await expect(editor(page, 0)).toBeFocused();
  expectClose(await shares(page), [0.5, 0.5]);
  await expect.poll(() => sessionWidths(page, 2)).toEqual([0.5, 0.5]);
  expect((await sessionPane(page, 0, 1)).tabs).toEqual(
    [memoTab("c")].map((tab) => expect.objectContaining(tab)),
  );
});

test("⌘W on an empty pane closes it; the only pane stays", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a")]]) });
  await expect(titles(page, 0)).toHaveText(["가"]);
  await menu(page, "split-pane");
  await expect(panes(page)).toHaveCount(2);
  await menu(page, "close-tab");
  await expect(panes(page)).toHaveCount(1);
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
  await expect(titles(page, 0)).toHaveText(["가"]);
  await menu(page, "close-tab");
  await expect(titles(page, 0)).toHaveCount(0);
  await expect(panes(page)).toHaveCount(1);
  await expect(page.locator(".editor-placeholder")).toContainText(EMPTY_TITLE);
  expect(await page.evaluate(() => window.__tote.backend.data.windowClosed)).toBe(false);
  await menu(page, "close-tab");
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.windowClosed)).toBe(true);
  await expect(panes(page)).toHaveCount(1);
});

test("the sidebar opens a memo in the focused pane", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a")], [memoTab("b")]]) });
  await expect(titles(page, 1)).toHaveText(["나"]);
  await page.locator(".memo-row", { hasText: "다" }).click();
  await expect(titles(page, 0)).toHaveText(["가", "다"]);
  await expect(titles(page, 1)).toHaveText(["나"]);
  // A click in a pane focuses it.
  await editor(page, 1).click();
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await page.locator(".memo-row", { hasText: "라" }).click();
  await expect(titles(page, 1)).toHaveText(["나", "라"]);
  await expect(editor(page, 1)).toHaveText("넷째");
  await expect(titles(page, 0)).toHaveText(["가", "다"]);
});

test("⌥⌘→ and ⌥⌘← move the focus and the status bar follows", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.qqq", "첫째\n둘째 줄"), b: fakeMemo("나.zzz", "하나") },
    session: paneSession([[memoTab("a", 4)], [memoTab("b", 0)]]),
  });
  await expect(editor(page, 0)).toBeFocused();
  await expect(page.locator(".status-position")).toHaveText("줄 2, 열 2");
  await expect(page.locator(".status-language")).toHaveText("QQQ");
  await menu(page, "focus-pane-right");
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(editor(page, 1)).toBeFocused();
  await expect(page.locator(".status-position")).toHaveText("줄 1, 열 1");
  await expect(page.locator(".status-language")).toHaveText("ZZZ");
  // Past the rightmost pane nothing moves.
  await menu(page, "focus-pane-right");
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await menu(page, "focus-pane-left");
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
  await expect(editor(page, 0)).toBeFocused();
  await expect(page.locator(".status-position")).toHaveText("줄 2, 열 2");
  await expect(page.locator(".status-language")).toHaveText("QQQ");
  await expect.poll(async () => (await sessionPane(page, 0, 0)).tabs.length).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(self.__tote.backend.data.session!).windows[0].focusedPane),
    )
    .toBe(0);
});

test("tab cycling stays inside the focused pane", async ({ page }) => {
  await start(page, {
    memos,
    session: paneSession(
      [
        [memoTab("a"), memoTab("b")],
        [memoTab("c"), memoTab("d")],
      ],
      { focusedPane: 1 },
    ),
  });
  await expect(activeTitle(page, 1)).toHaveText("다");
  await menu(page, "next-tab");
  await expect(activeTitle(page, 1)).toHaveText("라");
  await menu(page, "next-tab");
  await expect(activeTitle(page, 1)).toHaveText("다");
  await menu(page, "prev-tab");
  await expect(activeTitle(page, 1)).toHaveText("라");
  await expect(activeTitle(page, 0)).toHaveText("가");
});

test("a memo already open in another pane is focused there, not opened twice", async ({ page }) => {
  await start(page, {
    memos,
    session: paneSession([[memoTab("a")], [memoTab("b"), memoTab("c")]]),
  });
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
  await page.locator(".memo-row", { hasText: "다" }).click();
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(activeTitle(page, 1)).toHaveText("다");
  await expect(editor(page, 1)).toHaveText("셋째");
  await expect(editor(page, 1)).toBeFocused();
  await expect(titles(page, 0)).toHaveText(["가"]);
  await expect(page.locator(".tab")).toHaveCount(3);
});

test("a search result in a memo of another pane opens there at the match", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "하나\n둘 foo") },
    session: paneSession([[memoTab("a")], [memoTab("b")]]),
  });
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
  await menu(page, "search-workspace");
  await page.keyboard.type("foo");
  await expect(page.locator(".search-status")).toHaveText("1개 파일에서 1개");
  await page.locator(".search-match").click();
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(editor(page, 1)).toBeFocused();
  await expect(page.locator(".status-position")).toHaveText("줄 2, 열 3");
  await expect(page.locator(".tab")).toHaveCount(2);
});

test("leaving a pane retitles its memo", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a")], []], { focusedPane: 1 }) });
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await menu(page, "new-memo");
  await expect(editor(page, 1)).toBeFocused();
  await page.keyboard.type("# 장보기");
  await menu(page, "focus-pane-left");
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("장보기.md")))
    .toBe("# 장보기");
  await expect(activeTitle(page, 1)).toHaveText("장보기");
});

test("keys after ⌥⌘→ into a preview pane do not reach the pane left", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("회의.md", "# 회의 준비\n") },
    session: paneSession([[memoTab("a")], [{ ...memoTab("b"), mode: "preview" }]]),
  });
  await expect(editor(page, 0)).toBeFocused();
  await expect(pane(page, 1).locator("iframe.viewer-frame")).toHaveCount(1);
  await menu(page, "focus-pane-right");
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expectKeysStayOut(page);
});

test("a click inside a pane's preview focuses that pane", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("회의.md", "# 회의 준비\n") },
    session: paneSession([[memoTab("a")], [{ ...memoTab("b"), mode: "preview" }]]),
  });
  await expect(editor(page, 0)).toBeFocused();
  const frame = pane(page, 1).locator("iframe.viewer-frame");
  await expect(frame).toHaveCount(1);
  await expect(pane(page, 1).frameLocator("iframe.viewer-frame").locator("h1")).toHaveText(
    "회의 준비",
  );
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 40);
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  // ⌘W closes the tab looked at, not the other pane's.
  await menu(page, "close-tab");
  await expect(panes(page)).toHaveCount(1);
  await expect(titles(page, 0)).toHaveText(["가"]);
});

test("each pane keeps its own banner and preview mode", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("회의.md", "# 회의 준비\n"), b: fakeMemo("나.md", "둘째") },
    session: paneSession([[memoTab("a")], [memoTab("b")]]),
  });
  await expect(editor(page, 0)).toBeFocused();
  await menu(page, "toggle-preview");
  await expect(pane(page, 0).locator("iframe.viewer-frame")).toHaveCount(1);
  // The pane took the keys from its hidden editor.
  await expect(pane(page, 0)).toBeFocused();
  const removed: OutsideChange = {
    kind: "workspace",
    changes: [{ kind: "removed", id: "b", file: "나.md" }],
  };
  await page.evaluate((change) => window.__tote.backend.outside(change), removed);
  await expect(pane(page, 1).locator(".banner")).toBeVisible();
  await expect(pane(page, 0).locator(".banner")).toBeHidden();
  await menu(page, "focus-pane-right");
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(pane(page, 1).locator(".banner")).toBeVisible();
  await expect(pane(page, 0).locator(".banner")).toBeHidden();
  await expect(pane(page, 0).locator("iframe.viewer-frame")).toHaveCount(1);
  await expect(pane(page, 1).locator("iframe.viewer-frame")).toHaveCount(0);
  await expect(editor(page, 1)).toHaveText("둘째");
});

test("dragging the divider resizes and stops at 320px", async ({ page }) => {
  // An editing area of 992px — 1232px less the 240px sidebar: two panes of
  // 496px, the line between them the right one's border.
  await page.setViewportSize({ width: 1232, height: 720 });
  await start(page, { memos, session: paneSession([[memoTab("a")], [memoTab("b")]]) });
  await expect(panes(page)).toHaveCount(2);
  const width = (index: number) =>
    pane(page, index).evaluate((el) => el.getBoundingClientRect().width);
  const area = (await width(0)) + (await width(1));
  expect(area).toBeCloseTo(992, 0);
  /** Drags the divider by `dx` from where it is now. */
  const drag = async (dx: number) => {
    const box = (await page.locator(".pane-divider").boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 4 });
    await page.mouse.up();
  };
  await drag(-100);
  expect(await width(0)).toBeCloseTo(area / 2 - 100, 0);
  await drag(-1000);
  expect(await width(0)).toBeCloseTo(320, 0);
  expect(await width(1)).toBeCloseTo(area - 320, 0);
  // And on the other side.
  await drag(1000);
  expect(await width(1)).toBeCloseTo(320, 0);
  await expect.poll(async () => await sessionWidth(page, 0, 1)).toBeCloseTo(320 / area, 3);
});

test("the panes, their widths and the focused pane come back after a restart", async ({ page }) => {
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b")], [memoTab("c")]], {
      focusedPane: 0,
      widths: [0.7, 0.3],
    }),
  });
  await expect(panes(page)).toHaveCount(2);
  // A change of focus writes the session again.
  await menu(page, "focus-pane-right");
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(self.__tote.backend.data.session!).windows[0].focusedPane),
    )
    .toBe(1);
  await page.reload();
  await ready(page);
  await expect(panes(page)).toHaveCount(2);
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await expect(titles(page, 1)).toHaveText(["다"]);
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(editor(page, 1)).toBeFocused();
  expectClose(await shares(page), [0.7, 0.3]);
  const second = await sessionPane(page, 0, 1);
  expect(second.tabs.map((tab) => tab.kind === "memo" && tab.memoId)).toEqual(["c"]);
  expect(await sessionWidth(page, 0, 1)).toBeCloseTo(0.3);
});

test("a session listing one memo in two panes restores it once", async ({ page }) => {
  await start(page, {
    memos,
    session: paneSession([
      [memoTab("a"), memoTab("b")],
      [memoTab("a"), memoTab("c")],
    ]),
  });
  await expect(panes(page)).toHaveCount(2);
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await expect(titles(page, 1)).toHaveText(["다"]);
  await expect(page.locator(".tab")).toHaveCount(3);
});

test("widths keep their ratios in a window too narrow for them", async ({ page }) => {
  // An editing area of 1312px: wide enough to make three panes by splitting.
  await page.setViewportSize({ width: 1552, height: 800 });
  await start(page, {
    memos,
    session: JSON.stringify({ version: 1, activeTab: 1, tabs: [memoTab("a"), memoTab("b")] }),
  });
  await menu(page, "split-pane");
  await expect(panes(page)).toHaveCount(2);
  await menu(page, "split-pane");
  await expect(panes(page)).toHaveCount(3);
  await expect.poll(() => sessionWidths(page, 3)).toEqual([0.5, 0.25, 0.25]);
  // An editing area of 812px: under 960, so the panes are below the minimum width.
  await page.setViewportSize({ width: 1052, height: 800 });
  await page.reload();
  await ready(page);
  await expect(panes(page)).toHaveCount(3);
  expectClose(await shares(page), [0.5, 0.25, 0.25]);
  await menu(page, "split-pane");
  await expect(page.locator(".status-message")).toHaveText(TOO_NARROW);
  await expect(panes(page)).toHaveCount(3);
  // The session written after the restart keeps them too.
  await menu(page, "focus-pane-left");
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(self.__tote.backend.data.session!).windows[0].focusedPane),
    )
    .toBe(1);
  expect(await sessionWidths(page, 3)).toEqual([0.5, 0.25, 0.25]);
});

test("a composition in progress lands in its own pane before the focus moves", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a", 2)], [memoTab("b")]]) });
  await expect(editor(page, 0)).toBeFocused();
  // The text is drawn: the composition goes at its position 2.
  await expect(editor(page, 0)).toHaveText("첫째");
  // The input method's events as tests/e2e/pages/editor.ts sends them (`ime.start`, `update`,
  // `end("replace")`), into the first pane's editor; the menu item comes mid-composition.
  const seen = await page.evaluate(async () => {
    const { app, backend } = window.__tote;
    const view = app.panes[0].view;
    const dom = view.contentDOM;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const fire = (type: "beforeinput" | "input", inputType: string, data: string | null) =>
      dom.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, inputType, data }));
    const composition = (type: string, data: string) =>
      dom.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
    const write = (from: number, to: number, text: string) => {
      const at = view.domAtPos(from);
      let node = at.node;
      let offset = at.offset;
      if (node.nodeType !== Node.TEXT_NODE) {
        const before = node.childNodes[offset - 1];
        node = before;
        offset = before.nodeValue!.length;
      }
      const value = node.nodeValue!;
      node.nodeValue = value.slice(0, offset) + text + value.slice(offset + (to - from));
      document.getSelection()!.collapse(node, offset + text.length);
    };
    composition("compositionstart", "");
    await tick();
    const from = view.state.selection.main.from;
    composition("compositionupdate", "가");
    fire("beforeinput", "insertCompositionText", "가");
    write(from, from, "가");
    fire("input", "insertCompositionText", "가");
    await tick();
    const composing = view.composing;
    backend.menu("focus-pane-right");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The focus waits for the composition to end.
    const movedEarly = app.focused !== app.panes[0];
    fire("beforeinput", "deleteCompositionText", null);
    write(from, from + 1, "");
    fire("input", "deleteCompositionText", null);
    await tick();
    fire("beforeinput", "insertFromComposition", "가");
    write(from, from, "가");
    fire("input", "insertFromComposition", "가");
    await tick();
    composition("compositionend", "가");
    await tick();
    return { composing, movedEarly };
  });
  expect(seen).toEqual({ composing: true, movedEarly: false });
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(editor(page, 0)).toHaveText("첫째가");
  await expect(editor(page, 1)).toHaveText("둘째");
  await expect.poll(() => page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("첫째가");
  expect(await page.evaluate(() => window.__tote.backend.memoText("b"))).toBe("둘째");
});

test("⇧⌘\\ splits the focused pane downwards", async ({ page }) => {
  await start(page, {
    memos,
    session: JSON.stringify({ version: 1, activeTab: 1, tabs: [memoTab("a"), memoTab("b")] }),
  });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await menu(page, "split-pane-down");
  await expect(panes(page)).toHaveCount(2);
  const [top, bottom] = await boxes(page);
  expect(bottom.x).toBeCloseTo(top.x, 0);
  expect(bottom.width).toBeCloseTo(top.width, 0);
  expect(bottom.y).toBeCloseTo(top.y + top.height, 0);
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(titles(page, 1)).toHaveText(["나"]);
  await expect(activeTitle(page, 1)).toHaveText("나");
  await expect(editor(page, 1)).toBeFocused();
  await expect(titles(page, 0)).toHaveText(["가"]);
});

test("panes split both ways come back after a restart", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: JSON.stringify({
      version: 1,
      activeTab: 2,
      tabs: [memoTab("a"), memoTab("b"), memoTab("c")],
    }),
  });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  await menu(page, "split-pane");
  await expect(panes(page)).toHaveCount(2);
  // The right pane's only tab stays: the pane under it opens empty, and the sidebar fills it.
  await menu(page, "split-pane-down");
  await expect(panes(page)).toHaveCount(3);
  await page.locator(".memo-row", { hasText: "라" }).click();
  await expect(titles(page, 2)).toHaveText(["라"]);
  const before = await boxes(page);
  await expect.poll(() => sessionMemos(page, 2)).toEqual(["d"]);
  await page.reload();
  await ready(page);
  await expect(panes(page)).toHaveCount(3);
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await expect(titles(page, 1)).toHaveText(["다"]);
  await expect(titles(page, 2)).toHaveText(["라"]);
  await expect(pane(page, 2)).toHaveClass(/\bfocused\b/);
  const [left, top, bottom] = await boxes(page);
  // One pane on the left, two stacked on the right.
  expect(top.x).toBeCloseTo(left.x + left.width, 0);
  expect(bottom.x).toBeCloseTo(top.x, 0);
  expect(top.y).toBeCloseTo(left.y, 0);
  expect(bottom.y).toBeCloseTo(top.y + top.height, 0);
  expect(top.height + bottom.height).toBeCloseTo(left.height, 0);
  expectBoxes([left, top, bottom], before);
  expect(await sessionMemos(page, 0)).toEqual(["a", "b"]);
  expect(await sessionMemos(page, 1)).toEqual(["c"]);
  expect(await sessionMemos(page, 2)).toEqual(["d"]);
});

test("⌥⌘↑ and ⌥⌘↓ move the focus between stacked panes", async ({ page }) => {
  await start(page, {
    memos,
    session: layoutSession({
      axis: "column",
      shares: [0.5, 0.5],
      children: [leafOf([memoTab("a")]), leafOf([memoTab("b")])],
    }),
  });
  await expect(editor(page, 0)).toBeFocused();
  await menu(page, "focus-pane-down");
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(editor(page, 1)).toBeFocused();
  // Nothing is below the bottom pane, nor beside it.
  await menu(page, "focus-pane-down");
  await menu(page, "focus-pane-left");
  await menu(page, "focus-pane-right");
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await menu(page, "focus-pane-up");
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
  await expect(editor(page, 0)).toBeFocused();
  await expect(pane(page, 1)).not.toHaveClass(/\bfocused\b/);
});

test("a horizontal boundary drags and keeps 160px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: layoutSession({
      axis: "column",
      shares: [0.5, 0.5],
      children: [leafOf([memoTab("a")]), leafOf([memoTab("b")])],
    }),
  });
  await expect(panes(page)).toHaveCount(2);
  const height = (index: number) =>
    pane(page, index).evaluate((el) => el.getBoundingClientRect().height);
  const total = (await height(0)) + (await height(1));
  const divider = page.locator(".pane-divider");
  await expect(divider).toHaveCount(1);
  await expect(divider).toHaveCSS("cursor", "row-resize");
  /** Drags the boundary by `dy` from where it is now. */
  const drag = async (dy: number) => {
    const box = (await divider.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + dy, { steps: 4 });
    await page.mouse.up();
  };
  await drag(60);
  expect(await height(0)).toBeCloseTo(total / 2 + 60, 0);
  await drag(1000);
  expect(await height(1)).toBeGreaterThanOrEqual(160);
  expect(await height(1)).toBeCloseTo(160, 0);
  expect(await height(0)).toBeCloseTo(total - 160, 0);
  await drag(-1000);
  expect(await height(0)).toBeCloseTo(160, 0);
  await expect.poll(async () => await sessionWidth(page, 0, 0)).toBeCloseTo(160 / total, 3);
});

test("a move with no button down ends a divider drag whose release never came", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1232, height: 720 });
  await start(page, { memos, session: paneSession([[memoTab("a")], [memoTab("b")]]) });
  await expect(panes(page)).toHaveCount(2);
  const width = (index: number) =>
    pane(page, index).evaluate((el) => el.getBoundingClientRect().width);
  const area = (await width(0)) + (await width(1));
  const box = (await page.locator(".pane-divider").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y, { steps: 4 });
  expect(await width(0)).toBeCloseTo(area / 2 - 100, 0);
  // The release was lost out of the window: the pointer comes back with no button down, as
  // captured on the divider (WebKit's mouse is pointer 1).
  await page.locator(".pane-divider").evaluate(
    (el, at) => {
      el.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          buttons: 0,
          clientX: at.x,
          clientY: at.y,
          bubbles: true,
        }),
      );
    },
    { x: x - 300, y },
  );
  expect(await width(0)).toBeCloseTo(area / 2 - 100, 0);
  await expect
    .poll(async () => await sessionWidth(page, 0, 0))
    .toBeCloseTo((area / 2 - 100) / area, 3);
  await page.mouse.move(x - 200, y, { steps: 2 });
  expect(await width(0)).toBeCloseTo(area / 2 - 100, 0);
  await page.mouse.up();
});

test("closing a pane gives its room to the pane before it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    // The left 60% holds 가 over 나; 다 has the rest.
    session: layoutSession(
      {
        axis: "row",
        shares: [0.6, 0.4],
        children: [
          {
            axis: "column",
            shares: [0.5, 0.5],
            children: [leafOf([memoTab("a")]), leafOf([memoTab("b")])],
          },
          leafOf([memoTab("c")]),
        ],
      },
      1,
    ),
  });
  await expect(panes(page)).toHaveCount(3);
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await menu(page, "close-tab");
  await expect(panes(page)).toHaveCount(2);
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
  await expect(editor(page, 0)).toBeFocused();
  await expect(titles(page, 0)).toHaveText(["가"]);
  await expect(titles(page, 1)).toHaveText(["다"]);
  const area = await areaBox(page);
  const [first, second] = await boxes(page);
  // 가 took 나's room: the whole left 60%, top to bottom.
  expect(Math.abs(first.width + second.width - area.width)).toBeLessThanOrEqual(2);
  expect(first.width).toBeCloseTo(area.width * 0.6, 0);
  expect(first.height).toBeCloseTo(area.height, 0);
  expect(second.height).toBeCloseTo(area.height, 0);
  await expect.poll(() => sessionPaneCount(page)).toBe(2);
});

test("the focus of a closed pane goes to the pane that took its room", async ({ page }) => {
  await start(page, {
    memos,
    // 가 on the left; 나 over 다 on the right, 나 focused.
    session: layoutSession(
      {
        axis: "row",
        shares: [0.5, 0.5],
        children: [
          leafOf([memoTab("a")]),
          {
            axis: "column",
            shares: [0.5, 0.5],
            children: [leafOf([memoTab("b")]), leafOf([memoTab("c")])],
          },
        ],
      },
      1,
    ),
  });
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await menu(page, "close-tab");
  await expect(panes(page)).toHaveCount(2);
  // 다 took the right half, and the focus with it — not 가, the pane before 나 depth first.
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(titles(page, 1)).toHaveText(["다"]);
  await expect(editor(page, 1)).toBeFocused();
});

test("panes stay visible when the window is made smaller than their minimum", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await start(page, {
    memos,
    session: JSON.stringify({
      version: 1,
      activeTab: 3,
      tabs: [memoTab("a"), memoTab("b"), memoTab("c"), memoTab("d")],
    }),
  });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다", "라"]);
  // Two by two: 라 goes right, an empty pane under it, then the left pane's tab below it.
  await menu(page, "split-pane");
  await expect(panes(page)).toHaveCount(2);
  await menu(page, "split-pane-down");
  await expect(panes(page)).toHaveCount(3);
  await menu(page, "focus-pane-left");
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
  await menu(page, "split-pane-down");
  await expect(panes(page)).toHaveCount(4);
  const before = await boxes(page);
  await expect.poll(() => sessionPaneCount(page)).toBe(4);
  const expectAllShown = async () => {
    for (const box of await boxes(page)) {
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  };
  await page.setViewportSize({ width: 500, height: 300 });
  await expectAllShown();
  await page.setViewportSize({ width: 1280, height: 800 });
  expectBoxes(await boxes(page), before);
  // And a restart in the small window keeps the shares too.
  await page.setViewportSize({ width: 500, height: 300 });
  await page.reload();
  await ready(page);
  await expect(panes(page)).toHaveCount(4);
  await expectAllShown();
  await page.setViewportSize({ width: 1280, height: 800 });
  expectBoxes(await boxes(page), before);
});

test("the old right-edge drop target is gone", async ({ page }) => {
  await start(page, {
    memos,
    session: JSON.stringify({ version: 1, activeTab: 0, tabs: [memoTab("a"), memoTab("b")] }),
  });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  const from = (await pane(page, 0).locator(".tab", { hasText: "나" }).boundingBox())!;
  const area = await areaBox(page);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width - 10, area.y + area.height / 2, { steps: 8 });
  // The drag is on: the pane under it shows where the tab would land.
  await expect(page.locator(".drop-mask")).toHaveCount(1);
  await expect(page.locator(".pane-drop-edge")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(1);
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
});

const EMPTY_NEW_MEMO = "새 메모";

// A 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

test("an empty pane says how to start and its button makes a memo there", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, { memos, session: paneSession([[memoTab("a")], []], { focusedPane: 0 }) });
  const [left, right] = await panesByPosition(page);
  await expect(left.locator(".tab")).toHaveCount(1);
  const help = right.locator(".editor-placeholder");
  await expect(help.locator("p").nth(0)).toHaveText(EMPTY_TITLE);
  await expect(help.locator("p").nth(1)).toHaveText(EMPTY_HINT);
  await expect(help.locator("button")).toHaveText(EMPTY_NEW_MEMO);
  await help.locator("button").click();
  await expect(right.locator(".tab")).toHaveCount(1);
  await expect(right).toHaveClass(/\bfocused\b/);
  await expect(right.locator(".cm-content")).toBeFocused();
  await expect(left.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect(left.locator(".tab")).toHaveCount(1);
});

test("a window's only pane shows the same help", async ({ page }) => {
  await start(page);
  const help = page.locator(".editor-placeholder");
  await expect(help.locator("p").nth(0)).toHaveText(EMPTY_TITLE);
  await expect(help.locator("p").nth(1)).toHaveText(EMPTY_HINT);
  await expect(help.locator("button")).toHaveText(EMPTY_NEW_MEMO);
  await help.locator("button").click();
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("the empty pane hint is the default sentence from the start, or none yet", async ({
  page,
}) => {
  // Every hint text the page ever shows, from before the app's first paint.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { hintsSeen: string[] }).hintsSeen = seen;
    new MutationObserver(() => {
      for (const hint of document.querySelectorAll(".editor-placeholder-hint")) {
        const text = hint.textContent ?? "";
        if (seen.at(-1) !== text) seen.push(text);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await start(page);
  await expect(page.locator(".editor-placeholder p").nth(1)).toHaveText(EMPTY_HINT);
  const seen = await page.evaluate(() => (window as unknown as { hintsSeen: string[] }).hintsSeen);
  expect(seen.filter((text) => text !== "")).toEqual([EMPTY_HINT]);
});

/** What the settings screen does: save the whole shortcut map, then the backend's change event. */
async function saveShortcuts(page: Page, shortcuts: Record<string, string | null>) {
  await page.evaluate((map) => window.__tote.backend.patchSettings({ shortcuts: map }), shortcuts);
}

test("the empty pane hint follows the new memo shortcut", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, { memos, session: paneSession([[memoTab("a")], []], { focusedPane: 0 }) });
  const [, right] = await panesByPosition(page);
  const hint = right.locator(".editor-placeholder p").nth(1);
  await expect(hint).toHaveText(EMPTY_HINT);
  await saveShortcuts(page, { "new-memo": "CmdOrCtrl+Shift+M" });
  await expect(hint).toHaveText("메모 목록에서 메모를 열거나 ⇧⌘M 을 누르세요");
  await saveShortcuts(page, { "new-memo": null });
  await expect(hint).toHaveText("메모 목록에서 메모를 여세요");
  await expect(right.locator(".editor-placeholder p")).toHaveCount(2);
  await saveShortcuts(page, {});
  await expect(hint).toHaveText(EMPTY_HINT);
});

test("a shortcut table that failed to read is read again when the window takes the focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  // The first read fails (the handle is set just before the app starts); the later ones are real.
  await page.addInitScript(() => {
    let handle: unknown;
    Object.defineProperty(window, "__tote", {
      configurable: true,
      get: () => handle,
      set(value: { backend: { shortcutTable(): Promise<unknown> } }) {
        handle = value;
        const backend = value.backend;
        const read = backend.shortcutTable.bind(backend);
        let failed = false;
        backend.shortcutTable = () => {
          if (failed) return read();
          failed = true;
          return Promise.reject(new Error("unreadable"));
        };
      },
    });
  });
  await start(page, { memos, session: paneSession([[memoTab("a")], []], { focusedPane: 0 }) });
  const [, right] = await panesByPosition(page);
  const hint = right.locator(".editor-placeholder p").nth(1);
  await expect(right.locator(".editor-placeholder p")).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(hint).toHaveText(EMPTY_HINT);
});

test("the preview hint follows the toggle preview shortcut", async ({ page }) => {
  await start(page, { memos });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await menu(page, "toggle-preview");
  const status = page.locator(".status-message");
  await expect(status).toHaveText("미리보기 · ⇧⌘V 로 편집");
  await saveShortcuts(page, { "toggle-preview": "Alt+CmdOrCtrl+P" });
  await expect(status).toHaveText("미리보기 · ⌥⌘P 로 편집");
  await saveShortcuts(page, { "toggle-preview": null });
  await expect(status).toHaveText("미리보기");
  // Shown again, the preview says what the table says now.
  await menu(page, "toggle-preview");
  await expect(status).toHaveText("");
  await menu(page, "toggle-preview");
  await expect(status).toHaveText("미리보기");
});

test("a double click on the tab bar's free space opens a new memo as the last tab", async ({
  page,
}) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await expect(activeTitle(page, 0)).toHaveText("가");
  const bar = pane(page, 0).locator(".tabbar");
  // The bar and its last tab, read in one go once two reads agree: a tab bar still being laid out
  // puts the free space somewhere else, or has no last tab for a moment.
  const read = () =>
    bar.evaluate((el) => {
      const box = (of: Element) => {
        const { x, y, width, height } = of.getBoundingClientRect();
        return { x, y, width, height };
      };
      const tabs = el.querySelectorAll(".tab");
      return JSON.stringify({
        bar: box(el),
        last: tabs.length ? box(tabs[tabs.length - 1]) : null,
      });
    });
  let settled = "";
  await expect
    .poll(async () => {
      const now = await read();
      const same = now === settled;
      settled = now;
      return same && (JSON.parse(now) as { last: Box | null }).last !== null;
    })
    .toBe(true);
  const { bar: barBox, last } = JSON.parse(settled) as { bar: Box; last: Box };
  await bar.dblclick({
    position: { x: last.x + last.width + 20 - barBox.x, y: barBox.height / 2 },
  });
  await expect(pane(page, 0).locator(".tab")).toHaveCount(3);
  await expect(pane(page, 0).locator(".tab").nth(2)).toHaveClass(/\bactive\b/);
  await expect(editor(page, 0)).toBeFocused();
});

test("a double click on a tab opens nothing", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await pane(page, 0).locator(".tab", { hasText: "나" }).dblclick();
  await expect(activeTitle(page, 0)).toHaveText("나");
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  expect(await page.evaluate(() => Object.keys(window.__tote.backend.data.memos).length)).toBe(
    Object.keys(memos).length,
  );
});

test("the help never shows over a viewer or an open memo", async ({ page }) => {
  await start(page, {
    memos,
    files: { "/x/점.png": fakeFile(PNG) },
    picks: ["/x/점.png"],
    session: paneSession([[memoTab("a")], []]),
  });
  await expect(panes(page)).toHaveCount(2);
  const [left, right] = await panesByPosition(page);
  await expect(left.locator(".editor-placeholder")).toBeHidden();
  await expect(right.locator(".editor-placeholder")).toBeVisible();
  // Open a viewer in the empty pane: the help gives way.
  await right.locator(".surface").click();
  await menu(page, "open-file");
  await expect(right.locator("iframe.viewer-frame")).toHaveCount(1);
  await expect(right.locator(".editor-placeholder")).toBeHidden();
  await expect(left.locator(".editor-placeholder")).toBeHidden();
});

test("a tab's menu splits it into a new pane below", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b")]]),
    popupMenuPick: "split-tab-bottom",
  });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await pane(page, 0).locator(".tab", { hasText: "나" }).click({ button: "right" });
  await expect(panes(page)).toHaveCount(2);
  const [top, bottom] = await panesByPosition(page);
  await expect(top.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect(bottom.locator(".tab .tab-title")).toHaveText(["나"]);
  await expect(bottom).toHaveClass(/\bfocused\b/);
});

test("a tab's menu splits it into a new pane on the left", async ({ page }) => {
  // Two panes of 656px: halves of 328px keep the minimum.
  await page.setViewportSize({ width: 1600, height: 720 });
  await start(page, {
    memos,
    session: paneSession([[memoTab("a")], [memoTab("b"), memoTab("c")]]),
    popupMenuPick: "split-tab-left",
  });
  await expect(titles(page, 1)).toHaveText(["나", "다"]);
  await pane(page, 1).locator(".tab", { hasText: "다" }).click({ button: "right" });
  await expect(panes(page)).toHaveCount(3);
  const [first, second, third] = await panesByPosition(page);
  await expect(first.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect(second.locator(".tab .tab-title")).toHaveText(["다"]);
  await expect(third.locator(".tab .tab-title")).toHaveText(["나"]);
});

test("a tab's menu splits a pane's only tab into an empty new pane", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: paneSession([[memoTab("a")]]),
    popupMenuPick: "split-tab-right",
  });
  await expect(titles(page, 0)).toHaveText(["가"]);
  await pane(page, 0).locator(".tab", { hasText: "가" }).click({ button: "right" });
  await expect(panes(page)).toHaveCount(2);
  const [left, right] = await panesByPosition(page);
  await expect(left.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect(right.locator(".tab")).toHaveCount(0);
  await expect(right.locator(".editor-placeholder")).toContainText(EMPTY_TITLE);
});

test("a tab's menu in a narrow window says so and splits nothing", async ({ page }) => {
  // An editing area of 620px: two halves of 310px are under the minimum.
  await page.setViewportSize({ width: 860, height: 720 });
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b")]]),
    popupMenuPick: "split-tab-right",
  });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await pane(page, 0).locator(".tab", { hasText: "나" }).click({ button: "right" });
  await expect(page.locator(".status-message")).toHaveText(TOO_NARROW);
  await expect(panes(page)).toHaveCount(1);
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
});

test("a press and a move on the tab bar's empty part start no drag", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  const bar = (await pane(page, 0).locator(".tabbar").boundingBox())!;
  const last = (await pane(page, 0).locator(".tab").last().boundingBox())!;
  const x = (last.x + last.width + bar.x + bar.width) / 2;
  const y = bar.y + bar.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y + 200, { steps: 8 });
  await expect(page.locator(".drop-mask")).toHaveCount(0);
  await page.mouse.up();
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await expect(panes(page)).toHaveCount(1);
});

// One block (title, hint, button) in the middle of the pane, not spread over its height.
test("the empty pane notice sits together in the middle", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a")]]) });
  await menu(page, "split-pane");
  const area = pane(page, 1).locator(".editor-placeholder");
  const body = area.locator(".editor-placeholder-body");
  await expect(body).toHaveCount(1);
  await expect(body.locator("p")).toHaveCount(2);
  await expect(body.locator("button")).toHaveCount(1);
  const [outer, inner, title, button] = await Promise.all([
    area.boundingBox(),
    body.boundingBox(),
    body.locator("p").first().boundingBox(),
    body.locator("button").boundingBox(),
  ]);
  expect(Math.abs(inner!.y + inner!.height / 2 - (outer!.y + outer!.height / 2))).toBeLessThan(4);
  expect(button!.y - (title!.y + title!.height)).toBeLessThan(80);
});
