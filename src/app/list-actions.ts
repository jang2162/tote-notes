// What the memo list's and the trash list's menus and keys say when they act on several rows at
// once (docs/superpowers/specs/2026-11-14-tote-notes-list-keyboard-design.md 「문맥 메뉴」).

import { withRo } from "./context-menus";

/** How one memo's move to the trash went: moved here, kept because its tab could not be saved
 * (the status bar said so), or neither — gone already, closed meanwhile, or handed to the window
 * holding it. */
export type TrashOutcome = "trashed" | "unsaved" | "other";

/** How one memo's move to another workspace went, as `TrashOutcome` goes. */
export type MoveOutcome = "moved" | "kept" | "other";

export interface Said {
  text: string;
  tone: "normal" | "error";
}

export const purgeManyQuestion = (count: number) =>
  `고른 메모 ${count}개를 영구 삭제할까요? 되돌릴 수 없습니다.`;
export const duplicatedManyText = (count: number) => `${count}개를 복제했습니다`;

/** One memo that could not be saved has said so itself; with none moved there is nothing to add. */
export function trashSummary(outcomes: readonly TrashOutcome[]): Said | null {
  const moved = outcomes.filter((each) => each === "trashed").length;
  const unsaved = outcomes.filter((each) => each === "unsaved").length;
  if (moved === 0) return null;
  const text = `${moved}개를 휴지통으로 옮겼습니다`;
  if (unsaved === 0) return { text, tone: "normal" };
  return { text: `${text} · ${unsaved}개는 저장하지 못해 옮기지 않았습니다`, tone: "error" };
}

export function moveSummary(outcomes: readonly MoveOutcome[], workspace: string): Said | null {
  const moved = outcomes.filter((each) => each === "moved").length;
  const kept = outcomes.filter((each) => each === "kept").length;
  if (moved === 0) return null;
  const text = `${moved}개를 ${withRo(workspace.normalize("NFC"))} 옮겼습니다`;
  if (kept === 0) return { text, tone: "normal" };
  return { text: `${text} · ${kept}개는 옮기지 못했습니다`, tone: "error" };
}

/** `act` on each of `ids` in turn, the next once the one before is done: one that throws does not
 * stop the rest. The answers of those that did not throw, and the first error. */
export async function eachInTurn<T>(
  ids: readonly string[],
  act: (id: string) => Promise<T>,
): Promise<{ results: T[]; error: unknown }> {
  const results: T[] = [];
  let error: unknown;
  for (const id of ids) {
    try {
      results.push(await act(id));
    } catch (failure) {
      error ??= failure;
    }
  }
  return { results, error };
}
