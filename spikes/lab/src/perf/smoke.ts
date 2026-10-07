import { EditorView } from "codemirror";

import { exitApp, recordResult } from "../lab-api";
import { makeCodeFixture } from "./fixtures";
import { openEditor } from "./latency-page";
import {
  decorationsIn,
  highlightCount,
  lineDecorations,
  workerHighlighting,
} from "./shiki-decorations";
import type { WorkerReply, WorkerRequest } from "./worker-protocol";

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

/**
 * A tokens reply for a document that has since been edited must not be painted: tokens#1 goes out,
 * a line is inserted at the top, then the reply for tokens#1 arrives. Expect no decorations and
 * exactly one new tokens request.
 */
async function staleReplyDiscarded(parent: HTMLElement): Promise<boolean> {
  const sent: WorkerRequest[] = [];
  const hook: { listener: ((e: MessageEvent<WorkerReply>) => void) | null } = { listener: null };
  const fake = {
    postMessage: (m: WorkerRequest) => sent.push(m),
    addEventListener: (_: string, l: (e: MessageEvent<WorkerReply>) => void) => {
      hook.listener = l;
    },
    removeEventListener: () => {
      hook.listener = null;
    },
  } as unknown as Worker;
  const host = document.createElement("div");
  parent.append(host);
  const view = new EditorView({
    doc: "aaaa\nbbbb\ncccc",
    parent: host,
    extensions: workerHighlighting(fake, "oniguruma", "typescript"),
  });
  try {
    if (!(await waitFor(() => sent.some((m) => m.type === "tokens"), 5_000))) return false;
    const first = sent.find((m) => m.type === "tokens");
    if (first?.type !== "tokens") return false;
    view.dispatch({ changes: { from: 0, insert: "XX\n" } });
    const token = (content: string) => [{ content, offset: 0, color: "#ff0000" }];
    hook.listener?.({
      data: {
        type: "tokens-result",
        reqId: first.reqId,
        from: 0,
        lines: [token("aaaa"), token("bbbb"), token("cccc")],
      },
    } as MessageEvent<WorkerReply>);
    const decorationsAfterStale = highlightCount(view);
    await wait(300);
    const requestsAfterEdit = sent.slice(sent.findIndex((m) => m.type === "edit") + 1);
    return (
      decorationsAfterStale === 0 &&
      requestsAfterEdit.filter((m) => m.type === "tokens").length === 1
    );
  } finally {
    view.destroy();
    host.remove();
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
  // The first line is dispatched down to line 21 below; a worker that applied the edits colors it
  // the same way afterwards, while one that dropped them colors it as whatever was on line 21.
  const firstLineBefore = lineDecorations(editor.view, 1);
  for (let i = 0; i < 20; i++) {
    editor.view.dispatch({ changes: { from: 0, insert: INSERT } });
  }
  // Mapped old marks never cover text inserted at their start, so color here must come from a fresh reply.
  const insertedTextHighlighted = await waitFor(
    () => decorationsIn(editor.view, 0, INSERT.length) > 0,
    15_000,
  );
  // Read once, right after the fresh reply: marks mapped through the edits would match earlier.
  const movedLineAfter = lineDecorations(editor.view, 21);
  const editedLinesKeepColors =
    firstLineBefore.length > 0 &&
    JSON.stringify(movedLineAfter) === JSON.stringify(firstLineBefore);
  const errorReqIdMatches = await workerErrorReqIdMatches();
  const staleDiscarded = await staleReplyDiscarded(parent);

  document.removeEventListener("visibilitychange", onVisibility);
  const visibilityAtEnd = document.visibilityState;
  await recordResult("smoke", {
    userAgent: navigator.userAgent,
    // Weak: rAF stalls in a covered window and openEditor falls back to a 1 s timer. Not a criterion.
    openMs: editor.openMs,
    highlightedOnOpen,
    insertedTextHighlighted,
    workerErrorReqIdMatches: errorReqIdMatches,
    editedLinesKeepColors,
    staleReplyDiscarded: staleDiscarded,
    firstLineBefore,
    movedLineAfter,
    workerErrors: editor.workerErrors(),
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
