import { exitApp, recordResult } from "../lab-api";
import { MAX_TOKENIZED_LINE_LENGTH } from "./chunked-tokenizer";
import { makeCodeFixture, makeLogFixture, makeSingleLineJson } from "./fixtures";
import type { Engine, Lang, ThroughputResult, WorkerReply, WorkerRequest } from "./worker-protocol";

interface Case {
  label: string;
  lang: Lang;
  text: () => string;
  maxLineLength: number;
}

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
  // Same file without the line-length guard, to show what the 20,000-char limit protects against.
  {
    label: "json-10mb-one-line-nolimit",
    lang: "json",
    text: () => makeSingleLineJson(10_000_000),
    maxLineLength: 0,
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
    };
    const onMessage = (e: MessageEvent<WorkerReply>) => {
      if (e.data.type === "throughput-result" && e.data.id === req.id) {
        done();
        resolve(e.data);
      } else if (e.data.type === "error") {
        done();
        reject(new Error(e.data.message));
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("timeout after 120s"));
    }, 120_000);
    worker.addEventListener("message", onMessage);
    worker.postMessage(req);
  });
}

export async function runThroughputAuto(): Promise<void> {
  const worker = new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module" });
  const results: unknown[] = [];
  let id = 0;
  for (const engine of ENGINES) {
    for (const c of CASES) {
      const req: ThroughputRequest = {
        type: "throughput",
        id: ++id,
        label: c.label,
        engine,
        lang: c.lang,
        text: c.text(),
        maxLineLength: c.maxLineLength,
      };
      results.push(
        await call(worker, req).catch((err: unknown) => ({
          label: c.label,
          engine,
          error: String(err),
        })),
      );
    }
  }
  worker.terminate();
  await recordResult("throughput", { userAgent: navigator.userAgent, results });
  await exitApp();
}
