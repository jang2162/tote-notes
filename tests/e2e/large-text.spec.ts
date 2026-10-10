import { expect, test, type Page } from "@playwright/test";

import { LONG_LINE_LIMIT } from "../../src/app/docs";
import { fakeFile } from "../../src/backend/fake";
import { menu, start } from "./helpers";

// 3,000 short lines with one line past the long-line limit in the middle: paged reads and the
// long-line cut both come into play.
const lines = Array.from({ length: 3000 }, (_, i) =>
  i === 1500 ? "L".repeat(LONG_LINE_LIMIT + 1) : `row ${i} needle${i % 700 === 0 ? " hit" : ""}`,
);
const TEXT = lines.join("\n");

/** Opens the app with `TEXT` as `/x/huge.log`. The file is put in the fake backend after the page
 * is up and the fake stops persisting: at the measured limit the file is megabytes, which a
 * sessionStorage seed (or the write after each backend change) cannot hold. */
async function startWithHugeLog(page: Page) {
  await start(page, { picks: ["/x/huge.log"] });
  await page.evaluate((data) => {
    const backend = window.__tote.backend as unknown as {
      storage: { save(text: string): void };
      data: { files: Record<string, string> };
    };
    backend.storage = { save: () => {} };
    backend.data.files["/x/huge.log"] = data;
  }, fakeFile(TEXT));
}

test("a file with a line over the limit opens read-only in the large text viewer and pages through the file", async ({
  page,
}) => {
  await startWithHugeLog(page);
  await menu(page, "open-file");
  const viewer = page.locator(".large-text");
  await expect(viewer).toBeVisible();
  await expect(page.locator(".status-message")).toHaveText("읽기 전용 · 대용량 텍스트 뷰어");
  await expect(viewer.locator(".large-text-info")).toHaveText("3,000줄");
  await expect(viewer.locator(".large-text-line").first()).toHaveText("row 0 needle hit");
  await page.evaluate(() => window.__tote.app.largeText!.viewer.goToLine(1500));
  await expect(viewer.locator(".large-text-line.current")).toContainText(
    `… (${LONG_LINE_LIMIT + 1}자)`,
  );
  await page.evaluate(() => window.__tote.app.largeText!.viewer.goToLine(2999));
  await expect(viewer.locator(".large-text-line.current")).toHaveText("row 2999 needle");
});

test("search runs in the backend and walks the matches", async ({ page }) => {
  await startWithHugeLog(page);
  await menu(page, "open-file");
  const viewer = page.locator(".large-text");
  // The search box, not the two option checkboxes beside it.
  const input = viewer.locator('.large-text-search input[type="search"]');
  await input.fill("HIT");
  await input.press("Enter");
  await expect(viewer.locator(".large-text-count")).toHaveText("1 / 5");
  await expect(viewer.locator(".large-text-line.current")).toHaveText("row 0 needle hit");
  await viewer.locator("button", { hasText: "다음" }).click();
  await expect(viewer.locator(".large-text-count")).toHaveText("2 / 5");
  await expect(viewer.locator(".large-text-line.current")).toHaveText("row 700 needle hit");
  await viewer.locator("label", { hasText: "대소문자" }).click();
  await input.press("Enter");
  await expect(viewer.locator(".large-text-count")).toHaveText("0");
  await viewer.locator("label", { hasText: "대소문자" }).click();
  await viewer.locator("label", { hasText: "정규식" }).click();
  await input.fill("row 2[0-9]00 ");
  await input.press("Enter");
  await expect(viewer.locator(".large-text-count")).toHaveText("1 / 10");
});

test("closing the tab takes the viewer and its token down", async ({ page }) => {
  await startWithHugeLog(page);
  await menu(page, "open-file");
  await expect(page.locator(".large-text")).toBeVisible();
  expect(Object.keys(await page.evaluate(() => window.__tote.backend.data.tokens))).toHaveLength(1);
  await menu(page, "close-tab");
  await expect(page.locator(".large-text")).toHaveCount(0);
  expect(await page.evaluate(() => window.__tote.backend.data.tokens)).toEqual({});
});
