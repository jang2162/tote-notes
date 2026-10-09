import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type ChangeSpec,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

// Every cursor and selection gets the text the input method produces, as with Latin typing
// (spec 「편집기」). WKWebView's Korean input method was recorded feeding text through two paths,
// and both have to end the same way:
//
// - The direct path: each keystroke is a committed `insertText` (first jamo) or
//   `insertReplacementText` (the syllable before the caret rewritten), with no composition events
//   and `isComposing` false. CodeMirror repeats a plain insert at every range by itself but applies
//   the rewrite to the main range only — that is where `배ㄱ나` came from.
// - The composition path: compositionstart / compositionupdate / compositionend around the main
//   range, sometimes a second compositionstart inside the same composition, and the end either
//   re-inserting the text (deleteCompositionText + insertFromComposition) or a bare compositionend
//   with empty data. Only the main range is composed; the others get the result at the end.
//
// Which path a keystroke takes is the input method's choice and changes from run to run.

/** With several ranges, the main one is the first. The input method appears to locate its caret
 * by its offset from the start of the editable root — inferred from two observations, not shown
 * by the recordings themselves: text mirrored to a range *before* the caret made the next
 * keystroke start a fresh syllable (`ㄱ` then `ㅏ` instead of `가`), text mirrored after it did
 * not. Keeping the main range first puts every mirror after the caret. `null` when nothing has to
 * change. */
export function mainFirst(selection: EditorSelection): EditorSelection | null {
  return selection.ranges.length > 1 && selection.mainIndex !== 0
    ? EditorSelection.create(selection.ranges, 0)
    : null;
}

const keepMainFirst = EditorState.transactionFilter.of((tr) => {
  const next = tr.selection && mainFirst(tr.selection);
  return next ? [tr, { selection: next, sequential: true }] : tr;
});

/** The direct path's rewrite: the input method replaced `from`..`to`, which ends at the main range
 * and starts before it, with `text`, and CodeMirror moved the main range to `newMain`. Repeats the
 * rewrite at every other range that has the same text before it; a range that does not is left
 * alone. `null` when the change is not of that shape. */
export function mirrorReplacement(
  state: EditorState,
  from: number,
  to: number,
  text: string,
  newMain: SelectionRange,
): TransactionSpec | null {
  const { ranges, main } = state.selection;
  if (ranges.length < 2 || to !== main.to || from >= main.from) return null;
  const before = state.sliceDoc(from, main.from);
  const size = main.to - main.from;
  return state.changeByRange((range) => {
    if (range.from === main.from && range.to === main.to) {
      return { changes: { from, to, insert: text }, range: newMain };
    }
    const start = range.from - before.length;
    if (
      start < 0 ||
      range.to - range.from !== size ||
      state.sliceDoc(start, range.from) !== before
    ) {
      return { range };
    }
    const shift = range.to - main.to;
    return {
      changes: { from: start, to: range.to, insert: text },
      range: EditorSelection.range(newMain.anchor + shift, newMain.head + shift),
    };
  });
}

const mirrorDirectInput = EditorView.inputHandler.of((view, from, to, text, insert) => {
  if (view.compositionStarted) return false;
  const spec = mirrorReplacement(view.state, from, to, text, insert().newSelection.main);
  if (!spec) return false;
  view.dispatch(spec, { userEvent: "input.type", scrollIntoView: true });
  return true;
});

/** A composition in progress at the main range while the other ranges wait outside the
 * selection. Positions follow the document. */
export interface Composition {
  /** Where the composed text starts. Moves down if the composition takes text before the caret. */
  from: number;
  /** The text before the caret that the composition took over (`""` normally). At the end, a
   * waiting range gives up the same text before it — and only that text. */
  taken: string;
  /** The ranges the composed text goes to at the end, in document order after the main range. */
  others: readonly SelectionRange[];
}

const startComposition = StateEffect.define<Composition>();
const endComposition = StateEffect.define<null>();

const composition = StateField.define<Composition | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(startComposition)) value = effect.value;
      else if (effect.is(endComposition)) value = null;
    }
    if (!value) return null;
    // A click or a change from elsewhere (undo, a reload) ends the composition without an event.
    if (tr.isUserEvent("select.pointer") || (tr.docChanged && !tr.isUserEvent("input")))
      return null;
    if (!tr.docChanged) return value;
    let { from, taken } = value;
    if (tr.isUserEvent("input.type.compose")) {
      // A composition change reaching back before the composed text took that text over.
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA < from && toA >= from) {
          taken = tr.startState.sliceDoc(fromA, from) + taken;
          from = fromA;
        }
      });
    }
    return {
      from: tr.changes.mapPos(from, -1),
      taken,
      others: value.others.map((range) => range.map(tr.changes)),
    };
  },
});

/** The end of a composition: what the main range composed goes to every waiting range, and the
 * ranges come back. A composition that composed nothing gives the others nothing too. A waiting
 * range whose text before it is not what the composition took over is left as it is. */
export function compositionCommit(state: EditorState, current: Composition): TransactionSpec {
  const main = state.selection.main;
  const to = Math.max(main.to, current.from);
  const text = state.sliceDoc(current.from, to);
  const { taken } = current;
  const changes: ChangeSpec[] = [];
  const ranges = [main];
  let shift = 0;
  for (const range of current.others) {
    const from = range.from - taken.length;
    if (from < to || state.sliceDoc(from, range.from) !== taken) {
      ranges.push(EditorSelection.range(range.anchor + shift, range.head + shift));
      continue;
    }
    changes.push({ from, to: range.to, insert: text });
    ranges.push(EditorSelection.cursor(from + shift + text.length));
    shift += text.length - (range.to - from);
  }
  return {
    changes,
    selection: EditorSelection.create(ranges, 0),
    effects: endComposition.of(null),
    userEvent: "input.type.compose",
  };
}

/** Observers, not handlers: an extension's observers run before CodeMirror's built-in ones. At
 * compositionstart that matters because CodeMirror's deletes every non-empty selection when the
 * main one spans lines — collapsing first leaves it only the main range to delete. At
 * compositionend the document already holds the committed text (the mutation observer runs
 * between the input event and compositionend), and CodeMirror has not yet left composing, so the
 * mirrored changes land while the composition node is still protected. */
const compositionEvents = EditorView.domEventObservers({
  compositionstart(_event, view) {
    const { state } = view;
    const { main, ranges } = state.selection;
    if (state.field(composition) || ranges.length < 2) return;
    view.dispatch({
      selection: EditorSelection.create([main]),
      effects: startComposition.of({
        from: main.from,
        taken: "",
        others: ranges.filter((range) => range !== main),
      }),
      userEvent: "select",
    });
  },
  compositionend(_event, view) {
    const current = view.state.field(composition);
    if (current) view.dispatch(compositionCommit(view.state, current));
  },
});

/** CodeMirror ends a composition without a DOM compositionend when Safari forgets to send one:
 * an `insertText` during composition makes it call its own compositionend observer 20 ms later,
 * which our DOM observer never sees. A field left behind that way would copy whatever is typed
 * later at the main range to the waiting ranges. So the field is also settled from here: whenever
 * the composition field is set but CodeMirror is no longer composing, the commit runs. The check
 * waits a turn (dispatching inside an update is not allowed) and, after a document change while
 * composing, long enough for that 20 ms fallback. The start transaction itself is skipped —
 * CodeMirror only enters composing after our observer has run. */
const settleWithoutEvent = ViewPlugin.fromClass(
  class {
    private timer = -1;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (!update.state.field(composition)) return;
      if (update.transactions.some((tr) => tr.effects.some((e) => e.is(startComposition)))) return;
      if (!update.view.compositionStarted) this.settle(0);
      else if (update.docChanged) this.settle(50);
    }

    private settle(delay: number) {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        const current = this.view.state.field(composition, false);
        if (current && !this.view.compositionStarted) {
          this.view.dispatch(compositionCommit(this.view.state, current));
        }
      }, delay);
    }

    destroy() {
      clearTimeout(this.timer);
    }
  },
);

/** Gives every cursor and selection the input method's text. */
export const multiRangeIme = [
  keepMainFirst,
  mirrorDirectInput,
  composition,
  compositionEvents,
  settleWithoutEvent,
];
