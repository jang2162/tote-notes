import { expect, test } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { start } from "./helpers";

test("a config change reconfigures the language of every open tab", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("one.sh", "echo one"), b: fakeMemo("two.sh", "echo two") },
  });
  await page.locator('.memo-row[title="one.sh"]').click();
  await expect(page.locator(".cm-content")).toHaveText("echo one");
  await page.locator('.memo-row[title="two.sh"]').click();
  await expect(page.locator(".cm-content")).toHaveText("echo two");
  await page.evaluate(() => {
    const { backend } = window.__tote;
    backend.data.extensionFiles["tote.languages/language-configuration/shellscript.json"] =
      JSON.stringify({ comments: { lineComment: "##" } });
    // The fake's bundled list never changes, so the set changes the way an install changes it.
    backend.data.userExtensions.push({
      id: "someone.extra",
      version: "1.0.0",
      displayName: "Extra",
      source: "user",
      enabled: true,
      path: "/fake/extensions/someone.extra@1.0.0",
      modified: 1,
    });
    backend.config();
  });
  for (const name of ["one", "two"]) {
    // The title, not the tab: the middle of a short tab is its close button.
    await page.locator(".tab-title", { hasText: name }).click();
    await expect(page.locator(".cm-content")).toHaveText(`echo ${name}`);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Meta+/");
    await expect(page.locator(".cm-content")).toHaveText(`## echo ${name}`);
  }
});
