import type { EditorState } from "@codemirror/state";

import { h } from "./dom";

export class StatusBar {
  private readonly message = h("span", { class: "status-message" });
  private readonly position = h("span", { class: "status-position" });
  private readonly language = h("span", { class: "status-language" });
  readonly el = h("footer", { class: "statusbar" }, this.message, this.position, this.language);

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

  setLanguage(label: string): void {
    this.language.textContent = label;
  }
}
