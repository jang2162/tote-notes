import { h } from "./dom";
import type { MemoList } from "./memo-list";
import type { SearchPanel } from "./search-panel";
import type { WorkspaceSwitcher } from "./workspace-switcher";

export type SidebarPane = "memos" | "search";

/** The window's left column: the workspace switcher above the memo list, or the search panel in
 * its place (spec 「창 배치」). */
export class Sidebar {
  readonly el: HTMLElement;

  constructor(
    switcher: WorkspaceSwitcher,
    private readonly memoList: MemoList,
    private readonly search: SearchPanel,
  ) {
    this.el = h("nav", { class: "sidebar" }, switcher.el, memoList.el, search.el);
    this.show("memos");
  }

  show(pane: SidebarPane): void {
    this.memoList.el.hidden = pane !== "memos";
    this.search.el.hidden = pane !== "search";
  }
}
