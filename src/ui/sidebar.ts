import { h } from "./dom";
import type { MemoList } from "./memo-list";
import type { SearchPanel } from "./search-panel";

export type SidebarPane = "memos" | "search";

/** The window's left column: the memo list, or the search panel in its place (spec 「창 배치」). */
export class Sidebar {
  readonly el: HTMLElement;

  constructor(
    private readonly memoList: MemoList,
    private readonly search: SearchPanel,
  ) {
    this.el = h("nav", { class: "sidebar" }, memoList.el, search.el);
    this.show("memos");
  }

  show(pane: SidebarPane): void {
    this.memoList.el.hidden = pane !== "memos";
    this.search.el.hidden = pane !== "search";
  }
}
