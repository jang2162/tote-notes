import type { EditorState, Text } from "@codemirror/state";

// The status bar's character count (editor basics spec 「글자 수」).

/** Longer documents are not counted, and the count is not shown. The spec's 1 MB, in UTF-16 units
 * as `LARGE_MEMO_CHARS` in src/app/docs.ts measures it. */
export const CHAR_COUNT_LIMIT = 1_000_000;
/** How long the text and the selection rest before they are counted. */
export const CHAR_COUNT_DELAY_MS = 200;
/** How long one turn of counting holds the thread before it hands it back. */
const SLICE_MS = 8;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Printable ASCII and tabs: one character a unit, so no segmenting. */
const PLAIN = /^[\t\x20-\x7e]*$/;

/** The characters a person sees in `text`: a composed Hangul syllable, an emoji with its skin tone
 * or joiners, a flag, a letter with its accents are one each. */
export function countGraphemes(text: string): number {
  if (PLAIN.test(text)) return text.length;
  let count = 0;
  for (const _ of graphemes.segment(text)) count++;
  return count;
}

export interface CharCount {
  /** The selection's count rather than the document's. */
  selection: boolean;
  count: number;
}

/** The text between `from` and `to`, line by line without the line breaks. A grapheme never spans
 * a line break in a CodeMirror document, so the pieces count apart. */
function* pieces(doc: Text, ranges: readonly { from: number; to: number }[]) {
  for (const { from, to } of ranges) {
    for (const iter = doc.iterRange(from, to); !iter.next().done;)
      if (!iter.lineBreak) yield iter.value;
  }
}

/** What is counted in `state`: the selected ranges when any is not empty, else the document. Null
 * for a document over the limit. */
function target(state: EditorState): { selection: boolean; pieces: Iterable<string> } | null {
  const { doc } = state;
  if (doc.length > CHAR_COUNT_LIMIT) return null;
  const selected = state.selection.ranges.filter((range) => !range.empty);
  return selected.length
    ? { selection: true, pieces: pieces(doc, selected) }
    : { selection: false, pieces: pieces(doc, [{ from: 0, to: doc.length }]) };
}

/** The count of `state` all at once (`target`); null over the limit. */
export function countChars(state: EditorState): CharCount | null {
  const found = target(state);
  if (!found) return null;
  let count = 0;
  for (const piece of found.pieces) count += countGraphemes(piece);
  return { selection: found.selection, count };
}

export function charCountLabel({ selection, count }: CharCount): string {
  const n = count.toLocaleString("en-US");
  return selection ? `선택 ${n}자` : `${n}자`;
}

/** Counts off the typing path: `request` waits for the text to rest, then counts in slices that
 * hand the thread back, and a newer request drops the count under way. */
export class CharCounter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The document last counted whole, and its count. */
  private counted: { doc: Text; count: number } | null = null;
  /** The document of the last request: another one not reached by an edit is another tab's. */
  private requested: Text | null = null;
  private readonly now: () => number;

  /** `show` gets the label, or null for no count. */
  constructor(
    private readonly show: (label: string | null) => void,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  /** `state` is shown now: `edited` when its text was just changed in place (keep the last count
   * until the new one), not when it is another tab's (no count until its own). Null: no editor. */
  request(state: EditorState | null, { edited }: { edited: boolean }): void {
    this.cancel();
    const another = !edited && state?.doc !== this.requested;
    this.requested = state?.doc ?? null;
    if (!state || state.doc.length > CHAR_COUNT_LIMIT) {
      this.show(null);
      return;
    }
    const selecting = state.selection.ranges.some((range) => !range.empty);
    if (!selecting && this.counted?.doc === state.doc) {
      this.show(charCountLabel({ selection: false, count: this.counted.count }));
      return;
    }
    // Another tab's count must not stand for this one's while it is counted.
    if (another) this.show(null);
    this.timer = setTimeout(() => this.count(state), CHAR_COUNT_DELAY_MS);
  }

  /** Stops any count waiting or under way. */
  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private count(state: EditorState): void {
    const found = target(state)!;
    const iter = found.pieces[Symbol.iterator]();
    let count = 0;
    const slice = () => {
      const end = this.now() + SLICE_MS;
      for (;;) {
        const next = iter.next();
        if (next.done) break;
        count += countGraphemes(next.value);
        if (this.now() >= end) {
          this.timer = setTimeout(slice, 0);
          return;
        }
      }
      this.timer = undefined;
      if (!found.selection) this.counted = { doc: state.doc, count };
      this.show(charCountLabel({ selection: found.selection, count }));
    };
    slice();
  }
}
