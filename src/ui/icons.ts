import type { FileKind } from "../backend/types";

const SVG = "http://www.w3.org/2000/svg";

/** A 16px icon (or `size`) of one stroked path `d` on a 16-unit grid, in the text colour, hidden
 * from assistive technology: the button or row around it carries the name. */
export function strokeIcon(d: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
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

/** The marks of the kinds a memo row shows one for, on the 16-unit grid. A text memo has none:
 * every other row would carry the same one, and its extension says the kind. */
const KIND_MARKS: Record<Exclude<FileKind, "text">, string> = {
  // A frame, a sun and two hills.
  image:
    "M3.5 2.5h9A1.5 1.5 0 0 1 14 4v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5zM7.3 6.5a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 1 1 2.6 0zM2.5 12 6 8.5 8.5 11l2-2 3 3",
  // A frame round a play triangle.
  video:
    "M3.5 3h9A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3zM6.5 5.8v4.4L10.2 8z",
  // Two notes under a beam.
  audio:
    "M6 12.5v-9l7-1.5v9M6 12.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM13 11a2 2 0 1 1-4 0 2 2 0 1 1 4 0z",
  // A page with its corner folded and two lines.
  document:
    "M4 1.5h5.5L13 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5zM9.5 1.5V5H13M6 8.5h4M6 11h4",
};

/** The 14px mark in front of a memo row's name for `kind`, or nothing for a text memo. */
export function kindIcon(kind: FileKind): HTMLElement | null {
  if (kind === "text") return null;
  const box = document.createElement("span");
  box.className = "memo-icon";
  box.append(strokeIcon(KIND_MARKS[kind], 14));
  return box;
}
