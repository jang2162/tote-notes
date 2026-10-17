import { expect, test, type Page } from "@playwright/test";

import { fakeMemo, type FakeData } from "../../src/backend/fake";
import type { WorkspaceInfo, WorkspaceListItem } from "../../src/backend/types";
import { parseSessionFile } from "../../src/core/session";
import { menu, nextWindow, quietErrors, ready, start, startWindows } from "./helpers";

// The workspace rail (spec 「워크스페이스 띠」): the fake's `otherWorkspaces` stand for the
// workspaces this window is not showing, and a switch reloads the page as the app's does.

const info = (name: string): WorkspaceInfo => ({
  id: `workspace-${name}`,
  name,
  title: name,
  path: `/fake/${name}`,
  deviceId: "device-1",
});

const listed = (name: string, windows = 0): WorkspaceListItem => ({
  name,
  path: `/fake/${name}`,
  open: windows > 0,
  windows,
  missing: false,
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

const railItem = (page: Page, name: string) => page.locator(`.rail-item[title="${name}"]`);
const activeTitle = (page: Page) => page.locator(".tab.active .tab-title");

/** Waits for the page the switch reloaded to show workspace `name`. */
async function switchedTo(page: Page, name: string): Promise<void> {
  await expect(page).toHaveTitle(name);
  await ready(page);
}

test("the rail lists the workspaces by name with the current one marked", async ({ page }) => {
  await open(page);
  const rail = page.locator(".rail");
  expect((await rail.boundingBox())?.width).toBe(48);
  const items = page.locator(".rail-item");
  await expect(items).toHaveText(["가계", "개인", "업무"]);
  expect(await items.evaluateAll((all) => all.map((each) => each.getAttribute("title")))).toEqual([
    "가계부",
    "개인",
    "업무",
  ]);
  await expect(page.locator(".rail-item.current")).toHaveAttribute("title", "업무");
  await expect(page.locator(".rail-dot")).toHaveCount(0);
  await expect(page.locator(".rail-add")).toHaveText("+");
  // Left of the sidebar.
  const sidebar = await page.locator(".sidebar").boundingBox();
  expect((await rail.boundingBox())!.x).toBeLessThan(sidebar!.x);
});

test("clicking a workspace switches this window to it and restores its session", async ({
  page,
}) => {
  await open(page);
  await expect(activeTitle(page)).toHaveText("회의");
  await railItem(page, "개인").click();
  await switchedTo(page, "개인");
  await expect(activeTitle(page)).toHaveText("일기");
  await expect(page.locator(".cm-content")).toHaveText("오늘");
  await expect(page.locator(".rail-item.current")).toHaveAttribute("title", "개인");
});

test("the tabs left behind are written before the switch", async ({ page }) => {
  await open(page);
  await expect(page.locator(".cm-content")).toHaveText("안건");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 셋");
  await railItem(page, "개인").click();
  await switchedTo(page, "개인");
  const left = await page.evaluate(() => {
    const workspace = window.__tote.backend.data.otherWorkspaces?.["/fake/업무"];
    const bytes = Uint8Array.from(atob(workspace?.memos.m.data ?? ""), (ch) => ch.charCodeAt(0));
    return { text: new TextDecoder().decode(bytes), session: workspace?.session ?? null };
  });
  expect(left.text).toBe("안건 셋");
  const tabs = parseSessionFile(left.session).windows[0].panes[0].tabs;
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
  await railItem(page, "가계부").click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.focusedWorkspace))
    .toBe("/fake/가계부");
  expect(await page.evaluate(() => "notReloaded" in window)).toBe(true);
  await expect(page).toHaveTitle("업무");
  await expect(activeTitle(page)).toHaveText("회의");
  // Its own workspace: nothing happens, not even a sibling window coming forward.
  await railItem(page, "업무").click();
  expect(await page.evaluate(() => window.__tote.backend.data.focusedWorkspace)).toBe(
    "/fake/가계부",
  );
  expect(await page.evaluate(() => "notReloaded" in window)).toBe(true);
});

test("+ creates a workspace and switches this window to it", async ({ page }) => {
  await open(page);
  await page.locator(".rail-add").click();
  await expect(page.locator(".modal")).toContainText("새 워크스페이스 이름");
  await page.locator(".modal input").fill("여행");
  await page.locator(".modal input").press("Enter");
  await switchedTo(page, "여행");
  await expect(page.locator(".pane")).toHaveCount(1);
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect(page.locator(".rail-item.current")).toHaveAttribute("title", "여행");
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
  await railItem(page, "개인").click();
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
  await expect(first.locator(".rail-item.current .rail-dot")).toHaveCount(1);
  await railItem(second, "개인").click();
  await expect(railItem(first, "개인").locator(".rail-dot")).toHaveCount(1);
  await expect(first.locator(".rail-item.current .rail-dot")).toHaveCount(0);
});

test("a composition in progress lands in its memo before a switch writes the tabs", async ({
  page,
}) => {
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
    backend.requestFlush(77);
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
