import { describe, expect, it } from "vitest";

import { defaultFakeData, FakeBackend, fakeMemo, memoryStorage } from "../backend/fake";
import type { MemoInfo } from "../backend/types";
import { WriteScheduler } from "../core/scheduler";
import { ExternalDoc, MemoDoc, type DocHost } from "./docs";
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
  const host: DocHost = {
    backend,
    writes: new WriteScheduler(() => {}),
    extensions: () => [],
    languageConfig: async () => ({}),
    languageOf: () => undefined,
    changed: () => {},
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
  return { backend, tabs, sync };
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

describe("SessionSync.build and sessionTab", () => {
  it("writes mode and language only when they differ from the default", async () => {
    const { tabs, sync } = setup(null, { a: fakeMemo("가.md", "") });
    const memo = tabs.insertAfterActive(
      new MemoDoc(
        {
          backend: new FakeBackend(),
          writes: new WriteScheduler(() => {}),
          extensions: () => [],
          languageConfig: async () => ({}),
          languageOf: () => undefined,
          changed: () => {},
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
          extensions: () => [],
          languageConfig: async () => ({}),
          languageOf: () => undefined,
          changed: () => {},
        },
        "/x/a.sh",
      ),
    );
    ext.language = "python";
    tabs.active = ext;
    let captured = 0;
    const session = await sync.build(() => void captured++);
    expect(captured).toBe(1);
    expect(session.activeTab).toBe(1);
    expect(session.tabs[0]).toEqual({
      kind: "memo",
      memoId: "a",
      scrollAnchor: 0,
      mode: "preview",
    });
    expect(session.tabs[1]).toEqual({
      kind: "external",
      deviceId: "device-1",
      path: "/x/a.sh",
      scrollAnchor: 0,
      language: "python",
    });
    memo.mode = "edit";
    expect(sessionTab(memo, "device-1")).toEqual({ kind: "memo", memoId: "a", scrollAnchor: 0 });
  });
});
