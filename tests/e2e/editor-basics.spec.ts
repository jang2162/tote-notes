import { expect, test, type Page } from "@playwright/test";

import { WRAP_LIMIT } from "../../src/app/docs";
import { defaultFakeData, fakeMemo } from "../../src/backend/fake";
import { DEFAULT_EDITOR_SETTINGS, type SettingsPatch } from "../../src/backend/types";
import { menu, nextWindow, paneSession, start, startWindows } from "./helpers";

// Editor basics spec: bracket matching, the wrap and indent settings, the character count, folding.

const memos = {
  a: fakeMemo("가.md", "if x:\n  y\nz", { modifiedMs: 2 }),
  b: fakeMemo("나.txt", "(a [b] c)", { modifiedMs: 1 }),
};
const openA = paneSession([[{ kind: "memo", memoId: "a" }]]);

/** What the settings screen does for another window: save, then the backend's change event. */
function patch(page: Page, change: SettingsPatch): Promise<void> {
  return page.evaluate((c) => window.__tote.backend.patchSettings(c), change);
}

const text = (page: Page) => page.evaluate(() => window.__tote.app.view.state.doc.toString());
const wraps = (page: Page) =>
  page.locator(".cm-content").evaluate((el) => el.classList.contains("cm-lineWrapping"));

/** Puts the cursor at `at` in the focused editor, or selects `at`..`to`. */
async function select(page: Page, at: number, to = at): Promise<void> {
  await page.evaluate(
    ([anchor, head]) => {
      const { view } = window.__tote.app;
      view.focus();
      view.dispatch({ selection: { anchor, head } });
    },
    [at, to] as const,
  );
}

test("the settings screen's editor settings apply in every window at once", async ({ context }) => {
  const first = await startWindows(context, { memos, session: openA });
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await second.locator(".memo-row", { hasText: "나" }).click();
  await expect(second.locator(".cm-content")).toHaveText("(a [b] c)");
  for (const page of [first, second]) {
    expect(await wraps(page)).toBe(true);
    await expect(page.locator(".cm-foldGutter")).toHaveCount(1);
    await expect(page.locator(".status-count")).toBeEmpty();
  }

  await menu(first, "settings");
  const panel = first.locator(".modal.settings");
  await panel.getByRole("tab", { name: "모양", exact: true }).click();
  // The default is the editor as it was: wrapping, two spaces, markers, no count.
  await expect(panel.getByRole("checkbox", { name: "줄 바꿈" })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "접기 표시" })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "글자 수 보이기" })).not.toBeChecked();
  await expect(panel.getByRole("combobox", { name: "들여쓰기" })).toHaveValue("spaces-2");
  await expect(panel.getByRole("combobox", { name: "들여쓰기" }).locator("option")).toHaveText([
    "공백 2",
    "공백 4",
    "탭",
  ]);

  await panel.getByRole("checkbox", { name: "줄 바꿈" }).uncheck();
  await panel.getByRole("checkbox", { name: "접기 표시" }).uncheck();
  await panel.getByRole("checkbox", { name: "글자 수 보이기" }).check();
  await panel.getByRole("combobox", { name: "들여쓰기" }).selectOption("tab");
  for (const page of [first, second]) {
    await expect.poll(() => wraps(page)).toBe(false);
    await expect(page.locator(".cm-foldGutter")).toHaveCount(0);
    await expect(page.locator(".status-count")).not.toBeEmpty();
  }
  await expect(second.locator(".status-count")).toHaveText("9자");
  // The indent setting reached the other window's editor.
  await select(second, 0);
  await second.keyboard.press("Tab");
  expect(await text(second)).toBe("\t(a [b] c)");
  const saved = await first.evaluate(() => window.__tote.backend.settings());
  expect(saved.editor).toMatchObject({
    wrap: false,
    foldGutter: false,
    charCount: true,
    indent: "tab",
  });
});

test("보기 › 줄 바꿈 switches the setting, and a line over the limit never wraps", async ({
  page,
}) => {
  await start(page, {
    memos: { ...memos, c: fakeMemo("다.txt", "x".repeat(WRAP_LIMIT + 1), { modifiedMs: 0 }) },
    session: openA,
  });
  expect(await wraps(page)).toBe(true);
  await menu(page, "toggle-wrap");
  await expect.poll(() => wraps(page)).toBe(false);
  expect((await page.evaluate(() => window.__tote.backend.settings())).editor.wrap).toBe(false);
  // Tabs not shown follow too.
  await page.locator(".memo-row", { hasText: "나" }).click();
  await expect(page.locator(".cm-content")).toHaveText("(a [b] c)");
  expect(await wraps(page)).toBe(false);
  await menu(page, "toggle-wrap");
  await expect.poll(() => wraps(page)).toBe(true);
  expect((await page.evaluate(() => window.__tote.backend.settings())).editor.wrap).toBe(true);
  await page.locator(".memo-row", { hasText: "다" }).click();
  await expect(page.locator(".tab.active")).toContainText("다.txt");
  await expect.poll(() => text(page).then((t) => t.length)).toBe(WRAP_LIMIT + 1);
  expect(await wraps(page)).toBe(false);
});

test("Tab puts in the indent the setting chose", async ({ page }) => {
  await start(page, { memos, session: openA });
  // The text goes back to 「x」 before each press, so a press the setting has not reached yet is
  // tried again rather than piling up.
  const tabAfterX = async () => {
    await page.evaluate(() => {
      const { view } = window.__tote.app;
      view.focus();
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "x" },
        selection: { anchor: 1 },
      });
    });
    await page.keyboard.press("Tab");
    return text(page);
  };
  expect(await tabAfterX()).toBe("x  ");
  await patch(page, { editorIndent: "spaces-4" });
  await expect.poll(tabAfterX).toBe("x    ");
  await patch(page, { editorIndent: "tab" });
  await expect.poll(tabAfterX).toBe("x\t");
  await patch(page, { editorIndent: "spaces-2" });
  await expect.poll(tabAfterX).toBe("x  ");
});

test("a fold marker folds its block, with the line numbers off too, and ⌥⌘[ folds a heading", async ({
  page,
}) => {
  await start(page, {
    memos: {
      ...memos,
      d: fakeMemo("라.md", "# 하나\n본문\n## 둘\n더\n# 셋\n끝", { modifiedMs: 0 }),
    },
    session: openA,
  });
  await patch(page, { editorLineNumbers: false });
  await expect(page.locator(".cm-lineNumbers")).toHaveCount(0);
  await expect(page.locator(".cm-foldGutter")).toHaveCount(1);
  await expect(page.locator(".cm-line")).toHaveText(["if x:", "  y", "z"]);
  await page.locator('.cm-foldGutter span[title="접기"]').first().click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await expect(page.locator(".cm-line")).toHaveCount(2);
  // The gutter's hidden spacer is a marker too.
  await expect(
    page.locator('.cm-foldGutter span[title="펴기"]').filter({ visible: true }),
  ).toHaveCount(1);
  await page.locator(".cm-foldPlaceholder").click();
  await expect(page.locator(".cm-line")).toHaveText(["if x:", "  y", "z"]);

  await page.locator(".memo-row", { hasText: "라" }).click();
  await expect(page.locator(".cm-line")).toHaveCount(6);
  await select(page, 2);
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await expect(page.locator(".cm-line")).toHaveText(["# 하나…", "# 셋", "끝"]);
  await page.keyboard.press("Meta+Alt+BracketRight");
  await expect(page.locator(".cm-line")).toHaveCount(6);
});

test("the bracket at the cursor and its match are marked; one with no match is too", async ({
  page,
}) => {
  await start(page, {
    memos: { ...memos, e: fakeMemo("마.txt", "(a", { modifiedMs: 0 }) },
    session: paneSession([[{ kind: "memo", memoId: "b" }]]),
  });
  await select(page, 3);
  await expect(page.locator(".cm-matchingBracket")).toHaveText(["[", "]"]);
  await select(page, 0);
  await expect(page.locator(".cm-matchingBracket")).toHaveText(["(", ")"]);
  await page.locator(".memo-row", { hasText: "마" }).click();
  await select(page, 0);
  await expect(page.locator(".cm-nonmatchingBracket")).toHaveText("(");
});

test("the character count shows only with its setting on, and counts the selection", async ({
  page,
}) => {
  await start(page, {
    memos: { f: fakeMemo("바.md", "가나다 👍🏽\n한글", { modifiedMs: 0 }) },
    session: paneSession([[{ kind: "memo", memoId: "f" }]]),
  });
  await expect(page.locator(".status-position")).not.toBeEmpty();
  await expect(page.locator(".status-count")).toBeEmpty();
  await patch(page, { editorCharCount: true });
  await expect(page.locator(".status-count")).toHaveText("7자");
  await select(page, 0, 2);
  await expect(page.locator(".status-count")).toHaveText("선택 2자");
  await select(page, 0);
  await expect(page.locator(".status-count")).toHaveText("7자");
  await page.keyboard.type("ab");
  await expect(page.locator(".status-count")).toHaveText("9자");
  await patch(page, { editorCharCount: false });
  await expect(page.locator(".status-count")).toBeEmpty();
});

test("the line number of a folded block selects every line it holds", async ({ page }) => {
  await start(page, { memos, session: openA });
  await page.locator('.cm-foldGutter span[title="접기"]').first().click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await page.locator(".cm-lineNumbers .cm-gutterElement", { hasText: /^1$/ }).click();
  const selection = await page.evaluate(() => {
    const { main } = window.__tote.app.view.state.selection;
    return [main.from, main.to];
  });
  // 「if x:\n  y」: the folded line goes with its head, up to the line break before 「z」.
  expect(selection).toEqual([0, 9]);
});

test("saved editor settings apply from the start, in a new window too", async ({ context }) => {
  const settings = defaultFakeData().settings;
  settings.editor = {
    ...DEFAULT_EDITOR_SETTINGS,
    charCount: true,
    wrap: false,
    indent: "tab",
    foldGutter: false,
  };
  const first = await startWindows(context, { memos, session: openA, settings });
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await second.locator(".memo-row", { hasText: "나" }).click();
  await expect(second.locator(".cm-content")).toHaveText("(a [b] c)");
  await expect(first.locator(".status-count")).toHaveText("9자");
  await expect(second.locator(".status-count")).toHaveText("9자");
  for (const page of [first, second]) {
    expect(await wraps(page)).toBe(false);
    await expect(page.locator(".cm-foldGutter")).toHaveCount(0);
    await select(page, 0);
    await page.keyboard.press("Tab");
    await expect.poll(() => text(page).then((t) => t[0])).toBe("\t");
  }
});

test("with the count off the status bar is laid out as before it, one gap between its items", async ({
  page,
}) => {
  await start(page, { memos, session: openA });
  await expect(page.locator(".status-position")).not.toBeEmpty();
  const gap = (from: string, to: string) =>
    page.evaluate(
      ([a, b]) =>
        document.querySelector(b)!.getBoundingClientRect().left -
        document.querySelector(a)!.getBoundingClientRect().right,
      [from, to] as const,
    );
  const between = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector(".statusbar")!).columnGap),
  );
  expect(between).toBe(16);
  expect(await gap(".status-position", ".status-language")).toBe(between);
  await patch(page, { editorCharCount: true });
  await expect(page.locator(".status-count")).toHaveText("9자");
  expect(await gap(".status-position", ".status-count")).toBe(between);
  expect(await gap(".status-count", ".status-language")).toBe(between);
});
