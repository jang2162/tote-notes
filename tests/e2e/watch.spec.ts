import { expect, test, type Page } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import type { OutsideChange, WorkspaceChange } from "../../src/backend/types";
import { ready, sessionPane, start } from "./helpers";

/** What another app does to memo `id`: new contents, stamped later than anything seeded. */
async function writeElsewhere(page: Page, id: string, text: string): Promise<void> {
  await page.evaluate(
    ([memo, data]) => {
      Object.assign(window.__tote.backend.data.memos[memo], { data, modifiedMs: 900 });
    },
    [id, fakeFile(text)] as const,
  );
}

function outside(page: Page, ...changes: WorkspaceChange[]): Promise<void> {
  const change: OutsideChange = { kind: "workspace", changes };
  return page.evaluate((c) => window.__tote.backend.outside(c), change);
}

/** Opens 장보기 (우유) with the cursor after 우유 and types behind it. */
async function typeInto(page: Page): Promise<void> {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toHaveText("우유");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 계란");
}

const banner = (page: Page) => page.locator(".banner");

test("a memo changed outside is reread silently with the cursor in place", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("장보기.md", "우유\n계란", { modifiedMs: 2 }),
      b: fakeMemo("할 일.md", "청소", { modifiedMs: 1 }),
    },
  });
  await page.locator(".memo-row", { hasText: "할 일" }).click();
  await expect(page.locator(".cm-content")).toHaveText("청소");
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 1 } }));
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["장보기", "할 일"]);

  await writeElsewhere(page, "b", "청소\n빨래");
  await outside(page, { kind: "modified", id: "b" });
  await expect(page.locator(".cm-content")).toHaveText("청소빨래");
  expect(await page.evaluate(() => window.__tote.app.view.state.selection.main.head)).toBe(1);
  await expect(banner(page)).toBeHidden();
  // The listing follows: the memo changed last comes first.
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["할 일", "장보기"]);
  // Typing goes on where the cursor was.
  await page.keyboard.insertText("!");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoText("b")))
    .toBe("청!소\n빨래");
});

test("an external change while typing shows the conflict banner and keeps the typed text", async ({
  page,
}) => {
  await typeInto(page);
  // Within the half second before the save.
  await writeElsewhere(page, "a", "두유");
  await outside(page, { kind: "modified", id: "a" });
  await expect(banner(page)).toBeVisible();
  await expect(banner(page).locator(".banner-text")).toHaveText(
    "다른 앱이 이 파일을 바꿨습니다. 어느 쪽을 둘까요?",
  );
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
  // The save waits for the choice.
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("두유");

  await banner(page).getByRole("button", { name: "내 버전" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoText("a")))
    .toBe("우유 계란");
  await expect(banner(page)).toBeHidden();
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
});

test("디스크 버전 replaces the text and clears the banner", async ({ page }) => {
  await typeInto(page);
  await writeElsewhere(page, "a", "두유");
  await outside(page, { kind: "modified", id: "a" });
  await banner(page).getByRole("button", { name: "디스크 버전" }).click();
  await expect(page.locator(".cm-content")).toHaveText("두유");
  await expect(banner(page)).toBeHidden();
  // A new state, not an edit: ⌘Z has nothing to take back into the typed text.
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".cm-content")).toHaveText("두유");
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("두유");
});

test("a deleted memo keeps its text and 다시 저장 brings it back", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toHaveText("우유");
  await page.evaluate(() => {
    delete window.__tote.backend.data.memos.a;
  });
  await outside(page, { kind: "removed", id: "a", file: "장보기.md" });
  await expect(banner(page).locator(".banner-text")).toHaveText(
    "파일이 지워졌습니다. 다시 저장하거나 탭을 닫을 수 있습니다",
  );
  await expect(page.locator(".cm-content")).toHaveText("우유");
  await expect(page.locator(".memo-row")).toHaveCount(0);

  await banner(page).getByRole("button", { name: "다시 저장" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("장보기.md")))
    .toBe("우유");
  await expect(banner(page)).toBeHidden();
  await expect(page.locator(".status-message")).toHaveText(
    "원래 파일을 찾지 못해 새 메모로 저장했습니다",
  );
  await expect(page.locator(".memo-row.active .memo-name")).toHaveText("장보기");
});

test("language data arriving after a removal does not bring the memo back to the list", async ({
  page,
}) => {
  // The language configuration is fetched from the dev server, which answers late under load:
  // held here, it lands after the removal has been listed.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/language-configuration/markdown.json", async (route) => {
    await held;
    await route.continue();
  });
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toHaveText("우유");
  await page.evaluate(() => {
    delete window.__tote.backend.data.memos.a;
  });
  await outside(page, { kind: "removed", id: "a", file: "장보기.md" });
  await expect(banner(page)).toBeVisible();
  await expect(page.locator(".memo-row")).toHaveCount(0);

  release();
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys(window.__tote.app.focused.tabs.active?.languageData ?? {}).length,
      ),
    )
    .toBeGreaterThan(0);
  await expect(page.locator(".memo-row")).toHaveCount(0);
});

test("a renamed memo keeps its tab and saves under the new name", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유", { autoTitle: true }) } });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toHaveText("우유");
  await page.evaluate(() => {
    Object.assign(window.__tote.backend.data.memos.a, { file: "장 볼 것.md", autoTitle: false });
  });
  await outside(page, { kind: "renamed", id: "a", from: "장보기.md", to: "장 볼 것.md" });
  await expect(page.locator(".tab.active .tab-title")).toHaveText("장 볼 것");
  await expect(page.locator(".memo-row.active .memo-name")).toHaveText("장 볼 것");

  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 계란");
  // Leaving the title line would retitle a memo tote names; the rename made it the person's.
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("장 볼 것.md")))
    .toBe("우유 계란\n");
  expect(await page.evaluate(() => window.__tote.backend.memoTextByFile("장보기.md"))).toBeNull();
  await expect(page.locator(".tab")).toHaveCount(1);
});

test("the memo list follows added and removed files", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("장보기.md", "우유", { modifiedMs: 2 }),
      b: fakeMemo("할 일.md", "청소", { modifiedMs: 1 }),
    },
  });
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["장보기", "할 일"]);
  await page.evaluate(
    ([data]) => {
      const memos = window.__tote.backend.data.memos;
      memos.c = { file: "여행.md", autoTitle: false, data, modifiedMs: 900 };
      delete memos.b;
    },
    [fakeFile("제주")] as const,
  );
  await outside(
    page,
    { kind: "added", id: "c", file: "여행.md" },
    { kind: "removed", id: "b", file: "할 일.md" },
  );
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["여행", "장보기"]);
});

test("closing the window with two conflicts keeps every file as the other app left it and 내 버전 as new memos", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("장보기.md", "우유"), b: fakeMemo("할 일.md", "청소") },
  });
  for (const [id, name, text, typed, theirs] of [
    ["a", "장보기", "우유", " 계란", "두유"],
    ["b", "할 일", "청소", " 빨래", "설거지"],
  ] as const) {
    await page.locator(".memo-row", { hasText: name }).click();
    await expect(page.locator(".cm-content")).toHaveText(text);
    await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
    await page.keyboard.insertText(typed);
    await writeElsewhere(page, id, theirs);
    await outside(page, { kind: "modified", id });
    await expect(banner(page)).toBeVisible();
  }
  // What the native side asks of a window that closes or of the app that quits.
  await page.evaluate(() => window.__tote.backend.requestFlush(3));
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed))
    .toEqual([{ id: 3 }]);
  const text = (file: string) =>
    page.evaluate((f) => window.__tote.backend.memoTextByFile(f), file);
  expect(await text("장보기.md")).toBe("두유");
  expect(await text("할 일.md")).toBe("설거지");
  expect(await text("장보기 2.md")).toBe("우유 계란");
  expect(await text("할 일 2.md")).toBe("청소 빨래");
  // Each new memo's tab says so; the status bar stays quiet.
  await expect(banner(page)).toBeVisible();
  await expect(page.locator(".status-message")).toHaveText("");
});

/** A conflict left open on 장보기 and a flush: the tab is now the new memo with the info banner. */
async function keepConflict(page: Page): Promise<void> {
  await typeInto(page);
  await writeElsewhere(page, "a", "두유");
  await outside(page, { kind: "modified", id: "a" });
  await expect(banner(page)).toBeVisible();
  await page.evaluate(() => window.__tote.backend.requestFlush(3));
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.flushed))
    .toEqual([{ id: 3 }]);
}

const KEPT =
  "내 버전은 이 메모로 따로 저장했습니다. 다른 앱이 바꾼 버전은 원래 메모 「장보기」에 있습니다.";

test("the conflict-kept banner survives a restart", async ({ page }) => {
  await keepConflict(page);
  await expect(banner(page)).toHaveText(new RegExp(KEPT));
  // The flush wrote the session after the banner went up.
  const pane = await sessionPane(page);
  const tab = pane.tabs[pane.activeTab];
  expect(tab).toMatchObject({ kind: "memo", conflictKept: { memoId: "a" } });
  expect(tab).not.toMatchObject({ memoId: "a" });

  // Start again from that session, as after quitting the app.
  await page.reload();
  await ready(page);
  await expect(banner(page)).toBeVisible();
  await expect(banner(page).locator(".banner-text")).toHaveText(KEPT);
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
  await banner(page).getByRole("button", { name: "원래 메모 열기" }).click();
  await expect(page.locator(".cm-content")).toHaveText("두유");
  await expect(page.locator(".tab")).toHaveCount(2);
});

test("the conflict-kept banner ends with its tab", async ({ page }) => {
  await keepConflict(page);
  await expect(banner(page)).toBeVisible();
  await page.evaluate(() => window.__tote.backend.menu("close-tab"));
  await expect(page.locator(".tab")).toHaveCount(0);
  await page.locator(".memo-row", { hasText: "장보기 2" }).click();
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
  await expect(banner(page)).toBeHidden();
});

test("⌘W on a memo with the conflict open keeps the tab and says what to do", async ({ page }) => {
  await typeInto(page);
  await writeElsewhere(page, "a", "두유");
  await outside(page, { kind: "modified", id: "a" });
  await expect(banner(page)).toBeVisible();
  await page.evaluate(() => window.__tote.backend.menu("close-tab"));
  await expect(page.locator(".status-message")).toHaveText(
    "먼저 디스크 버전과 내 버전 중 하나를 고르세요",
  );
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(".cm-content")).toHaveText("우유 계란");
});
