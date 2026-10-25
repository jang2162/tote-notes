import { expect, test, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { menu, quietErrors, start } from "./helpers";

// Which window is asked, and that it is asked once however many are open, is Rust's
// (`an_update_offer_goes_to_one_window` in src-tauri/src/app/mod.rs); so is the restart writing
// every window (`a_restart_waits_on_the_windows_a_quit_would`). These check the page's side.

const OFFER = { version: "0.2.0", current: "0.1.0", notes: "검색이 빨라졌습니다." };

const offer = (page: Page) => page.evaluate((o) => window.__tote.backend.offerUpdate(o), OFFER);
const updateLog = (page: Page) => page.evaluate(() => window.__tote.backend.data.update);
const dialog = (page: Page) => page.locator(".modal.update");

test("an update offer asks once and installs nothing until accepted", async ({ page }) => {
  await start(page);
  await offer(page);
  await expect(dialog(page)).toContainText(
    "새 버전 tote 0.2.0 이 있습니다. 지금 버전은 0.1.0 입니다.",
  );
  await expect(dialog(page).locator("details summary")).toHaveText("바뀐 점");
  await expect(dialog(page).locator("details pre")).toHaveText("검색이 빨라졌습니다.");
  await expect(page.getByRole("button", { name: "업데이트하고 다시 시작" })).toBeFocused();
  expect((await updateLog(page))?.installCalls ?? 0).toBe(0);

  await page.getByRole("button", { name: "나중에", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  // Nothing comes back by itself: the offer was taken with the pending opens.
  await page.evaluate(() => window.__tote.backend.poke());
  await expect(dialog(page)).toHaveCount(0);
  expect((await updateLog(page))?.installCalls ?? 0).toBe(0);
});

test("accepting writes every open memo before the restart", async ({ page }) => {
  await page.clock.install();
  await start(page, { memos: { a: fakeMemo("장보기.md", "우유") } });
  await page.locator(".memo-row", { hasText: "장보기" }).click();
  await expect(page.locator(".cm-content")).toContainText("우유");
  // The save timer does not run: only the restart's round writes what is typed now.
  await page.clock.pauseAt(Date.now() + 60_000);
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 2 } }));
  await page.keyboard.insertText(" 계란");
  expect(await page.evaluate(() => window.__tote.backend.memoText("a"))).toBe("우유");

  await page.evaluate(() => window.__tote.backend.holdInstall());
  await offer(page);
  await page.getByRole("button", { name: "업데이트하고 다시 시작" }).click();
  await expect(dialog(page).getByRole("status")).toHaveText("받는 중… 50%");
  // Nothing in the dialog takes a press or Escape while it downloads.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeVisible();
  for (const button of await dialog(page).getByRole("button").all()) {
    await expect(button).toBeDisabled();
  }
  await page.evaluate(() => window.__tote.backend.releaseInstall());

  await expect.poll(async () => (await updateLog(page))?.restarted).toBe(true);
  await expect(dialog(page).getByRole("status")).toHaveText("저장하고 다시 시작하는 중…");
  const log = await updateLog(page);
  expect(log?.installCalls).toBe(1);
  // Written by the restart's round, before the restart: the memo held the typed text by then.
  expect(log?.memosAtRestart).toEqual({ a: "우유 계란" });
});

test("a cancelled restart leaves the update installed and says so", async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.__tote.backend.refuseNextRestart());
  await offer(page);
  await page.getByRole("button", { name: "업데이트하고 다시 시작" }).click();
  await expect(dialog(page)).toContainText(
    "업데이트는 설치됐습니다. 다음에 tote 를 열면 새 버전으로 시작합니다.",
  );
  await expect(page.getByRole("button", { name: "닫기", exact: true })).toBeVisible();
  expect((await updateLog(page))?.restarted).toBe(false);

  await page.getByRole("button", { name: "다시 시작", exact: true }).click();
  await expect.poll(async () => (await updateLog(page))?.restarted).toBe(true);
  const log = await updateLog(page);
  expect(log?.restartCalls).toBe(2);
  // Installed once: the second press only restarts.
  expect(log?.installCalls).toBe(1);
});

test("a restart refused while another window writes can be pressed again", async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.__tote.backend.busyNextRestart());
  await offer(page);
  await page.getByRole("button", { name: "업데이트하고 다시 시작" }).click();
  await expect(dialog(page)).toContainText(
    "다른 창이 저장하는 중입니다. 잠시 뒤 다시 눌러 주세요.",
  );
  await page.getByRole("button", { name: "다시 시작", exact: true }).click();
  await expect.poll(async () => (await updateLog(page))?.restarted).toBe(true);
  expect((await updateLog(page))?.installCalls).toBe(1);
});

test("an install that fails says why and can be retried", async ({ page }) => {
  await quietErrors(page, "Read-only file system");
  await start(page);
  await page.evaluate(() => window.__tote.backend.failNextInstall("Read-only file system"));
  await offer(page);
  await page.getByRole("button", { name: "업데이트하고 다시 시작" }).click();
  await expect(dialog(page)).toContainText("업데이트하지 못했습니다: Read-only file system");
  expect((await updateLog(page))?.restarted).toBe(false);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect.poll(async () => (await updateLog(page))?.restarted).toBe(true);
  expect((await updateLog(page))?.installCalls).toBe(2);
});

test("an update offer opens over the settings screen and Escape closes only it", async ({
  page,
}) => {
  await start(page);
  await menu(page, "settings");
  const settings = page.locator(".modal.settings");
  await expect(settings).toBeVisible();
  await offer(page);
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(settings).toBeVisible();
  expect((await updateLog(page))?.installCalls ?? 0).toBe(0);
});

test("a second offer while the dialog is open does not stack another", async ({ page }) => {
  await start(page);
  await offer(page);
  await expect(dialog(page)).toBeVisible();
  // The menu's check finding the same release again, in the same window.
  await offer(page);
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.pending.length)).toBe(0);
  await expect(dialog(page)).toHaveCount(1);
});

test("an update installed in this run asks only for the restart", async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.__tote.backend.refuseNextRestart());
  await offer(page);
  await page.getByRole("button", { name: "업데이트하고 다시 시작" }).click();
  await expect(dialog(page)).toContainText("업데이트는 설치됐습니다.");
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);

  // The menu's check finds it again: the running version is still the old one.
  await offer(page);
  await expect(dialog(page)).toContainText(
    "업데이트는 설치됐습니다. 다음에 tote 를 열면 새 버전으로 시작합니다.",
  );
  await expect(page.getByRole("button", { name: "업데이트하고 다시 시작" })).toHaveCount(0);
  await page.getByRole("button", { name: "다시 시작", exact: true }).click();
  await expect.poll(async () => (await updateLog(page))?.restarted).toBe(true);
  expect((await updateLog(page))?.installCalls).toBe(1);
});

test("an offer while another window downloads the update says so", async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.__tote.backend.installElsewhere());
  await offer(page);
  await expect(dialog(page)).toHaveText("새 버전 tote 0.2.0 을 다른 창에서 받는 중입니다.닫기");
  await expect(page.getByRole("button", { name: "닫기", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await updateLog(page))?.installCalls ?? 0).toBe(0);
});

test("accepting after another window began downloading says it is downloading there", async ({
  page,
}) => {
  await start(page);
  await offer(page);
  // Both windows were asked before either accepted; the other one was first.
  await page.evaluate(() => window.__tote.backend.installElsewhere());
  await page.getByRole("button", { name: "업데이트하고 다시 시작" }).click();
  await expect(dialog(page)).toHaveText("새 버전 tote 0.2.0 을 다른 창에서 받는 중입니다.닫기");
  await expect(page.getByRole("button", { name: "다시 시도" })).toHaveCount(0);
  expect((await updateLog(page))?.installCalls ?? 0).toBe(0);
});
