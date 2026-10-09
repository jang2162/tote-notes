import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorExtensions } from "../../../src/editor/setup";

const params = new URLSearchParams(location.search);
const view = new EditorView({
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc: params.get("doc") ?? "",
    extensions: editorExtensions({
      fileName: params.get("file") ?? "note.md",
      wrap: true,
      onUpdate: () => {},
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
Object.assign(window, { view, EditorSelection, ime });
