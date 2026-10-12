import type { IRawTheme } from "@shikijs/vscode-textmate";

import type { LanguageInfo } from "../backend/types";
import type { Registry } from "../extensions/registry";
import { collectGrammars } from "./grammars";
import type { GrammarSource, WorkerReply, WorkerRequest } from "./protocol";

type Answer = Extract<WorkerReply, { type: "tokens" } | { type: "stats" }>;

/** Tokens for a viewport. `ready` is null when they are exact; otherwise they are a guess, and
 * `ready` settles once the worker's line states reach them, so the exact ones can be asked for. */
export interface ViewportTokens {
  lines: Uint32Array[];
  ready: Promise<void> | null;
}

/** Puts the theme's colours on the page as classes: tokens carry colour ids, not colours, so
 * a decoration is one class name and a theme change is one stylesheet. */
export function installColorStyles(colorMap: string[]): void {
  let style = document.getElementById("tm-colors") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "tm-colors";
    document.head.append(style);
  }
  const rules = colorMap.map((color, i) => `.tm-c${i}{color:${color}}`);
  rules.push(
    ".tm-i{font-style:italic}",
    ".tm-b{font-weight:bold}",
    ".tm-u{text-decoration:underline}",
    ".tm-s{text-decoration:line-through}",
  );
  style.textContent = rules.join("\n");
}

/** The main-thread side of the worker (one per window). Grammars go to the worker the first
 * time a language is opened or preloaded (spec 「설치와 로딩」); the theme whenever it changes. */
export class HighlightClient {
  colorMap: string[] = [];
  private nextDoc = 1;
  private nextReq = 1;
  /** Requests answered by `tokens` or `stats`, by request number. */
  private readonly waiting = new Map<number, (answer: Answer | null) => void>();
  /** Per document, the guesses waiting for the line states to reach their first line. */
  private readonly readyWaiters = new Map<number, { from: number; resolve: () => void }[]>();
  /** One per `grammars` request in flight; the worker answers them in order. */
  private readonly grammarsReady: ((includes: string[]) => void)[] = [];
  private readonly opening = new Map<number, (ok: boolean) => void>();
  /** Documents whose `open` waits for their grammars; `close` takes a document out. */
  private readonly pendingOpens = new Set<number>();
  /** One per `theme` request in flight; the worker answers them in order. */
  private readonly themeReady: (() => void)[] = [];
  private readonly themeListeners = new Set<() => void>();
  private readonly sent = new Set<string>();
  private readonly loading = new Map<string, Promise<boolean>>();

  constructor(
    private readonly worker: Worker,
    private readonly registry: () => Registry,
    private readonly read: (extensionId: string, path: string) => Promise<Uint8Array>,
  ) {
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) =>
      this.onReply(event.data),
    );
    worker.addEventListener("error", (event) => console.error("highlight worker", event.message));
  }

  nextDocId(): number {
    return this.nextDoc++;
  }

  setTheme(theme: IRawTheme): Promise<void> {
    return new Promise((resolve) => {
      this.themeReady.push(resolve);
      this.send({ type: "theme", theme });
    });
  }

  /** Called after every theme change: the worker forgot its states and the colour ids changed,
   * so an open document asks for its tokens again (spec 「테마」 — the OS appearance can switch
   * the theme under an open file). Returns the unsubscribe. */
  onThemeChange(listener: () => void): () => void {
    this.themeListeners.add(listener);
    return () => this.themeListeners.delete(listener);
  }

  /** Forgets which grammars the worker was given: an extension was installed, replaced or removed,
   * so the next open of a language reads and sends its files again. Documents already open keep
   * the grammar they were opened with. */
  forgetGrammars(): void {
    this.sent.clear();
    this.loading.clear();
    this.send({ type: "forget-grammars" });
  }

  /** Sends the language's grammars (once per language) and opens the document. False when the
   * grammar is missing or broken (the text then stays plain), or when the document was closed
   * before its grammars were in.
   *
   * `text` is read only when the open is sent: reading the grammars can take many round trips,
   * and the worker drops the edits made meanwhile (it has no such document yet), so the text it
   * opens must already hold them. Edits after this point reach the worker after the open. */
  async open(doc: number, lang: LanguageInfo, text: () => string): Promise<boolean> {
    if (!lang.grammar) return false;
    this.pendingOpens.add(doc);
    const ready = await this.ensureGrammar(lang);
    // Closed while waiting: an open now would leave the document in the worker for good, since
    // its close has already gone.
    if (!this.pendingOpens.delete(doc) || !ready) return false;
    return new Promise((resolve) => {
      this.opening.set(doc, resolve);
      this.send({ type: "open", doc, scopeName: lang.grammar!.scopeName, text: text() });
    });
  }

  /** Sends the language's grammars once the window is idle, ahead of its first document: the
   * first markdown memo after ⌘N then opens without waiting for its grammars to be read. */
  preload(lang: LanguageInfo): void {
    if (!lang.grammar) return;
    const load = () => void this.ensureGrammar(lang);
    // Playwright's WebKit has no requestIdleCallback, and the app runs on WebKit.
    if (typeof requestIdleCallback === "function") requestIdleCallback(load);
    else setTimeout(load, 1000);
  }

  edit(doc: number, fromLine: number, toLine: number, insert: string[]): void {
    this.send({ type: "edit", doc, fromLine, toLine, insert });
  }

  /** Tokens of lines [from, to), the worker catching up to `from` first however far it is. Null
   * when the worker failed the request. */
  async tokens(doc: number, from: number, to: number): Promise<Uint32Array[] | null> {
    const answer = await this.ask((req) => ({ type: "tokens", doc, req, from, to }));
    return answer?.type === "tokens" ? answer.lines : null;
  }

  /** Tokens of lines [from, to) without waiting for the worker to catch up to `from`: a guess
   * when its line states are not there yet (see `ViewportTokens`). Null when the request failed. */
  async cachedTokens(doc: number, from: number, to: number): Promise<ViewportTokens | null> {
    const answer = await this.ask((req) => ({
      type: "tokens",
      doc,
      req,
      from,
      to,
      mode: "cached",
    }));
    if (answer?.type !== "tokens") return null;
    if (!answer.pending) return { lines: answer.lines, ready: null };
    const ready = new Promise<void>((resolve) => {
      const waiters = this.readyWaiters.get(doc) ?? [];
      waiters.push({ from, resolve });
      this.readyWaiters.set(doc, waiters);
    });
    return { lines: answer.lines, ready };
  }

  /** The documents on screen (the active tab's): the worker works on them first. */
  setVisible(docs: number[]): void {
    this.send({ type: "visible", docs });
  }

  /** How far the worker's line states reach. Null when the request failed. */
  async stats(doc: number): Promise<{ cachedLines: number } | null> {
    const answer = await this.ask((req) => ({ type: "stats", doc, req }));
    return answer?.type === "stats" ? { cachedLines: answer.cachedLines } : null;
  }

  close(doc: number): void {
    this.pendingOpens.delete(doc);
    this.opening.delete(doc);
    this.readyWaiters.delete(doc);
    this.send({ type: "close", doc });
  }

  private ask(request: (req: number) => WorkerRequest): Promise<Answer | null> {
    const req = this.nextReq++;
    return new Promise((resolve) => {
      this.waiting.set(req, resolve);
      this.send(request(req));
    });
  }

  private ensureGrammar(lang: LanguageInfo): Promise<boolean> {
    const key = `${lang.extension}:${lang.id}`;
    if (this.sent.has(key)) return Promise.resolve(true);
    let pending = this.loading.get(key);
    if (!pending) {
      pending = collectGrammars(this.registry(), lang, this.read, (batch) =>
        this.sendGrammars(batch),
      )
        .then((sent) => {
          if (sent.length === 0) return false;
          this.sent.add(key);
          return true;
        })
        .catch((error: unknown) => {
          console.warn(`grammar for ${lang.id} could not be loaded`, error);
          return false;
        })
        .finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  /** Resolves with the includes the worker still lacks after parsing `grammars`. */
  private sendGrammars(grammars: GrammarSource[]): Promise<string[]> {
    return new Promise((resolve) => {
      this.grammarsReady.push(resolve);
      this.send({ type: "grammars", grammars });
    });
  }

  private send(request: WorkerRequest): void {
    this.worker.postMessage(request);
  }

  private onReply(reply: WorkerReply): void {
    switch (reply.type) {
      case "theme-ready":
        this.colorMap = reply.colorMap;
        installColorStyles(reply.colorMap);
        this.themeReady.shift()?.();
        for (const listener of this.themeListeners) listener();
        return;
      case "grammars-ready":
        this.grammarsReady.shift()?.(reply.includes);
        return;
      case "opened":
        this.opening.get(reply.doc)?.(reply.ok);
        this.opening.delete(reply.doc);
        if (!reply.ok) console.warn(reply.message);
        return;
      case "tokens":
      case "stats":
        this.waiting.get(reply.req)?.(reply);
        this.waiting.delete(reply.req);
        return;
      case "ready": {
        const waiters = this.readyWaiters.get(reply.doc);
        if (!waiters) return;
        for (const waiter of waiters) if (waiter.from <= reply.from) waiter.resolve();
        this.readyWaiters.set(
          reply.doc,
          waiters.filter((waiter) => waiter.from > reply.from),
        );
        return;
      }
      case "error":
        console.error("highlight worker:", reply.message);
        if (reply.req !== undefined) {
          this.waiting.get(reply.req)?.(null);
          this.waiting.delete(reply.req);
        }
        if (reply.doc !== undefined) {
          this.opening.get(reply.doc)?.(false);
          this.opening.delete(reply.doc);
        }
        return;
    }
  }
}
