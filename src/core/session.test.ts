import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  isSessionPane,
  normalizeWidths,
  parseSessionFile,
  parseWindowSession,
  restoreSelection,
  sessionPanes,
  type PaneSession,
  type SessionSplit,
} from "./session";

/** The tabs of a window with one pane, read as the session's only window. */
const onePane = (pane: object) => sessionPanes(parseWindowSession({ panes: [pane] }).layout)[0];

const memoTab = (memoId: string) => ({ kind: "memo" as const, memoId });

describe("parseSessionFile", () => {
  it("parseSessionFile reads a version 1 file as one window with one pane", () => {
    const a = { kind: "memo", memoId: "a" };
    const b = { kind: "memo", memoId: "b" };
    expect(
      parseSessionFile(
        JSON.stringify({
          version: 1,
          window: { x: 10, y: 20, width: 900, height: 700 },
          activeTab: 1,
          tabs: [a, b],
        }),
      ),
    ).toEqual({
      version: 2,
      windows: [
        {
          frame: { x: 10, y: 20, width: 900, height: 700 },
          layout: { tabs: [a, b], activeTab: 1 },
          focusedPane: 0,
        },
      ],
    });
  });

  it("reads every window of a version 2 file", () => {
    const window = (memoId: string) => ({
      layout: { tabs: [{ kind: "memo", memoId }], activeTab: 0 },
      focusedPane: 0,
    });
    const file = { version: 2, windows: [window("a"), window("b")] };
    expect(parseSessionFile(JSON.stringify(file))).toEqual(file);
  });

  it("starts empty without a file or with a broken one", () => {
    for (const text of [null, "", "{ broken", "[1]", '{"tabs":"x"}', '{"version":2}']) {
      expect(parseSessionFile(text)).toEqual({ version: 2, windows: [] });
    }
  });
});

describe("parseWindowSession", () => {
  it("parseWindowSession keeps at least one pane", () => {
    for (const value of [{ panes: [] }, {}, null, { panes: ["x"] }]) {
      expect(parseWindowSession(value)).toEqual({
        layout: { tabs: [], activeTab: -1 },
        focusedPane: 0,
      });
    }
  });

  it("widths are made to sum to 1, equal shares when unusable", () => {
    const widths = (...values: unknown[]) =>
      (
        parseWindowSession({ panes: values.map((width) => ({ tabs: [], width })) })
          .layout as SessionSplit
      ).shares ?? [1];
    expect(widths(2, 2)).toEqual([0.5, 0.5]);
    expect(widths(1, 3)).toEqual([0.25, 0.75]);
    expect(widths(0, -1)).toEqual([0.5, 0.5]);
    expect(widths(1, 0)).toEqual([0.5, 0.5]);
    expect(widths(1, "x")).toEqual([0.5, 0.5]);
    expect(widths(undefined)).toEqual([1]);
  });

  it("reads the sidebar as collapsed only for true", () => {
    expect(parseWindowSession({ sidebarCollapsed: true }).sidebarCollapsed).toBe(true);
    for (const sidebarCollapsed of ["true", 1, null, false, undefined]) {
      expect(parseWindowSession({ sidebarCollapsed })).not.toHaveProperty("sidebarCollapsed");
    }
    expect(parseWindowSession({})).not.toHaveProperty("sidebarCollapsed");
  });

  it("reads the sidebar's width only from 180 to 480 and other than 240", () => {
    for (const sidebarWidth of [180, 300, 480])
      expect(parseWindowSession({ sidebarWidth }).sidebarWidth).toBe(sidebarWidth);
    for (const sidebarWidth of [240, 179, 481, "300", null, true, undefined]) {
      expect(parseWindowSession({ sidebarWidth })).not.toHaveProperty("sidebarWidth");
    }
  });

  it("focusedPane out of range is 0", () => {
    const panes = [{ tabs: [] }, { tabs: [] }];
    expect(parseWindowSession({ panes, focusedPane: 1 }).focusedPane).toBe(1);
    for (const focusedPane of [2, -1, 0.5, "1", undefined]) {
      expect(parseWindowSession({ panes, focusedPane }).focusedPane).toBe(0);
    }
  });

  it("reads mode and language and drops values it does not know", () => {
    const pane = onePane({
      activeTab: 0,
      tabs: [
        { kind: "memo", memoId: "a", mode: "preview" },
        { kind: "memo", memoId: "b", mode: "split" },
        { kind: "external", deviceId: "d", path: "/x", language: "python" },
        { kind: "external", deviceId: "d", path: "/y", language: 3 },
      ],
    });
    expect(pane.tabs[0]).toEqual({ kind: "memo", memoId: "a", mode: "preview" });
    expect(pane.tabs[1]).toEqual({ kind: "memo", memoId: "b" });
    expect(pane.tabs[2]).toEqual({
      kind: "external",
      deviceId: "d",
      path: "/x",
      language: "python",
    });
    expect(pane.tabs[3]).toEqual({ kind: "external", deviceId: "d", path: "/y" });
  });

  it("reads the conflict-kept banner of a memo tab and drops what is not one", () => {
    const pane = onePane({
      activeTab: 0,
      tabs: [
        { kind: "memo", memoId: "n", conflictKept: { memoId: "m1" } },
        { kind: "memo", memoId: "o", conflictKept: { memoId: 3 } },
        { kind: "memo", memoId: "p", conflictKept: "m1" },
        { kind: "external", deviceId: "d", path: "/x", conflictKept: { memoId: "m1" } },
      ],
    });
    expect(pane.tabs[0]).toEqual({ kind: "memo", memoId: "n", conflictKept: { memoId: "m1" } });
    expect(pane.tabs[1]).toEqual({ kind: "memo", memoId: "o" });
    expect(pane.tabs[2]).toEqual({ kind: "memo", memoId: "p" });
    expect(pane.tabs[3]).toEqual({ kind: "external", deviceId: "d", path: "/x" });
  });

  it("keeps the active tab when an earlier tab is dropped", () => {
    const pane = onePane({
      activeTab: 2,
      tabs: [
        {
          kind: "memo",
          memoId: "a",
          selection: { ranges: [{ anchor: 1, head: 2 }], main: 0 },
          scrollAnchor: 40,
        },
        { kind: "mystery" },
        { kind: "external", deviceId: "d", path: "/x.sh" },
      ],
    });
    expect(pane.activeTab).toBe(1);
    // An active tab that was dropped, or none given, falls back to the first tab that is left.
    const dropped = { activeTab: 1, tabs: [{ kind: "memo", memoId: "a" }, { kind: "mystery" }] };
    expect(onePane(dropped).activeTab).toBe(0);
    expect(onePane({ tabs: [{ kind: "memo", memoId: "a" }] }).activeTab).toBe(0);
    expect(onePane({ tabs: "x" })).toEqual({ tabs: [], activeTab: -1 });
    expect(pane.tabs).toEqual([
      {
        kind: "memo",
        memoId: "a",
        selection: { ranges: [{ anchor: 1, head: 2 }], main: 0 },
        scrollAnchor: 40,
      },
      { kind: "external", deviceId: "d", path: "/x.sh" },
    ]);

    // A selection keeps its main range past ranges that are dropped, and rejects fractional positions.
    const tab = (selection: unknown) =>
      onePane({ tabs: [{ kind: "memo", memoId: "a", selection }] }).tabs[0];
    expect(
      tab({
        ranges: [
          { anchor: 1.5, head: 2 },
          { anchor: 3, head: 3 },
          { anchor: 7, head: 8 },
        ],
        main: 2,
      }),
    ).toMatchObject({
      selection: {
        ranges: [
          { anchor: 3, head: 3 },
          { anchor: 7, head: 8 },
        ],
        main: 1,
      },
    });
    // The main range itself was dropped.
    expect(
      tab({
        ranges: [
          { anchor: 1, head: 1 },
          { anchor: "x", head: 2 },
        ],
        main: 1,
      }),
    ).toMatchObject({ selection: { main: 0 } });
  });

  it("reads the window frame when it is complete", () => {
    expect(parseWindowSession({ frame: { x: 1, y: 2, width: 800, height: 600 } }).frame).toEqual({
      x: 1,
      y: 2,
      width: 800,
      height: 600,
    });
    expect(parseWindowSession({ frame: { x: "1" } }).frame).toBeUndefined();
  });
});

describe("the layout tree", () => {
  it("reads the old panes row into a row split", () => {
    const w = parseWindowSession({
      panes: [
        { tabs: [memoTab("a")], activeTab: 0, width: 3 },
        { tabs: [memoTab("b")], activeTab: 0, width: 1 },
      ],
      focusedPane: 1,
    });
    expect(w.layout).toMatchObject({ axis: "row", shares: [0.75, 0.25] });
    expect(sessionPanes(w.layout).map((p) => p.tabs.length)).toEqual([1, 1]);
    expect(w.focusedPane).toBe(1);
  });
  it("reads the layout adopt_tab writes", () => {
    const w = parseWindowSession({
      panes: [{ tabs: [memoTab("a")], activeTab: 0, width: 1 }],
      focusedPane: 0,
    });
    expect(isSessionPane(w.layout)).toBe(true);
  });
  it("reads a nested layout back as written", () => {
    const layout = {
      axis: "row",
      shares: [0.5, 0.5],
      children: [
        { tabs: [memoTab("a")], activeTab: 0 },
        {
          axis: "column",
          shares: [0.5, 0.5],
          children: [
            { tabs: [], activeTab: -1 },
            { tabs: [memoTab("c")], activeTab: 0 },
          ],
        },
      ],
    };
    expect(parseWindowSession({ layout, focusedPane: 2 })).toEqual({ layout, focusedPane: 2 });
  });
  it("a broken branch keeps its tabs in one pane", () => {
    const w = parseWindowSession({
      layout: {
        axis: "diagonal",
        children: [
          { tabs: [memoTab("a")], activeTab: 0 },
          { tabs: [memoTab("b")], activeTab: 0 },
        ],
      },
      focusedPane: 0,
    });
    expect(sessionPanes(w.layout)).toEqual([
      { tabs: [memoTab("a"), memoTab("b")], activeTab: 0 } satisfies PaneSession,
    ]);
  });
  it("shares that do not add up are normalised and a lone child replaces its branch", () => {
    const w = parseWindowSession({
      layout: {
        axis: "column",
        shares: [2, 2],
        children: [
          { tabs: [], activeTab: -1 },
          { axis: "row", shares: [1], children: [{ tabs: [memoTab("x")], activeTab: 0 }] },
        ],
      },
      focusedPane: 9,
    });
    expect(w.layout).toMatchObject({ axis: "column", shares: [0.5, 0.5] });
    expect(isSessionPane((w.layout as SessionSplit).children[1])).toBe(true);
    expect(w.focusedPane).toBe(0);
  });
  it("a child that is not an object is dropped with its share and no tab is lost", () => {
    const w = parseWindowSession({
      layout: {
        axis: "row",
        shares: [1, 5, 2],
        children: [
          { tabs: [memoTab("a")], activeTab: 0 },
          "x",
          { tabs: [memoTab("b")], activeTab: 0 },
        ],
      },
    });
    expect(w.layout).toMatchObject({ axis: "row", shares: [1 / 3, 2 / 3] });
    expect(sessionPanes(w.layout).map((p) => p.tabs)).toEqual([[memoTab("a")], [memoTab("b")]]);
  });
  it("reads three old panes with their widths as shares", () => {
    const pane = (id: string, width: number) => ({ tabs: [memoTab(id)], activeTab: 0, width });
    const w = parseWindowSession({ panes: [pane("a", 1), pane("b", 1), pane("c", 2)] });
    expect(w.layout).toMatchObject({ axis: "row", shares: [0.25, 0.25, 0.5] });
  });
});

describe("normalizeWidths", () => {
  it("divides by the sum, or gives equal shares when any width is unusable", () => {
    expect(normalizeWidths([])).toEqual([]);
    expect(normalizeWidths([3])).toEqual([1]);
    expect(normalizeWidths([1, 1, 2])).toEqual([0.25, 0.25, 0.5]);
    expect(normalizeWidths([1, 0])).toEqual([0.5, 0.5]);
    expect(normalizeWidths([1, Number.NaN, 1, Infinity])).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});

describe("restoreSelection", () => {
  it("pulls positions past the end back in and keeps the main range", () => {
    const sel = restoreSelection(
      {
        ranges: [
          { anchor: 1, head: 1 },
          { anchor: 10, head: 10 },
        ],
        main: 1,
      },
      Text.of(["abc"]),
    );
    expect(sel.ranges.map((r) => r.head)).toEqual([1, 3]);
    expect(sel.mainIndex).toBe(1);
  });

  it("starts at the top without a saved selection", () => {
    expect(restoreSelection(undefined, Text.of(["abc"])).main.head).toBe(0);
  });
});
