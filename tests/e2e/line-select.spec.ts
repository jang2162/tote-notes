import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { paneSession, start } from "./helpers";

// Pressing the line numbers selects whole lines, as VS Code does (settings spec 「줄번호와 편집기
// 설정」).

async function open(page: Page, query: string) {
  await page.goto(`/tests/e2e/pages/editor.html?linenumbers=1&${query}`);
  await expect(page.locator(".cm-content")).toBeFocused();
}

const openDoc = (page: Page, doc: string) => open(page, `doc=${encodeURIComponent(doc)}`);

/** A screen point on the line-number gutter, level with the middle of line `n` (`row` picks a
 * point that far down the line instead, 0 its top and 1 its bottom). */
function gutterPoint(page: Page, n: number, row = 0.5) {
  return page.evaluate(
    ([line, at]) => {
      const { view } = window;
      const block = view.lineBlockAt(view.state.doc.line(line).from);
      const gutter = view.dom.querySelector(".cm-lineNumbers")!.getBoundingClientRect();
      return {
        x: gutter.left + gutter.width / 2,
        y: view.documentTop + block.top + block.height * at,
      };
    },
    [n, row] as const,
  );
}

async function press(page: Page, n: number, modifiers: "Shift"[] = []) {
  const at = await gutterPoint(page, n);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click(at.x, at.y);
  for (const key of modifiers) await page.keyboard.up(key);
}

async function drag(page: Page, from: number, to: number) {
  const start = await gutterPoint(page, from);
  const end = await gutterPoint(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

const range = (page: Page) =>
  page.evaluate(() => {
    const { ranges, main } = window.view.state.selection;
    return { ranges: ranges.length, anchor: main.anchor, head: main.head };
  });
const text = (page: Page) => page.evaluate(() => window.view.state.doc.toString());

// Lines: "one" 0-3, "" 4, "three" 5-10, "four" 11-15.
const DOC = "one\n\nthree\nfour";

test("a click on a line number selects the line through its line break, the editor keeping the keys", async ({
  page,
}) => {
  await openDoc(page, DOC);
  // WebKit also focuses the editor when CodeMirror writes a pointer selection into it: this sees
  // that the editor has the keys, not which of the two gave them.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await press(page, 3);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 5, head: 11 });
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Backspace");
  expect(await text(page)).toBe("one\n\nfour");
});

test("an empty line, the last line and a one-line text", async ({ page }) => {
  await openDoc(page, DOC);
  await press(page, 2);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 4, head: 5 });
  // The last line has no line break to take.
  await press(page, 4);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 11, head: 15 });
  await openDoc(page, "only");
  await press(page, 1);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 0, head: 4 });
});

test("a click replaces several cursors with the one line", async ({ page }) => {
  await openDoc(page, DOC);
  await page.evaluate(() => {
    const { view, EditorSelection } = window;
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(6)]),
    });
  });
  await press(page, 1);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 0, head: 4 });
});

test("dragging over the line numbers selects the lines passed over, down and up", async ({
  page,
}) => {
  await openDoc(page, DOC);
  await drag(page, 2, 4);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 4, head: 15 });
  // Up: from past the pressed line's break to the start of the line the pointer is on.
  await drag(page, 3, 1);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 11, head: 0 });
});

test("⇧click widens the selection by lines from where it started", async ({ page }) => {
  await openDoc(page, DOC);
  await press(page, 2);
  await press(page, 4, ["Shift"]);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 4, head: 15 });
  // Above the line it started on: that line stays in the selection.
  await press(page, 1, ["Shift"]);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 5, head: 0 });
  // Started upward, it still goes on from the line pressed first, not from the line the anchor
  // (past that line's break) sits on.
  await press(page, 3);
  await press(page, 1, ["Shift"]);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 11, head: 0 });
  await press(page, 4, ["Shift"]);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 5, head: 15 });
  // From a selection made in the text, it goes on from the line of the selection's anchor.
  await page.evaluate(() => window.view.dispatch({ selection: { anchor: 7, head: 8 } }));
  await press(page, 1, ["Shift"]);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 11, head: 0 });
});

test("a change to the text or a swapped state while the line numbers are held ends the drag", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /** Holds line `n`'s number, does `meanwhile`, and drags on to where line `to` was. */
  async function holdThen(n: number, meanwhile: () => Promise<unknown>, to: number) {
    const at = await gutterPoint(page, n);
    const end = await gutterPoint(page, to);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await meanwhile();
    await page.mouse.move(end.x, end.y, { steps: 4 });
    await page.mouse.up();
  }
  await openDoc(page, DOC);
  // The last line gone, the line held is past the end of the text.
  await holdThen(4, () => page.keyboard.press("Backspace"), 1);
  expect(await text(page)).toBe("one\n\nthree\n");
  expect(await range(page)).toEqual({ ranges: 1, anchor: 11, head: 11 });
  expect(errors).toEqual([]);
  // The first line gone, its old place is another line's: the drag selects nothing from it.
  await openDoc(page, DOC);
  await holdThen(1, () => page.keyboard.press("Backspace"), 3);
  expect(await text(page)).toBe("\nthree\nfour");
  expect(await range(page)).toEqual({ ranges: 1, anchor: 0, head: 0 });
  // A pane swaps the editor's state for another tab's: another text altogether.
  await openDoc(page, DOC);
  await holdThen(
    4,
    () => page.evaluate(() => window.view.setState(window.EditorState.create({ doc: "a\nb" }))),
    1,
  );
  expect(await range(page)).toEqual({ ranges: 1, anchor: 0, head: 0 });
  expect(errors).toEqual([]);
});

test("a wrapped line is selected whole from any of its rows", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 600 });
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  await openDoc(page, `first\n${long}\nlast`);
  const top = await gutterPoint(page, 2, 0.1);
  const bottom = await gutterPoint(page, 2, 0.9);
  expect(bottom.y - top.y).toBeGreaterThan(40); // it does wrap
  await page.mouse.click(bottom.x, bottom.y);
  expect(await range(page)).toEqual({ ranges: 1, anchor: 6, head: 6 + long.length + 1 });
});

test("held past the editor's bottom, a drag scrolls and goes on selecting", async ({ page }) => {
  // The scrolling runs on a timer: the clock is stopped, and moved by hand.
  await page.clock.install();
  await open(page, "lines=200");
  await page.clock.pauseAt(Date.now() + 1000);
  const start = await gutterPoint(page, 1);
  const editor = (await page.locator(".cm-editor").boundingBox())!;
  const bottom = await page.evaluate(
    () => window.view.lineBlockAtHeight(window.view.scrollDOM.clientHeight).to,
  );
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, editor.y + editor.height + 40, { steps: 4 });
  await page.clock.runFor(500);
  const scrolled = await page.evaluate(() => window.view.scrollDOM.scrollTop);
  expect(scrolled).toBeGreaterThan(200);
  const { anchor, head } = await range(page);
  expect(anchor).toBe(0);
  // On a line below where the editor's bottom was before it scrolled.
  expect(head).toBeGreaterThan(bottom);
  await page.mouse.up();
  // Let go, it neither scrolls nor follows the pointer any more.
  await page.clock.runFor(500);
  await page.mouse.move(start.x, start.y);
  expect(await page.evaluate(() => window.view.scrollDOM.scrollTop)).toBe(scrolled);
  expect((await range(page)).head).toBe(head);
});

test("in the app, a line number selects the line of the memo for the keys", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유\n계란\n두유") } });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toContainText("두유");
  const number = page.locator(".cm-lineNumbers .cm-gutterElement", { hasText: /^2$/ });
  // Take the keys from the editor first: the press must hand them back.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect(page.locator(".cm-content")).not.toBeFocused();
  await number.click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".cm-content")).toHaveText("우유두유");
});

test("a line number of another pane gives that pane the keys, on its line", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "첫째\n둘째"),
      b: fakeMemo("나.md", "셋째\n넷째"),
    },
    session: paneSession([[{ kind: "memo", memoId: "a" }], [{ kind: "memo", memoId: "b" }]]),
  });
  const [left, right] = [page.locator(".pane").nth(0), page.locator(".pane").nth(1)];
  await expect(right.locator(".cm-content")).toHaveText("셋째넷째");
  await expect(left).toHaveClass(/focused/);
  await right.locator(".cm-lineNumbers .cm-gutterElement", { hasText: /^1$/ }).click();
  await expect(right).toHaveClass(/focused/);
  await expect(right.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(right.locator(".cm-content")).toHaveText("넷째");
  await expect(left.locator(".cm-content")).toHaveText("첫째둘째");
});
