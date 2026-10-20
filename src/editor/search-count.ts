import type { SearchQuery } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";

export const COUNT_LIMIT = 1000;

/** How long one count may run before it stops and shows what it found as a floor ("12+"): a big
 * memo with few results would otherwise be scanned whole at every change while the bar is open. */
export const COUNT_BUDGET_MS = 30;

/** About how much text is searched between two looks at the clock; a piece ends at a line end. */
const PIECE_CHARS = 1 << 16;

export interface MatchCount {
  total: number;
  capped: boolean;
  current: number | null;
}

/** The matches found from the start, in order; `capped` when the count stopped before the end. */
export interface Matches {
  from: number[];
  to: number[];
  capped: boolean;
}

/** Whether a match of `query` can run over a line end: a newline in a plain search (CodeMirror reads
 * `\n` as one unless the query is literal), or a regexp CodeMirror searches across lines. */
function crossesLines(query: SearchQuery): boolean {
  return query.regexp
    ? /\\[sWDnr]|\n|\r|\[\^/.test(query.search)
    : /[\n\r]|\\[nr]/.test(query.search);
}

/** Finds matches from the start, stopping at the first one past `limit` or once `budgetMs` has run
 * out. The text is searched a piece of lines at a time, so a long stretch without a match is cut
 * too; a query that can run over a line end is searched in one piece. */
export function findMatches(
  state: EditorState,
  query: SearchQuery,
  limit: number = COUNT_LIMIT,
  budgetMs: number = COUNT_BUDGET_MS,
  now: () => number = () => performance.now(),
): Matches {
  const { doc } = state;
  const whole = crossesLines(query);
  const from: number[] = [];
  const to: number[] = [];
  const start = now();
  const late = () => now() - start > budgetMs;
  for (let at = 0; ;) {
    const end =
      whole || at + PIECE_CHARS >= doc.length ? doc.length : doc.lineAt(at + PIECE_CHARS).to;
    const cursor = query.getCursor(state, at, end);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      if (from.length === limit) return { from, to, capped: true };
      from.push(next.value.from);
      to.push(next.value.to);
      if (late()) return { from, to, capped: true };
    }
    if (end >= doc.length) return { from, to, capped: false };
    if (late()) return { from, to, capped: true };
    // The line break between two pieces holds no match: none runs over a line end here.
    at = end + 1;
  }
}

/** The number of the match equal to `selection` among `matches`, or null. */
export function currentMatch(
  matches: Matches,
  selection: { from: number; to: number },
): number | null {
  const { from, to } = matches;
  let low = 0;
  let high = from.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (from[mid] < selection.from) low = mid + 1;
    else high = mid;
  }
  for (let i = low; i < from.length && from[i] === selection.from; i++)
    if (to[i] === selection.to) return i + 1;
  return null;
}

/** Counts matches from the start, as `findMatches` finds them, numbering the main selection's. */
export function countMatches(
  state: EditorState,
  query: SearchQuery,
  limit: number = COUNT_LIMIT,
  budgetMs: number = COUNT_BUDGET_MS,
  now?: () => number,
): MatchCount {
  const matches = findMatches(state, query, limit, budgetMs, now);
  return {
    total: matches.from.length,
    capped: matches.capped,
    current: currentMatch(matches, state.selection.main),
  };
}

export function countLabel(query: SearchQuery, count: MatchCount | null): string {
  if (query.search === "") return "";
  if (!query.valid) return "잘못된 정규식";
  if (count === null || (count.total === 0 && !count.capped)) return "결과 없음";
  return `${count.current ?? "–"} / ${count.total}${count.capped ? "+" : ""}`;
}
