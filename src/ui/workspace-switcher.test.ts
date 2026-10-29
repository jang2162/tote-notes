import { describe, expect, it } from "vitest";

import type { WorkspaceListItem } from "../backend/types";
import { shortcutHint, switcherItems, switcherShortcut } from "./workspace-switcher";

const item = (
  name: string,
  path: string,
  windows = 0,
  missing = false,
  place: { order?: number | null; hidden?: boolean } = {},
): WorkspaceListItem => ({
  name,
  path,
  open: windows > 0,
  windows,
  missing,
  order: missing ? null : 0,
  hidden: false,
  orderable: !missing,
  ...place,
});

describe("switcherItems", () => {
  it("items follow the set order, not the name", () => {
    const items = switcherItems(
      [
        item("가계부", "/w/가계부", 0, false, { order: 2 }),
        item("업무", "/w/업무", 0, false, { order: 0 }),
        item("개인".normalize("NFD"), "/w/개인", 0, false, { order: 1 }),
      ],
      "/w/업무",
    );
    expect(items.map((each) => each.name)).toEqual(["업무", "개인", "가계부"]);
    expect(items.map((each) => each.path)).toEqual(["/w/업무", "/w/개인", "/w/가계부"]);
  });

  it("hidden and missing items are left out", () => {
    const items = switcherItems(
      [
        item("업무", "/w/업무", 1, false, { order: 0, hidden: true }),
        item("개인", "/w/개인", 0, false, { order: 1 }),
        item("가계부", "/w/가계부", 0, false, { order: 2 }),
        item("옛", "/gone/옛", 0, true),
      ],
      "/w/업무",
    );
    expect(items.map((each) => each.name)).toEqual(["개인", "가계부"]);
    // The numbers move up: ⌃1 picks what the first row shows.
    expect(items.map((_, index) => shortcutHint(index))).toEqual(["⌃1", "⌃2"]);
    const picked = switcherShortcut({
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      code: "Digit1",
    });
    expect(items[picked!].name).toBe("개인");
  });

  it("an item is the name, the path and the two marks, nothing more", () => {
    const [each] = switcherItems([item("업무 메모", "/w/x", 1)], "/w/y");
    expect(each).toEqual({ name: "업무 메모", path: "/w/x", current: false, dot: true });
  });

  it("the current workspace is marked and other windows get a dot", () => {
    const mark = (windows: number, path: string) => {
      const [each] = switcherItems([item("가", "/w/가", windows)], path);
      return { current: each.current, dot: each.dot };
    };
    expect(mark(1, "/w/가")).toEqual({ current: true, dot: false });
    expect(mark(2, "/w/가")).toEqual({ current: true, dot: true });
    expect(mark(1, "/w/나")).toEqual({ current: false, dot: true });
    expect(mark(0, "/w/나")).toEqual({ current: false, dot: false });
  });
});

describe("shortcutHint", () => {
  it("shortcutHint names ⌃1 to ⌃9 and nothing past them", () => {
    expect(shortcutHint(0)).toBe("⌃1");
    expect(shortcutHint(4)).toBe("⌃5");
    expect(shortcutHint(8)).toBe("⌃9");
    expect(shortcutHint(9)).toBeNull();
    expect(shortcutHint(-1)).toBeNull();
  });
});

describe("switcherShortcut", () => {
  const key = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code,
    ...mods,
  });

  it("⌃1–⌃9 pick the switcher's items, nothing else does", () => {
    expect(switcherShortcut(key("Digit3"))).toBe(2);
    expect(switcherShortcut(key("Digit1"))).toBe(0);
    expect(switcherShortcut(key("Digit9"))).toBe(8);
    expect(switcherShortcut(key("Digit3", { metaKey: true }))).toBeNull();
    expect(switcherShortcut(key("Digit3", { altKey: true }))).toBeNull();
    expect(switcherShortcut(key("Digit3", { shiftKey: true }))).toBeNull();
    expect(switcherShortcut(key("Digit3", { ctrlKey: false }))).toBeNull();
    expect(switcherShortcut(key("Digit0"))).toBeNull();
    expect(switcherShortcut(key("KeyA"))).toBeNull();
  });
});
