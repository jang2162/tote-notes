import { expect, test, type Locator, type Page } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import type { OutsideChange } from "../../src/backend/types";
import { boxOf, centre, menu, paneSession, start } from "./helpers";

// The find bar in the app: one bar per tab, in the pane that shows the tab, and kept open when
// the tab's file is read again after another app changed it.

const memos = {
  a: fakeMemo("가.md", "alpha one", { modifiedMs: 3 }),
  b: fakeMemo("나.md", "beta two", { modifiedMs: 2 }),
  c: fakeMemo("다.md", "gamma three", { modifiedMs: 1 }),
};
const memoTab = (memoId: string) => ({ kind: "memo", memoId });

const pane = (page: Page, index: number) => page.locator(".pane").nth(index);
const editor = (target: Locator) => target.locator(".cm-content");
const bar = (target: Locator) => target.locator(".find-bar");
const findInput = (target: Locator) => target.locator("input.find-bar-input[name=search]");
const replaceRow = (target: Locator) => target.locator(".find-bar-replace");
const tab = (target: Locator, title: string) =>
  target.locator(".tab", { has: target.page().locator(".tab-title", { hasText: title }) });

/** Puts the cursor in `target`'s editor and opens its bar with `keys`, then types `query`. */
async function search(target: Locator, query: string, keys = "Meta+f"): Promise<void> {
  await editor(target).click();
  await target.page().keyboard.press(keys);
  await expect(findInput(target)).toBeFocused();
  await findInput(target).fill(query);
}

/** Drags `from` to just inside the left end of `target`, as `tests/e2e/pane-drag.spec.ts` does:
 * a drop there lands before it. */
async function dragBefore(page: Page, from: Locator, target: Locator): Promise<void> {
  const start = await centre(from);
  const box = await boxOf(target);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("each tab keeps its own bar", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")]]) });
  const only = pane(page, 0);
  await expect(editor(only)).toHaveText("alpha one");
  await search(only, "alpha", "Meta+Alt+f");
  await expect(replaceRow(only)).toBeVisible();

  await tab(only, "나").click();
  await expect(editor(only)).toHaveText("beta two");
  await expect(bar(only)).toHaveCount(0);
  // This tab's bar opens folded: the first tab's replace row is its own.
  await search(only, "beta");
  await expect(replaceRow(only)).toBeHidden();

  await tab(only, "가").click();
  await expect(editor(only)).toHaveText("alpha one");
  await expect(bar(only)).toBeVisible();
  await expect(findInput(only)).toHaveValue("alpha");
  await expect(replaceRow(only)).toBeVisible();

  await tab(only, "나").click();
  await expect(findInput(only)).toHaveValue("beta");
  await expect(replaceRow(only)).toBeHidden();
});

test("two panes do not share a bar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: JSON.stringify({ version: 1, activeTab: 1, tabs: [memoTab("a"), memoTab("b")] }),
  });
  await menu(page, "split-pane");
  await expect(page.locator(".pane")).toHaveCount(2);
  await expect(editor(pane(page, 0))).toHaveText("alpha one");
  await expect(editor(pane(page, 1))).toHaveText("beta two");

  await search(pane(page, 0), "alpha");
  await expect(bar(pane(page, 0))).toBeVisible();
  await expect(bar(pane(page, 1))).toHaveCount(0);

  await search(pane(page, 1), "beta");
  await expect(findInput(pane(page, 0))).toHaveValue("alpha");
  await expect(findInput(pane(page, 1))).toHaveValue("beta");
});

test("the bar follows its tab to another pane", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: JSON.stringify({
      version: 1,
      activeTab: 1,
      tabs: [memoTab("a"), memoTab("b"), memoTab("c")],
    }),
  });
  await expect(editor(pane(page, 0))).toHaveText("beta two");
  await search(pane(page, 0), "beta");

  // Splitting moves the tab, and its bar, to the new pane.
  await menu(page, "split-pane");
  await expect(page.locator(".pane")).toHaveCount(2);
  await expect(editor(pane(page, 1))).toHaveText("beta two");
  await expect(bar(pane(page, 1))).toBeVisible();
  await expect(findInput(pane(page, 1))).toHaveValue("beta");
  await expect(editor(pane(page, 0))).not.toHaveText("beta two");
  await expect(bar(pane(page, 0))).toHaveCount(0);

  // Another tab joins the new pane, so it stays open once the first tab is dragged back.
  await dragBefore(page, tab(pane(page, 0), "다"), tab(pane(page, 1), "나"));
  await expect(editor(pane(page, 1))).toHaveText("gamma three");
  await expect(bar(pane(page, 1))).toHaveCount(0);

  // Dragged back, the bar comes along and leaves the pane it was in.
  await dragBefore(page, tab(pane(page, 1), "나"), tab(pane(page, 0), "가"));
  await expect(editor(pane(page, 0))).toHaveText("beta two");
  await expect(bar(pane(page, 0))).toBeVisible();
  await expect(findInput(pane(page, 0))).toHaveValue("beta");
  await expect(page.locator(".pane")).toHaveCount(2);
  await expect(editor(pane(page, 1))).toHaveText("gamma three");
  await expect(bar(pane(page, 1))).toHaveCount(0);
});

test("a reload keeps the bar open", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "alpha Alpha", { modifiedMs: 1 }) },
    session: paneSession([[memoTab("a")]]),
  });
  const only = pane(page, 0);
  await expect(editor(only)).toHaveText("alpha Alpha");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 0 } }));
  await search(only, "alpha", "Meta+Alt+f");
  await only.locator("button.find-bar-toggle[name=case]").click();
  await only.locator("input.find-bar-input[name=replace]").fill("z");
  await expect(only.locator(".find-bar-count")).toHaveText("– / 1");

  // Another app rewrites the memo; the tab reads it again as a new state.
  await page.evaluate((data) => {
    Object.assign(window.__tote.backend.data.memos.a, { data, modifiedMs: 900 });
  }, fakeFile("alpha alpha alpha Alpha"));
  const change: OutsideChange = { kind: "workspace", changes: [{ kind: "modified", id: "a" }] };
  await page.evaluate((c) => window.__tote.backend.outside(c), change);
  await expect(editor(only)).toHaveText("alpha alpha alpha Alpha");

  await expect(bar(only)).toBeVisible();
  await expect(findInput(only)).toHaveValue("alpha");
  await expect(only.locator("button.find-bar-toggle[name=case]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(replaceRow(only)).toBeVisible();
  await expect(only.locator("input.find-bar-input[name=replace]")).toHaveValue("z");
  // Counted in the new text, with 대소문자 구분 still on.
  await expect(only.locator(".find-bar-count")).toHaveText("– / 3");
});

test("a reload leaves a closed bar closed", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "alpha", { modifiedMs: 1 }) },
    session: paneSession([[memoTab("a")]]),
  });
  const only = pane(page, 0);
  await search(only, "alpha");
  await page.keyboard.press("Escape");
  await expect(bar(only)).toHaveCount(0);

  await page.evaluate((data) => {
    Object.assign(window.__tote.backend.data.memos.a, { data, modifiedMs: 900 });
  }, fakeFile("alpha alpha"));
  const change: OutsideChange = { kind: "workspace", changes: [{ kind: "modified", id: "a" }] };
  await page.evaluate((c) => window.__tote.backend.outside(c), change);
  await expect(editor(only)).toHaveText("alpha alpha");
  await expect(bar(only)).toHaveCount(0);
});

test("a reload in another pane leaves the focus where it is", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: JSON.stringify({ version: 1, activeTab: 1, tabs: [memoTab("a"), memoTab("b")] }),
  });
  await menu(page, "split-pane");
  await expect(page.locator(".pane")).toHaveCount(2);
  const left = pane(page, 0);
  const right = pane(page, 1);
  await expect(editor(left)).toHaveText("alpha one");
  await expect(editor(right)).toHaveText("beta two");
  await search(right, "beta");

  await editor(left).click();
  await expect(editor(left)).toBeFocused();

  // Another app rewrites the right pane's memo while the left pane is being typed in.
  await page.evaluate((data) => {
    Object.assign(window.__tote.backend.data.memos.b, { data, modifiedMs: 900 });
  }, fakeFile("beta beta"));
  const change: OutsideChange = { kind: "workspace", changes: [{ kind: "modified", id: "b" }] };
  await page.evaluate((c) => window.__tote.backend.outside(c), change);
  await expect(editor(right)).toHaveText("beta beta");
  await expect(findInput(right)).toHaveValue("beta");

  await expect(editor(left)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  await expect(editor(left)).toHaveText("alpha oneX");
  await expect(findInput(right)).toHaveValue("beta");
});
