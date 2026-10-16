import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { defaultFakeData, FakeBackend, fakeMemo, memoryStorage } from "../backend/fake";
import type { MemoInfo } from "../backend/types";
import { WriteScheduler } from "../core/scheduler";
import { conflictKeptText, ExternalDoc, MemoDoc, type DocHost } from "./docs";
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
    view: { state: EditorState.create(), dispatch: () => {} },
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
    tabs,
    "device-1",
    (id) => infos.get(id),
    (info) => new MemoDoc(host, info),
    (path) => new ExternalDoc(host, path),
  );
  return { backend, tabs, sync, host, opened };
}

describe("SessionSync.restore", () => {
  it("brings back the scroll anchor, selection, mode and language of each tab", async () => {
    const { tabs, sync } = setup(
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
    const active = await sync.restore();
    expect(tabs.list.map((d) => d.kind)).toEqual(["memo", "external"]);
    expect(tabs.list[0].scrollAnchor).toBe(40);
    expect(tabs.list[0].mode).toBe("preview");
    expect(tabs.list[1].restoreSelection).toEqual({ ranges: [{ anchor: 2, head: 2 }], main: 0 });
    expect(tabs.list[1].language).toBe("python");
    expect(active).toBe(tabs.list[1]);
  });

  it("drops a memo the list no longer has and an external file of another device", async () => {
    const { tabs, sync } = setup(
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
    const active = await sync.restore();
    expect(tabs.list.map((d) => (d as MemoDoc).info?.id)).toEqual(["a"]);
    // The active tab was dropped: the last tab that is left is shown.
    expect(active).toBe(tabs.list[0]);
  });

  it("brings back the tabs of the first pane of a version 2 window", async () => {
    const { tabs, sync } = setup(
      {
        version: 2,
        windows: [
          {
            panes: [
              { tabs: [{ kind: "memo", memoId: "a" }], activeTab: 0, width: 0.5 },
              { tabs: [{ kind: "memo", memoId: "b" }], activeTab: 0, width: 0.5 },
            ],
            focusedPane: 1,
          },
        ],
      },
      { a: fakeMemo("가.md", ""), b: fakeMemo("나.md", "") },
    );
    const active = await sync.restore();
    expect(tabs.list.map((d) => (d as MemoDoc).info?.id)).toEqual(["a"]);
    expect(active).toBe(tabs.list[0]);
  });

  it("opens the same memo once even if the session lists it twice", async () => {
    const { tabs, sync } = setup(
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
    await sync.restore();
    expect(tabs.list).toHaveLength(1);
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
    const { tabs, sync } = setup(
      {
        version: 1,
        activeTab: 0,
        tabs: [{ kind: "memo", memoId: "n", conflictKept: { memoId: "a" } }],
      },
      { a: fakeMemo("장보기.md", "다른 앱"), n: fakeMemo("장보기 2.md", "내 글") },
    );
    await sync.restore();
    const doc = tabs.list[0] as MemoDoc;
    await doc.ensureLoaded();
    await doc.onOutside({ kind: "removed", id: "n", file: "장보기 2.md" });
    expect(doc.banner?.kind).toBe("deleted");
    expect(sessionTab(doc, "device-1")).toMatchObject({ conflictKept: { memoId: "a" } });
  });

  it("brings back the conflict-kept banner", async () => {
    const { tabs, sync, opened } = setup(
      {
        version: 1,
        activeTab: 0,
        tabs: [{ kind: "memo", memoId: "n", conflictKept: { memoId: "a" } }],
      },
      { a: fakeMemo("장보기.md", "다른 앱"), n: fakeMemo("장보기 2.md", "내 글") },
    );
    await sync.restore();
    const doc = tabs.list[0] as MemoDoc;
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
    const { tabs, sync } = setup(
      {
        version: 1,
        activeTab: 0,
        tabs: [{ kind: "memo", memoId: "n", conflictKept: { memoId: "gone" } }],
      },
      { n: fakeMemo("장보기 2.md", "내 글") },
    );
    await sync.restore();
    const doc = tabs.list[0] as MemoDoc;
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
          view: { state: EditorState.create(), dispatch: () => {} },
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
          view: { state: EditorState.create(), dispatch: () => {} },
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
    const [pane] = session.panes;
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
      panes: [{ tabs: [], activeTab: -1, width: 1 }],
      focusedPane: 0,
    });
    const frame = { x: 1, y: 2, width: 800, height: 600 };
    backend.windowFrame = async () => frame;
    expect((await sync.build(() => {})).frame).toEqual(frame);
  });
});
