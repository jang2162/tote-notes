import { describe, expect, it } from "vitest";

import fixture from "../../src-tauri/tests/fixtures/shortcut-table.json";
import { FAKE_FIXED_SHORTCUTS, FAKE_SHORTCUT_COMMANDS } from "../backend/fake-shortcuts";
import type { ShortcutTable } from "../backend/types";
import {
  acceleratorFromEvent,
  bindingsOf,
  conflict,
  editorBindings,
  formatAccelerator,
  recordableAccelerator,
  sameAccelerator,
  shortcutHint,
} from "./keys";

/** The table with nothing saved, but `current` overridden for the ids in `current`. */
function table(current: Record<string, string | null> = {}): ShortcutTable {
  return {
    commands: FAKE_SHORTCUT_COMMANDS.map((command) => ({
      ...command,
      current: Object.hasOwn(current, command.id) ? current[command.id] : command.default,
    })),
    fixed: FAKE_FIXED_SHORTCUTS,
  };
}

function key(
  code: string,
  mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
  keyName = code.startsWith("Key") ? code.slice(3).toLowerCase() : code,
) {
  return {
    key: keyName,
    code,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  };
}

describe("formatAccelerator", () => {
  it("writes the macOS symbols in ⌃⌥⇧⌘ order and the key after them", () => {
    expect(formatAccelerator("CmdOrCtrl+Shift+N")).toBe("⇧⌘N");
    expect(formatAccelerator("Alt+CmdOrCtrl+Left")).toBe("⌥⌘←");
    expect(formatAccelerator("CmdOrCtrl+\\")).toBe("⌘\\");
    expect(formatAccelerator("F5")).toBe("F5");
    expect(formatAccelerator("Shift+Ctrl+Alt+Cmd+k")).toBe("⌃⌥⇧⌘K");
    expect(formatAccelerator("CmdOrCtrl+Shift+]")).toBe("⇧⌘]");
    expect(formatAccelerator("CmdOrCtrl+,")).toBe("⌘,");
    expect(formatAccelerator("Ctrl+1")).toBe("⌃1");
    expect(formatAccelerator("Alt+CmdOrCtrl+Down")).toBe("⌥⌘↓");
  });
});

describe("acceleratorFromEvent", () => {
  it("reads the key from `code`, whatever ⌥ or the input method made of it", () => {
    expect(acceleratorFromEvent(key("KeyN", { meta: true, shift: true }, "N"))).toBe(
      "CmdOrCtrl+Shift+N",
    );
    expect(acceleratorFromEvent(key("KeyN", { meta: true, alt: true }, "˜"))).toBe(
      "Alt+CmdOrCtrl+N",
    );
    expect(acceleratorFromEvent(key("KeyN", { meta: true }, "ㅜ"))).toBe("CmdOrCtrl+N");
    expect(acceleratorFromEvent(key("KeyF", { meta: true, ctrl: true }))).toBe("Ctrl+CmdOrCtrl+F");
    expect(acceleratorFromEvent(key("ArrowLeft", { meta: true, alt: true }))).toBe(
      "Alt+CmdOrCtrl+Left",
    );
    expect(acceleratorFromEvent(key("Backslash", { meta: true, shift: true }, "|"))).toBe(
      "CmdOrCtrl+Shift+\\",
    );
    expect(acceleratorFromEvent(key("Digit1", { ctrl: true }, "1"))).toBe("Ctrl+1");
  });

  it("takes ⌘, ⌃ or ⌥ with a key, or F1–F12 alone, and nothing else", () => {
    expect(acceleratorFromEvent(key("KeyN"))).toBeNull();
    expect(acceleratorFromEvent(key("KeyK", { shift: true }, "K"))).toBeNull();
    expect(acceleratorFromEvent(key("F5"))).toBe("F5");
    expect(acceleratorFromEvent(key("F12"))).toBe("F12");
    expect(acceleratorFromEvent(key("F5", { shift: true }))).toBeNull();
    expect(acceleratorFromEvent(key("F5", { alt: true }))).toBe("Alt+F5");
    expect(acceleratorFromEvent(key("F13"))).toBeNull();
    expect(acceleratorFromEvent(key("Enter"))).toBeNull();
    expect(acceleratorFromEvent(key("Space", {}, " "))).toBeNull();
    expect(acceleratorFromEvent(key("ArrowUp", { shift: true }))).toBeNull();
    expect(acceleratorFromEvent(key("Enter", { meta: true }))).toBe("CmdOrCtrl+Enter");
  });

  it("leaves a modifier pressed alone unrecorded", () => {
    expect(acceleratorFromEvent(key("MetaLeft", { meta: true }, "Meta"))).toBeNull();
    expect(acceleratorFromEvent(key("ShiftRight", { shift: true }, "Shift"))).toBeNull();
    expect(acceleratorFromEvent(key("AltLeft", { alt: true, meta: true }, "Alt"))).toBeNull();
    expect(acceleratorFromEvent(key("ControlLeft", { ctrl: true }, "Control"))).toBeNull();
  });

  it("cancels on Esc and clears on Backspace or Delete, with or without modifiers", () => {
    expect(acceleratorFromEvent(key("Escape"))).toBe("cancel");
    expect(acceleratorFromEvent(key("Escape", { meta: true }))).toBe("cancel");
    expect(acceleratorFromEvent(key("Backspace"))).toBe("clear");
    expect(acceleratorFromEvent(key("Backspace", { meta: true }))).toBe("clear");
    expect(acceleratorFromEvent(key("Delete"))).toBe("clear");
  });

  it("records only what the menu could be given back", () => {
    for (const event of [
      key("KeyN", { meta: true, shift: true }, "N"),
      key("F5"),
      key("BracketLeft", { meta: true, shift: true }, "{"),
    ]) {
      const recorded = acceleratorFromEvent(event);
      expect(typeof recorded === "string" && recordableAccelerator(recorded)).toBe(true);
    }
  });
});

describe("recordableAccelerator", () => {
  // The cases of `a_shortcut_typing_would_hit_is_dropped` in src-tauri/src/shortcuts.rs.
  it("says what Rust's `recordable` says", () => {
    for (const keys of ["K", "Shift+K", "Shift+F5", "Enter", "Space", "Left", "Shift+Up", "1"])
      expect(recordableAccelerator(keys), keys).toBe(false);
    for (const keys of ["F5", "F12", "Alt+K", "Ctrl+Shift+K", "Cmd+Enter", "Alt+F5"])
      expect(recordableAccelerator(keys), keys).toBe(true);
    expect(recordableAccelerator("Cmd+++")).toBe(false);
  });
});

describe("sameAccelerator", () => {
  it("compares the keys, not the spelling", () => {
    expect(sameAccelerator("CmdOrCtrl+Shift+N", "Shift+Cmd+N")).toBe(true);
    expect(sameAccelerator("CmdOrCtrl+N", "Super+N")).toBe(true);
    expect(sameAccelerator("Command+N", "cmdorctrl+n")).toBe(true);
    expect(sameAccelerator("Option+KeyN", "Alt+N")).toBe(true);
    expect(sameAccelerator("CmdOrCtrl+N", "CmdOrCtrl+Shift+N")).toBe(false);
    expect(sameAccelerator("Ctrl+N", "CmdOrCtrl+N")).toBe(false);
    expect(sameAccelerator("Cmd+++", "Cmd+++")).toBe(false);
  });
});

describe("editorBindings", () => {
  it("lists the editor's keys as macOS has them, named after their commands", () => {
    const bindings = editorBindings();
    const named = (accelerator: string) =>
      bindings.filter((b) => sameAccelerator(b.accelerator, accelerator)).map((b) => b.name);
    expect(named("CmdOrCtrl+L")).toContain("selectLine");
    expect(named("CmdOrCtrl+Shift+\\")).toContain("cursorMatchingBracket");
    expect(named("CmdOrCtrl+F")).toContain("openSearchPanel");
    expect(named("Alt+CmdOrCtrl+Up")).toContain("addCursorAbove");
    // `mac:` wins: Mod-ArrowLeft is ⌥← on macOS, and ⌘← is another command's.
    expect(named("Alt+Left")).toContain("cursorGroupLeft");
    expect(named("CmdOrCtrl+Left")).toEqual(["cursorLineBoundaryLeft"]);
    // historyKeymap's Alt-u is ⇧⌘U on macOS.
    expect(named("Alt+U")).toEqual([]);
    // A binding's `shift:` is the same key with ⇧.
    expect(named("Alt+Shift+Left")).toContain("selectGroupLeft");
    expect(bindings.every((b) => b.name !== "")).toBe(true);
  });
});

describe("bindingsOf", () => {
  it("names a key after its function, and a function without a name 편집기 명령", () => {
    function named() {
      return true;
    }
    // A function a function returns has no name (an arrow written as `run:` would be `run`).
    const make = () => () => true;
    expect(
      bindingsOf([
        { key: "Mod-k", run: named },
        { key: "Mod-j", run: make(), shift: make() },
      ]),
    ).toEqual([
      { accelerator: "CmdOrCtrl+K", name: "named" },
      { accelerator: "CmdOrCtrl+J", name: "편집기 명령" },
      { accelerator: "Shift+CmdOrCtrl+J", name: "편집기 명령" },
    ]);
  });
});

describe("Rust's shortcut table", () => {
  // The fixture is what `shortcut_table` answers with nothing saved. A key TS cannot read would be
  // shown as the string it is (`formatAccelerator`), silently.
  it("has only shortcuts TS reads", () => {
    const shortcuts = [
      ...fixture.commands.flatMap((command) => (command.default ? [command.default] : [])),
      ...fixture.fixed.map((fixed) => fixed.accelerator),
    ];
    expect(shortcuts.length).toBeGreaterThan(30);
    // A bare F key is written as it is either way.
    for (const keys of shortcuts.filter((keys) => !/^F\d+$/.test(keys)))
      expect(formatAccelerator(keys), keys).not.toBe(keys);
  });
});

describe("conflict", () => {
  it("names the fixed key first, then another command, then the editor", () => {
    expect(conflict(table(), "rename", "CmdOrCtrl+N")).toEqual({
      kind: "command",
      id: "new-memo",
      label: "새 메모",
    });
    expect(conflict(table(), "rename", "CmdOrCtrl+C")).toEqual({ kind: "fixed", name: "복사하기" });
    expect(conflict(table(), "rename", "CmdOrCtrl+L")).toEqual({
      kind: "editor",
      name: "selectLine",
    });
    expect(conflict(table(), "rename", "Ctrl+Alt+CmdOrCtrl+J")).toBeNull();
  });

  it("does not hold a command's own key against it", () => {
    expect(conflict(table(), "split-pane-down", "CmdOrCtrl+Shift+\\")).toEqual({
      kind: "editor",
      name: "cursorMatchingBracket",
    });
    expect(conflict(table(), "new-memo", "CmdOrCtrl+N")).toBeNull();
  });

  it("goes by the shortcuts the commands have now", () => {
    const moved = table({ "new-memo": null, rename: "CmdOrCtrl+Shift+M" });
    expect(conflict(moved, "save", "CmdOrCtrl+N")).toBeNull();
    expect(conflict(moved, "save", "Shift+Cmd+M")).toEqual({
      kind: "command",
      id: "rename",
      label: "이름 바꾸기…",
    });
  });
});

describe("shortcutHint", () => {
  it("writes the shortcut a command has now, or nothing", () => {
    expect(shortcutHint(table(), "new-memo")).toBe("⌘N");
    expect(shortcutHint(table(), "toggle-preview")).toBe("⇧⌘V");
    expect(shortcutHint(table({ "new-memo": "CmdOrCtrl+Shift+M" }), "new-memo")).toBe("⇧⌘M");
    expect(shortcutHint(table({ "new-memo": null }), "new-memo")).toBeNull();
    expect(shortcutHint(table(), "rename")).toBeNull();
    expect(shortcutHint(table(), "nope")).toBeNull();
  });
});
