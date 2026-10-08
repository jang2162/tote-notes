import { EditorState } from "@codemirror/state";
import { EditorView, rectangularSelection, type MouseSelectionStyle } from "@codemirror/view";

// CodeMirror's own rectangle gesture, taken from its facet: its geometry is kept, and only the
// choice between adding to the selection and replacing it is made here.
const rectangle = EditorState.create({ extensions: rectangularSelection() }).facet(
  EditorView.mouseSelectionStyle,
)[0];

/** A move this small is still a click (trackpads jitter). */
const DRAG_THRESHOLD_PX = 4;

/** ⌥click adds a cursor; ⌥drag selects a rectangle that replaces the selection (spec 「편집기」).
 * CodeMirror alone adds the rectangle to the selection, which leaves the cursor from the click
 * before it behind as a stray extra cursor. */
export function altMouseSelection() {
  return EditorView.mouseSelectionStyle.of((view, start) => {
    if (!start.altKey || start.button !== 0) return null;
    const style = rectangle(view, start);
    if (!style) return null;
    return {
      update: (update) => style.update(update),
      get(current, extend) {
        const moved =
          Math.abs(current.clientX - start.clientX) + Math.abs(current.clientY - start.clientY);
        return style.get(current, extend, moved <= DRAG_THRESHOLD_PX);
      },
    } satisfies MouseSelectionStyle;
  });
}
