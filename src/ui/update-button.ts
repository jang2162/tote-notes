import { h } from "./dom";
import { strokeIcon } from "./icons";

/** The icon: an arrow down onto a line (`strokeIcon`). */
const ARROW = "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10";

/** The button at the foot of the sidebar for a newer version found (`updateFound`): the check at
 * launch puts it up instead of asking, and it stays after 「나중에」 so the dialog can be opened
 * again. A download arrow, then the words; the words alone name it. */
export class UpdateButton {
  readonly el: HTMLButtonElement;
  private readonly label: HTMLSpanElement;

  constructor(
    onPress: () => void,
    private readonly onShown: (shown: boolean) => void,
  ) {
    this.label = h("span", { class: "update-label" });
    this.el = h("button", { class: "update-button", hidden: true }, strokeIcon(ARROW), this.label);
    this.el.addEventListener("click", onPress);
  }

  show(version: string): void {
    this.label.textContent = `업데이트 ${version}`;
    // The row's width cuts a long version short; the whole of it is here.
    this.el.title = this.label.textContent;
    this.el.hidden = false;
    this.onShown(true);
  }

  hide(): void {
    this.el.hidden = true;
    this.onShown(false);
  }
}
