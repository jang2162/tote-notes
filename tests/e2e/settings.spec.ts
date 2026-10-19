import { expect, test, type Page } from "@playwright/test";

import { LONG_LINE_LIMIT } from "../../src/app/docs";
import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, nextWindow, paneSession, start, startWindows } from "./helpers";

const PKG = { name: "night", publisher: "someone", version: "1.0.0", displayName: "Night Theme" };

test("the settings screen shows the root, the themes and the extensions, and saves changes", async ({
  page,
}) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await expect(panel.locator("h2")).toHaveText(["워크스페이스", "테마", "확장"]);
  await expect(panel.locator("input[name=workspaceRoot]")).toHaveValue("");
  await panel.locator("input[name=workspaceRoot]").fill("~/노트");
  await panel.locator("button", { hasText: "루트 저장" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.workspaceRoot))
    .toBe("~/노트");
  await expect(panel.locator(".root-note")).toContainText("새로 여는 창부터");
  await panel.locator("select[name=dark]").selectOption({ label: "Light+ (tote.themes)" });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.theme.dark))
    .toEqual({ extension: "tote.themes", label: "Light+" });
  await expect(panel.locator(".extension-row")).toHaveText([
    /tote 기본 언어 묶음/,
    /tote 마크다운 미리보기/,
    /tote 미디어 뷰어/,
    /tote 기본 테마/,
  ]);
  await expect(panel.locator(".extension-row input[type=checkbox]")).toHaveCount(0); // bundled: no switch
  await expect(panel.locator(".extension-row button")).toHaveCount(0); // bundled: no remove
});

test("installing, replacing, disabling and removing a user extension", async ({ page }) => {
  await start(page, {
    packages: { "/pkg/night.vsix": PKG, "/pkg/night2.vsix": { ...PKG, version: "2.0.0" } },
    picks: ["/pkg/night.vsix", "/pkg/night2.vsix"],
  });
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  const row = panel.locator(".extension-row", { hasText: "Night Theme" });
  await expect(row).toContainText("someone.night@1.0.0");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await expect(page.locator(".modal.confirm")).toContainText(
    "someone.night 1.0.0 이(가) 이미 설치돼 있습니다",
  );
  await page.locator(".modal.confirm button", { hasText: "교체" }).click();
  await expect(row).toContainText("someone.night@2.0.0");
  await row.locator("input[type=checkbox]").uncheck();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.extensions.disabled))
    .toEqual(["someone.night"]);
  await row.locator("input[type=checkbox]").check();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.extensions.disabled))
    .toEqual([]);
  await row.locator("button", { hasText: "제거" }).click();
  await page.locator(".modal.confirm button", { hasText: "제거" }).click();
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toHaveCount(0);
});

test("precedence is a radio and problems are listed", async ({ page }) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("input[name=precedence][value=bundled]").check();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.extensions.precedence))
    .toBe("bundled");
  await expect(panel.locator(".extension-problems")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("Escape closes only the confirmation on top of the settings screen", async ({ page }) => {
  await start(page, {
    packages: { "/pkg/night.vsix": PKG },
    picks: ["/pkg/night.vsix"],
  });
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await panel.locator(".extension-row", { hasText: "Night Theme" }).locator("button").click();
  await expect(page.locator(".modal.confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal.confirm")).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toBeVisible();
});

test("installing an extension makes the next file read its language files again", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("a.sh", "echo a"), b: fakeMemo("b.sh", "echo b") },
    packages: { "/pkg/night.vsix": PKG },
    picks: ["/pkg/night.vsix"],
  });
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const read = backend.readExtensionFile.bind(backend);
    (window as unknown as { configReads: string[] }).configReads = [];
    backend.readExtensionFile = (extensionId: string, path: string) => {
      if (path.startsWith("language-configuration/"))
        (window as unknown as { configReads: string[] }).configReads.push(path);
      return read(extensionId, path);
    };
  });
  const reads = () =>
    page.evaluate(() => (window as unknown as { configReads: string[] }).configReads.length);
  await page.locator(".memo-row", { hasText: "a" }).first().click();
  await expect.poll(reads).toBeGreaterThan(0);
  const before = await reads();
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".memo-row", { hasText: "b" }).first().click();
  await expect.poll(reads).toBeGreaterThan(before);
});

// A language file cut by a reload says nothing about the file: the page that is leaving does not
// warn about it (src/core/leaving.ts), one that stays does.
for (const leaving of [false, true]) {
  test(`a language configuration that cannot be read ${leaving ? "is not warned about while the page is leaving" : "is warned about"}`, async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    await start(page, { memos: { a: fakeMemo("a.sh", "echo a") } });
    await page.evaluate((unload) => {
      const backend = window.__tote.backend;
      const read = backend.readExtensionFile.bind(backend);
      (window as unknown as { cut: number }).cut = 0;
      backend.readExtensionFile = (extensionId: string, path: string) => {
        if (!path.startsWith("language-configuration/")) return read(extensionId, path);
        (window as unknown as { cut: number }).cut++;
        return Promise.reject(new TypeError("Load failed"));
      };
      if (unload) dispatchEvent(new Event("pagehide"));
    }, leaving);
    await page.locator(".memo-row", { hasText: "a" }).first().click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { cut: number }).cut))
      .toBeGreaterThan(0);
    // A round trip to the page: the rejection has been caught by now.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const own = warnings.filter((text) => text.includes("language configuration of"));
    expect(own).toHaveLength(leaving ? 0 : 1);
  });
}

test("a manifest problem is listed with its path", async ({ page }) => {
  await start(page, {
    problems: [{ path: "/ext/broken@1.0.0", message: "package.json 을 읽을 수 없습니다" }],
  });
  await menu(page, "settings");
  const problems = page.locator(".modal.settings .extension-problems");
  await expect(problems).toBeVisible();
  await expect(problems.locator("li")).toHaveText([
    "/ext/broken@1.0.0: package.json 을 읽을 수 없습니다",
  ]);
});

test("an unsaved root survives another setting being saved", async ({ page }) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("input[name=workspaceRoot]").fill("~/아직");
  await panel.locator("select[name=dark]").selectOption({ label: "Light+ (tote.themes)" });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.theme.dark))
    .not.toBeNull();
  await expect(panel.locator("input[name=workspaceRoot]")).toHaveValue("~/아직");
  expect(await page.evaluate(() => window.__tote.backend.data.settings.workspaceRoot)).toBeNull();
});

test("saving a theme keeps a switch flipped a moment before", async ({ page }) => {
  await start(page, {
    userExtensions: [
      {
        id: "someone.night",
        version: "1.0.0",
        displayName: "Night Theme",
        source: "user",
        enabled: true,
        path: "/x",
      },
    ],
  });
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toBeVisible();
  // The backend takes the switch; the screen has not heard of it when the theme is saved.
  await page.evaluate(async () => {
    const backend = window.__tote.backend;
    const handlers = (backend as unknown as { handlers: { config: (() => void)[] } }).handlers
      .config;
    const held = handlers.splice(0);
    await backend.setExtensionEnabled("someone.night", false);
    handlers.push(...held);
  });
  await panel.locator("select[name=light]").selectOption({ label: "Light+ (tote.themes)" });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.theme.light))
    .not.toBeNull();
  expect(
    await page.evaluate(() => window.__tote.backend.data.settings.extensions.disabled),
  ).toEqual(["someone.night"]);
});

// One FakeBackend cannot back two pages, so the other window is the test writing the backend's
// settings itself — once, at the next settings read, which is where a screen that reads the
// whole settings and writes them back would pick up the old value.
test("two settings screens do not undo each other", async ({ page }) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await expect(panel.locator(".extension-row").first()).toBeVisible();
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const read = backend.settings.bind(backend);
    let otherWindowSaved = false;
    backend.settings = async () => {
      const current = await read();
      if (!otherWindowSaved) {
        otherWindowSaved = true;
        backend.data.settings.workspaceRoot = "~/다른 창";
      }
      return current;
    };
  });
  await panel.locator("select[name=dark]").selectOption({ label: "Light+ (tote.themes)" });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.theme.dark))
    .toEqual({ extension: "tote.themes", label: "Light+" });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.workspaceRoot))
    .toBe("~/다른 창");
});

test("a second ⌘, does not pile a second settings screen", async ({ page }) => {
  await start(page);
  await menu(page, "settings");
  await menu(page, "settings");
  await expect(page.locator(".modal.settings")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal.settings")).toHaveCount(0);
});

test("a theme that is not installed shows the default", async ({ page }) => {
  await start(page, {
    settings: {
      workspaceRoot: null,
      theme: { light: { extension: "gone.theme", label: "Gone" }, dark: null },
      extensions: { disabled: [], precedence: "user" },
      editor: { lineNumbers: true, fontSize: 14, fontFamily: "" },
    },
  });
  await menu(page, "settings");
  await expect(page.locator(".modal.settings select[name=light] option:checked")).toHaveText(
    "기본",
  );
});

test("a folder dialog that fails says so instead of vanishing", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.__tote.backend.pickFolder = () => Promise.reject(new Error("dialog failed"));
  });
  await menu(page, "settings");
  await page.locator(".modal.settings button", { hasText: "폴더 선택…" }).click();
  await expect(page.locator(".modal.settings .modal-error")).not.toHaveText("");
});

// Replacing an extension with the same version installs a new folder; what was read from the
// old one is as stale as after any other change.
test("replacing an extension with the same version makes the next file read again", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("a.sh", "echo a"), b: fakeMemo("b.sh", "echo b") },
    packages: { "/pkg/night.vsix": PKG },
    picks: ["/pkg/night.vsix", "/pkg/night.vsix"],
  });
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const read = backend.readExtensionFile.bind(backend);
    (window as unknown as { configReads: string[] }).configReads = [];
    backend.readExtensionFile = (extensionId: string, path: string) => {
      if (path.startsWith("language-configuration/"))
        (window as unknown as { configReads: string[] }).configReads.push(path);
      return read(extensionId, path);
    };
  });
  const reads = () =>
    page.evaluate(() => (window as unknown as { configReads: string[] }).configReads.length);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".memo-row", { hasText: "a" }).first().click();
  await expect.poll(reads).toBeGreaterThan(0);
  const before = await reads();
  await menu(page, "settings");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await page.locator(".modal.confirm button", { hasText: "교체" }).click();
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".memo-row", { hasText: "b" }).first().click();
  await expect.poll(reads).toBeGreaterThan(before);
});

const lineMemos = {
  a: fakeMemo("가.md", "첫째\n둘째", { modifiedMs: 4 }),
  b: fakeMemo("나.md", "셋째", { modifiedMs: 3 }),
  c: fakeMemo("다.md", "넷째", { modifiedMs: 2 }),
  d: fakeMemo("라.md", "다섯째", { modifiedMs: 1 }),
};

/** What the settings screen does for another window: save, then the backend's change event. */
async function patch(page: Page, patch: object): Promise<void> {
  await page.evaluate(async (change) => {
    const backend = window.__tote.backend;
    await backend.patchSettings(change);
  }, patch);
}

test("line numbers show by default and switch off in every tab and window", async ({ context }) => {
  const first = await startWindows(context, {
    memos: lineMemos,
    session: paneSession([
      [
        { kind: "memo", memoId: "a" },
        { kind: "memo", memoId: "c" },
      ],
      [{ kind: "memo", memoId: "b" }],
    ]),
  });
  await expect(first.locator(".cm-lineNumbers")).toHaveCount(2);
  await patch(first, { editorLineNumbers: false });
  await expect(first.locator(".cm-lineNumbers")).toHaveCount(0);
  // The hidden tab was reconfigured too, not only the two on screen.
  await first.locator(".pane").first().locator(".tab", { hasText: "다" }).click();
  await expect(first.locator(".cm-content", { hasText: "넷째" })).toBeVisible();
  await expect(first.locator(".cm-lineNumbers")).toHaveCount(0);
  await patch(first, { editorLineNumbers: true });
  await expect(first.locator(".cm-lineNumbers")).toHaveCount(2);
  await patch(first, { editorLineNumbers: false });
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await second.locator(".memo-row", { hasText: "라" }).click();
  await expect(second.locator(".cm-content")).toContainText("다섯째");
  await expect(second.locator(".cm-lineNumbers")).toHaveCount(0);
});

test("the editor font size follows the setting but the large text viewer stays at 14px", async ({
  page,
}) => {
  await start(page, { memos: lineMemos, picks: ["/x/huge.log"] });
  await page.evaluate(
    (data) => {
      const backend = window.__tote.backend as unknown as {
        storage: { save(text: string): void };
        data: { files: Record<string, string> };
      };
      backend.storage = { save: () => {} };
      backend.data.files["/x/huge.log"] = data;
    },
    fakeFile("L".repeat(LONG_LINE_LIMIT + 1)),
  );
  await page.locator(".memo-row", { hasText: "가" }).click();
  const size = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize);
  await expect.poll(() => size(".cm-scroller")).toBe("14px");
  await patch(page, { editorFontSize: 18 });
  await expect.poll(() => size(".cm-scroller")).toBe("18px");
  await menu(page, "open-file");
  await expect(page.locator(".large-text")).toBeVisible();
  expect(await size(".large-text-scroller")).toBe("14px");
  await patch(page, { editorFontFamily: "Courier" });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-font")),
    )
    .toBe("Courier");
  await patch(page, { editorFontFamily: "" });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-font")),
    )
    .toBe("");
});
