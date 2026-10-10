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
import fakeRegistry from "../backend/fake-registry.json";
import { BackendError, type ExtensionRegistry } from "../backend/types";
import { splitName } from "../core/names";
import { WriteScheduler } from "../core/scheduler";
import {
  DRAFT_RESTORED_NOTICE,
  ExternalDoc,
  importExternal,
  LONG_LINE_LIMIT,
  MemoDoc,
  RECOVERED_NOTICE,
  type Change,
  type Doc,
  type DocHost,
} from "./docs";

const fakeLanguages = (fakeRegistry as ExtensionRegistry).languages;

function setup(seed: Partial<FakeData> = {}) {
  const backend = new FakeBackend(memoryStorage(JSON.stringify({ ...defaultFakeData(), ...seed })));
  const changes: Change[] = [];
  const host: DocHost = {
    backend,
    writes: new WriteScheduler((_key, error) => {
      throw error;
    }),
    extensions: () => [],
    languageConfig: async () => ({}),
    languageOf: () => undefined,
    languages: () => fakeLanguages,
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
  it("recovers under untitled.md when neither its own name nor untitled.<ext> can be made", async () => {
    // A file Finder named `a.b?` has the extension `b?`, which tote cannot write; the third
    // candidate is the only one left.
    const { backend, host } = setup({ memos: { a: fakeMemo("a.b?", "원래") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    delete backend.data.memos.a;
    type(doc, " 추가");
    await vi.runAllTimersAsync();
    expect(doc.info.file).toBe("untitled.md");
    expect(backend.memoText(doc.info.id)).toBe("원래 추가");
    expect(doc.notice).toBe(RECOVERED_NOTICE);
  });

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
    // Over a million characters in lines of 999: one line that long would be a long-line file.
    const text = `${"x".repeat(999)}\n`.repeat(1001);
    const { backend, host } = setup({ memos: { big: fakeMemo("big.md", text) } });
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
    expect(doc.info.file).toBe("a.md");
    expect(doc.info.autoTitle).toBe(false);

    // A script keeps its own name and extension instead of becoming untitled.md.
    const script = setup({ memos: { s: fakeMemo("deploy.sh", "#!/bin/bash") } });
    const other = new MemoDoc(script.host, (await script.backend.listMemos())[0]);
    await other.ensureLoaded();
    delete script.backend.data.memos.s;
    type(other, "\necho hi");
    await vi.runAllTimersAsync();
    expect(other.info.file).toBe("deploy.sh");
    expect(script.backend.memoText(other.info.id)).toBe("#!/bin/bash\necho hi");

    // A name tote cannot create (made in Finder) falls back to untitled.
    const odd = setup({ memos: { q: fakeMemo("할 일?.md", "원래") } });
    const third = new MemoDoc(odd.host, (await odd.backend.listMemos())[0]);
    await third.ensureLoaded();
    delete odd.backend.data.memos.q;
    type(third, " 추가");
    await vi.runAllTimersAsync();
    expect(third.info.file).toBe("untitled.md");
    expect(odd.backend.memoText(third.info.id)).toBe("원래 추가");
    expect(third.notice).toBe(RECOVERED_NOTICE);
    expect(Object.keys(odd.backend.data.memos)).toEqual([third.info.id]);
  });

  it("closing writes the text typed after a failed save once the disk is back", async () => {
    const { backend, host } = setup({ memos: { a: fakeMemo("장보기.md", "# 장보기\n우유") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    const write = backend.writeMemo.bind(backend);
    let broken = true;
    vi.spyOn(backend, "writeMemo").mockImplementation((id, bytes) =>
      broken ? Promise.reject(new Error("locked")) : write(id, bytes),
    );
    type(doc, "\n계란");
    await vi.advanceTimersByTimeAsync(500);
    expect(doc.error).toBeInstanceOf(Error);
    expect(backend.memoText("a")).toBe("# 장보기\n우유");
    broken = false;
    expect(await doc.close()).toBe(true);
    expect(backend.memoText("a")).toBe("# 장보기\n우유\n계란");
    expect(doc.error).toBeNull();
  });

  it("closing keeps the tab while the save keeps failing", async () => {
    const { backend, host } = setup({ memos: { a: fakeMemo("장보기.md", "우유") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    vi.spyOn(backend, "writeMemo").mockRejectedValue(new Error("locked"));
    type(doc, "\n계란");
    await vi.advanceTimersByTimeAsync(500);
    expect(await doc.close()).toBe(false);
    expect(doc.error).toBeInstanceOf(Error);
    expect(backend.memoText("a")).toBe("우유");
  });

  it("a window close or quit writes the text typed after a failed save", async () => {
    const { backend, host } = setup({ memos: { a: fakeMemo("장보기.md", "우유") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    const write = backend.writeMemo.bind(backend);
    let broken = true;
    vi.spyOn(backend, "writeMemo").mockImplementation((id, bytes) =>
      broken ? Promise.reject(new Error("locked")) : write(id, bytes),
    );
    type(doc, "\n계란");
    await vi.advanceTimersByTimeAsync(500);
    broken = false;
    await doc.flush();
    expect(backend.memoText("a")).toBe("우유\n계란");
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

  it("a text file with a line over the long-line limit does not load into the editor", async () => {
    const { backend, host } = setup({
      memos: { a: fakeMemo("one-line.json", "x".repeat(LONG_LINE_LIMIT + 1)) },
    });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    expect(doc.problem).toBe("long-line");
    expect(doc.state).toBeNull();
  });

  it("restores the session's selection, pulled into the text", async () => {
    const { backend, host } = setup({ memos: { a: fakeMemo("a.md", "abc") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    doc.restoreSelection = { ranges: [{ anchor: 2, head: 99 }], main: 0 };
    await doc.ensureLoaded();
    const { anchor, head } = doc.state!.selection.main;
    expect([anchor, head]).toEqual([2, 3]);
  });

  it("moves a .md memo without a language to the language its first line names, once", async () => {
    const { backend, host } = setup();
    const doc = new MemoDoc(host, await backend.createMemo());
    doc.startEmpty();
    type(doc, "#!/bin/sh");
    await vi.runAllTimersAsync();
    expect(doc.info.file).toBe("untitled.md");
    // Leaving line 1 detects; the title waits for the cursor to leave the title line (line 2).
    type(doc, "\necho hi");
    await vi.runAllTimersAsync();
    expect(doc.info.file).toBe("untitled.sh");
    expect(doc.info.language).toBe("shellscript");
    expect(backend.data.memos[doc.info.id].language).toBe("shellscript");
    // Never back: the first line changes, the language stays.
    type(doc, "# just a note", 0);
    await doc.leave();
    expect(doc.info.file).toBe("just a note#! bin sh.sh");
    expect(doc.info.language).toBe("shellscript");
  });

  it("detects on leave even when the cursor never left line 1", async () => {
    const { backend, host } = setup();
    const doc = new MemoDoc(host, await backend.createMemo());
    doc.startEmpty();
    type(doc, '{"a": 1}');
    await doc.leave();
    expect(doc.info).toMatchObject({ file: "{ a 1}.json", language: "json" });
  });

  it("does not detect for a memo that already has a language or is not .md", async () => {
    const { backend, host } = setup({
      memos: {
        a: fakeMemo("a.md", "#!/bin/sh"),
        b: fakeMemo("b.txt", "#!/bin/sh"),
      },
    });
    backend.data.memos.a.language = "markdown";
    const a = new MemoDoc(
      host,
      (await backend.listMemos()).find((m) => m.id === "a")!,
    );
    const b = new MemoDoc(
      host,
      (await backend.listMemos()).find((m) => m.id === "b")!,
    );
    await a.ensureLoaded();
    await b.ensureLoaded();
    await a.leave();
    await b.leave();
    expect(a.info.file).toBe("a.md");
    expect(b.info.file).toBe("b.txt");
  });

  it("a rename to another extension drops the picked language and reloads the language data", async () => {
    const { backend, host } = setup();
    // The controller's rule: the picked language, else the file name's. The data names its language.
    host.languageOf = (doc) =>
      fakeLanguages.find((l) =>
        doc.language
          ? l.id === doc.language
          : l.extensions.includes(splitName(doc.fileName).ext.toLowerCase()),
      );
    host.languageConfig = async (lang) => ({ wordChars: lang?.id ?? "" });
    const doc = new MemoDoc(host, await backend.createMemo());
    doc.startEmpty();
    await doc.changeLanguage(fakeLanguages.find((l) => l.id === "python")!);
    await doc.rename("script.PY");
    expect(doc.language).toBe("python");
    await doc.rename("script.sh");
    await vi.runAllTimersAsync();
    expect(doc.language).toBeNull();
    expect(backend.data.memos[doc.info.id].language).toBeUndefined();
    expect(doc.languageData).toEqual({ wordChars: "shellscript" });
  });

  it("does not move a memo the person named, even one named .md", async () => {
    const { backend, host } = setup();
    const doc = new MemoDoc(host, await backend.createMemo());
    doc.startEmpty();
    type(doc, "#!/bin/sh");
    await doc.rename("notes.md");
    type(doc, "\necho hi");
    await doc.leave();
    expect(doc.info).toMatchObject({ file: "notes.md", autoTitle: false });
    expect(doc.info.language).toBeUndefined();
  });

  it("keeps the language data of the latest change when the answers cross", async () => {
    const { host } = setup({ files: { "/x/a.txt": fakeFile("x") } });
    const answers: (() => void)[] = [];
    host.languageOf = (doc) => fakeLanguages.find((l) => l.id === doc.language);
    host.languageConfig = (lang) =>
      lang
        ? new Promise((resolve) => answers.push(() => resolve({ wordChars: lang.id })))
        : Promise.resolve({});
    const doc = new ExternalDoc(host, "/x/a.txt");
    await doc.ensureLoaded();
    const first = doc.changeLanguage(fakeLanguages.find((l) => l.id === "python")!);
    const second = doc.changeLanguage(fakeLanguages.find((l) => l.id === "sql")!);
    answers[1]();
    answers[0]();
    await Promise.all([first, second]);
    expect(doc.languageData).toEqual({ wordChars: "sql" });
  });

  it("changeLanguage renames a memo and records the language; an external file only remembers it", async () => {
    const { backend, host, changes } = setup({ files: { "/x/a.txt": fakeFile("x") } });
    const memo = new MemoDoc(host, await backend.createMemo());
    memo.startEmpty();
    await memo.changeLanguage(fakeLanguages.find((l) => l.id === "python")!);
    expect(memo.info.file).toBe("untitled.py");
    expect(memo.language).toBe("python");
    expect(changes).toContain("language");
    const ext = new ExternalDoc(host, "/x/a.txt");
    await ext.ensureLoaded();
    await ext.changeLanguage(fakeLanguages.find((l) => l.id === "python")!);
    expect(ext.language).toBe("python");
    expect(backend.data.files["/x/a.txt"]).toBe(fakeFile("x"));
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

    // The base was re-anchored on the disk: editing again and restarting is not "disk changed".
    type(doc, "!");
    await vi.advanceTimersByTimeAsync(1000);
    const restarted = setup({ ...backend.data });
    const again = new ExternalDoc(restarted.host, "/x/a.sh");
    await again.ensureLoaded();
    expect(again.state!.doc.toString()).toBe("saved!");
    expect(again.notice).toBeNull();
  });

  it("a_failing_draft_cleanup_still_opens_the_draft", async () => {
    const { backend, host } = setup({
      files: { "/x/a.sh": fakeFile("saved") },
      drafts: { "/x/a.sh": { base: fakeFile("old"), data: fakeFile("saved") } },
    });
    backend.discardExternalDraft = async () => {
      throw new Error("disk is read-only");
    };
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    expect(doc.problem).toBeNull();
    expect(doc.state!.doc.toString()).toBe("saved");
    expect(doc.dirty).toBe(true);
  });

  it("a draft that failed to be kept is kept again when the window closes", async () => {
    const { backend, host } = setup({ files: { "/x/a.sh": fakeFile("echo hi\n") } });
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    const keep = backend.keepExternalDraft.bind(backend);
    let broken = true;
    vi.spyOn(backend, "keepExternalDraft").mockImplementation((path, bytes) =>
      broken ? Promise.reject(new Error("no space")) : keep(path, bytes),
    );
    type(doc, "# 수정");
    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.data.drafts["/x/a.sh"]).toBeUndefined();
    broken = false;
    await doc.leave();
    expect(backend.data.drafts["/x/a.sh"]).toBeDefined();
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

  it("carries the language picked for the file over to the memo", async () => {
    const { backend, host } = setup({ files: { "/x/notes": fakeFile("select 1") } });
    const ext = new ExternalDoc(host, "/x/notes");
    await ext.ensureLoaded();
    await ext.changeLanguage(fakeLanguages.find((l) => l.id === "sql")!);
    const memo = await importExternal(ext, host);
    expect(memo.info).toMatchObject({ file: "notes.sql", language: "sql", autoTitle: false });
    expect(memo.language).toBe("sql");
    expect(backend.data.memos[memo.info.id].language).toBe("sql");
    expect(backend.memoText(memo.info.id)).toBe("select 1");
  });

  it("stands when the language cannot be carried over, and says why", async () => {
    const { backend, host } = setup({ files: { "/x/notes": fakeFile("select 1") } });
    const ext = new ExternalDoc(host, "/x/notes");
    await ext.ensureLoaded();
    await ext.changeLanguage(fakeLanguages.find((l) => l.id === "sql")!);
    backend.setMemoLanguage = async () => {
      throw new BackendError("io", "disk full");
    };
    const memo = await importExternal(ext, host);
    expect(memo.info.file).toBe("notes");
    expect(memo.error).toBeInstanceOf(BackendError);
    expect(backend.memoText(memo.info.id)).toBe("select 1");
    expect(backend.data.drafts["/x/notes"]).toBeUndefined();
  });
});
