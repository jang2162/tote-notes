import { describe, expect, it } from "vitest";

import { parseSessionFile } from "../core/session";
import { defaultFakeData } from "./fake";
import { FakeHub } from "./fake-hub";

const layout = (memoId: string) => ({
  layout: { tabs: [{ kind: "memo", memoId }], activeTab: 0 },
  focusedPane: 0,
});

const memoIds = (session: string | null) =>
  parseSessionFile(session).windows.map((window) =>
    "tabs" in window.layout
      ? window.layout.tabs.map((tab) => tab.kind === "memo" && tab.memoId)
      : [],
  );

describe("FakeHub", () => {
  it("a layout written before the other saved windows start keeps theirs", () => {
    const data = defaultFakeData();
    data.session = JSON.stringify({ version: 2, windows: [layout("a"), layout("b")] });
    const first = new FakeHub("ws-1");
    first.register(data);
    // The second window's page has not started yet: the native side made it at launch all the same.
    first.writeLayout(data, layout("c"));
    expect(memoIds(data.session)).toEqual([["c"], ["b"]]);
    const second = new FakeHub("ws-2");
    second.register(data);
    expect(second.layout(data)).toMatchObject({ layout: { tabs: [{ memoId: "b" }] } });
    second.writeLayout(data, layout("d"));
    expect(memoIds(data.session)).toEqual([["c"], ["d"]]);
  });

  it("a quit keeps the layouts of saved windows whose pages never started", () => {
    const data = defaultFakeData();
    data.session = JSON.stringify({ version: 2, windows: [layout("a"), layout("b")] });
    const first = new FakeHub("ws-1");
    first.register(data);
    first.quit(data);
    expect(memoIds(data.session)).toEqual([["a"], ["b"]]);
  });
});
