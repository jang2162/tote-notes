import { describe, expect, it } from "vitest";

import globalTable from "../../src-tauri/tests/fixtures/global-shortcut-table.json";
import table from "../../src-tauri/tests/fixtures/shortcut-table.json";
import type { ShortcutTable } from "../backend/types";
import { conflict } from "./keys";

describe("the global 빠른 메모 default ⌃⌥N", () => {
  it("is no editor key, and no app command or fixed shortcut has it", () => {
    const [quickNote] = globalTable.commands;
    expect(quickNote.default).toBe("Ctrl+Alt+N");
    expect(conflict(table as ShortcutTable, "global:quick-note", quickNote.default)).toBeNull();
  });
});
