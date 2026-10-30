import { describe, expect, it } from "vitest";

import type { MemoInfo } from "../backend/types";
import { visibleRows } from "./memo-list";
import { filterMemos } from "./memo-order";

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

  it("counts rows of the preview's height", () => {
    // 460 / 46 = row 10 at the top, 8 spare above; 460 + 276 = 736 / 46 = 16, 8 spare below.
    expect(visibleRows(460, 276, 10_000, 46)).toEqual([2, 24]);
    expect(visibleRows(460, 276, 10_000, 28)).toEqual([8, 35]);
  });
});
