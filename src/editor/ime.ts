import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** The selection to keep when an IME composition starts. WKWebView feeds the composition to the
 * main selection only and leaves stray jamo at the others, so the others go first (spec 「편집기」,
 * spike report 「한글 입력」). `null` when there is nothing to drop. */
export function compositionSelection(selection: EditorSelection): EditorSelection | null {
  return selection.ranges.length > 1 ? EditorSelection.create([selection.main]) : null;
}

/** An observer, not a handler: an extension's observers run before CodeMirror's built-in ones, and
 * its `compositionstart` observer deletes every non-empty selection when the main one spans lines.
 * Collapsing first leaves it only the main selection to delete. */
export const collapseSelectionOnComposition = EditorView.domEventObservers({
  compositionstart(_event, view) {
    const next = compositionSelection(view.state.selection);
    if (next) view.dispatch({ selection: next, userEvent: "select" });
  },
});
