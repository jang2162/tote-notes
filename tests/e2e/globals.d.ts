import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

declare global {
  interface Window {
    view: EditorView;
    EditorSelection: typeof EditorSelection;
  }
}

export {};
