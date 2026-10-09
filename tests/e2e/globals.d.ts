import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { AppController } from "../../src/app/controller";
import type { FakeBackend } from "../../src/backend/fake";
import type { askUnsaved, promptText, workspacePicker } from "../../src/ui/dialogs";

declare global {
  interface Window {
    view: EditorView;
    EditorSelection: typeof EditorSelection;
    /** The input-method stand-in from tests/e2e/pages/editor.ts. */
    ime: {
      insertText(text: string): Promise<void>;
      replaceBefore(count: number, text: string): Promise<void>;
      start(): Promise<void>;
      update(data: string): Promise<void>;
      restart(): Promise<void>;
      end(how: "replace" | "bare" | "cancel"): Promise<void>;
    };
    askUnsaved: typeof askUnsaved;
    promptText: typeof promptText;
    workspacePicker: typeof workspacePicker;
    result: unknown;
    /** Set by src/main.ts when it runs on the fake backend. */
    __tote: { app: AppController; backend: FakeBackend; ready: boolean };
  }
}

export {};
