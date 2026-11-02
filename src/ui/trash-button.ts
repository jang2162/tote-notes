import { h } from "./dom";
import { strokeIcon } from "./icons";

/** The icon: a lidded can with two ribs (`strokeIcon`). */
const CAN = "M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4M6.75 6.5v4.5M9.25 6.5v4.5";

/** `title` of the trash button: what the trash holds. A number badge would take the width the
 * update button beside it needs (memo trash spec 「휴지통 화면」). */
export function trashButtonTitle(count: number): string {
  return `휴지통 (${count}개)`;
}

/** The trash can at the foot of the sidebar, right of the settings button: swaps the memo list
 * for the trash and back. An icon alone, like the settings button; pressed while the trash shows. */
export class TrashButton {
  readonly el: HTMLButtonElement;

  constructor(onPress: () => void) {
    this.el = h(
      "button",
      { class: "trash-button", type: "button", ariaLabel: "휴지통", ariaPressed: "false" },
      strokeIcon(CAN),
    );
    this.el.addEventListener("click", onPress);
    this.setCount(0);
  }

  setCount(count: number): void {
    this.el.title = trashButtonTitle(count);
  }

  setOpen(open: boolean): void {
    this.el.ariaPressed = String(open);
  }
}
