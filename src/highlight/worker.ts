import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import { Registry, type IGrammar, type IOnigLib, type IRawGrammar } from "@shikijs/vscode-textmate";

import type { WorkerReply, WorkerRequest } from "./protocol";
import { LineTokenizer } from "./tokenizer";

/** Tokenization off the input path (spec 「성능」): grammars, theme and documents live here;
 * the main thread asks for the tokens of the lines it shows. Requests are handled in order so
 * an edit can never interleave with the tokens of the document it changes. */

const grammars = new Map<string, IRawGrammar>();
const loaded = new Map<string, IGrammar | null>();
const docs = new Map<number, LineTokenizer>();
let advancing = false;

// The inlined WASM needs no fetch, so the worker works the same from the dev server, the app's
// protocol and a test runner.
const registry: Promise<Registry> = createOnigurumaEngine(
  import("@shikijs/engine-oniguruma/wasm-inlined"),
).then((engine) => {
  const onigLib: IOnigLib = {
    createOnigScanner: (sources) => engine.createScanner(sources),
    createOnigString: (s) => engine.createString(s),
  };
  return new Registry({ onigLib, loadGrammar: (scope) => grammars.get(scope) ?? null });
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
      handle(await registry, request);
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
  if (request.type === "open") return { type: "opened", doc: request.doc, ok: false, message };
  return {
    type: "error",
    doc: "doc" in request ? request.doc : undefined,
    req: request.type === "tokens" ? request.req : undefined,
    message,
  };
}

function handle(registry: Registry, request: WorkerRequest): void {
  switch (request.type) {
    case "theme":
      registry.setTheme(request.theme);
      // Colour ids changed with the theme: every cached state is stale.
      for (const doc of docs.values()) doc.reset();
      reply({ type: "theme-ready", colorMap: registry.getColorMap() });
      return;
    case "grammars":
      for (const source of request.grammars) {
        grammars.set(source.scopeName, source.grammar);
        loaded.delete(source.scopeName);
      }
      return;
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
      docs.set(request.doc, new LineTokenizer(grammar, request.text));
      reply({ type: "opened", doc: request.doc, ok: true });
      scheduleAdvance();
      return;
    }
    case "edit":
      docs.get(request.doc)?.edit(request.fromLine, request.toLine, request.insert);
      scheduleAdvance();
      return;
    case "tokens": {
      const doc = docs.get(request.doc);
      if (!doc) throw new Error("tokens requested for a document that is not open");
      reply({
        type: "tokens",
        doc: request.doc,
        req: request.req,
        from: request.from,
        lines: doc.tokens(request.from, request.to),
      });
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
 * from the top in slices, so a far jump finds its states ready). Each slice yields to the
 * message queue, which keeps edits and viewport requests prompt. */
function scheduleAdvance(): void {
  if (advancing) return;
  advancing = true;
  setTimeout(advanceSlice, 0);
}

function advanceSlice(): void {
  let pending = false;
  for (const doc of docs.values()) {
    if (!doc.advance(15)) pending = true;
  }
  if (pending) setTimeout(advanceSlice, 0);
  else advancing = false;
}
