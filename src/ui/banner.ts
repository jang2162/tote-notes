import { h } from "./dom";

export type BannerKind = "conflict" | "deleted" | "info" | "trash";

export interface BannerAction {
  label: string;
  run(): void;
}

/** What a tab's banner says and offers; the tab keeps it while it is left and come back to. */
export interface BannerState {
  kind: BannerKind;
  text: string;
  actions: BannerAction[];
}

/** One line above the editor that asks about the file (spec 「외부 변경」): another app changed
 * it, or it was deleted. */
export class Banner {
  private readonly text = h("span", { class: "banner-text" });
  private readonly buttons = h("span", { class: "banner-actions" });
  readonly el = h("div", { class: "banner", role: "alert", hidden: true }, this.text, this.buttons);

  /** `acted` runs after any button's action: the editor takes the keys back. */
  constructor(private readonly acted: () => void = () => {}) {}

  show(kind: BannerKind, text: string, actions: BannerAction[]): void {
    this.el.className = `banner banner-${kind}`;
    this.text.textContent = text;
    this.buttons.replaceChildren(
      ...actions.map((action) => {
        const button = h("button", { textContent: action.label });
        button.addEventListener("click", () => {
          action.run();
          this.acted();
        });
        return button;
      }),
    );
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
    this.buttons.replaceChildren();
  }

  render(state: BannerState | null): void {
    if (state) this.show(state.kind, state.text, state.actions);
    else this.hide();
  }
}
