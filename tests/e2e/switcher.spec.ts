import { expect, test, type Locator, type Page } from "@playwright/test";

import { fakeMemo, type FakeData } from "../../src/backend/fake";
import type { WorkspaceInfo } from "../../src/backend/types";
import { parseSessionFile, sessionPanes } from "../../src/core/session";
import { hold, menu, nextWindow, quietErrors, ready, start, startWindows } from "./helpers";

// The workspace switcher (spec 「워크스페이스 고르개」): the fake's `otherWorkspaces` stand for the
// workspaces this window is not showing, and a switch reloads the page as the app's does.

const info = (name: string): WorkspaceInfo => ({
  id: `workspace-${name}`,
  name,
  title: name,
  path: `/fake/${name}`,
  deviceId: "device-1",
});

const listed = (name: string, windows = 0, hidden = false): FakeData["workspaces"][number] => ({
  name,
  path: `/fake/${name}`,
  open: windows > 0,
  windows,
  missing: false,
  hidden,
});

const oneTab = (memoId: string) =>
  JSON.stringify({ version: 1, activeTab: 0, tabs: [{ kind: "memo", memoId }] });

/** 업무, shown here with 회의 open; 개인 with 일기 open last time; 가계부 shown nowhere. */
function seed(patch: Partial<FakeData> = {}): Partial<FakeData> {
  return {
    workspace: info("업무"),
    memos: { m: fakeMemo("회의.md", "안건") },
    session: oneTab("m"),
    workspaces: [listed("업무", 1), listed("개인"), listed("가계부")],
    otherWorkspaces: {
      "/fake/개인": {
        workspace: info("개인"),
        memos: { p: fakeMemo("일기.md", "오늘") },
        session: oneTab("p"),
      },
      "/fake/가계부": { workspace: info("가계부"), memos: {}, session: null },
    },
    ...patch,
  };
}

/** Starts on `seed(patch)`. The page a switch leaves still writes as it unloads (blur, hidden),
 * and the backend refuses that on purpose: those reports stay out of the output. */
async function open(page: Page, patch: Partial<FakeData> = {}): Promise<void> {
  await quietErrors(page, "is switching workspaces");
  await start(page, seed(patch));
}

const button = (page: Page) => page.locator(".ws-switcher-button");
const option = (page: Page, name: string) =>
  page.locator(".ws-switcher-item", { has: page.locator(".ws-switcher-label", { hasText: name }) });

/** Where the cursor is in the focused pane's tab, as the tab keeps it. */
const cursor = (page: Page) =>
  page.evaluate(() => window.__tote.app.focused.tabs.active?.state?.selection.main.head);

/** Opens the list, if it is not, and clicks the workspace `name`. */
async function pickWorkspace(page: Page, name: string): Promise<void> {
  if (!(await page.locator(".ws-switcher-list").isVisible())) await button(page).click();
  await option(page, name).click();
}

/** Opens the list and clicks one of the two commands. */
async function pickCommand(page: Page, text: string): Promise<void> {
  if (!(await page.locator(".ws-switcher-list").isVisible())) await button(page).click();
  await page.locator(".ws-switcher-command", { hasText: text }).click();
}
const activeTitle = (page: Page) => page.locator(".tab.active .tab-title");

/** Waits for the page the switch reloaded to show workspace `name`. */
async function switchedTo(page: Page, name: string): Promise<void> {
  await expect(page).toHaveTitle(name);
  await ready(page);
}

test("the switcher lists the workspaces in the set order with the current one marked", async ({
  page,
}) => {
  await open(page);
  await expect(button(page)).toContainText("업무");
  await expect(button(page)).toHaveAttribute("aria-haspopup", "listbox");
  await expect(button(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".ws-switcher-list")).toBeHidden();
  await button(page).click();
  await expect(button(page)).toHaveAttribute("aria-expanded", "true");
  const items = page.locator(".ws-switcher-item .ws-switcher-label");
  await expect(items).toHaveText(["업무", "개인", "가계부"]);
  await expect(page.locator(".ws-switcher-item .ws-switcher-key")).toHaveText(["⌃1", "⌃2", "⌃3"]);
  await expect(page.locator(".ws-switcher-item").first()).toHaveAttribute(
    "aria-keyshortcuts",
    "Control+1",
  );
  await expect(page.locator(".ws-switcher-command .ws-switcher-key")).toHaveCount(0);
  await expect(page.locator(".ws-switcher-item.current")).toHaveCount(1);
  await expect(page.locator(".ws-switcher-item.current")).toContainText("업무");
  await expect(page.locator(".ws-switcher-item.current")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ws-switcher-dot")).toHaveCount(0);
  await expect(page.locator(".ws-switcher-command")).toHaveText([
    "새 워크스페이스…",
    "워크스페이스 열기…",
  ]);
});

test("the shortcut hint sits after the dot at the far right", async ({ page }) => {
  await open(page, { workspaces: [listed("업무", 1), listed("개인"), listed("가계부", 1)] });
  await button(page).click();
  const row = option(page, "가계부");
  await expect(row.locator(".ws-switcher-dot + .ws-switcher-key")).toHaveText("⌃3");
  expect(await row.evaluate((each) => each.lastElementChild?.className)).toBe("ws-switcher-key");
  const dot = (await row.locator(".ws-switcher-dot").boundingBox())!;
  const key = (await row.locator(".ws-switcher-key").boundingBox())!;
  expect(key.x).toBeGreaterThanOrEqual(dot.x + dot.width);
});

test("ten workspaces show hints on the first nine only", async ({ page }) => {
  const names = ["업무", "둘", "셋", "넷", "다섯", "여섯", "일곱", "여덟", "아홉", "열"];
  await open(page, { workspaces: names.map((name, index) => listed(name, index === 0 ? 1 : 0)) });
  await button(page).click();
  await expect(page.locator(".ws-switcher-item .ws-switcher-label")).toHaveText(names);
  await expect(page.locator(".ws-switcher-item .ws-switcher-key")).toHaveText(
    names.slice(0, 9).map((_, index) => `⌃${index + 1}`),
  );
  await expect(option(page, "열").locator(".ws-switcher-key")).toHaveCount(0);
  await expect(option(page, "열")).not.toHaveAttribute("aria-keyshortcuts");
});

test("hidden workspaces leave the list and give up their number", async ({ page }) => {
  await open(page, { workspaces: [listed("업무", 1), listed("개인", 0, true), listed("가계부")] });
  await button(page).click();
  await expect(page.locator(".ws-switcher-item .ws-switcher-label")).toHaveText(["업무", "가계부"]);
  await expect(page.locator(".ws-switcher-item .ws-switcher-key")).toHaveText(["⌃1", "⌃2"]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Digit2");
  await switchedTo(page, "가계부");
});

test("hiding this window's workspace keeps its name on the button", async ({ page }) => {
  await open(page, { workspaces: [listed("업무", 1, true), listed("개인"), listed("가계부")] });
  await expect(button(page)).toContainText("업무");
  await button(page).click();
  await expect(page.locator(".ws-switcher-item .ws-switcher-label")).toHaveText(["개인", "가계부"]);
  await expect(page.locator(".ws-switcher-item.current")).toHaveCount(0);
  await expect(page.locator(".ws-switcher-list .highlight")).toHaveText(/개인/);
  await expect(page.locator(".ws-switcher-item").first()).toHaveClass(/highlight/);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Digit1");
  await switchedTo(page, "개인");
});

test("a list without this window's workspace keeps its name on the button", async ({ page }) => {
  await open(page);
  await expect(button(page)).toContainText("업무");
  // As after the root changes: the list names the new root's workspaces, not this window's.
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    backend.data.workspaces = backend.data.workspaces.filter((each) => each.name !== "업무");
    backend.workspacesChanged();
  });
  await button(page).click();
  await expect(page.locator(".ws-switcher-item .ws-switcher-label")).toHaveText(["개인", "가계부"]);
  await expect(button(page)).toContainText("업무");
});

test("another window's new order reaches this switcher", async ({ context }) => {
  const first = await startWindows(
    context,
    seed({ workspaces: [listed("업무", 2), listed("개인"), listed("가계부")] }),
  );
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  // Open already: only the notice can bring the new order, not a read as the list opens.
  await button(first).click();
  const labels = first.locator(".ws-switcher-item .ws-switcher-label");
  await expect(labels).toHaveText(["업무", "개인", "가계부"]);
  await second.evaluate(() =>
    window.__tote.backend.setWorkspaceOrder(
      ["/fake/가계부", "/fake/업무", "/fake/개인"],
      ["/fake/개인"],
    ),
  );
  await expect(labels).toHaveText(["가계부", "업무"]);
  await expect(first.locator(".ws-switcher-item .ws-switcher-key")).toHaveText(["⌃1", "⌃2"]);
  // The window that saved it follows too.
  await button(second).click();
  await expect(second.locator(".ws-switcher-item .ws-switcher-label")).toHaveText([
    "가계부",
    "업무",
  ]);
});

test("the switcher sits above the title filter and stays while searching", async ({ page }) => {
  await open(page);
  const switcher = page.locator(".ws-switcher");
  const list = page.locator(".memo-pane");
  await expect(switcher).toBeVisible();
  expect((await switcher.boundingBox())!.y).toBeLessThan((await list.boundingBox())!.y);
  expect((await switcher.boundingBox())!.x).toBe((await page.locator(".sidebar").boundingBox())!.x);
  await menu(page, "search-workspace");
  await expect(page.locator(".search-input")).toBeFocused();
  await expect(switcher).toBeVisible();
  await expect(button(page)).toContainText("업무");
});

test("the rail is gone", async ({ page }) => {
  await open(page);
  await expect(page.locator(".rail")).toHaveCount(0);
  expect((await page.locator(".sidebar").boundingBox())!.x).toBe(0);
});

test("arrow keys and Enter switch, Esc closes without switching", async ({ page }) => {
  await open(page);
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.evaluate(() => {
    const { backend } = window.__tote;
    const switches: string[] = [];
    const switchWorkspace = backend.switchWorkspace.bind(backend);
    backend.switchWorkspace = (path) => {
      switches.push(path);
      return switchWorkspace(path);
    };
    Object.assign(window, { switches });
  });
  const switches = () =>
    page.evaluate(() => (window as unknown as { switches: string[] }).switches);
  // The list has the keys: they go into no editor, and the editor has them back when it closes.
  await button(page).click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.insertText("x");
  await page.keyboard.press("Escape");
  await expect(page.locator(".ws-switcher-list")).toBeHidden();
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".cm-content")).toHaveText("안건");
  expect(await switches()).toEqual([]);
  // A click outside closes it the same way.
  await button(page).click();
  await page.locator(".status-message").click({ force: true });
  await expect(page.locator(".ws-switcher-list")).toBeHidden();
  expect(await switches()).toEqual([]);
  // 업무 is the first; one down is 개인.
  await button(page).click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".ws-switcher-list .highlight")).toContainText("개인");
  await page.keyboard.press("Enter");
  await switchedTo(page, "개인");
});

test("typed keys go nowhere, ArrowDown stops at the end, Enter runs a command", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator(".cm-content")).toBeFocused();
  await button(page).click();
  await page.keyboard.type("zq");
  await expect(page.locator(".cm-content")).toHaveText("안건");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
  const highlight = page.locator(".ws-switcher-list .highlight");
  await expect(highlight).toHaveText("워크스페이스 열기…");
  await expect(page.locator(".ws-switcher-list")).toHaveAttribute(
    "aria-activedescendant",
    (await highlight.getAttribute("id"))!,
  );
  await page.keyboard.press("ArrowUp");
  await expect(highlight).toHaveText("새 워크스페이스…");
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal")).toContainText("새 워크스페이스 이름");
  await expect(page.locator(".ws-switcher-list")).toBeHidden();
});

test("a list opened from the search box gives it the keys back on Esc", async ({ page }) => {
  await open(page);
  await menu(page, "search-workspace");
  const search = page.locator(".search-input");
  await expect(search).toBeFocused();
  await button(page).click();
  await expect(page.locator(".ws-switcher-list")).toBeVisible();
  await expect(search).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ws-switcher-list")).toBeHidden();
  await expect(search).toBeFocused();
  // The Esc was the list's: the search is still on.
  await expect(search).toBeVisible();
});

test("a list left by a menu action closes and the keys go where the action put them", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator(".cm-content")).toBeFocused();
  await button(page).click();
  await expect(page.locator(".ws-switcher-list")).toBeVisible();
  // The native menu's shortcuts reach the page as menu events, not as keys the list could see.
  await menu(page, "new-memo");
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(".ws-switcher-list")).toBeHidden();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.insertText("새 글");
  await expect(page.locator(".cm-content")).toHaveText("새 글");
});

test("a list left with the window closes and gives the keys back when the window returns", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator(".cm-content")).toBeFocused();
  await button(page).click();
  await expect(page.locator(".ws-switcher-list")).toBeVisible();
  // A browser that blurs the focused element as the window goes inactive, with no element taking
  // the focus. WKWebView does not (the next test).
  await page.evaluate(() => {
    document.hasFocus = () => false;
    (document.activeElement as HTMLElement).blur();
  });
  await expect(page.locator(".ws-switcher-list")).toBeHidden();
  await page.evaluate(() => delete (document as { hasFocus?: unknown }).hasFocus);
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.insertText("돌아옴");
  await expect(page.locator(".cm-content")).toContainText("돌아옴");
});

test("a list left with the app closes on the window's blur alone and gives the keys back", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator(".cm-content")).toBeFocused();
  await button(page).click();
  await expect(page.locator(".ws-switcher-list")).toBeVisible();
  await expect(page.locator(".ws-switcher-list")).toBeFocused();
  // As WKWebView does when another app comes to the front: the window blurs, and the list keeps
  // the focus, so no focusout comes.
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("blur")));
  await expect(page.locator(".ws-switcher-list")).toBeHidden();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.insertText("돌아옴");
  await expect(page.locator(".cm-content")).toContainText("돌아옴");
});

test("「워크스페이스 열기…」 opens the picker", async ({ page }) => {
  await open(page);
  await pickCommand(page, "워크스페이스 열기…");
  await expect(page.locator(".modal.picker")).toBeVisible();
  await expect(page.locator(".ws-switcher-list")).toBeHidden();
});

test("clicking a workspace switches this window to it and restores its session", async ({
  page,
}) => {
  await open(page);
  await expect(activeTitle(page)).toHaveText("회의");
  await pickWorkspace(page, "개인");
  await switchedTo(page, "개인");
  await expect(activeTitle(page)).toHaveText("일기");
  await expect(page.locator(".cm-content")).toHaveText("오늘");
  await expect(button(page)).toContainText("개인");
});

test("the tabs left behind are written before the switch", async ({ page }) => {
  await open(page);
  await expect(page.locator(".cm-content")).toHaveText("안건");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 셋");
  await pickWorkspace(page, "개인");
  await switchedTo(page, "개인");
  const left = await page.evaluate(() => {
    const workspace = window.__tote.backend.data.otherWorkspaces?.["/fake/업무"];
    const bytes = Uint8Array.from(atob(workspace?.memos.m.data ?? ""), (ch) => ch.charCodeAt(0));
    return { text: new TextDecoder().decode(bytes), session: workspace?.session ?? null };
  });
  expect(left.text).toBe("안건 셋");
  const tabs = sessionPanes(parseSessionFile(left.session).windows[0].layout)[0].tabs;
  expect(tabs).toEqual([expect.objectContaining({ kind: "memo", memoId: "m" })]);
});

test("keys typed while a switch writes the tabs go into the memo left behind", async ({ page }) => {
  await open(page);
  await expect(page.locator(".cm-content")).toHaveText("안건");
  // ⌃숫자 leaves the editor focused: the person may still be finishing a word as the round
  // writes. The fake types it in while the round writes the session, the round's last write.
  await page.evaluate(() => {
    const { app, backend } = window.__tote;
    backend.whileWritingLayout = () => {
      const view = app.view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: " 넷" } });
    };
  });
  await page.keyboard.press("Control+Digit2");
  await switchedTo(page, "개인");
  const left = await page.evaluate(() => {
    const memo = window.__tote.backend.data.otherWorkspaces?.["/fake/업무"]?.memos.m;
    const bytes = Uint8Array.from(atob(memo?.data ?? ""), (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  });
  expect(left).toBe("안건 넷");
});

/** The text of memo `id` of the workspace the switch left. */
const leftMemoText = (page: Page, id: string) =>
  page.evaluate((memoId) => {
    const memo = window.__tote.backend.data.otherWorkspaces?.["/fake/업무"]?.memos[memoId];
    const bytes = Uint8Array.from(atob(memo?.data ?? ""), (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }, id);

/** The switch round has its answer: the fake's own round ids start at 1 000 000. */
const answered = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() => window.__tote.backend.data.flushed.some((each) => each.id >= 1_000_000)),
    )
    .toBe(true);

test("keys typed after the switch round answers do not reach the memo left", async ({ page }) => {
  await open(page);
  await expect(page.locator(".cm-content")).toHaveText("안건");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  const release = await hold(page, "switchGate");
  await pickWorkspace(page, "개인");
  await answered(page);
  await page.keyboard.insertText("x");
  // Typed into the gap before the window switches: written nowhere, so taken nowhere.
  expect(await page.evaluate(() => window.__tote.app.view.state.doc.toString())).not.toContain("x");
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await release();
  await switchedTo(page, "개인");
  expect(await leftMemoText(page, "m")).toBe("안건");
});

test("a switch the person cancels gives the editor back", async ({ page }) => {
  await quietErrors(page, "no space left on device");
  // Every write fails: the round answers with 저장 실패, and the fake takes 「취소」.
  await open(page, { failWrites: 1000 });
  await expect(page.locator(".cm-content")).toHaveText("안건");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 셋");
  await pickWorkspace(page, "개인");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed.map((each) => each.blocked)))
    .toEqual(["저장하지 못한 메모 1개"]);
  await expect(page).toHaveTitle("업무");
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.insertText("!");
  await expect(page.locator(".cm-content")).toHaveText("안건 셋!");
});

test("a memo opened while the window leaves shows nothing", async ({ page }) => {
  await open(page);
  const release = await hold(page, "switchGate");
  await pickWorkspace(page, "개인");
  await answered(page);
  await menu(page, "new-memo");
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".editor-host")).toBeHidden();
  await release();
  await switchedTo(page, "개인");
});

test("a tab moved out while the window switches stays and says why in words", async ({ page }) => {
  await quietErrors(page, "is switching workspaces", "is closing or switching");
  await start(page, seed());
  await expect(page.locator(".cm-content")).toHaveText("안건");
  const release = await hold(page, "switchGate");
  await pickWorkspace(page, "개인");
  await answered(page);
  await menu(page, "move-tab-to-new-window");
  await expect(page.locator(".status-message")).toHaveText(
    "창을 닫거나 바꾸는 중이라 탭을 옮기지 못했습니다",
  );
  expect(await page.evaluate(() => window.__tote.backend.data.tornOff ?? [])).toEqual([]);
  await expect(page.locator(".tab")).toHaveCount(1);
  await release();
  await switchedTo(page, "개인");
});

test("a switch that cannot open its target after writing gives the panes back", async ({
  page,
}) => {
  await open(page, { unopenable: ["/fake/개인"] });
  await expect(page.locator(".cm-content")).toHaveText("안건");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  const release = await hold(page, "switchGate");
  await pickWorkspace(page, "개인");
  await answered(page);
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await release();
  await expect(page.locator(".status-message")).toContainText("워크스페이스를 열지 못했습니다");
  await expect(page).toHaveTitle("업무");
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await cursor(page)).toBe(2);
  await page.keyboard.insertText(" 셋");
  await expect.poll(() => cursor(page)).toBe(4);
  await expect.poll(() => page.evaluate(() => window.__tote.backend.memoText("m"))).toBe("안건 셋");
});

test("a late answer after the round ended gives the panes back", async ({ page }) => {
  await open(page);
  await expect(page.locator(".cm-content")).toHaveText("안건");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  // The native side settled the round at its timeout and the window stays: the answer finds no
  // round, and no 「stay」 comes after it.
  await page.evaluate(() => {
    const { app, backend } = window.__tote;
    const flushDone = backend.flushDone.bind(backend);
    backend.flushDone = (id, blocked) => {
      Object.assign(window, { emptyAtAnswer: app.leaving });
      return flushDone(id, blocked);
    };
    backend.staleFlush = true;
    backend.requestFlush(77, "switch");
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { emptyAtAnswer?: boolean }).emptyAtAnswer),
    )
    .toBe(true);
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await cursor(page)).toBe(2);
  await page.keyboard.insertText(" 셋");
  await expect.poll(() => cursor(page)).toBe(4);
  await expect.poll(() => page.evaluate(() => window.__tote.backend.memoText("m"))).toBe("안건 셋");
});

test("a cancelled switch gives focus back to the search box", async ({ page }) => {
  await quietErrors(page, "no space left on device");
  // Every write fails: the round answers with 저장 실패, and the fake takes 「취소」.
  await open(page, { failWrites: 1000 });
  await expect(page.locator(".cm-content")).toHaveText("안건");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 셋");
  await menu(page, "search-workspace");
  const search = page.locator(".search-input");
  await expect(search).toBeFocused();
  await pickWorkspace(page, "개인");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed.map((each) => each.blocked)))
    .toEqual(["저장하지 못한 메모 1개"]);
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  await expect(search).toBeFocused();
  expect(
    await page.evaluate(() => document.activeElement?.classList.contains("search-input")),
  ).toBe(true);
});

/** Starts on `seed(patch)`; the search box has the keys; the window answers switch round 77 and
 * leaves. */
async function leaveFromSearch(page: Page, patch: Partial<FakeData> = {}): Promise<Locator> {
  await open(page, patch);
  await expect(page.locator(".pane")).toHaveCount(1);
  await menu(page, "search-workspace");
  const search = page.locator(".search-input");
  await expect(search).toBeFocused();
  await page.evaluate(() => window.__tote.backend.requestFlush(77, "switch"));
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed.map((each) => each.id)))
    .toContain(77);
  expect(await page.evaluate(() => window.__tote.app.leaving)).toBe(true);
  return search;
}

test("a search box hidden while the window left gives the keys to the pane", async ({ page }) => {
  // No tab: showing the pane again puts the keys nowhere, unlike an editor it shows.
  const search = await leaveFromSearch(page, { session: null });
  await page.evaluate(() =>
    (window.__tote.app as unknown as { sidebar: { show(view: string): void } }).sidebar.show(
      "memos",
    ),
  );
  await expect(search).toBeHidden();
  await page.evaluate(() => window.__tote.backend.stay());
  await expect(page.locator(".pane")).toBeFocused();
});

test("a second round while the window leaves keeps where the keys were", async ({ page }) => {
  const search = await leaveFromSearch(page);
  // The keys are nowhere by the time a close round comes (⌘W after the switch answered).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => window.__tote.backend.requestFlush(78, "close"));
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed.map((each) => each.id)))
    .toContain(78);
  await page.evaluate(() => window.__tote.backend.stay());
  await expect(search).toBeFocused();
});

test("a switcher click while the window leaves does nothing", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const { backend } = window.__tote;
    const switches: string[] = [];
    const switchWorkspace = backend.switchWorkspace.bind(backend);
    backend.switchWorkspace = (path) => {
      switches.push(path);
      return switchWorkspace(path);
    };
    Object.assign(window, { switches });
  });
  const release = await hold(page, "switchGate");
  await pickWorkspace(page, "개인");
  await answered(page);
  // The click is handled as it is dispatched: a switch would have reached the backend by now.
  await pickWorkspace(page, "가계부");
  expect(await page.evaluate(() => (window as unknown as { switches: string[] }).switches)).toEqual(
    ["/fake/개인"],
  );
  // `+` would ask for a name in a dialog shown as it is clicked.
  await pickCommand(page, "새 워크스페이스…");
  expect(await page.evaluate(() => document.querySelectorAll(".modal").length)).toBe(0);
  await release();
  await switchedTo(page, "개인");
});

test("a switcher switch titles a memo from its first line", async ({ page }) => {
  await open(page, { memos: { m: fakeMemo("회의.md", "안건", { autoTitle: true }) } });
  await expect(page.locator(".cm-content")).toHaveText("안건");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 정리");
  // The cursor never leaves the title line and the switcher click keeps the editor focused: only the
  // switch's writing of the tabs names the memo.
  await pickWorkspace(page, "개인");
  await switchedTo(page, "개인");
  expect(
    await page.evaluate(() => window.__tote.backend.data.otherWorkspaces?.["/fake/업무"]?.memos.m),
  ).toMatchObject({ file: "안건 정리.md" });
});

test("⌃2 does nothing while a dialog is open", async ({ page }) => {
  await open(page);
  await expect(page.locator(".cm-content")).toHaveText("안건");
  await page.evaluate(() => {
    const { backend } = window.__tote;
    const switches: string[] = [];
    const switchWorkspace = backend.switchWorkspace.bind(backend);
    backend.switchWorkspace = (path) => {
      switches.push(path);
      return switchWorkspace(path);
    };
    Object.assign(window, { switches });
  });
  await menu(page, "rename");
  await expect(page.locator(".modal")).toContainText("새 파일 이름");
  await page.keyboard.press("Control+Digit2");
  // A switch would have reached the backend by now; the page would have reloaded soon after.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { switches: string[] }).switches)).toEqual(
    [],
  );
  await expect(page.locator(".modal")).toBeVisible();
  await expect(page).toHaveTitle("업무");
});

test("⌃2 switches to the second workspace", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+Digit2");
  await switchedTo(page, "개인");
  await expect(activeTitle(page)).toHaveText("일기");
});

test("a workspace open in another window is brought forward and this window stays", async ({
  page,
}) => {
  await open(page, { workspaces: [listed("업무", 1), listed("개인"), listed("가계부", 1)] });
  await page.evaluate(() => Object.assign(window, { notReloaded: true }));
  await pickWorkspace(page, "가계부");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.focusedWorkspace))
    .toBe("/fake/가계부");
  expect(await page.evaluate(() => "notReloaded" in window)).toBe(true);
  await expect(page).toHaveTitle("업무");
  await expect(activeTitle(page)).toHaveText("회의");
  // Its own workspace: nothing happens, not even a sibling window coming forward.
  await pickWorkspace(page, "업무");
  expect(await page.evaluate(() => window.__tote.backend.data.focusedWorkspace)).toBe(
    "/fake/가계부",
  );
  expect(await page.evaluate(() => "notReloaded" in window)).toBe(true);
});

test("a workspace that cannot be found leaves the switcher after a failed switch", async ({
  page,
}) => {
  await quietErrors(page, "is switching workspaces", "is not a tote workspace");
  await start(page, seed());
  // The folder went since the list was read: the switcher still shows it.
  await page.evaluate(() => {
    const data = window.__tote.backend.data;
    data.workspaces[1].missing = true;
    delete data.otherWorkspaces!["/fake/개인"];
  });
  await button(page).click();
  await expect(option(page, "개인")).toHaveCount(1);
  await option(page, "개인").click();
  await expect(option(page, "개인")).toHaveCount(0);
  await expect(page.locator(".status-message")).toHaveText("워크스페이스가 아닌 폴더입니다");
  await expect(option(page, "가계부")).toHaveCount(1);
});

test("새 워크스페이스… creates a workspace and switches this window to it", async ({ page }) => {
  await open(page);
  await pickCommand(page, "새 워크스페이스…");
  await expect(page.locator(".modal")).toContainText("새 워크스페이스 이름");
  await page.locator(".modal input").fill("여행");
  await page.locator(".modal input").press("Enter");
  await switchedTo(page, "여행");
  await expect(page.locator(".pane")).toHaveCount(1);
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect(button(page)).toContainText("여행");
});

test("새 워크스페이스… in the menu switches this window too", async ({ page }) => {
  await open(page);
  await menu(page, "new-workspace");
  await expect(page.locator(".modal")).toContainText("새 워크스페이스 이름");
  await page.locator(".modal input").fill("독서");
  await page.locator(".modal input").press("Enter");
  await switchedTo(page, "독서");
  await expect(page.locator(".tab")).toHaveCount(0);
});

test("만들기 in the workspace picker switches this window too", async ({ page }) => {
  await open(page);
  await menu(page, "open-workspace");
  await page.locator(".modal.picker input").fill("요리");
  await page.locator(".modal.picker button", { hasText: "만들기" }).click();
  await switchedTo(page, "요리");
  await expect(page.locator(".tab")).toHaveCount(0);
});

test("a switch is marked for the timing", async ({ page }) => {
  await open(page, { perf: true });
  await pickWorkspace(page, "개인");
  await switchedTo(page, "개인");
  const marks = await page.evaluate(() => window.__tote.backend.data.marks ?? []);
  expect(marks).toContain("switch-click");
});

test("the dot follows a workspace opened in another window", async ({ context }) => {
  // Two windows show 업무.
  const first = await startWindows(
    context,
    seed({ workspaces: [listed("업무", 2), listed("개인"), listed("가계부")] }),
  );
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await button(first).click();
  await expect(first.locator(".ws-switcher-item.current .ws-switcher-dot")).toHaveCount(1);
  await pickWorkspace(second, "개인");
  await expect(option(first, "개인").locator(".ws-switcher-dot")).toHaveCount(1);
  await expect(first.locator(".ws-switcher-item.current .ws-switcher-dot")).toHaveCount(0);
});

test("onFlush writes a composition in progress before it answers", async ({ page }) => {
  await open(page, {
    session: JSON.stringify({
      version: 1,
      activeTab: 0,
      tabs: [
        { kind: "memo", memoId: "m", selection: { ranges: [{ anchor: 2, head: 2 }], main: 0 } },
      ],
    }),
  });
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".cm-content")).toHaveText("안건");
  // The input method's events as tests/e2e/tear-off.spec.ts sends them; the switch's flush round
  // (`onFlush`) comes mid-composition.
  const seen = await page.evaluate(async () => {
    const { app, backend } = window.__tote;
    const view = app.view;
    const dom = view.contentDOM;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const fire = (type: "beforeinput" | "input", inputType: string, data: string | null) =>
      dom.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, inputType, data }));
    const composition = (type: string, data: string) =>
      dom.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
    const write = (from: number, to: number, text: string) => {
      const at = view.domAtPos(from);
      let node = at.node;
      let offset = at.offset;
      if (node.nodeType !== Node.TEXT_NODE) {
        const before = node.childNodes[offset - 1];
        node = before;
        offset = before.nodeValue!.length;
      }
      const value = node.nodeValue!;
      node.nodeValue = value.slice(0, offset) + text + value.slice(offset + (to - from));
      document.getSelection()!.collapse(node, offset + text.length);
    };
    composition("compositionstart", "");
    await tick();
    const from = view.state.selection.main.from;
    composition("compositionupdate", "가");
    fire("beforeinput", "insertCompositionText", "가");
    write(from, from, "가");
    fire("input", "insertCompositionText", "가");
    await tick();
    const composing = view.composing;
    backend.requestFlush(77, "switch");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The tabs are written once the composition ends.
    const flushedEarly = backend.data.flushed.some((each) => each.id === 77);
    fire("beforeinput", "deleteCompositionText", null);
    write(from, from + 1, "");
    fire("input", "deleteCompositionText", null);
    await tick();
    fire("beforeinput", "insertFromComposition", "가");
    write(from, from, "가");
    fire("input", "insertFromComposition", "가");
    await tick();
    composition("compositionend", "가");
    return { composing, flushedEarly };
  });
  expect(seen).toEqual({ composing: true, flushedEarly: false });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed.map((each) => each.id)))
    .toContain(77);
  expect(await page.evaluate(() => window.__tote.backend.memoText("m"))).toBe("안건가");
});

/** Starts on `seed(patch)` with the cursor after 「안건」 and 「가」 being composed there. Like
 * macOS's, the input method ends the composition when the editor loses focus; `composed.ended`
 * says it has, and `composed.endedAtSwitch` whether it had when `switchWorkspace` was called. The
 * input method's events are sent as in the test above. */
async function composeUntilBlur(page: Page, patch: Partial<FakeData> = {}): Promise<void> {
  await open(page, {
    session: JSON.stringify({
      version: 1,
      activeTab: 0,
      tabs: [
        { kind: "memo", memoId: "m", selection: { ranges: [{ anchor: 2, head: 2 }], main: 0 } },
      ],
    }),
    ...patch,
  });
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".cm-content")).toHaveText("안건");
  await page.evaluate(async () => {
    const { app, backend } = window.__tote;
    const view = app.view;
    const dom = view.contentDOM;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const fire = (type: "beforeinput" | "input", inputType: string, data: string | null) =>
      dom.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, inputType, data }));
    const composition = (type: string, data: string) =>
      dom.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
    const write = (from: number, to: number, text: string) => {
      const at = view.domAtPos(from);
      let node = at.node;
      let offset = at.offset;
      if (node.nodeType !== Node.TEXT_NODE) {
        const before = node.childNodes[offset - 1];
        node = before;
        offset = before.nodeValue!.length;
      }
      const value = node.nodeValue!;
      node.nodeValue = value.slice(0, offset) + text + value.slice(offset + (to - from));
      document.getSelection()!.collapse(node, offset + text.length);
    };
    const state = { ended: false, endedAtSwitch: null as boolean | null };
    Object.assign(window, { composed: state });
    const switchWorkspace = backend.switchWorkspace.bind(backend);
    backend.switchWorkspace = (path) => {
      state.endedAtSwitch = state.ended;
      return switchWorkspace(path);
    };
    composition("compositionstart", "");
    await tick();
    const from = view.state.selection.main.from;
    composition("compositionupdate", "가");
    fire("beforeinput", "insertCompositionText", "가");
    write(from, from, "가");
    fire("input", "insertCompositionText", "가");
    await tick();
    // The syllable is in the text already; the end only commits it. Writing it again here would
    // put the selection back in the editor, and the keys with it.
    dom.addEventListener(
      "blur",
      () => {
        composition("compositionend", "가");
        state.ended = true;
      },
      { once: true },
    );
  });
}

const composed = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { composed: { ended: boolean; endedAtSwitch: boolean | null } })
        .composed,
  );

test("⌃3 on a workspace another window shows settles a composition first", async ({ page }) => {
  // ⌃3 takes no focus, and no flush round runs to end the composition.
  await composeUntilBlur(page, {
    workspaces: [listed("업무", 1), listed("개인"), listed("가계부", 1)],
  });
  await page.keyboard.press("Control+Digit3");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.focusedWorkspace))
    .toBe("/fake/가계부");
  expect((await composed(page)).endedAtSwitch).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__tote.backend.memoText("m"))).toBe("안건가");
  await expect(page).toHaveTitle("업무");
});

test("새 워크스페이스… ends a composition as its dialog takes the keys", async ({ page }) => {
  await composeUntilBlur(page);
  await pickCommand(page, "새 워크스페이스…");
  await expect(page.locator(".modal input")).toBeFocused();
  expect((await composed(page)).ended).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__tote.backend.memoText("m"))).toBe("안건가");
});
