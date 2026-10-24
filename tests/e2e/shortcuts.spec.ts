import { expect, test, type Locator, type Page } from "@playwright/test";

import { defaultFakeData, type FakeData } from "../../src/backend/fake";
import type { SettingsPatch } from "../../src/backend/types";
import { menu, nextWindow, start, startWindows } from "./helpers";

type Patches = { patches: SettingsPatch[] };

/** Keeps every `patchSettings` the page sends, in `window.patches`. */
async function trackPatches(page: Page): Promise<void> {
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const patchSettings = backend.patchSettings.bind(backend);
    (window as unknown as Patches).patches = [];
    backend.patchSettings = (change) => {
      (window as unknown as Patches).patches.push(change);
      return patchSettings(change);
    };
  });
}

const patches = (page: Page) =>
  page.evaluate(() => (window as unknown as Patches).patches.filter((p) => "shortcuts" in p));
const savedMap = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.settings.shortcuts ?? {});
const suspendCalls = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.suspendShortcutCalls ?? []);

/** Opens the settings screen on its 단축키 section. */
async function openShortcuts(page: Page): Promise<Locator> {
  await menu(page, "settings");
  await page.locator(".modal.settings").getByRole("tab", { name: "단축키", exact: true }).click();
  const panel = page.locator("#settings-panel-shortcuts");
  await expect(panel.locator(".shortcut-row")).not.toHaveCount(0);
  return panel;
}

async function startShortcuts(page: Page, seed: Partial<FakeData> = {}): Promise<Locator> {
  await start(page, seed);
  await trackPatches(page);
  return openShortcuts(page);
}

const row = (panel: Locator, id: string) => panel.locator(`.shortcut-row[data-command="${id}"]`);
const keys = (panel: Locator, id: string) => row(panel, id).locator(".shortcut-keys");

/** Clicks the row's shortcut and waits for it to listen. */
async function record(panel: Locator, id: string): Promise<void> {
  await keys(panel, id).click();
  await expect(keys(panel, id)).toHaveText("키를 누르세요");
}

test("recording a new shortcut saves it and the menu table follows", async ({ page }) => {
  const panel = await startShortcuts(page);
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  await expect(row(panel, "new-memo")).toContainText("새 메모");
  await expect(row(panel, "new-memo")).toContainText("파일");
  await expect(
    row(panel, "new-memo").getByRole("button", { name: "되돌리기", exact: true }),
  ).toHaveCount(0);

  await record(panel, "new-memo");
  await expect.poll(() => suspendCalls(page)).toEqual([true]);
  await page.keyboard.press("Meta+Shift+M");
  await expect.poll(() => savedMap(page)).toEqual({ "new-memo": "CmdOrCtrl+Shift+M" });
  expect(await suspendCalls(page)).toEqual([true, false]);
  await expect(keys(panel, "new-memo")).toHaveText("⇧⌘M");
  await expect(
    row(panel, "new-memo").getByRole("button", { name: "되돌리기", exact: true }),
  ).toBeVisible();
  // The table the menu and the pane hints read has it too.
  const table = await page.evaluate(() => window.__tote.backend.shortcutTable());
  expect(table.commands.find((c) => c.id === "new-memo")?.current).toBe("CmdOrCtrl+Shift+M");
  expect(await patches(page)).toEqual([
    { shortcuts: { "new-memo": "CmdOrCtrl+Shift+M" }, shortcutsExpected: {} },
  ]);
});

test("Backspace clears a shortcut and 되돌리기 brings the default back", async ({ page }) => {
  const panel = await startShortcuts(page);
  await record(panel, "save");
  await page.keyboard.press("Backspace");
  await expect.poll(() => savedMap(page)).toEqual({ save: null });
  await expect(keys(panel, "save")).toHaveText("없음");
  expect(await suspendCalls(page)).toEqual([true, false]);

  await row(panel, "save").getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(() => savedMap(page)).toEqual({});
  await expect(keys(panel, "save")).toHaveText("⌘S");
  await expect(
    row(panel, "save").getByRole("button", { name: "되돌리기", exact: true }),
  ).toHaveCount(0);
});

test("a key another command uses offers 바꾸기 and swaps them in one save", async ({ page }) => {
  const panel = await startShortcuts(page);
  await expect(keys(panel, "rename")).toHaveText("없음");
  await record(panel, "rename");
  await page.keyboard.press("Meta+N");
  await expect(row(panel, "rename").locator(".shortcut-note")).toHaveText(
    /새 메모 에 이미 쓰고 있습니다/,
  );
  // Nothing is saved until 바꾸기, and the shortcuts are back already.
  expect(await patches(page)).toEqual([]);
  expect(await suspendCalls(page)).toEqual([true, false]);
  await expect(keys(panel, "rename")).toHaveText("없음");

  await row(panel, "rename").getByRole("button", { name: "바꾸기", exact: true }).click();
  await expect.poll(() => savedMap(page)).toEqual({ "new-memo": null, rename: "CmdOrCtrl+N" });
  expect(await patches(page)).toEqual([
    { shortcuts: { "new-memo": null, rename: "CmdOrCtrl+N" }, shortcutsExpected: {} },
  ]);
  await expect(keys(panel, "rename")).toHaveText("⌘N");
  await expect(keys(panel, "new-memo")).toHaveText("없음");
  await expect(row(panel, "rename").locator(".shortcut-note")).toHaveCount(0);
});

test("resetting a key another command took on the way offers 바꾸기 like recording does", async ({
  page,
}) => {
  const panel = await startShortcuts(page, {
    settings: {
      ...defaultFakeData().settings,
      shortcuts: { "new-memo": null, rename: "CmdOrCtrl+N" },
    },
  });
  await row(panel, "new-memo").getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(row(panel, "new-memo").locator(".shortcut-note")).toHaveText(
    /이름 바꾸기… 에 이미 쓰고 있습니다/,
  );
  expect(await patches(page)).toEqual([]);
  await row(panel, "new-memo").getByRole("button", { name: "바꾸기", exact: true }).click();
  await expect.poll(() => savedMap(page)).toEqual({});
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  await expect(keys(panel, "rename")).toHaveText("없음");
});

test("swapping back a default leaves it out of the map", async ({ page }) => {
  const panel = await startShortcuts(page, {
    settings: {
      ...defaultFakeData().settings,
      shortcuts: { "new-memo": null, rename: "CmdOrCtrl+N" },
    },
  });
  await record(panel, "new-memo");
  await page.keyboard.press("Meta+N");
  await row(panel, "new-memo").getByRole("button", { name: "바꾸기", exact: true }).click();
  // 새 메모 is on its default again; only 이름 바꾸기's none is saved.
  await expect.poll(() => savedMap(page)).toEqual({});
  expect(await patches(page)).toEqual([
    { shortcuts: {}, shortcutsExpected: { "new-memo": null, rename: "CmdOrCtrl+N" } },
  ]);
});

test("⌘Q is fixed and recording it is refused", async ({ page }) => {
  const panel = await startShortcuts(page);
  await expect(panel.locator(".shortcut-fixed-row").filter({ hasText: "tote 종료" })).toContainText(
    "⌘Q",
  );
  await expect(row(panel, "quit")).toHaveCount(0);
  await record(panel, "new-memo");
  await page.keyboard.press("Meta+Q");
  await expect(row(panel, "new-memo").locator(".shortcut-note")).toHaveText(
    "tote 종료 에 고정된 단축키입니다",
  );
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  expect(await patches(page)).toEqual([]);
});

test("a fixed key is refused", async ({ page }) => {
  const panel = await startShortcuts(page);
  await record(panel, "new-memo");
  await page.keyboard.press("Meta+C");
  await expect(row(panel, "new-memo").locator(".shortcut-note")).toHaveText(
    "복사하기 에 고정된 단축키입니다",
  );
  await expect(
    row(panel, "new-memo").getByRole("button", { name: "바꾸기", exact: true }),
  ).toHaveCount(0);
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  expect(await patches(page)).toEqual([]);
  expect(await suspendCalls(page)).toEqual([true, false]);
});

test("an editor key is saved with a warning", async ({ page }) => {
  const panel = await startShortcuts(page);
  // The save answers after the change is heard, as the native side may: the table is read before
  // the save returns.
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const patchSettings = backend.patchSettings.bind(backend);
    backend.patchSettings = async (change) => {
      await patchSettings(change);
      await new Promise((done) => setTimeout(done, 100));
    };
  });
  await record(panel, "rename");
  await page.keyboard.press("Meta+L");
  await expect.poll(() => savedMap(page)).toEqual({ rename: "CmdOrCtrl+L" });
  await expect(keys(panel, "rename")).toHaveText("⌘L");
  const warning = row(panel, "rename").locator(".shortcut-note");
  await expect(warning).toHaveText("편집기의 selectLine 을 가립니다");
  // Read out, being news; the warnings of the rows not touched are not.
  await expect(warning).toHaveAttribute("role", "status");
  await expect(row(panel, "split-pane-down").locator(".shortcut-note")).not.toHaveAttribute(
    "role",
    "status",
  );
});

test("an editor key made by a function without a name is still named after its export", async ({
  page,
}) => {
  const panel = await startShortcuts(page);
  // ⇧⌘U is `redoSelection`, which CodeMirror makes with a function that has no name of its own.
  await record(panel, "rename");
  await page.keyboard.press("Meta+Shift+U");
  await expect.poll(() => savedMap(page)).toEqual({ rename: "CmdOrCtrl+Shift+U" });
  await expect(row(panel, "rename").locator(".shortcut-note")).toHaveText(
    "편집기의 redoSelection 을 가립니다",
  );
});

test("letters without a modifier are not recorded and Esc cancels", async ({ page }) => {
  const panel = await startShortcuts(page);
  await record(panel, "new-memo");
  await page.keyboard.press("N");
  await page.keyboard.press("Shift+N");
  await expect(keys(panel, "new-memo")).toHaveText("키를 누르세요");
  await page.keyboard.press("Escape");
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  // The first Esc ends the recording only: the screen is still open.
  await expect(page.locator(".modal.settings")).toBeVisible();
  expect(await patches(page)).toEqual([]);
  expect(await suspendCalls(page)).toEqual([true, false]);
});

test("the keys pressed while recording reach nothing else", async ({ page }) => {
  const panel = await startShortcuts(page);
  const heard: string[] = [];
  await page.exposeFunction("heardKey", (key: string) => heard.push(key));
  await page.evaluate(() =>
    document.addEventListener(
      "keydown",
      (event) => (window as unknown as { heardKey: (k: string) => void }).heardKey(event.key),
      true,
    ),
  );
  await record(panel, "new-memo");
  // Not taken (a letter alone, ⇧ alone, Tab) or taken (⌃1, refused as a fixed key): none goes on.
  await page.keyboard.press("N");
  await page.keyboard.press("Shift");
  await page.keyboard.press("Tab");
  await expect(keys(panel, "new-memo")).toHaveText("키를 누르세요");
  await page.keyboard.press("Control+1");
  await expect(row(panel, "new-memo").locator(".shortcut-note")).toHaveText(
    "워크스페이스 1 에 고정된 단축키입니다",
  );
  expect(heard).toEqual([]);
  // Not recording, the keys go where they always went.
  await page.keyboard.press("Shift");
  await expect.poll(() => heard).toEqual(["Shift"]);
});

// The screen has no way to close or change section while a row records that does not end the
// recording first: Esc is the recording's (the first one cancels it), and 닫기 or a tab is clicked
// outside the row (its pointerdown cancels it). This test goes those ways.
test("recording ends and shortcuts resume before the dialog closes or the section changes, and when the window loses focus", async ({
  page,
}) => {
  let panel = await startShortcuts(page);
  await record(panel, "new-memo");
  // The first Esc ends the recording, the second closes the screen.
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal.settings")).toBeVisible();
  expect(await suspendCalls(page)).toEqual([true, false]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal.settings")).toHaveCount(0);
  expect(await suspendCalls(page)).toEqual([true, false]);

  panel = await openShortcuts(page);
  await record(panel, "new-memo");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  expect(await suspendCalls(page)).toEqual([true, false, true, false]);

  // A click outside, another row, another section and 닫기 each end it once, on the pointerdown.
  await record(panel, "new-memo");
  await page.locator(".modal.settings h1").click();
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  await record(panel, "new-memo");
  await record(panel, "save");
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  await page.locator(".modal.settings").getByRole("tab", { name: "일반", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.locator(".modal.settings").getByRole("tab", { name: "단축키", exact: true }).click();
  await expect(keys(panel, "save")).toHaveText("⌘S");
  await record(panel, "save");
  await page.locator(".modal.settings").getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator(".modal.settings")).toHaveCount(0);
  expect(await suspendCalls(page)).toEqual([
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
  ]);
  expect(await patches(page)).toEqual([]);
});

test("recording ends when the page goes away", async ({ page }) => {
  const panel = await startShortcuts(page);
  await record(panel, "new-memo");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  expect(await suspendCalls(page)).toEqual([true, false]);
});

test("recording ends when the focus goes to an input outside the row, which then gets the keys", async ({
  page,
}) => {
  const panel = await startShortcuts(page);
  await record(panel, "new-memo");
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "elsewhere";
    document.body.append(input);
    input.focus();
  });
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  expect(await suspendCalls(page)).toEqual([true, false]);
  await page.keyboard.type("abc");
  await expect(page.locator("#elsewhere")).toHaveValue("abc");
  expect(await suspendCalls(page)).toEqual([true, false]);
});

test("모두 기본값으로 asks first and clears the map", async ({ page }) => {
  const panel = await startShortcuts(page, {
    settings: {
      ...defaultFakeData().settings,
      shortcuts: { "new-memo": "CmdOrCtrl+Shift+M", save: null },
    },
  });
  await expect(keys(panel, "new-memo")).toHaveText("⇧⌘M");
  await panel.getByRole("button", { name: "모두 기본값으로", exact: true }).click();
  const ask = page.locator(".modal.confirm");
  await expect(ask).toContainText("모든 단축키를 기본값으로 되돌릴까요?");
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  expect(await patches(page)).toEqual([]);

  await panel.getByRole("button", { name: "모두 기본값으로", exact: true }).click();
  await ask.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(() => savedMap(page)).toEqual({});
  expect(await patches(page)).toEqual([
    { shortcuts: {}, shortcutsExpected: { "new-memo": "CmdOrCtrl+Shift+M", save: null } },
  ]);
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  await expect(keys(panel, "save")).toHaveText("⌘S");
  await expect(panel.getByRole("button", { name: "모두 기본값으로", exact: true })).toBeDisabled();
});

test("the search filters by name and by shortcut", async ({ page }) => {
  const panel = await startShortcuts(page);
  const search = panel.getByPlaceholder("명령 검색");
  await search.fill("나누기");
  await expect(panel.locator(".shortcut-row:visible .shortcut-name")).toHaveText([
    "오른쪽으로 나누기",
    "아래로 나누기",
  ]);
  await search.fill("⌘N");
  await expect(panel.locator(".shortcut-row:visible .shortcut-name")).toHaveText(["새 메모"]);
  await search.fill("");
  await expect(panel.locator(".shortcut-row:visible")).toHaveCount(24);
});

test("the fixed group lists the fixed keys and cannot be edited", async ({ page }) => {
  const panel = await startShortcuts(page);
  const fixed = panel.locator(".shortcut-fixed");
  await expect(fixed.getByRole("heading")).toHaveText("고정");
  const rows = fixed.locator(".shortcut-fixed-row");
  await expect(rows).toHaveCount(21);
  await expect(rows.first()).toHaveText(/설정….*⌘,/);
  await expect(rows.nth(1)).toHaveText(/tote 종료.*⌘Q/);
  await expect(rows.filter({ hasText: "복사하기" })).toContainText("⌘C");
  await expect(rows.filter({ hasText: "워크스페이스 1" })).toContainText("⌃1");
  await expect(rows.filter({ hasText: "전체 화면" })).toContainText("⌃⌘F");
  await expect(fixed.locator("button, input")).toHaveCount(0);
  await rows.filter({ hasText: "복사하기" }).click();
  expect(await suspendCalls(page)).toEqual([]);
});

test("a save that fails says so under the row and the same key can be tried again", async ({
  page,
}) => {
  const panel = await startShortcuts(page);
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const patchSettings = backend.patchSettings.bind(backend);
    let failures = 1;
    backend.patchSettings = (change) =>
      failures-- > 0 ? Promise.reject(new Error("디스크가 가득 찼습니다")) : patchSettings(change);
  });
  await record(panel, "new-memo");
  await page.keyboard.press("Meta+Shift+M");
  await expect(row(panel, "new-memo").locator(".shortcut-note")).toHaveText(
    "오류: 디스크가 가득 찼습니다",
  );
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  expect(await savedMap(page)).toEqual({});

  await record(panel, "new-memo");
  await page.keyboard.press("Meta+Shift+M");
  await expect.poll(() => savedMap(page)).toEqual({ "new-memo": "CmdOrCtrl+Shift+M" });
  await expect(keys(panel, "new-memo")).toHaveText("⇧⌘M");
  await expect(row(panel, "new-memo").locator(".shortcut-note")).toHaveCount(0);
});

test("a shortcut change from another window reloads the table and ends a recording, another setting does not", async ({
  context,
}) => {
  const first = await startWindows(context);
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  const panel = await openShortcuts(first);
  await record(panel, "new-memo");
  // A setting other than the shortcuts leaves the recording on.
  await second.evaluate(() =>
    window.__tote.backend.patchSettings({
      themeDark: { extension: "tote.themes", label: "Light+" },
    }),
  );
  await expect(first.locator(".modal.settings select[name=dark]")).toHaveValue(
    JSON.stringify(["tote.themes", "Light+"]),
  );
  await first.evaluate(() => window.__tote.backend.shortcutTable());
  await expect(keys(panel, "new-memo")).toHaveText("키를 누르세요");
  expect(await suspendCalls(first)).toEqual([true]);
  await second.evaluate(() =>
    window.__tote.backend.patchSettings({ shortcuts: { save: "CmdOrCtrl+Shift+S" } }),
  );
  await expect(keys(panel, "save")).toHaveText("⇧⌘S");
  await expect(keys(panel, "new-memo")).toHaveText("⌘N");
  expect(await suspendCalls(first)).toEqual([true, false]);
});

test("모두 기본값으로 that fails says so and keeps the shortcuts", async ({ page }) => {
  const panel = await startShortcuts(page, {
    settings: { ...defaultFakeData().settings, shortcuts: { "new-memo": "CmdOrCtrl+Shift+M" } },
  });
  await page.evaluate(() => {
    window.__tote.backend.patchSettings = () => Promise.reject(new Error("디스크가 가득 찼습니다"));
  });
  await panel.getByRole("button", { name: "모두 기본값으로", exact: true }).click();
  await page.locator(".modal.confirm").getByRole("button", { name: "되돌리기" }).click();
  await expect(panel.locator(".shortcut-problem")).toHaveText("오류: 디스크가 가득 찼습니다");
  await expect(keys(panel, "new-memo")).toHaveText("⇧⌘M");
  expect(await savedMap(page)).toEqual({ "new-memo": "CmdOrCtrl+Shift+M" });
});

test("a row puts its name, shortcut, default and 되돌리기 on one line, in columns", async ({
  page,
}) => {
  const panel = await startShortcuts(page, {
    settings: { ...defaultFakeData().settings, shortcuts: { "new-memo": "CmdOrCtrl+Shift+M" } },
  });
  const box = async (locator: Locator) => (await locator.boundingBox())!;
  const changed = row(panel, "new-memo");
  const name = await box(changed.locator(".shortcut-name"));
  const menuName = await box(changed.locator(".shortcut-menu"));
  const shortcut = await box(keys(panel, "new-memo"));
  const reset = await box(changed.getByRole("button", { name: "되돌리기", exact: true }));
  const middle = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(middle(reset) - middle(name))).toBeLessThanOrEqual(4);
  expect(reset.x).toBeGreaterThan(name.x + name.width);
  // Name first, its menu after it; then the shortcut, the default, and 되돌리기 last.
  expect(menuName.x).toBeGreaterThan(name.x);
  expect(shortcut.x).toBeGreaterThan(menuName.x + menuName.width);
  expect(reset.x).toBeGreaterThan(shortcut.x + shortcut.width);
  // A row without 되돌리기 has its shortcut in the same column.
  const plain = await box(keys(panel, "save"));
  expect(plain.x).toBeCloseTo(shortcut.x, 0);
  expect(plain.width).toBeCloseTo(shortcut.width, 0);
});

test("a shortcut saved from a stale table is refused and the other window's change stays", async ({
  context,
}) => {
  const first = await startWindows(context);
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  const panel = await openShortcuts(second);
  // Window 2 never hears of window 1's save: its table stays the old one.
  await second.evaluate(() => {
    const backend = window.__tote.backend;
    backend.shortcutTable = () => new Promise(() => {});
  });
  await first.evaluate(() =>
    window.__tote.backend.patchSettings({ shortcuts: { "new-memo": "CmdOrCtrl+Shift+M" } }),
  );
  await expect.poll(() => savedMap(first)).toEqual({ "new-memo": "CmdOrCtrl+Shift+M" });
  await second.evaluate(() => {
    delete (window.__tote.backend as { shortcutTable?: unknown }).shortcutTable;
  });

  await record(panel, "save");
  await second.keyboard.press("Meta+Shift+K");
  await expect(row(panel, "save").locator(".shortcut-note")).toHaveText(
    "다른 창에서 단축키가 바뀌어 다시 읽었습니다. 다시 해 주세요",
  );
  expect(await savedMap(first)).toEqual({ "new-memo": "CmdOrCtrl+Shift+M" });
  await expect(keys(panel, "new-memo")).toHaveText("⇧⌘M");

  await record(panel, "save");
  await second.keyboard.press("Meta+Shift+K");
  await expect
    .poll(() => savedMap(first))
    .toEqual({ "new-memo": "CmdOrCtrl+Shift+M", save: "CmdOrCtrl+Shift+K" });
});

test("the stale note stays when a read that began later ends after the refusal", async ({
  context,
}) => {
  const first = await startWindows(context);
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  const panel = await openShortcuts(second);
  // The first four reads window 2 starts wait until the test lets them end.
  await second.evaluate(async () => {
    const backend = window.__tote.backend;
    const real = backend.shortcutTable.bind(backend);
    const old = await real();
    const gates: Array<() => void> = [];
    (window as unknown as { __gates: typeof gates }).__gates = gates;
    // The refusal's read (1) answers at once with the old table, so its continuation has run
    // before the test lets the next one end.
    backend.shortcutTable = () =>
      new Promise((resolve, reject) => {
        const at = gates.length;
        const end = () => (at === 1 ? resolve(old) : void real().then(resolve, reject));
        gates.push(end);
        // Only the first four are held; a read after them ends as it begins.
        if (at > 3) end();
      });
  });
  const waiting = () =>
    second.evaluate(() => (window as unknown as { __gates: unknown[] }).__gates.length);
  const open = (at: number) =>
    second.evaluate((n) => (window as unknown as { __gates: Array<() => void> }).__gates[n](), at);
  await first.evaluate(() =>
    window.__tote.backend.patchSettings({ shortcuts: { "new-memo": "CmdOrCtrl+Shift+M" } }),
  );
  await expect.poll(waiting).toBeGreaterThanOrEqual(1);

  // The refusal starts a read (1). Another window's change makes the controller read the table
  // (2), and the settings read it again once that ends (3).
  await record(panel, "save");
  await second.keyboard.press("Meta+Shift+K");
  await expect.poll(waiting).toBeGreaterThanOrEqual(2);
  await first.evaluate(() =>
    window.__tote.backend.patchSettings({ shortcuts: { "new-memo": "CmdOrCtrl+Alt+Shift+M" } }),
  );
  await expect.poll(waiting).toBeGreaterThanOrEqual(3);
  await open(2);
  await expect.poll(waiting).toBeGreaterThanOrEqual(4);

  // The refusal's read ends first and brings nothing; the later one brings the table.
  await open(1);
  await open(0);
  await open(3);
  await expect(keys(panel, "new-memo")).toHaveText("⌥⇧⌘M");
  await expect(row(panel, "save").locator(".shortcut-note")).toHaveText(
    "다른 창에서 단축키가 바뀌어 다시 읽었습니다. 다시 해 주세요",
  );
});

test("an entry saved equal to its default does not make a save look stale", async ({ page }) => {
  const panel = await startShortcuts(page, {
    settings: {
      ...defaultFakeData().settings,
      shortcuts: { save: "CmdOrCtrl+S", rename: null },
    },
  });
  await record(panel, "new-memo");
  await page.keyboard.press("Meta+Shift+M");
  await expect.poll(() => savedMap(page)).toEqual({ "new-memo": "CmdOrCtrl+Shift+M" });
  await expect(row(panel, "new-memo").locator(".shortcut-note")).toHaveCount(0);
  await expect(keys(panel, "new-memo")).toHaveText("⇧⌘M");
});

test("모두 기본값으로 from a stale table is refused and the other window's change stays", async ({
  context,
}) => {
  const first = await startWindows(context);
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  const panel = await openShortcuts(second);
  // 모두 기본값으로 is off while nothing is changed: give window 2 a table that has something.
  await first.evaluate(() =>
    window.__tote.backend.patchSettings({ shortcuts: { rename: "CmdOrCtrl+K" } }),
  );
  await expect(keys(panel, "rename")).toHaveText("⌘K");
  await second.evaluate(() => {
    window.__tote.backend.shortcutTable = () => new Promise(() => {});
  });
  await first.evaluate(() =>
    window.__tote.backend.patchSettings({
      shortcuts: { rename: "CmdOrCtrl+K", "new-memo": "CmdOrCtrl+Shift+M" },
    }),
  );
  await expect
    .poll(() => savedMap(first))
    .toEqual({ rename: "CmdOrCtrl+K", "new-memo": "CmdOrCtrl+Shift+M" });
  await second.evaluate(() => {
    delete (window.__tote.backend as { shortcutTable?: unknown }).shortcutTable;
  });

  await panel.getByRole("button", { name: "모두 기본값으로", exact: true }).click();
  await second.locator(".modal.confirm").getByRole("button", { name: "되돌리기" }).click();
  await expect(panel.locator(".shortcut-problem")).toHaveText(
    "다른 창에서 단축키가 바뀌어 다시 읽었습니다. 다시 해 주세요",
  );
  expect(await savedMap(first)).toEqual({
    rename: "CmdOrCtrl+K",
    "new-memo": "CmdOrCtrl+Shift+M",
  });
  await expect(keys(panel, "new-memo")).toHaveText("⇧⌘M");
});

test("the keyup of a recorded shortcut reaches nothing", async ({ page }) => {
  const panel = await startShortcuts(page);
  // What reaches the page after the window's capture listeners: the keyups anything else would hear.
  await page.evaluate(() => {
    const heard: string[] = [];
    (window as unknown as { heard: string[] }).heard = heard;
    document.addEventListener("keyup", (event) => heard.push(event.code));
  });
  const heard = () => page.evaluate(() => (window as unknown as { heard: string[] }).heard);
  await record(panel, "rename");
  await page.keyboard.down("Alt");
  await page.keyboard.down("Space");
  await expect.poll(() => savedMap(page)).toEqual({ rename: "Alt+Space" });
  await page.keyboard.up("Space");
  await page.keyboard.up("Alt");
  // Space's keyup would press the focused row button and record again; nothing else is held back.
  await expect(panel.locator(".recording")).toHaveCount(0);
  expect(await heard()).toEqual(["AltLeft"]);
  expect(await savedMap(page)).toEqual({ rename: "Alt+Space" });
  await expect(keys(panel, "rename")).toHaveText("⌥Space");
  // Only that key's: the next Space keyup is heard again.
  await page.keyboard.press("Space");
  expect(await heard()).toEqual(["AltLeft", "Space"]);
});

/** What reaches the page after the window's capture listeners: the keyups anything else would hear. */
async function hearKeyups(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const heard: string[] = [];
    (window as unknown as { heard: string[] }).heard = heard;
    document.addEventListener("keyup", (event) => heard.push(event.code));
  });
  return () => page.evaluate(() => (window as unknown as { heard: string[] }).heard);
}

test("releasing ⌘ lets go of the key recorded under it, whose keyup never comes", async ({
  page,
}) => {
  const panel = await startShortcuts(page);
  const heard = await hearKeyups(page);
  await record(panel, "rename");
  await page.keyboard.down("Meta");
  await page.keyboard.down("K");
  await expect.poll(() => savedMap(page)).toEqual({ rename: "CmdOrCtrl+K" });
  // WebKit sends no keyup for K here: only ⌘'s comes, and it is not held back.
  await page.keyboard.up("Meta");
  expect(await heard()).toEqual(["MetaLeft"]);
  // K's keyup is heard once K is pressed again: the list was emptied, not left waiting for the old one.
  await page.keyboard.up("K");
  expect(await heard()).toEqual(["MetaLeft", "KeyK"]);
});

test("closing the settings lets go of the key recorded last", async ({ page }) => {
  const panel = await startShortcuts(page);
  const heard = await hearKeyups(page);
  await record(panel, "rename");
  await page.keyboard.down("Alt");
  await page.keyboard.down("Space");
  await expect.poll(() => savedMap(page)).toEqual({ rename: "Alt+Space" });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator(".modal.settings")).toHaveCount(0);
  await page.keyboard.up("Space");
  await page.keyboard.up("Alt");
  expect(await heard()).toEqual(["Space", "AltLeft"]);
});

const menuRuns = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.menuCommandRuns ?? []);

/** The number of editor bindings the app's shortcuts make now (`menuKeymap`). */
const menuKeyCount = (page: Page) =>
  page.evaluate(() => (window.__tote.app as unknown as { menuKeys: unknown[] }).menuKeys.length);

const withShortcuts = (shortcuts: Record<string, string | null>): Partial<FakeData> => ({
  settings: { ...defaultFakeData().settings, shortcuts },
});

test("an app shortcut that is an editor key too runs the app command, not the editor's", async ({
  page,
}) => {
  await start(page, withShortcuts({ "close-tab": "CmdOrCtrl+L" }));
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("하나");
  await expect(page.locator(".status-position")).toHaveText("줄 1, 열 3");
  await page.keyboard.press("Meta+L");
  await expect.poll(() => menuRuns(page)).toEqual(["close-tab"]);
  await expect(page.locator(".tab")).toHaveCount(0);
});

test("an editor key no app shortcut has stays the editor's, and a table change hands it over in every tab", async ({
  page,
}) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("하나");
  await menu(page, "new-memo");
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("둘");
  await page.keyboard.press("Enter");
  await page.keyboard.type("셋");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".status-position")).toHaveText("줄 1, 열 2");
  // selectLine: the line and its break.
  await page.keyboard.press("Meta+L");
  await expect(page.locator(".status-position")).toHaveText("줄 2, 열 1");
  expect(await menuRuns(page)).toEqual([]);

  // As another window's settings screen saves: the first tab is not shown meanwhile.
  const before = await menuKeyCount(page);
  await page.evaluate(() =>
    window.__tote.backend.patchSettings({ shortcuts: { "close-tab": "CmdOrCtrl+L" } }),
  );
  await expect.poll(() => menuKeyCount(page)).toBeGreaterThan(before);
  await page.keyboard.press("Meta+L");
  await expect.poll(() => menuRuns(page)).toEqual(["close-tab"]);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Meta+L");
  await expect.poll(() => menuRuns(page)).toEqual(["close-tab", "close-tab"]);
  await expect(page.locator(".tab")).toHaveCount(0);
});

test("an app shortcut wins over the search bar's keys in its fields too", async ({ page }) => {
  await start(page, withShortcuts({ rename: "CmdOrCtrl+G" }));
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("가 가");
  await page.keyboard.press("Meta+F");
  const field = page.locator('input.find-bar-input[name=search][main-field="true"]');
  await expect(field).toBeFocused();
  await page.keyboard.type("가");
  // ⌘G is findNext in the bar's fields.
  await page.keyboard.press("Meta+G");
  await expect.poll(() => menuRuns(page)).toEqual(["rename"]);
});

// A macOS menu fires a keypad key's item on the main-row key of the same character too (settings
// smoke B-8), so the screen records the main-row key and checks it against the commands.
test("a keypad key records as its main-row twin, which another command may have", async ({
  page,
}) => {
  const panel = await startShortcuts(page, {
    settings: { ...defaultFakeData().settings, shortcuts: { rename: "CmdOrCtrl+1" } },
  });
  await expect(keys(panel, "rename")).toHaveText("⌘1");
  await record(panel, "new-memo");
  await page.keyboard.press("Meta+Numpad1");
  await expect(row(panel, "new-memo").locator(".shortcut-note")).toHaveText(
    /이름 바꾸기… 에 이미 쓰고 있습니다/,
  );
  await row(panel, "new-memo").getByRole("button", { name: "바꾸기", exact: true }).click();
  // 이름 바꾸기… has no default: 「없음」 is what it has anyway.
  await expect.poll(() => savedMap(page)).toEqual({ "new-memo": "CmdOrCtrl+1" });
  await expect(keys(panel, "new-memo")).toHaveText("⌘1");
  await expect(keys(panel, "rename")).toHaveText("없음");

  // The keypad's ＋ is not taken: recording goes on until a key it takes.
  await record(panel, "save");
  await page.keyboard.press("Meta+NumpadAdd");
  await expect(keys(panel, "save")).toHaveText("키를 누르세요");
  await page.keyboard.press("Meta+NumpadEnter");
  await expect
    .poll(() => savedMap(page))
    .toEqual({
      "new-memo": "CmdOrCtrl+1",
      save: "CmdOrCtrl+NumpadEnter",
    });
  await expect(keys(panel, "save")).toHaveText("⌘키패드 ↩");
});
