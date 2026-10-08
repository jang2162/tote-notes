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

test("a composition starting with several cursors keeps only the main one", async ({ page }) => {
  await open(page, "하나\n둘\n셋");
  await page.evaluate(() => {
    const { view, EditorSelection } = window;
    view.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.cursor(2), EditorSelection.cursor(4), EditorSelection.cursor(6)],
        0,
      ),
    });
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  });
  expect(await ranges(page)).toEqual([[2, 2]]);

  // A multi-line main selection must not cost the others their text: CodeMirror's own
  // compositionstart handling deletes every non-empty selection unless ours runs first. The main
  // selection itself is replaced by the composition, as usual; "four" has to survive.
  await open(page, "one\ntwo\nthree four");
  await page.evaluate(() => {
    const { view, EditorSelection } = window;
    view.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.range(0, 5), EditorSelection.range(14, 18)],
        0,
      ),
    });
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  });
  expect(await text(page)).toBe("wo\nthree four");
  expect(await ranges(page)).toEqual([[0, 0]]);

  // Typing that is not a composition keeps every cursor.
  await open(page, "aa\nbb\ncc");
  await page.evaluate(() => {
    const { view, EditorSelection } = window;
    view.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.cursor(2), EditorSelection.cursor(5), EditorSelection.cursor(8)],
        0,
      ),
    });
  });
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
