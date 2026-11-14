import { EditorSelection, EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAR_COUNT_DELAY_MS,
  CHAR_COUNT_LIMIT,
  CharCounter,
  charCountLabel,
  countChars,
  countGraphemes,
} from "./char-count";

const state = (doc: string, ranges?: [number, number][]) =>
  EditorState.create({
    doc,
    selection: ranges
      ? EditorSelection.create(ranges.map(([a, b]) => EditorSelection.range(a, b)))
      : undefined,
    extensions: EditorState.allowMultipleSelections.of(true),
  });

describe("countGraphemes", () => {
  it("counts what a person sees as one character as one", () => {
    expect(countGraphemes("abc def")).toBe(7);
    expect(countGraphemes("한글")).toBe(2);
    // A syllable being composed: a lone jamo, and one written as leading + vowel + trailing jamo.
    expect(countGraphemes("ㄱ")).toBe(1);
    expect(countGraphemes("각")).toBe(1);
    expect(countGraphemes("가가")).toBe(2);
    // Emoji: a skin tone, a ZWJ family, a flag.
    expect(countGraphemes("👍🏽")).toBe(1);
    expect(countGraphemes("👨‍👩‍👧")).toBe(1);
    expect(countGraphemes("🇰🇷")).toBe(1);
    expect(countGraphemes("é")).toBe(1);
    expect(countGraphemes("\t")).toBe(1);
  });
});

describe("countChars", () => {
  it("counts the document without its line breaks", () => {
    expect(countChars(state("가 나\n다\n\n👍🏽"))).toEqual({ selection: false, count: 5 });
    expect(countChars(state(""))).toEqual({ selection: false, count: 0 });
  });

  it("counts the selection instead when there is one, every range added up", () => {
    // 「가 나」 and 「👍🏽」 (two UTF-16 units each side of it), and a cursor that adds nothing.
    const doc = "가 나\n다\n👍🏽x";
    expect(
      countChars(
        state(doc, [
          [0, 3],
          [6, 10],
          [5, 5],
        ]),
      ),
    ).toEqual({ selection: true, count: 4 });
    // A selection over a line break counts the characters either side only.
    expect(countChars(state(doc, [[2, 5]]))).toEqual({ selection: true, count: 2 });
  });

  it("counts a document of the limit's length and none longer", () => {
    expect(countChars(state("a".repeat(CHAR_COUNT_LIMIT)))).toEqual({
      selection: false,
      count: CHAR_COUNT_LIMIT,
    });
    expect(countChars(state("a".repeat(CHAR_COUNT_LIMIT + 1)))).toBeNull();
    expect(countChars(state("a".repeat(CHAR_COUNT_LIMIT + 1), [[0, 2]]))).toBeNull();
  });
});

describe("charCountLabel", () => {
  it("says the document's or the selection's count", () => {
    expect(charCountLabel({ selection: false, count: 1234 })).toBe("1,234자");
    expect(charCountLabel({ selection: true, count: 12 })).toBe("선택 12자");
  });
});

describe("CharCounter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function counter() {
    const shown: (string | null)[] = [];
    let clock = 0;
    const counts = new CharCounter((label) => shown.push(label), {
      now: () => (clock += 1),
    });
    return { counts, shown };
  }

  it("counts after the text has rested, never as it is typed", () => {
    const { counts, shown } = counter();
    counts.request(state("가나다"), { edited: true });
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(CHAR_COUNT_DELAY_MS - 1);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    vi.runAllTimers();
    expect(shown).toEqual(["3자"]);
  });

  it("drops a count a newer change overtakes", () => {
    const { counts, shown } = counter();
    counts.request(state("가"), { edited: true });
    vi.advanceTimersByTime(CHAR_COUNT_DELAY_MS - 1);
    counts.request(state("가나"), { edited: true });
    vi.runAllTimers();
    expect(shown).toEqual(["2자"]);
  });

  it("gives the thread back while it counts a long document, and a change stops it", () => {
    const { counts, shown } = counter();
    const long = Array.from({ length: 5000 }, () => "한글 줄").join("\n");
    counts.request(state(long), { edited: true });
    vi.advanceTimersByTime(CHAR_COUNT_DELAY_MS);
    // The clock moves one millisecond a read: the count stops after a few lines for a turn.
    expect(shown).toEqual([]);
    counts.request(state("x"), { edited: true });
    vi.runAllTimers();
    expect(shown).toEqual(["1자"]);
  });

  it("gives the thread back inside one long line too, cutting it at spaces only", () => {
    const { counts, shown } = counter();
    // One line of 100,000 characters: two-unit emoji and Hangul between spaces.
    const line = Array.from({ length: 20_000 }, () => "👍🏽한 ").join("");
    counts.request(state(line), { edited: true });
    vi.advanceTimersByTime(CHAR_COUNT_DELAY_MS);
    expect(shown).toEqual([]);
    vi.runAllTimers();
    // Cut at spaces, so no grapheme was split: the same count as all at once.
    expect(shown).toEqual([charCountLabel(countChars(state(line))!)]);
    expect(countChars(state(line))!.count).toBe(60_000);
  });

  it("keeps the document's count as the cursor moves, without counting again", () => {
    const { counts, shown } = counter();
    const first = state("가나다");
    counts.request(first, { edited: true });
    vi.runAllTimers();
    const moved = first.update({ selection: { anchor: 1 } }).state;
    counts.request(moved, { edited: false });
    expect(shown).toEqual(["3자", "3자"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("empties the count of another document until it is counted, and keeps it while typing", () => {
    const { counts, shown } = counter();
    counts.request(state("가나다"), { edited: true });
    vi.runAllTimers();
    // Another tab: its text is not the one counted.
    counts.request(state("abcd"), { edited: false });
    expect(shown.at(-1)).toBeNull();
    vi.runAllTimers();
    expect(shown.at(-1)).toBe("4자");
  });

  it("shows nothing over the limit or with no editor, and stops when it is switched off", () => {
    const { counts, shown } = counter();
    counts.request(state("a".repeat(CHAR_COUNT_LIMIT + 1)), { edited: true });
    vi.runAllTimers();
    expect(shown).toEqual([null]);
    counts.request(null, { edited: false });
    expect(shown.at(-1)).toBeNull();
    counts.request(state("ab"), { edited: true });
    counts.cancel();
    vi.runAllTimers();
    expect(shown.at(-1)).toBeNull();
  });
});
