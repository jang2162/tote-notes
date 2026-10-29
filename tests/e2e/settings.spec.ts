import { expect, test, type Locator, type Page } from "@playwright/test";

import { LONG_LINE_LIMIT } from "../../src/app/docs";
import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, nextWindow, paneSession, ready, start, startWindows } from "./helpers";

const PKG = { name: "night", publisher: "someone", version: "1.0.0", displayName: "Night Theme" };

/** Opens the settings screen and picks the section whose tab reads `name`. */
async function openSection(page: Page, name: string): Promise<Locator> {
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await section(panel, name);
  return panel;
}

async function section(panel: Locator, name: string): Promise<void> {
  await panel.getByRole("tab", { name, exact: true }).click();
}

test("the settings screen shows the root, the themes and the extensions, and saves changes", async ({
  page,
}) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await expect(panel.getByRole("tab")).toHaveText([
    "일반",
    "워크스페이스",
    "편집기",
    "모양",
    "단축키",
    "확장",
  ]);
  await expect(panel.locator("input[name=workspaceRoot]")).toHaveValue("");
  await panel.locator("input[name=workspaceRoot]").fill("~/노트");
  await panel.getByRole("button", { name: "적용", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.workspaceRoot))
    .toBe("~/노트");
  await expect(panel.locator(".root-note")).toHaveText(
    "루트는 새로 여는 창부터 적용됩니다. 열린 창은 그대로입니다.",
  );
  await section(panel, "모양");
  await panel.locator("select[name=dark]").selectOption({ label: "Light+ (tote.themes)" });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.theme.dark))
    .toEqual({ extension: "tote.themes", label: "Light+" });
  await section(panel, "확장");
  await expect(panel.locator(".extension-row")).toHaveText([
    /Tote Notes 기본 언어 묶음/,
    /Tote Notes 마크다운 미리보기/,
    /Tote Notes 미디어 뷰어/,
    /Tote Notes 기본 테마/,
  ]);
  await expect(panel.locator(".extension-row input[type=checkbox]")).toHaveCount(0); // bundled: no switch
  await expect(panel.locator(".extension-row button")).toHaveCount(0); // bundled: no remove
});

test("installing, replacing, disabling and removing a user extension", async ({ page }) => {
  await start(page, {
    packages: { "/pkg/night.vsix": PKG, "/pkg/night2.vsix": { ...PKG, version: "2.0.0" } },
    picks: ["/pkg/night.vsix", "/pkg/night2.vsix"],
  });
  const panel = await openSection(page, "확장");
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
  const panel = await openSection(page, "확장");
  await panel.locator("input[name=precedence][value=bundled]").check();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.extensions.precedence))
    .toBe("bundled");
  await expect(panel.locator(".extension-problems")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("the update check switch saves updates.autoCheck", async ({ page }) => {
  await start(page);
  const panel = await openSection(page, "일반");
  const box = panel.getByRole("checkbox", { name: "실행할 때 업데이트 확인" });
  await expect(box).toBeChecked();
  await expect(panel.locator(".update-note")).toHaveText(
    "끄면 Tote Notes 는 실행할 때 github.com 에 새 버전을 묻지 않습니다. 메뉴 Tote Notes → 업데이트 확인… 으로 직접 확인할 수 있습니다.",
  );
  await box.uncheck();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.updates))
    .toEqual({ autoCheck: false });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await openSection(page, "일반");
  await expect(page.getByRole("checkbox", { name: "실행할 때 업데이트 확인" })).not.toBeChecked();
});

test("Escape closes only the confirmation on top of the settings screen", async ({ page }) => {
  await start(page, {
    packages: { "/pkg/night.vsix": PKG },
    picks: ["/pkg/night.vsix"],
  });
  const panel = await openSection(page, "확장");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await panel.locator(".extension-row", { hasText: "Night Theme" }).locator("button").click();
  await expect(page.locator(".modal.confirm")).toBeVisible();
  // Every modal is a labelled one, not only the settings screen.
  await expect(
    page.getByRole("dialog", { name: "Night Theme 을(를) 제거할까요?" }),
  ).toHaveAttribute("aria-modal", "true");
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
  const panel = await openSection(page, "확장");
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
    const own = () => warnings.filter((text) => text.includes("language configuration of"));
    if (!leaving) await expect.poll(() => own().length).toBe(1);
    // Every read has settled, so a warning it was going to give has been given: exactly one, or
    // none while leaving.
    await page.evaluate(() => Promise.all(window.__tote.app.languageConfigs.values()));
    expect(own()).toHaveLength(leaving ? 0 : 1);
  });
}

test("a manifest problem is listed with its path", async ({ page }) => {
  await start(page, {
    problems: [{ path: "/ext/broken@1.0.0", message: "package.json 을 읽을 수 없습니다" }],
  });
  await openSection(page, "확장");
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
  await section(panel, "모양");
  await panel.locator("select[name=dark]").selectOption({ label: "Light+ (tote.themes)" });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.theme.dark))
    .not.toBeNull();
  await section(panel, "일반");
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
  const panel = await openSection(page, "확장");
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
  await section(panel, "모양");
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
  const panel = await openSection(page, "확장");
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
  await section(panel, "모양");
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
      updates: { autoCheck: true },
    },
  });
  await openSection(page, "모양");
  await expect(page.locator(".modal.settings select[name=light] option:checked")).toHaveText(
    "기본",
  );
});

test("the root field shows the default root, and its folder dialog opens at the root in use", async ({
  page,
}) => {
  // `~/.tote` is hidden: a dialog left to start where it last was cannot be walked into it.
  await start(page, {
    roots: { current: "/Users/me/Notes", default: "/Users/me/.tote", defaultShown: "~/.tote" },
    picks: ["/Users/me/메모들"],
  });
  await menu(page, "settings");
  const root = page.locator(".modal.settings input[name=workspaceRoot]");
  await expect(root).toHaveAttribute("placeholder", "~/.tote");
  await page.locator(".modal.settings button", { hasText: "폴더 선택…" }).click();
  await expect(root).toHaveValue("/Users/me/메모들");
  // The root in use, not the default: the settings name another one.
  expect(await page.evaluate(() => window.__tote.backend.data.folderStarts)).toEqual([
    "/Users/me/Notes",
  ]);
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
  const panel = await openSection(page, "확장");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".memo-row", { hasText: "a" }).first().click();
  await expect.poll(reads).toBeGreaterThan(0);
  const before = await reads();
  await openSection(page, "확장");
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

test("line numbers switch in a window whose tabs include a viewer that has no editor state", async ({
  page,
}) => {
  // The sandboxed viewer's probe of its parent is reported as a SecurityError, whenever it runs.
  const errors: Error[] = [];
  page.on("pageerror", (error) => error.name !== "SecurityError" && errors.push(error));
  await start(page, {
    memos: lineMemos,
    files: { "/x/사진.png": fakeFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) },
    picks: ["/x/사진.png"],
    session: paneSession([[{ kind: "memo", memoId: "a" }]]),
  });
  await menu(page, "open-file");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  await patch(page, { editorLineNumbers: false });
  // The memo tab behind the viewer was reconfigured and nothing threw on the viewer.
  await page.locator(".tab", { hasText: "가" }).click();
  await expect(page.locator(".cm-content")).toContainText("첫째");
  await expect(page.locator(".cm-lineNumbers")).toHaveCount(0);
  await patch(page, { editorLineNumbers: true });
  await expect(page.locator(".cm-lineNumbers")).toHaveCount(1);
  expect(errors).toEqual([]);
});

// The change event is the backend's to every window (`broadcast_config`), not only the saver's.
test("line numbers switch off in a window that was open before the change", async ({ context }) => {
  const first = await startWindows(context, {
    memos: lineMemos,
    session: paneSession([[{ kind: "memo", memoId: "a" }]]),
  });
  const [second] = await Promise.all([nextWindow(first), menu(first, "new-window")]);
  await second.locator(".memo-row", { hasText: "라" }).click();
  await expect(second.locator(".cm-content")).toContainText("다섯째");
  await expect(first.locator(".cm-lineNumbers")).toHaveCount(1);
  await expect(second.locator(".cm-lineNumbers")).toHaveCount(1);
  await patch(first, { editorLineNumbers: false });
  await expect(first.locator(".cm-lineNumbers")).toHaveCount(0);
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
    .toBe("Courier, var(--large-text-font)");
  await patch(page, { editorFontFamily: "" });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-font")),
    )
    .toBe("");
  // A value CSS cannot read bare is quoted, as one family no one has: the last one is not kept,
  // and the default font stands behind it.
  await patch(page, { editorFontFamily: '"Fira' });
  await patch(page, { editorFontFamily: "Fira Code; color: red" });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-font")),
    )
    .toBe('"Fira Code; color: red", var(--large-text-font)');
});

test("settings open on 일반 and remember the last section in the window", async ({ page }) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  const selected = panel.locator("[role=tab][aria-selected=true]");
  await expect(selected).toHaveText("일반");
  await expect(panel.getByRole("tabpanel")).toHaveCount(1);
  await expect(panel.locator("input[name=workspaceRoot]")).toBeVisible();
  await section(panel, "모양");
  await expect(selected).toHaveText("모양");
  await expect(panel.getByRole("tabpanel")).toHaveCount(1);
  await expect(panel.locator("input[name=workspaceRoot]")).toBeHidden();
  await expect(panel.locator("select[name=light]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await menu(page, "settings");
  await expect(selected).toHaveText("모양");
  await expect(panel.locator("select[name=light]")).toBeVisible();
  await section(panel, "편집기");
  await panel.getByRole("button", { name: "닫기" }).click();
  await menu(page, "settings");
  await expect(selected).toHaveText("편집기");
  // Only the window keeps it: the page loaded again starts on 일반.
  await page.keyboard.press("Escape");
  await page.reload();
  await ready(page);
  await menu(page, "settings");
  await expect(selected).toHaveText("일반");
});

test("the editor section saves line numbers, font size and font at once", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const patchSettings = backend.patchSettings.bind(backend);
    (window as unknown as { patches: object[] }).patches = [];
    backend.patchSettings = (change) => {
      (window as unknown as { patches: object[] }).patches.push(change);
      return patchSettings(change);
    };
  });
  const patches = () => page.evaluate(() => (window as unknown as { patches: object[] }).patches);
  const editor = () => page.evaluate(() => window.__tote.backend.data.settings.editor);
  const panel = await openSection(page, "편집기");
  const lineNumbers = panel.getByLabel("줄번호 표시");
  const size = panel.getByLabel("글꼴 크기");
  const font = panel.getByLabel("글꼴", { exact: true });
  await expect(lineNumbers).toBeChecked();
  await expect(size).toHaveValue("14");
  await expect(size).toHaveAttribute("min", "11");
  await expect(size).toHaveAttribute("max", "24");
  await expect(font).toHaveValue("");
  await expect(font).toHaveAttribute("placeholder", "기본 글꼴");

  await lineNumbers.uncheck();
  await expect.poll(editor).toEqual({ lineNumbers: false, fontSize: 14, fontFamily: "" });
  await size.fill("18");
  await size.press("Enter");
  await expect.poll(editor).toEqual({ lineNumbers: false, fontSize: 18, fontFamily: "" });
  await font.fill("Menlo");
  await font.press("Tab");
  await expect.poll(editor).toEqual({ lineNumbers: false, fontSize: 18, fontFamily: "Menlo" });
  expect(await patches()).toEqual([
    { editorLineNumbers: false },
    { editorFontSize: 18 },
    { editorFontFamily: "Menlo" },
  ]);

  // Out of range is brought into it before it is saved, and the field shows what was saved.
  await size.fill("30");
  await size.press("Enter");
  await expect(size).toHaveValue("24");
  await expect.poll(editor).toEqual({ lineNumbers: false, fontSize: 24, fontFamily: "Menlo" });
  expect((await patches()).at(-1)).toEqual({ editorFontSize: 24 });
  // A field left empty is no size: it goes back to the saved one and nothing is sent.
  await size.fill("");
  await size.press("Enter");
  await expect(size).toHaveValue("24");
  expect(await patches()).toHaveLength(4);

  await page.keyboard.press("Escape");
  await menu(page, "settings");
  await expect(lineNumbers).not.toBeChecked();
  await expect(size).toHaveValue("24");
  await expect(font).toHaveValue("Menlo");
});

test("a font size with a fraction is saved as the whole number nearest it", async ({ page }) => {
  await start(page);
  const panel = await openSection(page, "편집기");
  const size = panel.getByLabel("글꼴 크기");
  await size.fill("14.5");
  await size.press("Enter");
  await expect(size).toHaveValue("15");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.editor.fontSize))
    .toBe(15);
});

test("a font size or font whose save failed is sent again as it is", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    const patchSettings = backend.patchSettings.bind(backend);
    const w = window as unknown as { patches: object[]; failures: number };
    w.patches = [];
    w.failures = 0;
    backend.patchSettings = (change) => {
      w.patches.push(change);
      return w.failures-- > 0
        ? Promise.reject(new Error("디스크가 가득 찼습니다"))
        : patchSettings(change);
    };
  });
  const failOnce = () =>
    page.evaluate(() => ((window as unknown as { failures: number }).failures = 1));
  const patches = () => page.evaluate(() => (window as unknown as { patches: object[] }).patches);
  const editor = () => page.evaluate(() => window.__tote.backend.data.settings.editor);
  const panel = await openSection(page, "편집기");
  const error = panel.locator(".modal-error");
  const size = panel.getByLabel("글꼴 크기");
  const font = panel.getByLabel("글꼴", { exact: true });
  await expect(size).toHaveValue("14");

  await failOnce();
  await size.fill("18");
  await size.press("Enter");
  await expect(error).toHaveText("오류: 디스크가 가득 찼습니다");
  // The same value again goes out once more and is saved.
  await size.press("Enter");
  await expect.poll(editor).toEqual({ lineNumbers: true, fontSize: 18, fontFamily: "" });
  await expect(error).toHaveText("");

  await failOnce();
  await font.fill("Menlo");
  await font.press("Enter");
  await expect(error).toHaveText("오류: 디스크가 가득 찼습니다");
  await font.press("Enter");
  await expect.poll(editor).toEqual({ lineNumbers: true, fontSize: 18, fontFamily: "Menlo" });
  expect(await patches()).toEqual([
    { editorFontSize: 18 },
    { editorFontSize: 18 },
    { editorFontFamily: "Menlo" },
    { editorFontFamily: "Menlo" },
  ]);
});

test("the root is saved with 적용 or Enter and only 닫기 is primary", async ({ page }) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  const root = panel.getByLabel("워크스페이스 루트");
  const saved = () => page.evaluate(() => window.__tote.backend.data.settings.workspaceRoot);
  await expect(root).toHaveAttribute("name", "workspaceRoot");
  await root.fill("~/적용");
  expect(await saved()).toBeNull();
  await panel.getByRole("button", { name: "적용", exact: true }).click();
  await expect.poll(saved).toBe("~/적용");
  await root.fill("~/엔터");
  await root.press("Enter");
  await expect.poll(saved).toBe("~/엔터");
  await expect(panel.getByRole("button", { name: "적용", exact: true })).not.toHaveClass(/primary/);
  await section(panel, "확장");
  await expect(panel.locator(".extension-row").first()).toBeVisible();
  // Every section's buttons, the hidden ones too.
  await expect(panel.locator("button.primary")).toHaveText(["닫기"]);
});

test("closing the settings, by Escape or 「닫기」, ends every config subscription it made", async ({
  page,
}) => {
  await start(page);
  // The controller's listeners for the open settings screen: its own and its shortcut section's.
  const listening = () =>
    page.evaluate(
      () =>
        (window.__tote.app as unknown as { configListeners: Set<unknown> }).configListeners.size,
    );
  for (const close of ["Escape", "닫기"]) {
    await menu(page, "settings");
    await expect(page.locator(".modal.settings")).toBeVisible();
    expect(await listening(), close).toBeGreaterThan(0);
    if (close === "Escape") await page.keyboard.press("Escape");
    else await page.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(page.locator(".modal.settings")).toHaveCount(0);
    await expect.poll(listening, { message: close }).toBe(0);
  }
});

test("the settings dialog is a labelled modal and its sections are tabs", async ({ page }) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await expect(panel).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
  const title = await panel.getAttribute("aria-labelledby");
  await expect(panel.locator(`#${title}`)).toHaveText("설정");
  await expect(panel.locator(".modal-error")).toHaveAttribute("aria-live", "polite");
  await expect(panel.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");

  const tab = (name: string) => panel.getByRole("tab", { name, exact: true });
  const shows = async (name: string) => {
    await expect(tab(name)).toBeFocused();
    await expect(tab(name)).toHaveAttribute("aria-selected", "true");
    await expect(panel.locator("[role=tab][aria-selected=true]")).toHaveCount(1);
    const controls = await tab(name).getAttribute("aria-controls");
    const shown = panel.getByRole("tabpanel");
    await expect(shown).toHaveCount(1);
    await expect(shown).toHaveAttribute("id", controls!);
  };
  // The selected section's tab takes the focus as the screen opens.
  await shows("일반");
  const height = (await panel.boundingBox())!.height;
  await page.keyboard.press("ArrowDown");
  await shows("워크스페이스");
  await page.keyboard.press("ArrowDown");
  await shows("편집기");
  await page.keyboard.press("End");
  await shows("확장");
  await expect(panel.locator(".extension-row").first()).toBeVisible();
  expect((await panel.boundingBox())!.height).toBe(height);
  await page.keyboard.press("ArrowDown");
  await shows("일반");
  await page.keyboard.press("ArrowUp");
  await shows("확장");
  await page.keyboard.press("Home");
  await shows("일반");
});

/** Whether the editor's text is drawn in a font of one width: "iiii" as wide as "MMMM". */
const editorIsMonospace = (page: Page) =>
  page.locator(".cm-scroller").evaluate((scroller) => {
    const width = (text: string) => {
      const span = document.createElement("span");
      span.textContent = text;
      scroller.append(span);
      const measured = span.getBoundingClientRect().width;
      span.remove();
      return measured;
    };
    return Math.abs(width("iiiiiiiiii") - width("MMMMMMMMMM")) < 0.5;
  });

test("a font that is not there falls back to the default monospace, not to serif", async ({
  page,
}) => {
  await start(page, { memos: lineMemos });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await editorIsMonospace(page)).toBe(true);
  await patch(page, { editorFontFamily: "NoSuchFont Zz" });
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((el) => getComputedStyle(el).fontFamily))
    .toContain("NoSuchFont Zz");
  expect(await editorIsMonospace(page)).toBe(true);
  // A name CSS cannot read as it is is quoted, and still falls back.
  await patch(page, { editorFontFamily: "3270 Nope" });
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((el) => getComputedStyle(el).fontFamily))
    .toContain("3270 Nope");
  expect(await editorIsMonospace(page)).toBe(true);
  // A newline in a hand-edited name: unescaped it would end the CSS string and throw the editor
  // theme's rule away, the font size with it.
  await patch(page, { editorFontSize: 18, editorFontFamily: "3270\nNope" });
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((el) => getComputedStyle(el).fontSize))
    .toBe("18px");
  expect(await editorIsMonospace(page)).toBe(true);
});

/** Each line number's box against its line's: [gutter top, line top, gutter height, line height]. */
const numberedLines = (page: Page) =>
  page.locator(".cm-editor").evaluate((editor) => {
    // Without the spacer CodeMirror sizes the gutter with, which is hidden and has no height.
    const numbers = [
      ...editor.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement"),
    ].filter((el) => el.style.visibility !== "hidden");
    const lines = [...editor.querySelectorAll(".cm-line")];
    return lines.map((line, at) => {
      const a = numbers[at].getBoundingClientRect();
      const b = line.getBoundingClientRect();
      return [Math.round(a.top), Math.round(b.top), Math.round(a.height), Math.round(b.height)];
    });
  });

test("a new font size remeasures the open editors, so the line numbers stay with their lines", async ({
  page,
}) => {
  await start(page, {
    // Plain text: Markdown's colours come in a moment later, and their redraw measures the editor
    // anyway, which would hide a measure the font change did not ask for.
    memos: { a: fakeMemo("가.txt", "하나\n둘\n셋\n넷\n다섯\n여섯", { modifiedMs: 4 }) },
  });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await expect(page.locator(".cm-line")).toHaveCount(6);
  const aligned = (boxes: number[][]) =>
    boxes.every(([gutterTop, lineTop, gutterHeight, lineHeight]) => {
      return Math.abs(gutterTop - lineTop) <= 1 && Math.abs(gutterHeight - lineHeight) <= 1;
    });
  expect(aligned(await numberedLines(page))).toBe(true);
  const before = await numberedLines(page);
  await patch(page, { editorFontSize: 24 });
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((el) => getComputedStyle(el).fontSize))
    .toBe("24px");
  // The lines grew; the numbers follow at the next measure, without a click or a resize. Not
  // polled: some later update of the editor measures it anyway, and would hide a missing one.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  const after = await numberedLines(page);
  expect(after[5][1]).toBeGreaterThan(before[5][1]);
  expect(aligned(after), JSON.stringify(after)).toBe(true);
});
