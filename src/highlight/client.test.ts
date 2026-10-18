import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionRegistry, LanguageInfo } from "../backend/types";
import { Registry } from "../extensions/registry";
import { HighlightClient } from "./client";
import type { WorkerReply, WorkerRequest } from "./protocol";

const lang = {
  id: "a",
  extension: "e",
  grammar: { scopeName: "source.a", path: "a.json" },
} as unknown as LanguageInfo;

const registry = new Registry({
  extensions: [],
  languages: [lang],
  grammars: [
    {
      extension: "e",
      language: null,
      scopeName: "source.b",
      path: "b.json",
      embeddedLanguages: {},
    },
  ],
  themes: [],
  viewers: [],
  problems: [],
} as ExtensionRegistry);

const files: Record<string, string> = {
  "a.json": '{"scopeName":"source.a","patterns":[{"include":"source.b"}]}',
  "b.json": '{"scopeName":"source.b","patterns":[]}',
};

/** A worker that answers `grammars` the way the real one does (the includes it does not hold
 * yet, here given per scope) and lets a test answer everything else. With `hold`, the answers to
 * `grammars` wait for `release()`. */
function setup(includes: Record<string, string[]> = {}, { hold = false } = {}) {
  const sent: WorkerRequest[] = [];
  const held: (() => void)[] = [];
  let listener: (event: MessageEvent<WorkerReply>) => void = () => {};
  const answer = (reply: WorkerReply) => listener({ data: reply } as MessageEvent<WorkerReply>);
  const worker = {
    postMessage: (request: WorkerRequest) => {
      sent.push(request);
      if (request.type === "grammars") {
        const found = request.grammars.flatMap((g) => includes[g.scopeName] ?? []);
        const reply = () => answer({ type: "grammars-ready", includes: found });
        if (hold) held.push(reply);
        else queueMicrotask(reply);
      }
    },
    addEventListener: (type: string, fn: typeof listener) => {
      if (type === "message") listener = fn;
    },
  } as unknown as Worker;
  let reads = 0;
  const read = async (_ext: string, path: string) => {
    reads++;
    return new TextEncoder().encode(files[path]);
  };
  const client = new HighlightClient(worker, () => registry, read);
  const ofType = <T extends WorkerRequest["type"]>(type: T) =>
    sent.filter((r): r is Extract<WorkerRequest, { type: T }> => r.type === type);
  const grammarMessages = () => ofType("grammars").length;
  const forgets = () => ofType("forget-grammars").length;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const release = () => held.splice(0).forEach((reply) => reply());
  return {
    client,
    sent,
    ofType,
    answer,
    release,
    grammarMessages,
    forgets,
    reads: () => reads,
    settle,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HighlightClient grammar cache", () => {
  it("sends a language's grammars once, and again after they are forgotten", async () => {
    const { client, grammarMessages, forgets, reads, settle } = setup();
    void client.open(1, lang, () => "x");
    await settle();
    void client.open(2, lang, () => "x");
    await settle();
    expect(grammarMessages()).toBe(1);
    expect(reads()).toBe(1);
    // An extension was reinstalled or replaced: its files may differ now.
    client.forgetGrammars();
    // The worker's own registry must be told too, or it keeps the first grammar it loaded.
    expect(forgets()).toBe(1);
    void client.open(3, lang, () => "x");
    await settle();
    expect(grammarMessages()).toBe(2);
    expect(reads()).toBe(2);
  });

  it("grammars travel as text and includes come back from the worker", async () => {
    const { client, ofType, settle } = setup({ "source.a": ["source.b", "source.nobody"] });
    void client.open(1, lang, () => "x");
    await settle();
    const batches = ofType("grammars").map((m) => m.grammars);
    // The main thread never parses a grammar: it sends the file's text as it was read.
    expect(batches).toEqual([
      [{ scopeName: "source.a", text: files["a.json"] }],
      [{ scopeName: "source.b", text: files["b.json"] }],
    ]);
    // The document opens once no include is missing.
    expect(ofType("open")).toHaveLength(1);
  });

  // The grammars of a language can take several round trips; forgetting them in between drops
  // the ones already sent from the worker, so the language must not count as sent afterwards.
  it("grammars collected across a forget are not taken as sent", async () => {
    const { client, release, grammarMessages, ofType, settle } = setup(
      { "source.a": ["source.b"] },
      { hold: true },
    );
    const opened = client.open(1, lang, () => "x");
    await settle();
    release(); // source.a answered: source.b is read and sent
    await settle();
    expect(grammarMessages()).toBe(2);
    client.forgetGrammars();
    release(); // source.b answered after the worker forgot source.a
    await settle();
    expect(ofType("open")).toHaveLength(0);
    expect(await opened).toBe(false);
    // The next document of the language sends its grammars again.
    void client.open(2, lang, () => "x");
    await settle();
    expect(grammarMessages()).toBe(3);
    release();
    await settle();
    release();
    await settle();
    expect(ofType("open")).toHaveLength(1);
  });

  it("preload sends the grammar once and open reuses it", async () => {
    vi.useFakeTimers();
    const { client, grammarMessages, ofType, reads } = setup();
    client.preload(lang);
    client.preload(lang);
    // Not at once: the window is still starting up.
    expect(grammarMessages()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(grammarMessages()).toBe(1);
    void client.open(1, lang, () => "x");
    await vi.advanceTimersByTimeAsync(0);
    expect(grammarMessages()).toBe(1);
    expect(reads()).toBe(1);
    expect(ofType("open")).toHaveLength(1);
  });
});

describe("HighlightClient viewport tokens", () => {
  it("a pending answer is followed by a ready message and a second request", async () => {
    const { client, ofType, answer, settle } = setup();
    const first = client.cachedTokens(7, 500, 520);
    const [request] = ofType("tokens");
    expect(request).toMatchObject({ doc: 7, from: 500, to: 520, mode: "cached" });
    const guess = [new Uint32Array([0, 1, 0])];
    answer({
      type: "tokens",
      doc: 7,
      req: request.req,
      from: 500,
      lines: guess,
      pending: true,
    });
    const reply = await first;
    expect(reply!.lines).toBe(guess);
    let ready = false;
    void reply!.ready!.then(() => (ready = true));
    // Another document's line states, or this one's short of line 500, are no answer.
    answer({ type: "ready", doc: 8, from: 500 });
    answer({ type: "ready", doc: 7, from: 400 });
    await settle();
    expect(ready).toBe(false);
    answer({ type: "ready", doc: 7, from: 500 });
    await settle();
    expect(ready).toBe(true);
    const second = client.cachedTokens(7, 500, 520);
    const requests = ofType("tokens");
    expect(requests).toHaveLength(2);
    const exact = [new Uint32Array([0, 2, 0])];
    answer({ type: "tokens", doc: 7, req: requests[1].req, from: 500, lines: exact });
    expect(await second).toEqual({ lines: exact, ready: null });
  });

  it("stats come back for the document asked about", async () => {
    const { client, ofType, answer } = setup();
    const stats = client.stats(3);
    const [request] = ofType("stats");
    answer({ type: "stats", req: request.req, cachedLines: 42, advancing: true });
    expect(await stats).toEqual({ cachedLines: 42, advancing: true });
  });

  it("setVisible names the documents shown", () => {
    const { client, ofType } = setup();
    client.setVisible([2, 5]);
    expect(ofType("visible")).toEqual([{ type: "visible", docs: [2, 5] }]);
  });
});

describe("HighlightClient grammar read failures", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A client made after the page `unload`ed or not, over a grammar read that fails the way a
   * request cut by a reload does. */
  async function failing(unload: boolean) {
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal("addEventListener", (type: string, listener: () => void) => {
      listeners[type] = listener;
    });
    vi.resetModules();
    const { HighlightClient: Client } = await import("./client");
    if (unload) listeners.pagehide();
    const worker = { postMessage: () => {}, addEventListener: () => {} } as unknown as Worker;
    const read = () => Promise.reject(new TypeError("Load failed"));
    return new Client(worker, () => registry, read);
  }

  it("is warned about when the page stays, not when it is going", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await (await failing(false)).open(1, lang, () => "x")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
      expect(await (await failing(true)).open(1, lang, () => "x")).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
