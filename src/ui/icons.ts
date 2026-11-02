const SVG = "http://www.w3.org/2000/svg";

/** A 16px icon of one stroked path `d` on a 16-unit grid, in the text colour, hidden from
 * assistive technology: the button around it carries the name. */
export function strokeIcon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  for (const [name, value] of [
    ["d", d],
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
