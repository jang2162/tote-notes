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
  lines: number;
  firstViewportMs: number;
  fullMs: number;
  linesPerSec: number;
  viewportTokens: number;
}

export type WorkerReply =
  | ThroughputResult
  | { type: "tokens-result"; reqId: number; from: number; lines: LineToken[][] }
  | { type: "error"; message: string };
