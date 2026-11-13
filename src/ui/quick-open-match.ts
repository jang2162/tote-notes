import type { MemoInfo, ShortcutTable } from "../backend/types";
import { formatAccelerator } from "../shortcuts/keys";
import { byName } from "./memo-order";

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

const isHangul = (code: number) =>
  (code >= 0x1100 && code <= 0x11ff) ||
  (code >= 0x3130 && code <= 0x318f) ||
  (code >= 0xac00 && code <= 0xd7af);

/** One character lowered, as a code point. One that would lower into several (`İ`) stays as it
 * is, so an index into the folded name is one into the name. ASCII and Hangul go the short way:
 * names are mostly those, and this runs for every character of every memo as the box opens. */
function lowerCode(char: string, code: number): number {
  if (code < 0x80) return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
  if (isHangul(code)) return code;
  const lowered = char.toLowerCase();
  return lowered.length === char.length ? lowered.codePointAt(0)! : code;
}

/** A capital: it lowers into another character. */
const isUpper = (char: string, code: number) =>
  code < 0x80 ? code >= 0x41 && code <= 0x5a : lowerCode(char, code) !== code;
/** A small letter: it has a capital. */
const isLower = (char: string, code: number) =>
  code < 0x80 ? code >= 0x61 && code <= 0x7a : !isHangul(code) && char.toUpperCase() !== char;

/** A name made ready to be matched again and again: its characters (code points) composed (NFC),
 * as a row shows them, those lowered, and what each adds as the head of a word — the start of the
 * name, after a separator, a capital after a small letter, either side of Hangul's edge. */
interface Prepared {
  chars: string[];
  // Plain arrays of small numbers: two typed arrays per name were 10ms of 10,000 names' making.
  folded: number[];
  heads: number[];
}

function prepare(name: string): Prepared {
  const chars = Array.from(name.normalize("NFC"));
  const n = chars.length;
  const folded = new Array<number>(n);
  const heads = new Array<number>(n).fill(0);
  let before = -1;
  for (let at = 0; at < n; at++) {
    const char = chars[at];
    const code = char.codePointAt(0)!;
    folded[at] = lowerCode(char, code);
    if (at === 0) heads[at] = NAME_HEAD;
    else if (
      SEPARATORS.has(chars[at - 1]) ||
      (isUpper(char, code) && isLower(chars[at - 1], before)) ||
      isHangul(before) !== isHangul(code)
    )
      heads[at] = WORD_HEAD;
    before = code;
  }
  return { chars, folded, heads };
}

/** What was typed, as `prepare` folds a name: composed, lowered, the spaces left out. */
function queryCodes(query: string): number[] {
  return Array.from(query.normalize("NFC"))
    .filter((char) => !/\s/u.test(char))
    .map((char) => lowerCode(char, char.codePointAt(0)!));
}

/** Whether `name` holds the letters in order: a walk that says so for most names before any
 * scoring. */
function holds(wanted: readonly number[], name: readonly number[]): boolean {
  let from = 0;
  for (const code of wanted) {
    from = name.indexOf(code, from) + 1;
    if (from === 0) return false;
  }
  return true;
}

// Rounded: two names alike but for where they are must tie, whatever the sums' last bits.
const rounded = (score: number) => Math.round(score * 10) / 10;

/** Two rows of the table `scoreOf` fills, kept from one name to the next and grown as a longer
 * one comes: a pair of new arrays per letter of every name was most of a keystroke's time over
 * 10,000 memos (spec 「성능」). */
let rows = [new Float64Array(64), new Float64Array(64)];

/** The best score of `wanted` in `name` (which `holds` it): the table of `matchOf` row by row,
 * without the way back to the letters. */
function scoreOf(wanted: readonly number[], name: Prepared): number {
  const { folded, heads } = name;
  const n = folded.length;
  if (rows[0].length < n) rows = [new Float64Array(n * 2), new Float64Array(n * 2)];
  let prev = rows[0];
  let cur = rows[1];
  for (let i = 0; i < wanted.length; i++) {
    const code = wanted[i];
    let farBest = -Infinity;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2) {
        const value = prev[j - 2] + GAP * (j - 2);
        if (value > farBest) farBest = value;
      }
      if (folded[j] !== code) {
        cur[j] = -Infinity;
        continue;
      }
      const own = MATCH + heads[j];
      if (i === 0) {
        cur[j] = own;
        continue;
      }
      const next = j > 0 ? prev[j - 1] + CONSECUTIVE : -Infinity;
      const best = Math.max(next, farBest - GAP * (j - 1));
      cur[j] = best === -Infinity ? -Infinity : own + best;
    }
    [prev, cur] = [cur, prev];
  }
  let best = -Infinity;
  for (let j = 0; j < n; j++) if (prev[j] > best) best = prev[j];
  return rounded(best);
}

export interface Match {
  score: number;
  /** The characters of the composed name that matched, as code point indices. */
  indices: number[];
}

/** The best place of `wanted` in `name` (which `holds` it) and its score, which is `scoreOf`'s:
 * best[i][j] is the best score with wanted[i] matched at j, back[i][j] where wanted[i - 1] was. */
function matchOf(wanted: readonly number[], name: Prepared): Match {
  const { folded, heads } = name;
  const n = folded.length;
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
      const own = MATCH + heads[j];
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
  let end = 0;
  for (let j = 1; j < n; j++) if (last[j] > last[end]) end = j;
  const indices: number[] = [];
  for (let i = wanted.length - 1, j = end; i >= 0; j = back[i][j], i--) indices.push(j);
  indices.reverse();
  return { score: rounded(last[end]), indices };
}

/** Whether `name` holds the letters of `query` in order — case ignored, both composed (NFC), the
 * spaces typed left out — and how well: the best of the places it could match at. */
export function fuzzyMatch(query: string, name: string): Match | null {
  const wanted = queryCodes(query);
  if (wanted.length === 0) return { score: 0, indices: [] };
  const prepared = prepare(name);
  return holds(wanted, prepared.folded) ? matchOf(wanted, prepared) : null;
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

type Entry = {
  result: FileResult;
  prepared: Prepared;
  /** A memo's, for its place in a tie; none for an open file. */
  memo?: MemoInfo;
};

function memoEntry(memo: MemoInfo): Entry {
  const prepared = prepare(memo.file);
  return {
    result: { kind: "memo", id: memo.id, name: prepared.chars.join(""), indices: [], score: 0 },
    prepared,
    memo,
  };
}

function externalEntry(path: string): Entry {
  const cut = path.lastIndexOf("/");
  const prepared = prepare(path.slice(cut + 1));
  return {
    result: {
      kind: "external",
      path,
      name: prepared.chars.join(""),
      dir: path.slice(0, Math.max(cut, 0)) || "/",
      indices: [],
      score: 0,
    },
    prepared,
  };
}

/** When the memo was last on show, as the memo list's 최근 조회순 counts it (`sortMemos`). */
const viewedAt = (memo: MemoInfo) => memo.viewedMs ?? memo.modifiedMs;

/** The order of a tie of scores: memos most recently viewed first, as 최근 조회순 (`sortMemos`:
 * the time viewed, else modified, then by name), then the open files — never viewed — by path. */
function tieOrder(a: Entry, b: Entry): number {
  if (a.memo && b.memo) return viewedAt(b.memo) - viewedAt(a.memo) || byName(a.memo, b.memo);
  if (a.memo || b.memo) return a.memo ? -1 : 1;
  const [x, y] = [a.result, b.result];
  return x.kind === "external" && y.kind === "external" ? (x.path < y.path ? -1 : 1) : 0;
}

/** The best `MAX_RESULTS` of what is offered (`offer`), best first, without sorting the rest: a
 * whole sort of 10,000 memos by name, as the box opens, was most of its time (spec 「성능」). */
class Top {
  readonly kept: { entry: Entry; score: number }[] = [];

  private before(a: { entry: Entry; score: number }, b: { entry: Entry; score: number }): boolean {
    return a.score !== b.score ? a.score > b.score : tieOrder(a.entry, b.entry) < 0;
  }

  offer(entry: Entry, score: number): void {
    const item = { entry, score };
    const { kept } = this;
    if (kept.length === MAX_RESULTS && !this.before(item, kept[MAX_RESULTS - 1])) return;
    let place = kept.length;
    while (place > 0 && this.before(item, kept[place - 1])) place--;
    kept.splice(place, 0, item);
    if (kept.length > MAX_RESULTS) kept.pop();
  }
}

/** The memos and open files of one 빠른 열기, made ready once as it opens and searched at each
 * keystroke (spec 「메모 찾기」·「성능」). */
export class FileIndex {
  private readonly memos: Entry[];
  private externals: Entry[] = [];
  /** The last query's letters and every entry they matched: a query that goes on from it can only
   * match among those. */
  private last: { key: string; matched: Entry[] } | null = null;
  /** What the last `rank` did, for the tests: the entries it walked and the ones it scored. */
  readonly counts = { walked: 0, scored: 0 };

  constructor(memos: readonly MemoInfo[], externals: readonly string[] = []) {
    this.memos = memos.map(memoEntry);
    this.setExternals(externals);
  }

  setExternals(paths: readonly string[]): void {
    this.externals = [...paths].sort().map(externalEntry);
    this.last = null;
  }

  /** What 빠른 열기 lists for `query`: the best match first, a tie in `tieOrder`, at most
   * `MAX_RESULTS`. With nothing typed, the `MAX_RESULTS` memos most recently viewed, then every
   * open file. */
  rank(query: string): FileResult[] {
    const wanted = queryCodes(query);
    this.counts.walked = this.counts.scored = 0;
    if (wanted.length === 0) {
      this.last = null;
      const top = new Top();
      for (const entry of this.memos) top.offer(entry, 0);
      return [...top.kept.map(({ entry }) => entry), ...this.externals].map((e) => e.result);
    }
    const key = String.fromCodePoint(...wanted);
    const from =
      this.last && key.startsWith(this.last.key)
        ? this.last.matched
        : [...this.memos, ...this.externals];
    const matched: Entry[] = [];
    const top = new Top();
    for (const entry of from) {
      this.counts.walked++;
      if (!holds(wanted, entry.prepared.folded)) continue;
      matched.push(entry);
      this.counts.scored++;
      top.offer(entry, scoreOf(wanted, entry.prepared));
    }
    this.last = { key, matched };
    return top.kept.map(({ entry }) => ({ ...entry.result, ...matchOf(wanted, entry.prepared) }));
  }
}

/** `FileIndex.rank` for one query. */
export function rankFiles(
  memos: readonly MemoInfo[],
  externals: readonly string[],
  query: string,
): FileResult[] {
  return new FileIndex(memos, externals).rank(query);
}

/** `name` cut into runs to draw bold (`bold`, holding a character at `indices`) or not. A run is
 * whole characters as people see them (grapheme clusters): a match on one code point of an emoji
 * sequence (👨‍👩‍👧, ❤️) makes the whole of it bold, which drawn apart would fall to pieces. */
export function boldRuns(
  name: string,
  indices: readonly number[],
): { text: string; bold: boolean }[] {
  const hit = new Set(indices);
  const runs: { text: string; bold: boolean }[] = [];
  let at = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    name,
  )) {
    const size = Array.from(segment).length;
    let bold = false;
    for (let each = at; each < at + size; each++) bold ||= hit.has(each);
    at += size;
    const lastRun = runs[runs.length - 1];
    if (lastRun?.bold === bold) lastRun.text += segment;
    else runs.push({ text: segment, bold });
  }
  return runs;
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
