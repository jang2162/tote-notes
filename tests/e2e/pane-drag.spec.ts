import { expect, test, type Locator, type Page } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { sessionPane, start } from "./helpers";

// Dragging a tab between the panes of one window, on the fake backend. The drag is made of pointer
// events (the spike could not confirm HTML5 drag and drop between tab bars in the app's webview), so
// the mouse goes down on a tab, moves and comes up where the tab is to go.

const TOO_NARROW = "창이 좁아 나눌 수 없습니다";

const panes = (page: Page) => page.locator(".pane");
const pane = (page: Page, index: number) => panes(page).nth(index);
const tab = (page: Page, index: number, title: string) =>
  pane(page, index).locator(".tab", { has: page.locator(".tab-title", { hasText: title }) });
const titles = (page: Page, index: number) => pane(page, index).locator(".tab .tab-title");
const activeTitle = (page: Page, index: number) =>
  pane(page, index).locator(".tab.active .tab-title");
const editor = (page: Page, index: number) => pane(page, index).locator(".cm-content");
const memoTab = (memoId: string) => ({ kind: "memo", memoId });

/** A version 2 session of one window whose panes hold `tabs`, each pane's first tab active. */
function session(tabs: object[][], focusedPane = 0): string {
  return JSON.stringify({
    version: 2,
    windows: [
      {
        panes: tabs.map((each) => ({
          tabs: each,
          activeTab: each.length ? 0 : -1,
          width: 1 / tabs.length,
        })),
        focusedPane,
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

/** `locator`'s box. `boundingBox` does not wait, and right after a restore the tab bar is drawn
 * again: a box read while its tabs are being replaced is null, so it is read until there is one. */
async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  await expect.poll(async () => (box = await locator.boundingBox())).not.toBeNull();
  return box!;
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await boxOf(locator);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Presses on `from`'s middle and moves to `to` in steps; lets go unless `release` is false. */
async function drag(
  page: Page,
  from: Locator,
  to: { x: number; y: number },
  release = true,
): Promise<void> {
  const start = await centre(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  if (release) await page.mouse.up();
}

/** Just inside the left end of `target`, at its height: a drop there lands before it. */
async function before(target: Locator): Promise<{ x: number; y: number }> {
  const box = await boxOf(target);
  return { x: box.x + 4, y: box.y + box.height / 2 };
}

/** Inside the editing area's right edge, halfway down. */
async function rightEdge(page: Page): Promise<{ x: number; y: number }> {
  const box = await boxOf(page.locator(".panes"));
  return { x: box.x + box.width - 10, y: box.y + box.height / 2 };
}

test("dragging a tab onto another pane's tab bar moves it there", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: session([
      [memoTab("a"), memoTab("b")],
      [memoTab("c"), memoTab("d")],
    ]),
  });
  await expect(titles(page, 1)).toHaveText(["다", "라"]);
  await drag(page, tab(page, 0, "나"), await before(tab(page, 1, "라")));
  await expect(titles(page, 1)).toHaveText(["다", "나", "라"]);
  await expect(activeTitle(page, 1)).toHaveText("나");
  await expect(editor(page, 1)).toHaveText("둘째");
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(editor(page, 1)).toBeFocused();
  await expect(titles(page, 0)).toHaveText(["가"]);
  await expect(activeTitle(page, 0)).toHaveText("가");
  await expect.poll(async () => (await sessionPane(page, 0, 1)).tabs.length).toBe(3);
  expect((await sessionPane(page, 0, 1)).activeTab).toBe(1);
});

test("dragging a tab within its tab bar puts it where it is dropped", async ({ page }) => {
  await start(page, { memos, session: session([[memoTab("a"), memoTab("b"), memoTab("c")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  await drag(page, tab(page, 0, "가"), await before(tab(page, 0, "다")));
  await expect(titles(page, 0)).toHaveText(["나", "가", "다"]);
  await expect(activeTitle(page, 0)).toHaveText("가");
});

test("a tab dropped on an empty pane goes into it", async ({ page }) => {
  await start(page, { memos, session: session([[memoTab("a"), memoTab("b")], []]) });
  await expect(panes(page)).toHaveCount(2);
  await drag(page, tab(page, 0, "나"), await centre(pane(page, 1).locator(".surface")));
  await expect(titles(page, 1)).toHaveText(["나"]);
  await expect(editor(page, 1)).toHaveText("둘째");
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(titles(page, 0)).toHaveText(["가"]);
});

test("dropping on the right edge makes a new pane", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, { memos, session: session([[memoTab("a"), memoTab("b")]]) });
  await expect(panes(page)).toHaveCount(1);
  await drag(page, tab(page, 0, "나"), await rightEdge(page));
  await expect(panes(page)).toHaveCount(2);
  await expect(titles(page, 1)).toHaveText(["나"]);
  await expect(editor(page, 1)).toHaveText("둘째");
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(titles(page, 0)).toHaveText(["가"]);
  await expect.poll(async () => (await sessionPane(page, 0, 1)).width).toBeCloseTo(0.5, 3);
});

test("dragging the last tab out closes its pane", async ({ page }) => {
  await start(page, {
    memos,
    session: session([[memoTab("a"), memoTab("b")], [memoTab("c")]], 1),
  });
  await expect(panes(page)).toHaveCount(2);
  const bar = pane(page, 0).locator(".tabbar");
  const box = await boxOf(bar);
  // Past the last tab of the left pane's bar.
  await drag(page, tab(page, 1, "다"), { x: box.x + box.width - 20, y: box.y + box.height / 2 });
  await expect(panes(page)).toHaveCount(1);
  await expect(page.locator(".pane-divider")).toHaveCount(0);
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  await expect(activeTitle(page, 0)).toHaveText("다");
  await expect(editor(page, 0)).toHaveText("셋째");
  await expect(pane(page, 0)).toHaveClass(/\bfocused\b/);
});

test("a moved memo keeps its unsaved text and its undo", async ({ page }) => {
  await start(page, { memos, session: session([[memoTab("a"), memoTab("b")], [memoTab("c")]]) });
  await editor(page, 0).click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("!!");
  await expect(editor(page, 0)).toHaveText("첫째!!");
  await drag(page, tab(page, 0, "가"), await before(tab(page, 1, "다")));
  await expect(titles(page, 1)).toHaveText(["가", "다"]);
  await expect(editor(page, 1)).toHaveText("첫째!!");
  await expect(editor(page, 1)).toBeFocused();
  await page.keyboard.press("Meta+z");
  await expect(editor(page, 1)).toHaveText("첫째");
  await page.evaluate(() => window.__tote.app.flushAll());
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("첫째");
});

test("a drop that would split a narrow window does nothing and says so", async ({ page }) => {
  // An editing area of 572px: two halves of 286px are under the minimum.
  await page.setViewportSize({ width: 860, height: 720 });
  await start(page, { memos, session: session([[memoTab("a"), memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await drag(page, tab(page, 0, "나"), await rightEdge(page));
  await expect(page.locator(".status-message")).toHaveText(TOO_NARROW);
  await expect(panes(page)).toHaveCount(1);
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
});

test("Esc during a drag calls it off", async ({ page }) => {
  await start(page, { memos, session: session([[memoTab("a"), memoTab("b")], [memoTab("c")]]) });
  await drag(page, tab(page, 0, "나"), await before(tab(page, 1, "다")), false);
  await expect(page.locator(".tab.drop-before")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".tab.drop-before")).toHaveCount(0);
  await page.mouse.up();
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await expect(titles(page, 1)).toHaveText(["다"]);
});

test("a press that moves no more than 4px is a click", async ({ page }) => {
  await start(page, { memos, session: session([[memoTab("a"), memoTab("b")], [memoTab("c")]]) });
  const { x, y } = await centre(tab(page, 0, "나"));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 4, y, { steps: 2 });
  // Not dragging: no landing place is marked.
  await expect(page.locator(".tab.drop-before, .tab.drop-after")).toHaveCount(0);
  await page.mouse.up();
  await expect(activeTitle(page, 0)).toHaveText("나");
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await expect(panes(page)).toHaveCount(2);
});

test("a file dropped from Finder still opens as a tab", async ({ page }) => {
  await start(page, {
    memos,
    files: { "/x/a.sh": fakeFile("echo hi\n") },
    session: session([[memoTab("a"), memoTab("b")], [memoTab("c")]]),
  });
  await drag(page, tab(page, 0, "나"), await before(tab(page, 1, "다")));
  await expect(titles(page, 1)).toHaveText(["나", "다"]);
  await page.evaluate(() => window.__tote.backend.dropFiles(["/x/a.sh"]));
  await expect(activeTitle(page, 1)).toHaveText("a.sh");
  await expect(editor(page, 1)).toContainText("echo hi");
  await expect(titles(page, 1)).toHaveText(["나", "a.sh", "다"]);
});

test("a composition in progress lands before its tab moves", async ({ page }) => {
  await start(page, {
    memos,
    session: session([
      [{ ...memoTab("a"), selection: { ranges: [{ anchor: 2, head: 2 }], main: 0 } }],
      [memoTab("b")],
    ]),
  });
  await expect(editor(page, 0)).toBeFocused();
  // The input method's events as tests/e2e/panes.spec.ts sends them (from tests/e2e/pages/editor.ts),
  // into the first pane's editor; the move a drop makes comes mid-composition.
  const seen = await page.evaluate(async () => {
    const { app } = window.__tote;
    const [left, right] = app.panes;
    const view = left.view;
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
    const moved = app.moveTab(left.tabs.active!, right, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The move waits for the composition to end.
    const movedEarly = left.tabs.list.length === 0;
    fire("beforeinput", "deleteCompositionText", null);
    write(from, from + 1, "");
    fire("input", "deleteCompositionText", null);
    await tick();
    fire("beforeinput", "insertFromComposition", "가");
    write(from, from, "가");
    fire("input", "insertFromComposition", "가");
    await tick();
    composition("compositionend", "가");
    await moved;
    return { composing, movedEarly };
  });
  expect(seen).toEqual({ composing: true, movedEarly: false });
  await expect(panes(page)).toHaveCount(1);
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await expect(editor(page, 0)).toHaveText("첫째가");
  await expect.poll(() => page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("첫째가");
});

test("a pane the move empties closes and the session follows, though the target cannot show the tab", async ({
  page,
}) => {
  await start(page, { memos, session: session([[memoTab("a")], [memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가"]);
  await expect(titles(page, 1)).toHaveText(["나"]);
  await page.evaluate(async () => {
    const { app } = window.__tote;
    const [left, right] = app.panes;
    right.activate = () => Promise.reject(new Error("cannot show"));
    await app.moveTab(left.tabs.active!, right, 0).catch(() => {});
  });
  await expect(panes(page)).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(window.__tote.backend.data.session!).windows[0].panes.length),
    )
    .toBe(1);
});

test("closePane leaves a pane that still has tabs", async ({ page }) => {
  await start(page, { memos, session: session([[memoTab("a")], [memoTab("b")]]) });
  await expect(titles(page, 1)).toHaveText(["나"]);
  await page.evaluate(() => window.__tote.app.closePane(window.__tote.app.panes[1]));
  await expect(panes(page)).toHaveCount(2);
  await expect(titles(page, 1)).toHaveText(["나"]);
});
