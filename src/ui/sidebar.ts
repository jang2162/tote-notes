import { h } from "./dom";
import type { MemoList } from "./memo-list";
import type { SearchPanel } from "./search-panel";
import type { SettingsButton } from "./settings-button";
import type { SidebarToggle } from "./sidebar-toggle";
import type { TrashButton } from "./trash-button";
import type { TrashList } from "./trash-list";
import type { UpdateButton } from "./update-button";
import type { WorkspaceSwitcher } from "./workspace-switcher";

export type SidebarPane = "memos" | "search" | "trash";

/** The window's left column: a top row on the window's top line — the room for the traffic lights
 * and the app's name (macOS), the button that collapses the column at its right end — then the
 * workspace switcher above the memo list, or the search panel or the trash in its place (spec
 * 「창 배치」, memo trash spec 「휴지통 화면」), and at its foot — the window's bottom left — a row
 * with the settings and trash buttons and, when there is a newer version, the update button in the
 * rest of it. */
export class Sidebar {
  readonly el: HTMLElement;
  /** The top row, one height with the panes' tab bars (`--top-row-height`). */
  readonly head: HTMLElement;

  constructor(
    collapse: SidebarToggle,
    switcher: WorkspaceSwitcher,
    private readonly memoList: MemoList,
    private readonly search: SearchPanel,
    private readonly trash: TrashList,
    settings: SettingsButton,
    private readonly trashButton: TrashButton,
    update: UpdateButton,
  ) {
    this.head = h(
      "div",
      { class: "sidebar-head" },
      h("span", { class: "traffic-lights-room" }),
      h("span", { class: "app-name", textContent: "Tote Notes" }),
      collapse.el,
    );
    const footer = h("div", { class: "sidebar-footer" }, settings.el, trashButton.el, update.el);
    this.el = h(
      "nav",
      { class: "sidebar" },
      this.head,
      switcher.el,
      memoList.el,
      search.el,
      trash.el,
      footer,
    );
    this.show("memos");
  }

  /** The pane in the memo list's place. */
  shown: SidebarPane = "memos";

  show(pane: SidebarPane): void {
    this.shown = pane;
    this.memoList.el.hidden = pane !== "memos";
    this.search.el.hidden = pane !== "search";
    this.trash.el.hidden = pane !== "trash";
    this.trashButton.setOpen(pane === "trash");
  }
}
