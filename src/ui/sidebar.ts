import { h } from "./dom";
import type { MemoList } from "./memo-list";
import type { SearchPanel } from "./search-panel";
import type { SettingsButton } from "./settings-button";
import type { UpdateButton } from "./update-button";
import type { WorkspaceSwitcher } from "./workspace-switcher";

export type SidebarPane = "memos" | "search";

/** The window's left column: the workspace switcher above the memo list, or the search panel in
 * its place (spec 「창 배치」), and at its foot — the window's bottom left — a row with the
 * settings button and, when there is a newer version, the update button beside it. */
export class Sidebar {
  readonly el: HTMLElement;

  constructor(
    switcher: WorkspaceSwitcher,
    private readonly memoList: MemoList,
    private readonly search: SearchPanel,
    settings: SettingsButton,
    update: UpdateButton,
  ) {
    const footer = h("div", { class: "sidebar-footer" }, settings.el, update.el);
    this.el = h("nav", { class: "sidebar" }, switcher.el, memoList.el, search.el, footer);
    this.show("memos");
  }

  show(pane: SidebarPane): void {
    this.memoList.el.hidden = pane !== "memos";
    this.search.el.hidden = pane !== "search";
  }
}
