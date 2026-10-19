import { describe, expect, it } from "vitest";

import { defaultFakeData, FakeBackend, memoryStorage } from "./fake";

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
