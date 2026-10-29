import { h } from "./dom";

const SVG = "http://www.w3.org/2000/svg";

const NAMES = { collapse: "사이드바 접기", expand: "사이드바 펼치기" } as const;

/** A button that collapses the sidebar (at the right end of the sidebar's top row) or expands it
 * again (in the lead, while it is collapsed). Like the settings button: an icon alone, the name in
 * `aria-label`, and `title` names the shortcut too. */
export class SidebarToggle {
  readonly el: HTMLButtonElement;
  private readonly name: string;

  constructor(role: "collapse" | "expand", onPress: () => void) {
    this.name = NAMES[role];
    this.el = h(
      "button",
      {
        class: "sidebar-toggle",
        type: "button",
        ariaLabel: this.name,
        ariaExpanded: String(role === "collapse"),
      },
      panel(),
    );
    this.el.addEventListener("click", onPress);
    this.setShortcut(undefined);
  }

  /** `shortcut` as the screen writes it; null or undefined (the table not read yet) for none. */
  setShortcut(shortcut: string | null | undefined): void {
    this.el.title = shortcut ? `${this.name} (${shortcut})` : this.name;
  }
}

/** In front of the top left pane's tab bar while the sidebar is collapsed: the room for the
 * traffic lights (macOS) and the button that expands the sidebar. No tab: it stays out of the tab
 * bar, which draws its tabs anew. */
export function tabLead(expand: SidebarToggle): HTMLElement {
  return h("div", { class: "tab-lead" }, h("span", { class: "traffic-lights-room" }), expand.el);
}

/** A window with a column down its left side, in the text colour. */
function panel(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const frame = document.createElementNS(SVG, "rect");
  const column = document.createElementNS(SVG, "line");
  for (const [el, attributes] of [
    [
      frame,
      [
        ["x", "1.75"],
        ["y", "2.75"],
        ["width", "12.5"],
        ["height", "10.5"],
        ["rx", "2"],
      ],
    ],
    [
      column,
      [
        ["x1", "6"],
        ["y1", "3"],
        ["x2", "6"],
        ["y2", "13"],
      ],
    ],
  ] as const) {
    for (const [name, value] of attributes) el.setAttribute(name, value);
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "currentColor");
    el.setAttribute("stroke-width", "1.5");
    svg.append(el);
  }
  return svg;
}
