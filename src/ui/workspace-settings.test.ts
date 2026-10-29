import { describe, expect, it } from "vitest";

import { moveItem } from "./workspace-settings";

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
