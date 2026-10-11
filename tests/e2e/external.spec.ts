import { expect, test } from "@playwright/test";

import { fakeFile } from "../../src/backend/fake";
import { menu, ready, start } from "./helpers";

test("an external file keeps a draft across a restart and is written only on ⌘S", async ({
  page,
}) => {
  await start(page, { files: { "/x/a.sh": fakeFile("echo hi\n") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("a.sh");
  // The tab shows before its text, which is still being read.
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
  // A text file whose bytes are not text: reading it again would fail the same way.
  await expect(page.locator(".editor-placeholder p")).toHaveText("텍스트로 열 수 없음");
  await expect(page.getByRole("button", { name: "텍스트로 열기" })).toHaveCount(0);
});

test("a .txt that is not UTF-8 says so at once, without 텍스트로 열기", async ({ page }) => {
  await start(page, {
    files: { "/x/latin1.txt": fakeFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9])) },
    picks: ["/x/latin1.txt"],
  });
  await menu(page, "open-file");
  await expect(page.locator(".editor-placeholder p")).toHaveText("텍스트로 열 수 없음");
  await expect(page.getByRole("button", { name: "텍스트로 열기" })).toHaveCount(0);
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
  await start(page, {
    files: {
      "/x/사진.png": fakeFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      // The NUL keeps it binary when read as text.
      "/x/doc.pdf": fakeFile(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00])),
    },
    picks: ["/x/사진.png"],
  });
  await menu(page, "open-file");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  // The bundled media viewer opens it and captions it with the file name.
  await expect(page.frameLocator("iframe.viewer-frame").locator(".media-caption")).toContainText(
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

const FILE = fakeFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
const testViewer = (url: string) => ({
  info: {
    extension: "test",
    id: "test",
    kind: "primary" as const,
    extensions: ["pdf"],
    entry: "viewer.html",
  },
  url,
});

test("a viewer that fails in the app leaves 열 수 없음 and 텍스트로 열기, and its token goes", async ({
  page,
}) => {
  await start(page, {
    files: { "/x/사진.pdf": FILE },
    picks: ["/x/사진.pdf"],
    extraViewers: [testViewer("/tests/e2e/pages/viewers/failing.html")],
  });
  await menu(page, "open-file");
  await expect(page.locator(".editor-placeholder p")).toHaveText("열 수 없음");
  await expect(page.getByRole("button", { name: "텍스트로 열기" })).toBeVisible();
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.tokens)).toEqual({});
});

test("a resolveRelative answered after its view closed leaves no token, even for the tab's next view", async ({
  page,
}) => {
  await start(page, {
    files: { "/x/사진.pdf": FILE, "/x/pic.pdf": FILE, "/x/a.txt": fakeFile("text") },
    picks: ["/x/a.txt"],
    extraViewers: [testViewer("/tests/e2e/pages/viewers/ok.html?rel=pic.pdf")],
  });
  await menu(page, "open-file");
  // Every resolveRelative answers a second late.
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const resolve = backend.resolveRelative.bind(backend);
    const counter = window as unknown as { resolveCalls: number; resolveDone: number };
    counter.resolveCalls = 0;
    counter.resolveDone = 0;
    backend.resolveRelative = async (...args) => {
      counter.resolveCalls++;
      await new Promise((done) => setTimeout(done, 1000));
      try {
        return await resolve(...args);
      } finally {
        counter.resolveDone++;
      }
    };
    backend.data.picks = ["/x/사진.pdf"];
  });
  const calls = () =>
    page.evaluate(() => (window as unknown as { resolveCalls: number }).resolveCalls);
  await menu(page, "open-file");
  await expect.poll(calls).toBe(1);
  // Away and back while the first view's answer is still on its way.
  await page.locator(".tab", { hasText: "a.txt" }).click();
  await page.locator(".tab", { hasText: "사진.pdf" }).click();
  await expect.poll(calls).toBe(2);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { resolveDone: number }).resolveDone))
    .toBe(2);
  // Both answers are in, and the controller has had its turn after the later one.
  await page.evaluate(() => new Promise((done) => setTimeout(done, 50)));
  // Only the open view holds tokens: its file and its pic.pdf.
  expect(
    await page.evaluate(() =>
      Object.values(window.__tote.backend.data.tokens).map((urls) => urls.length),
    ),
  ).toEqual([2]);
  await page.locator(".tab", { hasText: "a.txt" }).click();
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.tokens)).toEqual({});
});

test("a draft whose file changed on disk opens with the conflict banner", async ({ page }) => {
  await start(page, {
    files: { "/x/a.sh": fakeFile("v1") },
    drafts: { "/x/a.sh": { base: fakeFile("v0"), data: fakeFile("mine") } },
    picks: ["/x/a.sh"],
  });
  await menu(page, "open-file");
  await expect(page.locator(".cm-content")).toHaveText("mine");
  const banner = page.locator(".banner");
  await expect(banner.locator(".banner-text")).toHaveText(
    "다른 앱이 이 파일을 바꿨습니다. 어느 쪽을 둘까요?",
  );
  await expect(page.locator(".tab.active")).toHaveClass(/dirty/);
  await banner.getByRole("button", { name: "디스크 버전" }).click();
  await expect(page.locator(".cm-content")).toHaveText("v1");
  await expect(banner).toBeHidden();
  await expect(page.locator(".tab.active")).not.toHaveClass(/dirty/);
  expect(await page.evaluate(() => window.__tote.backend.data.drafts)).toEqual({});
});

test("an external file edited elsewhere while clean is reread", async ({ page }) => {
  await start(page, { files: { "/x/a.sh": fakeFile("v1") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".cm-content")).toHaveText("v1");
  // The tab asked to be told about the file.
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.watched))
    .toEqual({ "/x/a.sh": 1 });
  await page.evaluate(
    ([data]) => {
      const backend = window.__tote.backend;
      backend.data.files["/x/a.sh"] = data;
      backend.outside({ kind: "external", path: "/x/a.sh", state: "modified" });
    },
    [fakeFile("v2")] as const,
  );
  await expect(page.locator(".cm-content")).toHaveText("v2");
  await expect(page.locator(".banner")).toBeHidden();
  await expect(page.locator(".tab.active")).not.toHaveClass(/dirty/);
  await menu(page, "close-tab");
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.watched)).toEqual({});
});
