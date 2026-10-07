import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

import { ChunkedTokenizer } from "./chunked-tokenizer";
import type { Engine, WorkerReply, WorkerRequest } from "./worker-protocol";

const THEME = "github-dark";
const highlighters = new Map<Engine, Promise<HighlighterCore>>();
let live: ChunkedTokenizer | null = null;

function highlighter(engine: Engine): Promise<HighlighterCore> {
  let hl = highlighters.get(engine);
  if (!hl) {
    hl = createHighlighterCore({
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
  }
  return hl;
}

// The DOM lib types `self` as Window, whose postMessage wants a target origin; a worker's does not.
const reply = (msg: WorkerReply) =>
  (self as unknown as { postMessage(m: WorkerReply): void }).postMessage(msg);

// Handled strictly in order so an `edit` can never interleave with a `tokens` request.
let queue: Promise<void> = Promise.resolve();
self.addEventListener("message", (e: MessageEvent<WorkerRequest>) => {
  queue = queue
    .then(() => handle(e.data))
    .catch((err: unknown) => reply({ type: "error", message: String(err) }));
});

async function handle(req: WorkerRequest): Promise<void> {
  switch (req.type) {
    case "throughput": {
      const hl = await highlighter(req.engine);
      const t0 = performance.now();
      const tk = new ChunkedTokenizer(hl, req.text, {
        lang: req.lang,
        theme: THEME,
        maxLineLength: req.maxLineLength,
      });
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
        lines: tk.lineCount,
        firstViewportMs,
        fullMs,
        linesPerSec: tk.lineCount / (fullMs / 1000),
        viewportTokens: viewport.reduce((n, l) => n + l.length, 0),
      });
      return;
    }
    case "open":
      live = new ChunkedTokenizer(await highlighter(req.engine), req.text, {
        lang: req.lang,
        theme: THEME,
      });
      return;
    case "edit":
      live?.edit(req.fromLine, req.toLine, req.insert);
      return;
    case "tokens":
      if (live) {
        reply({
          type: "tokens-result",
          reqId: req.reqId,
          from: req.from,
          lines: live.tokens(req.from, req.to),
        });
      }
      return;
  }
}
