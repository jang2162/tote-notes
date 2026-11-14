import type { TrashedInfo } from "../backend/types";
import { splitName } from "../core/names";
import { modalOpen } from "./dialogs";
import { h } from "./dom";
import { ListSelection, listKey } from "./list-selection";

/** What the trash list asks of the window. */
export interface TrashListHost {
  /** A row was pressed, or Enter: the trashed memo, read-only. */
  open(id: string): Promise<void>;
  /** The context menu of the rows picked (right click, ⌃click, ⇧F10): 복구, 영구 삭제. */
  menu(ids: string[]): Promise<void>;
  /** ⌘⌫: the rows picked removed for good, once the person said so. */
  purge(ids: string[]): Promise<void>;
  /** The keys to the focused pane's tab. */
  toEditor(): void;
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

/** A trashed row's element ID, which the list's `aria-activedescendant` names. */
const optionId = (id: string) => `trash-option-${id}`;

/** The sidebar's trash pane, in the memo list's place while it shows (memo trash spec 「휴지통
 * 화면」): 「← 메모」 and the count on top, the trashed memos — no filter, no sort — and 「휴지통
 * 비우기」 at the foot. The rows take the memo list's keys and picks (list keyboard spec 「휴지통
 * 목록」). */
export class TrashList {
  private readonly heading = h("span", { class: "trash-heading" });
  private readonly rows = h("div", { class: "trash-rows" });
  private readonly box = h("div", { class: "trash-scroller", tabIndex: 0 });
  private readonly picks = new ListSelection();
  /** The trashed memo the focused pane shows. */
  private activeId: string | null = null;
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
      this.box,
      h("div", { class: "trash-foot" }, this.emptyButton),
    );
    this.box.append(this.rows, this.none);
    this.box.setAttribute("role", "listbox");
    this.box.setAttribute("aria-label", "휴지통 목록");
    this.box.setAttribute("aria-multiselectable", "true");
    this.box.addEventListener("keydown", (event) => this.onKey(event));
    this.setItems([]);
  }

  setActive(id: string | null): void {
    this.activeId = id;
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
    this.picks.setOrder(view.rows.map((row) => row.id));
    this.rows.replaceChildren(...view.rows.map((row) => this.row(row)));
    this.paint();
  }

  /** Marks the rows picked and the current one. */
  private paint(): void {
    for (const el of this.rows.children) {
      const id = (el as HTMLElement).dataset.id!;
      const picked = this.picks.isPicked(id);
      el.setAttribute("aria-selected", String(picked));
      el.classList.toggle("picked", picked);
      el.classList.toggle("current", id === this.picks.cursor);
    }
    const cursor = this.picks.cursor;
    if (cursor === null) this.box.removeAttribute("aria-activedescendant");
    else this.box.setAttribute("aria-activedescendant", optionId(cursor));
    this.box.classList.toggle("several", this.picks.size > 1);
  }

  private onKey(event: KeyboardEvent): void {
    const key = listKey(event);
    if (!key) return;
    event.preventDefault();
    if (key.kind === "move") {
      if (key.to === "first" || key.to === "last") this.picks.to(key.to, key.extend);
      else this.picks.step(this.stepOf(key.to), key.extend);
      this.paint();
      const cursor = this.picks.cursor;
      if (cursor !== null)
        this.box.querySelector(`[id="${optionId(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (key.kind === "all") {
      this.picks.selectAll();
      this.paint();
    } else if (key.kind === "open") void this.openCurrent(key.toEditor);
    else if (key.kind === "delete") void this.purgePicked();
    else this.openMenu(this.picks.menuFor(this.picks.cursor));
  }

  private stepOf(to: "up" | "down" | "page-up" | "page-down"): number {
    const row = this.rows.firstElementChild?.getBoundingClientRect().height || 46;
    const page = Math.max(1, Math.floor(this.box.clientHeight / row) - 1);
    return { up: -1, down: 1, "page-up": -page, "page-down": page }[to];
  }

  /** As the memo list's Enter: the keys stay here but for ⌘Enter and a row already on show. */
  private async openCurrent(toEditor: boolean): Promise<void> {
    const id = this.picks.cursor;
    if (id === null) return;
    if (id === this.activeId) return this.host.toEditor();
    await this.host.open(id);
    if (toEditor) this.host.toEditor();
    else if (!modalOpen()) this.box.focus({ preventScroll: true });
  }

  /** ⌘⌫ asks first (the host's question gives the keys back here when it closes). */
  private async purgePicked(): Promise<void> {
    const ids = this.picks.targets();
    if (ids.length) await this.host.purge(ids);
  }

  private openMenu(ids: string[]): void {
    this.paint();
    if (ids.length) void this.host.menu(ids);
  }

  private row(item: TrashRow): HTMLElement {
    const row = h(
      "div",
      {
        class: `trash-row kind-${item.kind}`,
        title: item.file,
        id: optionId(item.id),
        data: { id: item.id },
      },
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
    row.setAttribute("role", "option");
    row.setAttribute("aria-label", item.file);
    row.addEventListener("mousedown", (event) => {
      if (event.shiftKey) event.preventDefault();
    });
    row.addEventListener("click", (event) => {
      if (event.metaKey || event.shiftKey) {
        this.picks.press(item.id, { toggle: event.metaKey, range: event.shiftKey });
        this.paint();
        this.box.focus({ preventScroll: true });
        return;
      }
      this.picks.only(item.id);
      this.paint();
      void this.host.open(item.id);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openMenu(this.picks.menuFor(item.id));
    });
    return row;
  }
}
