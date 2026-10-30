import { expect, test, type Page } from "@playwright/test";

import { boxOf, dragSidebarTo, menu, sidebarWidth, start, writesSettled } from "./helpers";

// The grip on the sidebar's right edge (spec 「사이드바 너비 조절」): 240px by default, 180 to 480
// and at most half the window, collapsed below 120 while dragged, 240 again on a double click,
// written in the window's session once let go. Its first frames, the workspace switch and new
// windows are in sidebar-session.spec.ts.

const EXPAND = "사이드바 펼치기";

const grip = (page: Page) => page.locator(".sidebar-divider");

/** Window `n`'s sidebar fields in the fake's session file, as written. */
const saved = (page: Page, n = 0) =>
  page.evaluate((index) => {
    const window = JSON.parse(globalThis.window.__tote.backend.data.session ?? "null")?.windows?.[
      index
    ];
    return { collapsed: window?.sidebarCollapsed, width: window?.sidebarWidth };
  }, n);

const emptyWindow = { layout: { tabs: [], activeTab: -1 }, focusedPane: 0 };
const withWidth = (sidebarWidth: number) =>
  JSON.stringify({ version: 2, windows: [{ ...emptyWindow, sidebarWidth }] });

/** The sidebar is `width` wide, its content too (less its right line), and the panes start there. */
async function expectWidth(page: Page, width: number): Promise<void> {
  await expect.poll(() => sidebarWidth(page)).toBe(width);
  expect((await boxOf(page.locator(".sidebar-head"))).width).toBe(width - 1);
  expect((await boxOf(page.locator(".main"))).x).toBe(width);
}

const duration = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).transitionDuration);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("the grip spans the sidebar's edge from top to bottom with the dividers' cursor", async ({
  page,
}) => {
  await start(page);
  const box = await boxOf(grip(page));
  expect(box).toEqual({ x: 237, y: 0, width: 6, height: 720 });
  expect(await grip(page).evaluate((el) => getComputedStyle(el).cursor)).toBe("col-resize");
  expect(await grip(page).evaluate((el) => getComputedStyle(el).touchAction)).toBe("none");
  await menu(page, "toggle-sidebar");
  await expect(grip(page)).toBeHidden();
});

test("dragging the grip widens the sidebar, written in the session once let go", async ({
  page,
}) => {
  await start(page);
  await dragSidebarTo(page, 300, { release: false });
  await expectWidth(page, 300);
  await writesSettled(page);
  expect((await saved(page)).width).toBeUndefined();
  await page.mouse.up();
  await expect.poll(async () => (await saved(page)).width).toBe(300);
  await expectWidth(page, 300);
});

test("below 180 the sidebar holds at 180, and past half the window at the half", async ({
  page,
}) => {
  await start(page);
  await dragSidebarTo(page, 150);
  await expectWidth(page, 180);
  await expect.poll(async () => (await saved(page)).width).toBe(180);
  await dragSidebarTo(page, 900);
  await expectWidth(page, 480);
  await page.setViewportSize({ width: 800, height: 720 });
  await expectWidth(page, 400);
  await dragSidebarTo(page, 350);
  await expect.poll(async () => (await saved(page)).width).toBe(350);
  await dragSidebarTo(page, 450);
  await expectWidth(page, 400);
  await expect.poll(async () => (await saved(page)).width).toBe(400);
});

test("below 120 it collapses while still dragged, and back over 120 it expands at the pointer", async ({
  page,
}) => {
  await start(page);
  await page.locator(".sidebar-toggle").first().focus();
  await dragSidebarTo(page, 100, { release: false });
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
  await expect(page.locator(".tab-lead")).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest(".sidebar"))).toBe(false);
  expect(await sidebarWidth(page)).toBe(0);

  await page.mouse.move(150, 300, { steps: 2 });
  await expect(page.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);
  await expectWidth(page, 180);
  await page.mouse.move(200, 300, { steps: 2 });
  await expectWidth(page, 200);
  await page.mouse.up();
  await expect.poll(() => saved(page)).toEqual({ collapsed: undefined, width: 200 });
});

test("let go collapsed, the sidebar comes back at the width it had before the drag", async ({
  page,
}) => {
  await start(page, { session: withWidth(300) });
  await expectWidth(page, 300);
  await dragSidebarTo(page, 400, { release: false });
  await expectWidth(page, 400);
  await page.mouse.move(60, 300, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  await expect.poll(() => saved(page)).toEqual({ collapsed: true, width: 300 });

  await page.locator(".tab-lead").getByRole("button", { name: EXPAND, exact: true }).click();
  await expectWidth(page, 300);
  await expect.poll(() => saved(page)).toEqual({ collapsed: undefined, width: 300 });

  await dragSidebarTo(page, 50);
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  await menu(page, "toggle-sidebar");
  await expectWidth(page, 300);
});

test("a double click on the grip goes back to 240, and the session holds no width", async ({
  page,
}) => {
  await start(page, { session: withWidth(320) });
  await expectWidth(page, 320);
  await writesSettled(page);
  const writes = () => page.evaluate(() => window.__tote.backend.data.layoutWrites["ws-1"] ?? 0);
  const before = await writes();
  const at = await boxOf(grip(page));
  await page.mouse.dblclick(at.x + at.width / 2, at.y + at.height / 2);
  await expectWidth(page, 240);
  await expect.poll(writes).toBeGreaterThan(before);
  await expect.poll(async () => (await saved(page)).width).toBeUndefined();
  expect(await page.evaluate(() => sessionStorage.getItem("tote.sidebarWidth.ws-1"))).toBe("240");
});

test("a narrower window shows the sidebar narrower, keeps its width, and gives it back", async ({
  page,
}) => {
  await start(page, { session: withWidth(400) });
  await expectWidth(page, 400);
  await page.setViewportSize({ width: 700, height: 720 });
  await expectWidth(page, 350);
  // A press that does not move changes nothing, here neither.
  const at = await boxOf(grip(page));
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await writesSettled(page);
  expect((await saved(page)).width).toBe(400);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expectWidth(page, 400);
});

test("collapsing and expanding still slide for 0.16s, to the width kept; a drag never slides", async ({
  page,
}) => {
  await start(page, { session: withWidth(320) });
  expect(await duration(page)).toBe("0s");
  await menu(page, "toggle-sidebar");
  expect(await duration(page)).toBe("0.16s");
  await expect.poll(() => sidebarWidth(page)).toBe(0);
  await menu(page, "toggle-sidebar");
  expect(await duration(page)).toBe("0.16s");
  await expectWidth(page, 320);

  await dragSidebarTo(page, 360, { release: false });
  expect(await duration(page)).toBe("0s");
  expect(await sidebarWidth(page)).toBe(360);
  await page.mouse.move(80, 300, { steps: 2 });
  expect(await duration(page)).toBe("0s");
  expect(await sidebarWidth(page)).toBe(0);
  await page.mouse.move(360, 300, { steps: 2 });
  expect(await sidebarWidth(page)).toBe(360);
  await page.mouse.up();
  expect(await duration(page)).toBe("0.16s");
});

test("on macOS a press on the grip in the top row resizes and never drags or zooms the window", async ({
  page,
}) => {
  await start(page, { macTitlebar: true });
  const drags = () => page.evaluate(() => window.__tote.backend.data.windowDrags ?? 0);
  const zooms = () => page.evaluate(() => window.__tote.backend.data.windowZooms ?? 0);
  const at = await boxOf(grip(page));
  const top = { x: at.x + at.width / 2, y: 18 };
  await page.mouse.click(top.x, top.y);
  expect(await drags()).toBe(0);
  await dragSidebarTo(page, 300, { y: 18 });
  await expectWidth(page, 300);
  expect(await drags()).toBe(0);
  await page.mouse.dblclick(300, 18);
  await expectWidth(page, 240);
  expect(await drags()).toBe(0);
  expect(await zooms()).toBe(0);
});

/** A pointer event from the mouse (WebKit's pointer 1), as captured on the grip: from there it goes
 * up to the window. A release lost out of the window comes back as a move with no button down. */
const firePointer = (page: Page, type: string, x: number, buttons: number) =>
  page.evaluate(
    ({ type, x, buttons }) => {
      document.querySelector(".sidebar-divider")!.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          buttons,
          clientX: x,
          clientY: 300,
          bubbles: true,
        }),
      );
    },
    { type, x, buttons },
  );

const resizing = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains("sidebar-resizing"));

test("a move with no button down ends a drag whose release never came, and keeps its width", async ({
  page,
}) => {
  await start(page);
  await dragSidebarTo(page, 300, { release: false });
  await expectWidth(page, 300);
  await firePointer(page, "pointermove", 300, 0);
  expect(await resizing(page)).toBe(false);
  await expect.poll(async () => (await saved(page)).width).toBe(300);
  // Passing over the grip with no button down moves nothing any more.
  await firePointer(page, "pointermove", 400, 0);
  await page.mouse.move(400, 300, { steps: 2 });
  await expectWidth(page, 300);
  await page.mouse.up();
  await expectWidth(page, 300);
  expect(await duration(page)).toBe("0s");
});

test("the window's blur or a lost capture ends a drag, which keeps the width it had", async ({
  page,
}) => {
  await start(page);
  await dragSidebarTo(page, 320, { release: false });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  expect(await resizing(page)).toBe(false);
  await expect.poll(async () => (await saved(page)).width).toBe(320);
  await page.mouse.move(400, 300, { steps: 2 });
  await expectWidth(page, 320);
  await page.mouse.up();

  await dragSidebarTo(page, 260, { release: false });
  await page.locator(".sidebar-divider").evaluate((el) => el.releasePointerCapture(1));
  await page.mouse.move(380, 300, { steps: 2 });
  expect(await resizing(page)).toBe(false);
  await expectWidth(page, 260);
  await expect.poll(async () => (await saved(page)).width).toBe(260);
  await page.mouse.up();
});

test("a release in the frame of the last move does not slide the sidebar there", async ({
  page,
}) => {
  await start(page);
  // The column slides from the first collapse or expand on.
  await menu(page, "toggle-sidebar");
  await menu(page, "toggle-sidebar");
  await expectWidth(page, 240);
  const slides = () =>
    document.getAnimations().filter((each) => each instanceof CSSTransition).length;
  await expect.poll(() => page.evaluate(slides)).toBe(0);
  /** Moves to `x` and lets go there in one go, then counts the slides it started. */
  const flick = (x: number) =>
    page.evaluate((x) => {
      const grip = document.querySelector(".sidebar-divider")!;
      for (const [type, buttons] of [
        ["pointermove", 1],
        ["pointerup", 0],
      ] as const)
        grip.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            buttons,
            clientX: x,
            clientY: 300,
            bubbles: true,
          }),
        );
      return document.getAnimations().filter((each) => each instanceof CSSTransition).length;
    }, x);
  await dragSidebarTo(page, 300, { release: false });
  expect(await flick(380)).toBe(0);
  await expectWidth(page, 380);
  await page.mouse.up();
  await dragSidebarTo(page, 300, { release: false });
  expect(await flick(40)).toBe(0);
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  await page.mouse.up();
});

test("the toggle wins over a drag: it ends the drag, and the next move undoes nothing", async ({
  page,
}) => {
  await start(page);
  await dragSidebarTo(page, 300, { release: false });
  await menu(page, "toggle-sidebar");
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  expect(await resizing(page)).toBe(false);
  await page.mouse.move(350, 300, { steps: 2 });
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  await page.mouse.up();
  await expect.poll(() => saved(page)).toEqual({ collapsed: true, width: 300 });

  await menu(page, "toggle-sidebar");
  await expectWidth(page, 300);
  await dragSidebarTo(page, 60, { release: false });
  await expect(page.locator("html")).toHaveClass(/\bsidebar-collapsed\b/);
  await menu(page, "toggle-sidebar");
  await expect(page.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);
  await page.mouse.move(40, 300, { steps: 2 });
  await expect(page.locator("html")).not.toHaveClass(/\bsidebar-collapsed\b/);
  await page.mouse.up();
  await expectWidth(page, 300);
});

test("a press held as the window narrows shows the sidebar narrower once let go", async ({
  page,
}) => {
  await start(page, { session: withWidth(400) });
  await expectWidth(page, 400);
  const at = await boxOf(grip(page));
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.setViewportSize({ width: 700, height: 720 });
  // The resize comes in a frame's rendering steps, before its animation frame callbacks: while held,
  // the grip leaves the width alone.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  expect(await sidebarWidth(page)).toBe(400);
  await page.mouse.up();
  await expectWidth(page, 350);
  await writesSettled(page);
  expect((await saved(page)).width).toBe(400);
});
