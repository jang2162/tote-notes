import { describe, expect, it } from "vitest";

import table from "../../src-tauri/tests/fixtures/shortcut-table.json";
import type { MemoInfo, ShortcutTable } from "../backend/types";
import { conflict } from "../shortcuts/keys";
import {
  commandItems,
  fuzzyMatch,
  MAX_RESULTS,
  rankCommands,
  rankFiles,
  QUICK_OPEN_COMMAND,
} from "./quick-open-match";

const memo = (file: string, times: { modifiedMs?: number; viewedMs?: number } = {}): MemoInfo => ({
  id: file,
  file,
  autoTitle: false,
  modifiedMs: times.modifiedMs ?? 0,
  size: 0,
  kind: "text",
  ...(times.viewedMs !== undefined ? { viewedMs: times.viewedMs } : {}),
});

const names = (ranked: { name: string }[]) => ranked.map((each) => each.name);

describe("fuzzyMatch", () => {
  it("matches the letters in order, wherever they are", () => {
    expect(fuzzyMatch("mtg", "meeting notes.md")).not.toBeNull();
    expect(fuzzyMatch("tsg", "meeting notes.md")).toBeNull();
    expect(fuzzyMatch("xyz", "meeting notes.md")).toBeNull();
  });

  it("ignores case both ways", () => {
    expect(fuzzyMatch("README", "readme.md")?.indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fuzzyMatch("todo", "TODO.txt")?.indices).toEqual([0, 1, 2, 3]);
  });

  it("matches decomposed Hangul from Finder against composed input, and the other way", () => {
    const nfd = "회의록.md".normalize("NFD");
    expect(nfd).not.toBe("회의록.md");
    expect(fuzzyMatch("회의", nfd)?.indices).toEqual([0, 1]);
    expect(fuzzyMatch("회의".normalize("NFD"), "회의록.md")?.indices).toEqual([0, 1]);
  });

  it("leaves the spaces typed out", () => {
    expect(fuzzyMatch("회의 메모", "회의메모.md")).not.toBeNull();
    expect(fuzzyMatch("회의 메모", "회의 메모.md")?.indices).toEqual([0, 1, 3, 4]);
    expect(fuzzyMatch("  ", "아무거나.md")).toEqual({ score: 0, indices: [] });
  });

  it("counts by characters of the composed name, which is what a row shows", () => {
    // An astral character before the match: indices are code points, not UTF-16 units.
    expect(fuzzyMatch("b", "😀b.md")?.indices).toEqual([1]);
  });

  it("scores a run of letters above the same letters apart", () => {
    const run = fuzzyMatch("note", "notes.md")!;
    const apart = fuzzyMatch("note", "n-o-t-e.md")!;
    expect(run.score).toBeGreaterThan(apart.score);
  });

  it("scores the heads of words above letters inside them", () => {
    const heads = fuzzyMatch("mn", "meeting notes.md")!;
    const inside = fuzzyMatch("mn", "commune.md")!;
    expect(heads.score).toBeGreaterThan(inside.score);
  });

  it("takes the best place for a letter found more than once", () => {
    // The first 「n」 is inside 「meeting」; the head of 「notes」 scores more.
    expect(fuzzyMatch("mn", "meeting notes.md")?.indices).toEqual([0, 8]);
  });
});

describe("rankFiles", () => {
  it("puts the better match first", () => {
    const memos = [memo("commune.md"), memo("meeting notes.md")];
    expect(names(rankFiles(memos, [], "mn"))).toEqual(["meeting notes.md", "commune.md"]);
  });

  it("breaks a tie by the time last viewed, then by name", () => {
    const memos = [
      memo("b 메모.md", { viewedMs: 5 }),
      memo("a 메모.md", { viewedMs: 5 }),
      memo("c 메모.md", { viewedMs: 9 }),
      // Never viewed: counts as viewed when it was last modified, as the memo list's sort does.
      memo("d 메모.md", { modifiedMs: 7 }),
    ];
    expect(names(rankFiles(memos, [], "메모"))).toEqual([
      "c 메모.md",
      "d 메모.md",
      "a 메모.md",
      "b 메모.md",
    ]);
  });

  it("with nothing typed, lists the memos most recently viewed first, then the open files", () => {
    const memos = [
      memo("오래된.md", { modifiedMs: 1 }),
      memo("방금.md", { viewedMs: 50 }),
      memo("어제.md", { viewedMs: 20, modifiedMs: 40 }),
      memo("수정만.md", { modifiedMs: 30 }),
    ];
    const ranked = rankFiles(memos, ["/x/z.sh", "/x/a.sh"], "");
    expect(names(ranked)).toEqual(["방금.md", "수정만.md", "어제.md", "오래된.md", "a.sh", "z.sh"]);
    expect(ranked.every((each) => each.indices.length === 0)).toBe(true);
  });

  it("keeps the open files after the most recent memos when there are many", () => {
    const memos = Array.from({ length: 80 }, (_, i) => memo(`메모 ${i}.md`, { viewedMs: i }));
    const ranked = rankFiles(memos, ["/x/a.sh"], "");
    expect(ranked).toHaveLength(MAX_RESULTS + 1);
    expect(ranked[0].name).toBe("메모 79.md");
    expect(ranked.at(-1)).toMatchObject({ kind: "external", path: "/x/a.sh", name: "a.sh" });
  });

  it("matches an open file by the last part of its path and shows its folder", () => {
    const ranked = rankFiles([memo("deploy notes.md")], ["/srv/deploy/run.sh"], "run");
    expect(ranked).toEqual([
      {
        kind: "external",
        path: "/srv/deploy/run.sh",
        name: "run.sh",
        dir: "/srv/deploy",
        indices: [0, 1, 2],
        score: expect.any(Number),
      },
    ]);
  });

  it("shows a decomposed name composed", () => {
    const [found] = rankFiles([memo("한글 메모.md".normalize("NFD"))], [], "한");
    expect(found).toMatchObject({ kind: "memo", name: "한글 메모.md", indices: [0] });
    expect(found.kind === "memo" && found.id).toBe("한글 메모.md".normalize("NFD"));
  });

  it("gives at most MAX_RESULTS for a query", () => {
    const memos = Array.from({ length: 120 }, (_, i) => memo(`메모 ${i}.md`));
    expect(rankFiles(memos, [], "메모")).toHaveLength(MAX_RESULTS);
  });

  it("finds nothing when no name holds the letters", () => {
    expect(rankFiles([memo("장보기.md")], ["/x/a.sh"], "회의")).toEqual([]);
  });
});

describe("the command palette", () => {
  const shortcuts = table as ShortcutTable;

  it("lists the app commands of the shortcut table in menu order, without quick open itself", () => {
    const items = commandItems(shortcuts);
    expect(items.map((each) => each.id)).toEqual(
      shortcuts.commands.map((c) => c.id).filter((id) => id !== QUICK_OPEN_COMMAND),
    );
    expect(items.find((each) => each.id === "new-memo")).toMatchObject({
      label: "새 메모",
      menu: "파일",
      keys: "⌘N",
    });
    expect(items.find((each) => each.id === "rename")?.keys).toBeNull();
  });

  it("finds a command by its name, the best first; with nothing typed, all of them in order", () => {
    const items = commandItems(shortcuts);
    expect(rankCommands(items, "")).toEqual(
      items.map((item) => ({ ...item, indices: [], score: 0 })),
    );
    const found = rankCommands(items, "새창");
    expect(found[0]).toMatchObject({ id: "new-window", indices: [0, 2] });
    expect(rankCommands(items, "없는명령")).toEqual([]);
  });
});

describe("⌘P", () => {
  it("is no editor key, and no other shortcut has it", () => {
    const shortcuts = table as ShortcutTable;
    expect(conflict(shortcuts, QUICK_OPEN_COMMAND, "CmdOrCtrl+P")).toBeNull();
    expect(shortcuts.commands.find((c) => c.id === QUICK_OPEN_COMMAND)?.default).toBe(
      "CmdOrCtrl+P",
    );
  });
});
