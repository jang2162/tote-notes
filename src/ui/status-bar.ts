import type { EditorState } from "@codemirror/state";

import { h } from "./dom";

export class StatusBar {
  private readonly message = h("span", { class: "status-message" });
  private readonly position = h("span", { class: "status-position" });
  /** A button that opens the language picker; off where the language cannot be changed (list
   * keyboard spec 「상태 표시줄」). */
  private readonly language = h("button", {
    class: "status-language",
    type: "button",
    disabled: true,
  });
  readonly el = h("footer", { class: "statusbar" }, this.message, this.position, this.language);

  constructor() {
    // What the status bar says is read out as it changes.
    this.message.setAttribute("role", "status");
  }

  get showsError(): boolean {
    return this.message.classList.contains("error");
  }

  setMessage(text: string, tone: "normal" | "error" = "normal"): void {
    this.message.textContent = text;
    this.message.classList.toggle("error", tone === "error");
  }

  setPosition(state: EditorState | null): void {
    if (!state) {
      this.position.textContent = "";
      return;
    }
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const cursors = state.selection.ranges.length;
    this.position.textContent = `줄 ${line.number}, 열 ${head - line.from + 1}${cursors > 1 ? ` · 커서 ${cursors}개` : ""}`;
  }

  /** `onPick` makes the label a button that opens the language picker. */
  setLanguage(label: string, onPick?: () => void): void {
    this.language.textContent = label;
    this.language.onclick = onPick ?? null;
    this.language.disabled = !onPick;
    this.language.classList.toggle("clickable", Boolean(onPick));
    this.language.title = onPick ? "언어 바꾸기" : "";
    if (label) this.language.setAttribute("aria-label", `언어: ${label}`);
    else this.language.removeAttribute("aria-label");
  }
}
