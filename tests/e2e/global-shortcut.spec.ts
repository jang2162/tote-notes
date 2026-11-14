import { expect, test, type Locator, type Page } from "@playwright/test";

import { defaultFakeData, type FakeData } from "../../src/backend/fake";
import type { SettingsPatch } from "../../src/backend/types";
import { menu, start } from "./helpers";

// Global quick note spec (docs/superpowers/specs/2026-11-14-tote-notes-global-quick-note-design.md).
// The real global key and the menu bar icon are the native side's: here 빠른 메모 arrives as the
// native side leaves it for the window (`FakeBackend.quickNote`).

type Patches = { patches: SettingsPatch[] };

async function trackPatches(page: Page): Promise<void> {
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const patchSettings = backend.patchSettings.bind(backend);
    (window as unknown as Patches).patches = [];
    backend.patchSettings = (...args) => {
      (window as unknown as Patches).patches.push(...args);
      return patchSettings(...args);
    };
  });
}

const patches = (page: Page) => page.evaluate(() => (window as unknown as Patches).patches);
const savedGlobal = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.settings.globalShortcuts ?? {});
const memoCount = (page: Page) =>
  page.evaluate(() => Object.keys(window.__tote.backend.data.memos).length);
const quickNote = (page: Page) => page.evaluate(() => window.__tote.backend.quickNote());

async function openShortcuts(page: Page, seed: Partial<FakeData> = {}): Promise<Locator> {
  await start(page, seed);
  await trackPatches(page);
  await menu(page, "settings");
  await page.locator(".modal.settings").getByRole("tab", { name: "단축키", exact: true }).click();
  const panel = page.locator("#settings-panel-shortcuts");
  await expect(panel.locator(".shortcut-row")).not.toHaveCount(0);
  return panel;
}

const globalRow = (panel: Locator) => panel.locator('.shortcut-row[data-global="quick-note"]');
const globalKeys = (panel: Locator) => globalRow(panel).locator(".shortcut-keys");
const appRow = (panel: Locator, id: string) => panel.locator(`.shortcut-row[data-command="${id}"]`);

async function recordGlobal(panel: Locator): Promise<void> {
  await globalKeys(panel).click();
  await expect(globalKeys(panel)).toHaveText("키를 누르세요");
}

test.describe("빠른 메모", () => {
  test("makes a new memo in the focused pane, with the keys in its editor", async ({ page }) => {
    await start(page);
    await menu(page, "new-memo");
    await expect(page.locator(".tab")).toHaveCount(1);
    // The focus elsewhere, as when another app was in front.
    await page.locator("input.memo-filter").focus();

    await quickNote(page);
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.type("장보기 목록");
    await page.keyboard.press("Enter");
    await expect(page.locator(".tab.active .tab-title")).toHaveText("장보기 목록");
    await expect
      .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("장보기 목록.md")))
      .toBe("장보기 목록\n");
  });

  test("left empty and closed, leaves no file behind", async ({ page }) => {
    await start(page);
    await quickNote(page);
    await expect(page.locator(".tab")).toHaveCount(1);
    await expect(page.locator(".cm-content")).toBeFocused();
    await menu(page, "close-tab");
    await expect(page.locator(".tab")).toHaveCount(0);
    expect(await memoCount(page)).toBe(0);
  });

  test("makes nothing under a dialog, as ⌘N", async ({ page }) => {
    await start(page);
    await menu(page, "settings");
    await expect(page.locator(".modal.settings")).toBeVisible();
    await quickNote(page);
    await expect.poll(() => page.evaluate(() => window.__tote.backend.data.pending.length)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal.settings")).toHaveCount(0);
    // The second one's memo is the only one: the first, under the dialog, made none.
    await quickNote(page);
    await expect(page.locator(".tab")).toHaveCount(1);
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await memoCount(page)).toBe(1);
  });
});

test.describe("설정 › 단축키 › 전역", () => {
  test("records a new key, and 되돌리기 brings ⌃⌥N back", async ({ page }) => {
    const panel = await openShortcuts(page);
    await expect(panel.locator(".shortcut-global-title")).toHaveText("전역");
    await expect(globalRow(panel)).toContainText("빠른 메모");
    await expect(globalRow(panel)).toContainText("다른 앱에서도");
    await expect(globalKeys(panel)).toHaveText("⌃⌥N");
    await expect(
      globalRow(panel).getByRole("button", { name: "되돌리기", exact: true }),
    ).toHaveCount(0);

    await recordGlobal(panel);
    await page.keyboard.press("Control+Alt+Shift+N");
    await expect.poll(() => savedGlobal(page)).toEqual({ "quick-note": "Ctrl+Alt+Shift+N" });
    await expect(globalKeys(panel)).toHaveText("⌃⌥⇧N");
    expect(await patches(page)).toEqual([
      { globalShortcuts: { "quick-note": "Ctrl+Alt+Shift+N" } },
    ]);
    // The menu's shortcuts came off while it recorded, as for an app command.
    expect(await page.evaluate(() => window.__tote.backend.data.suspendShortcutCalls)).toEqual([
      true,
      false,
    ]);
    const table = await page.evaluate(() => window.__tote.backend.globalShortcutTable());
    expect(table.commands[0].current).toBe("Ctrl+Alt+Shift+N");

    await globalRow(panel).getByRole("button", { name: "되돌리기", exact: true }).click();
    await expect.poll(() => savedGlobal(page)).toEqual({});
    await expect(globalKeys(panel)).toHaveText("⌃⌥N");
  });

  test("Backspace leaves 빠른 메모 with no global key", async ({ page }) => {
    const panel = await openShortcuts(page);
    await recordGlobal(panel);
    await page.keyboard.press("Backspace");
    await expect.poll(() => savedGlobal(page)).toEqual({ "quick-note": null });
    await expect(globalKeys(panel)).toHaveText("없음");
  });

  test("an app command's key is refused, with no 바꾸기", async ({ page }) => {
    const panel = await openShortcuts(page);
    await recordGlobal(panel);
    await page.keyboard.press("Meta+N");
    const note = globalRow(panel).locator(".shortcut-note");
    await expect(note).toHaveText("새 메모 에 쓰고 있는 단축키입니다");
    await expect(globalRow(panel).getByRole("button", { name: "바꾸기" })).toHaveCount(0);
    await expect(globalKeys(panel)).toHaveText("⌃⌥N");

    await recordGlobal(panel);
    await page.keyboard.press("Meta+Q");
    await expect(note).toHaveText("Tote Notes 종료 에 고정된 단축키입니다");
    expect(await patches(page)).toEqual([]);
  });

  test("an app command cannot take the global key", async ({ page }) => {
    const panel = await openShortcuts(page);
    await appRow(panel, "rename").locator(".shortcut-keys").click();
    await page.keyboard.press("Control+Alt+N");
    await expect(appRow(panel, "rename").locator(".shortcut-note")).toHaveText(
      "전역 단축키 빠른 메모 에 쓰고 있습니다",
    );
    await expect(appRow(panel, "rename").locator(".shortcut-keys")).toHaveText("없음");
    expect(await patches(page)).toEqual([]);
  });

  test("an editor key is saved with a warning", async ({ page }) => {
    const panel = await openShortcuts(page);
    await recordGlobal(panel);
    await page.keyboard.press("Meta+L");
    await expect.poll(() => savedGlobal(page)).toEqual({ "quick-note": "CmdOrCtrl+L" });
    const warning = globalRow(panel).locator(".shortcut-note");
    await expect(warning).toHaveText("편집기의 selectLine 을 가립니다");
    await expect(warning).toHaveAttribute("role", "status");
  });

  test("a key macOS would not take says so, until another key is taken", async ({ page }) => {
    const panel = await openShortcuts(page, { refusedGlobalKeys: ["Ctrl+Alt+N"] });
    const note = globalRow(panel).locator(".shortcut-note");
    await expect(note).toHaveText("다른 앱이 쓰고 있어 등록하지 못했습니다");
    await recordGlobal(panel);
    await page.keyboard.press("Control+Alt+Shift+N");
    await expect(globalKeys(panel)).toHaveText("⌃⌥⇧N");
    await expect(note).toHaveCount(0);
  });

  test("the search finds the global row by name and by key", async ({ page }) => {
    const panel = await openShortcuts(page);
    const search = panel.getByRole("searchbox", { name: "명령 검색" });
    await search.fill("빠른 메모");
    await expect(globalRow(panel)).toBeVisible();
    await expect(appRow(panel, "new-memo")).toBeHidden();
    await search.fill("⌃⌥N");
    await expect(globalRow(panel)).toBeVisible();
    await search.fill("새 메모");
    await expect(globalRow(panel)).toBeHidden();
    await expect(panel.locator(".shortcut-global")).toBeHidden();
  });

  test("모두 기본값으로 puts the global key back too", async ({ page }) => {
    const panel = await openShortcuts(page, {
      settings: { ...defaultFakeData().settings, globalShortcuts: { "quick-note": null } },
    });
    await expect(globalKeys(panel)).toHaveText("없음");
    const resetAll = panel.getByRole("button", { name: "모두 기본값으로", exact: true });
    await expect(resetAll).toBeEnabled();
    await resetAll.click();
    await page.locator(".modal.confirm").getByRole("button", { name: "되돌리기" }).click();
    await expect.poll(() => savedGlobal(page)).toEqual({});
    await expect(globalKeys(panel)).toHaveText("⌃⌥N");
    expect(await patches(page)).toEqual([
      { shortcuts: {}, shortcutsExpected: {}, globalShortcuts: {} },
    ]);
  });
});

test("설정 › 일반 shows the menu bar icon switch, off, and saves it", async ({ page }) => {
  await start(page);
  await menu(page, "settings");
  const box = page.getByLabel("메뉴 막대에 아이콘 보이기");
  await expect(box).not.toBeChecked();
  await box.check();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.tray?.visible))
    .toBe(true);
  await box.uncheck();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.tray?.visible))
    .toBe(false);
});
