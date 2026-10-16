import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { parseSession, restoreSelection } from "./session";

describe("parseSession", () => {
  it("reads mode and language and drops values it does not know", () => {
    const session = parseSession(
      JSON.stringify({
        version: 1,
        activeTab: 0,
        tabs: [
          { kind: "memo", memoId: "a", mode: "preview" },
          { kind: "memo", memoId: "b", mode: "split" },
          { kind: "external", deviceId: "d", path: "/x", language: "python" },
          { kind: "external", deviceId: "d", path: "/y", language: 3 },
        ],
      }),
    );
    expect(session.tabs[0]).toEqual({ kind: "memo", memoId: "a", mode: "preview" });
    expect(session.tabs[1]).toEqual({ kind: "memo", memoId: "b" });
    expect(session.tabs[2]).toEqual({
      kind: "external",
      deviceId: "d",
      path: "/x",
      language: "python",
    });
    expect(session.tabs[3]).toEqual({ kind: "external", deviceId: "d", path: "/y" });
  });

  it("reads the conflict-kept banner of a memo tab and drops what is not one", () => {
    const session = parseSession(
      JSON.stringify({
        version: 1,
        activeTab: 0,
        tabs: [
          { kind: "memo", memoId: "n", conflictKept: { memoId: "m1" } },
          { kind: "memo", memoId: "o", conflictKept: { memoId: 3 } },
          { kind: "memo", memoId: "p", conflictKept: "m1" },
          { kind: "external", deviceId: "d", path: "/x", conflictKept: { memoId: "m1" } },
        ],
      }),
    );
    expect(session.tabs[0]).toEqual({ kind: "memo", memoId: "n", conflictKept: { memoId: "m1" } });
    expect(session.tabs[1]).toEqual({ kind: "memo", memoId: "o" });
    expect(session.tabs[2]).toEqual({ kind: "memo", memoId: "p" });
    expect(session.tabs[3]).toEqual({ kind: "external", deviceId: "d", path: "/x" });
  });

  it("starts empty without a file or with a broken one", () => {
    for (const text of [null, "", "{ broken", "[1]", '{"tabs":"x"}']) {
      expect(parseSession(text)).toEqual({ version: 1, activeTab: -1, tabs: [] });
    }
  });

  it("keeps the active tab when an earlier tab is dropped", () => {
    const session = parseSession(
      JSON.stringify({
        version: 1,
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
      }),
    );
    expect(session.activeTab).toBe(1);
    // An active tab that was dropped, or none given, falls back to the first tab that is left.
    const dropped = '{"activeTab":1,"tabs":[{"kind":"memo","memoId":"a"},{"kind":"mystery"}]}';
    expect(parseSession(dropped).activeTab).toBe(0);
    expect(parseSession('{"tabs":[{"kind":"memo","memoId":"a"}]}').activeTab).toBe(0);
    expect(session.tabs).toEqual([
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
      parseSession(JSON.stringify({ tabs: [{ kind: "memo", memoId: "a", selection }] })).tabs[0];
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
    expect(
      parseSession('{"tabs":[],"window":{"x":1,"y":2,"width":800,"height":600}}').window,
    ).toEqual({
      x: 1,
      y: 2,
      width: 800,
      height: 600,
    });
    expect(parseSession('{"tabs":[],"window":{"x":"1"}}').window).toBeUndefined();
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
