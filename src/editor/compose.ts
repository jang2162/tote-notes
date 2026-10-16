import type { EditorView } from "@codemirror/view";

/** Lands a composition in progress (Hangul being typed) in the editor it was typed in, before the
 * focus goes elsewhere: macOS input methods commit a composition when the editor loses focus
 * (core spec 「편집기」). Returns at once when nothing is composing; else blurs the editor and
 * waits for `compositionend`, or `timeoutMs` for an input method that never sends it. */
export function settleComposition(
  view: Pick<EditorView, "composing" | "contentDOM">,
  timeoutMs = 150,
): Promise<void> {
  if (!view.composing) return Promise.resolve();
  const dom = view.contentDOM;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      dom.removeEventListener("compositionend", done);
      resolve();
    };
    // Listening before the blur: an input method may end the composition inside `blur` itself.
    dom.addEventListener("compositionend", done);
    const timer = setTimeout(done, timeoutMs);
    dom.blur();
    if (!view.composing) done();
  });
}
