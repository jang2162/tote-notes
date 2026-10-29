import { selectLine } from "@codemirror/commands";
import { describe, expect, it } from "vitest";

import fixture from "../../src-tauri/tests/fixtures/shortcut-table.json";
import { FAKE_FIXED_SHORTCUTS, FAKE_SHORTCUT_COMMANDS } from "../backend/fake-shortcuts";
import type { ShortcutTable } from "../backend/types";
import {
  acceleratorFromEvent,
  bindingsOf,
  conflict,
  editorBindings,
  fixedShortcutHint,
  SETTINGS_FIXED_NAME,
  formatAccelerator,
  menuKeymap,
  recordableAccelerator,
  sameAccelerator,
  shortcutHint,
  UNNAMED_EDITOR_COMMAND,
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

  it("records Insert, Help and the keypad's Enter but not IntlBackslash", () => {
    const meta = { meta: true };
    expect(acceleratorFromEvent(key("NumpadEnter", meta, "Enter"))).toBe("CmdOrCtrl+NumpadEnter");
    expect(acceleratorFromEvent(key("Insert", { alt: true }))).toBe("Alt+Insert");
    expect(acceleratorFromEvent(key("Help", meta))).toBe("CmdOrCtrl+Help");
    expect(acceleratorFromEvent(key("IntlBackslash", meta, "<"))).toBeNull();
    expect(recordableAccelerator("CmdOrCtrl+IntlBackslash")).toBe(false);
    expect(formatAccelerator("CmdOrCtrl+NumpadEnter")).toBe("⌘키패드 ↩");
    expect(formatAccelerator("Alt+Insert")).toBe("⌥Insert");
    expect(formatAccelerator("CmdOrCtrl+Help")).toBe("⌘Help");
  });

  // A macOS menu does not tell a keypad key from the main-row key of the same character: an item
  // with either fires on both (settings smoke B-8).
  it("records a keypad key a menu cannot tell from a main-row key as that key", () => {
    const twins: [string, string][] = [
      ...Array.from({ length: 10 }, (_, n): [string, string] => [`Numpad${n}`, `${n}`]),
      ["NumpadSubtract", "-"],
      ["NumpadDecimal", "."],
      ["NumpadDivide", "/"],
      ["NumpadEqual", "="],
    ];
    for (const [code, twin] of twins) {
      expect(acceleratorFromEvent(key(code, { meta: true })), code).toBe(`CmdOrCtrl+${twin}`);
      expect(acceleratorFromEvent(key(code, { alt: true, shift: true })), code).toBe(
        `Alt+Shift+${twin}`,
      );
    }
    expect(formatAccelerator(acceleratorFromEvent(key("Numpad1", { meta: true })) as string)).toBe(
      "⌘1",
    );
    // So it meets the main-row key's command as the same key.
    expect(
      sameAccelerator(acceleratorFromEvent(key("Numpad1", { meta: true })) as string, "Cmd+1"),
    ).toBe(true);
    expect(acceleratorFromEvent(key("Numpad1", {}, "1"))).toBeNull();
  });

  it("does not record the keypad's ＋ and ×, whose items a main-row key fires too", () => {
    // Their item fires on ⇧⌘= and ⇧⌘8, and an item on those is not fired by the keypad.
    expect(acceleratorFromEvent(key("NumpadAdd", { meta: true }, "+"))).toBeNull();
    expect(acceleratorFromEvent(key("NumpadMultiply", { meta: true }, "*"))).toBeNull();
    for (const code of ["Numpad1", "NumpadAdd", "NumpadMultiply", "NumpadEqual"])
      expect(recordableAccelerator(`CmdOrCtrl+${code}`), code).toBe(false);
    expect(recordableAccelerator("CmdOrCtrl+NumpadEnter")).toBe(true);
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
    expect(named("Alt+CmdOrCtrl+F")).toEqual(["openSearchWithReplace"]);
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
  it("names a key after the export of its function, and a function no module exports 편집기 명령", () => {
    const local = () => true;
    expect(
      bindingsOf([
        { key: "Mod-k", run: selectLine },
        { key: "Mod-j", run: local, shift: local },
      ]),
    ).toEqual([
      { accelerator: "CmdOrCtrl+K", name: "selectLine" },
      { accelerator: "CmdOrCtrl+J", name: "편집기 명령" },
      { accelerator: "Shift+CmdOrCtrl+J", name: "편집기 명령" },
    ]);
  });

  it("editor bindings are named from the exports, not Function.name", () => {
    // What a minifier does to a function's name (`selectLine` read `Qp` in a build).
    const original = Object.getOwnPropertyDescriptor(selectLine, "name");
    Object.defineProperty(selectLine, "name", { value: "Qp", configurable: true });
    try {
      expect(bindingsOf([{ key: "Mod-l", run: selectLine }])).toEqual([
        { accelerator: "CmdOrCtrl+L", name: "selectLine" },
      ]);
    } finally {
      Object.defineProperty(selectLine, "name", original!);
    }
  });

  it("names every key of the editor", () => {
    expect(editorBindings().filter((b) => b.name === UNNAMED_EDITOR_COMMAND)).toEqual([]);
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
    // ⌘F is in the keymap twice, the find bar's ahead of CodeMirror's: one warning, the first.
    expect(editorBindings().filter((b) => sameAccelerator(b.accelerator, "CmdOrCtrl+F"))).toEqual([
      { accelerator: "CmdOrCtrl+F", name: "openSearchBar" },
      { accelerator: "CmdOrCtrl+F", name: "openSearchPanel" },
    ]);
    expect(conflict(table(), "rename", "CmdOrCtrl+F")).toEqual({
      kind: "editor",
      name: "openSearchBar",
    });
  });

  it("holds the keypad's ↩ against the editor's ↩, which the editor hears it as", () => {
    // CodeMirror goes by `key`, `Enter` for the keypad's ↩ too: its ⌘↩ runs on ⌘keypad ↩.
    expect(conflict(table(), "rename", "CmdOrCtrl+NumpadEnter")).toEqual({
      kind: "editor",
      name: "insertBlankLine",
    });
    expect(conflict(table(), "rename", "Ctrl+NumpadEnter")).toBeNull();
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

describe("fixedShortcutHint", () => {
  it("writes the fixed shortcut of the name Rust gives it, or nothing", () => {
    // Rust's own table: the sidebar's settings button looks 설정… up by this name.
    expect(fixedShortcutHint(fixture as ShortcutTable, SETTINGS_FIXED_NAME)).toBe("⌘,");
    expect(fixedShortcutHint(fixture as ShortcutTable, "설정")).toBeNull();
  });
});

describe("menuKeymap", () => {
  it("binds the editor keys the app shortcuts have, to the app command, in the search bar too", () => {
    const ran: string[] = [];
    const bindings = menuKeymap(
      table({ rename: "CmdOrCtrl+L", "new-memo": null, save: "Ctrl+Alt+CmdOrCtrl+J" }),
      (id) => ran.push(id),
    );
    // The defaults that are editor keys, and ⌘L; ⌘S and ⌃⌥⌘J are no editor's.
    expect(bindings.map((b) => b.key)).toEqual([
      "Mod-l",
      "Shift-Mod-\\",
      "Mod-Alt-ArrowUp",
      "Mod-Alt-ArrowDown",
    ]);
    for (const binding of bindings) {
      expect(binding.scope).toBe("editor search-panel");
      expect(binding.preventDefault).toBe(true);
    }
    expect(bindings[0].run!(null as never)).toBe(true);
    expect(ran).toEqual(["rename"]);
  });

  it("tells the keypad's ↩ from the main row's, as the menu does and the editor's key names do not", () => {
    const ran: string[] = [];
    const prevented: string[] = [];
    const press = (code: string) => ({
      ...key(code, { meta: true }, "Enter"),
      preventDefault: () => prevented.push(code),
    });
    const bindings = menuKeymap(
      table({ rename: "CmdOrCtrl+NumpadEnter", save: "CmdOrCtrl+Enter" }),
      (id) => ran.push(id),
    );
    const enter = bindings.filter((b) => b.any);
    expect(enter).toHaveLength(2);
    for (const binding of enter) expect(binding.scope).toBe("editor search-panel");
    // How many of the bindings took the key.
    const any = (code: string) =>
      enter.filter((b) => b.any!(null as never, press(code) as unknown as KeyboardEvent)).length;
    expect(any("NumpadEnter")).toBe(1);
    expect(ran).toEqual(["rename"]);
    expect(any("Enter")).toBe(1);
    expect(ran).toEqual(["rename", "save"]);
    expect(prevented).toEqual(["NumpadEnter", "Enter"]);
    // Another key, or the same with other modifiers, is the editor's.
    expect(
      enter.filter((b) =>
        b.any!(null as never, { ...press("Enter"), shiftKey: true } as unknown as KeyboardEvent),
      ),
    ).toHaveLength(0);
    expect(any("KeyL")).toBe(0);
    expect(ran).toEqual(["rename", "save"]);
    // No editor key is ⌃↩: the menu has it as it is.
    expect(
      menuKeymap(table({ rename: "Ctrl+NumpadEnter" }), () => {}).filter((b) => b.any),
    ).toEqual([]);
  });

  it("binds a key two editor bindings share once", () => {
    const bindings = menuKeymap(table({ rename: "CmdOrCtrl+F" }), () => {});
    expect(bindings.filter((b) => b.key === "Mod-f")).toHaveLength(1);
  });
});
