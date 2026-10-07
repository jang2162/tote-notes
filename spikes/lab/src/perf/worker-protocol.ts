import type { LineToken } from "./chunked-tokenizer";

export type Engine = "javascript" | "oniguruma";
export type Lang = "typescript" | "json" | "log";

export type WorkerRequest =
  | {
      type: "throughput";
      id: number;
      label: string;
      engine: Engine;
      lang: Lang;
      text: string;
      maxLineLength: number;
      /** Left out to keep Shiki's default per-line time limit. */
      timeLimit?: number;
    }
  | { type: "open"; engine: Engine; lang: Lang; text: string }
  | { type: "edit"; fromLine: number; toLine: number; insert: string[] }
  | { type: "tokens"; reqId: number; from: number; to: number };

export interface ThroughputResult {
  type: "throughput-result";
  id: number;
  label: string;
  engine: Engine;
  lang: Lang;
  maxLineLength: number;
  /** null when the request left it out, so Shiki's default (500 ms in 4.5.0) applied. */
  timeLimit: number | null;
  lines: number;
  /** Creating the highlighter: loading grammars and the regex engine. */
  highlighterMs: number;
  /** Tokenizing a small sample of the same language first, which compiles the grammar regexes. */
  warmupMs: number;
  firstViewportMs: number;
  fullMs: number;
  /** null when there are too few lines for a rate to mean anything at 1 ms timer resolution. */
  linesPerSec: number | null;
  viewportTokens: number;
}

export type WorkerReply =
  | ThroughputResult
  | { type: "tokens-result"; reqId: number; from: number; lines: LineToken[][] }
  // Carries the id of the request that failed, so a caller never takes another request's error.
  | { type: "error"; id?: number; reqId?: number; message: string };
