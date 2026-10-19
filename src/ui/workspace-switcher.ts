import type { WorkspaceListItem } from "../backend/types";
import { h } from "./dom";

/** One workspace in the switcher's list. */
export interface SwitcherItem {
  name: string;
  path: string;
  /** This window shows it. */
  current: boolean;
  /** A window other than this one shows it. */
  dot: boolean;
}

/** The switcher's items: the workspaces there are, by name — compared composed, so a name typed in
 * Finder (decomposed) sorts with the others — the current one marked. */
export function switcherItems(list: WorkspaceListItem[], currentPath: string): SwitcherItem[] {
  return list
    .filter((item) => !item.missing)
    .map((item) => {
      const current = item.path === currentPath;
      return {
        name: item.name.normalize("NFC"),
        path: item.path,
        current,
        dot: item.windows > (current ? 1 : 0),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The switcher item ⌃1 – ⌃9 pick, from 0; `null` for any other key. */
export function switcherShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">,
): number | null {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const digit = /^Digit([1-9])$/.exec(event.code);
  return digit ? Number(digit[1]) - 1 : null;
}

/** The combo box at the top of the sidebar (spec 「워크스페이스 고르개」): a button with the
 * current workspace's name, and the list it opens — the workspaces, then 「새 워크스페이스…」
 * and 「워크스페이스 열기…」. */
export class WorkspaceSwitcher {
  readonly el = h("div", { class: "ws-switcher" });
  private readonly button = h("button", {
    type: "button",
    class: "ws-switcher-button",
    ariaHasPopup: "listbox",
    ariaExpanded: "false",
  });
  private readonly list = h("div", {
    class: "ws-switcher-list",
    role: "listbox",
    tabIndex: -1,
  });
  private items: SwitcherItem[] = [];
  /** The entries the arrow keys walk: the options, then the two commands. */
  private entries: HTMLElement[] = [];
  private highlighted = -1;
  /** Where the keys were before the list opened; the list gives them back. */
  private restoreTo: HTMLElement | null = null;

  constructor(
    private readonly actions: { pick(item: SwitcherItem): void; create(): void; open(): void },
  ) {
    this.list.hidden = true;
    this.el.append(this.button, this.list);
    // The keys stay where they were: a switch that is called off gives them back there.
    this.el.addEventListener("mousedown", (event) => event.preventDefault());
    this.button.addEventListener("click", () => (this.isOpen ? this.close() : this.openList()));
  }

  get isOpen(): boolean {
    return !this.list.hidden;
  }

  render(items: SwitcherItem[]): void {
    this.items = items;
    const current = items.find((item) => item.current);
    this.button.replaceChildren(
      h("span", { class: "ws-switcher-name" }, current?.name ?? ""),
      h("span", { class: "ws-switcher-caret" }, "▾"),
    );
    this.button.title = current?.name ?? "";
    const options = items.map((item) => {
      const option = h(
        "div",
        {
          class: item.current ? "ws-switcher-item current" : "ws-switcher-item",
          role: "option",
          ariaSelected: item.current ? "true" : "false",
        },
        h("span", { class: "ws-switcher-check" }, item.current ? "✓" : ""),
        h("span", { class: "ws-switcher-label" }, item.name),
        item.dot && h("span", { class: "ws-switcher-dot" }),
      );
      option.addEventListener("click", () => this.choose(() => this.actions.pick(item)));
      return option;
    });
    const command = (text: string, run: () => void) => {
      const each = h("div", { class: "ws-switcher-command", role: "option" }, text);
      each.addEventListener("click", () => this.choose(run));
      return each;
    };
    const commands = [
      command("새 워크스페이스…", () => this.actions.create()),
      command("워크스페이스 열기…", () => this.actions.open()),
    ];
    this.entries = [...options, ...commands];
    this.list.replaceChildren(
      ...options,
      h("div", { class: "ws-switcher-separator", role: "separator" }),
      ...commands,
    );
    // A list read while it is open (another window changed the workspaces) keeps its place.
    this.highlighted = Math.min(this.highlighted, this.entries.length - 1);
    this.paint();
  }

  close(): void {
    if (!this.isOpen) return;
    this.list.hidden = true;
    this.button.ariaExpanded = "false";
    document.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("beforeinput", this.onInput, true);
    document.removeEventListener("mousedown", this.onOutside, true);
    const back = this.restoreTo;
    this.restoreTo = null;
    if (back && back.isConnected && document.activeElement !== back) back.focus();
  }

  private openList(): void {
    const active = document.activeElement;
    this.restoreTo = active instanceof HTMLElement && active !== document.body ? active : null;
    this.list.hidden = false;
    this.button.ariaExpanded = "true";
    this.highlighted = Math.max(
      0,
      this.items.findIndex((item) => item.current),
    );
    this.paint();
    // The list holds the keys while it is open, so no text input (a composition, an inserted text)
    // reaches the editor under it; `close` gives them back.
    this.list.focus({ preventScroll: true });
    // In the capture phase: the editor and the dialogs see the keys after this.
    document.addEventListener("keydown", this.onKey, true);
    document.addEventListener("beforeinput", this.onInput, true);
    document.addEventListener("mousedown", this.onOutside, true);
  }

  /** Closes the list, then runs what was chosen: it may hand the keys to a dialog. */
  private choose(run: () => void): void {
    this.close();
    run();
  }

  private paint(): void {
    this.entries.forEach((entry, index) =>
      entry.classList.toggle("highlight", this.isOpen && index === this.highlighted),
    );
    this.entries[this.highlighted]?.scrollIntoView?.({ block: "nearest" });
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (move) {
      const last = this.entries.length - 1;
      this.highlighted = Math.min(last, Math.max(0, this.highlighted + move));
      this.paint();
    } else if (event.key === "Enter") {
      this.entries[this.highlighted]?.click();
    } else if (event.key === "Escape") {
      this.close();
    } else if (event.isComposing || event.metaKey || event.ctrlKey) {
      // ⌃1 – ⌃9 and the shortcuts close it and go on.
      this.close();
      return;
    } else {
      // Typing waits until the list is closed rather than going into the editor under it.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  /** An inserted text (an input method's, a paste) goes to the editor's last selection even with
   * the keys on the list: it is refused while the list is open. */
  private readonly onInput = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onOutside = (event: MouseEvent): void => {
    if (!this.el.contains(event.target as Node)) this.close();
  };
}
