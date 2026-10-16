import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import type { OutsideChange } from "../../src/backend/types";
import { menu, ready, sessionPane, start } from "./helpers";

// Side-by-side panes of one window (⌘\, ⌥⌘← / ⌥⌘→) on the fake backend. The sidebar is 240px, so
// the editing area is the viewport's width less 240.

const EMPTY_PANE = "빈 칸입니다. 메모 목록에서 메모를 열거나 ⌘N 을 누르세요";
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

/** A version 2 session of one window whose panes hold `tabs`, each pane's first tab active. */
function session(
  tabs: object[][],
  options: { focusedPane?: number; widths?: number[] } = {},
): string {
  const widths = options.widths ?? tabs.map(() => 1 / tabs.length);
  return JSON.stringify({
    version: 2,
    windows: [
      {
        panes: tabs.map((each, index) => ({
          tabs: each,
          activeTab: each.length ? 0 : -1,
          width: widths[index],
        })),
        focusedPane: options.focusedPane ?? 0,
      },
    ],
  });
}

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
  for (let index = 0; index < count; index++)
    widths.push((await sessionPane(page, 0, index)).width);
  return widths;
}

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
  await start(page, { memos, session: session([[memoTab("a")]]) });
  await expect(titles(page, 0)).toHaveText(["가"]);
  await menu(page, "split-pane");
  await expect(panes(page)).toHaveCount(2);
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(pane(page, 1).locator(".editor-placeholder")).toHaveText(EMPTY_PANE);
  await expect(titles(page, 1)).toHaveCount(0);
  await expect(titles(page, 0)).toHaveText(["가"]);
});

test("⌘\\ in a narrow window says so and does nothing", async ({ page }) => {
  // An editing area of 620px: two halves of 310px are under the minimum.
  await page.setViewportSize({ width: 860, height: 720 });
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
    session: session([[memoTab("a")], [memoTab("b")], [memoTab("c")]], {
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
  await start(page, { memos, session: session([[memoTab("a")]]) });
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
  await expect(page.locator(".editor-placeholder")).toHaveText("⌘N 으로 새 메모를 만드세요");
  expect(await page.evaluate(() => window.__tote.backend.data.windowClosed)).toBe(false);
  await menu(page, "close-tab");
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.windowClosed)).toBe(true);
  await expect(panes(page)).toHaveCount(1);
});

test("the sidebar opens a memo in the focused pane", async ({ page }) => {
  await start(page, { memos, session: session([[memoTab("a")], [memoTab("b")]]) });
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
    session: session([[memoTab("a", 4)], [memoTab("b", 0)]]),
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
    session: session(
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
  await start(page, { memos, session: session([[memoTab("a")], [memoTab("b"), memoTab("c")]]) });
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
    session: session([[memoTab("a")], [memoTab("b")]]),
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
  await start(page, { memos, session: session([[memoTab("a")], []], { focusedPane: 1 }) });
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

test("each pane keeps its own banner and preview mode", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("회의.md", "# 회의 준비\n"), b: fakeMemo("나.md", "둘째") },
    session: session([[memoTab("a")], [memoTab("b")]]),
  });
  await expect(editor(page, 0)).toBeFocused();
  await menu(page, "toggle-preview");
  await expect(pane(page, 0).locator("iframe.viewer-frame")).toHaveCount(1);
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
  // An editing area of 1040px less the 1px divider: two panes of 519.5px.
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, { memos, session: session([[memoTab("a")], [memoTab("b")]]) });
  await expect(panes(page)).toHaveCount(2);
  const width = (index: number) =>
    pane(page, index).evaluate((el) => el.getBoundingClientRect().width);
  const area = (await width(0)) + (await width(1));
  expect(area).toBeCloseTo(1039, 0);
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
  await expect.poll(async () => (await sessionPane(page, 0, 1)).width).toBeCloseTo(320 / area, 3);
});

test("the panes, their widths and the focused pane come back after a restart", async ({ page }) => {
  await start(page, {
    memos,
    session: session([[memoTab("a"), memoTab("b")], [memoTab("c")]], {
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
  expect(second.width).toBeCloseTo(0.3);
});

test("a session listing one memo in two panes restores it once", async ({ page }) => {
  await start(page, {
    memos,
    session: session([
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
  // An editing area of 1360px: wide enough to make three panes by splitting.
  await page.setViewportSize({ width: 1600, height: 800 });
  await start(page, {
    memos,
    session: JSON.stringify({ version: 1, activeTab: 1, tabs: [memoTab("a"), memoTab("b")] }),
  });
  await menu(page, "split-pane");
  await expect(panes(page)).toHaveCount(2);
  await menu(page, "split-pane");
  await expect(panes(page)).toHaveCount(3);
  await expect.poll(() => sessionWidths(page, 3)).toEqual([0.5, 0.25, 0.25]);
  // An editing area of 860px: under 960, so the panes are below the minimum width.
  await page.setViewportSize({ width: 1100, height: 800 });
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
  await start(page, { memos, session: session([[memoTab("a", 2)], [memoTab("b")]]) });
  await expect(editor(page, 0)).toBeFocused();
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
