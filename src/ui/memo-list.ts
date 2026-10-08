import type { MemoInfo } from "../backend/types";
import { splitName } from "../core/names";
import { h } from "./dom";

export const ROW_HEIGHT = 28;
const OVERSCAN_ROWS = 8;

/** For matching only: Finder may hand over decomposed (NFD) Hangul while typed text is composed. */
const fold = (text: string) => text.normalize("NFC").toLocaleLowerCase();

export function filterMemos(memos: readonly MemoInfo[], query: string): MemoInfo[] {
  const wanted = fold(query.trim());
  return wanted ? memos.filter((memo) => fold(memo.file).includes(wanted)) : [...memos];
}

/** Most recently modified first, ties by name — the order the backend lists in. */
export function byRecent(a: MemoInfo, b: MemoInfo): number {
  return b.modifiedMs - a.modifiedMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}

/** Rows [start, end) worth rendering for a viewport, with some to spare on both sides. A
 * workspace may hold 10,000 memos; only these exist in the DOM. */
export function visibleRows(scrollTop: number, height: number, count: number): [number, number] {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const end = Math.min(count, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN_ROWS);
  return [start, end];
}

/** The sidebar: every memo, newest first, filtered by name (spec 「메모 목록」). */
export class MemoList {
  private readonly filter = h("input", {
    type: "search",
    placeholder: "제목 필터",
    class: "memo-filter",
  });
  private readonly rows = h("div", { class: "memo-rows" });
  private readonly scroller = h("div", { class: "memo-scroller" }, this.rows);
  readonly el = h("nav", { class: "sidebar" }, this.filter, this.scroller);
  private memos: MemoInfo[] = [];
  private shown: MemoInfo[] = [];
  private activeId: string | null = null;

  constructor(private readonly onOpen: (id: string) => void) {
    this.filter.spellcheck = false;
    this.filter.addEventListener("input", () => this.refilter());
    this.scroller.addEventListener("scroll", () => this.render(), { passive: true });
    new ResizeObserver(() => this.render()).observe(this.scroller);
  }

  get(id: string): MemoInfo | undefined {
    return this.memos.find((memo) => memo.id === id);
  }

  setMemos(memos: MemoInfo[]): void {
    this.memos = [...memos].sort(byRecent);
    this.refilter();
  }

  upsert(info: MemoInfo): void {
    this.memos = [...this.memos.filter((memo) => memo.id !== info.id), info].sort(byRecent);
    this.refilter();
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
    this.shown = filterMemos(this.memos, this.filter.value);
    this.render();
  }

  private render(): void {
    this.rows.style.height = `${this.shown.length * ROW_HEIGHT}px`;
    const [start, end] = visibleRows(
      this.scroller.scrollTop,
      this.scroller.clientHeight,
      this.shown.length,
    );
    this.rows.replaceChildren(
      ...this.shown.slice(start, end).map((memo, i) => this.row(memo, start + i)),
    );
  }

  private row(memo: MemoInfo, index: number): HTMLElement {
    const { stem, ext } = splitName(memo.file);
    const active = memo.id === this.activeId ? " active" : "";
    const row = h(
      "div",
      { class: `memo-row kind-${memo.kind}${active}`, title: memo.file },
      h("span", { class: "memo-icon" }),
      h("span", { class: "memo-name", textContent: stem }),
      ext ? h("span", { class: "memo-ext", textContent: ext }) : null,
    );
    row.style.top = `${index * ROW_HEIGHT}px`;
    row.addEventListener("click", () => this.onOpen(memo.id));
    return row;
  }
}
