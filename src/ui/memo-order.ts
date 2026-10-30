import type { ContentHit, MemoInfo, MemoSort } from "../backend/types";

/** For matching only: Finder may hand over decomposed (NFD) Hangul while typed text is composed. */
const fold = (text: string) => text.normalize("NFC").toLocaleLowerCase();

/** The memos whose name holds `query`, and those `hits` found by their content: case ignored,
 * composed (NFC) text against composed, in the order given. An empty query keeps every memo. */
export function filterMemos(
  memos: readonly MemoInfo[],
  query: string,
  hits: ReadonlyMap<string, ContentHit> = new Map(),
): MemoInfo[] {
  const wanted = fold(query.trim());
  if (!wanted) return [...memos];
  return memos.filter((memo) => fold(memo.file).includes(wanted) || hits.has(memo.id));
}

/** Characters of a content match's line shown before the match. */
export const SNIPPET_LEAD = 12;

/** A content match's line around the match, for its row: up to `SNIPPET_LEAD` characters before
 * it (`…` when more were cut), the match, and what follows. Without the query in the line (it
 * changed), the line as it is. */
export function snippet(
  hit: ContentHit,
  query: string,
): { before: string; match: string; after: string } {
  const text = hit.text.normalize("NFC");
  const wanted = fold(query.trim());
  // Folding keeps the length of composed Hangul and of most text, so its index is the text's.
  const at = wanted ? fold(text).indexOf(wanted) : -1;
  if (at < 0 || fold(text).length !== text.length) return { before: text, match: "", after: "" };
  const start = Math.max(0, at - SNIPPET_LEAD);
  return {
    before: (start > 0 ? "…" : "") + text.slice(start, at),
    match: text.slice(at, at + wanted.length),
    after: text.slice(at + wanted.length),
  };
}

/** The pinned memos and the rest, each in the order given (spec 2026-10-30 「고정」): the pinned
 * ones sit in their own zone above the list and are not listed again below it. */
export function splitPinned(memos: readonly MemoInfo[]): { pinned: MemoInfo[]; rest: MemoInfo[] } {
  const pinned: MemoInfo[] = [];
  const rest: MemoInfo[] = [];
  for (const memo of memos) (memo.pinned ? pinned : rest).push(memo);
  return { pinned, rest };
}

/** The sort menu (spec 2026-10-30 「정렬」), in its order. */
export const SORT_ITEMS: readonly { id: MemoSort; text: string }[] = [
  { id: "modified-desc", text: "최근 수정순" },
  { id: "modified-asc", text: "오래된 수정순" },
  { id: "viewed-desc", text: "최근 조회순" },
  { id: "viewed-asc", text: "오래된 조회순" },
  { id: "name-asc", text: "이름순" },
  { id: "name-desc", text: "이름 역순" },
];

export const isMemoSort = (value: string | null): value is MemoSort =>
  SORT_ITEMS.some((item) => item.id === value);

/** Korean collation, case ignored, numbers by size (`메모 2` before `메모 10`). */
const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "accent" });

/** Name order: by the collator on the composed (NFC) names — Finder may hand over decomposed
 * Hangul — and names it finds equal (only their case differs) by code point. */
export function byName(a: MemoInfo, b: MemoInfo): number {
  const order = collator.compare(a.file.normalize("NFC"), b.file.normalize("NFC"));
  return order || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}

/** A memo never on show counts as viewed when it was last modified. */
const viewedAt = (memo: MemoInfo) => memo.viewedMs ?? memo.modifiedMs;

/** `memos` in `sort`'s order, a new array. The time orders break ties by name. */
export function sortMemos(memos: readonly MemoInfo[], sort: MemoSort): MemoInfo[] {
  const compare: Record<MemoSort, (a: MemoInfo, b: MemoInfo) => number> = {
    "modified-desc": (a, b) => b.modifiedMs - a.modifiedMs || byName(a, b),
    "modified-asc": (a, b) => a.modifiedMs - b.modifiedMs || byName(a, b),
    "viewed-desc": (a, b) => viewedAt(b) - viewedAt(a) || byName(a, b),
    "viewed-asc": (a, b) => viewedAt(a) - viewedAt(b) || byName(a, b),
    "name-asc": byName,
    "name-desc": (a, b) => byName(b, a),
  };
  return [...memos].sort(compare[sort]);
}
