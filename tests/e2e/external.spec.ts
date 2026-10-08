import { expect, test } from "@playwright/test";

import { fakeFile } from "../../src/backend/fake";
import { menu, ready, start } from "./helpers";

test("an external file keeps a draft across a restart and is written only on ⌘S", async ({
  page,
}) => {
  await start(page, { files: { "/x/a.sh": fakeFile("echo hi\n") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("a.sh");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("echo more");
  await expect(page.locator(".tab.active")).toHaveClass(/dirty/);
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.drafts["/x/a.sh"] !== undefined))
    .toBe(true);
  expect(await page.evaluate(() => window.__tote.backend.fileText("/x/a.sh"))).toBe("echo hi\n");
  // The session is written a second after the last change; reload only once it lists the tab.
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"path":"/x/a.sh"');

  await page.reload();
  await ready(page);
  await expect(page.locator(".tab.active")).toHaveClass(/dirty/);
  await menu(page, "save");
  await expect(page.locator(".tab.active")).not.toHaveClass(/dirty/);
  expect(await page.evaluate(() => window.__tote.backend.fileText("/x/a.sh"))).toBe(
    "echo hi\necho more",
  );
  expect(await page.evaluate(() => window.__tote.backend.data.drafts)).toEqual({});
});

test("closing an edited external file asks first", async ({ page }) => {
  await start(page, { files: { "/x/a.sh": fakeFile("old") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("!");
  await menu(page, "close-tab");
  await page.getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".tab")).toHaveCount(1);
  await menu(page, "close-tab");
  await page.getByRole("button", { name: "버리기" }).click();
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(await page.evaluate(() => window.__tote.backend.fileText("/x/a.sh"))).toBe("old");
  expect(await page.evaluate(() => window.__tote.backend.data.drafts)).toEqual({});
});

test("importing turns the tab into a memo and leaves the original alone", async ({ page }) => {
  await start(page, { files: { "/x/deploy.sh": fakeFile("echo hi\n") }, picks: ["/x/deploy.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("deploy.sh");
  await menu(page, "import");
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["deploy"]);
  await expect(page.locator(".tab.active")).not.toHaveClass(/external/);
  expect(await page.evaluate(() => window.__tote.backend.memoTextByFile("deploy.sh"))).toBe(
    "echo hi\n",
  );
  expect(await page.evaluate(() => window.__tote.backend.fileText("/x/deploy.sh"))).toBe(
    "echo hi\n",
  );
});

test("a file that is not text shows a placeholder", async ({ page }) => {
  await start(page, {
    files: { "/x/data.bin": fakeFile(new Uint8Array([1, 0, 2])) },
    picks: ["/x/data.bin"],
  });
  await menu(page, "open-file");
  await expect(page.locator(".editor-placeholder")).toHaveText("텍스트로 열 수 없음");
});

test("files sent by a tote command open in tabs", async ({ page }) => {
  await start(page, { files: { "/x/a.sh": fakeFile("a") } });
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    backend.data.pending = [{ kind: "external", path: "/x/a.sh" }];
    backend.poke();
  });
  await expect(page.locator(".tab.active .tab-title")).toHaveText("a.sh");
});
