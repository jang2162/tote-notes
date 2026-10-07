import { exitApp, recordResult } from "../lab-api";
import { MAX_TOKENIZED_LINE_LENGTH } from "./chunked-tokenizer";
import { makeCodeFixture, makeLogFixture, makeSingleLineJson } from "./fixtures";
import type { Engine, Lang, ThroughputResult, WorkerReply, WorkerRequest } from "./worker-protocol";

interface Case {
  label: string;
  lang: Lang;
  text: () => string;
  maxLineLength: number;
  timeLimit?: number;
}

const CASE_TIMEOUT_MS = 120_000;

const CASES: Case[] = [
  {
    label: "code-1mb",
    lang: "typescript",
    text: () => makeCodeFixture(1_000_000),
    maxLineLength: MAX_TOKENIZED_LINE_LENGTH,
  },
  {
    label: "code-10mb",
    lang: "typescript",
    text: () => makeCodeFixture(10_000_000),
    maxLineLength: MAX_TOKENIZED_LINE_LENGTH,
  },
  {
    label: "json-10mb-one-line",
    lang: "json",
    text: () => makeSingleLineJson(10_000_000),
    maxLineLength: MAX_TOKENIZED_LINE_LENGTH,
  },
  // Same file with neither the line-length guard nor Shiki's per-line time limit, to show what the
  // 20,000-char limit protects against; the case timeout is the only bound.
  {
    label: "json-10mb-one-line-nolimit",
    lang: "json",
    text: () => makeSingleLineJson(10_000_000),
    maxLineLength: 0,
    timeLimit: 0,
  },
  {
    label: "log-100k",
    lang: "log",
    text: () => makeLogFixture(100_000),
    maxLineLength: MAX_TOKENIZED_LINE_LENGTH,
  },
];

const ENGINES: Engine[] = ["javascript", "oniguruma"];

type ThroughputRequest = Extract<WorkerRequest, { type: "throughput" }>;

function call(worker: Worker, req: ThroughputRequest): Promise<ThroughputResult> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    const onMessage = (e: MessageEvent<WorkerReply>) => {
      const msg = e.data;
      if (msg.type === "throughput-result" && msg.id === req.id) {
        done();
        resolve(msg);
      } else if (msg.type === "error" && msg.id === req.id) {
        done();
        reject(new Error(msg.message));
      }
    };
    // A worker that fails to load never replies, so without this the case would wait out the timeout.
    const onError = (e: ErrorEvent) => {
      done();
      reject(new Error(`worker error: ${e.message}`));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`timeout after ${CASE_TIMEOUT_MS / 1000}s`));
    }, CASE_TIMEOUT_MS);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(req);
  });
}

export async function runThroughputAuto(): Promise<void> {
  // A hidden window is where macOS throttles the page; record every change so it shows next to the timings.
  const visibilityChanges: { at: number; state: DocumentVisibilityState }[] = [];
  // Whether the page was hidden at any moment of the current case, generation included.
  let hiddenDuringCase = false;
  const onVisibility = () => {
    visibilityChanges.push({ at: performance.now(), state: document.visibilityState });
    if (document.visibilityState === "hidden") hiddenDuringCase = true;
  };
  document.addEventListener("visibilitychange", onVisibility);

  const results: unknown[] = [];
  let id = 0;
  for (const engine of ENGINES) {
    for (const c of CASES) {
      hiddenDuringCase = document.visibilityState === "hidden";
      const g0 = performance.now();
      const text = c.text();
      const generateMs = performance.now() - g0;
      const req: ThroughputRequest = {
        type: "throughput",
        id: ++id,
        label: c.label,
        engine,
        lang: c.lang,
        text,
        maxLineLength: c.maxLineLength,
        timeLimit: c.timeLimit,
      };
      // A fresh worker per case: a timed-out case is killed instead of running on into the next
      // case's window, and every case pays the same cold start, reported as highlighterMs/warmupMs.
      const worker = new Worker(new URL("./highlight-worker.ts", import.meta.url), {
        type: "module",
      });
      const postedAt = performance.now();
      const visibilityAtPost = document.visibilityState;
      const outcome = await call(worker, req).catch((err: unknown) => ({
        type: "error" as const,
        error: String(err),
      }));
      const receivedAt = performance.now();
      worker.terminate();
      results.push({
        id: req.id,
        label: c.label,
        engine,
        lang: c.lang,
        maxLineLength: c.maxLineLength,
        timeLimit: c.timeLimit ?? null,
        generateMs,
        postedAt,
        receivedAt,
        wallMs: receivedAt - postedAt,
        visibilityAtPost,
        visibilityAtReceive: document.visibilityState,
        // A hidden page gets its content process throttled, which skews timings and can even cut
        // tokens short through Shiki's wall-clock time limit.
        valid: !hiddenDuringCase && document.visibilityState === "visible",
        ...outcome,
      });
    }
  }

  document.removeEventListener("visibilitychange", onVisibility);
  await recordResult("throughput", {
    userAgent: navigator.userAgent,
    workerPerCase: true,
    visibilityChanges,
    results,
  });
  await exitApp();
}
