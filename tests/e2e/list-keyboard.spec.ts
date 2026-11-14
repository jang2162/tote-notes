import { expect, test, type Page } from "@playwright/test";

import { fakeMemo, type FakeData, type FakeTrashed } from "../../src/backend/fake";
import { menu, start } from "./helpers";

// The memo list's and the trash list's keys and picks, and the keys of the versions dialog, the
// language picker and the status bar (docs/superpowers/specs/2026-11-14-tote-notes-list-keyboard-
// design.md). Every flow here goes by the keys alone unless its name says it presses.

const memoList = (page: Page) => page.getByRole("listbox", { name: "메모 목록" });
const trashList = (page: Page) => page.getByRole("listbox", { name: "휴지통 목록" });
const option = (page: Page, name: string) => page.getByRole("option", { name, exact: true });
const filter = (page: Page) => page.getByPlaceholder("제목·내용 검색");
const status = (page: Page) => page.getByRole("status");
const activeTab = (page: Page) => page.locator(".tab.active .tab-title");
const data = (page: Page) => page.evaluate(() => window.__tote.backend.data);
const lastMenu = async (page: Page) =>
  (await page.evaluate(() => window.__tote.backend.data.popupMenus?.at(-1) ?? null))?.map(
    (item) => item.text,
  );
const pick = (page: Page, id: string | null) =>
  page.evaluate((id) => (window.__tote.backend.data.popupMenuPick = id), id);

/** The options picked, by name, in the list's order. */
const pickedNames = (page: Page) =>
  page
    .getByRole("option", { selected: true })
    .evaluateAll((all) => all.map((each) => each.getAttribute("aria-label")));

/** The option `aria-activedescendant` names. */
async function current(page: Page, list = memoList(page)): Promise<string | null> {
  const id = await list.getAttribute("aria-activedescendant");
  return id ? page.locator(`[id="${id}"]`).getAttribute("aria-label") : null;
}

const three = (): Partial<FakeData> => ({
  memos: {
    a: fakeMemo("가.md", "하나", { modifiedMs: 3 }),
    b: fakeMemo("나.md", "둘", { modifiedMs: 2 }),
    c: fakeMemo("다.md", "셋", { modifiedMs: 1 }),
  },
});

test("from the filter ↓ goes into the list, the keys move, Enter opens and keeps the keys", async ({
  page,
}) => {
  await start(page, three());
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(memoList(page)).toBeFocused();
  await expect(memoList(page)).toHaveAttribute("aria-multiselectable", "true");
  expect(await current(page)).toBe("가.md");
  await expect(option(page, "가.md")).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowDown");
  expect(await current(page)).toBe("나.md");
  expect(await pickedNames(page)).toEqual(["나.md"]);
  await page.keyboard.press("Enter");
  await expect(activeTab(page)).toHaveText("나");
  await expect(page.locator(".cm-content")).toHaveText("둘");
  await expect(memoList(page)).toBeFocused();

  // Down and Enter again: the next memo, the keys still on the list.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(activeTab(page)).toHaveText("다");
  await expect(memoList(page)).toBeFocused();
  // Enter on the memo already on show: the keys go to it.
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("⌘Enter opens and gives the keys to the editor", async ({ page }) => {
  await start(page, three());
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  expect(await current(page)).toBe("다.md");
  await page.keyboard.press("Meta+Enter");
  await expect(activeTab(page)).toHaveText("다");
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("↑ on the first row goes back to the filter, and Home and End go to the ends", async ({
  page,
}) => {
  await start(page, three());
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  expect(await current(page)).toBe("다.md");
  await page.keyboard.press("Home");
  expect(await current(page)).toBe("가.md");
  await page.keyboard.press("ArrowUp");
  await expect(filter(page)).toBeFocused();
});

test("the list is one stop of Tab after the filter", async ({ page }) => {
  await start(page, three());
  await filter(page).focus();
  // ⌥Tab stops at the sort button whatever the system's keyboard navigation says; the list is
  // the stop after it.
  await page.keyboard.press("Alt+Tab");
  await expect(page.getByRole("button", { name: "정렬" })).toBeFocused();
  await page.keyboard.press("Alt+Tab");
  await expect(memoList(page)).toBeFocused();
});

test("the pinned zone and the rest are one run of rows", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "", { modifiedMs: 3 }),
      b: { ...fakeMemo("나.md", "", { modifiedMs: 2 }), pinned: true },
      c: fakeMemo("다.md", "", { modifiedMs: 1 }),
    },
  });
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  expect(await current(page)).toBe("나.md");
  await page.keyboard.press("ArrowDown");
  expect(await current(page)).toBe("가.md");
  await page.keyboard.press("ArrowUp");
  expect(await current(page)).toBe("나.md");
});

test("⌘⌫ in the list moves the memo to the trash without asking; in the editor it deletes to the line's start", async ({
  page,
}) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "첫 줄\n둘째 줄", { modifiedMs: 3 }),
      b: fakeMemo("나.md", "둘", { modifiedMs: 2 }),
      c: fakeMemo("다.md", "셋", { modifiedMs: 1 }),
    },
  });
  await option(page, "가.md").click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Meta+Backspace");
  await expect(page.locator(".cm-line")).toHaveText(["첫 줄", ""]);
  await expect(option(page, "가.md")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("첫 줄\n");

  // The open memo goes, its tab closing; the keys stay on the list, on the row in its place.
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Meta+Backspace");
  await expect(option(page, "가.md")).toHaveCount(0);
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(status(page)).toHaveText("1개를 휴지통으로 옮겼습니다");
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(Object.keys((await data(page)).trash ?? {})).toEqual(["a"]);
  expect(await page.evaluate(() => window.__tote.backend.trashedText("a"))).toBe("첫 줄\n");
  await expect(memoList(page)).toBeFocused();
  expect(await current(page)).toBe("나.md");
  // Again: the next one.
  await page.keyboard.press("Meta+Backspace");
  await expect(option(page, "나.md")).toHaveCount(0);
  expect(await current(page)).toBe("다.md");
});

test("⇧F10 and the menu key open the row's context menu, as a right click does", async ({
  page,
}) => {
  await start(page, { ...three(), popupMenuPick: null });
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+F10");
  await expect.poll(() => lastMenu(page)).toContain("이름 바꾸기…");
  expect((await data(page)).popupMenus).toHaveLength(1);
  await page.keyboard.press("ContextMenu");
  await expect.poll(async () => (await data(page)).popupMenus?.length).toBe(2);
  await expect(memoList(page)).toBeFocused();

  await pick(page, "rename");
  await page.keyboard.press("Shift+F10");
  const input = page.locator(".modal input");
  await expect(input).toBeFocused();
  await input.fill("라.md");
  await input.press("Enter");
  await expect(option(page, "라.md")).toHaveCount(1);
  // The rename gave the keys to the editor as it closed; they come back to the list.
  await expect(memoList(page)).toBeFocused();
});

test("a memo open in a tab trashed from ⇧F10 leaves the keys on the list", async ({ page }) => {
  await start(page, { ...three(), popupMenuPick: "trash" });
  await option(page, "나.md").click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+F10");
  await expect(option(page, "나.md")).toHaveCount(0);
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect(memoList(page)).toBeFocused();
  expect(await current(page)).toBe("다.md");
});

test("⌘click adds and takes out, ⇧click picks a run, and neither opens", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "", { modifiedMs: 4 }),
      b: fakeMemo("나.md", "", { modifiedMs: 3 }),
      c: fakeMemo("다.md", "", { modifiedMs: 2 }),
      d: fakeMemo("라.md", "", { modifiedMs: 1 }),
    },
  });
  await option(page, "가.md").click();
  await expect(activeTab(page)).toHaveText("가");
  await option(page, "다.md").click({ modifiers: ["Meta"] });
  expect(await pickedNames(page)).toEqual(["가.md", "다.md"]);
  await option(page, "가.md").click({ modifiers: ["Meta"] });
  expect(await pickedNames(page)).toEqual(["다.md"]);
  await option(page, "나.md").click({ modifiers: ["Shift"] });
  expect(await pickedNames(page)).toEqual(["나.md", "다.md"]);
  await option(page, "라.md").click({ modifiers: ["Shift"] });
  expect(await pickedNames(page)).toEqual(["다.md", "라.md"]);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(activeTab(page)).toHaveText("가");
  // Several picked: the rows show it whether or not the list has the keys.
  await page.locator(".cm-content").click();
  await expect(option(page, "라.md")).toHaveClass(/\bpicked\b/);
});

test("the menu on what is picked moves it all to the trash", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "", { modifiedMs: 3 }),
      b: fakeMemo("나.md", "", { modifiedMs: 2 }),
      c: fakeMemo("다.md", "", { modifiedMs: 1 }),
    },
    popupMenuPick: "trash",
  });
  await option(page, "가.md").click({ modifiers: ["Meta"] });
  await option(page, "다.md").click({ modifiers: ["Meta"] });
  await option(page, "다.md").click({ button: "right" });
  await expect(option(page, "가.md")).toHaveCount(0);
  await expect(option(page, "다.md")).toHaveCount(0);
  await expect(option(page, "나.md")).toHaveCount(1);
  await expect(status(page)).toHaveText("2개를 휴지통으로 옮겼습니다");
  expect(Object.keys((await data(page)).trash ?? {}).sort()).toEqual(["a", "c"]);
  // For several, what is for one alone is not on the menu.
  expect(await lastMenu(page)).toEqual(["맨 위에 고정", "복제", "", "휴지통으로 이동"]);
});

test("a right click outside what is picked picks that row alone", async ({ page }) => {
  await start(page, { ...three(), popupMenuPick: "trash" });
  await option(page, "가.md").click({ modifiers: ["Meta"] });
  await option(page, "다.md").click({ modifiers: ["Meta"] });
  await option(page, "나.md").click({ button: "right" });
  await expect(option(page, "나.md")).toHaveCount(0);
  expect(Object.keys((await data(page)).trash ?? {})).toEqual(["b"]);
  expect(await lastMenu(page)).toContain("이름 바꾸기…");
});

test("⇧↓ widens what is picked; 고정 pins every one, then 고정 해제 frees them all", async ({
  page,
}) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "", { modifiedMs: 3 }),
      b: { ...fakeMemo("나.md", "", { modifiedMs: 2 }), pinned: true },
      c: fakeMemo("다.md", "", { modifiedMs: 1 }),
    },
    popupMenuPick: "pin",
  });
  await filter(page).focus();
  // 나 (pinned) first, then 가, 다.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  expect(await pickedNames(page)).toEqual(["나.md", "가.md"]);
  await page.keyboard.press("Shift+F10");
  // One of them is not pinned yet: 「맨 위에 고정」 pins both.
  await expect.poll(async () => (await data(page)).memos.a.pinned).toBe(true);
  expect(await lastMenu(page)).toEqual(["맨 위에 고정", "복제", "", "휴지통으로 이동"]);
  expect((await data(page)).memos.b.pinned).toBe(true);
  await expect(page.locator(".memo-pinned .memo-row")).toHaveCount(2);
  expect(await pickedNames(page)).toEqual(["가.md", "나.md"]);

  await page.keyboard.press("Shift+F10");
  await expect.poll(async () => (await data(page)).memos.a.pinned ?? false).toBe(false);
  expect((await lastMenu(page))?.[0]).toBe("고정 해제");
  expect((await data(page)).memos.b.pinned ?? false).toBe(false);
  await expect(page.locator(".memo-pinned .memo-row")).toHaveCount(0);
});

test("⌘A picks every row shown and 복제 copies them all", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "하나", { modifiedMs: 2 }),
      b: fakeMemo("나.md", "둘", { modifiedMs: 1 }),
    },
    popupMenuPick: "duplicate",
  });
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Meta+a");
  expect(await pickedNames(page)).toEqual(["가.md", "나.md"]);
  await page.keyboard.press("Shift+F10");
  await expect(status(page)).toHaveText("2개를 복제했습니다");
  const files = Object.values((await data(page)).memos).map((memo) => memo.file);
  expect(files.sort()).toEqual(["가 2.md", "가.md", "나 2.md", "나.md"]);
});

test("다른 워크스페이스로 옮기기 moves every row picked", async ({ page }) => {
  const info = (name: string) => ({
    id: name,
    name,
    title: name,
    path: `/fake/${name}`,
    deviceId: "d",
  });
  const listed = (name: string, windows: number, order: number) => ({
    name,
    path: `/fake/${name}`,
    open: windows > 0,
    windows,
    missing: false,
    order,
  });
  await start(page, {
    workspace: info("업무"),
    memos: {
      a: fakeMemo("가.md", "하나", { modifiedMs: 3 }),
      b: fakeMemo("나.md", "둘", { modifiedMs: 2 }),
      c: fakeMemo("다.md", "셋", { modifiedMs: 1 }),
    },
    workspaces: [listed("업무", 1, 0), listed("개인", 0, 1)],
    otherWorkspaces: { "/fake/개인": { workspace: info("개인"), memos: {}, session: null } },
    popupMenuPick: "move-to:/fake/개인",
  });
  await option(page, "가.md").click({ modifiers: ["Meta"] });
  await option(page, "나.md").click({ modifiers: ["Shift"] });
  await option(page, "가.md").click({ button: "right" });
  await expect(status(page)).toHaveText("2개를 개인으로 옮겼습니다");
  await expect(page.getByRole("option")).toHaveCount(1);
  const moved = await page.evaluate(() =>
    Object.values(window.__tote.backend.data.otherWorkspaces!["/fake/개인"].memos).map(
      (memo) => memo.file,
    ),
  );
  expect(moved.sort()).toEqual(["가.md", "나.md"]);
});

test("a row the filter hides is no longer picked", async ({ page }) => {
  await start(page, { ...three(), popupMenuPick: "trash" });
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Meta+a");
  expect(await pickedNames(page)).toEqual(["가.md", "나.md", "다.md"]);
  await filter(page).fill("나");
  await expect(page.getByRole("option")).toHaveCount(1);
  await filter(page).fill("");
  await expect(page.getByRole("option")).toHaveCount(3);
  expect(await pickedNames(page)).toEqual(["나.md"]);
  // The menu acts on it alone.
  await option(page, "나.md").click({ button: "right" });
  expect(Object.keys((await data(page)).trash ?? {})).toEqual(["b"]);
});

test("in a list of a thousand the current row stays in view to the end and back", async ({
  page,
}) => {
  const memos: FakeData["memos"] = {};
  for (let i = 0; i < 1000; i++) {
    const name = `메모 ${String(i).padStart(4, "0")}.md`;
    memos[`m${i}`] = fakeMemo(name, "", { modifiedMs: 1000 - i });
  }
  await start(page, { memos });
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  expect(await current(page)).toBe("메모 0999.md");
  await expect(option(page, "메모 0999.md")).toBeInViewport();
  await page.keyboard.press("Home");
  await expect(option(page, "메모 0000.md")).toBeInViewport();
  for (let i = 0; i < 5; i++) await page.keyboard.press("PageDown");
  const name = (await current(page))!;
  expect(name).not.toBe("메모 0000.md");
  await expect(option(page, name)).toBeInViewport();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
  await expect(option(page, (await current(page))!)).toBeInViewport();
  // Scrolled away with the wheel, the row is not drawn and not named; the next key brings it back.
  await page.locator(".memo-scroller").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(() => memoList(page).getAttribute("aria-activedescendant")).toBeNull();
  await page.keyboard.press("ArrowDown");
  await expect(option(page, (await current(page))!)).toBeInViewport();
});

const trashed = (file: string, contents: string, deletedMs: number): FakeTrashed => ({
  ...fakeMemo(file, contents),
  deletedMs,
});

async function openTrash(page: Page, trash: Record<string, FakeTrashed>): Promise<void> {
  await start(page, { trash, popupMenuPick: null });
  await page.getByRole("button", { name: "휴지통" }).click();
  await expect(trashList(page)).toBeVisible();
}

test("the trash list: the keys move, Enter opens read-only with the keys kept", async ({
  page,
}) => {
  await openTrash(page, {
    t: trashed("회의록.md", "옛것", 9),
    u: trashed("다른.md", "x", 5),
  });
  await trashList(page).focus();
  await page.keyboard.press("ArrowDown");
  expect(await current(page, trashList(page))).toBe("회의록.md");
  await page.keyboard.press("ArrowDown");
  expect(await current(page, trashList(page))).toBe("다른.md");
  await page.keyboard.press("Enter");
  await expect(activeTab(page)).toHaveText("다른");
  await expect(page.locator(".cm-content")).toHaveText("x");
  await expect(trashList(page)).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect.poll(() => lastMenu(page)).toEqual(["복구", "Finder 에서 보기", "", "영구 삭제"]);
});

test("⌘⌫ in the trash list asks before it removes for good, and the keys come back to the list", async ({
  page,
}) => {
  await openTrash(page, {
    t: trashed("회의록.md", "옛것", 9),
    u: trashed("다른.md", "x", 5),
    v: trashed("셋째.md", "y", 1),
  });
  await trashList(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Meta+Backspace");
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("p")).toHaveText(
    "「회의록.md」 를 영구 삭제할까요? 되돌릴 수 없습니다.",
  );
  await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal")).toHaveCount(0);
  expect(Object.keys((await data(page)).trash ?? {}).sort()).toEqual(["t", "u", "v"]);
  await expect(trashList(page)).toBeFocused();

  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Meta+Backspace");
  await expect(dialog.locator("p")).toHaveText(
    "고른 메모 2개를 영구 삭제할까요? 되돌릴 수 없습니다.",
  );
  await dialog.getByRole("button", { name: "영구 삭제" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
  expect(Object.keys((await data(page)).trash ?? {})).toEqual(["v"]);
  await expect(page.getByRole("option")).toHaveCount(1);
});

test("the trash list's menu acts on every row picked", async ({ page }) => {
  await openTrash(page, {
    t: trashed("회의록.md", "옛것", 9),
    u: trashed("다른.md", "x", 5),
    v: trashed("셋째.md", "y", 1),
  });
  await pick(page, "restore");
  await option(page, "회의록.md").click({ modifiers: ["Meta"] });
  await option(page, "셋째.md").click({ modifiers: ["Meta"] });
  await expect(page.locator(".tab")).toHaveCount(0);
  await option(page, "셋째.md").click({ button: "right" });
  await expect(page.getByRole("option")).toHaveCount(1);
  expect(await lastMenu(page)).toEqual(["복구", "", "영구 삭제"]);
  expect(Object.keys((await data(page)).trash ?? {})).toEqual(["u"]);
  const files = Object.values((await data(page)).memos).map((memo) => memo.file);
  expect(files.sort()).toEqual(["셋째.md", "회의록.md"]);

  await pick(page, "purge");
  await option(page, "다른.md").click({ button: "right" });
  await page.getByRole("dialog").getByRole("button", { name: "영구 삭제" }).click();
  await expect(page.getByRole("option")).toHaveCount(0);
});

test("the versions dialog picks with ↑↓ and restores with Enter", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("회의.md", "v3") },
    backups: {
      a: [
        { snapshot: "20261012-100000", file: "회의.md", text: "v1" },
        { snapshot: "20261012-101000", file: "회의.md", text: "v2" },
      ],
    },
  });
  await option(page, "회의.md").click();
  await expect(page.locator(".cm-content")).toHaveText("v3");
  await menu(page, "versions");
  const list = page.getByRole("listbox", { name: "버전" });
  await expect(list).toBeFocused();
  const preview = page.locator(".version-preview");
  await expect(preview).toHaveText("v2");
  await expect(list.getByRole("option", { selected: true })).toHaveText("2026-10-12 10:10:00");
  await page.keyboard.press("ArrowDown");
  await expect(preview).toHaveText("v1");
  await expect(list.getByRole("option", { selected: true })).toHaveText("2026-10-12 10:00:00");
  await page.keyboard.press("ArrowUp");
  await expect(preview).toHaveText("v2");
  await page.keyboard.press("End");
  await expect(preview).toHaveText("v1");
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveText("v1");
});

test("the status bar's language is a button, and the picker goes by ↑↓ and Enter", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("script.sh", "echo hi") } });
  await option(page, "script.sh").click();
  const button = page.getByRole("button", { name: "언어: Shell Script" });
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press("Enter");
  const input = page.getByRole("combobox");
  await expect(input).toBeFocused();
  const picker = page.getByRole("listbox", { name: "언어" });
  const names = await picker.getByRole("option").allTextContents();
  const next = names[names.indexOf("Shell Script") + 1];
  await expect(picker.getByRole("option", { selected: true })).toHaveText("Shell Script");
  await page.keyboard.press("ArrowDown");
  await expect(picker.getByRole("option", { selected: true })).toHaveText(next);
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    (await picker.getByRole("option", { selected: true }).getAttribute("id"))!,
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: `언어: ${next}` })).toBeVisible();

  // Typed into, the first shown is marked; ↑ at the top stays there.
  await page.getByRole("button", { name: `언어: ${next}` }).click();
  await page.getByRole("combobox").fill("pyth");
  await expect(picker.getByRole("option", { selected: true })).toHaveText("Python");
  await page.keyboard.press("ArrowUp");
  await expect(picker.getByRole("option", { selected: true })).toHaveText("Python");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "언어: Python" })).toBeVisible();
});

test("with nothing typed the picker's Enter keeps the language, and ↓ moves off it", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("script.sh", "echo hi") } });
  await option(page, "script.sh").click();
  await page.getByRole("button", { name: "언어: Shell Script" }).click();
  const picker = page.getByRole("listbox", { name: "언어" });
  await expect(picker.getByRole("option", { selected: true })).toHaveText("Shell Script");
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "언어: Shell Script" })).toBeVisible();
});

test("a trashed tab's language cannot be pressed, and the status bar's message is a status", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("script.sh", "echo hi") },
    trash: { t: trashed("회의록.md", "옛것", 9) },
  });
  await option(page, "script.sh").click();
  await expect(page.getByRole("button", { name: "언어: Shell Script" })).toBeEnabled();
  await page.getByRole("button", { name: "휴지통" }).click();
  await option(page, "회의록.md").click();
  await expect(page.getByRole("button", { name: "언어: Markdown" })).toBeDisabled();
  await expect(status(page)).toHaveClass(/\bstatus-message\b/);
});

// Review round (2026-11-14): a key held down, the Korean input method, a composition in the filter,
// and rows kept as the picks change.

/** The memos `trashMemo` was asked to move, in order, noted as each call comes in. */
async function noteTrashCalls(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const { backend } = window.__tote;
    const trashMemo = backend.trashMemo.bind(backend);
    const calls: string[] = [];
    (window as unknown as { trashCalls: string[] }).trashCalls = calls;
    backend.trashMemo = async (...args) => {
      calls.push(args[0]);
      return trashMemo(...args);
    };
  });
  return () => page.evaluate(() => (window as unknown as { trashCalls: string[] }).trashCalls);
}

test("⌘⌫ held down moves one memo, however long the key repeats", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "", { modifiedMs: 5 }),
      b: fakeMemo("나.md", "", { modifiedMs: 4 }),
      c: fakeMemo("다.md", "", { modifiedMs: 3 }),
      d: fakeMemo("라.md", "", { modifiedMs: 2 }),
      e: fakeMemo("마.md", "", { modifiedMs: 1 }),
    },
  });
  const trashCalls = await noteTrashCalls(page);
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.down("Meta");
  await page.keyboard.down("Backspace");
  await expect(option(page, "가.md")).toHaveCount(0);
  expect(await current(page)).toBe("나.md");
  // The key repeats while it is held: each of these is `repeat: true`.
  await page.keyboard.down("Backspace");
  await page.keyboard.down("Backspace");
  await page.keyboard.up("Backspace");
  // A press of its own moves the next one, and nothing came between.
  await page.keyboard.press("Backspace");
  await page.keyboard.up("Meta");
  await expect(option(page, "나.md")).toHaveCount(0);
  expect(await trashCalls()).toEqual(["a", "b"]);
  await expect(page.getByRole("option")).toHaveCount(3);
});

test("⌘⌫ held down in the trash list asks once", async ({ page }) => {
  await openTrash(page, {
    t: trashed("회의록.md", "옛것", 9),
    u: trashed("다른.md", "x", 5),
  });
  await trashList(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.down("Meta");
  await page.keyboard.down("Backspace");
  await page.keyboard.down("Backspace");
  await page.keyboard.down("Backspace");
  await page.keyboard.up("Backspace");
  await page.keyboard.up("Meta");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("dialog").getByRole("button", { name: "취소" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(Object.keys((await data(page)).trash ?? {}).sort()).toEqual(["t", "u"]);
});

test("⌘A picks every row with the Korean input method on, which sends ㅁ", async ({ page }) => {
  await start(page, three());
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  const taken = await memoList(page).evaluate((list) => {
    const event = new KeyboardEvent("keydown", {
      key: "ㅁ",
      code: "KeyA",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    list.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(taken).toBe(true);
  expect(await pickedNames(page)).toEqual(["가.md", "나.md", "다.md"]);
});

test("↓ in the filter while a syllable is composed stays with the composition", async ({
  page,
}) => {
  await start(page, three());
  await filter(page).focus();
  const passed = await filter(page).evaluate((input) =>
    [{ isComposing: true }, { keyCode: 229 }].map((how) => {
      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        code: "ArrowDown",
        bubbles: true,
        cancelable: true,
        isComposing: "isComposing" in how,
      });
      if ("keyCode" in how) Object.defineProperty(event, "keyCode", { value: how.keyCode });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  expect(passed).toEqual([false, false]);
  await expect(filter(page)).toBeFocused();
  expect(await memoList(page).getAttribute("aria-activedescendant")).toBeNull();
});

test("picking and moving the current row keep each row's element", async ({ page }) => {
  await start(page, three());
  await filter(page).focus();
  await page.keyboard.press("ArrowDown");
  const rows = await page.getByRole("option").elementHandles();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Meta+a");
  await option(page, "가.md").click({ modifiers: ["Meta"] });
  await option(page, "나.md").click({ modifiers: ["Shift"] });
  // ⌘ took 가 out of all three; ⇧ ran from the last row added to 나.
  expect(await pickedNames(page)).toEqual(["나.md"]);
  const now = await page.getByRole("option").elementHandles();
  expect(now).toHaveLength(rows.length);
  for (const [i, row] of rows.entries())
    expect(await row.evaluate((el, other) => el === other, now[i])).toBe(true);
});
