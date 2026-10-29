import { describe, expect, it } from "vitest";

import table from "../../src-tauri/tests/fixtures/shortcut-table.json";
import {
  FAKE_FIXED_SHORTCUTS,
  FAKE_SHORTCUT_COMMANDS,
  gaveWay,
  refusedShortcut,
  resolveShortcuts,
  sanitizeShortcuts,
} from "./fake-shortcuts";

// The fixture is the table Rust has (`shortcut_table` with nothing saved); a Rust test fails when
// it is stale. The fake's copy has to say the same, or the e2e tests run against another table.
describe("the fake backend's shortcut table", () => {
  it("has Rust's commands, in order, with their names, menus and defaults", () => {
    expect(FAKE_SHORTCUT_COMMANDS).toEqual(
      table.commands.map(({ id, label, menu, default: keys, yields }) => ({
        id,
        label,
        menu,
        default: keys,
        ...(yields ? { yields } : {}),
      })),
    );
  });

  it("has Rust's fixed shortcuts", () => {
    expect(FAKE_FIXED_SHORTCUTS).toEqual(table.fixed);
  });
});

describe("sanitizeShortcuts", () => {
  it("lets a saved ⌘B stand and leaves the sidebar toggle with none", () => {
    const saved = { rename: "CmdOrCtrl+B" };
    expect(sanitizeShortcuts(saved)).toEqual({ rename: "CmdOrCtrl+B" });
    const shortcuts = resolveShortcuts(saved);
    const at = (id: string) => FAKE_SHORTCUT_COMMANDS.findIndex((c) => c.id === id);
    expect(shortcuts[at("toggle-sidebar")]).toBeNull();
    expect(shortcuts[at("rename")]).toBe("CmdOrCtrl+B");
    expect(refusedShortcut(saved)).toBeNull();
  });

  it("says the sidebar toggle gave way only when it has no entry of its own", () => {
    const toggle = FAKE_SHORTCUT_COMMANDS.find((c) => c.id === "toggle-sidebar")!;
    expect(gaveWay(toggle, {})).toBe(false);
    expect(gaveWay(toggle, { rename: "CmdOrCtrl+B" })).toBe(true);
    expect(gaveWay(toggle, { rename: "Cmd+B" })).toBe(true);
    expect(gaveWay(toggle, { rename: "CmdOrCtrl+Shift+B" })).toBe(false);
    expect(gaveWay(toggle, { "toggle-sidebar": null, rename: "CmdOrCtrl+B" })).toBe(false);
    expect(gaveWay(toggle, { "toggle-sidebar": "CmdOrCtrl+K", rename: "CmdOrCtrl+B" })).toBe(false);
    const rename = FAKE_SHORTCUT_COMMANDS.find((c) => c.id === "rename")!;
    expect(gaveWay(rename, { save: "CmdOrCtrl+B" })).toBe(false);
  });
});
