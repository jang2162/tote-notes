import { expect, test, type Locator, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { boxOf, centre, layoutSession, paneSession, start } from "./helpers";

// What a tab bar shows while a tab is dragged over it, on the fake backend (spec 「탭 끌기와
// 마스크」, 「창 안에서 — 탭 바 위」): the tabs move aside into the place a drop would give it, and the
// drop gives it that place. The tabs slide there in 150ms; with reduced motion they are there at
// once, so a box read is where the tab is shown.

test.use({ reducedMotion: "reduce" });

const pane = (page: Page, index: number) => page.locator(".pane").nth(index);
const tab = (page: Page, index: number, title: string) =>
  pane(page, index).locator(".tab", { has: page.locator(".tab-title", { hasText: title }) });
const titles = (page: Page, index: number) => pane(page, index).locator(".tab .tab-title");
const mask = (page: Page) => page.locator(".drop-mask");
/** Tabs a preview has moved from their place. */
const moved = (page: Page) => page.locator('.tab[style*="translate"]');
const memoTab = (memoId: string) => ({ kind: "memo", memoId });

const memos = {
  a: fakeMemo("가.md", "첫째", { modifiedMs: 4 }),
  b: fakeMemo("나.md", "둘째", { modifiedMs: 3 }),
  c: fakeMemo("다.md", "셋째", { modifiedMs: 2 }),
  d: fakeMemo("라.md", "넷째", { modifiedMs: 1 }),
};

/** The titles of pane `index`'s tabs in the order they are shown, left to right: not their order
 * in the DOM, which a preview leaves be. */
function shownOrder(page: Page, index: number): Promise<string[]> {
  return pane(page, index)
    .locator(".tab")
    .evaluateAll((els) =>
      els
        .map((el) => ({
          left: el.getBoundingClientRect().left,
          title: el.querySelector(".tab-title")!.textContent!,
        }))
        .sort((a, b) => a.left - b.left)
        .map((each) => each.title),
    );
}

/** Where each of pane `index`'s tabs is shown, by title: its box's left and right edges. */
function edges(
  page: Page,
  index: number,
): Promise<Record<string, { left: number; right: number }>> {
  return pane(page, index)
    .locator(".tab")
    .evaluateAll((els) =>
      Object.fromEntries(
        els.map((el) => {
          const { left, right } = el.getBoundingClientRect();
          return [el.querySelector(".tab-title")!.textContent!, { left, right }];
        }),
      ),
    );
}

/** Presses on `from`'s middle and moves to `to` in steps, the button held. */
async function press(page: Page, from: Locator, to: { x: number; y: number }): Promise<void> {
  const start = await centre(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

/** Just inside the left end of `target`, at its height. */
async function before(target: Locator): Promise<{ x: number; y: number }> {
  const box = await boxOf(target);
  return { x: box.x + 4, y: box.y + box.height / 2 };
}

const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(1);

test("tabs move out of the way while a tab is dragged in its bar", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b"), memoTab("c")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  const was = await edges(page, 0);
  await press(page, tab(page, 0, "가"), await before(tab(page, 0, "다")));
  await expect.poll(() => shownOrder(page, 0)).toEqual(["나", "가", "다"]);
  const now = await edges(page, 0);
  // 나 takes 가's place; 다 stays, 가 is held at the pointer between them.
  near(now["나"].left, was["가"].left);
  near(now["다"].left, was["다"].left);
  await expect(tab(page, 0, "가")).toHaveClass(/(^|\s)dragging(\s|$)/);
  // Only the look: the tabs, and the order a screen reader reads them in, are as they were.
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  await expect(pane(page, 0).getByRole("tab")).toHaveText(["가", "나", "다"]);
  await expect(mask(page)).toHaveCount(0);
  await page.mouse.up();
});

test("dropping a tab puts it where the preview showed", async ({ page }) => {
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b"), memoTab("c"), memoTab("d")]]),
  });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다", "라"]);
  const target = await centre(tab(page, 0, "다"));
  await press(page, tab(page, 0, "나"), { x: target.x + 5, y: target.y });
  await expect.poll(() => shownOrder(page, 0)).toEqual(["가", "다", "나", "라"]);
  const shown = await edges(page, 0);
  await page.mouse.up();
  await expect(titles(page, 0)).toHaveText(["가", "다", "나", "라"]);
  await expect(moved(page)).toHaveCount(0);
  const after = await edges(page, 0);
  // The tabs it passed are where the preview had them; it is in the place they left it.
  for (const title of ["가", "다", "라"]) near(after[title].left, shown[title].left);
  near(after["나"].left, shown["다"].right);
});

test("a neighbour gives way once the dragged tab covers two thirds of it", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b"), memoTab("c")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  const was = await edges(page, 0);
  const from = await centre(tab(page, 0, "가"));
  const width = was["나"].right - was["나"].left;
  // 가's right edge starts at 나's left edge: moved by a part of 나's width, it covers that part.
  // Each step waits for 가 to be shown there (the pointer lands on whole pixels), so the order read
  // is the one for that place.
  const cover = async (part: number) => {
    await page.mouse.move(from.x + width * part, from.y, { steps: 4 });
    await expect
      .poll(async () =>
        Math.abs((await edges(page, 0))["가"].right - was["나"].left - width * part),
      )
      .toBeLessThanOrEqual(1);
  };
  await press(page, tab(page, 0, "가"), from);
  await cover(1 / 2);
  await expect(tab(page, 0, "가")).toHaveClass(/(^|\s)dragging(\s|$)/);
  expect(await shownOrder(page, 0)).toEqual(["가", "나", "다"]);
  await cover(2 / 3 - 3 / width);
  expect(await shownOrder(page, 0)).toEqual(["가", "나", "다"]);
  await cover(2 / 3 + 3 / width);
  expect(await shownOrder(page, 0)).toEqual(["나", "가", "다"]);
  await page.mouse.up();
  await expect(titles(page, 0)).toHaveText(["나", "가", "다"]);
});

test("a tab dragged past the bar's end drops last", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b"), memoTab("c")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  const was = await edges(page, 0);
  const last = await boxOf(tab(page, 0, "다"));
  // Past the last tab, over the bar's free space.
  await press(page, tab(page, 0, "가"), {
    x: last.x + last.width + 60,
    y: last.y + last.height / 2,
  });
  await expect.poll(() => shownOrder(page, 0)).toEqual(["나", "다", "가"]);
  // Held at the end, not at the pointer.
  near((await edges(page, 0))["가"].right, was["다"].right);
  await page.mouse.up();
  await expect(titles(page, 0)).toHaveText(["나", "다", "가"]);
});

test("another pane's bar opens a gap where the tab would go", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: paneSession([
      [memoTab("a"), memoTab("b")],
      [memoTab("c"), memoTab("d")],
    ]),
  });
  await expect(titles(page, 1)).toHaveText(["다", "라"]);
  const [home, there] = [await edges(page, 0), await edges(page, 1)];
  const width = home["나"].right - home["나"].left;
  await press(page, tab(page, 0, "나"), await before(tab(page, 1, "라")));
  // 라 steps right by 나's width; 다 stays.
  await expect
    .poll(async () => (await edges(page, 1))["라"].left)
    .toBeCloseTo(there["라"].left + width, 0);
  near((await edges(page, 1))["다"].left, there["다"].left);
  // In its own bar the tab stays where it is, dimmed, and so do the others.
  await expect(tab(page, 0, "나")).toHaveClass(/\bdragging-out\b/);
  await expect(tab(page, 0, "나")).not.toHaveClass(/(^|\s)dragging(\s|$)/);
  const nowHome = await edges(page, 0);
  for (const title of ["가", "나"]) near(nowHome[title].left, home[title].left);
  await expect(mask(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(titles(page, 1)).toHaveText(["다", "나", "라"]);
  await expect(page.locator(".tab.dragging-out")).toHaveCount(0);
  const after = await edges(page, 1);
  near(after["나"].left, there["라"].left);
  near(after["라"].left, there["라"].left + width);
});

test("leaving the bars puts every tab back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await start(page, {
    memos,
    session: paneSession([[memoTab("a"), memoTab("b"), memoTab("c")], [memoTab("d")]]),
  });
  await expect(titles(page, 1)).toHaveText(["라"]);
  const [home, there] = [await edges(page, 0), await edges(page, 1)];
  await press(page, tab(page, 0, "가"), await before(tab(page, 0, "다")));
  await expect.poll(() => shownOrder(page, 0)).toEqual(["나", "가", "다"]);
  // Over the other pane's bar: its own is as it was, the tab dimmed there, the gap opened here.
  const gap = await before(tab(page, 1, "라"));
  await page.mouse.move(gap.x, gap.y, { steps: 4 });
  await expect
    .poll(async () => (await edges(page, 1))["라"].left)
    .toBeGreaterThan(there["라"].left + 10);
  await expect(tab(page, 0, "가")).toHaveClass(/\bdragging-out\b/);
  const away = await edges(page, 0);
  for (const title of ["가", "나", "다"]) near(away[title].left, home[title].left);
  // Down into that pane's body: the mask, and every tab back where it was.
  const body = await boxOf(pane(page, 1).locator(".surface"));
  await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 4 });
  await expect(mask(page)).toHaveCount(1);
  await expect(moved(page)).toHaveCount(0);
  await expect(page.locator(".tab.dragging")).toHaveCount(0);
  near((await edges(page, 1))["라"].left, there["라"].left);
  const back = await edges(page, 0);
  for (const title of ["가", "나", "다"]) near(back[title].left, home[title].left);
  await page.mouse.up();
  // The mask's drop: the pane's last tab.
  await expect(titles(page, 1)).toHaveText(["라", "가"]);
});

test("Esc puts the tabs back", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b"), memoTab("c")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  const was = await edges(page, 0);
  await press(page, tab(page, 0, "가"), await before(tab(page, 0, "다")));
  await expect.poll(() => shownOrder(page, 0)).toEqual(["나", "가", "다"]);
  await page.keyboard.press("Escape");
  await expect(moved(page)).toHaveCount(0);
  await expect(page.locator(".tab.dragging")).toHaveCount(0);
  const now = await edges(page, 0);
  for (const title of ["가", "나", "다"]) near(now[title].left, was[title].left);
  await page.mouse.up();
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
});

test("a move with no button down calls the drag off and puts the tabs back", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b"), memoTab("c")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  const at = await before(tab(page, 0, "다"));
  await press(page, tab(page, 0, "가"), at);
  await expect.poll(() => shownOrder(page, 0)).toEqual(["나", "가", "다"]);
  // A release the page never heard of (let go out of the window): the next move has no button.
  await page.evaluate(
    ({ x, y }) =>
      window.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, buttons: 0, clientX: x, clientY: y }),
      ),
    at,
  );
  await expect(moved(page)).toHaveCount(0);
  await expect(page.locator(".tab.dragging")).toHaveCount(0);
  await page.mouse.up();
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
});

test("a tab bar drawn again during a drag shows the same preview", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b"), memoTab("c")]]) });
  await expect(titles(page, 0)).toHaveText(["가", "나", "다"]);
  await press(page, tab(page, 0, "가"), await before(tab(page, 0, "다")));
  await expect.poll(() => shownOrder(page, 0)).toEqual(["나", "가", "다"]);
  const shown = await edges(page, 0);
  // A save mark or a new title draws the bar again: new tab elements, with no transforms of their
  // own.
  await page.evaluate(() => window.__tote.app.panes[0].renderTabs());
  const now = await edges(page, 0);
  for (const title of ["가", "나", "다"]) near(now[title].left, shown[title].left);
  await expect(tab(page, 0, "가")).toHaveClass(/(^|\s)dragging(\s|$)/);
  await page.mouse.up();
  await expect(titles(page, 0)).toHaveText(["나", "가", "다"]);
});

test("a scrolled tab bar opens the gap and takes the tab where the pointer is", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const many = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `m${index}`,
      fakeMemo(`메모 제목이 길다 ${index}.md`, `${index}`, { modifiedMs: 8 - index }),
    ]),
  );
  const ids = Object.keys(many);
  // The right pane's last tab active: its bar is scrolled to it.
  await start(page, {
    memos: { ...memos, ...many },
    session: layoutSession({
      axis: "row",
      shares: [0.5, 0.5],
      children: [
        { tabs: [memoTab("a"), memoTab("b")], activeTab: 0 },
        { tabs: ids.map(memoTab), activeTab: ids.length - 1 },
      ],
    }),
  });
  const bar = pane(page, 1).locator(".tabbar");
  await expect(titles(page, 1)).toHaveCount(8);
  await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  const name = (index: number) => `메모 제목이 길다 ${index}`;
  const there = await edges(page, 1);
  const home = await edges(page, 0);
  const width = home["나"].right - home["나"].left;
  await press(page, tab(page, 0, "나"), await before(tab(page, 1, name(6))));
  // The gap is before the tab under the pointer: it and the one after it step right, no other.
  await expect
    .poll(async () => (await edges(page, 1))[name(6)].left)
    .toBeCloseTo(there[name(6)].left + width, 0);
  const now = await edges(page, 1);
  near(now[name(7)].left, there[name(7)].left + width);
  near(now[name(5)].left, there[name(5)].left);
  await page.mouse.up();
  await expect(titles(page, 1)).toHaveText(
    [0, 1, 2, 3, 4, 5].map(name).concat("나", name(6), name(7)),
  );
});

test("the tabs slide aside, at once for reduced motion", async ({ page }) => {
  await start(page, { memos, session: paneSession([[memoTab("a"), memoTab("b")]]) });
  const duration = () =>
    tab(page, 0, "나").evaluate((el) => getComputedStyle(el).transitionDuration);
  await expect.poll(duration).toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(duration).toBe("0.15s");
});
