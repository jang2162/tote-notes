import { h } from "./dom";

/** The button at the foot of the sidebar for a newer version found (`updateFound`): the check at
 * launch puts it up instead of asking, and it stays after 「나중에」 so the dialog can be opened
 * again. */
export class UpdateButton {
  readonly el: HTMLButtonElement;

  constructor(onPress: () => void) {
    this.el = h("button", { class: "update-button", hidden: true });
    this.el.addEventListener("click", onPress);
  }

  show(version: string): void {
    this.el.textContent = `업데이트 ${version}`;
    // The row's width cuts a long version short; the whole of it is here.
    this.el.title = this.el.textContent;
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }
}
