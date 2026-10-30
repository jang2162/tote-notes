import { describe, expect, it } from "vitest";

import {
  draggedSidebar,
  parseSidebarWidth,
  shownSidebarWidth,
  SIDEBAR_WIDTH,
  sidebarMaxWidth,
} from "./sidebar-width";

describe("the sidebar's width", () => {
  it("is 240 by default, between 180 and 480, and collapses below 120", () => {
    expect(SIDEBAR_WIDTH).toEqual({ default: 240, min: 180, max: 480, collapseBelow: 120 });
  });

  it("reads only numbers from 180 to 480, as the native side does (`layout_sidebar_width`)", () => {
    for (const width of [180, 240, 300.5, 480]) expect(parseSidebarWidth(width)).toBe(width);
    for (const width of [179.9, 480.1, 0, -240, "300", null, undefined, true, Number.NaN, [300]])
      expect(parseSidebarWidth(width)).toBeNull();
    expect(parseSidebarWidth(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("is at most half the window, never less than 180", () => {
    expect(sidebarMaxWidth(1280)).toBe(480);
    expect(sidebarMaxWidth(960)).toBe(480);
    expect(sidebarMaxWidth(800)).toBe(400);
    expect(sidebarMaxWidth(801)).toBe(400);
    expect(sidebarMaxWidth(360)).toBe(180);
    expect(sidebarMaxWidth(200)).toBe(180);
  });

  it("shows the stored width as far as the window allows, keeping it otherwise", () => {
    expect(shownSidebarWidth(300, 1280)).toBe(300);
    expect(shownSidebarWidth(480, 800)).toBe(400);
    expect(shownSidebarWidth(240, 400)).toBe(200);
    expect(shownSidebarWidth(240, 300)).toBe(180);
    expect(shownSidebarWidth(240, 480)).toBe(240);
  });

  it("follows the pointer while dragged, held at 180 down to 120 and collapsed below", () => {
    expect(draggedSidebar(300, 1280)).toEqual({ collapsed: false, width: 300 });
    expect(draggedSidebar(300.4, 1280)).toEqual({ collapsed: false, width: 300 });
    expect(draggedSidebar(150, 1280)).toEqual({ collapsed: false, width: 180 });
    expect(draggedSidebar(120, 1280)).toEqual({ collapsed: false, width: 180 });
    expect(draggedSidebar(119.9, 1280)).toEqual({ collapsed: true });
    expect(draggedSidebar(-50, 1280)).toEqual({ collapsed: true });
    expect(draggedSidebar(700, 1280)).toEqual({ collapsed: false, width: 480 });
    expect(draggedSidebar(450, 800)).toEqual({ collapsed: false, width: 400 });
  });
});
