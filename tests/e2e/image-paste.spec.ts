import { expect, test, type Page } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { IMAGE_TOO_LARGE, MAX_IMAGE_BYTES } from "../../src/core/images";
import { menu, start } from "./helpers";

// Images put in a Markdown memo (docs/superpowers/specs/2026-11-14-tote-notes-image-paste-design.md).
// The real clipboard and Finder are the person's check: a paste here is a ClipboardEvent the test
// makes, and a drop is the fake's `dropFiles`, which stands for Tauri's drop event — wry keeps
// Finder's drop away from the page, so a DataTransfer drop is not the way the app sees one.

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

const frame = (page: Page) => page.frameLocator("iframe.viewer-frame");
const titles = (page: Page) => page.locator(".tab .tab-title");
const memoText = (page: Page, file: string) =>
  page.evaluate((name) => window.__tote.backend.memoTextByFile(name), file);
const imageCalls = (page: Page) => page.evaluate(() => window.__tote.backend.data.imageCalls ?? []);
const memoData = (page: Page, file: string) =>
  page.evaluate(
    (name) => Object.values(window.__tote.backend.data.memos).find((m) => m.file === name)?.data,
    file,
  );

/** A paste on the focused editor of what the clipboard would hold: text, and an image of `type`
 * that is the test PNG, or `size` zero bytes. */
async function paste(
  page: Page,
  clip: { text?: string; image?: { type: string; size?: number } },
): Promise<void> {
  await page.locator(".cm-content").evaluate(
    (content, { clip, png }) => {
      const data = new DataTransfer();
      if (clip.text !== undefined) data.setData("text/plain", clip.text);
      if (clip.image) {
        const bytes =
          clip.image.size === undefined ? Uint8Array.from(png) : new Uint8Array(clip.image.size);
        data.items.add(new File([bytes], "image", { type: clip.image.type }));
      }
      content.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { clip, png: Array.from(PNG) },
  );
}

/** Where the end of line `line` (from 1) of the editor is, in the page's CSS pixels. */
async function endOfLine(page: Page, line: number): Promise<{ x: number; y: number }> {
  const box = await page
    .locator(".cm-line")
    .nth(line - 1)
    .boundingBox();
  if (!box) throw new Error(`no line ${line}`);
  return { x: box.x + box.width - 4, y: box.y + box.height / 2 };
}

async function openMemo(page: Page, name: string, text: string): Promise<void> {
  await page.locator(".memo-row", { hasText: name }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".cm-content")).toHaveText(text);
}

test("a pasted image goes to the workspace as <memo> 이미지 and its link where the cursor is; the preview shows it", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("회의 준비.md", "앞\n뒤") } });
  await openMemo(page, "회의 준비", "앞뒤");
  await page.keyboard.press("End");
  await paste(page, { image: { type: "image/png" } });
  await expect.poll(() => memoText(page, "회의 준비.md")).toBe("앞![](<회의 준비 이미지.png>)\n뒤");
  expect(await memoData(page, "회의 준비 이미지.png")).toBe(PNG_BASE64);
  await expect(page.locator(".memo-row", { hasText: "회의 준비 이미지" })).toHaveCount(1);
  // The cursor is after the link: what is typed next follows it.
  await page.keyboard.insertText("!");
  await expect
    .poll(() => memoText(page, "회의 준비.md"))
    .toBe("앞![](<회의 준비 이미지.png>)!\n뒤");

  // The same name again takes ` 2`; a JPEG is a .jpg.
  await paste(page, { image: { type: "image/png" } });
  await paste(page, { image: { type: "image/jpeg" } });
  await expect
    .poll(() => memoText(page, "회의 준비.md"))
    .toBe(
      "앞![](<회의 준비 이미지.png>)!![](<회의 준비 이미지 2.png>)![](<회의 준비 이미지.jpg>)\n뒤",
    );
  expect(await imageCalls(page)).toEqual([
    { save: "회의 준비 이미지.png" },
    { save: "회의 준비 이미지.png" },
    { save: "회의 준비 이미지.jpg" },
  ]);

  await menu(page, "toggle-preview");
  const images = frame(page).locator("#main img");
  await expect(images).toHaveCount(3);
  for (let i = 0; i < 3; i++)
    await expect(images.nth(i)).toHaveAttribute("src", /^data:image\/(png|jpeg);base64,/);
  await expect(frame(page).locator(".blocked-image")).toHaveCount(0);
});

test("a paste replaces the selection, and one undo takes the link back out", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("a.md", "가나다") } });
  await openMemo(page, "a", "가나다");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Shift+ArrowLeft");
  await paste(page, { image: { type: "image/gif" } });
  await expect(page.locator(".cm-content")).toHaveText("가나![](<a 이미지.gif>)");
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".cm-content")).toHaveText("가나다");
});

test("with text on the clipboard as well, a paste puts the text in and saves no image", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("a.md", "") } });
  await openMemo(page, "a", "");
  await paste(page, { text: "글", image: { type: "image/png" } });
  await expect(page.locator(".cm-content")).toHaveText("글");
  // The image goes in through an asynchronous read and save; a paste that takes the image path
  // later shows the earlier one did not (the calls are recorded in order).
  await paste(page, { image: { type: "image/png" } });
  await expect(page.locator(".cm-content")).toHaveText("글![](<a 이미지.png>)");
  expect(await imageCalls(page)).toEqual([{ save: "a 이미지.png" }]);
});

test("a memo in another language and an external Markdown file take no image", async ({ page }) => {
  await start(page, {
    memos: { t: fakeMemo("목록.txt", "x"), m: fakeMemo("나중.md", "") },
    files: { "/x/밖.md": fakeFile("# 밖") },
  });
  await openMemo(page, "목록", "x");
  await paste(page, { image: { type: "image/png" } });
  await page.evaluate(() => window.__tote.backend.dropFiles(["/x/밖.md"]));
  await expect(page.locator(".tab.active .tab-title")).toHaveText("밖.md");
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".cm-content")).toHaveText("# 밖");
  await paste(page, { image: { type: "image/png" } });
  // The Markdown memo's paste is the first save asked for.
  await openMemo(page, "나중", "");
  await paste(page, { image: { type: "image/png" } });
  await expect(page.locator(".cm-content")).toHaveText("![](<나중 이미지.png>)");
  expect(await imageCalls(page)).toEqual([{ save: "나중 이미지.png" }]);
  expect(await memoText(page, "목록.txt")).toBe("x");
  expect(await page.evaluate(() => window.__tote.backend.fileText("/x/밖.md"))).toBe("# 밖");
});

test("an image over 20MB is not put in, and the status bar says why", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("a.md", "") } });
  await openMemo(page, "a", "");
  await paste(page, { image: { type: "image/png", size: MAX_IMAGE_BYTES + 1 } });
  // Refused before anything is read or sent: there is no save on its way to wait for.
  await expect(page.locator(".status-message")).toHaveText(IMAGE_TOO_LARGE);
  expect(await imageCalls(page)).toEqual([]);
  await expect(page.locator(".cm-content")).toHaveText("");
});

test("image files dropped on the editor are copied in and linked where they were let go, a line each", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("회의.md", "첫 줄\n둘째 줄") },
    files: { "/x/사진.png": fakeFile(PNG), "/x/둘 째.jpg": fakeFile(PNG) },
  });
  await openMemo(page, "회의", "첫 줄둘째 줄");
  const at = await endOfLine(page, 1);
  await page.evaluate(
    (point) => window.__tote.backend.dropFiles(["/x/사진.png", "/x/둘 째.jpg"], point),
    at,
  );
  await expect
    .poll(() => memoText(page, "회의.md"))
    .toBe("첫 줄![](사진.png)\n![](<둘 째.jpg>)\n둘째 줄");
  expect(await memoData(page, "사진.png")).toBe(PNG_BASE64);
  expect(await memoData(page, "둘 째.jpg")).toBe(PNG_BASE64);
  // The originals stay, and no tab opened for them.
  expect(await page.evaluate(() => Object.keys(window.__tote.backend.data.files).sort())).toEqual([
    "/x/둘 째.jpg",
    "/x/사진.png",
  ]);
  await expect(titles(page)).toHaveText(["회의"]);
  await menu(page, "toggle-preview");
  await expect(frame(page).locator("#main img")).toHaveCount(2);
  await expect(frame(page).locator(".blocked-image")).toHaveCount(0);
});

test("an image already in the workspace is linked as it is, not copied", async ({ page }) => {
  await start(page, {
    memos: {
      a: fakeMemo("a.md", ""),
      pic: { file: "pic.png", autoTitle: false, data: fakeFile(PNG), modifiedMs: 1 },
    },
  });
  await openMemo(page, "a", "");
  const at = await endOfLine(page, 1);
  await page.evaluate(
    (point) => window.__tote.backend.dropFiles(["/fake/메모/pic.png"], point),
    at,
  );
  await expect(page.locator(".cm-content")).toHaveText("![](pic.png)");
  expect(await page.evaluate(() => Object.keys(window.__tote.backend.data.memos).sort())).toEqual([
    "a",
    "pic",
  ]);
});

test("a file that is not an image, and a drop off the editor, open as external tabs", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("a.md", "") },
    files: { "/x/b.png": fakeFile(PNG), "/x/c.sh": fakeFile("echo c\n") },
  });
  await openMemo(page, "a", "");
  const at = await endOfLine(page, 1);
  await page.evaluate(
    (point) => window.__tote.backend.dropFiles(["/x/b.png", "/x/c.sh"], point),
    at,
  );
  await expect(page.locator(".tab.active .tab-title")).toHaveText("c.sh");
  await expect(titles(page)).toHaveText(["a", "c.sh"]);
  expect(await memoText(page, "a.md")).toBe("![](b.png)");

  // Over the memo list, not an editor: the image opens as a tab of its own.
  const row = await page.locator(".memo-row", { hasText: "a" }).first().boundingBox();
  if (!row) throw new Error("no memo row");
  const off = { x: row.x + row.width / 2, y: row.y + row.height / 2 };
  await page.evaluate((point) => window.__tote.backend.dropFiles(["/x/b.png"], point), off);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("b.png");
  expect(await imageCalls(page)).toEqual([{ import: "/x/b.png" }]);
});
