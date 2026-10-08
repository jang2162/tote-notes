import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { AppController } from "../../src/app/controller";
import type { FakeBackend } from "../../src/backend/fake";
import type { askUnsaved, promptText, workspacePicker } from "../../src/ui/dialogs";

declare global {
  interface Window {
    view: EditorView;
    EditorSelection: typeof EditorSelection;
    askUnsaved: typeof askUnsaved;
    promptText: typeof promptText;
    workspacePicker: typeof workspacePicker;
    result: unknown;
    /** Set by src/main.ts when it runs on the fake backend. */
    __tote: { app: AppController; backend: FakeBackend; ready: boolean };
  }
}

export {};
