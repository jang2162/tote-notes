import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { askUnsaved, promptText, workspacePicker } from "../../src/ui/dialogs";

declare global {
  interface Window {
    view: EditorView;
    EditorSelection: typeof EditorSelection;
    askUnsaved: typeof askUnsaved;
    promptText: typeof promptText;
    workspacePicker: typeof workspacePicker;
    result: unknown;
  }
}

export {};
