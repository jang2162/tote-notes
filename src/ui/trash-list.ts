import type { TrashedInfo } from "../backend/types";
import { splitName } from "../core/names";
import { h } from "./dom";

/** What the trash list asks of the window. */
export interface TrashListHost {
  /** A row was pressed: the trashed memo, read-only. */
  open(id: string): void;
  /** A row's context menu (right click, ⌃click): 복구, 영구 삭제. */
  menu(id: string): void;
  /** 「← 메모」: back to the memo list. */
  back(): void;
  /** 「휴지통 비우기」. */
  empty(): void;
}

export const TRASH_EMPTY = "휴지통이 비었습니다";

/** When a memo went into the trash, in local time to the minute (`2026-11-01 14:05`): the digits
 * of the 「이전 버전」 list's labels (`versionLabel`) less the seconds. */
export function deletedLabel(ms: number): string {
  const at = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ` +
    `${two(at.getHours())}:${two(at.getMinutes())}`
  );
}

export interface TrashRow {
  id: string;
  file: string;
  stem: string;
  ext: string;
  kind: TrashedInfo["kind"];
  when: string;
}

/** What the trash pane shows for `items`: the rows most recently trashed first, the head's count,
 * the line in place of the rows when there are none, and whether 「휴지통 비우기」 has anything to do. */
export function trashView(items: TrashedInfo[]): {
  rows: TrashRow[];
  heading: string;
  none: string | null;
  canEmpty: boolean;
} {
  const rows = [...items]
    .sort((a, b) => b.deletedMs - a.deletedMs)
    .map(({ id, file, kind, deletedMs }) => ({
      id,
      file,
      ...splitName(file),
      kind,
      when: deletedLabel(deletedMs),
    }));
  return {
    rows,
    heading: `휴지통 ${rows.length}`,
    none: rows.length ? null : TRASH_EMPTY,
    canEmpty: rows.length > 0,
  };
}

/** The sidebar's trash pane, in the memo list's place while it shows (memo trash spec 「휴지통
 * 화면」): 「← 메모」 and the count on top, the trashed memos — no filter, no sort — and 「휴지통
 * 비우기」 at the foot. */
export class TrashList {
  private readonly heading = h("span", { class: "trash-heading" });
  private readonly rows = h("div", { class: "trash-rows" });
  private readonly none = h("p", { class: "trash-none", textContent: TRASH_EMPTY });
  private readonly emptyButton = h("button", {
    class: "trash-empty",
    type: "button",
    textContent: "휴지통 비우기",
  });
  readonly el: HTMLElement;
  private items: TrashedInfo[] = [];

  constructor(private readonly host: TrashListHost) {
    const back = h("button", { class: "trash-back", type: "button", textContent: "← 메모" });
    back.addEventListener("click", () => this.host.back());
    this.emptyButton.addEventListener("click", () => this.host.empty());
    this.el = h(
      "div",
      { class: "trash-pane" },
      h("div", { class: "trash-head" }, back, this.heading),
      h("div", { class: "trash-scroller" }, this.rows, this.none),
      h("div", { class: "trash-foot" }, this.emptyButton),
    );
    this.setItems([]);
  }

  get count(): number {
    return this.items.length;
  }

  get(id: string): TrashedInfo | undefined {
    return this.items.find((item) => item.id === id);
  }

  setItems(items: TrashedInfo[]): void {
    this.items = items;
    const view = trashView(items);
    this.heading.textContent = view.heading;
    this.none.hidden = view.none === null;
    this.emptyButton.disabled = !view.canEmpty;
    this.rows.replaceChildren(...view.rows.map((row) => this.row(row)));
  }

  private row(item: TrashRow): HTMLElement {
    const row = h(
      "div",
      { class: `trash-row kind-${item.kind}`, title: item.file },
      h("span", { class: "memo-icon" }),
      h(
        "span",
        { class: "memo-text" },
        h(
          "span",
          { class: "memo-title" },
          h("span", { class: "memo-name", textContent: item.stem }),
          item.ext ? h("span", { class: "memo-ext", textContent: item.ext }) : null,
        ),
        h("span", { class: "trash-when", textContent: item.when }),
      ),
    );
    row.addEventListener("click", () => this.host.open(item.id));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.host.menu(item.id);
    });
    return row;
  }
}
