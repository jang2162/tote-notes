import type { MemoInfo, ShortcutTable } from "../backend/types";
import { formatAccelerator } from "../shortcuts/keys";
import { byName, sortMemos } from "./memo-order";

// 빠른 열기's finding and ranking (spec 2026-11-14 「메모 찾기」·「명령 팔레트」), kept free of the
// DOM for the unit tests.

/** The app command of 빠른 열기 itself (`shortcuts::COMMANDS`). */
export const QUICK_OPEN_COMMAND = "quick-open";

/** The most rows a query shows, and the most memos the empty query does. */
export const MAX_RESULTS = 50;

/** A letter matched (spec 「점수」). */
const MATCH = 1;
/** Added when the letter before it matched too. More than a word head's, so that what was typed
 * found as one run beats the same letters each at the head of a word apart. */
const CONSECUTIVE = 7;
/** Added when it starts a word, or the whole name. */
const WORD_HEAD = 6;
const NAME_HEAD = 8;
/** Taken off for each letter skipped between two matched ones. */
const GAP = 0.1;

const SEPARATORS = new Set([" ", "-", "_", ".", "/", "(", ")", "[", "]"]);
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/u;

/** The name's characters (code points) composed, as a row shows them. */
const charsOf = (text: string) => Array.from(text.normalize("NFC"));

/** One character lowered. One that would lower into several (`İ`) stays as it is, so an index
 * into the folded name is one into the name. */
function lower(char: string): string {
  const lowered = char.toLowerCase();
  return Array.from(lowered).length === 1 ? lowered : char;
}

function headBonus(chars: readonly string[], at: number): number {
  if (at === 0) return NAME_HEAD;
  const before = chars[at - 1];
  const char = chars[at];
  if (SEPARATORS.has(before)) return WORD_HEAD;
  if (before !== before.toUpperCase() && char !== char.toLowerCase()) return WORD_HEAD;
  if (HANGUL.test(before) !== HANGUL.test(char)) return WORD_HEAD;
  return 0;
}

export interface Match {
  score: number;
  /** The characters of the composed name that matched, as code point indices. */
  indices: number[];
}

/** Whether `name` holds the letters of `query` in order — case ignored, both composed (NFC), the
 * spaces typed left out — and how well: the best of the places it could match at. */
export function fuzzyMatch(query: string, name: string): Match | null {
  const wanted = charsOf(query)
    .filter((char) => !/\s/u.test(char))
    .map(lower);
  if (wanted.length === 0) return { score: 0, indices: [] };
  const chars = charsOf(name);
  const folded = chars.map(lower);
  // Most names miss: a walk in order says so before the table is made.
  let from = 0;
  for (const char of wanted) {
    from = folded.indexOf(char, from) + 1;
    if (from === 0) return null;
  }
  const n = folded.length;
  // best[i][j]: the best score with wanted[i] matched at j; from[i][j] where wanted[i - 1] was.
  const best: Float64Array[] = [];
  const back: Int32Array[] = [];
  for (let i = 0; i < wanted.length; i++) {
    const row = new Float64Array(n).fill(-Infinity);
    const links = new Int32Array(n).fill(-1);
    // The best of best[i - 1][k] + GAP * k over k < j - 1: one gap of j - k - 1 letters costs
    // GAP * (j - 1) less than that.
    let farBest = -Infinity;
    let farAt = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2) {
        const k = j - 2;
        const value = best[i - 1][k] + GAP * k;
        if (value > farBest) {
          farBest = value;
          farAt = k;
        }
      }
      if (folded[j] !== wanted[i]) continue;
      const own = MATCH + headBonus(chars, j);
      if (i === 0) {
        row[j] = own;
        continue;
      }
      const next = j > 0 ? best[i - 1][j - 1] + CONSECUTIVE : -Infinity;
      const far = farBest - GAP * (j - 1);
      if (next === -Infinity && far === -Infinity) continue;
      if (next >= far) {
        row[j] = own + next;
        links[j] = j - 1;
      } else {
        row[j] = own + far;
        links[j] = farAt;
      }
    }
    best.push(row);
    back.push(links);
  }
  const last = best[wanted.length - 1];
  let end = -1;
  for (let j = 0; j < n; j++) if (end < 0 || last[j] > last[end]) end = j;
  if (end < 0 || last[end] === -Infinity) return null;
  const indices: number[] = [];
  for (let i = wanted.length - 1, j = end; i >= 0; j = back[i][j], i--) indices.push(j);
  indices.reverse();
  // Rounded: two names alike but for where they are must tie, whatever the sums' last bits.
  return { score: Math.round(last[end] * 10) / 10, indices };
}

export type FileResult =
  | { kind: "memo"; id: string; name: string; indices: number[]; score: number }
  | {
      kind: "external";
      path: string;
      name: string;
      /** The folder it is in, to tell two files of one name apart. */
      dir: string;
      indices: number[];
      score: number;
    };

function externalResult(path: string, match: Match): FileResult {
  const cut = path.lastIndexOf("/");
  return {
    kind: "external",
    path,
    name: path.slice(cut + 1).normalize("NFC"),
    dir: path.slice(0, Math.max(cut, 0)) || "/",
    indices: match.indices,
    score: match.score,
  };
}

const memoResult = (memo: MemoInfo, match: Match): FileResult => ({
  kind: "memo",
  id: memo.id,
  name: memo.file.normalize("NFC"),
  indices: match.indices,
  score: match.score,
});

/** When the memo was last on show, as the memo list's 최근 조회순 counts it (`sortMemos`). */
const viewedAt = (memo: MemoInfo) => memo.viewedMs ?? memo.modifiedMs;

/** What 빠른 열기 lists for `query`: the memos and the open external files (`externals`, by path)
 * whose name holds it, the best match first, then the one viewed last, then by name; external
 * files, never viewed, after memos of the same score. With nothing typed, the memos most recently
 * viewed first (as 최근 조회순), then every open file by path. */
export function rankFiles(
  memos: readonly MemoInfo[],
  externals: readonly string[],
  query: string,
): FileResult[] {
  const paths = [...externals].sort();
  if (!query.trim()) {
    const none: Match = { score: 0, indices: [] };
    return [
      ...sortMemos(memos, "viewed-desc")
        .slice(0, MAX_RESULTS)
        .map((memo) => memoResult(memo, none)),
      ...paths.map((path) => externalResult(path, none)),
    ];
  }
  const found: { result: FileResult; memo?: MemoInfo }[] = [];
  for (const memo of memos) {
    const match = fuzzyMatch(query, memo.file);
    if (match) found.push({ result: memoResult(memo, match), memo });
  }
  for (const path of paths) {
    const result = externalResult(path, { score: 0, indices: [] });
    const match = fuzzyMatch(query, result.name);
    if (match) found.push({ result: { ...result, ...match } });
  }
  found.sort((a, b) => {
    const order = b.result.score - a.result.score;
    if (order || !a.memo || !b.memo) return order || (a.memo ? -1 : b.memo ? 1 : 0);
    return viewedAt(b.memo) - viewedAt(a.memo) || byName(a.memo, b.memo);
  });
  return found.slice(0, MAX_RESULTS).map(({ result }) => result);
}

export interface CommandItem {
  id: string;
  label: string;
  menu: string;
  /** Its shortcut now, as the menu writes it; null when it has none. */
  keys: string | null;
}

/** The app commands the palette offers: the shortcut table's, in menu order, but 빠른 열기, which
 * would only open itself again. */
export function commandItems(table: ShortcutTable): CommandItem[] {
  return table.commands
    .filter((command) => command.id !== QUICK_OPEN_COMMAND)
    .map(({ id, label, menu, current }) => ({
      id,
      label,
      menu,
      keys: current ? formatAccelerator(current) : null,
    }));
}

export type CommandResult = CommandItem & Match;

/** The commands whose name holds `query`, the best match first, else in menu order; all of them
 * with nothing typed. */
export function rankCommands(items: readonly CommandItem[], query: string): CommandResult[] {
  const found: CommandResult[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, item.label);
    if (match) found.push({ ...item, ...match });
  }
  // A stable sort: equal scores keep the menu's order.
  return found.sort((a, b) => b.score - a.score);
}
