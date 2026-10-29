import { h } from "./dom";

const SVG = "http://www.w3.org/2000/svg";

/** The gear at the foot of the sidebar, there in every window: opens the settings screen as the
 * menu's 설정… does. An icon alone, so the update button beside it keeps the width for its
 * version; the name is in `aria-label`, and `title` names the shortcut too. */
export class SettingsButton {
  readonly el: HTMLButtonElement;

  constructor(onPress: () => void) {
    this.el = h("button", { class: "settings-button", type: "button", ariaLabel: "설정" }, gear());
    this.el.addEventListener("click", onPress);
    this.setShortcut(undefined);
  }

  /** `shortcut` as the screen writes it; null or undefined (the table not read yet) for none. */
  setShortcut(shortcut: string | null | undefined): void {
    this.el.title = shortcut ? `설정 (${shortcut})` : "설정";
  }
}

/** A ring with eight teeth, in the text colour. */
function gear(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const ring = document.createElementNS(SVG, "circle");
  for (const [name, value] of [
    ["cx", "8"],
    ["cy", "8"],
    ["r", "4"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "2"],
  ])
    ring.setAttribute(name, value);
  svg.append(ring);
  for (let turn = 0; turn < 360; turn += 45) {
    const tooth = document.createElementNS(SVG, "rect");
    for (const [name, value] of [
      ["x", "6.75"],
      ["y", "1"],
      ["width", "2.5"],
      ["height", "3"],
      ["rx", "0.5"],
      ["fill", "currentColor"],
      ["transform", `rotate(${turn} 8 8)`],
    ])
      tooth.setAttribute(name, value);
    svg.append(tooth);
  }
  return svg;
}
