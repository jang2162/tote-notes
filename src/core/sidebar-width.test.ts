import { describe, expect, it } from "vitest";

import {
  draggedSidebar,
  parseSidebarWidth,
  shownSidebarWidth,
  SIDEBAR_WIDTH,
  sidebarMaxWidth,
} from "./sidebar-width";

describe("the sidebar's width", () => {
  it("is 240 by default, between 200 and 480, and collapses below 150", () => {
    expect(SIDEBAR_WIDTH).toEqual({ default: 240, min: 200, max: 480, collapseBelow: 150 });
  });

  it("reads only numbers from 200 to 480, as the native side does (`layout_sidebar_width`)", () => {
    for (const width of [200, 240, 300.5, 480]) expect(parseSidebarWidth(width)).toBe(width);
    // 180 to 199 were saved by 0.2.0, which let the sidebar down to 180.
    for (const width of [
      199.9,
      190,
      180,
      480.1,
      0,
      -240,
      "300",
      null,
      undefined,
      true,
      Number.NaN,
      [300],
    ])
      expect(parseSidebarWidth(width)).toBeNull();
    expect(parseSidebarWidth(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("is at most half the window, never less than 200", () => {
    expect(sidebarMaxWidth(1280)).toBe(480);
    expect(sidebarMaxWidth(960)).toBe(480);
    expect(sidebarMaxWidth(800)).toBe(400);
    expect(sidebarMaxWidth(801)).toBe(400);
    expect(sidebarMaxWidth(401)).toBe(200);
    expect(sidebarMaxWidth(360)).toBe(200);
  });

  it("shows the stored width as far as the window allows, keeping it otherwise", () => {
    expect(shownSidebarWidth(300, 1280)).toBe(300);
    expect(shownSidebarWidth(480, 800)).toBe(400);
    expect(shownSidebarWidth(240, 440)).toBe(220);
    expect(shownSidebarWidth(240, 300)).toBe(200);
    expect(shownSidebarWidth(240, 480)).toBe(240);
  });

  it("follows the pointer while dragged, held at 200 and collapsed below 150 (150 itself stays open)", () => {
    expect(draggedSidebar(300, 1280)).toEqual({ collapsed: false, width: 300 });
    expect(draggedSidebar(300.4, 1280)).toEqual({ collapsed: false, width: 300 });
    expect(draggedSidebar(200, 1280)).toEqual({ collapsed: false, width: 200 });
    expect(draggedSidebar(199, 1280)).toEqual({ collapsed: false, width: 200 });
    expect(draggedSidebar(150, 1280)).toEqual({ collapsed: false, width: 200 });
    expect(draggedSidebar(149.9, 1280)).toEqual({ collapsed: true });
    expect(draggedSidebar(149, 1280)).toEqual({ collapsed: true });
    expect(draggedSidebar(-50, 1280)).toEqual({ collapsed: true });
    expect(draggedSidebar(700, 1280)).toEqual({ collapsed: false, width: 480 });
    expect(draggedSidebar(450, 800)).toEqual({ collapsed: false, width: 400 });
    expect(draggedSidebar(170, 360)).toEqual({ collapsed: false, width: 200 });
  });
});
