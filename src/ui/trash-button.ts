import { h } from "./dom";

const SVG = "http://www.w3.org/2000/svg";

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
      can(),
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

/** A lidded can with two ribs, in the text colour. */
function can(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  for (const [name, value] of [
    ["d", "M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4M6.75 6.5v4.5M9.25 6.5v4.5"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "1.4"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
  ])
    path.setAttribute(name, value);
  svg.append(path);
  return svg;
}
