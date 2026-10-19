import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

import { defaultFakeData, FakeBackend, fakeMemo, memoryStorage } from "../backend/fake";
import type { MemoInfo } from "../backend/types";
import { WriteScheduler } from "../core/scheduler";
import { sessionPanes } from "../core/session";
import { conflictKeptText, ExternalDoc, MemoDoc, type DocHost } from "./docs";
import { leaf } from "./layout";
import { SessionSync, sessionTab } from "./session-sync";
import { Tabs } from "./tabs";

function setup(session: object | null, memos: Record<string, ReturnType<typeof fakeMemo>> = {}) {
  const backend = new FakeBackend(
    memoryStorage(
      JSON.stringify({
        ...defaultFakeData(),
        memos,
        session: session ? JSON.stringify(session) : null,
      }),
    ),
  );
  const opened: string[] = [];
  const host: DocHost = {
    backend,
    writes: new WriteScheduler(() => {}),
    viewOf: () => ({ state: EditorState.create(), dispatch: () => {} }),
    extensions: () => [],
    languageConfig: async () => ({}),
    languageOf: () => undefined,
    languages: () => [],
    changed: () => {},
    memoInfo: (id) => infos.get(id),
    openMemo: (id) => void opened.push(id),
  };
  const infos = new Map<string, MemoInfo>();
  for (const [id, memo] of Object.entries(memos)) {
    infos.set(id, {
      id,
      file: memo.file,
      autoTitle: memo.autoTitle,
      modifiedMs: 0,
      size: 0,
      kind: "text",
    });
  }
  const tabs = new Tabs();
  const sync = new SessionSync(
    backend,
    () => ({ layout: leaf("p"), panes: new Map([["p", { tabs }]]), focusedPane: 0 }),
    "device-1",
    (id) => infos.get(id),
    (info) => new MemoDoc(host, info),
    (path) => new ExternalDoc(host, path),
  );
  return { backend, tabs, sync, host, opened };
}

describe("SessionSync.restore", () => {
  it("brings back the scroll anchor, selection, mode and language of each tab", async () => {
    const { sync } = setup(
      {
        version: 1,
        activeTab: 1,
        tabs: [
          { kind: "memo", memoId: "a", scrollAnchor: 40, mode: "preview" },
          {
            kind: "external",
            deviceId: "device-1",
            path: "/x/a.sh",
            selection: { ranges: [{ anchor: 2, head: 2 }], main: 0 },
            language: "python",
          },
        ],
      },
      { a: fakeMemo("가.md", "x".repeat(100)) },
    );
    const [{ tabs, active }] = (await sync.restore()).panes;
    expect(tabs.map((d) => d.kind)).toEqual(["memo", "external"]);
    expect(tabs[0].scrollAnchor).toBe(40);
    expect(tabs[0].mode).toBe("preview");
    expect(tabs[1].restoreSelection).toEqual({ ranges: [{ anchor: 2, head: 2 }], main: 0 });
    expect(tabs[1].language).toBe("python");
    expect(active).toBe(tabs[1]);
  });

  it("drops a memo the list no longer has and an external file of another device", async () => {
    const { sync } = setup(
      {
        version: 1,
        activeTab: 0,
        tabs: [
          { kind: "memo", memoId: "gone" },
          { kind: "external", deviceId: "other-device", path: "/x/a.sh" },
          { kind: "memo", memoId: "a" },
        ],
      },
      { a: fakeMemo("가.md", "") },
    );
    const [{ tabs, active }] = (await sync.restore()).panes;
    expect(tabs.map((d) => (d as MemoDoc).info?.id)).toEqual(["a"]);
    // The active tab was dropped: the last tab that is left is shown.
    expect(active).toBe(tabs[0]);
  });

  it("brings back every pane of a version 2 window with its width and the focus", async () => {
    const { sync } = setup(
      {
        version: 2,
        windows: [
          {
            panes: [
              { tabs: [{ kind: "memo", memoId: "a" }], activeTab: 0, width: 0.25 },
              { tabs: [{ kind: "memo", memoId: "b" }], activeTab: 0, width: 0.75 },
            ],
            focusedPane: 1,
          },
        ],
      },
      { a: fakeMemo("가.md", ""), b: fakeMemo("나.md", "") },
    );
    const { panes, layout, focusedPane } = await sync.restore();
    expect(panes.map(({ tabs }) => tabs.map((d) => (d as MemoDoc).info?.id))).toEqual([
      ["a"],
      ["b"],
    ]);
    expect(panes.map(({ tabs, active }) => active === tabs[0])).toEqual([true, true]);
    expect(layout).toMatchObject({ axis: "row", shares: [0.25, 0.75] });
    expect(focusedPane).toBe(1);
  });

  it("opens the same memo once even if the session lists it twice", async () => {
    const { sync } = setup(
      {
        version: 1,
        activeTab: 0,
        tabs: [
          { kind: "memo", memoId: "a" },
          { kind: "memo", memoId: "a" },
        ],
      },
      { a: fakeMemo("가.md", "") },
    );
    const [{ tabs }] = (await sync.restore()).panes;
    expect(tabs).toHaveLength(1);
  });

  it("opens every tab when their places cannot be claimed", async () => {
    const { backend, sync } = setup(
      {
        version: 1,
        activeTab: 1,
        tabs: [
          { kind: "memo", memoId: "a" },
          { kind: "external", deviceId: "device-1", path: "/x/a.sh" },
        ],
      },
      { a: fakeMemo("가.md", "") },
    );
    const failure = new Error("the places could not be claimed");
    backend.claimTabs = () => Promise.reject(failure);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const [{ tabs, active }] = (await sync.restore()).panes;
      expect(tabs.map((d) => d.kind)).toEqual(["memo", "external"]);
      expect(active).toBe(tabs[1]);
      expect(logged).toHaveBeenCalledWith(failure);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("conflict-kept banner in the session", () => {
  it("writes the conflict-kept banner with its tab", () => {
    const { host } = setup(null, { a: fakeMemo("가.md", "") });
    const info = {
      id: "n",
      file: "가 2.md",
      autoTitle: false,
      modifiedMs: 0,
      size: 0,
      kind: "text" as const,
    };
    const doc = new MemoDoc(host, info);
    expect(sessionTab(doc, "device-1")).not.toHaveProperty("conflictKept");
    doc.keepConflict("a");
    expect(sessionTab(doc, "device-1")).toMatchObject({
      kind: "memo",
      memoId: "n",
      conflictKept: { memoId: "a" },
    });
  });

  it("keeps conflictKept in the session while another banner is up", async () => {
    const { sync } = setup(
      {
        version: 1,
        activeTab: 0,
        tabs: [{ kind: "memo", memoId: "n", conflictKept: { memoId: "a" } }],
      },
      { a: fakeMemo("장보기.md", "다른 앱"), n: fakeMemo("장보기 2.md", "내 글") },
    );
    const doc = (await sync.restore()).panes[0].tabs[0] as MemoDoc;
    await doc.ensureLoaded();
    await doc.onOutside({ kind: "removed", id: "n", file: "장보기 2.md" });
    expect(doc.banner?.kind).toBe("deleted");
    expect(sessionTab(doc, "device-1")).toMatchObject({ conflictKept: { memoId: "a" } });
  });

  it("brings back the conflict-kept banner", async () => {
    const { sync, opened } = setup(
      {
        version: 1,
        activeTab: 0,
        tabs: [{ kind: "memo", memoId: "n", conflictKept: { memoId: "a" } }],
      },
      { a: fakeMemo("장보기.md", "다른 앱"), n: fakeMemo("장보기 2.md", "내 글") },
    );
    const doc = (await sync.restore()).panes[0].tabs[0] as MemoDoc;
    expect(doc.banner?.kind).toBe("info");
    expect(doc.banner?.text).toBe(conflictKeptText("장보기"));
    expect(doc.banner?.actions.map((a) => a.label)).toEqual(["원래 메모 열기", "닫기"]);
    doc.banner!.actions[0].run();
    expect(opened).toEqual(["a"]);
    // Opening the original leaves the banner up; closing it ends the note.
    expect(doc.banner).not.toBeNull();
    doc.banner!.actions[1].run();
    expect(doc.banner).toBeNull();
    expect(doc.conflictKept).toBeNull();
  });

  it("names no memo when the original is not in the list, and offers only 닫기", async () => {
    const { sync } = setup(
      {
        version: 1,
        activeTab: 0,
        tabs: [{ kind: "memo", memoId: "n", conflictKept: { memoId: "gone" } }],
      },
      { n: fakeMemo("장보기 2.md", "내 글") },
    );
    const doc = (await sync.restore()).panes[0].tabs[0] as MemoDoc;
    expect(doc.banner?.text).toBe(conflictKeptText(null));
    expect(doc.banner?.actions.map((a) => a.label)).toEqual(["닫기"]);
  });
});

describe("SessionSync.build and sessionTab", () => {
  it("writes mode and language only when they differ from the default", async () => {
    const { tabs, sync } = setup(null, { a: fakeMemo("가.md", "") });
    const memo = tabs.insertAfterActive(
      new MemoDoc(
        {
          backend: new FakeBackend(),
          writes: new WriteScheduler(() => {}),
          viewOf: () => ({ state: EditorState.create(), dispatch: () => {} }),
          extensions: () => [],
          languageConfig: async () => ({}),
          languageOf: () => undefined,
          languages: () => [],
          changed: () => {},
          memoInfo: () => undefined,
          openMemo: () => {},
        },
        { id: "a", file: "가.md", autoTitle: false, modifiedMs: 0, size: 0, kind: "text" },
      ),
    );
    memo.mode = "preview";
    const ext = tabs.insertAfterActive(
      new ExternalDoc(
        {
          backend: new FakeBackend(),
          writes: new WriteScheduler(() => {}),
          viewOf: () => ({ state: EditorState.create(), dispatch: () => {} }),
          extensions: () => [],
          languageConfig: async () => ({}),
          languageOf: () => undefined,
          languages: () => [],
          changed: () => {},
          memoInfo: () => undefined,
          openMemo: () => {},
        },
        "/x/a.sh",
      ),
    );
    ext.language = "python";
    tabs.active = ext;
    let captured = 0;
    const session = await sync.build(() => void captured++);
    expect(captured).toBe(1);
    const [pane] = sessionPanes(session.layout);
    expect(pane.activeTab).toBe(1);
    expect(pane.tabs[0]).toEqual({
      kind: "memo",
      memoId: "a",
      scrollAnchor: 0,
      mode: "preview",
    });
    expect(pane.tabs[1]).toEqual({
      kind: "external",
      deviceId: "device-1",
      path: "/x/a.sh",
      scrollAnchor: 0,
      language: "python",
    });
    memo.mode = "edit";
    expect(sessionTab(memo, "device-1")).toEqual({ kind: "memo", memoId: "a", scrollAnchor: 0 });
  });

  it("builds a window of one pane with the whole width and the window's frame", async () => {
    const { backend, sync } = setup(null);
    expect(await sync.build(() => {})).toEqual({
      layout: { tabs: [], activeTab: -1 },
      focusedPane: 0,
    });
    const frame = { x: 1, y: 2, width: 800, height: 600 };
    backend.windowFrame = async () => frame;
    expect((await sync.build(() => {})).frame).toEqual(frame);
  });

  it("builds the layout tree with each pane's tabs", async () => {
    const { backend, host, tabs } = setup(null, {
      a: fakeMemo("가.md", ""),
      b: fakeMemo("나.md", ""),
      c: fakeMemo("다.md", ""),
    });
    const tabsOf = (id: string, own: Tabs) => {
      const info = host.memoInfo(id)!;
      own.active = own.insertAfterActive(new MemoDoc(host, info));
      return own;
    };
    const [a, b, c] = [tabsOf("a", tabs), tabsOf("b", new Tabs()), tabsOf("c", new Tabs())];
    const layout = {
      kind: "split" as const,
      axis: "row" as const,
      shares: [0.4, 0.6],
      children: [
        leaf("a"),
        {
          kind: "split" as const,
          axis: "column" as const,
          shares: [0.5, 0.5],
          children: [leaf("b"), leaf("c")],
        },
      ],
    };
    const built = new SessionSync(
      backend,
      () => ({
        layout,
        panes: new Map([
          ["a", { tabs: a }],
          ["b", { tabs: b }],
          ["c", { tabs: c }],
        ]),
        focusedPane: 2,
      }),
      "device-1",
      (id) => host.memoInfo(id),
      (info) => new MemoDoc(host, info),
      (path) => new ExternalDoc(host, path),
    );
    const session = await built.build(() => {});
    const memo = (id: string) => ({ kind: "memo", memoId: id, scrollAnchor: 0 });
    expect(session.layout).toEqual({
      axis: "row",
      shares: [0.4, 0.6],
      children: [
        { tabs: [memo("a")], activeTab: 0 },
        {
          axis: "column",
          shares: [0.5, 0.5],
          children: [
            { tabs: [memo("b")], activeTab: 0 },
            { tabs: [memo("c")], activeTab: 0 },
          ],
        },
      ],
    });
    expect(session.focusedPane).toBe(2);
  });
});
