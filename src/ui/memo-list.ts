import type { ContentHit, MemoInfo, MemoSort, MenuPoint } from "../backend/types";
import { splitName } from "../core/names";
import { modalOpen } from "./dialogs";
import { h, placeChildren } from "./dom";
import { ListSelection, listKey } from "./list-selection";
import { filterMemos, snippet, sortMemos, splitPinned } from "./memo-order";
import { SEARCH_DEBOUNCE_MS } from "./search-panel";

export const ROW_HEIGHT = 28;
/** A row with its preview line under the name (spec 2026-10-30 「미리보기」). */
export const PREVIEW_ROW_HEIGHT = 46;
const OVERSCAN_ROWS = 8;

/** Rows [start, end) worth rendering for a viewport, with some to spare on both sides. A
 * workspace may hold 10,000 memos; only these exist in the DOM. */
export function visibleRows(
  scrollTop: number,
  height: number,
  count: number,
  rowHeight = ROW_HEIGHT,
): [number, number] {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const end = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN_ROWS);
  return [start, end];
}

/** Where a menu opened from the keys shows: under the left end of the row whose option has `id`,
 * else under the list's top (list keyboard spec 「문맥 메뉴」). In window CSS pixels. */
export function belowRow(list: HTMLElement, id: string): MenuPoint {
  const row = list.querySelector(`[id="${id}"]`)?.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  return row ? { x: row.left, y: row.bottom } : { x: box.left, y: box.top };
}

/** What the memo list asks of the window. */
export interface MemoListHost {
  open(id: string): Promise<void>;
  /** The context menu of the rows picked (right click, ⌃click, ⇧F10): what it picks applies to
   * every one of them. At `at` from the keys, at the pointer without it. */
  menu(ids: string[], at?: MenuPoint): Promise<void>;
  /** ⌘⌫: the memos to the trash, without asking. */
  trash(ids: string[]): Promise<void>;
  /** The keys to the focused pane's tab. */
  toEditor(): void;
  /** The sort button: the order menu. */
  sort(): void;
  /** A row found by its content (spec 2026-10-30 「필터가 내용도 찾는다」): the memo, its cursor
   * on the match. `line` is 0-based; `column` counts characters in the whole line. */
  openAt(id: string, line: number, column: number): Promise<void>;
  /** The memos holding `query` in their text, first match each; `null` when a newer ask or a
   * cancel stopped this one. */
  find(query: string): Promise<ContentHit[] | null>;
  /** The filter was emptied: the content filter running stops. */
  cancelFind(): void;
}

const SVG = "http://www.w3.org/2000/svg";

/** The mark of a pinned row: a pushpin. */
function pinMark(): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("class", "memo-pin");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute(
    "d",
    "M10 1.5 14.5 6l-2 .8-2.6 2.6.6 3.1-1.1 1.1L6.6 10.8 3 14.5 1.5 13l3.7-3.6-2.8-2.8 1.1-1.1 3.1.6L9.2 3.5z",
  );
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

/** The sort button's mark: arrows up and down. */
function sortMark(): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M5 2v10.5M2 9.5l3 3 3-3M11 14V3.5M8 6.5l3-3 3 3");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

/** One run of rows in a scroller of its own; only the rows in view are in the DOM. A row that
 * would be drawn the same (`look`) keeps its element from one render to the next: the list is
 * drawn again at any moment — a save's answer, a scroll — and a row made anew under a press gets
 * no click when the press is let go (`placeChildren`). */
class RowSection {
  private readonly rows = h("div", { class: "memo-rows" });
  readonly el: HTMLElement;
  items: MemoInfo[] = [];
  /** The rows in the DOM, by memo ID. */
  private drawn = new Map<string, { look: string; el: HTMLElement }>();

  constructor(
    className: string,
    private readonly draw: (memo: MemoInfo) => HTMLElement,
    /** Everything `draw` shows of a memo, but where its row is. */
    private readonly look: (memo: MemoInfo) => string,
    private readonly rowHeight: () => number,
    /** Marks a row drawn as picked or current, on the element as it is: a row made anew under a
     * press would lose the click, so the picks are not part of its look. Then once all are. */
    private readonly paint: (id: string, el: HTMLElement) => void,
    private readonly painted: () => void,
  ) {
    this.el = h("div", { class: className }, this.rows);
    this.el.addEventListener("scroll", () => this.render(), { passive: true });
    new ResizeObserver(() => this.render()).observe(this.el);
  }

  render(): void {
    const rowHeight = this.rowHeight();
    this.rows.style.height = `${this.items.length * rowHeight}px`;
    const [start, end] = visibleRows(
      this.el.scrollTop,
      this.el.clientHeight,
      this.items.length,
      rowHeight,
    );
    const drawn = new Map<string, { look: string; el: HTMLElement }>();
    this.items.slice(start, end).forEach((memo, i) => {
      const look = this.look(memo);
      const had = this.drawn.get(memo.id);
      const row = had?.look === look ? had : { look, el: this.draw(memo) };
      row.el.style.top = `${(start + i) * rowHeight}px`;
      drawn.set(memo.id, row);
    });
    this.drawn = drawn;
    placeChildren(
      this.rows,
      [...drawn.values()].map(({ el }) => el),
    );
    for (const [id, { el }] of drawn) this.paint(id, el);
    this.painted();
  }

  /** Scrolls the row at `at` into view. */
  reveal(at: number): void {
    const rowHeight = this.rowHeight();
    const top = at * rowHeight;
    if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (top + rowHeight > this.el.scrollTop + this.el.clientHeight)
      this.el.scrollTop = top + rowHeight - this.el.clientHeight;
  }
}

/** A memo row's element ID, which the list's `aria-activedescendant` names. */
const optionId = (id: string) => `memo-option-${id}`;

/** The sidebar's memo pane: the pinned memos in a zone that stays put above the list, then every
 * other memo in the order picked, all filtered by name at once and by content a moment later
 * (spec 「메모 목록」, 2026-10-30 「고정」·「정렬」·「필터가 내용도 찾는다」). */
export class MemoList {
  private readonly filter = h("input", {
    type: "search",
    placeholder: "제목·내용 검색",
    class: "memo-filter",
  });
  private readonly sortButton = h("button", { class: "memo-sort", type: "button" }, sortMark());
  private readonly picks = new ListSelection();
  private readonly pinned = new RowSection(
    "memo-pinned",
    (memo) => this.row(memo),
    (memo) => this.rowLook(memo),
    () => this.rowHeight,
    (id, el) => this.paint(id, el),
    () => this.painted(),
  );
  private readonly divider = h("div", { class: "memo-pinned-divider" });
  private readonly list = new RowSection(
    "memo-scroller",
    (memo) => this.row(memo),
    (memo) => this.rowLook(memo),
    () => this.rowHeight,
    (id, el) => this.paint(id, el),
    () => this.painted(),
  );
  /** One stop of Tab for both zones: the keys stay on it and `aria-activedescendant` names the
   * current row, which comes and goes with the scroll (list keyboard spec 「자리와 역할」). */
  private readonly box = h(
    "div",
    { class: "memo-listbox", tabIndex: 0 },
    this.pinned.el,
    this.divider,
    this.list.el,
  );
  readonly el = h(
    "div",
    { class: "memo-pane with-preview" },
    h("div", { class: "memo-filter-row" }, this.filter, this.sortButton),
    this.box,
  );
  private readonly none = h("p", { class: "memo-none", textContent: "맞는 메모가 없습니다" });
  private memos: MemoInfo[] = [];
  private activeId: string | null = null;
  private sort: MemoSort = "modified-desc";
  private preview = true;
  /** The content filter's answer for `hitsFor`, by memo ID. */
  private hits = new Map<string, ContentHit>();
  private hitsFor = "";
  /** The content filter waits for typing to stop (`SEARCH_DEBOUNCE_MS`), then asks. */
  private findTimer: ReturnType<typeof setTimeout> | null = null;
  /** The trimmed query the list was last filtered for: typing that leaves it so changes nothing. */
  private filtered = "";
  /** Numbers the asks: only the latest one's answer is taken, whatever its query. */
  private ask = 0;
  /** The latest ask has not answered yet. */
  private asking = false;

  constructor(private readonly host: MemoListHost) {
    this.list.el.append(this.none);
    this.filter.spellcheck = false;
    this.sortButton.setAttribute("aria-label", "정렬");
    this.sortButton.title = "정렬";
    this.sortButton.addEventListener("click", () => this.host.sort());
    this.filter.addEventListener("input", () => this.queryChanged());
    this.filter.addEventListener("keydown", (event) => this.onFilterKey(event));
    this.box.setAttribute("role", "listbox");
    this.box.setAttribute("aria-label", "메모 목록");
    this.box.setAttribute("aria-multiselectable", "true");
    this.divider.setAttribute("role", "none");
    this.box.addEventListener("keydown", (event) => this.onKey(event));
  }

  /** The keys on the list, its current row as it was. */
  focus(): void {
    this.box.focus({ preventScroll: true });
  }

  get(id: string): MemoInfo | undefined {
    return this.memos.find((memo) => memo.id === id);
  }

  /** The memo whose file is `name`, both read in NFC. */
  byFile(name: string): MemoInfo | undefined {
    const wanted = name.normalize("NFC");
    return this.memos.find((memo) => memo.file.normalize("NFC") === wanted);
  }

  /** Every memo listed, filter or not (빠른 열기 looks through them). */
  get all(): readonly MemoInfo[] {
    return this.memos;
  }

  get order(): MemoSort {
    return this.sort;
  }

  private get rowHeight(): number {
    return this.preview ? PREVIEW_ROW_HEIGHT : ROW_HEIGHT;
  }

  /** Each row's second line with the start of its text, on or off. */
  setPreview(on: boolean): void {
    if (on === this.preview) return;
    this.preview = on;
    this.el.classList.toggle("with-preview", on);
    this.refilter();
  }

  /** The order of every list; the scroll stays where it is. */
  setSort(sort: MemoSort): void {
    if (sort === this.sort) return;
    this.sort = sort;
    this.setMemos(this.memos);
  }

  setMemos(memos: MemoInfo[]): void {
    this.memos = sortMemos(memos, this.sort);
    this.refilter();
  }

  /** How many times the window put a memo in or took one out itself (`upsert`, `remove`): a
   * listing asked for before the latest of them is older than what the list holds. */
  get edits(): number {
    return this.editCount;
  }

  private editCount = 0;

  /** A viewed time only moves on: an info a tab kept from before its last view keeps the list's. */
  upsert(info: MemoInfo): void {
    this.editCount++;
    const listed = this.get(info.id)?.viewedMs;
    const viewedMs = Math.max(listed ?? -Infinity, info.viewedMs ?? -Infinity);
    const memo = Number.isFinite(viewedMs) ? { ...info, viewedMs } : info;
    this.setMemos([...this.memos.filter((each) => each.id !== info.id), memo]);
  }

  remove(id: string): void {
    this.editCount++;
    this.memos = this.memos.filter((memo) => memo.id !== id);
    this.refilter();
  }

  setActive(id: string | null): void {
    this.activeId = id;
    this.render();
  }

  private get query(): string {
    return this.filter.value.trim();
  }

  /** Names match at once; the content's answer for the old query is dropped and a new one asked
   * once typing stops. A query the same once trimmed (a space typed after it, a composition
   * committed as it was) leaves everything as it is. */
  private queryChanged(): void {
    const query = this.query;
    if (query === this.filtered) return;
    this.filtered = query;
    this.list.el.scrollTop = 0;
    this.pinned.el.scrollTop = 0;
    if (this.findTimer !== null) clearTimeout(this.findTimer);
    this.findTimer = null;
    this.hits = new Map();
    this.hitsFor = "";
    const ask = ++this.ask;
    if (!query) {
      if (this.asking) this.host.cancelFind();
      this.asking = false;
    } else {
      this.asking = true;
      this.findTimer = setTimeout(() => void this.find(query, ask), SEARCH_DEBOUNCE_MS);
    }
    this.refilter();
  }

  private async find(query: string, ask: number): Promise<void> {
    this.findTimer = null;
    let found: ContentHit[] | null;
    try {
      found = await this.host.find(query);
    } catch (error) {
      console.warn(error);
      found = [];
    }
    // Typed on or emptied since: this answer is for an ask no longer the latest — even one of
    // the same query, which a later ask may have cancelled (it answers `null`).
    if (ask !== this.ask || found === null) return;
    this.asking = false;
    this.hits = new Map(found.map((hit) => [hit.memoId, hit]));
    this.hitsFor = query;
    this.refilter();
  }

  /** The row's content match, when the filter found it by its content for the query there is. */
  private hitOf(memo: MemoInfo): ContentHit | undefined {
    return this.hitsFor === this.query ? this.hits.get(memo.id) : undefined;
  }

  private refilter(): void {
    const shown = filterMemos(
      this.memos,
      this.query,
      this.hitsFor === this.query ? this.hits : undefined,
    );
    // Said only once the content's answer is in: until then a memo may still turn up.
    this.none.hidden = shown.length > 0 || !this.query || this.asking;
    const { pinned, rest } = splitPinned(shown);
    this.picks.setOrder([...pinned, ...rest].map((memo) => memo.id));
    this.pinned.items = pinned;
    this.list.items = rest;
    this.pinned.el.hidden = pinned.length === 0;
    this.divider.hidden = pinned.length === 0;
    // As tall as its rows, up to the stylesheet's share of the pane; past it, it scrolls.
    this.pinned.el.style.height = `${pinned.length * this.rowHeight}px`;
    this.render();
  }

  private render(): void {
    this.pinned.render();
    this.list.render();
  }

  private paint(id: string, el: HTMLElement): void {
    const picked = this.picks.isPicked(id);
    el.setAttribute("aria-selected", String(picked));
    el.classList.toggle("picked", picked);
    el.classList.toggle("current", id === this.picks.cursor);
  }

  /** The current row is named only while it is drawn: one scrolled away has no element. */
  private painted(): void {
    const cursor = this.picks.cursor;
    const drawn = cursor !== null && this.box.querySelector(`[id="${optionId(cursor)}"]`);
    if (drawn) this.box.setAttribute("aria-activedescendant", optionId(cursor));
    else this.box.removeAttribute("aria-activedescendant");
    // One row picked shows only while the list has the keys: a plain press picks the row it opens
    // and gives the keys to the editor, where the active row's colour says it all.
    this.box.classList.toggle("several", this.picks.size > 1);
  }

  /** The current row in view, and drawn. */
  private reveal(): void {
    const id = this.picks.cursor;
    for (const section of [this.pinned, this.list]) {
      const at = section.items.findIndex((memo) => memo.id === id);
      if (at >= 0) section.reveal(at);
    }
    this.render();
  }

  /** ↓ from the filter: the list's first row (list keyboard spec 「키」). */
  private onFilterKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" || event.metaKey || event.shiftKey || event.altKey) return;
    if (event.ctrlKey || event.isComposing || event.keyCode === 229) return;
    const first = this.pinned.items[0] ?? this.list.items[0];
    if (!first) return;
    event.preventDefault();
    this.picks.only(first.id);
    this.reveal();
    this.focus();
  }

  private onKey(event: KeyboardEvent): void {
    const key = listKey(event);
    if (!key) return;
    event.preventDefault();
    if (key.kind === "held") return;
    if (key.kind === "move") {
      if (key.to === "up" && !key.extend && this.picks.index === 0) {
        this.filter.focus();
        return;
      }
      if (key.to === "first" || key.to === "last") this.picks.to(key.to, key.extend);
      else this.picks.step(this.stepOf(key.to), key.extend);
      this.reveal();
    } else if (key.kind === "all") {
      this.picks.selectAll();
      this.render();
    } else if (key.kind === "open") void this.openCurrent(key.toEditor);
    else if (key.kind === "delete") void this.trashPicked();
    else void this.menuFromKeys();
  }

  /** ⇧F10: the menu of what is picked; whatever it did, the keys come back here. */
  private async menuFromKeys(): Promise<void> {
    const ids = this.picks.menuFor(this.picks.cursor);
    this.render();
    if (ids.length === 0) return;
    await this.host.menu(ids, belowRow(this.box, optionId(this.picks.cursor ?? "")));
    this.keepKeys();
  }

  /** Rows a key moves: one, or a page of the list below the pinned zone less one row. */
  private stepOf(to: "up" | "down" | "page-up" | "page-down"): number {
    const page = Math.max(1, Math.floor(this.list.el.clientHeight / this.rowHeight) - 1);
    return { up: -1, down: 1, "page-up": -page, "page-down": page }[to];
  }

  /** Enter: the current row's memo in the focused pane, the keys kept here — but for ⌘Enter, and
   * for the memo the pane shows already, whose tab takes them. */
  private async openCurrent(toEditor: boolean): Promise<void> {
    const id = this.picks.cursor;
    const memo = id === null ? undefined : this.get(id);
    if (!memo) return;
    if (memo.id === this.activeId) return this.host.toEditor();
    const hit = this.hitOf(memo);
    await (hit ? this.host.openAt(memo.id, hit.line, hit.column) : this.host.open(memo.id));
    if (toEditor) this.host.toEditor();
    else this.keepKeys();
  }

  /** ⌘⌫: what is picked to the trash; the keys stay here, on the row now in the place of the
   * current one, though a tab closing took them. */
  private async trashPicked(): Promise<void> {
    const ids = this.picks.targets();
    if (ids.length === 0) return;
    await this.host.trash(ids);
    this.keepKeys();
  }

  /** Back to the list, unless a dialog has them now. */
  private keepKeys(): void {
    if (!modalOpen()) this.focus();
  }

  private openMenu(ids: string[]): void {
    this.render();
    if (ids.length) void this.host.menu(ids);
  }

  /** Everything `row` draws of `memo`. Its listeners go by the memo's ID alone, so a row kept
   * for a memo whose other fields changed (its size, its times) still acts on the right one. */
  private rowLook(memo: MemoInfo): string {
    const hit = this.preview ? this.hitOf(memo) : undefined;
    return JSON.stringify([
      memo.file,
      memo.kind,
      Boolean(memo.pinned),
      memo.id === this.activeId,
      this.preview && (hit ? [hit, this.query] : (memo.preview ?? "")),
    ]);
  }

  private row(memo: MemoInfo): HTMLElement {
    const { stem, ext } = splitName(memo.file);
    const active = memo.id === this.activeId ? " active" : "";
    const row = h(
      "div",
      { class: `memo-row kind-${memo.kind}${active}`, title: memo.file, id: optionId(memo.id) },
      h("span", { class: "memo-icon" }),
      h(
        "span",
        { class: "memo-text" },
        h(
          "span",
          { class: "memo-title" },
          h("span", { class: "memo-name", textContent: stem }),
          ext ? h("span", { class: "memo-ext", textContent: ext }) : null,
        ),
        this.preview ? this.previewLine(memo) : null,
      ),
      memo.pinned ? pinMark() : null,
    );
    row.setAttribute("role", "option");
    row.setAttribute("aria-label", memo.file);
    // A ⇧ press would also select the page's text from the last press; the list takes the keys
    // itself on the click.
    row.addEventListener("mousedown", (event) => {
      if (event.shiftKey) event.preventDefault();
    });
    row.addEventListener("click", (event) => {
      // ⌘ adds or takes out, ⇧ picks a run; neither opens (list keyboard spec 「누르기」).
      if (event.metaKey || event.shiftKey) {
        this.picks.press(memo.id, { toggle: event.metaKey, range: event.shiftKey });
        this.render();
        this.focus();
        return;
      }
      this.picks.only(memo.id);
      this.render();
      const hit = this.hitOf(memo);
      void (hit ? this.host.openAt(memo.id, hit.line, hit.column) : this.host.open(memo.id));
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openMenu(this.picks.menuFor(memo.id));
    });
    return row;
  }

  /** The preview, or for a memo found by its content the matching line, the match marked. */
  private previewLine(memo: MemoInfo): HTMLElement {
    const hit = this.hitOf(memo);
    if (!hit) return h("span", { class: "memo-preview", textContent: memo.preview ?? "" });
    const { before, match, after } = snippet(hit, this.query);
    return h(
      "span",
      { class: "memo-preview memo-hit" },
      before,
      match ? h("mark", { textContent: match }) : null,
      after,
    );
  }
}
