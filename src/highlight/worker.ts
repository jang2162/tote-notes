import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import {
  Registry,
  type IGrammar,
  type IOnigLib,
  type IRawGrammar,
  type IRawTheme,
} from "@shikijs/vscode-textmate";

import { parseJsonc } from "../core/jsonc";
import { collectIncludes } from "./grammars";
import type { WorkerReply, WorkerRequest } from "./protocol";
import { LineTokenizer } from "./tokenizer";

/** Tokenization off the input path (spec 「성능」): grammars, theme and documents live here;
 * the main thread asks for the tokens of the lines it shows. Requests are handled in order so
 * an edit can never interleave with the tokens of the document it changes. */

/** How long one background slice tokenizes before the worker answers its messages again. */
const SLICE_MS = 15;

interface OpenDoc {
  tokenizer: LineTokenizer;
  /** The end of the farthest viewport asked for: as far as the document goes while hidden. */
  shownTo: number;
  /** First lines of guesses whose `ready` has not gone yet. */
  guessed: Set<number>;
}

const grammars = new Map<string, IRawGrammar>();
const loaded = new Map<string, IGrammar | null>();
const docs = new Map<number, OpenDoc>();
/** The documents on screen, from the last `visible`. */
let visible: number[] = [];
let advancing = false;

let onigLib: IOnigLib;
let lastTheme: IRawTheme | null = null;

const makeRegistry = () =>
  new Registry({ onigLib, loadGrammar: (scope) => grammars.get(scope) ?? null });

// The inlined WASM needs no fetch, so the worker works the same from the dev server, the app's
// protocol and a test runner.
let registry: Promise<Registry> = createOnigurumaEngine(
  import("@shikijs/engine-oniguruma/wasm-inlined"),
).then((engine) => {
  onigLib = {
    createOnigScanner: (sources) => engine.createScanner(sources),
    createOnigString: (s) => engine.createString(s),
  };
  return makeRegistry();
});

const reply = (message: WorkerReply) =>
  (self as unknown as { postMessage(m: WorkerReply): void }).postMessage(message);

// Listening starts at once and every request waits in this chain for the engine: a message that
// arrives while the WASM compiles would otherwise be dropped, and the promise the main thread
// holds for it would never settle. The chain also keeps the requests in order.
let queue: Promise<void> = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      const next = handle(await registry, request);
      if (next) registry = Promise.resolve(next);
    } catch (error) {
      reply(failure(request, String(error)));
    }
  });
});

/** The answer to a request that threw. Whoever waits on it is answered, so nothing hangs: a
 * theme that cannot be used leaves no colours (the text stays plain), a document that cannot be
 * opened stays uncoloured. */
function failure(request: WorkerRequest, message: string): WorkerReply {
  console.warn(`highlight worker: ${request.type} failed`, message);
  if (request.type === "theme") return { type: "theme-ready", colorMap: [] };
  if (request.type === "grammars") return { type: "grammars-ready", includes: [] };
  if (request.type === "open") return { type: "opened", doc: request.doc, ok: false, message };
  return {
    type: "error",
    doc: "doc" in request ? request.doc : undefined,
    req: "req" in request ? request.req : undefined,
    message,
  };
}

/** Returns the registry that replaces `registry`, when a request makes it. */
function handle(registry: Registry, request: WorkerRequest): Registry | void {
  switch (request.type) {
    case "theme":
      lastTheme = request.theme;
      registry.setTheme(request.theme);
      // Colour ids changed with the theme: every cached state is stale.
      for (const doc of docs.values()) doc.tokenizer.reset();
      reply({ type: "theme-ready", colorMap: registry.getColorMap() });
      scheduleAdvance();
      return;
    case "grammars": {
      // Parsed here, not on the main thread (the keystrokes' thread). A grammar that does not
      // parse is left out: a document of its language then opens uncoloured.
      const includes = new Set<string>();
      for (const source of request.grammars) {
        try {
          const grammar = parseJsonc<IRawGrammar>(source.text);
          grammars.set(source.scopeName, grammar);
          loaded.delete(source.scopeName);
          for (const scope of collectIncludes(grammar)) includes.add(scope);
        } catch (error) {
          console.warn(`grammar ${source.scopeName} could not be parsed`, error);
        }
      }
      reply({
        type: "grammars-ready",
        includes: [...includes].filter((scope) => !grammars.has(scope)),
      });
      return;
    }
    case "forget-grammars": {
      // A vscode-textmate registry never asks again for a scope it has loaded, so a replaced
      // grammar is only used by a new registry. Documents already open keep their own grammar;
      // the same theme gives the new registry the same colour ids.
      grammars.clear();
      loaded.clear();
      const fresh = makeRegistry();
      if (lastTheme) fresh.setTheme(lastTheme);
      return fresh;
    }
    case "open": {
      const grammar = grammarFor(registry, request.scopeName);
      if (!grammar) {
        reply({
          type: "opened",
          doc: request.doc,
          ok: false,
          message: `no grammar for ${request.scopeName}`,
        });
        return;
      }
      docs.set(request.doc, {
        tokenizer: new LineTokenizer(grammar, request.text),
        shownTo: 0,
        guessed: new Set(),
      });
      reply({ type: "opened", doc: request.doc, ok: true });
      scheduleAdvance();
      return;
    }
    case "edit":
      docs.get(request.doc)?.tokenizer.edit(request.fromLine, request.toLine, request.insert);
      scheduleAdvance();
      return;
    case "tokens": {
      const doc = docs.get(request.doc);
      if (!doc) throw new Error("tokens requested for a document that is not open");
      const { doc: id, req, from, to } = request;
      if (request.mode !== "cached") {
        reply({ type: "tokens", doc: id, req, from, lines: doc.tokenizer.tokens(from, to) });
        return;
      }
      doc.shownTo = Math.max(doc.shownTo, to);
      const lines = doc.tokenizer.tokensIfCached(from, to);
      if (lines) {
        reply({ type: "tokens", doc: id, req, from, lines });
        return;
      }
      // Catching up to a far viewport takes as long as tokenizing everything above it (seconds
      // on a big file), so it goes on in slices and a guess colours the viewport meanwhile.
      doc.guessed.add(from);
      reply({
        type: "tokens",
        doc: id,
        req,
        from,
        lines: doc.tokenizer.guessTokens(from, to),
        pending: true,
      });
      scheduleAdvance();
      return;
    }
    case "visible":
      visible = request.docs;
      scheduleAdvance();
      return;
    case "stats": {
      const doc = docs.get(request.doc);
      if (!doc) throw new Error("stats requested for a document that is not open");
      reply({ type: "stats", req: request.req, cachedLines: doc.tokenizer.cachedLines });
      return;
    }
    case "close":
      docs.delete(request.doc);
      return;
  }
}

function grammarFor(registry: Registry, scopeName: string): IGrammar | null {
  if (!loaded.has(scopeName)) {
    try {
      loaded.set(scopeName, registry.loadGrammar(scopeName));
    } catch (error) {
      console.warn(`grammar ${scopeName} failed to load`, error);
      loaded.set(scopeName, null);
    }
  }
  return loaded.get(scopeName) ?? null;
}

/** Background tokenization (spec 「크기별 단계」: files up to the highlight limit are tokenized
 * from the top in slices, so a far jump finds its states ready). One slice at a time goes to one
 * document — those on screen first, to their end; the hidden ones only as far as they were ever
 * shown, so ten big tabs in the background do not take the CPU — and each slice yields to the
 * message queue, which keeps edits and viewport requests prompt. */
function scheduleAdvance(): void {
  if (advancing) return;
  advancing = true;
  setTimeout(advanceSlice, 0);
}

function target(id: number, doc: OpenDoc): number {
  return visible.includes(id) ? doc.tokenizer.lineCount : doc.shownTo;
}

function nextToAdvance(): [number, OpenDoc] | undefined {
  const behind = ([id, doc]: [number, OpenDoc]) => doc.tokenizer.cachedLines < target(id, doc);
  const open = [...docs];
  return (
    open.find((entry) => visible.includes(entry[0]) && behind(entry)) ??
    open.find((entry) => behind(entry))
  );
}

function advanceSlice(): void {
  const next = nextToAdvance();
  if (next) next[1].tokenizer.advance(SLICE_MS, target(...next));
  announceReady();
  if (nextToAdvance()) setTimeout(advanceSlice, 0);
  else advancing = false;
}

/** Tells the main thread which guesses can now be replaced by exact tokens. */
function announceReady(): void {
  for (const [id, doc] of docs) {
    const { cachedLines, lineCount } = doc.tokenizer;
    for (const from of doc.guessed) {
      if (from > cachedLines && cachedLines < lineCount) continue;
      doc.guessed.delete(from);
      reply({ type: "ready", doc: id, from });
    }
  }
}
