import { expect, test } from "@playwright/test";

import { fakeFile } from "../../src/backend/fake";
import { menu, ready, start } from "./helpers";

test("an external file keeps a draft across a restart and is written only on ⌘S", async ({
  page,
}) => {
  await start(page, { files: { "/x/a.sh": fakeFile("echo hi\n") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("a.sh");
  // The tab shows before its text: loading waits for the language's configuration too.
  await expect(page.locator(".cm-content")).toContainText("echo hi");
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
  await expect(page.locator(".editor-placeholder p")).toHaveText("열 수 없음");
  await expect(page.getByRole("button", { name: "텍스트로 열기" })).toBeVisible();
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

test("a non-text file with a viewer opens it; 텍스트로 열기 falls back to the editor path", async ({
  page,
}) => {
  // No bundled viewer opens PNG yet (the media viewer comes later), so a test viewer stands in.
  await start(page, {
    files: {
      "/x/사진.png": fakeFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      // The NUL keeps it binary when read as text.
      "/x/doc.pdf": fakeFile(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00])),
    },
    picks: ["/x/사진.png"],
    extraViewers: [
      {
        info: {
          extension: "test.ok",
          id: "ok",
          kind: "primary",
          extensions: ["png"],
          entry: "ok.html",
        },
        url: "/tests/e2e/pages/viewers/ok.html",
      },
    ],
  });
  await menu(page, "open-file");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  await expect(page.frameLocator("iframe.viewer-frame").locator("body")).toHaveAttribute(
    "data-file",
    "사진.png",
  );
  await expect(page.locator(".editor-placeholder")).toBeHidden();
  // `pickFiles` hands over every pick at once, so the second file is picked on its own.
  await page.evaluate(() => {
    window.__tote.backend.data.picks = ["/x/doc.pdf"];
  });
  await menu(page, "open-file");
  // PDF has no bundled viewer: the placeholder stays, with the text fallback.
  await expect(page.locator(".editor-placeholder p")).toHaveText("열 수 없음");
  await page.getByRole("button", { name: "텍스트로 열기" }).click();
  await expect(page.locator(".editor-placeholder p")).toHaveText("텍스트로 열 수 없음");
  // Leaving the image tab takes its viewer down with its token; coming back brings a new one.
  await page.locator(".tab", { hasText: "사진.png" }).click();
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  await page.locator(".tab", { hasText: "doc.pdf" }).click();
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  expect(await page.evaluate(() => window.__tote.backend.data.tokens)).toEqual({});
});
