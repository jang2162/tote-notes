import { expect, test } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, sessionPane, start } from "./helpers";

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
    .poll(async () =>
      (await sessionPane(page)).tabs.some(
        (tab) => tab.kind === "external" && tab.language === "sql",
      ),
    )
    .toBe(true);
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

test("a rename to another extension brings that language's comment token", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("a.md", "x = 1\ny = 2") } });
  await page.locator(".memo-row", { hasText: "a" }).click();
  const rename = async (name: string) => {
    await menu(page, "rename");
    const input = page.locator(".modal input");
    await input.fill(name);
    await input.press("Enter");
    await expect(page.locator(".tab.active .tab-title")).toHaveText(name === "a.md" ? "a" : name);
  };
  await rename("a.py");
  await expect(page.locator(".status-language")).toHaveText("Python");
  await page.locator(".cm-line").nth(0).click();
  await page.keyboard.press("Meta+/");
  await expect(page.locator(".cm-line").nth(0)).toHaveText("# x = 1");
  await rename("a.md");
  await expect(page.locator(".status-language")).toHaveText("Markdown");
  await page.locator(".cm-line").nth(1).click();
  await page.keyboard.press("Meta+/");
  await expect(page.locator(".cm-line").nth(1)).toHaveText("<!-- y = 2 -->");
});

test("an import stands when the picked language cannot be carried over", async ({ page }) => {
  await start(page, { files: { "/x/notes": fakeFile("select 1") }, picks: ["/x/notes"] });
  await menu(page, "open-file");
  await page.locator(".status-language").click();
  await page.locator(".modal.picker li", { hasText: "SQL" }).click();
  await expect(page.locator(".status-language")).toHaveText("SQL");
  await page.evaluate(() => {
    window.__tote.backend.setMemoLanguage = async () => {
      throw new Error("disk full");
    };
  });
  await menu(page, "import");
  await expect(page.locator(".tab.active")).not.toHaveClass(/external/);
  await expect(page.locator(".status-message.error")).not.toBeEmpty();
  expect(
    await page.evaluate(() => Object.values(window.__tote.backend.data.memos).map((m) => m.file)),
  ).toEqual(["notes"]);
});

test("Enter in the language picker without a filter keeps the current language", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("script.sh", "echo hi") } });
  await page.locator(".memo-row", { hasText: "script" }).click();
  await page.locator(".status-language").click();
  await page.locator(".modal.picker input").press("Enter");
  await expect(page.locator(".modal.picker")).toHaveCount(0);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("script.sh");
  expect(await page.evaluate(() => window.__tote.backend.data.memos.a.file)).toBe("script.sh");

  await page.locator(".status-language").click();
  await page.locator(".modal.picker input").fill("zzzz");
  await page.locator(".modal.picker input").press("Enter");
  await expect(page.locator(".modal.picker")).toHaveCount(1);
});
