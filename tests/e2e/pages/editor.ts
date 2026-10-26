import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { IRawTheme } from "@shikijs/vscode-textmate";

import { WRAP_LIMIT } from "../../../src/app/docs";
import fakeRegistry from "../../../src/backend/fake-registry.json";
import type { ExtensionRegistry } from "../../../src/backend/types";
import { longestLine } from "../../../src/core/codec";
import { languageData, parseLanguageConfiguration } from "../../../src/editor/language-config";
import { editorExtensions } from "../../../src/editor/setup";
import { Registry } from "../../../src/extensions/registry";
import { HighlightClient } from "../../../src/highlight/client";
import { workerHighlighting } from "../../../src/highlight/extension";
import type { WorkerRequest } from "../../../src/highlight/protocol";
import { loadTheme, tokenTheme } from "../../../src/theme/vscode-theme";

const params = new URLSearchParams(location.search);

// Grammars are parsed in the worker. A spec marks a grammar's text (through `fileOverride`) and
// counts the parses of it on this thread: `parseJsonc` tries `JSON.parse` first on every path, so
// watching `JSON.parse` sees it.
let parsedOnMain = 0;
const jsonParse = JSON.parse;
JSON.parse = (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
  if (typeof text === "string" && text.includes("tote-grammar-mark")) parsedOnMain++;
  return jsonParse(text, reviver);
};
Object.defineProperty(window, "parsedOnMain", { get: () => parsedOnMain });
const fileName = params.get("file") ?? "note.md";
// The dev server serves the bundled extensions under /extensions/, so no fake backend is needed.
const lang = new Registry(fakeRegistry as ExtensionRegistry).languageForFile(fileName);
const configResponse = lang?.configuration
  ? await fetch(`/extensions/${lang.extension}/${lang.configuration}`)
  : null;
const config = configResponse?.ok ? parseLanguageConfiguration(await configResponse.text()) : {};

// `?highlight=1` runs the real worker on the registry's grammars and the bundled Dark+ theme.
// `badgrammar` breaks the grammar files only, `badtheme` gives a theme the tokenizer refuses,
// `slowgrammar=<ms>` holds every grammar read back that long (the first file of a language in
// the app reads its grammar and every include over IPC before the worker can open it).
const registry = new Registry(fakeRegistry as ExtensionRegistry);
const slowGrammar = Number(params.get("slowgrammar") ?? 0);
/** File text standing in for a bundled file, by path: a spec swaps a grammar for another one. */
const fileOverride: Record<string, string> = {};
const readFile = async (ext: string, path: string) => {
  if (path in fileOverride) return new TextEncoder().encode(fileOverride[path]);
  if (slowGrammar && path.startsWith("grammars/"))
    await new Promise((resolve) => setTimeout(resolve, slowGrammar));
  if (params.get("badgrammar") && path.startsWith("grammars/"))
    return new TextEncoder().encode("{ not a grammar");
  if (params.get("badtheme") && path.startsWith("themes/"))
    return new TextEncoder().encode(
      JSON.stringify({ tokenColors: [{ scope: [1], settings: { foreground: "#ff0000" } }] }),
    );
  const response = await fetch(`/extensions/${ext}/${path}`);
  if (!response.ok) throw new Error(`${ext}/${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};
let highlight: Extension | undefined;
let closeHighlight = () => {};
let highlightTheme = async (_theme: string | IRawTheme) => {};
/** Every request the page sent the worker, without its payload. */
const workerLog: { type: string; doc?: number }[] = [];
if (params.get("highlight")) {
  const worker = new Worker(new URL("../../../src/highlight/worker.ts", import.meta.url), {
    type: "module",
  });
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (message: WorkerRequest) => {
    workerLog.push({ type: message.type, doc: "doc" in message ? message.doc : undefined });
    post(message);
  };
  const client = new HighlightClient(worker, () => registry, readFile);
  highlightTheme = async (theme: string | IRawTheme) => {
    if (typeof theme !== "string") return client.setTheme(theme);
    const loaded = await loadTheme(
      async (p) => new TextDecoder().decode(await readFile("tote.themes", p)),
      theme,
    );
    await client.setTheme(tokenTheme(loaded));
  };
  await highlightTheme("themes/dark-plus.json");
  Object.assign(window, { highlightClient: client, fileOverride, highlightLang: lang });
  if (lang?.grammar) {
    const highlighting = workerHighlighting(client, lang);
    highlight = highlighting.extension;
    closeHighlight = () => highlighting.close();
    // On screen, as the app's active tab is.
    client.setVisible([highlighting.doc]);
    Object.assign(window, { highlightDoc: highlighting.doc });
  }
}

// `?longline=<n>` is one line of n characters and `?lines=<n>` n lines of code: a URL cannot carry
// megabytes, so the long documents of the boundary measurement (tests/measure) are built here.
// `&commenttail=<n>` opens a block comment that never closes before the last n of those lines.
const longLine = Number(params.get("longline") ?? 0);
const lines = Number(params.get("lines") ?? 0);
const commentTail = Number(params.get("commenttail") ?? 0);
function codeLines(): string {
  const code = Array.from({ length: lines }, (_, i) => `const v${i} = f(${i}) + "text";`);
  if (commentTail) code.splice(lines - commentTail, 0, "/*");
  return code.join("\n");
}
const doc = longLine
  ? "x".repeat(longLine)
  : lines
    ? codeLines()
    : (params.get("doc") ?? new URLSearchParams(location.hash.slice(1)).get("doc") ?? "");

const view = new EditorView({
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc,
    extensions: editorExtensions({
      fileName,
      lineNumbers: !!params.get("linenumbers"),
      // As the app decides it (`setText` in src/app/docs.ts), so the measurement sees its setting.
      wrap: !params.get("nowrap") && longestLine(doc) <= WRAP_LIMIT,
      onUpdate: () => {},
      languageData: languageData(config),
      highlight,
    }),
  }),
});
view.focus();

// --- A stand-in for WKWebView's Korean input method -------------------------------------------
// Playwright cannot drive the macOS input method, so the specs replay the two shapes it was
// recorded producing (src/editor/ime.ts has the shapes): the direct path, where every keystroke is
// a committed `insertText` / `insertReplacementText` with no composition events, and the
// composition path with compositionstart/update/end. Each step yields a task so CodeMirror's
// mutation observer runs between steps, as it does in the app.

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fire(type: "beforeinput" | "input", inputType: string, data: string | null) {
  view.contentDOM.dispatchEvent(
    new InputEvent(type, { bubbles: true, cancelable: true, inputType, data }),
  );
}

function composition(type: string, data: string) {
  view.contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
}

/** Rewrites the DOM text between document positions `from`..`to` in place — one text node, as
 * WebKit edits a syllable — and leaves the caret after `text`. */
function write(from: number, to: number, text: string) {
  const at = view.domAtPos(from);
  let node = at.node;
  let offset = at.offset;
  if (node.nodeType !== Node.TEXT_NODE) {
    const before = node.childNodes[offset - 1];
    if (before?.nodeType === Node.TEXT_NODE) {
      node = before;
      offset = before.nodeValue!.length;
    } else {
      const fresh = document.createTextNode("");
      node.insertBefore(fresh, node.childNodes[offset] ?? null);
      node = fresh;
      offset = 0;
    }
  }
  const value = node.nodeValue!;
  node.nodeValue = value.slice(0, offset) + text + value.slice(offset + (to - from));
  document.getSelection()!.collapse(node, offset + text.length);
}

/** The composed range while a composition is open. */
let composed: { from: number; to: number } | null = null;

const ime = {
  /** Direct path: a committed insert at the caret (over the selection), no composition events.
   * While a composition is open it replaces the composed text, as WebKit does for a dead key. */
  async insertText(text: string) {
    const { from, to } = composed ?? view.state.selection.main;
    composed = null;
    fire("beforeinput", "insertText", text);
    write(from, to, text);
    fire("input", "insertText", text);
    await tick();
  },
  /** Direct path: the input method rewrites the `count` characters before the caret. */
  async replaceBefore(count: number, text: string) {
    const { to } = view.state.selection.main;
    fire("beforeinput", "insertReplacementText", null);
    write(to - count, to, text);
    fire("input", "insertReplacementText", null);
    await tick();
  },
  /** Composition path: opens a composition over the main selection. */
  async start() {
    const { from, to } = view.state.selection.main;
    composition("compositionstart", view.state.sliceDoc(from, to));
    await tick();
    const main = view.state.selection.main;
    composed = { from: main.from, to: main.to };
  },
  /** Composition path: the composed text becomes `data`. */
  async update(data: string) {
    const { from, to } = composed!;
    composition("compositionupdate", data);
    fire("beforeinput", "insertCompositionText", data);
    write(from, to, data);
    composed = { from, to: from + data.length };
    fire("input", "insertCompositionText", data);
    await tick();
  },
  /** A second compositionstart inside the same composition, which WebKit was recorded sending. */
  async restart() {
    const { from, to } = composed!;
    composition("compositionstart", view.state.sliceDoc(from, to));
    await tick();
  },
  /** Composition path: the end. `replace` re-inserts the text as the recording shows
   * (deleteCompositionText, then insertFromComposition); `bare` is compositionend alone; `cancel`
   * removes the composed text first. */
  async end(how: "replace" | "bare" | "cancel") {
    const { from, to } = composed!;
    const final = view.state.sliceDoc(from, to);
    if (how !== "bare") {
      fire("beforeinput", "deleteCompositionText", null);
      write(from, to, "");
      fire("input", "deleteCompositionText", null);
      await tick();
    }
    if (how === "replace") {
      fire("beforeinput", "insertFromComposition", final);
      write(from, from, final);
      fire("input", "insertFromComposition", final);
      await tick();
    }
    composition("compositionend", how === "replace" ? final : "");
    composed = null;
    await tick();
  },
};

// The specs drive and inspect the editor through these.
/** What closing a tab does: the view goes, and so does the document in the worker. */
function closeDoc() {
  view.destroy();
  closeHighlight();
}

Object.assign(window, {
  view,
  EditorSelection,
  EditorState,
  ime,
  highlightTheme,
  workerLog,
  closeDoc,
});
