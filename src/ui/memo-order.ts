import type { MemoInfo, MemoSort } from "../backend/types";

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
