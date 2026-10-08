import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** The selection to keep when an IME composition starts. WKWebView feeds the composition to the
 * main selection only and leaves stray jamo at the others, so the others go first (spec 「편집기」,
 * spike report 「한글 입력」). `null` when there is nothing to drop. */
export function compositionSelection(selection: EditorSelection): EditorSelection | null {
  return selection.ranges.length > 1 ? EditorSelection.create([selection.main]) : null;
}

export const collapseSelectionOnComposition = EditorView.domEventHandlers({
  compositionstart(_event, view) {
    const next = compositionSelection(view.state.selection);
    if (next) view.dispatch({ selection: next, userEvent: "select" });
    // CodeMirror still runs its own composition handling.
    return false;
  },
});
