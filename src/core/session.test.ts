import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { parseSession, restoreSelection } from "./session";

describe("parseSession", () => {
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
    expect(session.tabs).toEqual([
      {
        kind: "memo",
        memoId: "a",
        selection: { ranges: [{ anchor: 1, head: 2 }], main: 0 },
        scrollAnchor: 40,
      },
      { kind: "external", deviceId: "d", path: "/x.sh" },
    ]);
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
