import { expect, test, type Page } from "@playwright/test";

import { defaultFakeData, fakeFile, fakeMemo, type FakeTrashed } from "../../src/backend/fake";
import { menu, start } from "./helpers";

// A dialog has the window until it is answered: what `modal()` itself does (inert, Tab, the focus
// given back) is in dialogs.spec.ts; these check it against the app behind it.

const MEMOS = { a: fakeMemo("가.md", "첫째") };

async function openMemo(page: Page): Promise<void> {
  await page.locator(".memo-row", { hasText: "가" }).click();
  await expect(page.locator(".cm-content")).toHaveText("첫째");
  await expect(page.locator(".cm-content")).toBeFocused();
}

const keysInDialog = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest(".modal") != null);

const memoCount = (page: Page) =>
  page.evaluate(() => Object.keys(window.__tote.backend.data.memos).length);

test("Tab in the rename dialog never reaches the editor behind it", async ({ page }) => {
  await start(page, { memos: MEMOS });
  await openMemo(page);
  await menu(page, "rename");
  await expect(page.locator(".modal input")).toBeFocused();
  for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect.poll(() => keysInDialog(page), { message: `after ${key}` }).toBe(true);
    await page.keyboard.type("x");
  }
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveText("첫째");
  // Cancelled, the keys go to the editor (docs/guides/development.md).
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("menu commands do nothing behind the unsaved-changes question, which is asked once", async ({
  page,
}) => {
  await start(page, { files: { "/x/a.sh": fakeFile("echo hi\n") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".cm-content")).toContainText("echo hi");
  await page.keyboard.type("more ");
  await expect(page.locator(".tab.active")).toHaveClass(/dirty/);
  const memos = await memoCount(page);

  await menu(page, "close-tab");
  await expect(page.locator(".modal")).toHaveCount(1);
  await menu(page, "close-tab");
  await menu(page, "new-memo");
  await menu(page, "split-pane");
  // 「백업 폴더 열기」 leaves the window alone, and works.
  await menu(page, "reveal-backups");
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.revealed)).toBe(1);
  // One Escape answers the one question; a second question would still be up.
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  // The same command once the question is answered: its memo is the only new one — the one sent
  // behind the question, begun first, would have been made by now.
  await menu(page, "new-memo");
  await expect(page.locator(".tab")).toHaveCount(2);
  expect(await memoCount(page)).toBe(memos + 1);
  await expect(page.locator(".pane")).toHaveCount(1);
});

test("the menu's undo leaves the memo behind a dialog alone", async ({ page }) => {
  await start(page, { memos: MEMOS });
  await openMemo(page);
  await page.keyboard.type("둘째 ");
  await expect(page.locator(".cm-content")).toHaveText("둘째 첫째");
  await menu(page, "rename");
  await expect(page.locator(".modal input")).toBeFocused();
  // The keys on nothing: a press on the dimmed page takes them off the field.
  await page.mouse.click(5, 5);
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await menu(page, "undo");
  await page.locator(".modal input").focus();
  await menu(page, "undo");
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveText("둘째 첫째");
});

test("a dialog leaves the sidebar as it was, collapsed or not", async ({ page }) => {
  await start(page, { memos: MEMOS });
  await openMemo(page);
  const sidebar = page.locator(".sidebar");
  await menu(page, "rename");
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(page.locator(".main")).toHaveAttribute("inert", "");
  // ⌘B behind the dialog does not collapse it.
  await menu(page, "toggle-sidebar");
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(sidebar).not.toHaveAttribute("inert");
  await expect(page.locator(".main")).not.toHaveAttribute("inert");
  await expect(page.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);

  await menu(page, "toggle-sidebar");
  await expect(sidebar).toHaveAttribute("inert", "");
  await menu(page, "rename");
  await expect(page.locator(".modal input")).toBeFocused();
  await menu(page, "toggle-sidebar");
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".main")).not.toHaveAttribute("inert");
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  await expect(sidebar).toHaveAttribute("inert", "");
});

test("휴지통 비우기, called off, gives the keys back to its button", async ({ page }) => {
  const trashed = (file: string, deletedMs: number): FakeTrashed => ({
    ...fakeMemo(file, ""),
    deletedMs,
  });
  await start(page, { memos: MEMOS, trash: { b: trashed("나.md", 1) } });
  await page.getByRole("button", { name: "휴지통", exact: true }).click();
  const empty = page.getByRole("button", { name: "휴지통 비우기" });
  await empty.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal.confirm").getByRole("button", { name: "취소" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(empty).toBeFocused();
});

test("a question over the settings screen holds it off, then gives the keys back to it", async ({
  page,
}) => {
  // A changed shortcut: 「모두 기본값으로」 has something to ask about.
  await start(page, {
    memos: MEMOS,
    settings: { ...defaultFakeData().settings, shortcuts: { "new-memo": "CmdOrCtrl+Shift+M" } },
  });
  await menu(page, "settings");
  const settings = page.locator(".modal.settings");
  await settings.getByRole("tab", { name: "단축키", exact: true }).click();
  const reset = settings.getByRole("button", { name: "모두 기본값으로", exact: true });
  await expect(reset).toBeEnabled();
  await reset.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal.confirm")).toHaveCount(1);
  await expect(page.locator(".modal-backdrop").first()).toHaveAttribute("inert", "");
  // Another settings screen is not opened over the question either.
  await menu(page, "settings");
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal.confirm")).toHaveCount(0);
  await expect(page.locator(".modal")).toHaveCount(1);
  await expect(page.locator(".modal-backdrop")).not.toHaveAttribute("inert");
  await expect(reset).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
});

// A press on a button takes the keys off whatever had them (WebKit), so a dialog it opens has
// nothing to give them back to: they go to the focused pane, or stay with a dialog left open.
const TRASH = { b: { ...fakeMemo("나.md", ""), deletedMs: 1 } satisfies FakeTrashed };

test("휴지통 비우기 pressed with the mouse and called off gives the keys to the editor", async ({
  page,
}) => {
  await start(page, { memos: MEMOS, trash: TRASH });
  await openMemo(page);
  await page.getByRole("button", { name: "휴지통", exact: true }).click();
  await page.getByRole("button", { name: "휴지통 비우기" }).click();
  await expect(page.locator(".modal.confirm")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("x");
  await expect(page.locator(".cm-content")).toContainText("x");
});

test("with no tab open, a dialog with nothing to give the keys back to gives them to the pane", async ({
  page,
}) => {
  await start(page, { memos: MEMOS, trash: TRASH });
  await expect(page.locator(".tab")).toHaveCount(0);
  await page.getByRole("button", { name: "휴지통", exact: true }).click();
  await page.getByRole("button", { name: "휴지통 비우기" }).click();
  await expect(page.locator(".modal.confirm")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".pane")).toBeFocused();
});

test("a purge asked for with the keys on nothing gives them to the editor once it is done", async ({
  page,
}) => {
  await start(page, { memos: MEMOS, trash: TRASH });
  await openMemo(page);
  await page.getByRole("button", { name: "휴지통", exact: true }).click();
  // As the row's context menu leaves it: the press took the keys off the editor.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    void window.__tote.app.purgeTrashed("b");
  });
  await page.locator(".modal.confirm").getByRole("button", { name: "영구 삭제" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.trash?.b)).toBeUndefined();
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("a question over the settings screen opened with the mouse gives the keys back to it", async ({
  page,
}) => {
  await start(page, {
    memos: MEMOS,
    settings: { ...defaultFakeData().settings, shortcuts: { "new-memo": "CmdOrCtrl+Shift+M" } },
  });
  await openMemo(page);
  await menu(page, "settings");
  const settings = page.locator(".modal.settings");
  await settings.getByRole("tab", { name: "단축키", exact: true }).click();
  await settings.getByRole("button", { name: "모두 기본값으로", exact: true }).click();
  await expect(page.locator(".modal.confirm")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal.confirm")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest(".modal.settings") != null))
    .toBe(true);
});

test("a dialog whose opener has left the page gives the keys to the editor", async ({ page }) => {
  await start(page, { memos: MEMOS, trash: TRASH });
  await openMemo(page);
  await page.getByRole("button", { name: "휴지통", exact: true }).click();
  const empty = page.getByRole("button", { name: "휴지통 비우기" });
  await empty.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal.confirm")).toHaveCount(1);
  // What opened it goes while it is up, as a row another window removes does.
  await empty.evaluate((button) => button.remove());
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
});
