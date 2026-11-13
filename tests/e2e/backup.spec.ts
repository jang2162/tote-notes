import { expect, test } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { menu, start } from "./helpers";

// Snapshots themselves — what goes in, the hard links, retention, following a renamed memo — are
// pinned in Rust (src-tauri/src/backup). These check the window's side: the menu items, the
// dialog, and that a restore is one edit that saves and undoes like typing.

test("previous versions list, preview and restore undoably", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("회의.md", "v3") },
    backups: {
      a: [
        { snapshot: "20261012-100000", file: "회의.md", text: "v1" },
        { snapshot: "20261012-101000", file: "회의.md", text: "v2" },
        { snapshot: "20261012-102000", file: "회의.md", text: "v2" },
      ],
    },
  });
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await expect(page.locator(".cm-content")).toHaveText("v3");

  await menu(page, "versions");
  const rows = page.locator(".version-list li");
  await expect(rows).toHaveText(["2026-10-12 10:10:00 – 10:20:00", "2026-10-12 10:00:00"]);
  const preview = page.locator(".version-preview");
  await expect(preview).toHaveText("v2");
  await rows.nth(1).click();
  await expect(preview).toHaveText("v1");
  await page.getByRole("button", { name: "이 버전으로 되돌리기" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveText("v1");
  const saved = () => page.evaluate(() => window.__tote.backend.memoText("a"));
  await expect.poll(saved).toBe("v1");

  await page.keyboard.press("Meta+z");
  await expect(page.locator(".cm-content")).toHaveText("v3");
  await expect.poll(saved).toBe("v3");
});

// A preview come back to from another tab is not in the editor: the restore goes into the tab's
// state alone, and the highlighter's copy of the text must follow it all the same — else the
// editor, shown again, paints the old text's colours over the new lines.
test("a version restored under a preview is coloured as the new text once the editor is back", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("회의.md", "# 제목\n본문"), b: fakeMemo("다른.md", "다른 글") },
    backups: { a: [{ snapshot: "20261012-100000", file: "회의.md", text: "본문\n\n# 제목" }] },
  });
  const lines = page.locator(".cm-line");
  const colourOf = (line: number, text: string) =>
    lines
      .nth(line)
      .locator("span[class*='tm-c']", { hasText: text })
      .first()
      .evaluate((el) => getComputedStyle(el).color);
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await expect(lines.nth(0).locator("span[class*='tm-c']", { hasText: "제목" })).toBeVisible();
  const heading = await colourOf(0, "제목");
  await expect(lines.nth(1).locator("span[class*='tm-c']", { hasText: "본문" })).toBeVisible();
  const body = await colourOf(1, "본문");
  expect(heading).not.toBe(body);

  await menu(page, "toggle-preview");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  // Away and back: the editor now holds the other tab's text, not this one's.
  await page.locator(".memo-row", { hasText: "다른" }).click();
  await expect(page.locator(".cm-content")).toHaveText("다른 글");
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);

  await menu(page, "versions");
  await page.getByRole("button", { name: "이 버전으로 되돌리기" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await menu(page, "toggle-preview");
  await expect(lines).toHaveText(["본문", "", "# 제목"]);
  await expect(lines.nth(2).locator("span[class*='tm-c']", { hasText: "제목" })).toHaveCSS(
    "color",
    heading,
  );
  await expect(lines.nth(0).locator("span[class*='tm-c']", { hasText: "본문" })).toHaveCSS(
    "color",
    body,
  );
});

test("a memo without versions says so", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  const message = page.locator(".status-message");
  // No tab yet: nothing to look back on.
  await menu(page, "versions");
  await expect(message).toHaveText("메모 탭에서만 쓸 수 있습니다");

  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toHaveText("우유");
  await menu(page, "versions");
  await expect(message).toHaveText("이전 버전이 없습니다");
  await expect(page.locator(".modal")).toHaveCount(0);
});

test("reveal backups asks the backend", async ({ page }) => {
  await start(page);
  await menu(page, "reveal-backups");
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.revealed)).toBe(1);
});
