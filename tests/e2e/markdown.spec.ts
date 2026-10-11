import { expect, test, type Page } from "@playwright/test";

import { RECOVERED_NOTICE } from "../../src/app/docs";
import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, ready, start } from "./helpers";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const frame = (page: Page) => page.frameLocator("iframe.viewer-frame");

const DOC = [
  "# 회의 준비",
  "",
  "- 안건 **하나**",
  "",
  "![그림](pic.png)",
  "![원격](https://example.com/x.png)",
  "![밖](../secret.png)",
  "",
  '<img src="pic.png" onerror="document.body.dataset.pwned=1">',
  "<script>document.body.dataset.pwned = 2</script>",
  "",
  "[링크](https://example.com)",
].join("\n");

test("⇧⌘V shows the rendered Markdown and ⇧⌘V again the editor; the mode is in the session", async ({
  page,
}) => {
  await start(page, {
    memos: {
      a: fakeMemo("회의.md", DOC),
      pic: { file: "pic.png", autoTitle: false, data: fakeFile(PNG), modifiedMs: 1 },
    },
  });
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await menu(page, "toggle-preview");
  const body = frame(page).locator("body");
  await expect(body.locator("h1")).toHaveText("회의 준비");
  await expect(body.locator("li strong")).toHaveText("하나");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"mode":"preview"');
  await menu(page, "toggle-preview");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .not.toContain('"mode"');
});

test("images in the same folder load through resolveRelative; outside the folder and remote images stay blank", async ({
  page,
}) => {
  await start(page, {
    memos: {
      a: fakeMemo("회의.md", DOC),
      pic: { file: "pic.png", autoTitle: false, data: fakeFile(PNG), modifiedMs: 1 },
    },
  });
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await menu(page, "toggle-preview");
  const body = frame(page).locator("body");
  await expect(body.locator("img[alt='그림']")).toHaveAttribute("src", /^data:image\/png/);
  await expect(body.locator("img[alt='원격']")).toHaveCount(0);
  await expect(body.locator(".blocked-image", { hasText: "원격" })).toHaveCount(1);
  await expect(body.locator("img[alt='밖']")).toHaveCount(0);
  await expect(body.locator(".blocked-image", { hasText: "밖" })).toHaveCount(1);
});

test("HTML in the Markdown cannot run scripts or handlers, and links do not navigate the frame", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("회의.md", DOC) } });
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await menu(page, "toggle-preview");
  const body = frame(page).locator("body");
  await expect(body.locator("a", { hasText: "링크" })).toBeVisible();
  await body.locator("a", { hasText: "링크" }).click();
  await page.waitForTimeout(300);
  expect(await body.getAttribute("data-pwned")).toBeNull();
  await expect(body.locator("h1")).toHaveText("회의 준비"); // still our page, not example.com
});

// The CSP would stop a handler or a script from running even if one got through; these look at
// the DOM, so they hold the viewer's own stripping to account.
test("the sanitizer drops on* handlers and script tags independently of CSP", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("회의.md", DOC),
      pic: { file: "pic.png", autoTitle: false, data: fakeFile(PNG), modifiedMs: 1 },
    },
  });
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await menu(page, "toggle-preview");
  const main = frame(page).locator("#main");
  await expect(main.locator("h1")).toHaveText("회의 준비");
  // The raw <img> stays (only its handler goes): it and ![그림] both load pic.png.
  await expect(main.locator('img[src^="data:image/png"]')).toHaveCount(2);
  await expect(main.locator("[onerror]")).toHaveCount(0);
  await expect(main.locator("script")).toHaveCount(0);
});

test("the status bar keeps a document's notice over the preview hint", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("a.md", "# 처음") } });
  await page.locator(".memo-row", { hasText: "a" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  // The file goes away under the tab: the next save recovers it as a new memo.
  await page.evaluate(() => delete window.__tote.backend.data.memos.a);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.insertText(" 둘");
  await expect(page.locator(".status-message")).toHaveText(RECOVERED_NOTICE);
  await menu(page, "toggle-preview");
  await expect(frame(page).locator("body h1")).toHaveText("처음 둘");
  await expect(page.locator(".status-message")).toHaveText(RECOVERED_NOTICE);
});

test("the preview shows the text as it is when it opens, and the mode comes back after a restart", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("a.md", "# 처음") } });
  await page.locator(".memo-row", { hasText: "a" }).click();
  // Keys sent before the memo is in the editor are lost.
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  // One insert: a fast second key on an empty line can land first in WebKit (real input: Task 16).
  await page.keyboard.insertText("둘째");
  await menu(page, "toggle-preview");
  await expect(frame(page).locator("body p")).toHaveText("둘째");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"mode":"preview"');
  await page.reload();
  await ready(page);
  await expect(frame(page).locator("body h1")).toHaveText("처음");
});

test("a file without a preview viewer ignores ⇧⌘V", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("a.txt", "plain") } });
  await page.locator(".memo-row", { hasText: "a" }).click();
  await menu(page, "toggle-preview");
  await page.waitForTimeout(200);
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("a memo imported from a tab in preview stays in preview", async ({ page }) => {
  await start(page, { files: { "/x/n.md": fakeFile("# 가져옴") }, picks: ["/x/n.md"] });
  await menu(page, "open-file");
  await menu(page, "toggle-preview");
  await expect(frame(page).locator("body h1")).toHaveText("가져옴");
  await menu(page, "import");
  await expect(page.locator(".tab.active")).not.toHaveClass(/external/);
  await expect(frame(page).locator("body h1")).toHaveText("가져옴");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"mode":"preview"');
});

test("a preview that cannot start goes back to the editor with the text intact", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("a.md", "# 본문") } });
  await page.locator(".memo-row", { hasText: "a" }).click();
  await page.evaluate(() => {
    // A page that never says `ready`.
    window.__tote.backend.viewerUrl = () => "data:text/html,<p>silent</p>";
  });
  await menu(page, "toggle-preview");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0, { timeout: 9000 });
  await expect(page.locator(".cm-content")).toContainText("# 본문");
  await expect(page.locator(".status-message")).toHaveText(
    "미리보기를 열 수 없어 편집으로 돌아왔습니다",
  );
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .not.toContain('"mode"');
});

test("an area in an image map does not take the frame anywhere", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo(
        "a.md",
        '# 지도\n\n<map name="m"><area shape="rect" coords="0,0,9,9" href="https://example.com"></map>\n\n[링크](https://example.com)',
      ),
    },
  });
  await page.locator(".memo-row", { hasText: "a" }).click();
  await menu(page, "toggle-preview");
  const body = frame(page).locator("body");
  await expect(body.locator("h1")).toHaveText("지도");
  // The sanitiser drops the map; the click guard also covers an area that gets past it.
  await expect(body.locator("area")).toHaveCount(0);
  await body.locator("a", { hasText: "링크" }).click();
  await page.waitForTimeout(300);
  await expect(body.locator("h1")).toHaveText("지도");
});

test("a Markdown memo that detection turns into JSON on leaving ends in the editor, not in preview", async ({
  page,
}) => {
  await start(page, { memos: { a: { ...fakeMemo("a.md", '{"a": 1}'), autoTitle: true } } });
  await page.locator(".memo-row", { hasText: "a" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await menu(page, "toggle-preview");
  await expect(page.locator(".status-language")).toHaveText("JSON");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .not.toContain('"mode"');
});
