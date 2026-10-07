import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

import { ChunkedTokenizer } from "./chunked-tokenizer";
import { TS_SAMPLE, makeLogFixture, makeSingleLineJson } from "./fixtures";
import type { Engine, Lang, WorkerReply, WorkerRequest } from "./worker-protocol";

const THEME = "github-dark";
const MIN_LINES_FOR_RATE = 1_000;
const highlighters = new Map<Engine, Promise<HighlighterCore>>();
let live: ChunkedTokenizer | null = null;

// Short inputs per language: the grammar regexes compile on first use, and this keeps that one-off
// cost out of the measured run.
const WARMUP: Record<Lang, () => string> = {
  typescript: () => TS_SAMPLE,
  json: () => makeSingleLineJson(500),
  log: () => makeLogFixture(20),
};

function highlighter(engine: Engine): Promise<HighlighterCore> {
  const cached = highlighters.get(engine);
  if (cached) return cached;
  const hl = createHighlighterCore({
    themes: [import("@shikijs/themes/github-dark")],
    langs: [
      import("@shikijs/langs/typescript"),
      import("@shikijs/langs/json"),
      import("@shikijs/langs/log"),
    ],
    engine:
      engine === "javascript"
        ? createJavaScriptRegexEngine()
        : createOnigurumaEngine(import("shiki/wasm")),
  });
  highlighters.set(engine, hl);
  // A rejected promise left in the map would fail every later request for this engine.
  hl.catch(() => highlighters.delete(engine));
  return hl;
}

// The DOM lib types `self` as Window, whose postMessage wants a target origin; a worker's does not.
const reply = (msg: WorkerReply) =>
  (self as unknown as { postMessage(m: WorkerReply): void }).postMessage(msg);

const requestIds = (req: WorkerRequest) =>
  req.type === "throughput" ? { id: req.id } : req.type === "tokens" ? { reqId: req.reqId } : {};

// Handled strictly in order so an `edit` can never interleave with a `tokens` request.
let queue: Promise<void> = Promise.resolve();
self.addEventListener("message", (e: MessageEvent<WorkerRequest>) => {
  queue = queue
    .then(() => handle(e.data))
    .catch((err: unknown) => reply({ type: "error", ...requestIds(e.data), message: String(err) }));
});

async function handle(req: WorkerRequest): Promise<void> {
  switch (req.type) {
    case "throughput": {
      const h0 = performance.now();
      const hl = await highlighter(req.engine);
      const highlighterMs = performance.now() - h0;
      const opts = {
        lang: req.lang,
        theme: THEME,
        maxLineLength: req.maxLineLength,
        timeLimit: req.timeLimit,
      };
      const w0 = performance.now();
      const sample = new ChunkedTokenizer(hl, WARMUP[req.lang](), opts);
      sample.tokens(0, sample.lineCount);
      const warmupMs = performance.now() - w0;
      const t0 = performance.now();
      const tk = new ChunkedTokenizer(hl, req.text, opts);
      const viewport = tk.tokens(0, 100);
      const firstViewportMs = performance.now() - t0;
      // Asking for the last lines forces every chunk state, i.e. a jump to the end of the file.
      tk.tokens(Math.max(0, tk.lineCount - 100), tk.lineCount);
      const fullMs = performance.now() - t0;
      reply({
        type: "throughput-result",
        id: req.id,
        label: req.label,
        engine: req.engine,
        lang: req.lang,
        maxLineLength: req.maxLineLength,
        timeLimit: req.timeLimit ?? null,
        lines: tk.lineCount,
        highlighterMs,
        warmupMs,
        firstViewportMs,
        fullMs,
        linesPerSec: tk.lineCount >= MIN_LINES_FOR_RATE ? tk.lineCount / (fullMs / 1000) : null,
        viewportTokens: viewport.reduce((n, l) => n + l.length, 0),
      });
      return;
    }
    case "open":
      // Cleared first so a failed open never leaves later edits and tokens on the previous document.
      live = null;
      live = new ChunkedTokenizer(await highlighter(req.engine), req.text, {
        lang: req.lang,
        theme: THEME,
      });
      return;
    case "edit":
      live?.edit(req.fromLine, req.toLine, req.insert);
      return;
    case "tokens":
      if (!live) throw new Error("tokens requested with no open document");
      reply({
        type: "tokens-result",
        reqId: req.reqId,
        from: req.from,
        lines: live.tokens(req.from, req.to),
      });
      return;
  }
}
