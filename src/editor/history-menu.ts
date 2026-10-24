import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { redoWithCursors, undoWithCursors } from "./ime";

/** A field whose undo is WebKit's own: what the person typed into it. */
function isField(el: Element): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLIFrameElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/** The editor whose text has the keys. */
function editorWithKeys(active: Element | null): EditorView | null {
  if (!active?.closest(".cm-content")) return null;
  const editor = active.closest<HTMLElement>(".cm-editor");
  return editor && EditorView.findFromDOM(editor);
}

/** 편집 › 실행 취소·실행 복귀 (an app item, not the system one: src-tauri/src/app/menu.rs).
 * WebKit's undo stack only holds what the browser itself edited, never a CodeMirror transaction
 * (모두 바꾸기, a pasted text, Enter), so the editor with the keys steps through its own history.
 * Keys on nothing in particular (the page, the focused pane itself) mean that pane's editor, when
 * it shows one (`pane.editor`). A text field keeps WebKit's undo for its typing, which
 * `historyStaysWithTheKeys` keeps off the memos; so do the sidebar and the dialogs. */
export function runHistoryMenu(
  direction: "undo" | "redo",
  pane: { el: Element; editor: EditorView | null },
): void {
  const active = document.activeElement;
  const loose =
    !active || active === document.body || (pane.el.contains(active) && !isField(active));
  const view = editorWithKeys(active) ?? (loose ? pane.editor : null);
  if (view) (direction === "undo" ? undoWithCursors : redoWithCursors)(view);
  else document.execCommand(direction);
}

/** A WebKit undo or redo that lands in an editor without the keys is dropped: one step of WebKit's
 * stack is the editor's typing, which it reaches through the undo of a text field (its
 * `beforeinput` goes to the editor that typing was in, whatever has the keys). CodeMirror's history
 * would undo the memo then; the spec has a field's undo leave the memo alone. Ahead of
 * CodeMirror's own handler, which `history()` adds. */
export const historyStaysWithTheKeys = Prec.highest(
  EditorView.domEventHandlers({
    beforeinput(event, view) {
      if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return false;
      return !view.hasFocus;
    },
  }),
);
