import { describe, expect, it } from "vitest";

import type { WorkspaceListItem } from "../backend/types";
import { railItems, railShortcut } from "./rail";

const item = (name: string, path: string, windows = 0, missing = false): WorkspaceListItem => ({
  name,
  path,
  open: windows > 0,
  windows,
  missing,
});

describe("railItems", () => {
  it("items are sorted by name, NFD names included, missing ones left out", () => {
    const items = railItems(
      [
        item("업무", "/w/업무"),
        item("개인".normalize("NFD"), "/w/개인"),
        item("가계부", "/w/가계부"),
        item("옛", "/gone/옛", 0, true),
      ],
      "/w/업무",
    );
    expect(items.map((each) => each.name)).toEqual(["가계부", "개인", "업무"]);
    expect(items.map((each) => each.path)).toEqual(["/w/가계부", "/w/개인", "/w/업무"]);
  });

  it("the label is the first two characters", () => {
    const label = (name: string) => railItems([item(name, "/w/x")], "/w/y")[0].label;
    expect(label("업무 메모")).toBe("업무");
    expect(label("a")).toBe("a");
    expect(label("👩‍💻노트")).toBe("👩‍💻노");
  });

  it("the current workspace is marked and other windows get a dot", () => {
    const mark = (windows: number, path: string) => {
      const [each] = railItems([item("가", "/w/가", windows)], path);
      return { current: each.current, dot: each.dot };
    };
    expect(mark(1, "/w/가")).toEqual({ current: true, dot: false });
    expect(mark(2, "/w/가")).toEqual({ current: true, dot: true });
    expect(mark(1, "/w/나")).toEqual({ current: false, dot: true });
    expect(mark(0, "/w/나")).toEqual({ current: false, dot: false });
  });
});

describe("railShortcut", () => {
  const key = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code,
    ...mods,
  });

  it("⌃1–⌃9 pick the rail's items, nothing else does", () => {
    expect(railShortcut(key("Digit3"))).toBe(2);
    expect(railShortcut(key("Digit1"))).toBe(0);
    expect(railShortcut(key("Digit9"))).toBe(8);
    expect(railShortcut(key("Digit3", { metaKey: true }))).toBeNull();
    expect(railShortcut(key("Digit3", { altKey: true }))).toBeNull();
    expect(railShortcut(key("Digit3", { shiftKey: true }))).toBeNull();
    expect(railShortcut(key("Digit3", { ctrlKey: false }))).toBeNull();
    expect(railShortcut(key("Digit0"))).toBeNull();
    expect(railShortcut(key("KeyA"))).toBeNull();
  });
});
