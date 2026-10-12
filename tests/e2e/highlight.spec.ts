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
/** Dark+ `storage.type` (`const`), #569CD6. */
const DARK_PLUS_STORAGE = "rgb(86, 156, 214)";

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

test("a ts fence inside markdown is coloured", async ({ page }) => {
  await open(page, "```ts\nconst a = 1;\n```\n\n```\nconst b = 2;\n```", "note.md");
  const lines = page.locator(".cm-line");
  const fenced = lines.nth(1).locator("span[class*='tm-c']", { hasText: /^const$/ });
  await expect(fenced).toHaveCSS("color", DARK_PLUS_STORAGE);
  expect(await fenced.getAttribute("class")).toMatch(/tm-c\d+/);
  // A fence without a language stays the fence's colour: the colour above is TypeScript's.
  const plain = lines.nth(5).locator("span[class*='tm-c']").first();
  await expect(plain).toBeVisible();
  await expect(plain).not.toHaveCSS("color", DARK_PLUS_STORAGE);
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

// The worker's vscode-textmate registry keeps the first grammar of a scope for good, so a
// grammar that was replaced (a fixed version of a broken extension) needs a new registry.
test("a document opened after the grammars were forgotten follows the replaced grammar", async ({
  page,
}) => {
  await open(page, "", "run.sh");
  const starts = (grammarMatch: string) =>
    page.evaluate(async (match) => {
      const lang = window.highlightLang;
      const scope = lang.grammar!.scopeName;
      window.fileOverride[lang.grammar!.path] = JSON.stringify({
        scopeName: scope,
        patterns: [{ match, name: "comment.line" }],
      });
      const client = window.highlightClient;
      const doc = client.nextDocId();
      await client.open(doc, lang, () => "foo bar");
      const lines = await client.tokens(doc, 0, 1);
      client.close(doc);
      return Array.from(lines![0]).filter((_, i) => i % 3 === 0);
    }, grammarMatch);
  expect(await starts("foo")).toContain(3);
  await page.evaluate(() => window.highlightClient.forgetGrammars());
  const second = await starts("bar");
  expect(second).toContain(4);
  expect(second).not.toContain(3);
});

/** 200,000 lines of TypeScript: tokenizing them all takes the worker several seconds. */
async function openBig(page: Page, extra = "") {
  await page.goto(`/tests/e2e/pages/editor.html?highlight=1&file=big.ts&lines=200000${extra}`);
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(coloured(page).first()).toBeVisible();
}

test("a far jump colours the viewport without waiting for everything before it", async ({
  page,
}) => {
  await openBig(page);
  await page.keyboard.press("Meta+ArrowDown");
  const last = page.locator(".cm-line").last();
  await expect(last).toHaveText('const v199999 = f(199999) + "text";');
  await expect(last.locator("span[class*='tm-c']").first()).toBeVisible({ timeout: 3000 });
});

// The far viewport is first coloured from a guess (the grammar's initial state, as VS Code does),
// which cannot know a comment opened above it; the exact colours replace it once the worker's
// line states reach the viewport.
test("a far jump into a block comment shows guessed colours, then the comment's", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openBig(page, "&commenttail=300");
  await page.keyboard.press("Meta+ArrowDown");
  const last = page.locator(".cm-line").last().locator("span[class*='tm-c']").first();
  await expect(last).toHaveCSS("color", DARK_PLUS_STORAGE, { timeout: 3000 });
  await expect(last).toHaveCSS("color", DARK_PLUS_COMMENT, { timeout: 60_000 });
});

test("the first keystroke after opening a markdown memo is not delayed by grammar parsing", async ({
  page,
}) => {
  await open(page, "# title", "note.md");
  await expect(coloured(page).first()).toBeVisible();
  const result = await page.evaluate(async () => {
    const lang = window.highlightLang;
    const path = lang.grammar!.path;
    const original = await (await fetch(`/extensions/${lang.extension}/${path}`)).text();
    // Marked, so a parse of this grammar's text on this thread shows in `parsedOnMain`.
    window.fileOverride[path] = original.replace("{", '{"tote-grammar-mark":1,');
    const client = window.highlightClient;
    client.forgetGrammars();
    window.workerLog.length = 0;
    const doc = client.nextDocId();
    const ok = await client.open(doc, lang, () => "# typed");
    const lines = await client.tokens(doc, 0, 1);
    return {
      ok,
      log: window.workerLog.map((m) => m.type),
      parsed: window.parsedOnMain,
      tokens: lines?.[0].length ?? 0,
    };
  });
  expect(result.ok).toBe(true);
  expect(result.tokens).toBeGreaterThan(0);
  // The grammar reaches the worker before the document it colours, as text: the main thread,
  // which takes the keystrokes, never parses it.
  expect(result.log.indexOf("grammars")).toBeGreaterThan(-1);
  expect(result.log.indexOf("grammars")).toBeLessThan(result.log.indexOf("open"));
  expect(result.parsed).toBe(0);
});

test("hidden documents stop advancing where they were last shown", async ({ page }) => {
  await openBig(page);
  const counts = await page.evaluate(async () => {
    const client = window.highlightClient;
    const shown = window.highlightDoc;
    // Small, so the worker is done with it at once and free to go on with a hidden one.
    const other = client.nextDocId();
    const text = Array.from({ length: 10 }, (_, i) => `let x${i} = ${i};`).join("\n");
    await client.open(other, window.highlightLang, () => text);
    client.setVisible([other]);
    const before = await client.stats(shown);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {
      before: before!.cachedLines,
      after: (await client.stats(shown))!.cachedLines,
      other: (await client.stats(other))!.cachedLines,
    };
  });
  // The page's document was shown and worked ahead; hidden now, it stays where it was.
  expect(counts.before).toBeGreaterThan(0);
  expect(counts.before).toBeLessThan(200_000);
  expect(counts.after).toBe(counts.before);
  // The worker was not idle meanwhile: it went through the document now shown.
  expect(counts.other).toBe(10);
});

// A hidden document goes as far as it was shown; once a deletion leaves it shorter than that,
// it must still count as done, or the worker spins on it and the documents after it wait.
test("a hidden document that shrank does not keep the worker busy", async ({ page }) => {
  await open(page, "echo hi", "run.sh");
  await expect(coloured(page).first()).toBeVisible();
  const result = await page.evaluate(async () => {
    const client = window.highlightClient;
    const lang = window.highlightLang;
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `echo ${i}`).join("\n");
    const shrunk = client.nextDocId();
    await client.open(shrunk, lang, () => lines(50));
    // Shown to its end, then its last two lines become one.
    await (await client.cachedTokens(shrunk, 40, 50))!.ready;
    client.edit(shrunk, 48, 50, ["echo last"]);
    client.setVisible([]);
    const other = client.nextDocId();
    await client.open(other, lang, () => lines(2000));
    const far = (await client.cachedTokens(other, 1500, 1510))!.ready!;
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000));
    const ready = await Promise.race([far.then(() => true), timeout]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { ready, advancing: (await client.stats(shrunk))!.advancing };
  });
  expect(result.ready).toBe(true);
  expect(result.advancing).toBe(false);
});
