import { describe, expect, it } from "vitest";

import { ListSelection, listKey } from "./list-selection";

const listOf = (...ids: string[]) => {
  const list = new ListSelection();
  list.setOrder(ids);
  return list;
};

const picked = (list: ListSelection) => list.targets();

describe("ListSelection moves", () => {
  it("starts at the first row whichever way it moves first", () => {
    const down = listOf("a", "b", "c");
    down.step(1, false);
    expect(down.cursor).toBe("a");
    const up = listOf("a", "b", "c");
    up.step(-1, false);
    expect(up.cursor).toBe("a");
  });

  it("moves one row at a time, the row moved to alone picked, and stops at the ends", () => {
    const list = listOf("a", "b", "c");
    list.step(1, false);
    list.step(1, false);
    expect(list.cursor).toBe("b");
    expect(picked(list)).toEqual(["b"]);
    list.step(5, false);
    expect(list.cursor).toBe("c");
    list.step(-9, false);
    expect(list.cursor).toBe("a");
  });

  it("goes to the first and the last row", () => {
    const list = listOf("a", "b", "c");
    list.to("last", false);
    expect(list.cursor).toBe("c");
    list.to("first", false);
    expect(list.cursor).toBe("a");
  });

  it("widens from the row it started at with ⇧, either way", () => {
    const list = listOf("a", "b", "c", "d");
    list.step(1, false);
    list.step(1, false);
    list.step(1, true);
    list.step(1, true);
    expect(picked(list)).toEqual(["b", "c", "d"]);
    list.step(-1, true);
    list.step(-1, true);
    list.step(-1, true);
    expect(picked(list)).toEqual(["a", "b"]);
    list.to("last", true);
    expect(picked(list)).toEqual(["b", "c", "d"]);
  });

  it("does nothing on an empty list", () => {
    const list = listOf();
    list.step(1, false);
    expect(list.cursor).toBeNull();
    expect(picked(list)).toEqual([]);
  });
});

describe("ListSelection presses", () => {
  it("adds and takes out with ⌘, the row pressed becoming the current one", () => {
    const list = listOf("a", "b", "c");
    list.press("a", {});
    list.press("c", { toggle: true });
    expect(picked(list)).toEqual(["a", "c"]);
    expect(list.cursor).toBe("c");
    list.press("a", { toggle: true });
    expect(picked(list)).toEqual(["c"]);
  });

  it("picks the run from the row it started at with ⇧, keeping that row", () => {
    const list = listOf("a", "b", "c", "d");
    list.press("b", {});
    list.press("d", { range: true });
    expect(picked(list)).toEqual(["b", "c", "d"]);
    list.press("a", { range: true });
    expect(picked(list)).toEqual(["a", "b"]);
  });

  it("starts a ⇧ run from where ⌘ last added a row", () => {
    const list = listOf("a", "b", "c", "d");
    list.press("a", {});
    list.press("c", { toggle: true });
    list.press("d", { range: true });
    expect(picked(list)).toEqual(["c", "d"]);
  });

  it("a row ⌘ takes out is not where a ⇧ run starts", () => {
    const list = listOf("a", "b", "c", "d");
    list.press("a", {});
    list.press("c", { toggle: true });
    list.press("a", { toggle: true });
    expect(list.cursor).toBe("a");
    list.press("b", { range: true });
    expect(picked(list)).toEqual(["b", "c"]);
  });

  it("a plain press picks that row alone", () => {
    const list = listOf("a", "b", "c");
    list.selectAll();
    list.press("b", {});
    expect(picked(list)).toEqual(["b"]);
  });

  it("picks every row in order with ⌘A", () => {
    const list = listOf("a", "b", "c");
    list.press("b", {});
    list.selectAll();
    expect(picked(list)).toEqual(["a", "b", "c"]);
    expect(list.cursor).toBe("b");
  });
});

describe("ListSelection menus", () => {
  it("a row inside what is picked has the menu for all of it", () => {
    const list = listOf("a", "b", "c");
    list.press("a", {});
    list.press("c", { toggle: true });
    expect(list.menuFor("a")).toEqual(["a", "c"]);
  });

  it("a row outside what is picked is picked alone for its menu", () => {
    const list = listOf("a", "b", "c");
    list.press("a", {});
    list.press("c", { toggle: true });
    expect(list.menuFor("b")).toEqual(["b"]);
    expect(picked(list)).toEqual(["b"]);
  });

  it("the keys' menu is for the current row's", () => {
    const list = listOf("a", "b", "c");
    expect(list.menuFor(null)).toEqual([]);
    list.selectAll();
    list.step(1, false);
    list.press("c", { toggle: true });
    expect(list.menuFor(list.cursor)).toEqual(["a", "c"]);
  });

  it("acts on the current row when nothing is picked", () => {
    const list = listOf("a", "b");
    list.press("b", {});
    list.press("b", { toggle: true });
    expect(list.targets()).toEqual(["b"]);
  });
});

describe("ListSelection follows the rows", () => {
  it("drops the rows no longer shown", () => {
    const list = listOf("a", "b", "c");
    list.selectAll();
    list.setOrder(["c", "a"]);
    expect(picked(list)).toEqual(["c", "a"]);
  });

  it("puts the current row on the one in its place once it goes, and picks it when nothing is left", () => {
    const list = listOf("a", "b", "c");
    list.press("b", {});
    list.setOrder(["a", "c"]);
    expect(list.cursor).toBe("c");
    expect(picked(list)).toEqual(["c"]);
    list.setOrder(["a"]);
    expect(list.cursor).toBe("a");
    list.setOrder([]);
    expect(list.cursor).toBeNull();
    expect(picked(list)).toEqual([]);
  });

  it("keeps what is still picked when the current row goes", () => {
    const list = listOf("a", "b", "c");
    list.press("a", {});
    list.press("b", { toggle: true });
    list.setOrder(["a", "c"]);
    expect(list.cursor).toBe("c");
    expect(picked(list)).toEqual(["a"]);
  });

  it("keeps the current row through a new order", () => {
    const list = listOf("a", "b", "c");
    list.press("b", {});
    list.setOrder(["c", "b", "a"]);
    expect(list.cursor).toBe("b");
    expect(picked(list)).toEqual(["b"]);
  });

  it("with nothing current, a new list has nothing current either", () => {
    const list = listOf("a", "b");
    list.setOrder(["b"]);
    expect(list.cursor).toBeNull();
  });
});

const key = (key: string, more: Partial<KeyboardEvent> = {}) =>
  ({
    key,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 0,
    ...more,
  }) as KeyboardEvent;

describe("listKey", () => {
  it("reads the moves, with ⇧ widening", () => {
    expect(listKey(key("ArrowDown"))).toEqual({ kind: "move", to: "down", extend: false });
    expect(listKey(key("ArrowUp", { shiftKey: true }))).toEqual({
      kind: "move",
      to: "up",
      extend: true,
    });
    expect(listKey(key("Home"))).toEqual({ kind: "move", to: "first", extend: false });
    expect(listKey(key("End", { shiftKey: true }))).toEqual({
      kind: "move",
      to: "last",
      extend: true,
    });
    expect(listKey(key("PageDown"))).toEqual({ kind: "move", to: "page-down", extend: false });
    expect(listKey(key("PageUp"))).toEqual({ kind: "move", to: "page-up", extend: false });
  });

  it("reads Enter, ⌘Enter, ⌘⌫, ⌘A and the menu keys", () => {
    expect(listKey(key("Enter"))).toEqual({ kind: "open", toEditor: false });
    expect(listKey(key("Enter", { metaKey: true }))).toEqual({ kind: "open", toEditor: true });
    expect(listKey(key("Backspace", { metaKey: true }))).toEqual({ kind: "delete" });
    expect(listKey(key("a", { metaKey: true }))).toEqual({ kind: "all" });
    expect(listKey(key("A", { metaKey: true }))).toEqual({ kind: "all" });
    expect(listKey(key("F10", { shiftKey: true }))).toEqual({ kind: "menu" });
    expect(listKey(key("ContextMenu"))).toEqual({ kind: "menu" });
  });

  it("leaves other keys and other modifiers alone", () => {
    expect(listKey(key("Backspace"))).toBeNull();
    expect(listKey(key("F10"))).toBeNull();
    expect(listKey(key("a"))).toBeNull();
    expect(listKey(key("ArrowDown", { metaKey: true }))).toBeNull();
    expect(listKey(key("ArrowDown", { altKey: true }))).toBeNull();
    expect(listKey(key("Backspace", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(listKey(key("Enter", { keyCode: 229 }))).toBeNull();
  });
});
