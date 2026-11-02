import { h } from "./dom";

const SVG = "http://www.w3.org/2000/svg";

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
    this.el = h("button", { class: "update-button", hidden: true }, arrow(), this.label);
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

/** An arrow down onto a line, in the text colour. */
function arrow(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  for (const [name, value] of [
    ["d", "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"],
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
