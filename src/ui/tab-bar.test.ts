import { describe, expect, it } from "vitest";

import { dropIndex } from "./tab-bar";

describe("dropIndex", () => {
  const tabs = [
    { left: 0, width: 100 },
    { left: 100, width: 100 },
    { left: 200, width: 100 },
  ];

  it("puts a drop left of a tab's middle before that tab", () => {
    expect(dropIndex(tabs, 10)).toBe(0);
    expect(dropIndex(tabs, 60)).toBe(1);
  });

  it("puts a drop past the last tab's middle at the end", () => {
    expect(dropIndex(tabs, 260)).toBe(3);
  });

  it("puts a drop on an empty tab bar first", () => {
    expect(dropIndex([], 10)).toBe(0);
  });
});
