import { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import { describe, expect, it } from "vitest";
import {
  COUNT_BUDGET_MS,
  COUNT_LIMIT,
  countLabel,
  countMatches,
  currentMatch,
  findMatches,
} from "./search-count";

function state(doc: string, from = 0, to = from): EditorState {
  return EditorState.create({ doc, selection: { anchor: from, head: to } });
}

/** A clock that never moves: tests of what a count finds must not stop early on a slow machine. */
const still = () => 0;

function count(s: EditorState, query: SearchQuery) {
  return countMatches(s, query, COUNT_LIMIT, COUNT_BUDGET_MS, still);
}

function find(s: EditorState, query: SearchQuery) {
  return findMatches(s, query, COUNT_LIMIT, COUNT_BUDGET_MS, still);
}

describe("countMatches", () => {
  it("ignores case by default and honours caseSensitive", () => {
    const s = state("my my My");
    expect(count(s, new SearchQuery({ search: "my" })).total).toBe(3);
    expect(count(s, new SearchQuery({ search: "my", caseSensitive: true })).total).toBe(2);
  });

  it("numbers the match equal to the main selection, null for a bare cursor", () => {
    const query = new SearchQuery({ search: "my" });
    expect(count(state("my my My", 3, 5), query).current).toBe(2);
    expect(count(state("my my My", 3), query).current).toBeNull();
    expect(count(state("my my My", 3, 4), query).current).toBeNull();
  });

  it("stops at the limit", () => {
    const doc = "a ".repeat(5000);
    const query = new SearchQuery({ search: "a" });
    expect(count(state(doc, 0, 1), query)).toEqual({
      total: COUNT_LIMIT,
      capped: true,
      current: 1,
    });
    // The 4000th match starts at 2 * 3999.
    expect(count(state(doc, 7998, 7999), query).current).toBeNull();
  });

  it("is not capped at exactly the limit, and numbers the match that is the last one counted", () => {
    const doc = "a ".repeat(COUNT_LIMIT);
    const query = new SearchQuery({ search: "a" });
    expect(count(state(doc), query)).toEqual({
      total: COUNT_LIMIT,
      capped: false,
      current: null,
    });
    const last = 2 * (COUNT_LIMIT - 1);
    expect(count(state(doc, last, last + 1), query)).toEqual({
      total: COUNT_LIMIT,
      capped: false,
      current: COUNT_LIMIT,
    });
  });

  it("an empty-matching regexp still finishes", () => {
    const doc = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    // One empty match at each of the 100 line starts; `a*` matches empty at every position.
    expect(count(state(doc), new SearchQuery({ search: "^", regexp: true }))).toMatchObject({
      total: 100,
      capped: false,
    });
    const every = count(state(doc), new SearchQuery({ search: "a*", regexp: true }));
    expect(every.total).toBeLessThanOrEqual(COUNT_LIMIT);
  });

  it("numbers an empty match under the cursor as the current one", () => {
    // Line starts are 0, 2 and 4: the cursor on the second line start is the second match.
    expect(count(state("a\nb\nc", 2), new SearchQuery({ search: "^", regexp: true }))).toEqual({
      total: 3,
      capped: false,
      current: 2,
    });
  });
});

describe("findMatches", () => {
  /** Every match of `query` in one cursor over the whole text, the way CodeMirror itself steps. */
  function plain(s: EditorState, query: SearchQuery): number[] {
    const starts: number[] = [];
    const cursor = query.getCursor(s);
    for (let next = cursor.next(); !next.done; next = cursor.next()) starts.push(next.value.from);
    return starts;
  }

  // Over 200K characters, so the text is searched in several pieces.
  const long = Array.from({ length: 6000 }, (_, i) => `line ${i} has my-word and MY word`).join(
    "\n",
  );

  it("finds what one cursor over the whole text finds", () => {
    const s = state(long);
    for (const query of [
      new SearchQuery({ search: "word" }),
      new SearchQuery({ search: "my", wholeWord: true }),
      new SearchQuery({ search: "^line 5", regexp: true }),
      new SearchQuery({ search: "\\d+$", regexp: true }),
      new SearchQuery({ search: "word\\nline", regexp: true }),
      new SearchQuery({ search: "word\\nline 59" }),
    ]) {
      const found = findMatches(s, query, Infinity, Infinity);
      expect(found.from, query.search).toEqual(plain(s, query));
      expect(found.capped).toBe(false);
    }
  });

  it("stops once the count has taken its time, keeping what it found", () => {
    // The clock reads 0 when the count starts and past the budget at every later look.
    const late = () => {
      let started = false;
      return () => (started ? COUNT_BUDGET_MS + 1 : ((started = true), 0));
    };
    const query = new SearchQuery({ search: "a" });
    expect(
      countMatches(state("a a a a", 2, 3), query, COUNT_LIMIT, COUNT_BUDGET_MS, late()),
    ).toEqual({ total: 1, capped: true, current: null });
    expect(
      countMatches(state("a a a a", 0, 1), query, COUNT_LIMIT, COUNT_BUDGET_MS, late()),
    ).toEqual({ total: 1, capped: true, current: 1 });
    // A text with no match early on is cut too, not scanned to its end in one go.
    const sparse = state(`${"x".repeat(100).concat("\n").repeat(2000)}needle`);
    expect(
      countMatches(
        sparse,
        new SearchQuery({ search: "needle" }),
        COUNT_LIMIT,
        COUNT_BUDGET_MS,
        late(),
      ),
    ).toEqual({ total: 0, capped: true, current: null });
    expect(
      countMatches(
        sparse,
        new SearchQuery({ search: "needle" }),
        COUNT_LIMIT,
        COUNT_BUDGET_MS,
        still,
      ),
    ).toEqual({ total: 1, capped: false, current: null });
  });

  it("a count stopped by time resumes to the exact total", () => {
    const s = state(long);
    /** A clock that moves `step` at every look: a count stops after a few looks, on each go. */
    const ticking = (step: number) => {
      let time = 0;
      return () => (time += step);
    };
    for (const query of [
      new SearchQuery({ search: "line 59" }),
      new SearchQuery({ search: "my", wholeWord: true }),
      new SearchQuery({ search: "word" }),
      new SearchQuery({ search: "^line 5", regexp: true }),
      new SearchQuery({ search: "word$", regexp: true }),
      // Empty matches, also right where a match ends: none is counted twice or missed.
      new SearchQuery({ search: "a*", regexp: true }),
      new SearchQuery({ search: "^", regexp: true }),
      new SearchQuery({ search: "\\s*", regexp: true }),
      // Over a line end: searched in one piece, so resumed where the last match ends.
      new SearchQuery({ search: "word\\nline 5\\d\\b", regexp: true }),
      new SearchQuery({ search: "word\\nline 59" }),
    ])
      for (const step of [7, 11, 16]) {
        const what = `${query.search} every ${step}ms`;
        const stopped = findMatches(s, query, COUNT_LIMIT, COUNT_BUDGET_MS, still);
        const now = ticking(step);
        let found = findMatches(s, query, COUNT_LIMIT, COUNT_BUDGET_MS, now);
        expect(found.resume, what).not.toBeNull();
        expect(found.capped, what).toBe(true);
        // Each go finds one match at least, so a count that does not end is one that goes nowhere.
        for (let goes = 0; found.resume !== null; goes++) {
          expect(goes, what).toBeLessThan(COUNT_LIMIT);
          found = findMatches(s, query, COUNT_LIMIT, COUNT_BUDGET_MS, now, found);
        }
        expect(found.from, what).toEqual(stopped.from);
        expect(found.to, what).toEqual(stopped.to);
        expect(found.capped, what).toBe(stopped.capped);
      }
    // Stopped between two pieces with nothing found yet, it goes on from the next piece.
    const sparse = state(`${"x".repeat(100).concat("\n").repeat(2000)}needle`);
    const needle = new SearchQuery({ search: "needle" });
    const nothing = findMatches(sparse, needle, COUNT_LIMIT, COUNT_BUDGET_MS, ticking(16));
    expect(nothing).toMatchObject({ from: [], capped: true, resume: expect.any(Number) });
    let found = nothing;
    while (found.resume !== null)
      found = findMatches(sparse, needle, COUNT_LIMIT, COUNT_BUDGET_MS, ticking(16), found);
    expect(found).toEqual({ from: [202000], to: [202006], capped: false, resume: null });
    // Stopped on an empty match at the very end, nothing is left to resume.
    const late = () => {
      let started = false;
      return () => (started ? COUNT_BUDGET_MS + 1 : ((started = true), 0));
    };
    const empty = new SearchQuery({ search: "x*", regexp: true });
    found = findMatches(state("a"), empty, COUNT_LIMIT, COUNT_BUDGET_MS, late());
    expect(found).toEqual({ from: [0], to: [0], capped: true, resume: 1 });
    found = findMatches(state("a"), empty, COUNT_LIMIT, COUNT_BUDGET_MS, late(), found);
    expect(found).toEqual({ from: [0, 1], to: [0, 1], capped: false, resume: null });
  });

  it("leaves nothing to resume once the count ends or reaches the limit", () => {
    const query = new SearchQuery({ search: "a" });
    expect(find(state("a a a"), query)).toEqual({
      from: [0, 2, 4],
      to: [1, 3, 5],
      capped: false,
      resume: null,
    });
    const many = find(state("a ".repeat(5000)), query);
    expect(many.from.length).toBe(COUNT_LIMIT);
    expect(many.capped).toBe(true);
    expect(many.resume).toBeNull();
    // Stopped by time on its 1000th match, the count goes on only to see there are more.
    let looks = 0;
    const s = state("a ".repeat(COUNT_LIMIT + 1));
    const first = findMatches(s, query, COUNT_LIMIT, COUNT_BUDGET_MS, () =>
      ++looks > COUNT_LIMIT ? COUNT_BUDGET_MS + 1 : 0,
    );
    expect(first.from.length).toBe(COUNT_LIMIT);
    expect(first.resume).not.toBeNull();
    const resumed = findMatches(s, query, COUNT_LIMIT, COUNT_BUDGET_MS, still, first);
    expect(resumed.from.length).toBe(COUNT_LIMIT);
    expect(resumed.capped).toBe(true);
    expect(resumed.resume).toBeNull();
  });
});

describe("currentMatch", () => {
  it("finds the selection among the matches", () => {
    const found = find(state(long()), new SearchQuery({ search: "ab" }));
    expect(found.from.length).toBe(500);
    expect(currentMatch(found, { from: 0, to: 2 })).toBe(1);
    expect(currentMatch(found, { from: 3 * 237, to: 3 * 237 + 2 })).toBe(238);
    expect(currentMatch(found, { from: 3 * 499, to: 3 * 499 + 2 })).toBe(500);
    expect(currentMatch(found, { from: 3 * 237, to: 3 * 237 + 1 })).toBeNull();
    expect(currentMatch(found, { from: 1, to: 3 })).toBeNull();
    expect(currentMatch(found, { from: 3 * 500, to: 3 * 500 })).toBeNull();
  });

  function long() {
    return "ab ".repeat(500);
  }
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
    // Cut by the time budget: at least this many, however few.
    expect(countLabel(q, some(4, null, true))).toBe("– / 4+");
    expect(countLabel(q, some(0, null, true))).toBe("– / 0+");
  });
});
