import type { EditorState } from "@codemirror/state";

import { CharCounter } from "../editor/char-count";
import { h } from "./dom";

export class StatusBar {
  private readonly message = h("span", { class: "status-message" });
  private readonly position = h("span", { class: "status-position" });
  private readonly count = h("span", { class: "status-count" });
  private readonly language = h("span", { class: "status-language" });
  readonly el = h(
    "footer",
    { class: "statusbar" },
    this.message,
    this.position,
    this.count,
    this.language,
  );
  /** The character count setting. */
  private counting = false;
  private readonly counter = new CharCounter((label) => (this.count.textContent = label ?? ""));
  /** What `setPosition` was last given, for the count once it is switched on. */
  private shown: EditorState | null = null;

  get showsError(): boolean {
    return this.message.classList.contains("error");
  }

  setMessage(text: string, tone: "normal" | "error" = "normal"): void {
    this.message.textContent = text;
    this.message.classList.toggle("error", tone === "error");
  }

  /** `edited`: the state is the shown one's text just changed, not another tab's (`CharCounter`). */
  setPosition(state: EditorState | null, { edited = false }: { edited?: boolean } = {}): void {
    this.shown = state;
    if (this.counting) this.counter.request(state, { edited });
    if (!state) {
      this.position.textContent = "";
      return;
    }
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const cursors = state.selection.ranges.length;
    this.position.textContent = `줄 ${line.number}, 열 ${head - line.from + 1}${cursors > 1 ? ` · 커서 ${cursors}개` : ""}`;
  }

  /** Shows the character count of what `setPosition` is given, or stops counting. */
  setCharCount(on: boolean): void {
    if (on === this.counting) return;
    this.counting = on;
    if (on) this.counter.request(this.shown, { edited: false });
    else {
      this.counter.cancel();
      this.count.textContent = "";
    }
  }

  /** `onPick` makes the label a button that opens the language picker. */
  setLanguage(label: string, onPick?: () => void): void {
    this.language.textContent = label;
    this.language.onclick = onPick ?? null;
    this.language.classList.toggle("clickable", Boolean(onPick));
    this.language.title = onPick ? "언어 바꾸기" : "";
  }
}
