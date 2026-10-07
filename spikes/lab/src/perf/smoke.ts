import { exitApp, recordResult } from "../lab-api";
import { makeCodeFixture } from "./fixtures";
import { openEditor } from "./latency-page";
import { decorationsIn, highlightCount } from "./shiki-decorations";
import type { WorkerReply } from "./worker-protocol";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (pred()) return true;
    await wait(50);
  }
  return pred();
}

const INSERT = "/* edit */\n";
const ERROR_REQ_ID = 4242;

/** A separate worker gets `tokens` with no `open`: its `error` reply must carry the same reqId. */
async function workerErrorReqIdMatches(): Promise<boolean> {
  const worker = new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      worker.addEventListener("message", (e: MessageEvent<WorkerReply>) => {
        if (e.data.type !== "error") return;
        clearTimeout(timer);
        resolve(e.data.reqId === ERROR_REQ_ID);
      });
      worker.postMessage({ type: "tokens", reqId: ERROR_REQ_ID, from: 0, to: 1 });
    });
  } finally {
    worker.terminate();
  }
}

/** Proves the editor ↔ worker pipeline end to end without a human: open, highlight, edit, re-highlight. */
export async function runSmokeAuto(parent: HTMLElement): Promise<void> {
  const visibilityAtStart = document.visibilityState;
  let hiddenDuringRun = visibilityAtStart === "hidden";
  const onVisibility = () => {
    if (document.visibilityState === "hidden") hiddenDuringRun = true;
  };
  document.addEventListener("visibilitychange", onVisibility);

  const editor = await openEditor(parent, makeCodeFixture(10_000_000), "oniguruma", "typescript");
  const highlightedOnOpen = await waitFor(() => highlightCount(editor.view) > 0, 15_000);
  const before = editor.view.state.doc.length;
  for (let i = 0; i < 20; i++) {
    editor.view.dispatch({ changes: { from: 0, insert: INSERT } });
  }
  // Mapped old marks never cover text inserted at their start, so color here must come from a fresh reply.
  const insertedTextHighlighted = await waitFor(
    () => decorationsIn(editor.view, 0, INSERT.length) > 0,
    15_000,
  );
  const errorReqIdMatches = await workerErrorReqIdMatches();

  document.removeEventListener("visibilitychange", onVisibility);
  const visibilityAtEnd = document.visibilityState;
  await recordResult("smoke", {
    userAgent: navigator.userAgent,
    // Weak: rAF stalls in a covered window and openEditor falls back to a 1 s timer. Not a criterion.
    openMs: editor.openMs,
    highlightedOnOpen,
    insertedTextHighlighted,
    workerErrorReqIdMatches: errorReqIdMatches,
    docGrewBy: editor.view.state.doc.length - before,
    decorations: highlightCount(editor.view),
    visibilityAtStart,
    visibilityAtEnd,
    hiddenDuringRun,
    // Only says the page was never hidden; other load can still skew timings.
    valid: !hiddenDuringRun && visibilityAtEnd === "visible",
  });
  editor.destroy();
  await exitApp();
}
