import {
  codeFolding,
  foldable,
  foldEffect,
  foldedRanges,
  foldService,
  foldState,
  language,
  syntaxTree,
  unfoldEffect,
} from "@codemirror/language";
import {
  EditorState,
  Facet,
  Prec,
  RangeSet,
  RangeSetBuilder,
  type Extension,
} from "@codemirror/state";
import {
  gutter,
  GutterMarker,
  ViewPlugin,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";

import { HIGHLIGHT_LIMIT_CHARS } from "../highlight/extension";

// Folding (editor basics spec 「접기」). TextMate grammars give no ranges, so blocks fold by
// indentation in every language; Markdown's bundled parser folds headings first.

/** How many lines below a line `indentFold` looks for the next one with text. A head whose next
 * text is further down, past blank lines only, folds nothing. */
export const FOLD_LOOKAHEAD_LINES = 1_000;

/** While the gutter decides where markers go: `indentFold` answers whether a line folds without
 * finding where its block ends. The gutter asks for every line in view on every change, and a
 * block's end can be tens of thousands of lines down (a deeply nested JSON at its top). */
let probing = false;

/** `foldable` as the gutter asks it (`probing`): whether the line `lineStart`..`lineEnd` folds,
 * with an indentation block's range cut at its first deeper line. */
export function probeFold(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  probing = true;
  try {
    return foldable(state, lineStart, lineEnd);
  } finally {
    probing = false;
  }
}

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
 * those after it stay out. The line folds when its next line with text (within
 * `FOLD_LOOKAHEAD_LINES`) is deeper; while `probing`, the range ends there. */
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
    const depth = indentation(iter.value, state.tabSize);
    if (depth === null) {
      if (last === line.number && n - line.number >= FOLD_LOOKAHEAD_LINES) return null;
      continue;
    }
    if (depth <= base) break;
    last = n;
    if (probing) break;
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

class FoldMarker extends GutterMarker {
  constructor(readonly open: boolean) {
    super();
  }

  override eq(other: FoldMarker): boolean {
    return this.open === other.open;
  }

  override toDOM(view: EditorView): Node {
    const span = document.createElement("span");
    span.textContent = this.open ? "⌄" : "›";
    span.title = view.state.phrase(this.open ? "Fold line" : "Unfold line");
    return span;
  }
}

const canFoldMarker = new FoldMarker(true);
const foldedMarker = new FoldMarker(false);

/** The fold at the start of the line `from`..`to`, if there is one. */
function foldAt(state: EditorState, from: number, to: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(from, to, (a, b) => {
    if (!found || found.from > a) found = { from: a, to: b };
  });
  return found;
}

/** CodeMirror's `foldGutter`, except that a marker is decided by `probeFold`: the range is found
 * only when the marker is pressed. */
function foldMarkers(): Extension {
  const markers = ViewPlugin.fromClass(
    class {
      markers: RangeSet<GutterMarker>;
      constructor(view: EditorView) {
        this.markers = this.build(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.startState.facet(language) !== update.state.facet(language) ||
          update.startState.field(foldState, false) !== update.state.field(foldState, false) ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        )
          this.markers = this.build(update.view);
      }

      build(view: EditorView) {
        const builder = new RangeSetBuilder<GutterMarker>();
        for (const line of view.viewportLineBlocks) {
          const mark = foldAt(view.state, line.from, line.to)
            ? foldedMarker
            : probeFold(view.state, line.from, line.to)
              ? canFoldMarker
              : null;
          if (mark) builder.add(line.from, line.from, mark);
        }
        return builder.finish();
      }
    },
  );
  return [
    markers,
    gutter({
      class: "cm-foldGutter",
      markers: (view) => view.plugin(markers)?.markers ?? RangeSet.empty,
      initialSpacer: () => foldedMarker,
      domEventHandlers: {
        click: (view, line) => {
          const folded = foldAt(view.state, line.from, line.to);
          if (folded) {
            view.dispatch({ effects: unfoldEffect.of(folded) });
            return true;
          }
          const range = foldable(view.state, line.from, line.to);
          if (!range) return false;
          view.dispatch({ effects: foldEffect.of(range) });
          return true;
        },
      },
    }),
  ];
}

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
    state.gutter ? foldMarkers() : [],
    phrases,
  ];
}
