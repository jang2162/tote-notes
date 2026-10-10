import { expect, test, type Page } from "@playwright/test";

// The text goes in the fragment, which stays in the browser: a 20,000-character query string
// makes the dev server answer 431.
async function open(page: Page, doc: string, file: string, extra = "") {
  await page.goto(
    `/tests/e2e/pages/editor.html?highlight=1&file=${encodeURIComponent(file)}${extra}#doc=${encodeURIComponent(doc)}`,
  );
  await expect(page.locator(".cm-content")).toBeFocused();
}

const coloured = (page: Page) => page.locator(".cm-line span[class*='tm-c']");
/** Dark+ comments, #6A9955. */
const DARK_PLUS_COMMENT = "rgb(106, 153, 85)";

test("a shell script gets TextMate colours from the worker", async ({ page }) => {
  await open(page, "# comment\necho hi", "run.sh");
  await expect(coloured(page).first()).toBeVisible();
  const classes = await page
    .locator(".cm-line")
    .first()
    .locator("span")
    .first()
    .getAttribute("class");
  expect(classes).toMatch(/tm-c\d+/);
  expect(await page.evaluate(() => document.getElementById("tm-colors")?.textContent)).toContain(
    ".tm-c",
  );
});

test("typed text is coloured and an edit recolours from its line", async ({ page }) => {
  await open(page, "echo one\necho two", "run.sh");
  await expect(coloured(page).first()).toBeVisible();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# a comment");
  const lastLine = page.locator(".cm-line").last();
  // Every token gets a colour class, so the colour itself says the line became a comment.
  await expect(lastLine.locator("span[class*='tm-c']").first()).toHaveCSS(
    "color",
    DARK_PLUS_COMMENT,
  );
});

test("lines typed while the grammar is still loading are coloured once it arrives", async ({
  page,
}) => {
  await open(page, "echo hi", "run.sh", "&slowgrammar=800");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("echo two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# late comment");
  // Typed before any colour came: the worker must open the text as it stands then.
  expect(await coloured(page).count()).toBe(0);
  const lastLine = page.locator(".cm-line").last();
  await expect(lastLine.locator("span[class*='tm-c']").first()).toHaveCSS(
    "color",
    DARK_PLUS_COMMENT,
  );
});

test("a document closed while its grammar loads is never opened in the worker", async ({
  page,
}) => {
  await open(page, "echo hi", "run.sh", "&slowgrammar=500");
  await page.evaluate(() => window.closeDoc());
  await page.waitForTimeout(1000);
  const log = await page.evaluate(() => window.workerLog);
  expect(log.filter((m) => m.type === "close")).toHaveLength(1);
  expect(log.filter((m) => m.type === "open")).toEqual([]);
});

test("a line over 20,000 characters stays plain while the others are coloured", async ({
  page,
}) => {
  const long = "x".repeat(20_001);
  // Without wrapping, as the app opens a file with a line this long (WRAP_LIMIT): wrapped, the
  // line would push the third one out of the rendered range.
  await open(page, `echo hi\n${long}\necho bye`, "run.sh", "&nowrap=1");
  await expect(
    page.locator(".cm-line").last().locator("span[class*='tm-c']").first(),
  ).toBeVisible();
  expect(await page.locator(".cm-line").nth(1).locator("span[class*='tm-c']").count()).toBe(0);
});

test("a grammar that fails to load leaves the text uncoloured and editable", async ({ page }) => {
  await open(page, "echo hi", "run.sh", "&badgrammar=1");
  await page.waitForTimeout(500);
  expect(await coloured(page).count()).toBe(0);
  await page.keyboard.press("End");
  await page.keyboard.type(" there");
  expect(await page.evaluate(() => window.view.state.doc.toString())).toBe("echo hi there");
});

test("a file without a grammar and plain text stay uncoloured", async ({ page }) => {
  await open(page, "just text", "notes.txt");
  await page.waitForTimeout(300);
  expect(await coloured(page).count()).toBe(0);
});

test("a theme the tokenizer cannot take leaves the text plain and editable", async ({ page }) => {
  await open(page, "# comment\necho hi", "run.sh", "&badtheme=1");
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => document.getElementById("tm-colors")?.textContent),
  ).not.toContain(".tm-c");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" there");
  expect(await page.evaluate(() => window.view.state.doc.toString())).toBe(
    "# comment\necho hi there",
  );
});

test("a theme change recolours the open document without an edit", async ({ page }) => {
  await open(page, "# comment\necho hi", "run.sh");
  const comment = page.locator(".cm-line").first().locator("span[class*='tm-c']").first();
  await expect(comment).toHaveCSS("color", DARK_PLUS_COMMENT);
  // Two rules sorting before "comment" move its colour id (Dark+ and Light+ give it the same
  // one), so colours stay right only if the tokens are asked for again.
  await page.evaluate(() =>
    window.highlightTheme({
      settings: [
        { settings: { foreground: "#D4D4D4", background: "#1E1E1E" } },
        { scope: "a", settings: { foreground: "#111111" } },
        { scope: "b", settings: { foreground: "#222222" } },
        { scope: "comment", settings: { foreground: "#00AA00" } },
      ],
    }),
  );
  await expect(comment).toHaveCSS("color", "rgb(0, 170, 0)");
});

// The app swaps the view's state on every tab switch, which rebuilds the plugins: the document
// must stay in the worker (with its line states) instead of being closed and sent again.
test("a document stays open in the worker while another state is shown", async ({ page }) => {
  await open(page, "# comment\necho hi", "run.sh");
  await expect(coloured(page).first()).toBeVisible();
  await page.evaluate(() => {
    const state = window.view.state;
    window.view.setState(window.EditorState.create({ doc: "other" }));
    window.view.setState(state);
  });
  await expect(coloured(page).first()).toBeVisible();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# after");
  await expect(page.locator(".cm-line").last().locator("span[class*='tm-c']").first()).toHaveCSS(
    "color",
    DARK_PLUS_COMMENT,
  );
  const log = await page.evaluate(() => window.workerLog);
  expect(log.filter((m) => m.type === "open")).toHaveLength(1);
  expect(log.filter((m) => m.type === "close")).toEqual([]);
});
