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
      ],
    },
  });
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await expect(page.locator(".cm-content")).toHaveText("v3");

  await menu(page, "versions");
  const rows = page.locator(".version-list li");
  await expect(rows).toHaveText(["2026-10-12 10:10:00", "2026-10-12 10:00:00"]);
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
