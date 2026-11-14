import { expect, test, type Locator, type Page } from "@playwright/test";

import { FAKE_STORAGE_KEY, fakeFile, fakeMemo, type FakeData } from "../../src/backend/fake";
import type { WorkspaceInfo } from "../../src/backend/types";
import {
  menu,
  memoWrites,
  openWindow,
  quietErrors,
  start,
  startWindows,
  typeWhileChangedElsewhere,
  writesSettled,
} from "./helpers";

// Finder, the clipboard, a memo copied or moved to another workspace, and a workspace renamed or
// trashed from the settings (docs/superpowers/specs/2026-11-14-tote-notes-conveniences-design.md),
// on the fake backend: its call records, the memo list and the tabs.

const NOT_IN_FINDER = "파일이 없어 Finder 에서 보지 못했습니다";
const NOT_MOVED_UNSAVED = "저장하지 못해 다른 워크스페이스로 옮기지 않았습니다";
const NOT_MOVED_BANNER = "충돌·삭제 알림이 떠 있어 다른 워크스페이스로 옮기지 않았습니다";
const WRITE_FAILED = "no space left on device";
const OPEN_NOTE =
  "열린 워크스페이스는 그 창을 닫거나 다른 워크스페이스로 바꾼 뒤 이름을 바꾸거나 지울 수 있습니다.";

const info = (name: string): WorkspaceInfo => ({
  id: `workspace-${name}`,
  name,
  title: name,
  path: `/fake/${name}`,
  deviceId: "device-1",
});

const listed = (
  name: string,
  windows = 0,
  patch: Partial<FakeData["workspaces"][number]> = {},
): FakeData["workspaces"][number] => ({
  name,
  path: `/fake/${name}`,
  open: windows > 0,
  windows,
  missing: false,
  ...patch,
});

/** 업무, shown here with 회의 and 할 일; 개인 (with a 회의 of its own), 가계부 and the hidden 보관
 * shown nowhere. The switcher's order: 가계부, 업무, 개인, 보관. */
function seed(patch: Partial<FakeData> = {}): Partial<FakeData> {
  return {
    workspace: info("업무"),
    memos: {
      m: { ...fakeMemo("회의.md", "안건", { modifiedMs: 2 }), language: "markdown", pinned: true },
      t: fakeMemo("할 일.txt", "청소", { modifiedMs: 1 }),
    },
    workspaces: [
      listed("업무", 1, { order: 1 }),
      listed("개인", 0, { order: 2 }),
      listed("가계부", 0, { order: 0 }),
      listed("보관", 0, { order: 3, hidden: true }),
    ],
    otherWorkspaces: {
      "/fake/개인": {
        workspace: info("개인"),
        memos: { p: fakeMemo("회의.md", "개인 회의") },
        session: null,
      },
      "/fake/가계부": { workspace: info("가계부"), memos: {}, session: null },
      "/fake/보관": { workspace: info("보관"), memos: {}, session: null },
    },
    popupMenuPick: null,
    ...patch,
  };
}

/** The page a switch leaves still writes as it unloads, and the backend refuses that on purpose. */
async function open(page: Page, patch: Partial<FakeData> = {}): Promise<void> {
  await quietErrors(page, "is switching workspaces");
  await start(page, seed(patch));
}

const row = (page: Page, name: string) => page.locator(".memo-row", { hasText: name });
const status = (page: Page) => page.locator(".status-message");
const lastMenu = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.popupMenus?.at(-1) ?? null);
const data = (page: Page) => page.evaluate(() => window.__tote.backend.data);
const pick = (page: Page, id: string | null) =>
  page.evaluate((id) => (window.__tote.backend.data.popupMenuPick = id), id);
/** The memos of workspace `name` among the fake's other workspaces, by file: their text. */
const memosOf = (page: Page, name: string) =>
  page.evaluate((path) => {
    const memos = window.__tote.backend.data.otherWorkspaces?.[path]?.memos ?? {};
    return Object.fromEntries(
      Object.values(memos).map((memo) => [
        memo.file,
        new TextDecoder().decode(Uint8Array.from(atob(memo.data), (c) => c.charCodeAt(0))),
      ]),
    );
  }, `/fake/${name}`);

test("a memo row's menu offers a copy, a move to each other shown workspace, Finder and the path", async ({
  page,
}) => {
  await open(page);
  await row(page, "회의").click({ button: "right" });
  await expect.poll(() => lastMenu(page)).not.toBeNull();
  const items = (await lastMenu(page))!;
  expect(items.map((item) => (item.separator ? "─" : item.text))).toEqual([
    "이름 바꾸기…",
    "고정 해제",
    "복제",
    "다른 워크스페이스로 옮기기",
    "─",
    "Finder 에서 보기",
    "경로 복사",
    "─",
    "휴지통으로 이동",
  ]);
  // The switcher's order, this workspace and the hidden one left out.
  expect(items[3].items!.map((item) => [item.text, item.id])).toEqual([
    ["가계부", "move-to:/fake/가계부"],
    ["개인", "move-to:/fake/개인"],
  ]);
  // Nothing was picked: nothing happened.
  await expect(page.locator(".memo-row")).toHaveCount(2);
  expect((await data(page)).revealedFiles).toBeUndefined();
});

test("with nowhere to move to, the row's menu has no move", async ({ page }) => {
  await open(page, {
    workspaces: [listed("업무", 1), listed("보관", 0, { hidden: true })],
  });
  await row(page, "회의").click({ button: "right" });
  await expect.poll(() => lastMenu(page)).not.toBeNull();
  expect((await lastMenu(page))!.some((item) => item.items)).toBe(false);
});

test("Finder shows the memo's file, and the path goes to the clipboard", async ({ page }) => {
  await open(page, { popupMenuPick: "reveal-in-finder" });
  await row(page, "회의").click({ button: "right" });
  await expect.poll(async () => (await data(page)).revealedFiles).toEqual(["/fake/업무/회의.md"]);
  await pick(page, "copy-path");
  await row(page, "할 일").click({ button: "right" });
  await expect(status(page)).toHaveText("경로를 복사했습니다");
  expect((await data(page)).copiedPaths).toEqual(["/fake/업무/할 일.txt"]);
});

test("a tab's menu shows its file; an external file that is not there says so", async ({
  page,
}) => {
  await open(page, { files: { "/x/a.sh": fakeFile("echo") } });
  await row(page, "회의").click();
  await page.evaluate(() => (window.__tote.backend.data.popupMenuPick = "copy-path"));
  await page.locator(".tab", { hasText: "회의" }).click({ button: "right" });
  await expect(status(page)).toHaveText("경로를 복사했습니다");
  expect((await data(page)).copiedPaths).toEqual(["/fake/업무/회의.md"]);
  // The memo tab's menu: its splits, its move to a new window, then its copy and its file.
  expect((await lastMenu(page))!.slice(-4).map((item) => item.id)).toEqual([
    "",
    "duplicate",
    "reveal-in-finder",
    "copy-path",
  ]);

  await page.evaluate(() => window.__tote.app.openExternal("/x/a.sh"));
  await expect(page.locator(".tab.active")).toHaveClass(/external/);
  await pick(page, "reveal-in-finder");
  await page.locator(".tab.active").click({ button: "right" });
  await expect.poll(async () => (await data(page)).revealedFiles).toEqual(["/x/a.sh"]);
  // An external tab is not copied.
  expect((await lastMenu(page))!.some((item) => item.id === "duplicate")).toBe(false);

  await page.evaluate(() => window.__tote.app.openExternal("/x/없음.sh"));
  await expect(page.locator(".tab.active")).toContainText("없음");
  await page.locator(".tab.active").click({ button: "right" });
  await expect(status(page)).toHaveText(NOT_IN_FINDER);
  expect((await data(page)).revealedFiles).toEqual(["/x/a.sh"]);
});

test("a trashed row shows its file in the trash", async ({ page }) => {
  await open(page, {
    trash: { gone: { ...fakeMemo("옛것.md", "x"), deletedMs: 5 } },
    popupMenuPick: "reveal-in-finder",
  });
  await page.getByRole("button", { name: "휴지통", exact: true }).click();
  await page.locator(".trash-row", { hasText: "옛것" }).click({ button: "right" });
  await expect
    .poll(async () => (await data(page)).revealedFiles)
    .toEqual(["/fake/업무/.trash/gone/옛것.md"]);
  expect((await lastMenu(page))!.map((item) => item.text)).toEqual([
    "복구",
    "Finder 에서 보기",
    "",
    "영구 삭제",
  ]);
});

test("a copy takes the next number, the language and not the pin, and is not opened", async ({
  page,
}) => {
  await open(page, { popupMenuPick: "duplicate" });
  await row(page, "회의").click({ button: "right" });
  await expect(row(page, "회의 2")).toHaveCount(1);
  await expect(status(page)).toHaveText("복제했습니다: 회의 2.md");
  await expect(page.locator(".tab")).toHaveCount(0);
  const copy = Object.values((await data(page)).memos).find((memo) => memo.file === "회의 2.md")!;
  expect(copy).toMatchObject({ autoTitle: false, language: "markdown" });
  expect(copy.pinned).toBeUndefined();
  expect(await page.evaluate(() => window.__tote.backend.memoTextByFile("회의 2.md"))).toBe("안건");
  // The original's row stays pinned, the copy's is not.
  await expect(page.locator(".memo-pinned .memo-row .memo-name")).toHaveText(["회의"]);
  expect((await data(page)).duplicateCalls).toEqual([{ id: "m", withText: false }]);
});

test("a copy of an open memo holds the text as typed, before its save", async ({ page }) => {
  await open(page);
  await row(page, "할 일").click();
  await expect(page.locator(".cm-content")).toHaveText("청소");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 빨래");
  // At once, before the save's timer.
  await pick(page, "duplicate");
  await page.locator(".tab", { hasText: "할 일" }).click({ button: "right" });
  await expect(row(page, "할 일 2")).toHaveCount(1);
  expect(await page.evaluate(() => window.__tote.backend.memoTextByFile("할 일 2.txt"))).toBe(
    "청소 빨래",
  );
  expect((await data(page)).duplicateCalls).toEqual([{ id: "t", withText: true }]);
  // The tab stays on the original.
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".tab.active")).toContainText("할 일");
});

test("a memo moves to another workspace under a free name, and the switch finds it there", async ({
  page,
}) => {
  await open(page, { popupMenuPick: "move-to:/fake/개인" });
  await row(page, "회의").click({ button: "right" });
  await expect(row(page, "회의")).toHaveCount(0);
  await expect(status(page)).toHaveText("개인으로 옮겼습니다");
  // 개인 has a 회의.md of its own: the moved one is 회의 2.md, under a new ID, pin and language
  // with it.
  expect(await memosOf(page, "개인")).toEqual({ "회의.md": "개인 회의", "회의 2.md": "안건" });
  const moved = await page.evaluate(() =>
    Object.entries(window.__tote.backend.data.otherWorkspaces!["/fake/개인"].memos).find(
      ([, memo]) => memo.file === "회의 2.md",
    ),
  );
  expect(moved![0]).not.toBe("m");
  expect(moved![1]).toMatchObject({ autoTitle: false, language: "markdown", pinned: true });
  expect(Object.keys((await data(page)).memos)).toEqual(["t"]);

  await pick(page, null);
  await page.locator(".ws-switcher-button").click();
  await page.locator(".ws-switcher-item", { hasText: "개인" }).click();
  await expect(page).toHaveTitle("개인");
  await expect(row(page, "회의 2")).toHaveCount(1);
});

test("an open memo is saved and its tab closed before it moves", async ({ page }) => {
  await open(page);
  await row(page, "할 일").click();
  await expect(page.locator(".cm-content")).toHaveText("청소");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 빨래");
  await pick(page, "move-to:/fake/가계부");
  await row(page, "할 일").click({ button: "right" });
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect(row(page, "할 일")).toHaveCount(0);
  await expect(status(page)).toHaveText("가계부로 옮겼습니다");
  expect(await memosOf(page, "가계부")).toEqual({ "할 일.txt": "청소 빨래" });
  expect((await data(page)).places).toEqual({});
});

test("a memo whose save failed does not move", async ({ page }) => {
  await quietErrors(page, WRITE_FAILED);
  await open(page, { failWrites: 1000 });
  await row(page, "할 일").click();
  await expect(page.locator(".cm-content")).toHaveText("청소");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 빨래");
  await pick(page, "move-to:/fake/가계부");
  await row(page, "할 일").click({ button: "right" });
  await expect(status(page)).toHaveText(NOT_MOVED_UNSAVED);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".cm-content")).toHaveText("청소 빨래");
  await expect(row(page, "할 일")).toHaveCount(1);
  expect(await memosOf(page, "가계부")).toEqual({});
});

test("a memo whose tab asks about a change elsewhere stays, unsaved over that change", async ({
  page,
}) => {
  // 장보기 (우유) typed into while another app wrote 두유: the conflict banner is up.
  await typeWhileChangedElsewhere(page);
  await expect(page.locator(".banner")).toBeVisible();
  await writesSettled(page);
  const writes = await memoWrites(page, "a");
  const { workspaces, otherWorkspaces } = seed();
  await page.evaluate((patch) => Object.assign(window.__tote.backend.data, patch), {
    workspaces,
    otherWorkspaces,
    popupMenuPick: "move-to:/fake/가계부",
  });
  await row(page, "장보기").click({ button: "right" });
  await expect(status(page)).toHaveText(NOT_MOVED_BANNER);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".banner")).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
  expect(await memosOf(page, "가계부")).toEqual({});
  // The banner is the person's to answer: the move did not try a save of its own.
  await writesSettled(page);
  expect(await memoWrites(page, "a")).toBe(writes);
});

test("a memo open in another window is saved and closed there, then moved", async ({ context }) => {
  const first = await startWindows(context, seed());
  await row(first, "할 일").click();
  await expect(first.locator(".cm-content")).toHaveText("청소");
  // As in the trash's test of the same: the second window opens before the typing, and the held
  // clock keeps the first window's save until it is asked.
  const second = await openWindow(context, "ws-2");
  await first.clock.install();
  await first.clock.pauseAt(Date.now() + 60_000);
  await first.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await first.keyboard.insertText(" 빨래");
  await second.evaluate(
    ([id, key]) => {
      const { backend } = window.__tote;
      backend.data.popupMenuPick = id;
      localStorage.setItem(key, JSON.stringify(backend.data));
    },
    ["move-to:/fake/가계부", FAKE_STORAGE_KEY] as const,
  );
  await row(second, "할 일").click({ button: "right" });
  await expect(first.locator(".tab")).toHaveCount(0);
  await expect(row(first, "할 일")).toHaveCount(0);
  await expect(first.locator(".status-message")).toHaveText("가계부로 옮겼습니다");
  expect(await memosOf(first, "가계부")).toEqual({ "할 일.txt": "청소 빨래" });
  expect(await second.evaluate(() => window.__tote.backend.data.moveRequests)).toEqual([
    { label: "ws-1", id: "t", workspace: "/fake/가계부" },
  ]);
  await expect.poll(() => memosOf(second, "가계부")).toEqual({ "할 일.txt": "청소 빨래" });
  await first.clock.runFor(300);
  await expect(row(second, "할 일")).toHaveCount(0);
});

// The settings screen's 워크스페이스 section.

async function openSection(page: Page): Promise<Locator> {
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.getByRole("tab", { name: "워크스페이스", exact: true }).click();
  await expect(panel.locator(".ws-order-list")).toBeVisible();
  return panel;
}

const settingsRow = (panel: Locator, name: string) =>
  panel.locator("li.ws-order-row", {
    has: panel.page().locator(".ws-order-name", { hasText: name }),
  });

test("an open workspace's buttons are off and say why", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  const own = settingsRow(panel, "업무");
  await expect(own.locator(".ws-order-open")).toHaveText("열림");
  await expect(own.getByRole("button", { name: "업무 이름 바꾸기" })).toBeDisabled();
  await expect(own.getByRole("button", { name: "업무 휴지통으로 이동" })).toBeDisabled();
  await expect(own.getByRole("button", { name: "업무 이름 바꾸기" })).toHaveAttribute(
    "title",
    OPEN_NOTE,
  );
  await expect(panel.locator(".ws-order-open-note")).toHaveText(OPEN_NOTE);
  await expect(
    settingsRow(panel, "개인").getByRole("button", { name: "개인 이름 바꾸기" }),
  ).toBeEnabled();
});

test("a closed workspace is renamed, and the switcher follows", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  await settingsRow(panel, "개인").getByRole("button", { name: "개인 이름 바꾸기" }).click();
  const prompt = page.locator(".modal").last();
  await expect(prompt.locator("input")).toHaveValue("개인");
  await prompt.locator("input").fill("집");
  await prompt.locator("input").press("Enter");
  await expect(settingsRow(panel, "집")).toHaveCount(1);
  await expect(settingsRow(panel, "개인")).toHaveCount(0);
  await expect(panel.locator(".modal-error")).toHaveText("");
  const workspaces = (await data(page)).workspaces;
  expect(workspaces.find((w) => w.name === "집")).toMatchObject({ path: "/fake/집", order: 2 });
  await page.keyboard.press("Escape");
  await page.locator(".ws-switcher-button").click();
  await expect(page.locator(".ws-switcher-item .ws-switcher-label")).toHaveText([
    "가계부",
    "업무",
    "집",
  ]);
});

test("a name another workspace has is refused and said", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  await settingsRow(panel, "개인").getByRole("button", { name: "개인 이름 바꾸기" }).click();
  const prompt = page.locator(".modal").last();
  await prompt.locator("input").fill("가계부");
  await prompt.locator("input").press("Enter");
  await expect(panel.locator(".modal-error")).toHaveText("같은 이름이 이미 있습니다");
  await expect(settingsRow(panel, "개인")).toHaveCount(1);
});

test("a workspace goes to the trash after the question names its memos", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  await settingsRow(panel, "개인").getByRole("button", { name: "개인 휴지통으로 이동" }).click();
  const question = page.locator(".modal.confirm");
  await expect(question.locator("p")).toHaveText(
    "「개인」 워크스페이스를 휴지통으로 옮길까요? 메모 1개가 함께 옮겨집니다.",
  );
  await question.getByRole("button", { name: "취소" }).click();
  await expect(settingsRow(panel, "개인")).toHaveCount(1);
  expect((await data(page)).trashedWorkspaces).toBeUndefined();

  await settingsRow(panel, "개인").getByRole("button", { name: "개인 휴지통으로 이동" }).click();
  await question.getByRole("button", { name: "휴지통으로 이동" }).click();
  await expect(settingsRow(panel, "개인")).toHaveCount(0);
  expect((await data(page)).trashedWorkspaces).toEqual(["/fake/개인"]);
});

test("a workspace opened in another window meanwhile is refused and said", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  // Another window shows it since the section was drawn.
  await page.evaluate(() => {
    const listed = window.__tote.backend.data.workspaces.find((w) => w.name === "개인")!;
    Object.assign(listed, { open: true, windows: 1 });
  });
  await settingsRow(panel, "개인").getByRole("button", { name: "개인 이름 바꾸기" }).click();
  const prompt = page.locator(".modal").last();
  await prompt.locator("input").fill("집");
  await prompt.locator("input").press("Enter");
  await expect(panel.locator(".modal-error")).toHaveText(
    "열린 창을 닫거나 다른 워크스페이스로 바꾼 뒤 바꿀 수 있습니다",
  );
  // Read again, the row says it is open now.
  await expect(settingsRow(panel, "개인").locator(".ws-order-open")).toHaveText("열림");
});
