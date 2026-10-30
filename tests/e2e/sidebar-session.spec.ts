import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { fakeMemo, type FakeData } from "../../src/backend/fake";
import type { WorkspaceInfo } from "../../src/backend/types";
import {
  dragSidebarTo,
  menu,
  nextWindow,
  openWindow,
  quietErrors,
  ready,
  start,
  startWindows,
  writesSettled,
} from "./helpers";

// The collapsed sidebar is the window's (spec 「세션」): written in its session, back at the next
// launch from the first frame, kept across a workspace switch, and not handed to a new window.

/** Records the sidebar's width at every frame from the page's first on, in `__sidebarWidths`. */
async function firstFrames(on: Page | BrowserContext): Promise<void> {
  await on.addInitScript(() => {
    const widths: number[] = (window.__sidebarWidths = []);
    const record = () => {
      const sidebar = document.querySelector(".sidebar");
      if (sidebar) widths.push(sidebar.getBoundingClientRect().width);
      requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  });
}

const widths = (page: Page) => page.evaluate(() => window.__sidebarWidths ?? []);

/** Every frame the page drew had the sidebar collapsed, and it does not slide. */
async function collapsedFromTheFirstFrame(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  const drawn = await widths(page);
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.every((width) => width === 0)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.body).transitionDuration)).toBe("0s");
}

/** The sidebar field of window `n` in the fake's session file, as written. */
const saved = (page: Page, n = 0) =>
  page.evaluate(
    (index) =>
      JSON.parse(window.__tote.backend.data.session ?? "null")?.windows?.[index]?.sidebarCollapsed,
    n,
  );

const collapsed = (page: Page) => page.locator("html.sidebar-collapsed");

/** Every frame the page drew had the sidebar `width` wide. */
async function wideFromTheFirstFrame(page: Page, width: number): Promise<void> {
  await expect
    .poll(() => page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().width))
    .toBe(width);
  const drawn = await widths(page);
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.filter((each) => each !== width)).toEqual([]);
}

/** The sidebar's width in window `n` of the fake's session file, as written. */
const savedWidth = (page: Page, n = 0) =>
  page.evaluate(
    (index) =>
      JSON.parse(window.__tote.backend.data.session ?? "null")?.windows?.[index]?.sidebarWidth,
    n,
  );

const sidebarWide = (page: Page) =>
  page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().width);

const emptyWindow = { layout: { tabs: [], activeTab: -1 }, focusedPane: 0 };
const oneWindow = (window: object) => JSON.stringify({ version: 2, windows: [window] });

const memos = {
  a: fakeMemo("가.md", "첫째", { modifiedMs: 2 }),
  b: fakeMemo("나.md", "둘째", { modifiedMs: 1 }),
};

async function openMemo(page: Page, title: string): Promise<void> {
  await page.locator(".memo-row", { hasText: title }).click();
  await expect(page.locator(".tab.active .tab-title")).toHaveText(title);
}

test("a window saved collapsed opens collapsed from its first frame", async ({ page }) => {
  await firstFrames(page);
  await start(page, { session: oneWindow({ ...emptyWindow, sidebarCollapsed: true }) });
  await collapsedFromTheFirstFrame(page);
});

test("collapsing is saved in the window's session and comes back at the next launch", async ({
  context,
}) => {
  const first = await startWindows(context);
  await menu(first, "toggle-sidebar");
  await expect.poll(() => saved(first)).toBe(true);
  await first.evaluate(() => window.__tote.backend.quit());
  await first.close();

  await firstFrames(context);
  const again = await openWindow(context, "ws-1");
  await collapsedFromTheFirstFrame(again);
  await menu(again, "toggle-sidebar");
  await expect.poll(() => saved(again)).toBeUndefined();
});

test("an old session or a value that is not true opens expanded", async ({ context }) => {
  const sessions = [
    JSON.stringify({ version: 1, activeTab: 0, tabs: [] }),
    oneWindow({ ...emptyWindow, sidebarCollapsed: "true" }),
  ];
  for (const session of sessions) {
    const page = await context.newPage();
    await start(page, { session });
    await expect(page.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);
  }
});

test("a new window and a torn-off tab's window open expanded", async ({ context }) => {
  const first = await startWindows(context, { memos });
  await openMemo(first, "가");
  await openMemo(first, "나");
  await menu(first, "toggle-sidebar");
  await expect(collapsed(first)).toHaveCount(1);

  // Both get a copy of the first window's sessionStorage: its kept state is under its own label.
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await expect(second.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);
  const [third] = await Promise.all([nextWindow(first), menu(first, "move-tab-to-new-window")]);
  await expect(third.locator(".tab.active .tab-title")).toHaveText("나");
  await expect(third.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);
  await expect(collapsed(first)).toHaveCount(1);
});

const info = (name: string): WorkspaceInfo => ({
  id: `workspace-${name}`,
  name,
  title: name,
  path: `/fake/${name}`,
  deviceId: "device-1",
});

const listed = (name: string, windows = 0): FakeData["workspaces"][number] => ({
  name,
  path: `/fake/${name}`,
  open: windows > 0,
  windows,
  missing: false,
});

/** 업무 shown here with 회의 open; 개인 with no tab open last time, its window as `personal`
 * says: a tab shown there would write the session once its language data is in (`changed`), which
 * would hide whether the switch itself writes it. The switcher lists them in the set order, here
 * the seed's: ⌃1 goes to 개인. */
function seed(personal: object = {}): Partial<FakeData> {
  return {
    workspace: info("업무"),
    memos: { m: fakeMemo("회의.md", "안건") },
    session: oneWindow({
      layout: { tabs: [{ kind: "memo", memoId: "m" }], activeTab: 0 },
      focusedPane: 0,
    }),
    workspaces: [listed("개인"), listed("업무", 1)],
    otherWorkspaces: {
      "/fake/개인": {
        workspace: info("개인"),
        memos: { p: fakeMemo("일기.md", "오늘") },
        session: oneWindow({ ...emptyWindow, ...personal }),
      },
    },
  };
}

/** Starts on `seed(personal)`. The page a switch leaves still writes as it unloads (blur,
 * hidden), and the backend refuses that on purpose: those reports stay out of the output. */
async function openSeeded(page: Page, personal: object = {}): Promise<void> {
  await quietErrors(page, "is switching workspaces");
  await start(page, seed(personal));
  await expect(page.locator(".cm-content")).toHaveText("안건");
}

async function switchToPersonal(page: Page): Promise<void> {
  await page.keyboard.press("Control+Digit1");
  await expect(page).toHaveTitle("개인");
  await ready(page);
  await expect(page.locator(".memo-row", { hasText: "일기" })).toHaveCount(1);
}

test("switching the workspace keeps the window's state, and the workspace it goes to saves it", async ({
  page,
  context,
}) => {
  await firstFrames(page);
  await openSeeded(page);
  await menu(page, "toggle-sidebar");
  await expect(collapsed(page)).toHaveCount(1);
  // ⌃ and a number are heard while the sidebar, and the switcher in it, is collapsed.
  await switchToPersonal(page);
  await collapsedFromTheFirstFrame(page);
  await expect.poll(() => saved(page)).toBe(true);

  // A window never collapsed or expanded goes to a workspace whose window was saved collapsed.
  const other = await context.newPage();
  await openSeeded(other, { sidebarCollapsed: true });
  await switchToPersonal(other);
  await expect(other.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);
  await expect.poll(() => saved(other)).toBeUndefined();
});

test("an expanded state the search brought is saved", async ({ page }) => {
  await start(page, { session: oneWindow({ ...emptyWindow, sidebarCollapsed: true }) });
  await expect(collapsed(page)).toHaveCount(1);
  await menu(page, "search-workspace");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);
  await expect.poll(() => saved(page)).toBeUndefined();
});

test("searching an expanded window writes no session for the sidebar", async ({ page }) => {
  await start(page);
  await writesSettled(page);
  const writes = () => page.evaluate(() => window.__tote.backend.data.layoutWrites["ws-1"] ?? 0);
  const before = await writes();
  await menu(page, "search-workspace");
  await writesSettled(page);
  expect(await writes()).toBe(before);
});

test("a window saved wider opens at its width from its first frame, and so after a reload", async ({
  page,
}) => {
  await firstFrames(page);
  await start(page, { session: oneWindow({ ...emptyWindow, sidebarWidth: 320 }) });
  await wideFromTheFirstFrame(page, 320);
  await page.reload();
  await ready(page);
  await wideFromTheFirstFrame(page, 320);
});

test("a width out of range opens at 240", async ({ page }) => {
  await start(page, { session: oneWindow({ ...emptyWindow, sidebarWidth: 600 }) });
  await expect.poll(() => sidebarWide(page)).toBe(240);
});

test("a width 0.2.0 saved below 200 opens at 240", async ({ page }) => {
  await start(page, { session: oneWindow({ ...emptyWindow, sidebarWidth: 190 }) });
  await expect.poll(() => sidebarWide(page)).toBe(240);
});

test("a width dragged to is written in the session and comes back at the next launch", async ({
  context,
}) => {
  const first = await startWindows(context);
  await dragSidebarTo(first, 360);
  await expect.poll(() => savedWidth(first)).toBe(360);
  await first.evaluate(() => window.__tote.backend.quit());
  await first.close();

  await firstFrames(context);
  const again = await openWindow(context, "ws-1");
  await wideFromTheFirstFrame(again, 360);
});

test("switching the workspace keeps the window's width, and the workspace it goes to saves it", async ({
  page,
  context,
}) => {
  await firstFrames(page);
  await openSeeded(page);
  await dragSidebarTo(page, 320);
  await expect.poll(() => savedWidth(page)).toBe(320);
  await switchToPersonal(page);
  await wideFromTheFirstFrame(page, 320);
  await expect.poll(() => savedWidth(page)).toBe(320);

  // A window never resized goes to a workspace whose window was saved wider.
  const other = await context.newPage();
  await openSeeded(other, { sidebarWidth: 400 });
  await switchToPersonal(other);
  await expect.poll(() => sidebarWide(other)).toBe(240);
  await expect.poll(() => savedWidth(other)).toBeUndefined();
});

test("a new window and a torn-off tab's window open at 240", async ({ context }) => {
  const first = await startWindows(context, { memos });
  await openMemo(first, "가");
  await openMemo(first, "나");
  await dragSidebarTo(first, 320);
  await expect.poll(() => sidebarWide(first)).toBe(320);

  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await expect.poll(() => sidebarWide(second)).toBe(240);
  const [third] = await Promise.all([nextWindow(first), menu(first, "move-tab-to-new-window")]);
  await expect(third.locator(".tab.active .tab-title")).toHaveText("나");
  await expect.poll(() => sidebarWide(third)).toBe(240);
  expect(await sidebarWide(first)).toBe(320);
});
