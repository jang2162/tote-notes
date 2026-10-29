import { expect, test, type Locator, type Page } from "@playwright/test";

import { fakeMemo, type FakeData } from "../../src/backend/fake";
import type { WorkspaceInfo } from "../../src/backend/types";
import { menu, nextWindow, quietErrors, ready, start, startWindows } from "./helpers";

// The settings screen's 워크스페이스 section (spec 「설정 화면 『워크스페이스』 구역」): the order and the
// hidden ones the switcher and ⌃1 – ⌃9 follow, changed by dragging rows and ticking 「숨김」.

const info = (name: string): WorkspaceInfo => ({
  id: `workspace-${name}`,
  name,
  title: name,
  path: `/fake/${name}`,
  deviceId: "device-1",
});

const listed = (
  name: string,
  windows = 0,
  patch: Partial<FakeData["workspaces"][number]> = {},
): FakeData["workspaces"][number] => ({
  name,
  path: `/fake/${name}`,
  open: windows > 0,
  windows,
  missing: false,
  ...patch,
});

const oneTab = (memoId: string) =>
  JSON.stringify({ version: 1, activeTab: 0, tabs: [{ kind: "memo", memoId }] });

/** 업무, shown here; 개인 and 가계부 shown nowhere. */
function seed(patch: Partial<FakeData> = {}): Partial<FakeData> {
  return {
    workspace: info("업무"),
    memos: { m: fakeMemo("회의.md", "안건") },
    session: oneTab("m"),
    workspaces: [listed("업무", 1), listed("개인"), listed("가계부")],
    otherWorkspaces: {
      "/fake/개인": {
        workspace: info("개인"),
        memos: { p: fakeMemo("일기.md", "오늘") },
        session: oneTab("p"),
      },
      "/fake/가계부": { workspace: info("가계부"), memos: {}, session: null },
    },
    ...patch,
  };
}

/** Starts on `seed(patch)`. The page a switch leaves still writes as it unloads, and the backend
 * refuses that on purpose: those reports stay out of the output. */
async function open(page: Page, patch: Partial<FakeData> = {}): Promise<void> {
  await quietErrors(page, "is switching workspaces");
  await start(page, seed(patch));
}

/** Opens the settings screen on its 워크스페이스 section. */
async function openSection(page: Page): Promise<Locator> {
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.getByRole("tab", { name: "워크스페이스", exact: true }).click();
  await expect(panel.locator(".ws-order-list")).toBeVisible();
  return panel;
}

const rows = (panel: Locator) => panel.locator("li.ws-order-row");
const row = (panel: Locator, name: string) =>
  panel.locator("li.ws-order-row", {
    has: panel.page().locator(".ws-order-name", { hasText: name }),
  });
const names = (panel: Locator) => panel.locator("li.ws-order-row .ws-order-name");
const keys = (panel: Locator) => panel.locator("li.ws-order-row .ws-order-key");

/** Presses on row `from`'s name and moves to just inside the top edge of row `to`: the row lands
 * before `to`. The button stays down; the caller lets it go. */
async function pressAndMove(page: Page, from: Locator, to: Locator): Promise<void> {
  const start = (await from.locator(".ws-order-name").boundingBox())!;
  const target = (await to.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, target.y + 2, { steps: 8 });
}

/** Drags row `from` before row `to` and lets it go there. */
async function dragBefore(page: Page, from: Locator, to: Locator): Promise<void> {
  await pressAndMove(page, from, to);
  await page.mouse.up();
}

const switcherLabels = (page: Page) => page.locator(".ws-switcher-item .ws-switcher-label");

/** What the fake has saved as each workspace's place: `undefined` for every one until a save. */
const savedOrder = (page: Page) =>
  page.evaluate(() => window.__tote.backend.data.workspaces.map((each) => each.order));

test("the 워크스페이스 section sits under 일반 and lists the workspaces in order", async ({
  page,
}) => {
  await open(page, {
    workspaces: [
      listed("업무", 1),
      listed("개인"),
      listed("옛것", 0, { missing: true }),
      listed("가계부"),
    ],
  });
  const panel = await openSection(page);
  await expect(panel.getByRole("tab")).toHaveText([
    "일반",
    "워크스페이스",
    "편집기",
    "모양",
    "단축키",
    "확장",
  ]);
  await expect(
    panel.getByText(
      "끌어서 순서를 바꿉니다. 고르개와 ⌃1~⌃9 가 이 순서를 따릅니다. 숨긴 워크스페이스는 고르개에 보이지 않습니다.",
      { exact: true },
    ),
  ).toBeVisible();
  // A missing workspace is not one to order.
  await expect(names(panel)).toHaveText(["업무", "개인", "가계부"]);
  await expect(keys(panel)).toHaveText(["⌃1", "⌃2", "⌃3"]);
  await expect(panel.locator("li.ws-order-row .ws-order-grip")).toHaveText(["⋮⋮", "⋮⋮", "⋮⋮"]);
  const first = rows(panel).first();
  await expect(first.locator("label")).toHaveText("숨김");
  await expect(first.locator("label input[type=checkbox]")).not.toBeChecked();
  await expect(first.locator("label input[type=checkbox]")).toBeEnabled();
});

test("dragging a row reorders the switcher and ⌃1", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  await dragBefore(page, row(panel, "가계부"), row(panel, "업무"));
  await expect(names(panel)).toHaveText(["가계부", "업무", "개인"]);
  await expect(keys(panel)).toHaveText(["⌃1", "⌃2", "⌃3"]);
  await expect(panel.locator(".ws-order-drop")).toBeHidden();
  await expect.poll(() => savedOrder(page)).toEqual([1, 2, 0]);
  await expect(panel.locator(".modal-error")).toHaveText("");
  await panel.getByRole("button", { name: "닫기" }).click();
  // The section closed with the screen stops listening.
  expect(
    await page.evaluate(
      () =>
        (window.__tote.app as unknown as { workspaceListeners: Set<unknown> }).workspaceListeners
          .size,
    ),
  ).toBe(0);
  await page.locator(".ws-switcher-button").click();
  await expect(switcherLabels(page)).toHaveText(["가계부", "업무", "개인"]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Digit1");
  await expect(page).toHaveTitle("가계부");
  await ready(page);
});

test("a row dragged down lands where it is let go", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  await dragBefore(page, row(panel, "업무"), row(panel, "가계부"));
  await expect(names(panel)).toHaveText(["개인", "업무", "가계부"]);
  await expect.poll(() => savedOrder(page)).toEqual([1, 0, 2]);
});

test("a hidden workspace leaves the switcher and gives up its number", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  await row(panel, "개인").locator("input[type=checkbox]").check();
  await expect(row(panel, "개인")).toHaveClass(/\bhidden\b/);
  await expect(row(panel, "개인").locator(".ws-order-key")).toHaveText("");
  await expect(row(panel, "가계부").locator(".ws-order-key")).toHaveText("⌃2");
  await expect
    .poll(() =>
      page.evaluate(() => window.__tote.backend.data.workspaces.map((each) => each.hidden)),
    )
    .toEqual([false, true, false]);
  await panel.getByRole("button", { name: "닫기" }).click();
  await page.locator(".ws-switcher-button").click();
  await expect(switcherLabels(page)).toHaveText(["업무", "가계부"]);
});

test("a click on the hidden box is not a drag", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  const box = row(panel, "가계부").locator("input[type=checkbox]");
  const at = (await box.boundingBox())!;
  const label = (await row(panel, "가계부").locator("label").boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  // Past the 4px a drag starts at, still on the label: let go there, it is the box's click.
  await page.mouse.move(label.x + label.width - 2, at.y + at.height / 2, { steps: 5 });
  await expect(panel.locator(".ws-order-drop")).toBeHidden();
  await expect(panel.locator("li.ws-order-row.dragging")).toHaveCount(0);
  await page.mouse.up();
  await expect(box).toBeChecked();
  await expect(names(panel)).toHaveText(["업무", "개인", "가계부"]);
});

test("Esc during a drag puts the row back and saves nothing", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  await pressAndMove(page, row(panel, "가계부"), row(panel, "업무"));
  await expect(panel.locator(".ws-order-drop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.locator(".ws-order-drop")).toBeHidden();
  await page.mouse.up();
  // The screen stays: the Esc was the drag's.
  await expect(panel).toBeVisible();
  await expect(names(panel)).toHaveText(["업무", "개인", "가계부"]);
  expect(await savedOrder(page)).toEqual([undefined, undefined, undefined]);
  // With no drag, Esc closes the screen as before.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("a row let go outside the list goes back and saves nothing", async ({ page }) => {
  await open(page);
  const panel = await openSection(page);
  await pressAndMove(page, row(panel, "가계부"), row(panel, "업무"));
  // Off the list's left edge at the first row's height: inside, it would land first.
  const list = (await panel.locator(".ws-order-list").boundingBox())!;
  const first = (await row(panel, "업무").boundingBox())!;
  await page.mouse.move(list.x - 30, first.y + 2, { steps: 4 });
  await page.mouse.up();
  await expect(panel.locator(".ws-order-drop")).toBeHidden();
  await expect(names(panel)).toHaveText(["업무", "개인", "가계부"]);
  expect(await savedOrder(page)).toEqual([undefined, undefined, undefined]);
});

test("a failed save says why and shows the saved order", async ({ page }) => {
  await open(page, { failWorkspaceOrder: 1 });
  const panel = await openSection(page);
  await dragBefore(page, row(panel, "가계부"), row(panel, "업무"));
  await expect(panel.locator(".modal-error")).not.toHaveText("");
  await expect(names(panel)).toHaveText(["업무", "개인", "가계부"]);
  // The next save goes through and takes the reason away.
  await dragBefore(page, row(panel, "가계부"), row(panel, "업무"));
  await expect(names(panel)).toHaveText(["가계부", "업무", "개인"]);
  await expect(panel.locator(".modal-error")).toHaveText("");
});

test("another window's settings section follows a new order", async ({ context }) => {
  const first = await startWindows(
    context,
    seed({ workspaces: [listed("업무", 2), listed("개인"), listed("가계부")] }),
  );
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  const here = await openSection(first);
  const there = await openSection(second);
  await expect(names(there)).toHaveText(["업무", "개인", "가계부"]);
  await dragBefore(first, row(here, "가계부"), row(here, "업무"));
  await expect(names(here)).toHaveText(["가계부", "업무", "개인"]);
  await expect(names(there)).toHaveText(["가계부", "업무", "개인"]);
  await row(here, "업무").locator("input[type=checkbox]").check();
  await expect(row(there, "업무")).toHaveClass(/\bhidden\b/);
  await expect(keys(there)).toHaveText(["⌃1", "", "⌃2"]);
});

test("a new order heard during a drag waits for the row to be let go", async ({ context }) => {
  const first = await startWindows(
    context,
    seed({ workspaces: [listed("업무", 2), listed("개인"), listed("가계부")] }),
  );
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  const here = await openSection(first);
  await pressAndMove(first, row(here, "가계부"), row(here, "업무"));
  await expect(here.locator("li.ws-order-row.dragging")).toHaveCount(1);
  await second.evaluate(() =>
    window.__tote.backend.setWorkspaceOrder(["/fake/개인", "/fake/업무", "/fake/가계부"], []),
  );
  // The switcher hears the same notice: once it has the new order, the section has heard it too.
  await expect(first.locator(".ws-switcher-item .ws-switcher-label")).toHaveText([
    "개인",
    "업무",
    "가계부",
  ]);
  await expect(names(here)).toHaveText(["업무", "개인", "가계부"]);
  await expect(here.locator("li.ws-order-row.dragging")).toHaveCount(1);
  await first.keyboard.press("Escape");
  await first.mouse.up();
  await expect(names(here)).toHaveText(["개인", "업무", "가계부"]);
});

test("no workspaces under the root says so", async ({ page }) => {
  await open(page, { workspaces: [] });
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.getByRole("tab", { name: "워크스페이스", exact: true }).click();
  await expect(
    panel.locator("p.settings-note", { hasText: "워크스페이스 루트에 워크스페이스가 없습니다." }),
  ).toBeVisible();
  await expect(rows(panel)).toHaveCount(0);
});

test("a workspace without an id cannot be hidden", async ({ page }) => {
  await open(page, {
    workspaces: [
      listed("가계부", 0, { orderable: false, order: 2 }),
      listed("업무", 1, { order: 0 }),
      listed("개인", 0, { order: 1 }),
    ],
  });
  const panel = await openSection(page);
  await expect(names(panel)).toHaveText(["업무", "개인", "가계부"]);
  await expect(row(panel, "가계부").locator("input[type=checkbox]")).toBeDisabled();
  await expect(row(panel, "업무").locator("input[type=checkbox]")).toBeEnabled();
});

test("a hidden row is drawn muted", async ({ page }) => {
  await open(page, {
    workspaces: [listed("업무", 1), listed("개인", 0, { hidden: true }), listed("가계부")],
  });
  const panel = await openSection(page);
  await expect(row(panel, "개인")).toHaveClass(/\bhidden\b/);
  await expect(row(panel, "개인").locator("input[type=checkbox]")).toBeChecked();
  await expect(keys(panel)).toHaveText(["⌃1", "", "⌃2"]);
  const muted = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = "var(--muted)";
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  const color = (name: string) =>
    row(panel, name)
      .locator(".ws-order-name")
      .evaluate((each) => getComputedStyle(each).color);
  expect(await color("개인")).toBe(muted);
  expect(await color("업무")).not.toBe(muted);
});
