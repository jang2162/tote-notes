import { describe, expect, it, vi } from "vitest";

import { defaultFakeData, FAKE_LABEL, FakeBackend, fakeMemo, memoryStorage } from "./fake";
import type { BackendError, TabRef } from "./types";

describe("FakeBackend settings", () => {
  it("hands out a copy, so a caller's edit is not a save", async () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    const copy = await backend.settings();
    copy.theme.dark = { extension: "x", label: "y" };
    copy.extensions.disabled.push("z");
    expect((await backend.settings()).theme.dark).toBeNull();
    expect((await backend.settings()).extensions.disabled).toEqual([]);
  });

  it("keeps a bundled extension enabled even when its id is listed as disabled", async () => {
    const data = defaultFakeData();
    data.settings.extensions.disabled = ["tote.themes"];
    const backend = new FakeBackend(memoryStorage(JSON.stringify(data)));
    const registry = await backend.extensionRegistry();
    const bundled = registry.extensions.filter((e) => e.source === "bundled");
    expect(bundled.length).toBeGreaterThan(0);
    expect(bundled.every((e) => e.enabled)).toBe(true);
  });
});

describe("FakeBackend write counts", () => {
  it("start from nothing in data stored before they were counted", async () => {
    const data: Partial<ReturnType<typeof defaultFakeData>> = {
      ...defaultFakeData(),
      memos: { a: fakeMemo("a.md", "a") },
    };
    delete data.memoWrites;
    delete data.layoutWrites;
    const backend = new FakeBackend(memoryStorage(JSON.stringify(data)));
    await backend.writeMemo("a", new TextEncoder().encode("b"));
    await backend.writeWindowLayout(JSON.stringify({ panes: [], focusedPane: 0 }));
    expect(backend.data.memoWrites).toEqual({ a: 1 });
    expect(Object.values(backend.data.layoutWrites)).toEqual([1]);
  });
});

describe("FakeBackend whileWritingLayout", () => {
  it("is kept for the switch's flush round, not used up by a write outside one", async () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    let ran = 0;
    backend.whileWritingLayout = () => ran++;
    await backend.writeWindowLayout(JSON.stringify({ panes: [], focusedPane: 0 }));
    expect(ran).toBe(0);
    expect(backend.whileWritingLayout).not.toBeNull();
  });
});

describe("FakeBackend tear-off during a switch", () => {
  it("refuses a tab while the switch round is open and until the window stays, as Rust does", async () => {
    const data = defaultFakeData();
    data.workspaces.push({
      name: "개인",
      path: "/fake/개인",
      open: false,
      windows: 0,
      missing: false,
    });
    data.otherWorkspaces = {
      "/fake/개인": {
        workspace: { ...data.workspace, id: "workspace-2", name: "개인", path: "/fake/개인" },
        memos: {},
        session: null,
      },
    };
    // The switch cannot open its target: the window stays, and the page does not reload.
    data.unopenable = ["/fake/개인"];
    const backend = new FakeBackend(memoryStorage(JSON.stringify(data)));
    const ref: TabRef = { kind: "memo", id: "a" };
    const tearOff = () =>
      backend.tearOffTab(JSON.stringify({ kind: "memo", memoId: "a" }), ref).then(
        () => "moved",
        (error: BackendError) => error.code,
      );
    const inRound: string[] = [];
    backend.onFlush((id) => {
      void tearOff().then((code) => {
        inRound.push(code);
        return backend.flushDone(id);
      });
    });
    let release = () => {};
    backend.switchGate = new Promise((resolve) => (release = resolve));
    const switched = backend.switchWorkspace("/fake/개인");
    await vi.waitFor(() => expect(inRound).toEqual(["window-busy"]));
    // Answered, the switch waits before it swaps the workspace: the native side's `in_switch`.
    await vi.waitFor(() => expect(backend.data.flushed).toHaveLength(1));
    expect(await tearOff()).toBe("window-busy");
    release();
    expect(await switched).toBe("switching");
    // Stayed: the tab is the backend's to refuse for its own reasons now (it holds no place here).
    expect(await tearOff()).toBe("io");
  });
});

describe("FakeBackend editor settings", () => {
  it("starts with line numbers on, the default size and no font of its own", async () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    expect((await backend.settings()).editor).toEqual({
      lineNumbers: true,
      fontSize: 14,
      fontFamily: "",
    });
  });

  it("clamps the font size to 11–24 like the Rust side and rounds a fraction", async () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    await backend.patchSettings({ editorFontSize: 30 });
    expect((await backend.settings()).editor.fontSize).toBe(24);
    await backend.patchSettings({ editorFontSize: 3 });
    expect((await backend.settings()).editor.fontSize).toBe(11);
    await backend.patchSettings({ editorFontSize: 16.6 });
    expect((await backend.settings()).editor.fontSize).toBe(17);
  });

  it("keeps what a patch leaves out", async () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    await backend.patchSettings({ editorLineNumbers: false, editorFontFamily: "Menlo" });
    await backend.patchSettings({ editorFontSize: 18 });
    expect((await backend.settings()).editor).toEqual({
      lineNumbers: false,
      fontSize: 18,
      fontFamily: "Menlo",
    });
  });
});

describe("FakeBackend shortcuts", () => {
  it("answers the table with the saved shortcuts as the current ones", async () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    const before = await backend.shortcutTable();
    expect(before.commands.find((c) => c.id === "new-memo")?.current).toBe("CmdOrCtrl+N");
    expect(before.fixed.slice(0, 2)).toEqual([
      { name: "설정…", accelerator: "CmdOrCtrl+," },
      { name: "Tote Notes 종료", accelerator: "CmdOrCtrl+Q" },
    ]);

    await backend.patchSettings({
      shortcuts: { "new-memo": "CmdOrCtrl+Shift+M", rename: "CmdOrCtrl+K" },
    });
    const after = await backend.shortcutTable();
    const current = (id: string) => after.commands.find((c) => c.id === id)?.current;
    expect(current("new-memo")).toBe("CmdOrCtrl+Shift+M");
    expect(current("rename")).toBe("CmdOrCtrl+K");
    expect(current("save")).toBe("CmdOrCtrl+S");
    expect(after.commands.find((c) => c.id === "new-memo")?.default).toBe("CmdOrCtrl+N");
    expect((await backend.settings()).shortcuts).toEqual({
      "new-memo": "CmdOrCtrl+Shift+M",
      rename: "CmdOrCtrl+K",
    });

    // The whole map is replaced: what is left out goes back to its default.
    await backend.patchSettings({ shortcuts: {} });
    expect((await backend.shortcutTable()).commands.find((c) => c.id === "new-memo")?.current).toBe(
      "CmdOrCtrl+N",
    );
    expect((await backend.settings()).shortcuts).toBeUndefined();
  });

  // The rules of `shortcuts::validate` in src-tauri/src/shortcuts.rs, refused as Rust refuses
  // them (`InvalidInput` is "bad-request"), the whole patch with them.
  it("refuses a shortcut map Rust would refuse and saves nothing of the patch", async () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    // Rust names the first refused id in sorted order.
    const cases: [Record<string, string | null>, string][] = [
      [{ nope: "CmdOrCtrl+K" }, "nope"],
      [{ settings: "CmdOrCtrl+K" }, "settings"],
      [{ save: "Cmd+++" }, "save"],
      [{ rename: "K" }, "rename"],
      [{ rename: "Shift+K" }, "rename"],
      [{ rename: "Shift+F5" }, "rename"],
      [{ rename: "CmdOrCtrl+C" }, "rename"],
      [{ rename: "CmdOrCtrl+N" }, "rename"],
      [{ "close-window": "CmdOrCtrl+Shift+V" }, "close-window"],
      // ⌘Q is fixed, and so is the item it belongs to: no id for it to be saved under.
      [{ quit: "CmdOrCtrl+Shift+Q" }, "quit"],
      [{ quit: null }, "quit"],
      [{ rename: "CmdOrCtrl+Q" }, "rename"],
      [{ "open-file": "CmdOrCtrl+Shift+M", "new-memo": "CmdOrCtrl+Shift+M" }, "open-file"],
      [{ save: "CmdOrCtrl+C", rename: "CmdOrCtrl+S" }, "rename"],
    ];
    for (const [shortcuts, name] of cases) {
      const refused = backend.patchSettings({ shortcuts, editorFontSize: 20 });
      await expect(refused, JSON.stringify(shortcuts)).rejects.toMatchObject({
        code: "bad-request",
        message: `단축키를 저장할 수 없습니다: ${name}`,
      });
      expect((await backend.settings()).shortcuts).toBeUndefined();
      expect((await backend.settings()).editor.fontSize).toBe(14);
    }
    expect(backend.data.settings.shortcuts).toBeUndefined();
  });

  it("takes a map whose every entry stands", async () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    const shortcuts = { "new-memo": null, rename: "Cmd+N", save: "F5", "close-window": "Alt+F5" };
    await backend.patchSettings({ shortcuts });
    expect((await backend.settings()).shortcuts).toEqual(shortcuts);
    const current = (await backend.shortcutTable()).commands.find((c) => c.id === "rename");
    expect(current?.current).toBe("Cmd+N");
  });

  it("drops a bad saved entry on read and keeps the rest, as Rust does", async () => {
    const data = defaultFakeData();
    data.settings.shortcuts = {
      "new-memo": "CmdOrCtrl+Shift+M",
      nope: "CmdOrCtrl+K",
      rename: "CmdOrCtrl+C",
      "open-file": "CmdOrCtrl+Shift+M",
      "close-tab": null,
    };
    const backend = new FakeBackend(memoryStorage(JSON.stringify(data)));
    expect((await backend.settings()).shortcuts).toEqual({
      "new-memo": "CmdOrCtrl+Shift+M",
      "close-tab": null,
    });
    const current = (id: string) =>
      backend.shortcutTable().then((t) => t.commands.find((c) => c.id === id)?.current);
    expect(await current("open-file")).toBe("CmdOrCtrl+O");
    expect(await current("rename")).toBeNull();
    expect(await current("close-tab")).toBeNull();
  });

  it("refuses a patch made from a map that is no longer the saved one, whole", async () => {
    const data = defaultFakeData();
    data.settings.shortcuts = { save: "CmdOrCtrl+Shift+S", rename: null };
    const backend = new FakeBackend(memoryStorage(JSON.stringify(data)));
    const stale = backend.patchSettings({
      editorFontSize: 20,
      shortcuts: { rename: null },
      shortcutsExpected: {},
    });
    await expect(stale).rejects.toMatchObject({
      code: "bad-request",
      message: "shortcuts changed",
    });
    expect((await backend.settings()).shortcuts).toEqual({
      save: "CmdOrCtrl+Shift+S",
      rename: null,
    });
    expect((await backend.settings()).editor.fontSize).not.toBe(20);

    // The same entries in another order, `null` included, are the saved map.
    await backend.patchSettings({
      shortcuts: {},
      shortcutsExpected: { rename: null, save: "CmdOrCtrl+Shift+S" },
    });
    expect((await backend.settings()).shortcuts).toBeUndefined();
  });

  it("does not count an entry equal to its default as a change of the saved map", async () => {
    const data = defaultFakeData();
    data.settings.shortcuts = {
      save: "CmdOrCtrl+S",
      rename: null,
      "new-memo": "CmdOrCtrl+Shift+M",
    };
    const backend = new FakeBackend(memoryStorage(JSON.stringify(data)));
    await backend.patchSettings({
      shortcuts: { "close-tab": null },
      shortcutsExpected: { "new-memo": "CmdOrCtrl+Shift+M" },
    });
    expect((await backend.settings()).shortcuts).toEqual({ "close-tab": null });
  });

  it("keeps whether the shortcuts are off and every ask", async () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    expect(backend.data.shortcutsSuspended).toBeUndefined();
    await backend.suspendShortcuts(true);
    expect(backend.data.shortcutsSuspended).toBe(true);
    await backend.suspendShortcuts(false);
    expect(backend.data.shortcutsSuspended).toBe(false);
    expect(backend.data.suspendShortcutCalls).toEqual([true, false]);
  });
});

describe("FakeBackend window start", () => {
  const sessionWith = (sidebarCollapsed: unknown) =>
    JSON.stringify({ version: 2, windows: [{ panes: [], focusedPane: 0, sidebarCollapsed }] });

  it("is not macOS and expanded by default", () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    expect(backend.windowStart()).toEqual({
      label: FAKE_LABEL,
      macTitlebar: false,
      sidebarCollapsed: false,
    });
  });

  it("takes macOS from the seed and the sidebar from the window's saved layout", () => {
    const data = { ...defaultFakeData(), macTitlebar: true, session: sessionWith(true) };
    const backend = new FakeBackend(memoryStorage(JSON.stringify(data)));
    expect(backend.windowStart()).toMatchObject({ macTitlebar: true, sidebarCollapsed: true });
    const text = { ...data, session: sessionWith("true") };
    const other = new FakeBackend(memoryStorage(JSON.stringify(text)));
    expect(other.windowStart().sidebarCollapsed).toBe(false);
  });

  it("counts drags and zooms", async () => {
    const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
    await backend.startWindowDrag();
    await backend.startWindowDrag();
    await backend.toggleWindowZoom();
    await backend.toggleWindowZoom();
    expect(backend.data.windowDrags).toBe(2);
    expect(backend.data.windowZooms).toBe(2);
  });
});
