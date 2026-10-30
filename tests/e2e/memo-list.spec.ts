import { expect, test, type Page } from "@playwright/test";

import { defaultFakeData, fakeMemo } from "../../src/backend/fake";
import { openWindow, paneSession, start, startWindows } from "./helpers";

// The sidebar's memo list (spec 2026-10-30 「메모 목록 기능 묶음」): renaming from a row's context
// menu, pins, the sort, previews and the filter that finds memos by their content.

const row = (page: Page, name: string) => page.locator(".memo-row", { hasText: name });
const names = (page: Page) => page.locator(".memo-scroller .memo-row .memo-name");
const lastMenu = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.popupMenus?.at(-1) ?? null);

async function renameFromRow(page: Page, from: string, to: string): Promise<void> {
  await row(page, from).click({ button: "right" });
  const input = page.locator(".modal input");
  await expect(input).toBeVisible();
  await input.fill(to);
  await input.press("Enter");
}

test("renaming a memo that is not open from its context menu", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }),
      b: fakeMemo("나.md", "둘째", { modifiedMs: 1, autoTitle: true }),
    },
    popupMenuPick: "rename",
  });
  await renameFromRow(page, "나", "다.md");
  await expect(names(page)).toHaveText(["가", "다"]);
  expect((await lastMenu(page))?.map((item) => item.text)[0]).toBe("이름 바꾸기…");
  const memo = await page.evaluate(() => window.__tote.backend.data.memos.b);
  expect(memo.file).toBe("다.md");
  expect(memo.autoTitle).toBe(false);
  await expect(page.locator(".tab")).toHaveCount(0);
});

test("renaming an open memo from the sidebar saves it first and renames its tab", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째") }, popupMenuPick: "rename" });
  await row(page, "가").click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 더");
  await renameFromRow(page, "가", "라.md");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("라");
  expect(await page.evaluate(() => window.__tote.backend.memoTextByFile("라.md"))).toBe("첫째 더");
});

test("a bad name from the sidebar shows the same error", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", ""), b: fakeMemo("나.md", "") },
    popupMenuPick: "rename",
  });
  await renameFromRow(page, "가", "나.md");
  await expect(page.locator(".status-message")).toHaveText("같은 이름이 이미 있습니다");
  await renameFromRow(page, "가", "a/b");
  await expect(page.locator(".status-message")).toHaveText("쓸 수 없는 이름입니다");
  expect(await page.evaluate(() => window.__tote.backend.data.memos.a.file)).toBe("가.md");
});

test("another window's rename reaches this window's open tab", async ({ context }) => {
  const first = await startWindows(context, {
    memos: { a: fakeMemo("가.md", "첫째", { autoTitle: true }) },
    popupMenuPick: "rename",
  });
  await row(first, "가").click();
  await expect(first.locator(".tab.active .tab-title")).toHaveText("가");
  const second = await openWindow(context, "ws-2");
  await renameFromRow(second, "가", "라.md");
  await expect(first.locator(".tab.active .tab-title")).toHaveText("라");
  // The first window's tab knows the name is the person's now: leaving it asks for no title.
  await first.locator(".cm-content").click();
  await first.keyboard.press("Enter");
  await first.keyboard.insertText("새 줄");
  await expect
    .poll(() => first.evaluate(() => window.__tote.backend.memoTextByFile("라.md")))
    .toBe("첫째\n새 줄");
});

const many = (count: number, pinned: (i: number) => boolean = () => false) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `m${i}`,
      {
        ...fakeMemo(`메모 ${i}.md`, "", { modifiedMs: count - i }),
        ...(pinned(i) ? { pinned: true } : {}),
      },
    ]),
  );

test("pinning a memo moves it to the zone above the list", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "", { modifiedMs: 2 }),
      b: fakeMemo("나.md", "", { modifiedMs: 1 }),
    },
    popupMenuPick: "pin",
  });
  await row(page, "나").click({ button: "right" });
  await expect(page.locator(".memo-pinned .memo-row .memo-name")).toHaveText(["나"]);
  await expect(names(page)).toHaveText(["가"]);
  await expect(page.locator(".memo-pinned .memo-row .memo-pin")).toHaveCount(1);
  expect((await lastMenu(page))?.map((item) => [item.id, item.text])).toEqual([
    ["rename", "이름 바꾸기…"],
    ["pin", "맨 위에 고정"],
  ]);
  expect(await page.evaluate(() => window.__tote.backend.data.memos.b.pinned)).toBe(true);
  await expect(page.locator(".memo-pinned-divider")).toBeVisible();

  await row(page, "나").click({ button: "right" });
  expect((await lastMenu(page))?.[1].text).toBe("고정 해제");
  await expect(names(page)).toHaveText(["가", "나"]);
  await expect(page.locator(".memo-pinned")).toBeHidden();
  await expect(page.locator(".memo-pinned-divider")).toBeHidden();
});

test("the pinned zone stays put while the list scrolls", async ({ page }) => {
  await start(page, { memos: many(200, (i) => i === 150) });
  const pinned = page.locator(".memo-pinned .memo-row");
  await expect(pinned.locator(".memo-name")).toHaveText("메모 150");
  const before = await pinned.boundingBox();
  await page.locator(".memo-scroller").evaluate((el) => (el.scrollTop = 2000));
  await expect(names(page).first()).not.toHaveText("메모 0");
  expect(await pinned.boundingBox()).toEqual(before);
});

test("the pinned zone scrolls on its own past 40% of the list", async ({ page }) => {
  await start(page, { memos: many(80, (i) => i < 40) });
  const sizes = await page.evaluate(() => {
    const zone = document.querySelector<HTMLElement>(".memo-pinned")!;
    const pane = document.querySelector<HTMLElement>(".memo-pane")!;
    return { zone: zone.clientHeight, scroll: zone.scrollHeight, pane: pane.clientHeight };
  });
  expect(sizes.zone).toBeLessThanOrEqual(sizes.pane * 0.4 + 1);
  expect(sizes.scroll).toBeGreaterThan(sizes.zone);
  await expect(names(page).first()).toBeVisible();
});

test("the pinned zone hides when no pinned memo matches the filter", async ({ page }) => {
  await start(page, {
    memos: { a: { ...fakeMemo("고정.md", ""), pinned: true }, b: fakeMemo("나머지.md", "") },
  });
  await expect(page.locator(".memo-pinned .memo-row")).toHaveCount(1);
  await page.locator(".memo-filter").fill("나머");
  await expect(page.locator(".memo-pinned")).toBeHidden();
  await expect(page.locator(".memo-pinned-divider")).toBeHidden();
  await expect(names(page)).toHaveText(["나머지"]);
  await page.locator(".memo-filter").fill("고정");
  await expect(page.locator(".memo-pinned .memo-row")).toHaveCount(1);
  await expect(names(page)).toHaveCount(0);
});

test("another window follows a pin", async ({ context }) => {
  const first = await startWindows(context, {
    memos: { a: fakeMemo("가.md", "") },
    popupMenuPick: "pin",
  });
  const second = await openWindow(context, "ws-2");
  await row(second, "가").click({ button: "right" });
  await expect(first.locator(".memo-pinned .memo-row")).toHaveCount(1);
});

test("an open memo stays pinned through its saves", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째") }, popupMenuPick: "pin" });
  await row(page, "가").click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await row(page, "가").click({ button: "right" });
  await expect(page.locator(".memo-pinned .memo-row")).toHaveCount(1);
  await page.locator(".cm-content").click();
  await page.keyboard.insertText("더");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("가.md")))
    .toContain("더");
  await expect(page.locator(".memo-pinned .memo-row")).toHaveCount(1);
});

const threeMemos = {
  a: fakeMemo("가.md", "첫째", { modifiedMs: 3 }),
  b: fakeMemo("나.md", "둘째", { modifiedMs: 2 }),
  c: fakeMemo("다.md", "셋째", { modifiedMs: 1 }),
};
const viewedOrder = { ...defaultFakeData().settings, sidebar: { sort: "viewed-desc" as const } };

test("the sort button picks one of six, the current one checked", async ({ page }) => {
  await start(page, { memos: threeMemos, popupMenuPick: "modified-asc" });
  await expect(names(page)).toHaveText(["가", "나", "다"]);
  await page.getByRole("button", { name: "정렬" }).click();
  await expect(names(page)).toHaveText(["다", "나", "가"]);
  expect(await lastMenu(page)).toEqual([
    { id: "modified-desc", text: "최근 수정순", checked: true },
    { id: "modified-asc", text: "오래된 수정순", checked: false },
    { id: "viewed-desc", text: "최근 조회순", checked: false },
    { id: "viewed-asc", text: "오래된 조회순", checked: false },
    { id: "name-asc", text: "이름순", checked: false },
    { id: "name-desc", text: "이름 역순", checked: false },
  ]);
  expect(await page.evaluate(() => window.__tote.backend.data.settings.sidebar.sort)).toBe(
    "modified-asc",
  );
  await page.evaluate(() => (window.__tote.backend.data.popupMenuPick = "name-desc"));
  await page.getByRole("button", { name: "정렬" }).click();
  await expect(names(page)).toHaveText(["다", "나", "가"]);
  expect((await lastMenu(page))?.find((item) => item.checked)?.id).toBe("modified-asc");
});

test("the viewed order follows what comes on show", async ({ page }) => {
  await start(page, { memos: threeMemos, settings: viewedOrder });
  await expect(names(page)).toHaveText(["가", "나", "다"]);
  await row(page, "다").click();
  await expect(names(page)).toHaveText(["다", "가", "나"]);
  await row(page, "나").click();
  await expect(names(page)).toHaveText(["나", "다", "가"]);
  // A click on a tab puts its memo first too.
  await page.locator(".tab", { hasText: "다" }).click();
  await expect(names(page)).toHaveText(["다", "나", "가"]);
  expect(await page.evaluate(() => window.__tote.backend.data.memoViewedCalls)).toEqual([
    "c",
    "b",
    "c",
  ]);
});

test("opening a memo under the viewed order re-sorts and keeps the scroll", async ({ page }) => {
  await start(page, { memos: many(200), settings: viewedOrder });
  const scroller = page.locator(".memo-scroller");
  await scroller.evaluate((el) => (el.scrollTop = 1400));
  await row(page, "메모 60").click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.memoViewedCalls))
    .toEqual(["m60"]);
  // Opened, it went first: the row at the top of the list is it, out of view up there.
  await expect(names(page).first()).not.toHaveText("메모 60");
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(1400);
  await scroller.evaluate((el) => (el.scrollTop = 0));
  await expect(names(page).first()).toHaveText("메모 60");
});

test("a restored active tab is not counted as viewed", async ({ page }) => {
  await start(page, {
    memos: threeMemos,
    settings: viewedOrder,
    session: paneSession([[{ kind: "memo", memoId: "c" }]]),
  });
  await expect(page.locator(".tab.active .tab-title")).toHaveText("다");
  await expect(names(page)).toHaveText(["가", "나", "다"]);
  expect(await page.evaluate(() => window.__tote.backend.data.memoViewedCalls ?? [])).toEqual([]);
});

test("another window's view re-sorts this one", async ({ context }) => {
  const first = await startWindows(context, { memos: threeMemos, settings: viewedOrder });
  const second = await openWindow(context, "ws-2");
  await row(second, "다").click();
  await expect(names(first)).toHaveText(["다", "가", "나"]);
});

test("another window's pick of order applies here", async ({ context }) => {
  const first = await startWindows(context, { memos: threeMemos, popupMenuPick: "name-desc" });
  const second = await openWindow(context, "ws-2");
  await second.getByRole("button", { name: "정렬" }).click();
  await expect(names(first)).toHaveText(["다", "나", "가"]);
});
