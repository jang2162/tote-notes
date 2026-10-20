import type { SearchQuery } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";

export const COUNT_LIMIT = 1000;

export interface MatchCount {
  total: number;
  capped: boolean;
  current: number | null;
}

/** Counts matches from the start, stopping at the first one past `limit`. */
export function countMatches(
  state: EditorState,
  query: SearchQuery,
  limit: number = COUNT_LIMIT,
): MatchCount {
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current: number | null = null;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (total === limit) return { total: limit, capped: true, current };
    total++;
    if (next.value.from === from && next.value.to === to) current = total;
  }
  return { total, capped: false, current };
}

export function countLabel(query: SearchQuery, count: MatchCount | null): string {
  if (query.search === "") return "";
  if (!query.valid) return "잘못된 정규식";
  if (count === null || count.total === 0) return "결과 없음";
  return `${count.current ?? "–"} / ${count.total}${count.capped ? "+" : ""}`;
}
