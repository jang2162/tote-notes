import { Lexer, type Token } from "marked";

/** A list item's own box at the head of its line, after any quote marks, bullets and spaces —
 * what a line has to look like before its box is changed. */
const TASK_LINE = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*\[[ xX]\](?=[ \t])/;
const LINE_END = /\r\n|\r|\n/g;

/** The lines (from 0) of the task list items of `text`, in the order the preview's `marked` draws
 * their checkboxes — the order the viewer numbers them in (spec 2026-11-14 md-preview 「n 번째 할 일
 * ↔ 원본 줄」). Read with the same `marked` and the same options as the viewer, so a `- [ ]` in a
 * code block or an HTML block, which marked draws no checkbox for, is not counted. */
export function taskLines(text: string): number[] {
  const lines: number[] = [];
  walk(Lexer.lex(text), 0, lines);
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

/** Where line `line` (from 0) of `text` starts and ends, its line end left out. */
function lineRange(text: string, line: number): { from: number; to: number } | null {
  let from = 0;
  LINE_END.lastIndex = 0;
  for (let n = 0; n < line; n++) {
    const end = LINE_END.exec(text);
    if (!end) return null;
    from = end.index + end[0].length;
  }
  LINE_END.lastIndex = from;
  const end = LINE_END.exec(text);
  return { from, to: end ? end.index : text.length };
}

/** Where the box's mark (the character between its brackets) is in `line`, or null when `line`
 * does not start as a task list item does. */
export function boxMark(line: string): number | null {
  const head = TASK_LINE.exec(line);
  return head ? head[0].length - 2 : null;
}

/** The change that flips the box of the `index`-th task of `text` (`[ ]` ↔ `[x]`): one character,
 * at an offset into `text`. Null when there is no such task, when its line does not look like a
 * task (the count went wrong: nothing is changed rather than the wrong line), or when `drawn` — the
 * text the preview was drawn from — is not `text` any more: the `index`-th task of the text on show
 * may be another one now. */
export function toggleTask(
  text: string,
  index: number,
  drawn: string = text,
): { from: number; to: number; insert: string } | null {
  if (drawn !== text || !Number.isInteger(index) || index < 0) return null;
  const line = taskLines(text)[index];
  if (line === undefined) return null;
  const range = lineRange(text, line);
  if (!range) return null;
  const mark = boxMark(text.slice(range.from, range.to));
  if (mark === null) return null;
  const at = range.from + mark;
  return { from: at, to: at + 1, insert: text[at] === " " ? "x" : " " };
}
