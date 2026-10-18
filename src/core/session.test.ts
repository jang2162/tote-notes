import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  normalizeWidths,
  parsePane,
  parseSessionFile,
  parseWindowSession,
  restoreSelection,
} from "./session";

/** The tabs of a window with one pane, read as the session's only window. */
const onePane = (pane: object) => parseWindowSession({ panes: [pane] }).panes[0];

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
          panes: [{ tabs: [a, b], activeTab: 1, width: 1 }],
          focusedPane: 0,
        },
      ],
    });
  });

  it("reads every window of a version 2 file", () => {
    const window = (memoId: string) => ({
      panes: [{ tabs: [{ kind: "memo", memoId }], activeTab: 0, width: 1 }],
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
        panes: [{ tabs: [], activeTab: -1, width: 1 }],
        focusedPane: 0,
      });
    }
  });

  it("widths are made to sum to 1, equal shares when unusable", () => {
    const widths = (...values: unknown[]) =>
      parseWindowSession({ panes: values.map((width) => ({ tabs: [], width })) }).panes.map(
        (pane) => pane.width,
      );
    expect(widths(2, 2)).toEqual([0.5, 0.5]);
    expect(widths(1, 3)).toEqual([0.25, 0.75]);
    expect(widths(0, -1)).toEqual([0.5, 0.5]);
    expect(widths(1, 0)).toEqual([0.5, 0.5]);
    expect(widths(1, "x")).toEqual([0.5, 0.5]);
    expect(widths(undefined)).toEqual([1]);
  });

  it("a width that is not a number is kept as NaN, never a string typed as a number", () => {
    // Before `normalizeWidths` judges it, which a window parse always does.
    const { width } = parsePane({ tabs: [], width: "x" });
    expect(typeof width).toBe("number");
    expect(Number.isNaN(width)).toBe(true);
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
    expect(onePane({ tabs: "x" })).toEqual({ tabs: [], activeTab: -1, width: 1 });
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
