import type { IRawTheme } from "@shikijs/vscode-textmate";

/** A grammar file's text as it was read: the worker parses it, so a big grammar (markdown's, with
 * every language its fences include) never holds up the thread that takes the keystrokes. */
export interface GrammarSource {
  scopeName: string;
  text: string;
}

/** Main thread → worker. Documents are numbered by the main thread. */
export type WorkerRequest =
  | { type: "theme"; theme: IRawTheme }
  /** Answered with `grammars-ready`. */
  | { type: "grammars"; grammars: GrammarSource[] }
  /** The extension set changed: drop every grammar the worker holds, including the ones its
   * vscode-textmate registry cached, so the next ones sent are the ones used. */
  | { type: "forget-grammars" }
  | { type: "open"; doc: number; scopeName: string; text: string }
  | { type: "edit"; doc: number; fromLine: number; toLine: number; insert: string[] }
  /** `cached`: answer from the line states the worker has, never by catching up to `from` first
   * (a guess and `pending` when they do not reach it). Without it, the worker catches up. */
  | { type: "tokens"; doc: number; req: number; from: number; to: number; mode?: "cached" }
  /** The documents on screen: they are worked ahead first and to their end; the others only as
   * far as they were ever shown. */
  | { type: "visible"; docs: number[] }
  | { type: "stats"; doc: number; req: number }
  | { type: "close"; doc: number };

/** Worker → main thread. A line's tokens are `[start, foregroundId, fontStyle]` triples;
 * `foregroundId` indexes the colour map sent with `theme-ready`. */
export type WorkerReply =
  | { type: "theme-ready"; colorMap: string[] }
  /** The scopes the grammars just sent include that the worker does not hold yet. */
  | { type: "grammars-ready"; includes: string[] }
  | { type: "opened"; doc: number; ok: boolean; message?: string }
  /** `pending`: the lines are a guess; `ready` follows once the line states reach `from`. */
  | {
      type: "tokens";
      doc: number;
      req: number;
      from: number;
      lines: Uint32Array[];
      pending?: boolean;
    }
  | { type: "ready"; doc: number; from: number }
  | { type: "stats"; req: number; cachedLines: number }
  | { type: "error"; doc?: number; req?: number; message: string };
