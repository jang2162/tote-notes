import { expect, test, type Page } from "@playwright/test";

// The line numbers are 0.85 of the text and sit on their lines (memo trash spec 「줄번호 글자 크기」).

const DOC = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");

async function open(page: Page) {
  await page.goto(`/tests/e2e/pages/editor.html?linenumbers=1&doc=${encodeURIComponent(DOC)}`);
  await expect(page.locator(".cm-content")).toBeFocused();
}

/** The text sizes of the body and of every line number, and, line by line, how far the middle of
 * the number's glyphs is from the middle of the line's first glyph. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const { view } = window;
    const size = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
    const middle = (node: Node, from: number, to: number) => {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const box = range.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    const firstText = (el: Element) =>
      document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode() as Text;
    // The gutter's hidden width spacer ("99") is not a line's number.
    const numbers = [
      ...view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement"),
    ].filter((el) => el.style.visibility !== "hidden");
    const offsets = numbers.map((el) => {
      const n = Number(el.textContent);
      const { node } = view.domAtPos(view.state.doc.line(n).from);
      const line = (
        node.nodeType === Node.TEXT_NODE ? node.parentElement! : (node as Element)
      ).closest(".cm-line")!;
      const text = firstText(line);
      const number = firstText(el);
      return {
        n,
        offset: Math.abs(middle(number, 0, number.length) - middle(text, 0, 1)),
      };
    });
    return {
      body: size(view.contentDOM),
      numbers: numbers.map(size),
      offsets,
    };
  });

async function expectNumbersFit(page: Page) {
  const { body, numbers, offsets } = await measure(page);
  expect(offsets.map((o) => o.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  // The cursor's line among them: no gutter extension marks it apart.
  for (const n of numbers) expect(Math.abs(n - body * 0.85)).toBeLessThanOrEqual(0.5);
  for (const { n, offset } of offsets) expect(offset, `line ${n}`).toBeLessThanOrEqual(1);
}

test("line numbers are 0.85 of the text and sit on their lines", async ({ page }) => {
  await open(page);
  await expectNumbersFit(page);
});

test("line numbers follow a new text size", async ({ page }) => {
  await open(page);
  // As the font setting does it (`fontTheme` in src/editor/setup.ts sets the scroller's size).
  await page.evaluate(() => {
    window.view.scrollDOM.style.fontSize = "20px";
    window.view.requestMeasure();
  });
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(window.view.contentDOM).fontSize))
    .toBe("20px");
  // The gutter is redrawn on the next measure.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await expectNumbersFit(page);
});
