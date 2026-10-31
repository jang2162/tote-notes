import { expect, test, type Page } from "@playwright/test";

import { FAKE_STORAGE_KEY, fakeMemo, type FakeTrashed } from "../../src/backend/fake";
import {
  menu,
  openShopping,
  openWindow,
  quietErrors,
  ready,
  sessionPane,
  start,
  startWindows,
  typeWhileChangedElsewhere,
  writesSettled,
} from "./helpers";

// The memo trash (spec 2026-11-01 「휴지통으로 옮기기」) on the fake backend: what goes into
// `data.trash`, and what stays when it must not go.

const NOT_TRASHED = "저장하지 못해 휴지통으로 옮기지 않았습니다";
const NOT_TORN_OFF = "휴지통 메모는 새 창으로 옮길 수 없습니다";
const WRITE_FAILED = "no space left on device";

const row = (page: Page, name: string) => page.locator(".memo-row", { hasText: name });
const lastMenu = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.popupMenus?.at(-1) ?? null);
const trash = (page: Page) => page.evaluate(() => window.__tote.backend.data.trash ?? {});
const trashedText = (page: Page, id: string) =>
  page.evaluate((memo) => window.__tote.backend.trashedText(memo), id);

/** What the next pop-up menu of the windows of `page`'s context picks. Stored at once: the windows
 * share the fake's data, and another window's write would otherwise read over a change only in
 * this page's memory. */
const pick = (page: Page, id: string | null) =>
  page.evaluate(
    ([id, key]) => {
      const { backend } = window.__tote;
      backend.data.popupMenuPick = id;
      localStorage.setItem(key, JSON.stringify(backend.data));
    },
    [id, FAKE_STORAGE_KEY] as const,
  );

/** Opens 장보기 (우유) with the cursor after 우유 and types behind it. */
async function typeInto(page: Page, seed: Parameters<typeof start>[1] = {}): Promise<void> {
  await openShopping(page, seed);
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 계란");
}

test("the memo menu ends with a separator and 휴지통으로 이동", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }),
      b: { ...fakeMemo("나.md", "둘째", { modifiedMs: 1 }), pinned: true },
    },
    popupMenuPick: null,
  });
  const ending = [{ separator: true }, { id: "trash", text: "휴지통으로 이동" }];
  await row(page, "가").click({ button: "right" });
  await expect.poll(async () => (await lastMenu(page))?.slice(-2)).toMatchObject(ending);
  // A row of the pinned zone has it too.
  await page.locator(".memo-pinned .memo-row", { hasText: "나" }).click({ button: "right" });
  await expect.poll(async () => (await lastMenu(page))?.[0].text).toBe("이름 바꾸기…");
  expect(await page.evaluate(() => window.__tote.backend.data.popupMenus?.length)).toBe(2);
  expect((await lastMenu(page))?.slice(-2)).toMatchObject(ending);
  // Nothing was picked: both stay.
  await expect(page.locator(".memo-row")).toHaveCount(2);
});

test("trashing moves the memo out of the list without asking", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }), b: fakeMemo("나.md", "둘째") },
    popupMenuPick: "trash",
  });
  await row(page, "가").click({ button: "right" });
  await expect(row(page, "가")).toHaveCount(0);
  await expect(row(page, "나")).toHaveCount(1);
  await expect(page.locator(".modal")).toHaveCount(0);
  expect(Object.keys(await trash(page))).toEqual(["a"]);
  expect(await trashedText(page, "a")).toBe("첫째");
  expect(await page.evaluate(() => Object.keys(window.__tote.backend.data.memos))).toEqual(["b"]);
});

test("trashing an open memo saves its last edit first and closes its tab", async ({ page }) => {
  await typeInto(page, { popupMenuPick: "trash" });
  // At once, before the save's timer: the trash takes the text as typed.
  await row(page, "장보기").click({ button: "right" });
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect(row(page, "장보기")).toHaveCount(0);
  expect(await trashedText(page, "a")).toBe("우유 계란");
  expect(await page.evaluate(() => window.__tote.backend.data.places)).toEqual({});
});

test("a memo whose save failed is not trashed", async ({ page }) => {
  await quietErrors(page, WRITE_FAILED);
  // Every write fails: the save tried before the move fails too.
  await typeInto(page, { failWrites: 1000, popupMenuPick: "trash" });
  await row(page, "장보기").click({ button: "right" });
  await expect(page.locator(".status-message")).toHaveText(NOT_TRASHED);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
  await expect(row(page, "장보기")).toHaveCount(1);
  expect(await trash(page)).toEqual({});
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("우유");
});

test("a memo with a conflict banner open is not trashed", async ({ page }) => {
  await typeWhileChangedElsewhere(page);
  await expect(page.locator(".banner")).toBeVisible();
  await page.evaluate(() => (window.__tote.backend.data.popupMenuPick = "trash"));
  await row(page, "장보기").click({ button: "right" });
  await expect(page.locator(".status-message")).toHaveText(NOT_TRASHED);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".banner")).toBeVisible();
  expect(await trash(page)).toEqual({});
  // Neither side of the conflict was written over.
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("두유");
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
});

test("trashing a memo open in another window saves it there and closes its tab", async ({
  context,
}) => {
  const first = await startWindows(context, {
    memos: { a: fakeMemo("장보기.md", "우유"), b: fakeMemo("할 일.md", "청소") },
  });
  await row(first, "장보기").click();
  await expect(first.locator(".cm-content")).toHaveText("우유");
  // The pages share the fake's data as one `localStorage` blob that reaches the other page late,
  // so a page writing from an old copy wipes what the other wrote meanwhile: the second window
  // opens before the typing, and the clock (the context's, both pages') holds the save's timer,
  // so the first window writes only once it is asked — after the second's last write.
  const second = await openWindow(context, "ws-2");
  await first.clock.install();
  await first.clock.pauseAt(Date.now() + 60_000);
  await first.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await first.keyboard.insertText(" 계란");
  await pick(second, "trash");
  expect(await first.evaluate(() => window.__tote.backend.memoText("a"))).toBe("우유");
  await row(second, "장보기").click({ button: "right" });
  await expect(first.locator(".tab")).toHaveCount(0);
  await expect(row(first, "장보기")).toHaveCount(0);
  expect(await trashedText(first, "a")).toBe("우유 계란");
  // The second window reads the change once it has reached its page, then hears of it (its
  // gathering timer, MEMOS_GATHER_MS in src/app/controller.ts, runs on the held clock).
  await expect.poll(() => trashedText(second, "a")).toBe("우유 계란");
  await first.clock.runFor(300);
  await expect(row(second, "장보기")).toHaveCount(0);
  expect(await second.evaluate(() => window.__tote.backend.data.places)).toEqual({});
});

// The trash in the sidebar (spec 2026-11-01 「휴지통 화면」).

const trashButton = (page: Page) => page.getByRole("button", { name: "휴지통", exact: true });
const settingsButton = (page: Page) => page.getByRole("button", { name: "설정", exact: true });
const trashNames = (page: Page) => page.locator(".trash-row .memo-name");
const trashRow = (page: Page, name: string) => page.locator(".trash-row", { hasText: name });
const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;
const trashed = (file: string, contents: string, deletedMs: number): FakeTrashed => ({
  ...fakeMemo(file, contents),
  deletedMs,
});
const confirmDialog = (page: Page) => page.locator(".modal.confirm");

test("the trash button swaps the memo list for the trash and back", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째") },
    trash: { old: trashed("옛것.md", "x", 5), recent: trashed("최근.txt", "y", 9) },
  });
  await expect(trashButton(page)).toHaveAttribute("title", "휴지통 (2개)");
  // At the foot, right of the settings button, as tall and on its line.
  const footer = await box(page, ".sidebar-footer");
  const settings = (await settingsButton(page).boundingBox())!;
  const own = (await trashButton(page).boundingBox())!;
  expect(footer.height).toBe(44);
  expect(own.height).toBe(28);
  expect(own.x).toBeGreaterThanOrEqual(settings.x + settings.width);
  expect(own.y + own.height / 2).toBeCloseTo(settings.y + settings.height / 2, 0);

  await trashButton(page).click();
  await expect(page.locator(".memo-pane")).toBeHidden();
  await expect(page.locator(".trash-pane")).toBeVisible();
  await expect(trashButton(page)).toHaveAttribute("aria-pressed", "true");
  // The switcher stays above it.
  await expect(page.locator(".ws-switcher-button")).toBeVisible();
  await expect(page.locator(".trash-heading")).toHaveText("휴지통 2");
  await expect(trashNames(page)).toHaveText(["최근", "옛것"]);
  await expect(page.locator(".trash-row .memo-ext")).toHaveText(["txt", "md"]);
  await expect(page.locator(".trash-row .trash-when").first()).toHaveText(
    /^\d{4}-\d\d-\d\d \d\d:\d\d$/,
  );
  await expect(page.getByRole("button", { name: "휴지통 비우기" })).toBeEnabled();
  expect(await box(page, ".sidebar-footer")).toEqual(footer);

  await page.getByRole("button", { name: "← 메모" }).click();
  await expect(page.locator(".trash-pane")).toBeHidden();
  await expect(page.locator(".memo-pane")).toBeVisible();
  await expect(trashButton(page)).toHaveAttribute("aria-pressed", "false");
  await trashButton(page).click();
  await expect(page.locator(".trash-pane")).toBeVisible();
  await trashButton(page).click();
  await expect(page.locator(".memo-pane")).toBeVisible();
  await expect(page.locator(".trash-pane")).toBeHidden();
});

test("an update fills the rest of the foot right of the trash button", async ({ page }) => {
  await start(page);
  const footer = await box(page, ".sidebar-footer");
  await page.evaluate(() =>
    window.__tote.backend.announceUpdate({ version: "0.2.0", current: "0.1.0", notes: "" }),
  );
  await expect(page.locator(".update-button")).toBeVisible();
  expect(await box(page, ".sidebar-footer")).toEqual(footer);
  const own = (await trashButton(page).boundingBox())!;
  const update = await box(page, ".update-button");
  expect(update.x).toBeGreaterThanOrEqual(own.x + own.width);
  expect(update.y + update.height / 2).toBeCloseTo(own.y + own.height / 2, 0);
  expect(update.x + update.width).toBeGreaterThan(footer.x + footer.width - 16);
  expect(update.x + update.width).toBeLessThanOrEqual(footer.x + footer.width);
});

test("a trashed row's menu restores it into the memo list", async ({ page }) => {
  await start(page, {
    memos: { n: fakeMemo("회의록.md", "새것") },
    trash: { t: { ...trashed("회의록.md", "옛것", 5), pinned: true, language: "markdown" } },
    popupMenuPick: "restore",
  });
  await trashButton(page).click();
  await trashRow(page, "회의록").click({ button: "right" });
  await expect(trashNames(page)).toHaveCount(0);
  await expect(page.locator(".trash-none")).toHaveText("휴지통이 비었습니다");
  await expect(page.getByRole("button", { name: "휴지통 비우기" })).toBeDisabled();
  await expect(trashButton(page)).toHaveAttribute("title", "휴지통 (0개)");
  expect(await page.evaluate(() => window.__tote.backend.data.popupMenus?.at(-1))).toMatchObject([
    { id: "restore", text: "복구" },
    { separator: true },
    { id: "purge", text: "영구 삭제" },
  ]);
  // Asked nothing; back in the list under the next free name, pinned as it was.
  await expect(page.locator(".modal")).toHaveCount(0);
  await page.getByRole("button", { name: "← 메모" }).click();
  await expect(page.locator(".memo-pinned .memo-row .memo-name")).toHaveText(["회의록 2"]);
  expect(await page.evaluate(() => window.__tote.backend.data.memos.t)).toMatchObject({
    file: "회의록 2.md",
    pinned: true,
    language: "markdown",
  });
  expect(await page.evaluate(() => window.__tote.backend.memoText("n"))).toBe("새것");
});

test("영구 삭제 asks once and removes for good", async ({ page }) => {
  await start(page, {
    trash: { t: trashed("회의록.md", "옛것", 5), u: trashed("다른.md", "x", 4) },
    popupMenuPick: "purge",
  });
  await trashButton(page).click();
  await trashRow(page, "회의록").click({ button: "right" });
  await expect(confirmDialog(page)).toHaveCount(1);
  await expect(confirmDialog(page).locator("p")).toHaveText(
    "「회의록.md」 를 영구 삭제할까요? 되돌릴 수 없습니다.",
  );
  await expect(confirmDialog(page).locator("button")).toHaveText(["취소", "영구 삭제"]);
  await expect(confirmDialog(page).getByRole("button", { name: "영구 삭제" })).toHaveClass(
    /\bdanger\b/,
  );
  // What cannot be undone is not the default: a stray Enter keeps it.
  await expect(confirmDialog(page).getByRole("button", { name: "취소" })).toBeFocused();
  await confirmDialog(page).getByRole("button", { name: "취소" }).click();
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(trashNames(page)).toHaveText(["회의록", "다른"]);

  await trashRow(page, "회의록").click({ button: "right" });
  await confirmDialog(page).getByRole("button", { name: "영구 삭제" }).click();
  await expect(trashNames(page)).toHaveText(["다른"]);
  await expect(page.locator(".modal")).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(window.__tote.backend.data.trash ?? {}))).toEqual([
    "u",
  ]);
  await expect(trashButton(page)).toHaveAttribute("title", "휴지통 (1개)");
});

test("휴지통 비우기 asks with the count", async ({ page }) => {
  await start(page, {
    trash: {
      a: trashed("가.md", "", 1),
      b: trashed("나.md", "", 2),
      c: trashed("다.md", "", 3),
    },
  });
  await trashButton(page).click();
  const empty = page.getByRole("button", { name: "휴지통 비우기" });
  await empty.click();
  await expect(confirmDialog(page).locator("p")).toHaveText(
    "휴지통의 메모 3개를 영구 삭제할까요? 되돌릴 수 없습니다.",
  );
  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(trashNames(page)).toHaveCount(3);

  await empty.click();
  await confirmDialog(page).getByRole("button", { name: "영구 삭제" }).click();
  await expect(trashNames(page)).toHaveCount(0);
  await expect(page.locator(".trash-none")).toBeVisible();
  await expect(page.locator(".trash-heading")).toHaveText("휴지통 0");
  await expect(empty).toBeDisabled();
  expect(await page.evaluate(() => window.__tote.backend.data.trash)).toEqual({});
});

test("another window's trash change shows here", async ({ context }) => {
  const first = await startWindows(context, {
    memos: { a: fakeMemo("장보기.md", "우유"), b: fakeMemo("할 일.md", "청소") },
  });
  await trashButton(first).click();
  await expect(first.locator(".trash-none")).toBeVisible();
  const second = await openWindow(context, "ws-2");
  await pick(second, "trash");
  await row(second, "장보기").click({ button: "right" });
  await expect(trashNames(first)).toHaveText(["장보기"]);
  await expect(first.locator(".trash-heading")).toHaveText("휴지통 1");
  await expect(trashButton(first)).toHaveAttribute("title", "휴지통 (1개)");
  await expect(trashButton(second)).toHaveAttribute("title", "휴지통 (1개)");

  await trashButton(second).click();
  await pick(second, "restore");
  await trashRow(second, "장보기").click({ button: "right" });
  await expect(first.locator(".trash-none")).toBeVisible();
  await expect(trashButton(first)).toHaveAttribute("title", "휴지통 (0개)");
  await trashButton(first).click();
  await expect(row(first, "장보기")).toHaveCount(1);
});

test("switching workspaces shows the new workspace's trash", async ({ page }) => {
  await quietErrors(page, "is switching workspaces");
  const other = {
    workspace: { id: "w-2", name: "개인", title: "개인", path: "/fake/개인", deviceId: "device-1" },
    memos: {},
    session: null,
    trash: { p: trashed("일기.md", "오늘", 7) },
  };
  await start(page, {
    trash: { t: trashed("회의록.md", "x", 5), u: trashed("다른.md", "y", 4) },
    workspaces: [
      { name: "메모", path: "/fake/메모", open: true, windows: 1, missing: false },
      { name: "개인", path: "/fake/개인", open: false, windows: 0, missing: false },
    ],
    otherWorkspaces: { "/fake/개인": other },
  });
  await expect(trashButton(page)).toHaveAttribute("title", "휴지통 (2개)");
  await trashButton(page).click();
  await expect(trashNames(page)).toHaveText(["회의록", "다른"]);
  await page.locator(".ws-switcher-button").click();
  await page.locator(".ws-switcher-item", { hasText: "개인" }).click();
  await expect(page).toHaveTitle("개인");
  await ready(page);
  await expect(trashButton(page)).toHaveAttribute("title", "휴지통 (1개)");
  await trashButton(page).click();
  await expect(trashNames(page)).toHaveText(["일기"]);
});

// A trashed memo's read-only tab (spec 2026-11-01 「내용 보기」).

const tab = (page: Page) => page.locator(".tab");
const editor = (page: Page) => page.locator(".cm-content");
const banner = (page: Page) => page.locator(".banner");
const TRASHED_AT = /^휴지통에 있는 메모입니다 · \d{4}-\d\d-\d\d \d\d:\d\d$/;

test("a trashed row opens read-only with the trash banner", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("장보기.md", "우유") },
    trash: { t: { ...trashed("회의록.md", "def f():\n    pass", 5), language: "python" } },
  });
  await trashButton(page).click();
  await trashRow(page, "회의록").click();
  await expect(tab(page)).toHaveCount(1);
  // The original name, dimmed: a trashed memo's tab.
  await expect(page.locator(".tab.active .tab-title")).toHaveText("회의록");
  await expect(page.locator(".tab.active")).toHaveClass(/\btrashed\b/);
  await expect(editor(page)).toHaveText("def f():    pass");
  await expect(editor(page)).toHaveAttribute("aria-readonly", "true");
  // Its own language, which the read-only tab does not offer to change.
  await expect(page.locator(".status-language")).toHaveText("Python");
  await expect(page.locator(".status-language")).not.toHaveClass(/\bclickable\b/);
  await expect(banner(page)).toHaveClass(/\bbanner-trash\b/);
  await expect(banner(page).locator(".banner-text")).toHaveText(TRASHED_AT);
  // The same time the trash row shows.
  const when = await trashRow(page, "회의록").locator(".trash-when").textContent();
  await expect(banner(page).locator(".banner-text")).toHaveText(
    `휴지통에 있는 메모입니다 · ${when}`,
  );
  await expect(banner(page).locator("button")).toHaveText(["복구", "영구 삭제"]);

  // Pressed again, the row goes to the tab it has.
  await page.getByRole("button", { name: "← 메모" }).click();
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(tab(page)).toHaveCount(2);
  await expect(banner(page)).toBeHidden();
  await trashButton(page).click();
  await trashRow(page, "회의록").click();
  await expect(tab(page)).toHaveCount(2);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("회의록");
  await expect(banner(page)).toBeVisible();
  // Nothing about it changed in the trash, and nothing came into the memo list.
  expect(await trashedText(page, "t")).toBe("def f():\n    pass");
  expect(await page.evaluate(() => Object.keys(window.__tote.backend.data.memos))).toEqual(["a"]);
});

test("복구 in the banner turns the tab into the memo", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("장보기.md", "우유") },
    trash: { t: { ...trashed("회의록.md", "옛것", 5), pinned: true } },
  });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await trashButton(page).click();
  await trashRow(page, "회의록").click();
  await expect(banner(page)).toBeVisible();
  // Another tab after it: the memo takes the trashed tab's place, not the end.
  await page.getByRole("button", { name: "← 메모" }).click();
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await page.locator(".tab", { hasText: "회의록" }).click();
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "복구" }).click();

  await expect(banner(page)).toBeHidden();
  await expect(page.locator(".tab .tab-title")).toHaveText(["장보기", "회의록"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("회의록");
  await expect(page.locator(".tab.trashed")).toHaveCount(0);
  await expect(editor(page)).not.toHaveAttribute("aria-readonly", "true");
  await expect(page.locator(".memo-pinned .memo-row.active .memo-name")).toHaveText(["회의록"]);
  await expect(trashButton(page)).toHaveAttribute("title", "휴지통 (0개)");
  expect(await page.evaluate(() => window.__tote.backend.data.places)).toMatchObject({
    "memo:t": expect.any(String),
  });
  // An ordinary memo tab now: what is typed is saved.
  await editor(page).click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.insertText(" 새것");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoText("t")))
    .toBe("옛것 새것");
});

test("a purged memo's tab closes, in every window", async ({ context }) => {
  const first = await startWindows(context, {
    memos: { a: fakeMemo("장보기.md", "우유") },
    trash: { t: trashed("회의록.md", "옛것", 5), u: trashed("다른.md", "x", 4) },
  });
  await trashButton(first).click();
  await trashRow(first, "회의록").click();
  await trashRow(first, "다른").click();
  await expect(tab(first)).toHaveCount(2);
  const second = await openWindow(context, "ws-2");
  await trashButton(second).click();
  await trashRow(second, "회의록").click();
  await expect(tab(second)).toHaveCount(1);

  // 영구 삭제 in the banner asks as the row's menu does.
  await first.locator(".tab", { hasText: "회의록" }).click();
  await banner(first).getByRole("button", { name: "영구 삭제" }).click();
  await expect(confirmDialog(first).locator("p")).toHaveText(
    "「회의록.md」 를 영구 삭제할까요? 되돌릴 수 없습니다.",
  );
  await confirmDialog(first).getByRole("button", { name: "영구 삭제" }).click();
  await expect(first.locator(".tab .tab-title")).toHaveText(["다른"]);
  await expect(tab(second)).toHaveCount(0);
  await expect(trashNames(second)).toHaveText(["다른"]);

  // Emptied by the native side's hourly round: gone from the trash, the tab closes too.
  await first.evaluate((key) => {
    const { backend } = window.__tote;
    delete backend.data.trash!.u;
    localStorage.setItem(key, JSON.stringify(backend.data));
    backend.trashChanged();
  }, FAKE_STORAGE_KEY);
  await expect(tab(first)).toHaveCount(0);
  await expect(first.locator(".trash-none")).toBeVisible();
});

test("trashed tabs do not come back after a restart", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("장보기.md", "우유") },
    trash: { t: trashed("회의록.md", "옛것", 5) },
  });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await trashButton(page).click();
  await trashRow(page, "회의록").click();
  await expect(page.locator(".tab.active .tab-title")).toHaveText("회의록");
  // Written with the trashed tab open and in front: only the memo's tab is in it.
  await expect.poll(async () => (await sessionPane(page)).tabs.length).toBe(1);
  await writesSettled(page);
  const pane = await sessionPane(page);
  expect(pane.tabs).toMatchObject([{ kind: "memo", memoId: "a" }]);
  // Not even as an entry the reading drops: the file has the memo's tab alone.
  const file = await page.evaluate(() => window.__tote.backend.data.session ?? "");
  expect(file.match(/"kind":/g)).toHaveLength(1);
  expect(await page.evaluate(() => window.__tote.backend.data.places)).toEqual({
    "memo:a": "ws-1",
  });

  await page.reload();
  await ready(page);
  await expect(page.locator(".tab .tab-title")).toHaveText(["장보기"]);
  await expect(banner(page)).toBeHidden();
});

test("a trashed tab takes no typing, paste, drop or replace", async ({ page }) => {
  await start(page, { trash: { t: trashed("회의록.md", "옛것", 5) } });
  await trashButton(page).click();
  await trashRow(page, "회의록").click();
  await expect(editor(page)).toHaveText("옛것");
  await editor(page).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("ab");
  await page.keyboard.insertText("가나");
  for (const key of ["Enter", "Backspace", "Delete", "Tab", "Meta+Shift+d", "Meta+x"])
    await page.keyboard.press(key);
  await page.evaluate(() => {
    const target = window.__tote.app.view.contentDOM;
    const data = new DataTransfer();
    data.setData("text/plain", "붙임");
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    const { left, top } = target.getBoundingClientRect();
    target.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        clientX: left + 4,
        clientY: top + 4,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  // ⌥⌘F: the find bar opens, its replace does nothing.
  await page.keyboard.press("Meta+Alt+f");
  await page.locator("input.find-bar-input[name=search]").fill("옛것");
  await page.locator("input.find-bar-input[name=replace]").fill("새것");
  await page.locator("button[name=replace]").click();
  await page.locator("button[name=replace-all]").click();
  await expect(page.locator(".find-bar-count")).toHaveText(/1/);
  // A change the app dispatches itself, as Tab's indent and a composition's commit do.
  await page.evaluate(() => window.__tote.app.view.dispatch({ changes: { from: 0, insert: "x" } }));
  await expect(editor(page)).toHaveText("옛것");
  expect(await trashedText(page, "t")).toBe("옛것");
  expect(await page.evaluate(() => window.__tote.backend.data.memos)).toEqual({});
});

test("the menu leaves a trashed tab alone", async ({ page }) => {
  await start(page, {
    trash: { t: trashed("회의록.md", "# 옛것", 5) },
    popupMenuPick: null,
  });
  await trashButton(page).click();
  await trashRow(page, "회의록").click();
  await expect(editor(page)).toHaveText("# 옛것");
  for (const id of ["save", "rename", "import", "toggle-preview"]) await menu(page, id);
  await menu(page, "versions");
  await expect(page.locator(".status-message")).toHaveText("메모 탭에서만 쓸 수 있습니다");
  // Asked after them, the last command has answered: whatever the ones before would have shown
  // is showing by now.
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  // Not to another window: the trashed tab has no place there.
  await menu(page, "move-tab-to-new-window");
  await expect(page.locator(".status-message")).toHaveText(NOT_TORN_OFF);
  await expect(tab(page)).toHaveCount(1);
  expect(await page.evaluate(() => window.__tote.backend.data.tornOff ?? [])).toEqual([]);
  await page.locator(".tab", { hasText: "회의록" }).click({ button: "right" });
  await expect
    .poll(async () => (await lastMenu(page))?.map((item: { id: string }) => item.id))
    .toEqual(["split-tab-left", "split-tab-right", "split-tab-top", "split-tab-bottom"]);
  expect(await trashedText(page, "t")).toBe("# 옛것");
  expect(await page.evaluate(() => window.__tote.backend.data.memos)).toEqual({});
});

test("a restored memo another window holds closes the trashed tab here", async ({ page }) => {
  await start(page, {
    trash: { t: trashed("회의록.md", "옛것", 5) },
    // Opened in another window between the restore and this window's claim.
    places: { "memo:t": "ws-9" },
  });
  await trashButton(page).click();
  await trashRow(page, "회의록").click();
  await banner(page).getByRole("button", { name: "복구" }).click();
  await expect(tab(page)).toHaveCount(0);
  await page.getByRole("button", { name: "← 메모" }).click();
  await expect(page.locator(".memo-row", { hasText: "회의록" })).toHaveCount(1);
  expect(await page.evaluate(() => window.__tote.backend.data.places)).toEqual({
    "memo:t": "ws-9",
  });
});

test("a memo restored in another window turns the tab here into the memo", async ({ context }) => {
  const first = await startWindows(context, { trash: { t: trashed("회의록.md", "옛것", 5) } });
  await trashButton(first).click();
  await trashRow(first, "회의록").click();
  await expect(first.locator(".tab.trashed")).toHaveCount(1);
  const second = await openWindow(context, "ws-2");
  await trashButton(second).click();
  await pick(second, "restore");
  await trashRow(second, "회의록").click({ button: "right" });
  await expect(first.locator(".tab.trashed")).toHaveCount(0);
  await expect(first.locator(".tab.active .tab-title")).toHaveText("회의록");
  await expect(banner(first)).toBeHidden();
  await expect(editor(first)).toHaveText("옛것");
  await expect(editor(first)).not.toHaveAttribute("aria-readonly", "true");
  expect(await second.evaluate(() => window.__tote.backend.data.places)).toEqual({
    "memo:t": "ws-1",
  });
});

test("a trashed picture is not handed to a viewer", async ({ page }) => {
  await start(page, { trash: { p: trashed("점.png", "not a picture", 5) } });
  await trashButton(page).click();
  await trashRow(page, "점").click();
  await expect(page.locator(".tab.active .tab-title")).toHaveText("점.png");
  // No file a viewer could read: the placeholder of a file the editor cannot show.
  await expect(page.locator(".editor-placeholder")).toContainText("열 수 없음");
  await expect(banner(page).locator(".banner-text")).toHaveText(TRASHED_AT);
  // Shown, and no viewer asked for a file: the pane asks as it shows the tab, so by now it would
  // have — whatever the fake then made of the missing file.
  expect(await page.evaluate(() => window.__tote.backend.data.fileTokenRequests ?? [])).toEqual([]);
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  await expect(page.locator(".status-message")).toHaveText("");
});

test("a trashed memo over the editor's limit says so, as a memo tab does", async ({ page }) => {
  await start(page, { trash: { t: trashed("큰.txt", "x", 5) } });
  // The native side refuses it by its size before reading (`read_trashed`).
  await page.evaluate(async () => {
    const { backend } = window.__tote;
    // The app's own `BackendError`, as the fake throws it for a memo the trash does not have.
    const Refusal = await backend.readTrashed("없음").then(
      () => null,
      (error: Error) => error.constructor as typeof window.BackendError,
    );
    backend.readTrashed = async () => {
      throw new Refusal!("too-large", "over the editor's limit");
    };
  });
  await trashButton(page).click();
  await trashRow(page, "큰").click();
  await expect(page.locator(".tab.active .tab-title")).toHaveText("큰.txt");
  await expect(page.locator(".editor-placeholder")).toContainText(
    "100MB 가 넘어 편집기로 열 수 없습니다",
  );
  await expect(banner(page).locator(".banner-text")).toHaveText(TRASHED_AT);
  await expect(page.locator(".large-text")).toHaveCount(0);
});

test("a restore heard of before the memo list turns the tab into the memo", async ({ page }) => {
  await start(page, { trash: { t: trashed("회의록.md", "옛것", 5) } });
  await trashButton(page).click();
  await trashRow(page, "회의록").click();
  await expect(page.locator(".tab.trashed")).toHaveCount(1);
  // Another window restored it; the trash's word comes in first, the memo list's not yet.
  await page.evaluate((key) => {
    const { backend } = window.__tote;
    const { deletedMs: _deleted, ...memo } = backend.data.trash!.t;
    backend.data.memos.t = memo;
    delete backend.data.trash!.t;
    localStorage.setItem(key, JSON.stringify(backend.data));
    backend.trashChanged();
  }, FAKE_STORAGE_KEY);
  await expect(page.locator(".tab.trashed")).toHaveCount(0);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("회의록");
  await expect(editor(page)).toHaveText("옛것");
});

test("a trashed tab closed while its restore claims the place lets the place go", async ({
  page,
}) => {
  await start(page, { trash: { t: trashed("회의록.md", "옛것", 5) } });
  await trashButton(page).click();
  await trashRow(page, "회의록").click();
  await expect(page.locator(".tab.trashed")).toHaveCount(1);
  // This window's claim of the restored memo's place waits until the test lets it answer.
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const claim = backend.claimTabs.bind(backend);
    const w = window as unknown as { claimsHeld: number; letClaimsGo: () => void };
    w.claimsHeld = 0;
    let go!: () => void;
    const gate = new Promise<void>((resolve) => (go = resolve));
    w.letClaimsGo = go;
    backend.claimTabs = async (...args) => {
      w.claimsHeld++;
      await gate;
      return claim(...args);
    };
  });
  // Another window restored it.
  await page.evaluate((key) => {
    const { backend } = window.__tote;
    const { deletedMs: _deleted, ...memo } = backend.data.trash!.t;
    backend.data.memos.t = memo;
    delete backend.data.trash!.t;
    localStorage.setItem(key, JSON.stringify(backend.data));
    backend.trashChanged();
  }, FAKE_STORAGE_KEY);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { claimsHeld: number }).claimsHeld))
    .toBe(1);
  // Closed by its close mark while the claim is out.
  await page.getByRole("button", { name: "회의록 탭 닫기" }).click();
  await expect(tab(page)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { letClaimsGo: () => void }).letClaimsGo());
  // The claim came back yes for a tab no longer here: the place goes, so another window that
  // opens the memo opens it there instead of asking this window to.
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.places)).toEqual({});
  await expect(tab(page)).toHaveCount(0);
});
