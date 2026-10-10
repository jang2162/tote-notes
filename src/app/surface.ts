import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { h } from "../ui/dom";

/** What the view holds while the editor is hidden. */
const DETACHED = EditorState.create({ extensions: EditorView.editable.of(false) });

/** The editor area: the editor, a placeholder sentence, or a panel (a viewer, the large text
 * viewer). One of them is visible at a time. */
export class Surface {
  // CodeMirror's own CSS sets `display` on .cm-editor with !important, so its host is what hides.
  private readonly editorHost: HTMLElement;
  private readonly placeholder = h("div", { class: "editor-placeholder" });
  private readonly panelHost = h("div", { class: "panel-host" });
  readonly el: HTMLElement;

  constructor(private readonly view: EditorView) {
    this.editorHost = h("div", { class: "editor-host" }, view.dom);
    this.el = h("div", { class: "editor-area" }, this.editorHost, this.placeholder, this.panelHost);
    this.showEmpty();
  }

  get showsEditor(): boolean {
    return !this.editorHost.hidden;
  }

  showEditor(state: EditorState, scrollAnchor: number): void {
    this.only(this.editorHost);
    this.view.setState(state);
    const anchor = Math.min(scrollAnchor, state.doc.length);
    this.view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: "start" }) });
    this.view.requestMeasure();
    this.view.focus();
  }

  showPlaceholder(text: string, action?: { label: string; run: () => void }): void {
    this.only(this.placeholder);
    const children: (Node | string)[] = [h("p", { textContent: text })];
    if (action) {
      const button = h("button", { textContent: action.label });
      button.addEventListener("click", action.run);
      children.push(button);
    }
    this.placeholder.replaceChildren(...children);
  }

  showPanel(el: HTMLElement): void {
    this.only(this.panelHost);
    this.panelHost.replaceChildren(el);
  }

  /** Between a tab switch and what the new tab shows: nothing, and keys typed are dropped. */
  showNothing(): void {
    this.showPlaceholder("");
  }

  showEmpty(): void {
    this.showPlaceholder("⌘N 으로 새 메모를 만드세요");
  }

  private only(shown: HTMLElement): void {
    for (const part of [this.editorHost, this.placeholder, this.panelHost])
      part.hidden = part !== shown;
    if (shown !== this.panelHost) this.panelHost.replaceChildren();
    // A hidden editor still takes keys in WebKit, blurred or not, and the tab whose state it
    // holds would save them; that tab keeps its state in its own `Doc`.
    if (shown !== this.editorHost) this.view.setState(DETACHED);
  }
}
