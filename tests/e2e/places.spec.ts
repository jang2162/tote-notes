import { expect, test, type Page } from "@playwright/test";

import { RECOVERED_NOTICE } from "../../src/app/docs";
import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, start } from "./helpers";

// The fake is window "ws-1"; "ws-9" stands for another window holding a tab.

function places(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => window.__tote.backend.data.places ?? {});
}

function memoIds(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(window.__tote.backend.data.memos));
}

const twoTabs = {
  version: 1,
  activeTab: 1,
  tabs: [
    { kind: "memo", memoId: "a" },
    { kind: "memo", memoId: "b" },
  ],
};

test("a file open in another window is revealed there, not opened here", async ({ page }) => {
  await start(page, {
    files: { "/tmp/a.sh": fakeFile("echo hi\n") },
    places: { "external:/tmp/a.sh": "ws-9" },
  });
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    backend.data.pending = [{ kind: "external", path: "/tmp/a.sh" }];
    backend.poke();
  });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.reveals))
    .toEqual([{ label: "ws-9", tab: { kind: "external", path: "/tmp/a.sh" } }]);
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(await places(page)).toEqual({ "external:/tmp/a.sh": "ws-9" });
});

test("a restored tab open elsewhere is left out", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(twoTabs),
    places: { "memo:b": "ws-9" },
  });
  await expect(page.locator(".tab .tab-title")).toHaveText(["가"]);
  await expect(page.locator(".cm-content")).toHaveText("첫째");
  expect(await page.evaluate(() => window.__tote.backend.data.reads)).toEqual({ a: 1 });
  expect(await places(page)).toEqual({ "memo:a": "ws-1", "memo:b": "ws-9" });
});

test("a reveal activates the tab", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(twoTabs),
  });
  await expect(page.locator(".tab.active .tab-title")).toHaveText("나");
  await page.evaluate(() => window.__tote.backend.reveal({ kind: "memo", id: "a" }));
  await expect(page.locator(".tab.active .tab-title")).toHaveText("가");
  await expect(page.locator(".cm-content")).toHaveText("첫째");
});

test("closing a tab gives up its place", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") } });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await page.locator(".memo-row", { hasText: "나" }).click();
  await expect(page.locator(".tab")).toHaveCount(2);
  expect(await places(page)).toEqual({ "memo:a": "ws-1", "memo:b": "ws-1" });
  await menu(page, "close-tab");
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect.poll(() => places(page)).toEqual({ "memo:a": "ws-1" });
});

test("importing an external file moves its place to the memo", async ({ page }) => {
  await start(page, { files: { "/x/a.sh": fakeFile("echo hi\n") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".cm-content")).toContainText("echo hi");
  expect(await places(page)).toEqual({ "external:/x/a.sh": "ws-1" });
  await menu(page, "import");
  await expect(page.locator(".status-message")).toHaveText("워크스페이스로 가져왔습니다");
  const [id] = await memoIds(page);
  await expect.poll(() => places(page)).toEqual({ [`memo:${id}`]: "ws-1" });
});

test("a memo saved under a new ID keeps its place", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째") } });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await places(page)).toEqual({ "memo:a": "ws-1" });
  // Deleted in Finder while the tab was open: the next save makes a new memo of the text.
  await page.evaluate(() => delete window.__tote.backend.data.memos.a);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.insertText(" 둘");
  await expect(page.locator(".status-message")).toHaveText(RECOVERED_NOTICE);
  const [id] = await memoIds(page);
  expect(id).not.toBe("a");
  await expect.poll(() => places(page)).toEqual({ [`memo:${id}`]: "ws-1" });
});
