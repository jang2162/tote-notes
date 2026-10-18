import type { WorkspaceListItem } from "../backend/types";
import { h } from "./dom";

/** One workspace on the rail. */
export interface RailItem {
  name: string;
  path: string;
  /** What the round button shows: the name's first two characters. */
  label: string;
  /** This window shows it. */
  current: boolean;
  /** A window other than this one shows it. */
  dot: boolean;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The rail's items: the workspaces there are, by name — compared composed, so a name typed in
 * Finder (decomposed) sorts with the others — the current one marked. */
export function railItems(list: WorkspaceListItem[], currentPath: string): RailItem[] {
  return list
    .filter((item) => !item.missing)
    .map((item) => {
      const name = item.name.normalize("NFC");
      const current = item.path === currentPath;
      return {
        name,
        path: item.path,
        label: [...graphemes.segment(name)]
          .slice(0, 2)
          .map((each) => each.segment)
          .join(""),
        current,
        dot: item.windows > (current ? 1 : 0),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The rail item ⌃1 – ⌃9 pick, from 0; `null` for any other key. */
export function railShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">,
): number | null {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const digit = /^Digit([1-9])$/.exec(event.code);
  return digit ? Number(digit[1]) - 1 : null;
}

/** The column left of the sidebar (spec 「워크스페이스 띠」): a round button per workspace, `+` at
 * the bottom. */
export class WorkspaceRail {
  readonly el = h("nav", { class: "rail" });

  constructor(private readonly actions: { pick: (item: RailItem) => void; add: () => void }) {
    // The keys stay where they were: a switch that is called off gives them back there.
    this.el.addEventListener("mousedown", (event) => event.preventDefault());
  }

  render(items: RailItem[]): void {
    const buttons = items.map((item) => {
      const button = h(
        "button",
        {
          type: "button",
          class: item.current ? "rail-item current" : "rail-item",
          title: item.name,
        },
        h("span", { class: "rail-label" }, item.label),
        item.dot && h("span", { class: "rail-dot" }),
      );
      button.addEventListener("click", () => this.actions.pick(item));
      return button;
    });
    const add = h("button", { type: "button", class: "rail-add", title: "새 워크스페이스" }, "+");
    add.addEventListener("click", () => this.actions.add());
    this.el.replaceChildren(...buttons, add);
  }
}
