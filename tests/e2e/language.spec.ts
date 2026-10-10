import { expect, test } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, start } from "./helpers";

test("the status bar names the language of the file and opens a picker", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("script.sh", "echo hi") } });
  await page.locator(".memo-row", { hasText: "script" }).click();
  await expect(page.locator(".status-language")).toHaveText("Shell Script");
  await page.locator(".status-language").click();
  const picker = page.locator(".modal.picker");
  await picker.locator("input").fill("pyth");
  await picker.locator("li", { hasText: "Python" }).click();
  await expect(page.locator(".status-language")).toHaveText("Python");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("script.py");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.memos.a))
    .toMatchObject({ file: "script.py", language: "python", autoTitle: false });
});

// The shebang is not a title (spec 「제목 자동 생성」) and line 2 is blank, so the name stays
// untitled; leaving line 1 is what moves the memo off Markdown.
test("a shebang on the first line of a new memo moves it off Markdown once the cursor leaves", async ({
  page,
}) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("#!/bin/bash");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("untitled.sh");
  await expect(page.locator(".status-language")).toHaveText("Shell Script");
});

test("an external file keeps its chosen language in the session", async ({ page }) => {
  await start(page, { files: { "/x/notes": fakeFile("select 1") }, picks: ["/x/notes"] });
  await menu(page, "open-file");
  await expect(page.locator(".status-language")).toHaveText("텍스트");
  await page.locator(".status-language").click();
  await page.locator(".modal.picker li", { hasText: "SQL" }).click();
  await expect(page.locator(".status-language")).toHaveText("SQL");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"language":"sql"');
  await page.reload();
  await page.waitForFunction(() => window.__tote?.ready === true);
  await expect(page.locator(".status-language")).toHaveText("SQL");
});

test("a new language brings its colours, its comment token and leaves Markdown's aids", async ({
  page,
}) => {
  await start(page, {
    files: { "/x/a.md": fakeFile("# one\nx = 1\n- a") },
    picks: ["/x/a.md"],
  });
  await menu(page, "open-file");
  const heading = page.locator(".cm-line").first().locator("span[class*='tm-c']").first();
  await expect(heading).toBeVisible();
  const markdownColour = await heading.evaluate((el) => getComputedStyle(el).color);
  await page.locator(".status-language").click();
  await page.locator(".modal.picker li", { hasText: "Python" }).click();
  await expect(page.locator(".status-language")).toHaveText("Python");
  // `# one` is a Python comment now, coloured by the Python grammar instead of the Markdown one.
  await expect
    .poll(() =>
      page
        .locator(".cm-line")
        .first()
        .locator("span[class*='tm-c']")
        .first()
        .evaluate((el) => getComputedStyle(el).color),
    )
    .not.toBe(markdownColour);
  // ⌘/ takes Python's `#`, not the `<!-- -->` Markdown would give an `.md` file.
  await page.locator(".cm-line").nth(1).click();
  await page.keyboard.press("Meta+/");
  await expect(page.locator(".cm-line").nth(1)).toHaveText("# x = 1");
  // Enter after `- a` does not continue a list: the file is not Markdown any more.
  await page.locator(".cm-line").nth(2).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("b");
  await expect(page.locator(".cm-line").nth(3)).toHaveText("b");
});
