import { describe, expect, it } from "vitest";

import { landing, moveItem } from "./workspace-settings";

describe("moveItem", () => {
  const list = ["a", "b", "c", "d"] as const;

  it("puts the item at the index it lands on", () => {
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("leaves the list as it was when the item stays", () => {
    expect(moveItem(list, 1, 1)).toEqual(["a", "b", "c", "d"]);
  });

  it("gives a new list and leaves the one given alone", () => {
    const given = ["a", "b"];
    const moved = moveItem(given, 0, 1);
    expect(moved).toEqual(["b", "a"]);
    expect(given).toEqual(["a", "b"]);
  });
});

describe("landing", () => {
  // Three rows 30 high; the last has no border under it.
  const rows = [
    { top: 0, height: 30 },
    { top: 30, height: 30 },
    { top: 60, height: 29 },
  ];

  it("passes a row once its middle is gone by", () => {
    expect(landing(rows, 0, 3, 29)).toBe(0);
    expect(landing(rows, 0, 3, 31)).toBe(1);
    expect(landing(rows, 0, 3, 60)).toBe(2);
    expect(landing(rows, 2, 3, -16)).toBe(2);
    expect(landing(rows, 2, 3, -30)).toBe(1);
  });

  it("goes first or last past the list's ends", () => {
    expect(landing(rows, 2, 3, -1000)).toBe(0);
    expect(landing(rows, 0, 3, 1000)).toBe(2);
  });

  it("stays before the rows that cannot move", () => {
    expect(landing(rows, 0, 2, 1000)).toBe(1);
  });
});
