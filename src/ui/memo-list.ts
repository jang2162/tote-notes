import type { ContentHit, MemoInfo, MemoSort } from "../backend/types";
import { splitName } from "../core/names";
import { h } from "./dom";
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

/** What the memo list asks of the window. */
export interface MemoListHost {
  open(id: string): void;
  /** A row's context menu (right click, ⌃click). */
  menu(id: string): void;
  /** The sort button: the order menu. */
  sort(): void;
  /** A row found by its content (spec 2026-10-30 「필터가 내용도 찾는다」): the memo, its cursor
   * on the match. `line` is 0-based; `column` counts characters in the whole line. */
  openAt(id: string, line: number, column: number): void;
  /** The memos holding `query` in their text, first match each. */
  find(query: string): Promise<ContentHit[]>;
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

/** One run of rows in a scroller of its own; only the rows in view are in the DOM. */
class RowSection {
  private readonly rows = h("div", { class: "memo-rows" });
  readonly el: HTMLElement;
  items: MemoInfo[] = [];

  constructor(
    className: string,
    private readonly draw: (memo: MemoInfo, index: number) => HTMLElement,
    private readonly rowHeight: () => number,
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
    this.rows.replaceChildren(
      ...this.items.slice(start, end).map((memo, i) => this.draw(memo, start + i)),
    );
  }
}

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
  private readonly pinned = new RowSection(
    "memo-pinned",
    (memo, i) => this.row(memo, i),
    () => this.rowHeight,
  );
  private readonly divider = h("div", { class: "memo-pinned-divider" });
  private readonly list = new RowSection(
    "memo-scroller",
    (memo, i) => this.row(memo, i),
    () => this.rowHeight,
  );
  readonly el = h(
    "div",
    { class: "memo-pane with-preview" },
    h("div", { class: "memo-filter-row" }, this.filter, this.sortButton),
    this.pinned.el,
    this.divider,
    this.list.el,
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
  /** The query of the ask on its way, `null` when none is. */
  private asking: string | null = null;

  constructor(private readonly host: MemoListHost) {
    this.list.el.append(this.none);
    this.filter.spellcheck = false;
    this.sortButton.setAttribute("aria-label", "정렬");
    this.sortButton.title = "정렬";
    this.sortButton.addEventListener("click", () => this.host.sort());
    this.filter.addEventListener("input", () => {
      this.list.el.scrollTop = 0;
      this.pinned.el.scrollTop = 0;
      this.queryChanged();
    });
  }

  get(id: string): MemoInfo | undefined {
    return this.memos.find((memo) => memo.id === id);
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

  /** A viewed time only moves on: an info a tab kept from before its last view keeps the list's. */
  upsert(info: MemoInfo): void {
    const listed = this.get(info.id)?.viewedMs;
    const viewedMs = Math.max(listed ?? -Infinity, info.viewedMs ?? -Infinity);
    const memo = Number.isFinite(viewedMs) ? { ...info, viewedMs } : info;
    this.setMemos([...this.memos.filter((each) => each.id !== info.id), memo]);
  }

  remove(id: string): void {
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
   * once typing stops. */
  private queryChanged(): void {
    if (this.findTimer !== null) clearTimeout(this.findTimer);
    this.findTimer = null;
    this.hits = new Map();
    this.hitsFor = "";
    const query = this.query;
    if (!query) {
      if (this.asking !== null) this.host.cancelFind();
      this.asking = null;
    } else {
      this.asking = query;
      this.findTimer = setTimeout(() => void this.find(query), SEARCH_DEBOUNCE_MS);
    }
    this.refilter();
  }

  private async find(query: string): Promise<void> {
    this.findTimer = null;
    let found: ContentHit[];
    try {
      found = await this.host.find(query);
    } catch (error) {
      console.warn(error);
      found = [];
    }
    // Typed on or emptied since: this answer is for a query no longer there.
    if (query !== this.query || this.asking !== query) return;
    this.asking = null;
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
    this.none.hidden = shown.length > 0 || !this.query || this.asking !== null;
    const { pinned, rest } = splitPinned(shown);
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

  private row(memo: MemoInfo, index: number): HTMLElement {
    const { stem, ext } = splitName(memo.file);
    const active = memo.id === this.activeId ? " active" : "";
    const row = h(
      "div",
      { class: `memo-row kind-${memo.kind}${active}`, title: memo.file },
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
    row.style.top = `${index * this.rowHeight}px`;
    row.addEventListener("click", () => {
      const hit = this.hitOf(memo);
      if (hit) this.host.openAt(memo.id, hit.line, hit.column);
      else this.host.open(memo.id);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.host.menu(memo.id);
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
