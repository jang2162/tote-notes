import { expect, test, type Page } from "@playwright/test";

import { RECOVERED_NOTICE } from "../../src/app/docs";
import { LINK_REFUSED, TASK_STALE } from "../../src/app/pane";
import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { LINK_OUTSIDE, linkMissing } from "../../src/viewer/links";
import { menu, ready, sessionPane, start } from "./helpers";

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

test("⇧⌘P shows the rendered Markdown and ⇧⌘P again the editor; the mode is in the session", async ({
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
    .poll(async () => (await sessionPane(page)).tabs.some((tab) => tab.mode === "preview"))
    .toBe(true);
  await menu(page, "toggle-preview");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect.poll(async () => (await sessionPane(page)).tabs.some((tab) => tab.mode)).toBe(false);
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
    .poll(async () => (await sessionPane(page)).tabs.some((tab) => tab.mode === "preview"))
    .toBe(true);
  await page.reload();
  await ready(page);
  await expect(frame(page).locator("body h1")).toHaveText("처음");
});

test("a file without a preview viewer ignores ⇧⌘P", async ({ page }) => {
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
    .poll(async () => (await sessionPane(page)).tabs.some((tab) => tab.mode === "preview"))
    .toBe(true);
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
  await expect.poll(async () => (await sessionPane(page)).tabs.some((tab) => tab.mode)).toBe(false);
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
  await expect.poll(async () => (await sessionPane(page)).tabs.some((tab) => tab.mode)).toBe(false);
});

// Spec 2026-11-14 md-preview: checkboxes, code colours and links.

const TASKS = [
  "# 할 일",
  "",
  "- [ ] 하나",
  "- [x] 둘",
  "",
  "```",
  "- [ ] 코드 안",
  "```",
  "",
  '<input type="checkbox" checked>',
  "",
  "> - [ ] 셋",
].join("\n");

const memoText = (page: Page, id: string) =>
  page.evaluate((memo) => window.__tote.backend.memoText(memo), id);

async function preview(page: Page, name: string): Promise<void> {
  await page.locator(".memo-row", { hasText: name }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await menu(page, "toggle-preview");
}

test("a task list shows checkboxes; a press flips the box in the text, and ⌘Z in the editor flips it back", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("할일.md", TASKS) } });
  await preview(page, "할일");
  const boxes = frame(page).locator("input[type=checkbox]");
  // The box written as HTML is dropped: only the three marked draws for the tasks are left.
  await expect(boxes).toHaveCount(3);
  await expect(boxes.nth(0)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await expect(boxes.nth(2)).not.toBeChecked();
  await expect(boxes.nth(0)).toBeEnabled();

  await boxes.nth(2).click();
  await expect.poll(() => memoText(page, "a")).toBe(TASKS.replace("> - [ ] 셋", "> - [x] 셋"));
  await expect(boxes.nth(2)).toBeChecked();
  await boxes.nth(1).click();
  await expect(boxes.nth(1)).not.toBeChecked();
  await expect
    .poll(() => memoText(page, "a"))
    .toBe(TASKS.replace("> - [ ] 셋", "> - [x] 셋").replace("- [x] 둘", "- [ ] 둘"));
  // The code block's line is not a task: it stays as written.
  expect(await memoText(page, "a")).toContain("- [ ] 코드 안");

  await menu(page, "toggle-preview");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".cm-content")).toContainText("- [x] 둘");
  await expect(page.locator(".cm-content")).toContainText("> - [x] 셋");
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".cm-content")).toContainText("> - [ ] 셋");
  await expect.poll(() => memoText(page, "a")).toBe(TASKS);
});

test("a press on a preview drawn from a text the tab no longer holds changes no line and draws it again", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("할일.md", "- [ ] 하나\n- [ ] 둘") } });
  await preview(page, "할일");
  const boxes = frame(page).locator("input[type=checkbox]");
  await expect(boxes).toHaveCount(2);
  // The text changes under the preview without it being drawn again.
  await page.evaluate(() => {
    const doc = window.__tote.app.focused.tabs.active!;
    const start = doc.state!;
    const { state } = start.update({ changes: { from: 0, insert: "- [ ] 새 줄\n" } });
    doc.update({ state, startState: start, docChanged: true, selectionSet: false });
  });
  await boxes.nth(1).click();
  await expect(page.locator(".status-message")).toHaveText(TASK_STALE);
  await expect(boxes).toHaveCount(3);
  await expect.poll(() => memoText(page, "a")).toBe("- [ ] 새 줄\n- [ ] 하나\n- [ ] 둘");
  // Drawn again from the text as it is, the press goes to the line under it.
  await boxes.nth(1).click();
  await expect.poll(() => memoText(page, "a")).toBe("- [ ] 새 줄\n- [x] 하나\n- [ ] 둘");
});

test("a press whose answer comes after its tab left the pane changes nothing", async ({ page }) => {
  // The first press loads marked (`import("../viewer/tasks")`): held here until the tab is gone.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const asked = new Promise<void>((resolve) => (reached = resolve));
  await page.route("**/src/viewer/tasks.ts*", async (route) => {
    reached();
    await held;
    await route.continue();
  });
  await start(page, {
    memos: { a: fakeMemo("할일.md", "- [ ] 하나"), b: fakeMemo("다른.md", "x") },
  });
  await preview(page, "할일");
  const boxes = frame(page).locator("input[type=checkbox]");
  await expect(boxes).toHaveCount(1);
  await boxes.nth(0).click();
  await asked;
  await page.locator(".memo-row", { hasText: "다른" }).click();
  await expect(page.locator(".cm-content")).toHaveText("x");
  release();
  // Back on show, a press now flips the box once: had the first one landed, this would flip it
  // back (the presses are taken in turn, each after marked is in).
  await page.locator(".memo-row", { hasText: "할일" }).click();
  await expect(boxes).toHaveCount(1);
  await expect(boxes.nth(0)).not.toBeChecked();
  await boxes.nth(0).click();
  await expect(boxes.nth(0)).toBeChecked();
  await expect.poll(() => memoText(page, "a")).toBe("- [x] 하나");
});

test("a press in the preview of a tab that takes no edits changes nothing", async ({ page }) => {
  await start(page, {
    memos: { a: fakeMemo("할일.md", "- [ ] 하나\n- [ ] 둘\n\n[웹](https://example.com/)") },
  });
  await preview(page, "할일");
  const boxes = frame(page).locator("input[type=checkbox]");
  await expect(boxes).toHaveCount(2);
  // A press first, so that marked is in and a press is answered in the turn it is taken.
  await boxes.nth(1).click();
  await expect.poll(() => memoText(page, "a")).toContain("- [x] 둘");
  // The tab turns read-only under the preview, which still offers its boxes.
  await page.evaluate(() => {
    const doc = window.__tote.app.focused.tabs.active!;
    const start = doc.state!;
    const Kind = start.constructor as typeof start.constructor & {
      create: (config: object) => typeof start;
      readOnly: { of: (value: boolean) => object };
    };
    doc.state = Kind.create({ doc: start.doc, extensions: Kind.readOnly.of(true) });
  });
  await boxes.nth(0).click();
  // A link pressed after it: its call is the sign the box's request has been taken.
  await frame(page).locator("a").click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.openedLinks))
    .toEqual(["https://example.com/"]);
  const text = await page.evaluate(() =>
    window.__tote.app.focused.tabs.active!.state!.doc.toString(),
  );
  expect(text).toBe("- [ ] 하나\n- [x] 둘\n\n[웹](https://example.com/)");
  await expect(boxes.nth(0)).not.toBeChecked();
});

test("a preview viewer of another extension is not given the Markdown preview's requests", async ({
  page,
}) => {
  // It asks for everything a preview may ask (tests/e2e/pages/viewers/requests.html).
  await start(page, {
    memos: { a: fakeMemo("할일.mdx", "- [ ] a") },
    extraViewers: [
      {
        info: {
          extension: "someone.preview",
          id: "mdx",
          kind: "preview",
          extensions: ["mdx"],
          entry: "viewer.html",
        },
        url: "/tests/e2e/pages/viewers/requests.html",
      },
    ],
  });
  await preview(page, "할일");
  // Answered after the host has taken every request it sent.
  await expect(frame(page).locator("body")).toHaveAttribute("data-resolved", "9");
  expect(await page.evaluate(() => window.__tote.backend.data.openedLinks)).toBeUndefined();
  expect(
    await page.evaluate(() => window.__tote.app.focused.tabs.active!.state!.doc.toString()),
  ).toBe("- [ ] a");
});

test("a trashed memo's read-only tab shows no preview, so no box to press", async ({ page }) => {
  await start(page, { trash: { t: { ...fakeMemo("할일.md", "- [ ] 하나"), deletedMs: 5 } } });
  await page.getByRole("button", { name: "휴지통", exact: true }).click();
  await page.locator(".trash-row", { hasText: "할일" }).click();
  await expect(page.locator(".cm-content")).toHaveText("- [ ] 하나");
  await menu(page, "toggle-preview");
  await menu(page, "versions");
  // Asked after it, the last command has answered: the preview would be on show by now.
  await expect(page.locator(".status-message")).toHaveText("메모 탭에서만 쓸 수 있습니다");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  expect(await page.evaluate(() => window.__tote.backend.trashedText("t"))).toBe("- [ ] 하나");
});

test("a code block in a language with a grammar comes coloured; one in an unknown language stays plain", async ({
  page,
}) => {
  await start(page, {
    memos: {
      a: fakeMemo(
        "코드.md",
        ["```ts", "const a = 1; // 하나", "```", "", "```cobol", "MOVE A TO B", "```"].join("\n"),
      ),
    },
  });
  await preview(page, "코드");
  const code = frame(page).locator("pre > code");
  await expect(code).toHaveCount(2);
  await expect(code.nth(0).locator("span.tok").first()).toBeVisible();
  await expect(code.nth(0)).toHaveText("const a = 1; // 하나\n");
  const colors = await code
    .nth(0)
    .locator("span.tok")
    .evaluateAll((spans) => [...new Set(spans.map((s) => (s as HTMLElement).style.color))]);
  // Keyword, number and comment in their own colours, as the editor draws them.
  expect(colors.filter(Boolean).length).toBeGreaterThanOrEqual(3);
  await expect(code.nth(1).locator("span")).toHaveCount(0);
  await expect(code.nth(1)).toHaveText("MOVE A TO B\n");
});

const LINKS = [
  "# 링크",
  "",
  "[준비](회의%20준비.md) [없음](없는.md) [밖](../밖.md) [하위](sub/a.md)",
  "",
  "[웹](https://example.com/a?b=1) [메일](mailto:a@example.com) [파일](file:///etc/hosts)",
  "",
  "[나쁜](javascript:alert(1)) [아래로](#끝-제목)",
  "",
  ...Array.from({ length: 80 }, (_, i) => `문단 ${i}\n`),
  "## 끝 제목",
].join("\n");

test("a link to a memo of the workspace opens it in a tab; one to no memo says so in the status bar", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("링크.md", LINKS), b: fakeMemo("회의 준비.md", "# 준비") },
  });
  await preview(page, "링크");
  const link = (name: string) => frame(page).locator("a", { hasText: name });
  await expect(link("준비")).toHaveAttribute("title", "회의 준비.md");
  await link("없음").click();
  await expect(page.locator(".status-message")).toHaveText(linkMissing("없는.md"));
  await link("밖").click();
  await expect(page.locator(".status-message")).toHaveText(LINK_OUTSIDE);
  await link("하위").click();
  await expect(page.locator(".status-message")).toHaveText(LINK_OUTSIDE);
  await expect(page.locator(".tab")).toHaveCount(1);
  await link("준비").click();
  await expect(page.locator(".tab.active")).toHaveText(/회의 준비/);
  await expect(page.locator(".tab")).toHaveCount(2);
});

test("a web or mail link goes to the backend's open_link with its URL; javascript: and file: call nothing", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("링크.md", LINKS) } });
  await preview(page, "링크");
  const link = (name: string) => frame(page).locator("a", { hasText: name });
  await expect(link("나쁜")).not.toHaveAttribute("href", /.*/);
  await link("나쁜").click();
  await link("파일").click();
  await expect(page.locator(".status-message")).toHaveText(`${LINK_REFUSED}: file:///etc/hosts`);
  await link("웹").click();
  await link("메일").click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.openedLinks))
    .toEqual(["https://example.com/a?b=1", "mailto:a@example.com"]);
  // Still our page: no link took the frame anywhere.
  await expect(frame(page).locator("h1")).toHaveText("링크");
});

test("a #fragment link scrolls the preview to its heading", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("링크.md", LINKS) } });
  await preview(page, "링크");
  await expect(frame(page).locator("h2")).toHaveText("끝 제목");
  const viewer = page.frames().find((f) => f.url().includes("markdown-preview"))!;
  expect(await viewer.evaluate(() => scrollY)).toBe(0);
  await frame(page).locator("a", { hasText: "아래로" }).click();
  await expect.poll(() => viewer.evaluate(() => scrollY)).toBeGreaterThan(100);
  expect(await page.evaluate(() => window.__tote.backend.data.openedLinks ?? [])).toEqual([]);
});
