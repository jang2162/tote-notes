import { describe, expect, it } from "vitest";

import type { MemoInfo } from "../backend/types";
import { sortMemos, splitPinned } from "./memo-order";

const memo = (file: string, extra: Partial<MemoInfo> = {}): MemoInfo => ({
  id: file,
  file,
  autoTitle: false,
  modifiedMs: 0,
  size: 0,
  kind: "text",
  ...extra,
});

describe("splitPinned", () => {
  it("keeps each side in the order given", () => {
    const list = [memo("a"), memo("b", { pinned: true }), memo("c"), memo("d", { pinned: true })];
    const { pinned, rest } = splitPinned(list);
    expect(pinned.map((m) => m.file)).toEqual(["b", "d"]);
    expect(rest.map((m) => m.file)).toEqual(["a", "c"]);
  });

  it("leaves a pinned memo out of the rest", () => {
    const { rest } = splitPinned([memo("a", { pinned: true })]);
    expect(rest).toEqual([]);
  });
});

const files = (list: MemoInfo[]) => list.map((m) => m.file);

describe("sortMemos", () => {
  // Modified 1·2·3, viewed in another order: b first, then c; a never.
  const list = [
    memo("a.md", { modifiedMs: 3 }),
    memo("b.md", { modifiedMs: 1, viewedMs: 10 }),
    memo("c.md", { modifiedMs: 2, viewedMs: 5 }),
  ];

  it("orders by modified time, newest or oldest first", () => {
    expect(files(sortMemos(list, "modified-desc"))).toEqual(["a.md", "c.md", "b.md"]);
    expect(files(sortMemos(list, "modified-asc"))).toEqual(["b.md", "c.md", "a.md"]);
  });

  it("orders by viewed time, a memo never viewed counting its modified time", () => {
    expect(files(sortMemos(list, "viewed-desc"))).toEqual(["b.md", "c.md", "a.md"]);
    expect(files(sortMemos(list, "viewed-asc"))).toEqual(["a.md", "c.md", "b.md"]);
  });

  it("breaks ties of the time orders by name", () => {
    const tied = [memo("b.md", { modifiedMs: 1 }), memo("a.md", { modifiedMs: 1 })];
    for (const sort of ["modified-desc", "modified-asc", "viewed-desc", "viewed-asc"] as const)
      expect(files(sortMemos(tied, sort))).toEqual(["a.md", "b.md"]);
  });

  it("counts numbers in names by size", () => {
    const named = [memo("메모 10.md"), memo("메모 2.md"), memo("메모 1.md")];
    expect(files(sortMemos(named, "name-asc"))).toEqual(["메모 1.md", "메모 2.md", "메모 10.md"]);
  });

  it("ignores case and breaks a case-only tie by code point", () => {
    const named = [memo("b.md"), memo("a.md"), memo("A.md")];
    expect(files(sortMemos(named, "name-asc"))).toEqual(["A.md", "a.md", "b.md"]);
  });

  it("compares decomposed Hangul as composed", () => {
    const nfd = "나.md".normalize("NFD");
    const named = [memo("다.md"), memo(nfd), memo("가.md")];
    expect(files(sortMemos(named, "name-asc"))).toEqual(["가.md", nfd, "다.md"]);
  });

  it("puts name-desc in the reverse of name-asc", () => {
    const named = [memo("b.md"), memo("a.md"), memo("A.md"), memo("메모 10.md"), memo("메모 2.md")];
    expect(files(sortMemos(named, "name-desc"))).toEqual(
      files(sortMemos(named, "name-asc")).reverse(),
    );
  });
});
