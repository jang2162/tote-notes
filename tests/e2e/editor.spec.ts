import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, doc: string, file = "note.md") {
  await page.goto(
    `/tests/e2e/pages/editor.html?file=${encodeURIComponent(file)}&doc=${encodeURIComponent(doc)}`,
  );
  await expect(page.locator(".cm-content")).toBeFocused();
}

/** A screen point just inside the character at `pos`. */
function pointAt(page: Page, pos: number) {
  return page.evaluate((p) => {
    const rect = window.view.coordsAtPos(p)!;
    return { x: rect.left + 2, y: (rect.top + rect.bottom) / 2 };
  }, pos);
}

const ranges = (page: Page) =>
  page.evaluate(() => window.view.state.selection.ranges.map((r) => [r.anchor, r.head]));
const text = (page: Page) => page.evaluate(() => window.view.state.doc.toString());

test("⌥click adds a cursor and keeps the one already there", async ({ page }) => {
  await open(page, "one\ntwo\nthree");
  const a = await pointAt(page, 1);
  const b = await pointAt(page, 5);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down("Alt");
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up("Alt");
  expect(await ranges(page)).toEqual([
    [1, 1],
    [5, 5],
  ]);
});

test("⌥drag selects a rectangle that replaces the selection", async ({ page }) => {
  await open(page, "abcd\nefgh\nijkl");
  const start = await pointAt(page, 1);
  const end = await pointAt(page, 12);
  await page.mouse.click(start.x - 4, start.y); // a plain cursor first, which must not survive
  await page.keyboard.down("Alt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect(await ranges(page)).toEqual([
    [1, 2],
    [6, 7],
    [11, 12],
  ]);
});

/** Sets several ranges; `main` is the index CodeMirror would have given the last ⌥click. */
async function select(page: Page, ranges: [number, number][], main = 0) {
  await page.evaluate(
    ([rs, m]) => {
      const { view, EditorSelection } = window;
      view.dispatch({
        selection: EditorSelection.create(
          rs.map(([anchor, head]) => EditorSelection.range(anchor, head)),
          m,
        ),
      });
    },
    [ranges, main] as const,
  );
}

// The Hangul specs replay the input method's recorded event shapes (tests/e2e/pages/editor.ts).
// Three cursors at the ends of 사과 / 배 / 귤, the last ⌥click on the middle line, as recorded.
const THREE: [number, number][] = [
  [2, 2],
  [4, 4],
  [6, 6],
];

test("with several ranges the first one is the main range", async ({ page }) => {
  await open(page, "사과\n배\n귤");
  await select(page, THREE, 1);
  expect(await page.evaluate(() => window.view.state.selection.mainIndex)).toBe(0);
  expect(await ranges(page)).toEqual(THREE);
});

test("direct-path Hangul at three cursors lands at every cursor", async ({ page }) => {
  await open(page, "사과\n배\n귤");
  await select(page, THREE, 1);
  await page.evaluate(() => window.ime.insertText("ㄱ"));
  expect(await text(page)).toBe("사과ㄱ\n배ㄱ\n귤ㄱ");
  await page.evaluate(() => window.ime.replaceBefore(1, "가"));
  expect(await text(page)).toBe("사과가\n배가\n귤가");
  await page.evaluate(() => window.ime.replaceBefore(1, "간"));
  await page.evaluate(() => window.ime.replaceBefore(1, "가"));
  await page.evaluate(() => window.ime.insertText("나"));
  expect(await text(page)).toBe("사과가나\n배가나\n귤가나");
  expect(await ranges(page)).toEqual([
    [4, 4],
    [8, 8],
    [12, 12],
  ]);
});

test("composition-path Hangul at three cursors lands at every cursor", async ({ page }) => {
  await open(page, "사과\n배\n귤");
  await select(page, THREE, 1);
  await page.evaluate(() => window.ime.start());
  await page.evaluate(() => window.ime.update("ㄱ"));
  await page.evaluate(() => window.ime.update("가"));
  // While composing, the preview is at the main range only.
  expect(await text(page)).toBe("사과가\n배\n귤");
  expect(await ranges(page)).toEqual([[3, 3]]);
  await page.evaluate(() => window.ime.end("replace"));
  expect(await text(page)).toBe("사과가\n배가\n귤가");
  expect(await ranges(page)).toEqual([
    [3, 3],
    [6, 6],
    [9, 9],
  ]);
  await page.evaluate(() => window.ime.start());
  await page.evaluate(() => window.ime.update("ㄴ"));
  await page.evaluate(() => window.ime.update("나"));
  await page.evaluate(() => window.ime.end("replace"));
  expect(await text(page)).toBe("사과가나\n배가나\n귤가나");
  expect(await ranges(page)).toEqual([
    [4, 4],
    [8, 8],
    [12, 12],
  ]);
});

test("recording 1 — a direct jamo, then compositions: every cursor ends the same", async ({
  page,
}) => {
  // The recording: ㄱ arrived as a plain insertText, then the input method opened a fresh
  // composition for ㅏ and another for 나. Each cursor must end with the same text, whatever
  // syllables the input method made of it.
  await open(page, "사과\n배\n귤");
  await select(page, THREE, 1);
  await page.evaluate(() => window.ime.insertText("ㄱ"));
  await page.evaluate(() => window.ime.start());
  await page.evaluate(() => window.ime.update("ㅏ"));
  await page.evaluate(() => window.ime.end("replace"));
  await page.evaluate(() => window.ime.start());
  await page.evaluate(() => window.ime.update("ㄴ"));
  await page.evaluate(() => window.ime.update("나"));
  await page.evaluate(() => window.ime.end("replace"));
  expect(await text(page)).toBe("사과ㄱㅏ나\n배ㄱㅏ나\n귤ㄱㅏ나");
  expect(await ranges(page)).toEqual([
    [5, 5],
    [10, 10],
    [15, 15],
  ]);
});

test("recording 2 — two ⌘D selections and a composition: both become the syllable", async ({
  page,
}) => {
  // The recorded order: the first word selected, ⌘D adds the second, then the composition —
  // with a second compositionstart inside it and a bare compositionend with empty data.
  await open(page, "test test");
  await page.evaluate(() => window.view.dispatch({ selection: { anchor: 0, head: 4 } }));
  await page.keyboard.press("Meta+d");
  expect(await ranges(page)).toEqual([
    [0, 4],
    [5, 9],
  ]);
  await page.evaluate(() => window.ime.start());
  await page.evaluate(() => window.ime.update("ㄱ"));
  await page.evaluate(() => window.ime.restart());
  await page.evaluate(() => window.ime.update("가"));
  // Until the end, nothing is copied to the other selection.
  expect(await text(page)).toBe("가 test");
  expect(await ranges(page)).toEqual([[1, 1]]);
  await page.evaluate(() => window.ime.end("bare"));
  expect(await text(page)).toBe("가 가");
  expect(await ranges(page)).toEqual([
    [1, 1],
    [3, 3],
  ]);
});

test("direct-path Hangul over two selections replaces both", async ({ page }) => {
  await open(page, "test test");
  await select(page, [
    [0, 4],
    [5, 9],
  ]);
  await page.evaluate(() => window.ime.insertText("ㄱ"));
  expect(await text(page)).toBe("ㄱ ㄱ");
  await page.evaluate(() => window.ime.replaceBefore(1, "가"));
  expect(await text(page)).toBe("가 가");
  expect(await ranges(page)).toEqual([
    [1, 1],
    [3, 3],
  ]);
});

test("a cancelled composition leaves nothing at any cursor", async ({ page }) => {
  // A synthetic shape, not in the recordings: the input method removes the composed text before
  // compositionend. The person's real check saw Esc commit the syllable instead (every cursor
  // got the same `ㄱ`); this pins what happens if a cancel ever does arrive.
  await open(page, "사과\n배\n귤");
  await select(page, THREE, 1);
  await page.evaluate(() => window.ime.start());
  await page.evaluate(() => window.ime.update("ㄱ"));
  expect(await text(page)).toBe("사과ㄱ\n배\n귤");
  await page.evaluate(() => window.ime.end("cancel"));
  expect(await text(page)).toBe("사과\n배\n귤");
  expect(await ranges(page)).toEqual(THREE);
});

test("a composition CodeMirror ends without a compositionend still settles every cursor", async ({
  page,
}) => {
  // Safari sometimes forgets compositionend; CodeMirror then ends the composition itself 20 ms
  // after an insertText that arrives while composing, and no DOM event reaches us. The waiting
  // cursors must still get the text, and later typing at one cursor must stay at that cursor.
  await open(page, "사과\n배\n귤");
  await select(page, THREE, 1);
  await page.evaluate(() => window.ime.start());
  await page.evaluate(() => window.ime.update("´"));
  await page.evaluate(() => window.ime.insertText("é"));
  await expect.poll(() => text(page)).toBe("사과é\n배é\n귤é");
  expect(await ranges(page)).toEqual([
    [3, 3],
    [6, 6],
    [9, 9],
  ]);
  await select(page, [[3, 3]]);
  await page.keyboard.type(" hi ");
  await page.evaluate(() => window.ime.start());
  await page.evaluate(() => window.ime.update("가"));
  await page.evaluate(() => window.ime.end("replace"));
  expect(await text(page)).toBe("사과é hi 가\n배é\n귤é");
  expect(await ranges(page)).toEqual([[8, 8]]);
});

test("a multi-line main selection does not cost the other selection its text", async ({ page }) => {
  // CodeMirror's own compositionstart handling deletes every non-empty selection when the main
  // one spans lines; ours runs first and keeps the others out of its way until the end, when the
  // composed text replaces them too.
  await open(page, "one\ntwo\nthree four");
  await select(page, [
    [0, 5],
    [14, 18],
  ]);
  await page.evaluate(() => window.ime.start());
  expect(await text(page)).toBe("wo\nthree four");
  expect(await ranges(page)).toEqual([[0, 0]]);
  await page.evaluate(() => window.ime.update("가"));
  await page.evaluate(() => window.ime.end("replace"));
  expect(await text(page)).toBe("가wo\nthree 가");
  expect(await ranges(page)).toEqual([
    [1, 1],
    [11, 11],
  ]);
});

test("typing that is not a composition keeps every cursor", async ({ page }) => {
  await open(page, "aa\nbb\ncc");
  await select(page, [
    [2, 2],
    [5, 5],
    [8, 8],
  ]);
  await page.keyboard.type("xy");
  expect(await text(page)).toBe("aaxy\nbbxy\nccxy");
});

test("⌘D adds the next occurrence of the selected word", async ({ page }) => {
  await open(page, "foo bar foo");
  await page.evaluate(() => window.view.dispatch({ selection: { anchor: 0, head: 3 } }));
  await page.keyboard.press("Meta+d");
  expect(await ranges(page)).toEqual([
    [0, 3],
    [8, 11],
  ]);
});

test("Enter continues a Markdown list and Tab indents at the cursor", async ({ page }) => {
  await open(page, "");
  await page.keyboard.type("- 하나");
  await page.keyboard.press("Enter");
  await page.keyboard.type("둘");
  expect(await text(page)).toBe("- 하나\n- 둘");
  await page.keyboard.press("Tab");
  expect(await text(page)).toBe("- 하나\n- 둘  ");
});
