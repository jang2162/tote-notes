import { codeFolding, foldEffect, foldGutter, foldService } from "@codemirror/language";
import { EditorState, Facet, Prec, type Extension } from "@codemirror/state";

import { HIGHLIGHT_LIMIT_CHARS } from "../highlight/extension";

// Folding (editor basics spec 「접기」). TextMate grammars give no ranges, so blocks fold by
// indentation in every language; Markdown's bundled parser folds headings first.

/** How many lines below a line `indentFold` reads looking for its block's end. The gutter asks
 * again for every line in view on every change, so a block of hundreds of thousands of lines read
 * to its end each time would slow typing; such a block has no marker instead. */
export const FOLD_SCAN_LINES = 10_000;

/** Whether a text this long folds: up to the length highlighting stops at (core design
 * 「크기별 단계」). */
export function foldsAt(length: number): boolean {
  return length <= HIGHLIGHT_LIMIT_CHARS;
}

/** The columns `text`'s indentation takes; null for a blank line. */
function indentation(text: string, tabSize: number): number | null {
  let column = 0;
  for (const ch of text) {
    if (ch === " ") column++;
    else if (ch === "\t") column += tabSize - (column % tabSize);
    else return column;
  }
  return null;
}

/** A `foldService`: from the end of the line to the end of the last non-blank line below it that
 * is indented deeper, before the first one that is not. Blank lines inside go with the block;
 * those after it stay out. */
export function indentFold(
  state: EditorState,
  lineStart: number,
  _lineEnd: number,
): { from: number; to: number } | null {
  const { doc } = state;
  const line = doc.lineAt(lineStart);
  const base = indentation(line.text, state.tabSize);
  if (base === null || line.number === doc.lines) return null;
  let last = line.number;
  let n = line.number;
  for (const iter = doc.iterLines(line.number + 1); !iter.next().done;) {
    n++;
    if (n - line.number > FOLD_SCAN_LINES) return null;
    const depth = indentation(iter.value, state.tabSize);
    if (depth === null) continue;
    if (depth <= base) break;
    last = n;
  }
  return last === line.number ? null : { from: line.to, to: doc.line(last).to };
}

/** CodeMirror's words, as the editor's other messages are Korean. */
const phrases = EditorState.phrases.of({
  "Fold line": "접기",
  "Unfold line": "펴기",
  "folded code": "접힌 부분",
  unfold: "펴기",
  "Folded lines": "접은 줄",
  "Unfolded lines": "편 줄",
  to: "~",
});

/** Off: no fold gets into the state, whatever command or language's service asks for one. */
const noFolds = EditorState.transactionFilter.of((tr) => {
  if (!tr.effects.some((effect) => effect.is(foldEffect))) return tr;
  return {
    changes: tr.changes,
    selection: tr.selection,
    scrollIntoView: tr.scrollIntoView,
    effects: tr.effects.filter((effect) => !effect.is(foldEffect)),
  };
});

/** Whether the state's text was short enough to fold when it was made (`foldsAt`). */
export const foldFits = Facet.define<boolean, boolean>({
  combine: (values) => values.every(Boolean),
});

/** Folding for a state whose text `fits` (`foldsAt`), with the gutter's markers when `gutter` is
 * on. After the line numbers, so the markers sit to their right. */
export function folding(state: { fits: boolean; gutter: boolean }): Extension {
  if (!state.fits) return noFolds;
  return [
    codeFolding(),
    // Below Markdown's own service, which folds a heading's section first.
    Prec.low(foldService.of(indentFold)),
    state.gutter ? foldGutter() : [],
    phrases,
  ];
}
