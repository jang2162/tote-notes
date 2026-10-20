import { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import { describe, expect, it } from "vitest";
import { COUNT_LIMIT, countLabel, countMatches } from "./search-count";

function state(doc: string, from = 0, to = from): EditorState {
  return EditorState.create({ doc, selection: { anchor: from, head: to } });
}

describe("countMatches", () => {
  it("ignores case by default and honours caseSensitive", () => {
    const s = state("my my My");
    expect(countMatches(s, new SearchQuery({ search: "my" })).total).toBe(3);
    expect(countMatches(s, new SearchQuery({ search: "my", caseSensitive: true })).total).toBe(2);
  });

  it("numbers the match equal to the main selection, null for a bare cursor", () => {
    const query = new SearchQuery({ search: "my" });
    expect(countMatches(state("my my My", 3, 5), query).current).toBe(2);
    expect(countMatches(state("my my My", 3), query).current).toBeNull();
    expect(countMatches(state("my my My", 3, 4), query).current).toBeNull();
  });

  it("stops at the limit", () => {
    const doc = "a ".repeat(5000);
    const query = new SearchQuery({ search: "a" });
    expect(countMatches(state(doc, 0, 1), query)).toEqual({
      total: COUNT_LIMIT,
      capped: true,
      current: 1,
    });
    // The 4000th match starts at 2 * 3999.
    expect(countMatches(state(doc, 7998, 7999), query).current).toBeNull();
  });

  it("an empty-matching regexp still finishes", () => {
    const doc = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    for (const search of ["^", "a*"]) {
      const count = countMatches(state(doc), new SearchQuery({ search, regexp: true }));
      expect(count.total).toBeLessThanOrEqual(COUNT_LIMIT);
    }
  });
});

describe("countLabel", () => {
  const some = (total: number, current: number | null, capped = false) => ({
    total,
    capped,
    current,
  });

  it("formats each state", () => {
    expect(countLabel(new SearchQuery({ search: "" }), null)).toBe("");
    expect(countLabel(new SearchQuery({ search: "(", regexp: true }), null)).toBe("잘못된 정규식");
    const q = new SearchQuery({ search: "x" });
    expect(countLabel(q, some(0, null))).toBe("결과 없음");
    expect(countLabel(q, some(12, 3))).toBe("3 / 12");
    expect(countLabel(q, some(12, null))).toBe("– / 12");
    expect(countLabel(q, some(1000, 17, true))).toBe("17 / 1000+");
  });
});
