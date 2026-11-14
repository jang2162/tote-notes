import { Lexer, type Token } from "marked";

/** A box as a list item's head has it: what a press may change, one character between brackets. */
const BOX_OR_LINE_END = /\r\n|\r|\n|\[[ xX]\]/g;
/** How much reading a press may cost when the counted line is not the box's: each box tried is the
 * whole text read again. */
const READ_BUDGET_CHARS = 4_000_000;
const MAX_TRIES = 64;

/** The lines (from 0) of the task list items of `text`, in the order the preview's `marked` draws
 * their checkboxes — the order the viewer numbers them in (spec 2026-11-14 md-preview 「n 번째 할 일
 * ↔ 원본 줄」). Read with the same `marked` and the same options as the viewer, so a `- [ ]` in a
 * code block or an HTML block, which marked draws no checkbox for, is not counted. */
export function taskLines(text: string): number[] {
  return linesOf(Lexer.lex(text));
}

function linesOf(tokens: readonly Token[]): number[] {
  const lines: number[] = [];
  walk(tokens, 0, lines);
  return lines;
}

/** A block token starts on a line, and its children start on its line and follow each other:
 * marked lexes a child from the text it took off the parent, and taking off quote marks or a list
 * item's indent changes no line count. A list item's checkbox token stands at its head, or at the
 * head of its first paragraph when the list is loose. */
function walk(tokens: readonly Token[], line: number, out: number[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "list":
        walk(token.items, line, out);
        break;
      case "list_item":
      case "blockquote":
        walk(token.tokens ?? [], line, out);
        break;
      case "checkbox":
        out.push(line);
        break;
      case "paragraph":
      case "text":
        for (const inline of token.tokens ?? []) if (inline.type === "checkbox") out.push(line);
        break;
    }
    line += count(token.raw);
  }
}

function count(raw: string): number {
  let n = 0;
  for (let i = raw.indexOf("\n"); i >= 0; i = raw.indexOf("\n", i + 1)) n++;
  return n;
}

/** Whether each box marked draws for `text` is checked, in the order it draws them — the order of
 * marked's own walk, which is its renderer's. */
export function boxStates(text: string): boolean[] {
  return statesOf(Lexer.lex(text));
}

/** marked's `walkTokens` order (table header cells, then rows, then a list's items, then any other
 * token's children), walked here because `marked.walkTokens` gathers its callback's answers with
 * `Array.concat` at every level: its cost grows with the square of the tokens, about 1 s for a
 * 300,000-character memo (`toggleTask`'s cost test in `tasks.test.ts`). The extensions'
 * `childTokens` that marked's walk also follows are left out: the host's `marked` has none. */
function statesOf(tokens: readonly Token[], states: boolean[] = []): boolean[] {
  for (const token of tokens) {
    switch (token.type) {
      case "checkbox":
        states.push(token.checked);
        break;
      case "table":
        for (const cell of token.header) statesOf(cell.tokens, states);
        for (const row of token.rows) for (const cell of row) statesOf(cell.tokens, states);
        continue;
      case "list":
        statesOf(token.items, states);
        continue;
    }
    if ("tokens" in token && token.tokens) statesOf(token.tokens, states);
  }
  return states;
}

/** Every box-like `[ ]`/`[x]`/`[X]` of `text` (the offset of its `[`), those on line `near` first,
 * then by how far their line is from it. */
function boxesNear(text: string, near: number): number[] {
  const found: { at: number; distance: number }[] = [];
  let line = 0;
  for (const match of text.matchAll(BOX_OR_LINE_END)) {
    if (match[0][0] === "[") found.push({ at: match.index, distance: Math.abs(line - near) });
    else line++;
  }
  found.sort((a, b) => a.distance - b.distance || a.at - b.at);
  return found.map((box) => box.at);
}

/** The change that flips the box of the `index`-th task of `text` (`[ ]` ↔ `[x]`): one character,
 * at an offset into `text` (spec 2026-11-14 md-preview 「n 번째 할 일 ↔ 원본 줄」).
 *
 * The line `taskLines` counts is where to look first, not the answer: marked's tokens do not always
 * add up to the text (a quote split by a line without `>` gains a line end in its raw, a definition
 * in a quote loses one), so the count can land on another task or on a line that only looks like
 * one. A box is changed only when the text with it changed draws the same boxes with box `index`
 * alone flipped — the press then changes what was pressed and nothing else. When no box within the
 * reading budget does, nothing is changed: null, as for an index past the last task or a `drawn`
 * text — the one the preview was drawn from — that is not `text` any more. */
export function toggleTask(
  text: string,
  index: number,
  drawn: string = text,
): { from: number; to: number; insert: string } | null {
  if (drawn !== text || !Number.isInteger(index) || index < 0) return null;
  const tokens = Lexer.lex(text);
  const before = statesOf(tokens);
  if (index >= before.length) return null;
  const tries = Math.min(MAX_TRIES, Math.max(1, Math.floor(READ_BUDGET_CHARS / (text.length + 1))));
  for (const box of boxesNear(text, linesOf(tokens)[index] ?? 0).slice(0, tries)) {
    const at = box + 1;
    const insert = text[at] === " " ? "x" : " ";
    const after = boxStates(text.slice(0, at) + insert + text.slice(at + 1));
    if (onlyFlipped(before, after, index)) return { from: at, to: at + 1, insert };
  }
  return null;
}

function onlyFlipped(
  before: readonly boolean[],
  after: readonly boolean[],
  index: number,
): boolean {
  return (
    after.length === before.length &&
    after.every((checked, i) => (i === index ? checked !== before[i] : checked === before[i]))
  );
}
