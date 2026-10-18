import { expect, test, type Locator, type Page } from "@playwright/test";

import { LONG_LINE_LIMIT, RECOVERED_NOTICE } from "../../src/app/docs";
import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, quietErrors, ready, sessionPane, start } from "./helpers";

test("a new memo is named after its first line once the cursor leaves it", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("# 회의 준비");
  await page.keyboard.press("Enter");
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["회의 준비"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("회의 준비");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("회의 준비.md")))
    .toBe("# 회의 준비\n");
});

test("closing an empty new memo leaves no file behind", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".tab")).toHaveCount(1);
  await menu(page, "close-tab");
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(window.__tote.backend.data.memos))).toEqual([]);
  await expect(page.locator(".editor-placeholder")).toHaveText("⌘N 으로 새 메모를 만드세요");
});

test("restoring a session reads only the active tab", async ({ page }) => {
  const session = {
    version: 1,
    activeTab: 1,
    tabs: [
      { kind: "memo", memoId: "a" },
      { kind: "memo", memoId: "b", selection: { ranges: [{ anchor: 1, head: 1 }], main: 0 } },
    ],
  };
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(session),
  });
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("나");
  expect(await page.evaluate(() => window.__tote.backend.data.reads)).toEqual({ b: 1 });
  expect(await page.evaluate(() => window.__tote.app.view.state.selection.main.head)).toBe(1);
  await page.locator(".tab", { hasText: "가" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.reads))
    .toEqual({ a: 1, b: 1 });
});

test("tabs, the active tab and the cursor come back after a restart", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째 줄\n둘째 줄") } });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await expect(page.locator(".cm-content")).toContainText("둘째 줄");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 6 } }));
  await expect
    .poll(async () => (await sessionPane(page)).tabs[0]?.selection?.ranges[0].anchor)
    .toBe(6);
  await page.reload();
  await ready(page);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("가");
  expect(await page.evaluate(() => window.__tote.app.view.state.selection.main.head)).toBe(6);
});

test("a flush request writes pending edits and the title before answering", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  // One insert: a fast second key on an empty line can land first in WebKit (real input: Task 16).
  await page.keyboard.insertText("급히 끈다");
  await page.evaluate(() => window.__tote.backend.requestFlush(7));
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed))
    .toEqual([{ id: 7 }]);
  const files = await page.evaluate(() =>
    Object.values(window.__tote.backend.data.memos).map((m) => m.file),
  );
  expect(files).toEqual(["급히 끈다.md"]);
  expect(await page.evaluate(() => window.__tote.backend.memoTextByFile("급히 끈다.md"))).toBe(
    "급히 끈다",
  );
  expect((await sessionPane(page)).tabs.map((tab) => tab.kind)).toEqual(["memo"]);
});

test("the memo list filters by name", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("회의록.md", ""), b: fakeMemo("장보기.md", "") } });
  await page.locator(".memo-filter").fill("회의");
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["회의록"]);
});

test("a memo the person renamed keeps that name", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  // One insert: a fast second key on an empty line can land first in WebKit (real input: Task 16).
  await page.keyboard.insertText("첫 줄");
  await menu(page, "rename");
  const input = page.locator(".modal input");
  await input.fill("목록.txt");
  await input.press("Enter");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("목록.txt");
  // Leaving the title line is when an automatic title would apply.
  await page.keyboard.press("Enter");
  // One insert: a fast second key on an empty line can land first in WebKit (real input: Task 16).
  await page.keyboard.insertText("둘째 줄");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("목록.txt")))
    .toBe("첫 줄\n둘째 줄");
  const files = await page.evaluate(() =>
    Object.values(window.__tote.backend.data.memos).map((m) => m.file),
  );
  expect(files).toEqual(["목록.txt"]);
});

test("a memo gone from disk says so, without 텍스트로 열기", async ({ page }) => {
  const session = {
    version: 1,
    activeTab: 0,
    tabs: [
      { kind: "memo", memoId: "a" },
      { kind: "memo", memoId: "b" },
    ],
  };
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(session),
  });
  // Deleted in Finder while its tab waited to be read.
  await page.evaluate(() => {
    delete window.__tote.backend.data.memos.b;
  });
  await page.locator(".tab", { hasText: "나" }).click();
  await expect(page.locator(".editor-placeholder p")).toHaveText("파일을 찾을 수 없습니다");
  await expect(page.getByRole("button", { name: "텍스트로 열기" })).toHaveCount(0);
});

test("recovering a vanished memo moves the sidebar highlight to the new memo", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째") } });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await expect(page.locator(".memo-row.active")).toHaveCount(1);
  await expect(page.locator(".cm-content")).toBeFocused();
  // Deleted in Finder while the tab was open: the next save makes a new memo of the text.
  await page.evaluate(() => delete window.__tote.backend.data.memos.a);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.insertText(" 둘");
  await expect(page.locator(".status-message")).toHaveText(RECOVERED_NOTICE);
  // Coming back to the window lists the folder again: only the new memo is left in it.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["가"]);
  await expect(page.locator(".memo-row.active")).toHaveCount(1);
});

type SlowCall = "readMemo" | "openExternal" | "scanText" | "issueFileToken";

/** The app calls the backend over IPC, the fake answers at once: without a delay there is never
 * a moment between a tab switch and what the tab shows. */
async function slowCalls(page: Page, ...names: SlowCall[]): Promise<void> {
  await page.evaluate((names) => {
    const backend = window.__tote.backend as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    for (const name of names) {
      const call = backend[name];
      backend[name] = async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return call.apply(backend, args);
      };
    }
  }, names);
}

const slowReads = (page: Page) => slowCalls(page, "readMemo", "openExternal");

// A tab still reading its file is not yet in the editor; keys typed meanwhile must not land in
// the tab left behind, which would save them into a document the person no longer sees. They are
// dropped: the new tab's exact text also shows a run whose keys came after the read.
test("keys typed while a file opened with ⌘O loads do not reach the tab left, nor its memo", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("a.txt", "AAA") },
    files: { "/x/n.md": fakeFile("# 새") },
    picks: ["/x/n.md"],
  });
  await page.locator(".memo-row", { hasText: "a" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Meta+ArrowDown");
  await slowReads(page);
  await menu(page, "open-file");
  await page.keyboard.type("xy");
  await expect(page.locator(".cm-content")).toHaveText("# 새");
  await page.waitForTimeout(700); // past the memo's save delay
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("AAA");
  await page.locator(".memo-row", { hasText: "a" }).click();
  await expect(page.locator(".cm-content")).toHaveText("AAA");
});

// A guard, not evidence for the fix: clicking a row already takes the focus off the editor, so
// this passed before it too.
test("guard: keys typed while a memo picked in the list loads do not reach the tab left", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("a.txt", "AAA"), b: fakeMemo("b.md", "# 둘") } });
  await page.locator(".memo-row", { hasText: "a" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Meta+ArrowDown");
  await slowReads(page);
  await page.locator(".memo-row", { hasText: "b" }).click();
  await page.keyboard.type("xy");
  await expect(page.locator(".cm-content")).toHaveText("# 둘");
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("AAA");
  await page.locator('.memo-row[title="a.txt"]').click();
  await expect(page.locator(".cm-content")).toHaveText("AAA");
});

test("keys typed while a restored tab picked in the tab bar loads do not reach the tab left", async ({
  page,
}) => {
  const session = {
    version: 1,
    activeTab: 0,
    tabs: [
      { kind: "memo", memoId: "a" },
      { kind: "memo", memoId: "b" },
    ],
  };
  await start(page, {
    memos: { a: fakeMemo("a.txt", "AAA"), b: fakeMemo("b.md", "# 둘") },
    session: JSON.stringify(session),
  });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await slowReads(page);
  // The title, not the tab: the middle of a short tab is its close button.
  await page.locator(".tab-title", { hasText: "b" }).click();
  await page.keyboard.type("xy");
  await expect(page.locator(".cm-content")).toHaveText("# 둘");
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("AAA");
  await page.locator(".tab-title", { hasText: "a.txt" }).click();
  await expect(page.locator(".cm-content")).toHaveText("AAA");
});

// A tab shown as something other than the editor: the view must not keep the tab left either.

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** Memo `b` is already open and shown as `shown`; from memo `a` (focused, cursor at the end) ⌘⇧]
 * goes to `b` and keys are typed there — once `b` is on show, or with `early` at once, while the
 * `slow` backend calls of showing it are still on their way. Memo `a` must come back as it was. */
async function typeAfterKeyboardSwitch(
  page: Page,
  b: { file: string; autoTitle: boolean; data: string; modifiedMs: number },
  shown: (page: Page) => Locator,
  options: { prepare?: (page: Page) => Promise<void>; early?: boolean; slow?: SlowCall[] } = {},
): Promise<void> {
  const { prepare = async () => {}, early = false, slow = [] } = options;
  await start(page, { memos: { a: fakeMemo("a.txt", "AAA"), b } });
  await page.locator(`.memo-row[title="${b.file}"]`).click();
  await prepare(page);
  await expect(shown(page)).toBeVisible();
  await page.locator('.memo-row[title="a.txt"]').click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Meta+ArrowDown");
  await slowCalls(page, ...slow);
  await menu(page, "next-tab");
  if (!early) await expect(shown(page)).toBeVisible();
  await page.keyboard.type("xy");
  await expect(shown(page)).toBeVisible();
  await page.waitForTimeout(700); // past the memo's save delay
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("AAA");
  await page.locator('.memo-row[title="a.txt"]').click();
  await expect(page.locator(".cm-content")).toHaveText("AAA");
}

test("keys typed in a tab showing its preview do not reach the tab left", async ({ page }) => {
  await typeAfterKeyboardSwitch(
    page,
    fakeMemo("b.md", "# 둘"),
    (page) => page.locator("iframe.viewer-frame"),
    { prepare: (page) => menu(page, "toggle-preview") },
  );
});

test("keys typed in a tab showing a viewer do not reach the tab left", async ({ page }) => {
  await typeAfterKeyboardSwitch(
    page,
    { file: "pic.png", autoTitle: false, data: fakeFile(PNG), modifiedMs: 1 },
    (page) => page.locator("iframe.viewer-frame"),
  );
});

test("keys typed in a tab showing the large text viewer do not reach the tab left", async ({
  page,
}) => {
  await typeAfterKeyboardSwitch(
    page,
    fakeMemo("long.txt", "L".repeat(LONG_LINE_LIMIT + 1)),
    (page) => page.locator(".large-text"),
  );
});

test("keys typed in a tab showing a placeholder do not reach the tab left", async ({ page }) => {
  await typeAfterKeyboardSwitch(
    page,
    {
      file: "latin1.txt",
      autoTitle: false,
      data: fakeFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9])),
      modifiedMs: 1,
    },
    (page) => page.locator(".editor-placeholder p", { hasText: "텍스트로 열 수 없음" }),
  );
});

// The switch itself lets go of the tab left: keys typed before the new tab is on show (a token,
// a scan of a large file, a viewer page on its way) are dropped, whatever that tab shows.
test("keys typed while a large text tab gets its viewer do not reach the tab left", async ({
  page,
}) => {
  await typeAfterKeyboardSwitch(
    page,
    fakeMemo("long.txt", "L".repeat(LONG_LINE_LIMIT + 1)),
    (page) => page.locator(".large-text"),
    { early: true, slow: ["scanText", "issueFileToken"] },
  );
});

test("keys typed while a viewer tab gets its file do not reach the tab left", async ({ page }) => {
  await typeAfterKeyboardSwitch(
    page,
    { file: "pic.png", autoTitle: false, data: fakeFile(PNG), modifiedMs: 1 },
    (page) => page.locator("iframe.viewer-frame"),
    { early: true, slow: ["issueFileToken"] },
  );
});

test("keys typed while a preview tab's viewer starts do not reach the tab left", async ({
  page,
}) => {
  await typeAfterKeyboardSwitch(
    page,
    fakeMemo("b.md", "# 둘"),
    (page) => page.locator("iframe.viewer-frame"),
    { prepare: (page) => menu(page, "toggle-preview"), early: true },
  );
});

test("keys typed after ⇧⌘V turns the tab to its preview do not edit the hidden text", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("a.md", "# 하나") } });
  await page.locator('.memo-row[title="a.md"]').click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Meta+ArrowDown");
  await menu(page, "toggle-preview");
  await expect(page.locator("iframe.viewer-frame")).toBeVisible();
  await page.keyboard.type("xy");
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("# 하나");
  await menu(page, "toggle-preview");
  await expect(page.locator(".cm-content")).toHaveText("# 하나");
});

test("another window's change to the memo list shows here", async ({ page }) => {
  await start(page);
  const calls = () => page.evaluate(() => window.__tote.backend.data.listMemosCalls ?? 0);
  const before = await calls();
  await page.evaluate(
    (memo) => {
      const backend = window.__tote.backend;
      backend.data.memos["from-other-window"] = memo;
      backend.memosChanged();
      backend.memosChanged();
      backend.memosChanged();
    },
    fakeMemo("다른 창.md", "다른 창에서 만든 메모"),
  );
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["다른 창"]);
  // Past the 300ms the three were gathered in: still one listing.
  await page.waitForTimeout(500);
  expect(await calls()).toBe(before + 1);
});

test("a memo still opens when claiming its place fails", async ({ page }) => {
  await quietErrors(page, "claim refused");
  await start(page, { memos: { a: fakeMemo("가.md", "첫째") } });
  await page.evaluate(() => {
    window.__tote.backend.claimTabs = () => Promise.reject(new Error("claim refused"));
  });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await expect(page.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect(page.locator(".cm-content")).toHaveText("첫째");
});
