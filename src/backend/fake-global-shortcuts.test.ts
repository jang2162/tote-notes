import { describe, expect, it } from "vitest";

import table from "../../src-tauri/tests/fixtures/global-shortcut-table.json";
import {
  FAKE_GLOBAL_COMMANDS,
  GLOBAL_REGISTER_FAILED,
  globalShortcutTable,
  refusedGlobalShortcut,
  sanitizeGlobalShortcuts,
} from "./fake-global-shortcuts";

// The fixture is the table Rust has with nothing saved; a Rust test fails when it is stale.
describe("the fake backend's global shortcut table", () => {
  it("has Rust's commands with their names and defaults", () => {
    expect(FAKE_GLOBAL_COMMANDS).toEqual(
      table.commands.map(({ id, label, default: keys }) => ({ id, label, default: keys })),
    );
    expect(globalShortcutTable({}, {}, [])).toEqual(table);
  });

  it("drops an entry an app command, a fixed shortcut or a media key has", () => {
    for (const keys of ["CmdOrCtrl+N", "CmdOrCtrl+Q", "N", "Ctrl+MediaPlayPause"]) {
      expect(sanitizeGlobalShortcuts({ "quick-note": keys }, {}), keys).toEqual({});
      expect(refusedGlobalShortcut({ "quick-note": keys }, {}), keys).toBe("quick-note");
    }
    expect(sanitizeGlobalShortcuts({ "quick-note": null, nope: "Ctrl+Alt+K" }, {})).toEqual({
      "quick-note": null,
    });
    expect(refusedGlobalShortcut({ "quick-note": "Ctrl+Alt+K" }, { rename: "Ctrl+Alt+K" })).toBe(
      "quick-note",
    );
  });

  it("gives the default way to an app command that has it", () => {
    const [row] = globalShortcutTable({}, { rename: "Ctrl+Alt+N" }, []).commands;
    expect(row).toMatchObject({ current: null, yielded: true });
  });

  it("says a key macOS refused only while the command has it", () => {
    const refused = ["Ctrl+Alt+N"];
    expect(globalShortcutTable({}, {}, refused).commands[0].problem).toBe(GLOBAL_REGISTER_FAILED);
    expect(
      globalShortcutTable({ "quick-note": null }, {}, refused).commands[0].problem,
    ).toBeUndefined();
  });
});
