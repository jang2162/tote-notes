import { expect, test, type Page } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import type { OutsideChange, WorkspaceChange } from "../../src/backend/types";
import {
  dragOut,
  hold,
  memoWrites,
  menu,
  openShopping,
  quietErrors,
  start,
  typeWhileChangedElsewhere,
  writesSettled,
} from "./helpers";

// 「탭을 새 창으로 옮기기」 in one window on the fake backend: what leaves this window and what the
// backend is handed (`data.tornOff`). tests/e2e/windows.spec.ts opens the new window too.

const NOT_MOVED = "저장하지 못해 새 창으로 옮기지 않았습니다";
const NOT_MOVED_WITH_BANNER = "충돌·삭제 알림이 떠 있어 새 창으로 옮기지 않았습니다";
const MOVE = "move-tab-to-new-window";
const WRITE_FAILED = "no space left on device";

// A 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const twoTabs = {
  version: 1,
  activeTab: 1,
  tabs: [
    { kind: "memo", memoId: "a" },
    { kind: "memo", memoId: "b" },
  ],
};

const data = (page: Page) => page.evaluate(() => window.__tote.backend.data);
const memoText = (page: Page, id: string) =>
  page.evaluate((memo) => window.__tote.backend.memoText(memo), id);

/** Opens 장보기 (우유) with the cursor after 우유 and types behind it. */
async function typeInto(page: Page, seed: Parameters<typeof start>[1] = {}): Promise<void> {
  await openShopping(page, seed);
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 계란");
}

function outside(page: Page, ...changes: WorkspaceChange[]): Promise<void> {
  const change: OutsideChange = { kind: "workspace", changes };
  return page.evaluate((c) => window.__tote.backend.outside(c), change);
}

test("탭을 새 창으로 옮기기 saves the memo first and hands the tab over", async ({ page }) => {
  await typeInto(page);
  await menu(page, MOVE);
  await expect(page.locator(".tab")).toHaveCount(0);
  // Written before the tab went, not by the save timer after.
  expect(await memoText(page, "a")).toBe("우유 계란");
  const { tornOff, places } = await data(page);
  expect(tornOff).toHaveLength(1);
  expect(tornOff![0].tab).toMatchObject({ kind: "memo", memoId: "a" });
  expect(places).toEqual({ "memo:a": "ws-2" });
});

test("a tab whose save fails stays with 저장 실패", async ({ page }) => {
  await quietErrors(page, WRITE_FAILED);
  // Every write fails: a save that fails once is tried again at once before the move.
  await typeInto(page, { failWrites: 1000 });
  await menu(page, MOVE);
  await expect(page.locator(".status-message")).toHaveText(NOT_MOVED);
  await expect(page.locator(".tab.active")).toHaveClass(/\bfailed\b/);
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
  const { tornOff, places } = await data(page);
  expect(tornOff).toBeUndefined();
  expect(places).toEqual({ "memo:a": "ws-1" });
});

test("keys typed while the tab is being torn off do not reach it", async ({ page }) => {
  await typeInto(page);
  const release = await hold(page, "tearOffGate");
  await menu(page, MOVE);
  // The tab is let go of and the backend is still handing it over. What blocks the keys is the
  // editor showing nothing (`showNothing`), which turns contenteditable off.
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await page.keyboard.insertText("x");
  // Nothing is waiting to be saved: `unwritten` is what a key reaching the tab would have set by
  // scheduling a write, so `false` means no key got in.
  expect(await page.evaluate(() => window.__tote.app.focused.tabs.active!.unwritten)).toBe(false);
  await release();
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(await memoText(page, "a")).toBe("우유 계란");
  expect((await data(page)).tornOff).toHaveLength(1);
});

test("a tab being torn off does not take its editor back when shown again", async ({ page }) => {
  const refused = "ws-1 does not hold the tab";
  await quietErrors(page, refused);
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(twoTabs),
  });
  await expect(page.locator(".cm-content")).toHaveText("둘째");
  const away = async () => {
    await page.locator(".tab", { hasText: "가" }).click();
    await expect(page.locator(".cm-content")).toHaveText("첫째");
    await page.locator(".tab", { hasText: "나" }).click();
    await expect(page.locator(".tab.active .tab-title")).toHaveText("나");
    await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
    // The tab's click leaves the keys on the tab: they go where a shown editor would take them.
    await page.evaluate(() => window.__tote.app.view.focus());
    await page.keyboard.insertText("x");
  };

  // Shown again while it is handed over: it stays let go of, and goes.
  let release = await hold(page, "tearOffGate");
  await menu(page, MOVE);
  await away();
  // A save the key scheduled would have run by the time nothing is left to write.
  await writesSettled(page);
  expect(await memoWrites(page, "b")).toBe(0);
  expect(await memoText(page, "b")).toBe("둘째");
  await release();
  await expect(page.locator(".tab .tab-title")).toHaveText(["가"]);

  // The backend refuses the move: the tab is editable again.
  await page.evaluate(() => {
    delete window.__tote.backend.data.places!["memo:b"];
  });
  await page.locator(".memo-row", { hasText: "나" }).click();
  await expect(page.locator(".cm-content")).toHaveText("둘째");
  await page.evaluate(() => {
    window.__tote.backend.data.places!["memo:b"] = "ws-9";
  });
  release = await hold(page, "tearOffGate");
  await menu(page, MOVE);
  await away();
  await release();
  await expect(page.locator(".status-message")).toHaveText(`오류: ${refused}`);
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.insertText("!");
  await expect.poll(() => memoText(page, "b")).toBe("둘째!");
});

test("a tab whose hand-over throws stays editable", async ({ page }) => {
  const broken = "the hand-over broke";
  await quietErrors(page, broken);
  await typeInto(page);
  await page.evaluate((message) => {
    window.__tote.app.focused.tabs.active!.handOver = () => Promise.reject(new Error(message));
  }, broken);
  await menu(page, MOVE);
  await expect(page.locator(".status-message")).toHaveText(`오류: ${broken}`);
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  await page.keyboard.insertText("!");
  await expect.poll(() => memoText(page, "a")).toBe("우유 계란!");
});

test("a tab whose window is closing or switching stays and says why in words", async ({ page }) => {
  await quietErrors(page, "is closing or switching");
  await typeInto(page);
  await page.evaluate(() => {
    window.__tote.backend.tearOffBusy = true;
  });
  await menu(page, MOVE);
  await expect(page.locator(".status-message")).toHaveText(
    "창을 닫거나 바꾸는 중이라 탭을 옮기지 못했습니다",
  );
  await expect(page.locator(".tab")).toHaveCount(1);
});

test("a tab the backend does not take stays editable and says why", async ({ page }) => {
  const refused = "ws-1 does not hold the tab";
  await quietErrors(page, refused);
  await typeInto(page);
  // Another window holds it now, as far as the backend knows: it refuses the move.
  await page.evaluate(() => {
    window.__tote.backend.data.places!["memo:a"] = "ws-9";
  });
  await menu(page, MOVE);
  await expect(page.locator(".status-message")).toHaveText(`오류: ${refused}`);
  await expect(page.locator(".tab")).toHaveCount(1);
  await page.keyboard.insertText("!");
  await expect(page.locator(".cm-content")).toHaveText("우유 계란!");
  await expect.poll(() => memoText(page, "a")).toBe("우유 계란!");
});

test("a tab with a conflict banner stays and says why", async ({ page }) => {
  await typeWhileChangedElsewhere(page);
  await expect(page.locator(".banner")).toBeVisible();
  await menu(page, MOVE);
  await expect(page.locator(".status-message")).toHaveText(NOT_MOVED_WITH_BANNER);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
  expect((await data(page)).tornOff).toBeUndefined();
});

test("a tab with a save failure and a conflict banner says the banner", async ({ page }) => {
  await quietErrors(page, WRITE_FAILED);
  await typeInto(page, { failWrites: 1000 });
  // The autosave has failed before the file changes outside, so the tab holds both.
  await expect(page.locator(".tab.active")).toHaveClass(/\bfailed\b/);
  await page.evaluate(
    (text) => Object.assign(window.__tote.backend.data.memos.a, { data: text, modifiedMs: 900 }),
    fakeFile("두유"),
  );
  await outside(page, { kind: "modified", id: "a" });
  await expect(page.locator(".banner")).toBeVisible();
  await menu(page, MOVE);
  // Both hold the tab; the banner is what the person has to answer first.
  await expect(page.locator(".status-message")).toHaveText(NOT_MOVED_WITH_BANNER);
  await expect(page.locator(".tab")).toHaveCount(1);
  expect((await data(page)).tornOff).toBeUndefined();
});

test("an external file whose draft is over a changed file stays", async ({ page }) => {
  await start(page, {
    files: { "/x/a.sh": fakeFile("echo theirs\n") },
    drafts: { "/x/a.sh": { base: fakeFile("echo hi\n"), data: fakeFile("echo mine\n") } },
    picks: ["/x/a.sh"],
  });
  await menu(page, "open-file");
  await expect(page.locator(".banner")).toBeVisible();
  await menu(page, MOVE);
  await expect(page.locator(".status-message")).toHaveText(NOT_MOVED_WITH_BANNER);
  await expect(page.locator(".tab")).toHaveCount(1);
  expect((await data(page)).tornOff).toBeUndefined();
});

test("a memo deleted on disk stays", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toHaveText("우유");
  await page.evaluate(() => {
    delete window.__tote.backend.data.memos.a;
  });
  await outside(page, { kind: "removed", id: "a", file: "장보기.md" });
  await expect(page.locator(".banner")).toBeVisible();
  await menu(page, MOVE);
  await expect(page.locator(".status-message")).toHaveText(NOT_MOVED_WITH_BANNER);
  await expect(page.locator(".tab")).toHaveCount(1);
  expect((await data(page)).tornOff).toBeUndefined();
});

test("an external file's unsaved edits go with it as a draft", async ({ page }) => {
  await start(page, { files: { "/x/a.sh": fakeFile("echo hi\n") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".cm-content")).toContainText("echo hi");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.insertText("echo more");
  await menu(page, MOVE);
  await expect(page.locator(".tab")).toHaveCount(0);
  const { drafts, files, tornOff, watched, places } = await data(page);
  expect(drafts["/x/a.sh"].data).toBe(fakeFile("echo hi\necho more"));
  expect(files["/x/a.sh"]).toBe(fakeFile("echo hi\n"));
  expect(tornOff![0].tab).toMatchObject({ kind: "external", path: "/x/a.sh" });
  expect(places).toEqual({ "external:/x/a.sh": "ws-2" });
  // This window no longer watches it.
  expect(watched).toEqual({});
});

test("a tab never shown moves without being read", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(twoTabs),
    popupMenuPick: MOVE,
  });
  await expect(page.locator(".tab.active .tab-title")).toHaveText("나");
  await page.locator(".tab", { hasText: "가" }).click({ button: "right" });
  await expect(page.locator(".tab .tab-title")).toHaveText(["나"]);
  const { reads, tornOff } = await data(page);
  expect(reads).toEqual({ b: 1 });
  expect(tornOff![0].tab).toMatchObject({ kind: "memo", memoId: "a" });
});

test("the tab's context menu offers 탭을 새 창으로 옮기기", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") } });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await page.locator(".memo-row", { hasText: "나" }).click();
  await expect(page.locator(".tab")).toHaveCount(2);
  // Closed without a pick: nothing moves.
  await page.locator(".tab", { hasText: "가" }).click({ button: "right" });
  await expect
    .poll(async () => (await data(page)).popupMenus)
    .toEqual([
      [
        { id: "split-tab-left", text: "왼쪽으로 나누기" },
        { id: "split-tab-right", text: "오른쪽으로 나누기" },
        { id: "split-tab-top", text: "위로 나누기" },
        { id: "split-tab-bottom", text: "아래로 나누기" },
        { id: MOVE, text: "탭을 새 창으로 옮기기" },
      ],
    ]);
  await expect(page.locator(".tab")).toHaveCount(2);
  await page.evaluate((pick) => {
    window.__tote.backend.data.popupMenuPick = pick;
  }, MOVE);
  await page.locator(".tab", { hasText: "가" }).click({ button: "right" });
  await expect(page.locator(".tab .tab-title")).toHaveText(["나"]);
  expect((await data(page)).tornOff![0].tab).toMatchObject({ kind: "memo", memoId: "a" });
});

test("a viewer tab gives back its file token before it goes", async ({ page }) => {
  await start(page, { files: { "/x/점.png": fakeFile(PNG) }, picks: ["/x/점.png"] });
  await menu(page, "open-file");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  expect(Object.keys((await data(page)).tokens)).toHaveLength(1);
  await menu(page, MOVE);
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  expect((await data(page)).tokens).toEqual({});
});

test("a blank new memo moves without being deleted", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".tab")).toHaveCount(1);
  const [id] = Object.keys((await data(page)).memos);
  await menu(page, MOVE);
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(Object.keys((await data(page)).memos)).toEqual([id]);
  expect((await data(page)).tornOff![0].tab).toMatchObject({ kind: "memo", memoId: id });
});

test("a pane left without tabs closes", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(twoTabs),
  });
  await expect(page.locator(".tab")).toHaveCount(2);
  await menu(page, "split-pane");
  await expect(page.locator(".pane")).toHaveCount(2);
  await expect(page.locator(".pane").nth(1).locator(".tab .tab-title")).toHaveText(["나"]);
  await menu(page, MOVE);
  await expect(page.locator(".pane")).toHaveCount(1);
  await expect(page.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect(page.locator(".pane").first()).toHaveClass(/\bfocused\b/);
});

test("a composition in progress lands before its tab moves", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째") },
    session: JSON.stringify({
      version: 1,
      activeTab: 0,
      tabs: [
        { kind: "memo", memoId: "a", selection: { ranges: [{ anchor: 2, head: 2 }], main: 0 } },
      ],
    }),
  });
  await expect(page.locator(".cm-content")).toBeFocused();
  // The input method's events as tests/e2e/panes.spec.ts sends them; the move comes
  // mid-composition.
  const seen = await page.evaluate(async () => {
    const { app } = window.__tote;
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
    const moved = app.tearOff(app.focused.tabs.active!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The move waits for the composition to end.
    const movedEarly = window.__tote.backend.data.tornOff !== undefined;
    fire("beforeinput", "deleteCompositionText", null);
    write(from, from + 1, "");
    fire("input", "deleteCompositionText", null);
    await tick();
    fire("beforeinput", "insertFromComposition", "가");
    write(from, from, "가");
    fire("input", "insertFromComposition", "가");
    await tick();
    composition("compositionend", "가");
    return { composing, movedEarly, moved: await moved };
  });
  expect(seen).toEqual({ composing: true, movedEarly: false, moved: true });
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(await memoText(page, "a")).toBe("첫째가");
});

// Dragging a tab out of the window: a drop there tears it off as the menu item does, handing the
// backend the screen point it was let go at.

const tab = (page: Page, title: string) =>
  page.locator(".tab", { has: page.locator(".tab-title", { hasText: title }) });

test("a tab dropped outside every window opens in a new window there", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(twoTabs),
  });
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  const at = await dragOut(page, tab(page, "가"), false);
  // Out of the window: no mask, and the tab is left dimmed where it is.
  await expect(tab(page, "가")).toHaveClass(/\bdragging-out\b/);
  await expect(page.locator(".drop-mask")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(".tab .tab-title")).toHaveText(["나"]);
  const { tornOff, places } = await data(page);
  expect(tornOff).toEqual([{ tab: expect.objectContaining({ memoId: "a" }), at }]);
  expect(places).toMatchObject({ "memo:a": "ws-2" });
});

test("Esc outside the window calls the drag off", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(twoTabs),
  });
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await dragOut(page, tab(page, "가"), false);
  await expect(tab(page, "가")).toHaveClass(/\bdragging-out\b/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".tab.dragging-out")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await expect(page.locator(".pane")).toHaveCount(1);
  expect((await data(page)).tornOff).toBeUndefined();
});

test("a drag whose pointerup never came is called off by the next move without a button", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(twoTabs),
  });
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await dragOut(page, tab(page, "가"), false);
  await expect(tab(page, "가")).toHaveClass(/\bdragging-out\b/);
  // The release out there was lost: the pointer comes back with no button down, and a later click
  // would end with a pointerup on the pane's right edge.
  const edge = (await page.locator(".pane").boundingBox())!;
  const x = edge.x + edge.width - 4;
  const y = edge.y + edge.height / 2;
  await page.evaluate(
    ({ x, y }) => {
      for (const type of ["pointermove", "pointerup"])
        window.dispatchEvent(
          new PointerEvent(type, { pointerId: 1, buttons: 0, clientX: x, clientY: y }),
        );
    },
    { x, y },
  );
  await expect(page.locator(".tab.dragging-out")).toHaveCount(0);
  await expect(page.locator(".drop-mask")).toHaveCount(0);
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await expect(page.locator(".pane")).toHaveCount(1);
  expect((await data(page)).tornOff).toBeUndefined();
});

test("dragging back over the tab bar and letting go keeps the tab where it was", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(twoTabs),
  });
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  const box = (await tab(page, "가").boundingBox())!;
  await dragOut(page, tab(page, "가"), false);
  await expect(tab(page, "가")).toHaveClass(/\bdragging-out\b/);
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2, { steps: 8 });
  // Back in the window: no longer dimmed, it follows the pointer in its bar.
  await expect(page.locator(".tab.dragging-out")).toHaveCount(0);
  await expect(tab(page, "가")).toHaveClass(/(^|\s)dragging(\s|$)/);
  await page.mouse.up();
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await expect(page.locator(".pane")).toHaveCount(1);
  expect((await data(page)).tornOff).toBeUndefined();
});

test("a tab whose save fails stays when dropped outside", async ({ page }) => {
  await quietErrors(page, WRITE_FAILED);
  await typeInto(page, { failWrites: 1000 });
  await dragOut(page, tab(page, "장보기"));
  await expect(page.locator(".status-message")).toHaveText(NOT_MOVED);
  await expect(page.locator(".tab.active")).toHaveClass(/\bfailed\b/);
  await expect(page.locator(".tab.dragging-out")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
  const { tornOff, places } = await data(page);
  expect(tornOff).toBeUndefined();
  expect(places).toEqual({ "memo:a": "ws-1" });
});

test("a tab dragged out again while it is being written goes once", async ({ page }) => {
  await typeInto(page);
  const release = await hold(page, "tearOffGate");
  await dragOut(page, tab(page, "장보기"));
  // Written and on its way: the tab is still in the bar, and is dragged out once more.
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await dragOut(page, tab(page, "장보기"));
  await release();
  await expect(page.locator(".tab")).toHaveCount(0);
  // Past the memo save delay: anything the second drop set off has landed.
  await page.waitForTimeout(600);
  await expect(page.locator(".status-message")).not.toHaveText(/오류/);
  const { tornOff, places } = await data(page);
  expect(tornOff).toHaveLength(1);
  expect(places).toEqual({ "memo:a": "ws-2" });
  expect(await memoText(page, "a")).toBe("우유 계란");
});
