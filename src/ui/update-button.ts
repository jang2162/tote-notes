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
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }
}
