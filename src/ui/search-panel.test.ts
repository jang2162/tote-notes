import { describe, expect, it } from "vitest";

import type { SearchEvent, SearchMatch } from "../backend/types";
import { countOf, groupKey, SEARCHING, statusOf } from "./search-panel";

const match = (line: number): SearchMatch => ({
  line,
  column: 0,
  text: "foo",
  before: [],
  after: [],
});

const file = (memoId: string, lines: number[]): SearchEvent => ({
  kind: "file",
  memoId,
  file: `${memoId}.md`,
  matches: lines.map(match),
});

describe("countOf", () => {
  it("countOf sums files and matches and keeps the truncated flag", () => {
    const events: SearchEvent[] = [
      file("a", [0, 3]),
      file("b", [1]),
      { kind: "done", filesSearched: 5, truncated: true, cancelled: false },
    ];
    expect(countOf(events)).toEqual({ files: 2, matches: 3, truncated: true });
    expect(countOf(events.slice(0, 2))).toEqual({ files: 2, matches: 3, truncated: false });
    expect(groupKey(events[0] as Extract<SearchEvent, { kind: "file" }>)).toBe("a");
  });
});

describe("statusOf", () => {
  it("a done event with cancelled true leaves the status alone", () => {
    const events: SearchEvent[] = [
      file("a", [0]),
      { kind: "done", filesSearched: 1, truncated: false, cancelled: true },
    ];
    expect(statusOf(events, SEARCHING)).toBe(SEARCHING);
    expect(statusOf(events, "")).toBe("");
    const finished: SearchEvent[] = [
      file("a", [0]),
      { kind: "done", filesSearched: 1, truncated: false, cancelled: false },
    ];
    expect(statusOf(finished, SEARCHING)).toBe("1개 파일에서 1개");
  });
});
