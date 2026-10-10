import type { IRawGrammar, IRawTheme } from "@shikijs/vscode-textmate";

export interface GrammarSource {
  scopeName: string;
  grammar: IRawGrammar;
}

/** Main thread → worker. Documents are numbered by the main thread. */
export type WorkerRequest =
  | { type: "theme"; theme: IRawTheme }
  | { type: "grammars"; grammars: GrammarSource[] }
  /** The extension set changed: drop every grammar the worker holds, including the ones its
   * vscode-textmate registry cached, so the next ones sent are the ones used. */
  | { type: "forget-grammars" }
  | { type: "open"; doc: number; scopeName: string; text: string }
  | { type: "edit"; doc: number; fromLine: number; toLine: number; insert: string[] }
  | { type: "tokens"; doc: number; req: number; from: number; to: number }
  | { type: "close"; doc: number };

/** Worker → main thread. A line's tokens are `[start, foregroundId, fontStyle]` triples;
 * `foregroundId` indexes the colour map sent with `theme-ready`. */
export type WorkerReply =
  | { type: "theme-ready"; colorMap: string[] }
  | { type: "opened"; doc: number; ok: boolean; message?: string }
  | { type: "tokens"; doc: number; req: number; from: number; lines: Uint32Array[] }
  | { type: "error"; doc?: number; req?: number; message: string };
