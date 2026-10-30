import { describe, expect, it } from "vitest";

import { arrange, landing, ownLanding } from "./tab-bar";

const tabs = [
  { left: 0, width: 100 },
  { left: 100, width: 100 },
  { left: 200, width: 100 },
];

describe("landing", () => {
  it("puts a tab whose middle is left of a tab's middle before that tab", () => {
    expect(landing(tabs, 10)).toBe(0);
    expect(landing(tabs, 60)).toBe(1);
  });

  it("puts a tab past the last tab's middle at the end", () => {
    expect(landing(tabs, 260)).toBe(3);
  });

  it("puts a tab on an empty tab bar first", () => {
    expect(landing([], 10)).toBe(0);
  });
});

describe("ownLanding", () => {
  it("keeps a tab right of the dragged one in place until two thirds of it are covered", () => {
    // The first tab's right edge at 150: half of the second covered.
    expect(ownLanding(tabs, 0, 50)).toBe(0);
    // At 166 short of two thirds (166.67), at 167 past them.
    expect(ownLanding(tabs, 0, 66)).toBe(0);
    expect(ownLanding(tabs, 0, 67)).toBe(1);
    expect(ownLanding(tabs, 0, 166)).toBe(1);
    expect(ownLanding(tabs, 0, 167)).toBe(2);
  });

  it("keeps a tab left of the dragged one in place until two thirds of it are covered", () => {
    // The last tab's left edge at 150: half of the second covered.
    expect(ownLanding(tabs, 2, 150)).toBe(2);
    // At 134 short of two thirds from the second's right edge (133.33), at 133 past them.
    expect(ownLanding(tabs, 2, 134)).toBe(2);
    expect(ownLanding(tabs, 2, 133)).toBe(1);
    expect(ownLanding(tabs, 2, 34)).toBe(1);
    expect(ownLanding(tabs, 2, 33)).toBe(0);
  });

  it("measures two thirds of each tab passed, whatever the dragged tab's width", () => {
    const uneven = [
      { left: 0, width: 90 },
      { left: 90, width: 120 },
      { left: 210, width: 60 },
    ];
    // The first tab, 90 wide, to the right: two thirds of the second end at 170, of the third at
    // 250. Exactly there is not past them.
    expect(ownLanding(uneven, 0, 80)).toBe(0);
    expect(ownLanding(uneven, 0, 81)).toBe(1);
    expect(ownLanding(uneven, 0, 160)).toBe(1);
    expect(ownLanding(uneven, 0, 161)).toBe(2);
    // The last tab, 60 wide, to the left: two thirds of the second from its right end at 130, of
    // the first at 30.
    expect(ownLanding(uneven, 2, 130)).toBe(2);
    expect(ownLanding(uneven, 2, 129)).toBe(1);
    expect(ownLanding(uneven, 2, 30)).toBe(1);
    expect(ownLanding(uneven, 2, 29)).toBe(0);
  });
});

describe("arrange", () => {
  it("moves the others aside into the order a drag in their bar would leave", () => {
    // The first tab dragged 110px right: it goes after the second, which takes its place.
    expect(arrange(tabs, { from: 0, left: 110 })).toEqual({ to: 1, shifts: [110, -100, 0] });
    // Dragged 67px, it covers two thirds of the second, which gives way all the same.
    expect(arrange(tabs, { from: 0, left: 67 })).toEqual({ to: 1, shifts: [67, -100, 0] });
    // The last tab dragged 67px left: the second gives way to the right.
    expect(arrange(tabs, { from: 2, left: 133 })).toEqual({ to: 1, shifts: [0, 100, -67] });
  });

  it("leaves every tab in place for a tab not dragged over two thirds of any", () => {
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
    // Held to the end, its right edge (240) is past two thirds of the narrow tab (226.67).
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
