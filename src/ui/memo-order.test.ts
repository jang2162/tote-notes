import { describe, expect, it } from "vitest";

import type { MemoInfo } from "../backend/types";
import { splitPinned } from "./memo-order";

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
