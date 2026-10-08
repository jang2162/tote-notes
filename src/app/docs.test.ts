import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultFakeData,
  FakeBackend,
  fakeFile,
  fakeMemo,
  fromBase64,
  memoryStorage,
  type FakeData,
} from "../backend/fake";
import { WriteScheduler } from "../core/scheduler";
import {
  DRAFT_RESTORED_NOTICE,
  ExternalDoc,
  importExternal,
  MemoDoc,
  RECOVERED_NOTICE,
  type Change,
  type Doc,
  type DocHost,
} from "./docs";

function setup(seed: Partial<FakeData> = {}) {
  const backend = new FakeBackend(memoryStorage(JSON.stringify({ ...defaultFakeData(), ...seed })));
  const changes: Change[] = [];
  const host: DocHost = {
    backend,
    writes: new WriteScheduler((_key, error) => {
      throw error;
    }),
    extensions: () => [],
    changed: (_doc, change) => void changes.push(change),
  };
  return { backend, host, changes };
}

/** Types `insert` at `at` (default: the end) and moves the cursor behind it, as the editor would. */
function type(doc: Doc, insert: string, at?: number) {
  const start = doc.state!;
  const from = at ?? start.doc.length;
  const tr = start.update({
    changes: { from, insert },
    selection: { anchor: from + insert.length },
  });
  doc.update({ state: tr.state, startState: start, docChanged: true, selectionSet: true });
}

const utf8 = (text: string) => new TextEncoder().encode(text);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("MemoDoc", () => {
  it("saves half a second after typing stops", async () => {
    const { backend, host } = setup();
    const doc = new MemoDoc(host, await backend.createMemo());
    doc.startEmpty();
    type(doc, "가");
    await vi.advanceTimersByTimeAsync(300);
    type(doc, "나");
    await vi.advanceTimersByTimeAsync(499);
    expect(backend.memoText(doc.info.id)).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.memoText(doc.info.id)).toBe("가나");
  });

  it("waits three seconds between saves of a large memo", async () => {
    const { backend, host } = setup({ memos: { big: fakeMemo("big.md", "x".repeat(1_000_001)) } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    type(doc, "!");
    await vi.advanceTimersByTimeAsync(2999);
    expect(backend.memoText("big")?.endsWith("!")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.memoText("big")?.endsWith("!")).toBe(true);
  });

  it("takes its title when the cursor leaves the first line", async () => {
    const { backend, host } = setup();
    const doc = new MemoDoc(host, await backend.createMemo());
    doc.startEmpty();
    type(doc, "# 회의 준비");
    await vi.runAllTimersAsync();
    expect(doc.info.file).toBe("untitled.md");
    type(doc, "\n");
    await vi.runAllTimersAsync();
    expect(doc.info.file).toBe("회의 준비.md");
  });

  it("closing an empty new memo removes its file; one the person named stays", async () => {
    const { backend, host, changes } = setup({ memos: { named: fakeMemo("내 메모.md", "") } });
    const fresh = new MemoDoc(host, await backend.createMemo());
    fresh.startEmpty();
    type(fresh, "  \n");
    expect(await fresh.close()).toBe(true);
    expect(backend.data.memos[fresh.info.id]).toBeUndefined();
    expect(changes).toContain("deleted");
    const named = new MemoDoc(
      host,
      (await backend.listMemos()).find((m) => m.id === "named")!,
    );
    await named.ensureLoaded();
    await named.close();
    expect(backend.data.memos.named).toBeDefined();
  });

  it("recovers a memo whose file vanished", async () => {
    const { backend, host } = setup({ memos: { a: fakeMemo("a.md", "원래") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    delete backend.data.memos.a; // renamed or deleted in Finder
    type(doc, " 추가");
    await vi.runAllTimersAsync();
    expect(doc.info.id).not.toBe("a");
    expect(backend.memoText(doc.info.id)).toBe("원래 추가");
    expect(doc.notice).toBe(RECOVERED_NOTICE);
  });

  it("loads once, lazily, and keeps CRLF and the BOM", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("a\r\nb")]);
    const { backend, host } = setup({
      memos: { w: { ...fakeMemo("win.txt", ""), data: fakeFile(bytes) } },
    });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    expect(backend.data.reads).toEqual({});
    await Promise.all([doc.ensureLoaded(), doc.ensureLoaded()]);
    expect(backend.data.reads).toEqual({ w: 1 });
    type(doc, "c");
    await vi.runAllTimersAsync();
    expect([...fromBase64(backend.data.memos.w.data)]).toEqual([
      0xef,
      0xbb,
      0xbf,
      ...utf8("a\r\nbc"),
    ]);
  });

  it("does not read files it cannot show", async () => {
    const { backend, host } = setup({ memos: { p: fakeMemo("사진.png", "") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    expect(doc.problem).toBe("binary");
    expect(backend.data.reads).toEqual({});
  });

  it("restores the session's selection, pulled into the text", async () => {
    const { backend, host } = setup({ memos: { a: fakeMemo("a.md", "abc") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    doc.restoreSelection = { ranges: [{ anchor: 2, head: 99 }], main: 0 };
    await doc.ensureLoaded();
    const { anchor, head } = doc.state!.selection.main;
    expect([anchor, head]).toEqual([2, 3]);
  });
});

describe("ExternalDoc", () => {
  it("keeps a draft a second after typing and finds it again after a restart", async () => {
    const { backend, host } = setup({ files: { "/x/a.sh": fakeFile("echo hi\n") } });
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    type(doc, "# 수정");
    expect(doc.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(backend.data.drafts["/x/a.sh"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.data.drafts["/x/a.sh"]).toBeDefined();

    const restarted = setup({ ...backend.data });
    const again = new ExternalDoc(restarted.host, "/x/a.sh");
    await again.ensureLoaded();
    expect(again.dirty).toBe(true);
    expect(again.state!.doc.toString()).toBe("echo hi\n# 수정");
    expect(again.notice).toBeNull();
  });

  it("says so when the file changed on disk after the draft", async () => {
    const { host } = setup({
      files: { "/x/a.sh": fakeFile("v1") },
      drafts: { "/x/a.sh": { base: fakeFile("v0"), data: fakeFile("mine") } },
    });
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    expect(doc.state!.doc.toString()).toBe("mine");
    expect(doc.notice).toBe(DRAFT_RESTORED_NOTICE);
  });

  it("a_draft_equal_to_the_disk_opens_clean", async () => {
    // ⌘S wrote the file but deleting the draft failed: the draft keeps the old base yet holds
    // exactly what is on disk now.
    const { backend, host } = setup({
      files: { "/x/a.sh": fakeFile("saved") },
      drafts: { "/x/a.sh": { base: fakeFile("old"), data: fakeFile("saved") } },
    });
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    expect(doc.state!.doc.toString()).toBe("saved");
    expect(doc.dirty).toBe(false);
    expect(doc.notice).toBeNull();
    expect(backend.data.drafts["/x/a.sh"]).toBeUndefined();
  });

  it("⌘S writes the file, drops the draft and clears the mark", async () => {
    const { backend, host } = setup({ files: { "/x/a.sh": fakeFile("old") } });
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    type(doc, " new");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await doc.save()).toBe(true);
    expect(backend.fileText("/x/a.sh")).toBe("old new");
    expect(backend.data.drafts["/x/a.sh"]).toBeUndefined();
    expect(doc.dirty).toBe(false);
  });

  it("asks before closing with unsaved edits, and discarding leaves the file alone", async () => {
    const { backend, host } = setup({ files: { "/x/a.sh": fakeFile("old") } });
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    const ask = vi.fn(async () => "cancel" as const);
    expect(await doc.close(ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    type(doc, "!");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await doc.close(async () => "cancel")).toBe(false);
    expect(await doc.close(async () => "discard")).toBe(true);
    expect(backend.data.drafts["/x/a.sh"]).toBeUndefined();
    expect(backend.fileText("/x/a.sh")).toBe("old");
  });

  it("opens a path that does not exist yet and creates it on ⌘S", async () => {
    const { backend, host } = setup();
    const doc = new ExternalDoc(host, "/x/new.txt");
    await doc.ensureLoaded();
    expect(doc.state!.doc.toString()).toBe("");
    type(doc, "처음");
    await doc.save();
    expect(backend.fileText("/x/new.txt")).toBe("처음");
  });
});

describe("importExternal", () => {
  it("copies the edited text into a memo that takes over the tab", async () => {
    const { backend, host } = setup({ files: { "/x/deploy.sh": fakeFile("echo hi\n") } });
    const ext = new ExternalDoc(host, "/x/deploy.sh");
    await ext.ensureLoaded();
    type(ext, "echo more\n");
    await vi.advanceTimersByTimeAsync(1000);
    const memo = await importExternal(ext, host);
    expect(memo.info).toMatchObject({ file: "deploy.sh", autoTitle: false });
    expect(memo.state!.doc.toString()).toBe("echo hi\necho more\n");
    expect(backend.memoText(memo.info.id)).toBe("echo hi\necho more\n");
    expect(backend.fileText("/x/deploy.sh")).toBe("echo hi\n");
    expect(backend.data.drafts["/x/deploy.sh"]).toBeUndefined();
  });
});
