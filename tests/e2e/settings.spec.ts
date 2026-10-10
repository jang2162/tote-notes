import { expect, test } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { menu, start } from "./helpers";

const PKG = { name: "night", publisher: "someone", version: "1.0.0", displayName: "Night Theme" };

test("the settings screen shows the root, the themes and the extensions, and saves changes", async ({
  page,
}) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await expect(panel.locator("h2")).toHaveText(["워크스페이스", "테마", "확장"]);
  await expect(panel.locator("input[name=workspaceRoot]")).toHaveValue("");
  await panel.locator("input[name=workspaceRoot]").fill("~/노트");
  await panel.locator("button", { hasText: "루트 저장" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.workspaceRoot))
    .toBe("~/노트");
  await expect(panel.locator(".root-note")).toContainText("새로 여는 창부터");
  await panel.locator("select[name=dark]").selectOption({ label: "Light+ (tote.themes)" });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.theme.dark))
    .toEqual({ extension: "tote.themes", label: "Light+" });
  await expect(panel.locator(".extension-row")).toHaveText([
    /tote 기본 언어 묶음/,
    /tote 마크다운 미리보기/,
    /tote 미디어 뷰어/,
    /tote 기본 테마/,
  ]);
  await expect(panel.locator(".extension-row input[type=checkbox]")).toHaveCount(0); // bundled: no switch
  await expect(panel.locator(".extension-row button")).toHaveCount(0); // bundled: no remove
});

test("installing, replacing, disabling and removing a user extension", async ({ page }) => {
  await start(page, {
    packages: { "/pkg/night.vsix": PKG, "/pkg/night2.vsix": { ...PKG, version: "2.0.0" } },
    picks: ["/pkg/night.vsix", "/pkg/night2.vsix"],
  });
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  const row = panel.locator(".extension-row", { hasText: "Night Theme" });
  await expect(row).toContainText("someone.night@1.0.0");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await expect(page.locator(".modal.confirm")).toContainText(
    "someone.night 1.0.0 이(가) 이미 설치돼 있습니다",
  );
  await page.locator(".modal.confirm button", { hasText: "교체" }).click();
  await expect(row).toContainText("someone.night@2.0.0");
  await row.locator("input[type=checkbox]").uncheck();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.extensions.disabled))
    .toEqual(["someone.night"]);
  await row.locator("input[type=checkbox]").check();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.extensions.disabled))
    .toEqual([]);
  await row.locator("button", { hasText: "제거" }).click();
  await page.locator(".modal.confirm button", { hasText: "제거" }).click();
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toHaveCount(0);
});

test("precedence is a radio and problems are listed", async ({ page }) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("input[name=precedence][value=bundled]").check();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.extensions.precedence))
    .toBe("bundled");
  await expect(panel.locator(".extension-problems")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("Escape closes only the confirmation on top of the settings screen", async ({ page }) => {
  await start(page, {
    packages: { "/pkg/night.vsix": PKG },
    picks: ["/pkg/night.vsix"],
  });
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await panel.locator(".extension-row", { hasText: "Night Theme" }).locator("button").click();
  await expect(page.locator(".modal.confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal.confirm")).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toBeVisible();
});

test("installing an extension makes the next file read its language files again", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("a.sh", "echo a"), b: fakeMemo("b.sh", "echo b") },
    packages: { "/pkg/night.vsix": PKG },
    picks: ["/pkg/night.vsix"],
  });
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const read = backend.readExtensionFile.bind(backend);
    (window as unknown as { configReads: string[] }).configReads = [];
    backend.readExtensionFile = (extensionId: string, path: string) => {
      if (path.startsWith("language-configuration/"))
        (window as unknown as { configReads: string[] }).configReads.push(path);
      return read(extensionId, path);
    };
  });
  const reads = () =>
    page.evaluate(() => (window as unknown as { configReads: string[] }).configReads.length);
  await page.locator(".memo-row", { hasText: "a" }).first().click();
  await expect.poll(reads).toBeGreaterThan(0);
  const before = await reads();
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".memo-row", { hasText: "b" }).first().click();
  await expect.poll(reads).toBeGreaterThan(before);
});
