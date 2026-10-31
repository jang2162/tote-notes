import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import {
  openShopping,
  openWindow,
  quietErrors,
  start,
  startWindows,
  typeWhileChangedElsewhere,
} from "./helpers";

// The memo trash (spec 2026-11-01 「휴지통으로 옮기기」) on the fake backend: what goes into
// `data.trash`, and what stays when it must not go.

const NOT_TRASHED = "저장하지 못해 휴지통으로 옮기지 않았습니다";
const WRITE_FAILED = "no space left on device";

const row = (page: Page, name: string) => page.locator(".memo-row", { hasText: name });
const lastMenu = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.popupMenus?.at(-1) ?? null);
const trash = (page: Page) => page.evaluate(() => window.__tote.backend.data.trash ?? {});
const trashedText = (page: Page, id: string) =>
  page.evaluate((memo) => window.__tote.backend.trashedText(memo), id);

/** Opens 장보기 (우유) with the cursor after 우유 and types behind it. */
async function typeInto(page: Page, seed: Parameters<typeof start>[1] = {}): Promise<void> {
  await openShopping(page, seed);
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 계란");
}

test("the memo menu ends with a separator and 휴지통으로 이동", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }),
      b: { ...fakeMemo("나.md", "둘째", { modifiedMs: 1 }), pinned: true },
    },
    popupMenuPick: null,
  });
  const ending = [{ separator: true }, { id: "trash", text: "휴지통으로 이동" }];
  await row(page, "가").click({ button: "right" });
  await expect.poll(async () => (await lastMenu(page))?.slice(-2)).toMatchObject(ending);
  // A row of the pinned zone has it too.
  await page.locator(".memo-pinned .memo-row", { hasText: "나" }).click({ button: "right" });
  await expect.poll(async () => (await lastMenu(page))?.[0].text).toBe("이름 바꾸기…");
  expect(await page.evaluate(() => window.__tote.backend.data.popupMenus?.length)).toBe(2);
  expect((await lastMenu(page))?.slice(-2)).toMatchObject(ending);
  // Nothing was picked: both stay.
  await expect(page.locator(".memo-row")).toHaveCount(2);
});

test("trashing moves the memo out of the list without asking", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }), b: fakeMemo("나.md", "둘째") },
    popupMenuPick: "trash",
  });
  await row(page, "가").click({ button: "right" });
  await expect(row(page, "가")).toHaveCount(0);
  await expect(row(page, "나")).toHaveCount(1);
  await expect(page.locator(".modal")).toHaveCount(0);
  expect(Object.keys(await trash(page))).toEqual(["a"]);
  expect(await trashedText(page, "a")).toBe("첫째");
  expect(await page.evaluate(() => Object.keys(window.__tote.backend.data.memos))).toEqual(["b"]);
});

test("trashing an open memo saves its last edit first and closes its tab", async ({ page }) => {
  await typeInto(page, { popupMenuPick: "trash" });
  // At once, before the save's timer: the trash takes the text as typed.
  await row(page, "장보기").click({ button: "right" });
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect(row(page, "장보기")).toHaveCount(0);
  expect(await trashedText(page, "a")).toBe("우유 계란");
  expect(await page.evaluate(() => window.__tote.backend.data.places)).toEqual({});
});

test("a memo whose save failed is not trashed", async ({ page }) => {
  await quietErrors(page, WRITE_FAILED);
  // Every write fails: the save tried before the move fails too.
  await typeInto(page, { failWrites: 1000, popupMenuPick: "trash" });
  await row(page, "장보기").click({ button: "right" });
  await expect(page.locator(".status-message")).toHaveText(NOT_TRASHED);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
  await expect(row(page, "장보기")).toHaveCount(1);
  expect(await trash(page)).toEqual({});
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("우유");
});

test("a memo with a conflict banner open is not trashed", async ({ page }) => {
  await typeWhileChangedElsewhere(page);
  await expect(page.locator(".banner")).toBeVisible();
  await page.evaluate(() => (window.__tote.backend.data.popupMenuPick = "trash"));
  await row(page, "장보기").click({ button: "right" });
  await expect(page.locator(".status-message")).toHaveText(NOT_TRASHED);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".banner")).toBeVisible();
  expect(await trash(page)).toEqual({});
  // Neither side of the conflict was written over.
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("두유");
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
});

test("trashing a memo open in another window saves it there and closes its tab", async ({
  context,
}) => {
  const first = await startWindows(context, {
    memos: { a: fakeMemo("장보기.md", "우유"), b: fakeMemo("할 일.md", "청소") },
  });
  await row(first, "장보기").click();
  await expect(first.locator(".cm-content")).toHaveText("우유");
  await first.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await first.keyboard.insertText(" 계란");
  const second = await openWindow(context, "ws-2");
  await second.evaluate(() => (window.__tote.backend.data.popupMenuPick = "trash"));
  await row(second, "장보기").click({ button: "right" });
  await expect(first.locator(".tab")).toHaveCount(0);
  await expect(row(first, "장보기")).toHaveCount(0);
  await expect(row(second, "장보기")).toHaveCount(0);
  expect(await trashedText(second, "a")).toBe("우유 계란");
  expect(await second.evaluate(() => window.__tote.backend.data.trashRequests)).toEqual([
    { label: "ws-1", id: "a" },
  ]);
  expect(await second.evaluate(() => window.__tote.backend.data.places)).toEqual({});
});
