import type { MemoInfo } from "../backend/types";

/** The pinned memos and the rest, each in the order given (spec 2026-10-30 「고정」): the pinned
 * ones sit in their own zone above the list and are not listed again below it. */
export function splitPinned(memos: readonly MemoInfo[]): { pinned: MemoInfo[]; rest: MemoInfo[] } {
  const pinned: MemoInfo[] = [];
  const rest: MemoInfo[] = [];
  for (const memo of memos) (memo.pinned ? pinned : rest).push(memo);
  return { pinned, rest };
}
