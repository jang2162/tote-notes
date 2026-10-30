import { describe, expect, it } from "vitest";

import { arrange, landing } from "./tab-bar";

const tabs = [
  { left: 0, width: 100 },
  { left: 100, width: 100 },
  { left: 200, width: 100 },
];

describe("landing", () => {
  it("puts a tab whose middle is left of a tab's middle before that tab", () => {
    expect(landing(tabs, 10, null)).toBe(0);
    expect(landing(tabs, 60, null)).toBe(1);
  });

  it("puts a tab past the last tab's middle at the end", () => {
    expect(landing(tabs, 260, null)).toBe(3);
  });

  it("puts a tab on an empty tab bar first", () => {
    expect(landing([], 10, null)).toBe(0);
  });

  it("leaves the dragged tab itself out of the count", () => {
    // The first tab dragged 60px right: its middle (110) is short of the second's (150).
    expect(landing(tabs, 110, 0)).toBe(0);
    // 110px: past the second's middle, short of the third's.
    expect(landing(tabs, 160, 0)).toBe(1);
    expect(landing(tabs, 260, 0)).toBe(2);
  });
});

describe("arrange", () => {
  it("moves the others aside into the order a drag in their bar would leave", () => {
    // The first tab dragged 110px right: it goes after the second, which takes its place.
    expect(arrange(tabs, { from: 0, left: 110 })).toEqual({ to: 1, shifts: [110, -100, 0] });
  });

  it("leaves every tab in place for a tab not dragged past any middle", () => {
    expect(arrange(tabs, { from: 1, left: 120 })).toEqual({ to: 1, shifts: [0, 20, 0] });
  });

  it("keeps a tab dragged past the bar's end at the end, and lands it last", () => {
    expect(arrange(tabs, { from: 0, left: 900 })).toEqual({ to: 2, shifts: [200, -100, -100] });
    expect(arrange(tabs, { from: 2, left: -400 })).toEqual({ to: 0, shifts: [100, 100, -200] });
  });

  it("lands a wide tab dragged past a narrow last one last", () => {
    const uneven = [
      { left: 0, width: 200 },
      { left: 200, width: 40 },
    ];
    // Held to the end, its middle (140) is short of the narrow tab's (220): the pointer is not.
    expect(arrange(uneven, { from: 0, left: 300 })).toEqual({ to: 1, shifts: [40, -200] });
  });

  it("opens a gap the dragged tab's width where it would go in another bar", () => {
    expect(arrange(tabs, { from: null, middle: 160, width: 80 })).toEqual({
      to: 2,
      shifts: [0, 0, 80],
    });
    expect(arrange(tabs, { from: null, middle: 10, width: 80 })).toEqual({
      to: 0,
      shifts: [80, 80, 80],
    });
    expect(arrange(tabs, { from: null, middle: 900, width: 80 })).toEqual({
      to: 3,
      shifts: [0, 0, 0],
    });
  });

  it("measures from the first tab, wherever the bar starts", () => {
    const later = tabs.map((tab) => ({ ...tab, left: tab.left + 30 }));
    expect(arrange(later, { from: 2, left: -400 })).toEqual({ to: 0, shifts: [100, 100, -200] });
  });

  it("has nothing to move in an empty bar", () => {
    expect(arrange([], { from: null, middle: 10, width: 80 })).toEqual({ to: 0, shifts: [] });
  });
});
