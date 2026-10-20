import { expect, test, type Locator, type Page } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import {
  boxOf,
  centre,
  paneSession,
  panesByPosition,
  sessionPane,
  sessionPaneCount,
  start,
} from "./helpers";

// Dragging a tab between the panes of one window, on the fake backend. The drag is made of pointer
// events (the spike could not confirm HTML5 drag and drop between tab bars in the app's webview), so
// the mouse goes down on a tab, moves and comes up where the tab is to go.

const panes = (page: Page) => page.locator(".pane");
const pane = (page: Page, index: number) => panes(page).nth(index);
const tab = (page: Page, index: number, title: string) =>
  pane(page, index).locator(".tab", { has: page.locator(".tab-title", { hasText: title }) });
const titles = (page: Page, index: number) => pane(page, index).locator(".tab .tab-title");
const activeTitle = (page: Page, index: number) =>
  pane(page, index).locator(".tab.active .tab-title");
const editor = (page: Page, index: number) => pane(page, index).locator(".cm-content");
const memoTab = (memoId: string) => ({ kind: "memo", memoId });
const titlesIn = (target: Locator) => target.locator(".tab .tab-title");
const mask = (page: Page) => page.locator(".drop-mask");

type Box = { x: number; y: number; width: number; height: number };

const memos = {
  a: fakeMemo("가.md", "첫째", { modifiedMs: 4 }),
  b: fakeMemo("나.md", "둘째", { modifiedMs: 3 }),
  c: fakeMemo("다.md", "셋째", { modifiedMs: 2 }),
  d: fakeMemo("라.md", "넷째", { modifiedMs: 1 }),
};

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

/** A point of `target`'s body — the part under its tab bar — at `fx` of its width and `fy` of its
 * height. */
async function inBody(target: Locator, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await boxOf(target.locator(".surface"));
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

/** Waits for the drop mask to cover `want` (±2px): it slides to a new place in 100ms. */
async function expectMask(page: Page, want: Box): Promise<void> {
  await expect(async () => {
    const got = await mask(page).boundingBox();
    expect(got).not.toBeNull();
    for (const key of ["x", "y", "width", "height"] as const)
      expect(Math.abs(got![key] - want[key])).toBeLessThanOrEqual(2);
  }).toPass({ timeout: 2000 });
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
    session: paneSession([
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
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b"), memoTab("c")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  await drag(page, tab(page, 0, "가"), await before(tab(page, 0, "다")));
  await expect(titles(page, 0)).toHaveText(["나", "가", "다"]);
  await expect(activeTitle(page, 0)).toHaveText("가");
});

test("a tab dropped on an empty pane goes into it", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")], []]) });
  await expect(panes(page)).toHaveCount(2);
  await drag(page, tab(page, 0, "나"), await centre(pane(page, 1).locator(".surface")));
  await expect(titles(page, 1)).toHaveText(["나"]);
  await expect(editor(page, 1)).toHaveText("둘째");
  await expect(pane(page, 1)).toHaveClass(/\bfocused\b/);
  await expect(titles(page, 0)).toHaveText(["가"]);
});

test("the mask covers the half a drop on the right edge would take", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  const box = await boxOf(pane(page, 0));
  await drag(page, tab(page, 0, "가"), await inBody(pane(page, 0), 7 / 8, 1 / 2), false);
  await expectMask(page, {
    x: box.x + box.width / 2,
    y: box.y,
    width: box.width / 2,
    height: box.height,
  });
  // Over a pane's body the tab bar marks no place.
  await expect(page.locator(".tab.drop-before, .tab.drop-after")).toHaveCount(0);
  await page.mouse.up();
  await expect(mask(page)).toHaveCount(0);
  await expect(panes(page)).toHaveCount(2);
  const [left, right] = await panesByPosition(page);
  await expect(titlesIn(left)).toHaveText(["나"]);
  await expect(titlesIn(right)).toHaveText(["가"]);
  await expect(right.locator(".cm-content")).toHaveText("첫째");
  await expect(right).toHaveClass(/\bfocused\b/);
  const [leftBox, rightBox] = [await boxOf(left), await boxOf(right)];
  expect(Math.abs(rightBox.x - (box.x + box.width / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(leftBox.y - rightBox.y)).toBeLessThanOrEqual(1);
  const memosOf = async (index: number) =>
    (await sessionPane(page, 0, index)).tabs.map((each) => each.kind === "memo" && each.memoId);
  await expect.poll(() => memosOf(1)).toEqual(["a"]);
  expect(await memosOf(0)).toEqual(["b"]);
});

test("the mask covers the whole pane in the middle, and a drop there puts the tab last", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b")], [memoTab("c")]]),
  });
  await expect(titles(page, 1)).toHaveText(["다"]);
  await drag(page, tab(page, 0, "가"), await inBody(pane(page, 1), 1 / 2, 1 / 2), false);
  await expectMask(page, await boxOf(pane(page, 1)));
  await page.mouse.up();
  await expect(mask(page)).toHaveCount(0);
  await expect(panes(page)).toHaveCount(2);
  await expect(titles(page, 1)).toHaveText(["다", "가"]);
  await expect(activeTitle(page, 1)).toHaveText("가");
  await expect(titles(page, 0)).toHaveText(["나"]);
});

test("dropping on the bottom edge stacks a new pane below", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  const box = await boxOf(pane(page, 0));
  await drag(page, tab(page, 0, "가"), await inBody(pane(page, 0), 1 / 2, 15 / 16), false);
  await expectMask(page, {
    x: box.x,
    y: box.y + box.height / 2,
    width: box.width,
    height: box.height / 2,
  });
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(2);
  const [top, bottom] = await panesByPosition(page);
  await expect(titlesIn(top)).toHaveText(["나"]);
  await expect(titlesIn(bottom)).toHaveText(["가"]);
  await expect(bottom.locator(".cm-content")).toHaveText("첫째");
  await expect(bottom).toHaveClass(/\bfocused\b/);
  const [topBox, bottomBox] = [await boxOf(top), await boxOf(bottom)];
  expect(Math.abs(topBox.x - bottomBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(bottomBox.y - (box.y + box.height / 2))).toBeLessThanOrEqual(2);
});

test("dropping on the top edge of another pane splits that pane", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b")], [memoTab("c")]]),
  });
  await expect(titles(page, 1)).toHaveText(["다"]);
  const before = await boxOf(pane(page, 1));
  await drag(page, tab(page, 0, "나"), await inBody(pane(page, 1), 1 / 2, 1 / 16), false);
  await expectMask(page, { ...before, height: before.height / 2 });
  // The edge is the body's top quarter (the part under the tab bar), not the whole pane's: 0.24 of
  // the body is still the top half's.
  const near = await inBody(pane(page, 1), 1 / 2, 0.24);
  await page.mouse.move(near.x, near.y);
  await expectMask(page, { ...before, height: before.height / 2 });
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(3);
  const [left, upper, lower] = await panesByPosition(page);
  await expect(titlesIn(left)).toHaveText(["가"]);
  await expect(titlesIn(upper)).toHaveText(["나"]);
  await expect(titlesIn(lower)).toHaveText(["다"]);
  await expect(upper).toHaveClass(/\bfocused\b/);
  const [leftBox, upperBox, lowerBox] = [await boxOf(left), await boxOf(upper), await boxOf(lower)];
  // The left pane keeps its whole height; the right one is cut in two.
  expect(Math.abs(leftBox.height - before.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(upperBox.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(lowerBox.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(upperBox.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(lowerBox.y - (before.y + before.height / 2))).toBeLessThanOrEqual(2);
});

test("a pane emptied by a drag closes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b")], [memoTab("c")]]),
  });
  await expect(titles(page, 1)).toHaveText(["다"]);
  await drag(page, tab(page, 1, "다"), await inBody(pane(page, 0), 1 / 2, 1 / 2));
  await expect(panes(page)).toHaveCount(1);
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  await expect(activeTitle(page, 0)).toHaveText("다");
  const [area, left] = [await boxOf(page.locator(".panes")), await boxOf(pane(page, 0))];
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(left[key] - area[key])).toBeLessThanOrEqual(1);
});

test("a side too small to split shows the whole pane instead", async ({ page }) => {
  // An editing area of 600px: a half would be under 320px.
  await page.setViewportSize({ width: 840, height: 720 });
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  const box = await boxOf(pane(page, 0));
  expect(Math.round(box.width)).toBe(600);
  await drag(page, tab(page, 0, "가"), await inBody(pane(page, 0), 7 / 8, 1 / 2), false);
  await expectMask(page, box);
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(1);
  await expect(titles(page, 0)).toHaveText(["나", "가"]);
  await expect(page.locator(".status-message")).toHaveText("");
});

test("a lone tab over its own pane's edge shows no mask and stays", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, { memos, session: paneSession([[memoTab("a")]]) });
  await expect(titles(page, 0)).toHaveText(["가"]);
  // Its middle shows the mask, so the mask going away at the edge is the edge's doing.
  await drag(page, tab(page, 0, "가"), await inBody(pane(page, 0), 1 / 2, 1 / 2), false);
  await expectMask(page, await boxOf(pane(page, 0)));
  const edge = await inBody(pane(page, 0), 7 / 8, 1 / 2);
  await page.mouse.move(edge.x, edge.y, { steps: 4 });
  await expect(mask(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(1);
  await expect(titles(page, 0)).toHaveText(["가"]);
  await expect(editor(page, 0)).toHaveText("첫째");
});

test("dragging the last tab out closes its pane", async ({ page }) => {
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b")], [memoTab("c")]], { focusedPane: 1 }),
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
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b")], [memoTab("c")]]),
  });
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

test("a drop near the right edge of a narrow window goes into the pane too", async ({ page }) => {
  // An editing area of 572px, too narrow to split.
  await page.setViewportSize({ width: 812, height: 720 });
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await drag(page, tab(page, 0, "가"), await rightEdge(page));
  await expect(titles(page, 0)).toHaveText(["나", "가"]);
  await expect(activeTitle(page, 0)).toHaveText("가");
  await expect(page.locator(".status-message")).toHaveText("");
  await expect(panes(page)).toHaveCount(1);
});

test("Esc during a drag calls it off", async ({ page }) => {
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b")], [memoTab("c")]]),
  });
  await drag(page, tab(page, 0, "나"), await before(tab(page, 1, "다")), false);
  await expect(page.locator(".tab.drop-before")).toHaveCount(1);
  await expect(mask(page)).toHaveCount(0);
  // On into the pane's body: the mask takes over from the tab bar's mark.
  const body = await inBody(pane(page, 1), 1 / 2, 1 / 2);
  await page.mouse.move(body.x, body.y, { steps: 4 });
  await expect(mask(page)).toHaveCount(1);
  await expect(page.locator(".tab.drop-before")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(mask(page)).toHaveCount(0);
  await expect(page.locator(".tab.drop-before, .tab.drop-after")).toHaveCount(0);
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(2);
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await expect(titles(page, 1)).toHaveText(["다"]);
});

test("a press that moves no more than 4px is a click", async ({ page }) => {
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b")], [memoTab("c")]]),
  });
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
    session: paneSession([[memoTab("a"), memoTab("b")], [memoTab("c")]]),
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
    session: paneSession([
      [{ ...memoTab("a"), selection: { ranges: [{ anchor: 2, head: 2 }], main: 0 } }],
      [memoTab("b")],
    ]),
  });
  await expect(editor(page, 0)).toBeFocused();
  // The text is drawn: the composition goes at its position 2.
  await expect(editor(page, 0)).toHaveText("첫째");
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

test("a composition in progress lands in its memo before a drag splits", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: paneSession([
      [{ ...memoTab("a"), selection: { ranges: [{ anchor: 2, head: 2 }], main: 0 } }, memoTab("b")],
    ]),
  });
  await expect(editor(page, 0)).toBeFocused();
  // The text is drawn: the composition goes at its position 2.
  await expect(editor(page, 0)).toHaveText("첫째");
  const bottom = await inBody(pane(page, 0), 1 / 2, 15 / 16);
  // The input method's events as in the test above; the drop on the pane's bottom edge comes
  // mid-composition.
  const seen = await page.evaluate(async (at) => {
    const { app } = window.__tote;
    const [only] = app.panes;
    const view = only.view;
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
    const drag = app.dragTab(only.tabs.active!.tabId);
    drag.over(at.x, at.y);
    // In the window: the screen point is not looked at.
    drag.drop(at.x, at.y, 0, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The split waits for the composition to end.
    const splitEarly = app.panes.length > 1;
    fire("beforeinput", "deleteCompositionText", null);
    write(from, from + 1, "");
    fire("input", "deleteCompositionText", null);
    await tick();
    fire("beforeinput", "insertFromComposition", "가");
    write(from, from, "가");
    fire("input", "insertFromComposition", "가");
    await tick();
    composition("compositionend", "가");
    return { composing, splitEarly };
  }, bottom);
  expect(seen).toEqual({ composing: true, splitEarly: false });
  await expect(panes(page)).toHaveCount(2);
  const [upper, lower] = await panesByPosition(page);
  await expect(titlesIn(upper)).toHaveText(["나"]);
  await expect(titlesIn(lower)).toHaveText(["가"]);
  await expect(lower.locator(".cm-content")).toHaveText("첫째가");
  await expect.poll(() => page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("첫째가");
});

test("a pane the move empties closes and the session follows, though the target cannot show the tab", async ({
  page,
}) => {
  await start(page, { memos, session: paneSession([[memoTab("a")], [memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가"]);
  await expect(titles(page, 1)).toHaveText(["나"]);
  await page.evaluate(async () => {
    const { app } = window.__tote;
    const [left, right] = app.panes;
    right.activate = () => Promise.reject(new Error("cannot show"));
    await app.moveTab(left.tabs.active!, right, 0).catch(() => {});
  });
  await expect(panes(page)).toHaveCount(1);
  await expect.poll(() => sessionPaneCount(page)).toBe(1);
});

test("closePane leaves a pane that still has tabs", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a")], [memoTab("b")]]) });
  await expect(titles(page, 1)).toHaveText(["나"]);
  await page.evaluate(() => window.__tote.app.closePane(window.__tote.app.panes[1]));
  await expect(panes(page)).toHaveCount(2);
  await expect(titles(page, 1)).toHaveText(["나"]);
});

test("a drag goes on and ends cleanly when the pointer cannot be captured", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  await page.evaluate(() => {
    Element.prototype.setPointerCapture = () => {
      throw new DOMException("no such pointer", "InvalidStateError");
    };
  });
  await drag(page, tab(page, 0, "가"), await rightEdge(page), false);
  await expect(mask(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(mask(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(1);
  await expect(titles(page, 0)).toHaveText(["가", "나"]);
  expect(errors).toEqual([]);
});
