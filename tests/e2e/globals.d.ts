import type { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { IRawTheme } from "@shikijs/vscode-textmate";

import type { AppController } from "../../src/app/controller";
import type { FakeBackend } from "../../src/backend/fake";
import type { askUnsaved, pickLanguage, promptText, workspacePicker } from "../../src/ui/dialogs";
import type { HighlightClient } from "../../src/highlight/client";
import type { BackendError, LanguageInfo, TextQuery, TextSearch } from "../../src/backend/types";
import type { ViewerHost } from "../../src/viewer/host";
import type { LargeTextViewer } from "../../src/viewer/large-text";

declare global {
  interface Window {
    view: EditorView;
    EditorSelection: typeof EditorSelection;
    EditorState: typeof EditorState;
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
    /** Editor page: destroys the view and closes its document in the worker, as closing a tab does. */
    closeDoc(): void;
    /** Editor page with `?highlight=1`: the client of the worker, the text served for a path
     * instead of the bundled file, and the language of `?file=`. */
    highlightClient: HighlightClient;
    fileOverride: Record<string, string>;
    highlightLang: LanguageInfo;
    askUnsaved: typeof askUnsaved;
    promptText: typeof promptText;
    workspacePicker: typeof workspacePicker;
    pickLanguage: typeof pickLanguage;
    result: unknown;
    /** Set by tests/e2e/pages/viewer.ts. */
    viewerHost: ViewerHost;
    /** Set by tests/e2e/pages/large-text.ts. */
    largeTextViewer: LargeTextViewer;
    searchCalls: {
      query: TextQuery;
      fromLine: number;
      resolve(result: TextSearch): void;
      reject(error: unknown): void;
    }[];
    /** The Range requests the viewer made, as [first byte, last byte]. */
    fetchLog: [number, number][];
    BackendError: typeof BackendError;
    lineText(line: number): string;
    /** Set by src/main.ts when it runs on the fake backend. */
    __tote: { app: AppController; backend: FakeBackend; ready: boolean };
  }
}

export {};
