import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { IRawTheme } from "@shikijs/vscode-textmate";

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
    /** Editor page with `?highlight=1`: hands the worker a bundled theme file (by path) or a
     * theme as the tokenizer takes it. */
    highlightTheme(theme: string | IRawTheme): Promise<void>;
    /** Editor page with `?highlight=1`: the requests sent to the worker, without payloads. */
    workerLog: { type: string; doc?: number }[];
    askUnsaved: typeof askUnsaved;
    promptText: typeof promptText;
    workspacePicker: typeof workspacePicker;
    result: unknown;
    /** Set by src/main.ts when it runs on the fake backend. */
    __tote: { app: AppController; backend: FakeBackend; ready: boolean };
  }
}

export {};
