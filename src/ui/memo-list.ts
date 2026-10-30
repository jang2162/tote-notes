import type { MemoInfo, MemoSort } from "../backend/types";
import { splitName } from "../core/names";
import { h } from "./dom";
import { sortMemos, splitPinned } from "./memo-order";

export const ROW_HEIGHT = 28;
/** A row with its preview line under the name (spec 2026-10-30 「미리보기」). */
export const PREVIEW_ROW_HEIGHT = 46;
const OVERSCAN_ROWS = 8;

/** For matching only: Finder may hand over decomposed (NFD) Hangul while typed text is composed. */
const fold = (text: string) => text.normalize("NFC").toLocaleLowerCase();

export function filterMemos(memos: readonly MemoInfo[], query: string): MemoInfo[] {
  const wanted = fold(query.trim());
  return wanted ? memos.filter((memo) => fold(memo.file).includes(wanted)) : [...memos];
}

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
 * other memo, newest first, all filtered by name (spec 「메모 목록」, 2026-10-30 「고정」). */
export class MemoList {
  private readonly filter = h("input", {
    type: "search",
    placeholder: "제목 필터",
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
  private memos: MemoInfo[] = [];
  private activeId: string | null = null;
  private sort: MemoSort = "modified-desc";
  private preview = true;

  constructor(private readonly host: MemoListHost) {
    this.filter.spellcheck = false;
    this.sortButton.setAttribute("aria-label", "정렬");
    this.sortButton.title = "정렬";
    this.sortButton.addEventListener("click", () => this.host.sort());
    this.filter.addEventListener("input", () => {
      this.list.el.scrollTop = 0;
      this.pinned.el.scrollTop = 0;
      this.refilter();
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

  private refilter(): void {
    const { pinned, rest } = splitPinned(filterMemos(this.memos, this.filter.value));
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
        this.preview ? h("span", { class: "memo-preview", textContent: memo.preview ?? "" }) : null,
      ),
      memo.pinned ? pinMark() : null,
    );
    row.style.top = `${index * this.rowHeight}px`;
    row.addEventListener("click", () => this.host.open(memo.id));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.host.menu(memo.id);
    });
    return row;
  }
}
