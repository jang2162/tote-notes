import { describe, expect, it } from "vitest";

import type { MemoInfo } from "../backend/types";
import { filterMemos, visibleRows } from "./memo-list";

const memo = (file: string, modifiedMs = 0): MemoInfo => ({
  id: file,
  file,
  autoTitle: false,
  modifiedMs,
  size: 0,
  kind: "text",
});

describe("filterMemos", () => {
  it("matches decomposed Hangul from Finder against composed input", () => {
    const nfd = memo("한글 메모.md".normalize("NFD"));
    expect(filterMemos([nfd, memo("다른.md")], "한글")).toEqual([nfd]);
  });

  it("ignores case and keeps everything for an empty query", () => {
    const list = [memo("README.md"), memo("todo.txt")];
    expect(filterMemos(list, "readme")).toEqual([list[0]]);
    expect(filterMemos(list, "  ")).toEqual(list);
  });
});

describe("visibleRows", () => {
  it("renders the rows in view plus some to spare", () => {
    expect(visibleRows(0, 280, 10_000)).toEqual([0, 18]);
    expect(visibleRows(2800, 280, 10_000)).toEqual([92, 118]);
    expect(visibleRows(0, 280, 5)).toEqual([0, 5]);
  });
});
