import { describeError } from "../app/errors";
import { errorCode, type TextQuery, type TextScan, type TextSearch } from "../backend/types";
import { h } from "../ui/dom";

export const LINE_HEIGHT = 20;
/** Characters of a line that are put in the DOM; the rest is summarised. */
export const DISPLAY_LINE_LIMIT = 20_000;
/** Same as CHECKPOINT_LINES in src-tauri/src/files/text.rs. */
export const CHECKPOINT_LINES = 1000;
const OVERSCAN_LINES = 20;
/** The scrolled height is cut here: WebKit clips an element near 2^25 px, which at LINE_HEIGHT
 * is about 1.67 million lines. Past it the scroll range is scaled onto the whole file. */
export const MAX_SCROLL_HEIGHT = 10_000_000;

/** The scan the Rust side makes, for the fake backend and the tests. */
export function scanBytes(bytes: Uint8Array): TextScan {
  const checkpoints = [0];
  let lines = 0;
  let lineStart = 0;
  let longest = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 10) continue;
    longest = Math.max(longest, i - lineStart);
    lines++;
    lineStart = i + 1;
    if (lines % CHECKPOINT_LINES === 0) checkpoints.push(lineStart);
  }
  longest = Math.max(longest, bytes.length - lineStart);
  return { size: bytes.length, lineCount: lines + 1, checkpoints, longestLine: longest };
}

export const pageOf = (line: number): number => Math.floor(line / CHECKPOINT_LINES);

/** Byte range [start, end) of the lines of `page`. */
export function pageRange(scan: TextScan, page: number): [number, number] {
  return [scan.checkpoints[page], scan.checkpoints[page + 1] ?? scan.size];
}

/** Pixels of the scroll range and of the whole file (every line at LINE_HEIGHT) that the
 * viewport can move through. */
function scrollRanges(height: number, lineCount: number): [number, number] {
  return [MAX_SCROLL_HEIGHT - height, lineCount * LINE_HEIGHT - height];
}

/** Where in the whole file (pixels, every line at LINE_HEIGHT) the viewport's top is. */
export function virtualTop(scrollTop: number, height: number, lineCount: number): number {
  if (lineCount * LINE_HEIGHT <= MAX_SCROLL_HEIGHT) return scrollTop;
  const [scroll, file] = scrollRanges(height, lineCount);
  return scroll > 0 ? Math.min(1, Math.max(0, scrollTop / scroll)) * file : 0;
}

/** The scrollTop that puts `virtual` (as `virtualTop` returns it) at the viewport's top. */
export function scrollTopFor(virtual: number, height: number, lineCount: number): number {
  if (lineCount * LINE_HEIGHT <= MAX_SCROLL_HEIGHT) return virtual;
  const [scroll, file] = scrollRanges(height, lineCount);
  return file > 0 ? Math.min(1, Math.max(0, virtual / file)) * scroll : 0;
}

export function visibleLines(
  scrollTop: number,
  height: number,
  lineCount: number,
): [number, number] {
  return linesAround(virtualTop(scrollTop, height, lineCount), height, lineCount);
}

/** The lines to draw when the viewport's top is at `top` in the whole file. */
function linesAround(top: number, height: number, lineCount: number): [number, number] {
  const start = Math.max(0, Math.floor(top / LINE_HEIGHT) - OVERSCAN_LINES);
  const end = Math.min(lineCount, Math.ceil((top + height) / LINE_HEIGHT) + OVERSCAN_LINES);
  return [start, end];
}

export function displayLine(text: string): string {
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  if (line.length <= DISPLAY_LINE_LIMIT) return line;
  return `${line.slice(0, DISPLAY_LINE_LIMIT)} … (${line.length}자)`;
}

interface Options {
  url: string;
  scan: TextScan;
  fileName: string;
  search: (query: TextQuery, fromLine: number) => Promise<TextSearch>;
}

/** The read-only screen for files the editor must not load (spec 「크기별 단계」): lines come in
 * pages of CHECKPOINT_LINES through Range requests on the token URL, only the visible ones are
 * in the DOM, and search runs in the backend a page of matches at a time. */
export class LargeTextViewer {
  readonly el: HTMLElement;
  private readonly rows = h("div", { class: "large-text-rows" });
  private readonly scroller = h("div", { class: "large-text-scroller", tabIndex: 0 }, this.rows);
  private readonly count = h("span", { class: "large-text-count" });
  private readonly input = h("input", { type: "search", placeholder: "파일 안 찾기" });
  private readonly caseBox = h("input", { type: "checkbox" });
  private readonly regexBox = h("input", { type: "checkbox" });
  private readonly resize = new ResizeObserver(() => this.moveTo(this.top));
  private readonly pages = new Map<number, Promise<string[]>>();
  /** Where the viewport's top is in the whole file, in pixels with every line at LINE_HEIGHT.
   * On a scaled file the scroll position only approximates it, so the viewer keeps it. */
  private top = 0;
  /** The scrollTop this viewer last set; a scroll event elsewhere is the scroll bar dragged. */
  private setScrollTop = 0;
  private current = -1;
  private matches: { line: number; column: number }[] = [];
  private matchIndex = -1;
  private search: SearchRun | null = null;
  /** Numbers the renders: one that waited for its pages longer than a later one draws nothing. */
  private renders = 0;
  private destroyed = false;

  constructor(private readonly options: Options) {
    this.input.spellcheck = false;
    const next = h("button", { textContent: "다음" });
    const prev = h("button", { textContent: "이전" });
    next.addEventListener("click", () => void this.step(1));
    prev.addEventListener("click", () => void this.step(-1));
    this.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      void this.startSearch();
    });
    const search = h(
      "div",
      { class: "large-text-search" },
      this.input,
      h("label", {}, this.caseBox, "대소문자"),
      h("label", {}, this.regexBox, "정규식"),
      prev,
      next,
      this.count,
    );
    const info = h("span", {
      class: "large-text-info",
      textContent: `${options.scan.lineCount.toLocaleString("ko-KR")}줄`,
    });
    this.el = h(
      "div",
      { class: "large-text" },
      h("div", { class: "large-text-bar" }, search, info),
      this.scroller,
    );
    this.rows.style.height = `${Math.min(options.scan.lineCount * LINE_HEIGHT, MAX_SCROLL_HEIGHT)}px`;
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.scroller.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.scroller.addEventListener("keydown", (event) => this.onKey(event));
    this.resize.observe(this.scroller);
  }

  goToLine(line: number): void {
    this.current = line;
    this.moveTo(line * LINE_HEIGHT - this.scroller.clientHeight / 2);
  }

  destroy(): void {
    this.destroyed = true;
    this.resize.disconnect();
    this.el.remove();
  }

  private get scaled(): boolean {
    return this.options.scan.lineCount * LINE_HEIGHT > MAX_SCROLL_HEIGHT;
  }

  /** Puts the viewport's top at `top` (clamped to the file) and draws. */
  private moveTo(top: number): void {
    const height = this.scroller.clientHeight;
    const { lineCount } = this.options.scan;
    this.top = Math.max(0, Math.min(top, lineCount * LINE_HEIGHT - height));
    this.scroller.scrollTop = scrollTopFor(this.top, height, lineCount);
    this.setScrollTop = this.scroller.scrollTop;
    // Unscaled, the browser's clamped scrollTop is the position itself.
    if (!this.scaled) this.top = this.setScrollTop;
    void this.render();
  }

  private onScroll(): void {
    const { scrollTop, clientHeight } = this.scroller;
    if (this.scaled && Math.abs(scrollTop - this.setScrollTop) <= 1) return; // our own move
    // The scroll bar (or the browser) moved it: on a scaled file that is a jump in proportion.
    this.top = virtualTop(scrollTop, clientHeight, this.options.scan.lineCount);
    this.setScrollTop = scrollTop;
    void this.render();
  }

  /** On a scaled file one pixel of scrollTop is several lines, so the wheel and the keys move
   * the position itself, as far as they would move an unscaled page: reading down a log must not
   * skip lines. Unscaled files keep the browser's own scrolling. */
  private onWheel(event: WheelEvent): void {
    if (!this.scaled || event.ctrlKey) return;
    event.preventDefault();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? LINE_HEIGHT
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? this.scroller.clientHeight
          : 1;
    this.scroller.scrollLeft += event.deltaX * unit;
    if (event.deltaY) this.moveTo(this.top + event.deltaY * unit);
  }

  private onKey(event: KeyboardEvent): void {
    if (!this.scaled || event.metaKey || event.ctrlKey || event.altKey) return;
    const page = Math.max(LINE_HEIGHT, this.scroller.clientHeight - LINE_HEIGHT);
    const moves: Record<string, number> = {
      ArrowDown: 2 * LINE_HEIGHT,
      ArrowUp: -2 * LINE_HEIGHT,
      PageDown: page,
      PageUp: -page,
      " ": event.shiftKey ? -page : page,
      Home: -Infinity,
      End: Infinity,
    };
    const delta = moves[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const end = this.options.scan.lineCount * LINE_HEIGHT;
    this.moveTo(delta === -Infinity ? 0 : delta === Infinity ? end : this.top + delta);
  }

  private page(index: number): Promise<string[]> {
    let pending = this.pages.get(index);
    if (!pending) {
      const [start, end] = pageRange(this.options.scan, index);
      // A file ending in a newline after a whole page of lines has an empty last page: its
      // checkpoint is the file's end and a Range for it would be unsatisfiable.
      if (start >= end) return Promise.resolve([""]);
      pending = fetch(this.options.url, { headers: { Range: `bytes=${start}-${end - 1}` } })
        .then(async (response) => {
          if (!response.ok) throw new Error(`${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          // A server without Range support (the fake's data: URL) answers 200 with everything.
          const slice = response.status === 206 ? bytes : bytes.subarray(start, end);
          const text = new TextDecoder().decode(slice);
          const lines = text.split("\n");
          // The page ends at the next checkpoint, right after a newline — except the last page.
          if (end < this.options.scan.size || text.endsWith("\n")) lines.pop();
          return lines;
        })
        .catch((error: unknown) => {
          this.pages.delete(index);
          throw error;
        });
      this.pages.set(index, pending);
    }
    return pending;
  }

  private async render(): Promise<void> {
    const ticket = ++this.renders;
    const { scrollTop, clientHeight } = this.scroller;
    const [from, to] = linesAround(this.top, clientHeight, this.options.scan.lineCount);
    // Rows sit where the viewport is; on a scaled file their offset from it is the unscaled one.
    const shift = scrollTop - this.top;
    const needed = new Set<number>();
    for (let line = from; line < to; line++) needed.add(pageOf(line));
    const pages = new Map<number, string[]>();
    for (const index of needed) {
      try {
        pages.set(index, await this.page(index));
      } catch {
        pages.set(index, []);
      }
    }
    if (this.destroyed || ticket !== this.renders) return;
    const rows: HTMLElement[] = [];
    for (let line = from; line < to; line++) {
      const text = pages.get(pageOf(line))?.[line % CHECKPOINT_LINES] ?? "";
      const row = h("div", {
        class: `large-text-line${line === this.current ? " current" : ""}`,
        textContent: displayLine(text),
        data: { line: String(line) },
      });
      row.style.top = `${line * LINE_HEIGHT + shift}px`;
      rows.push(row);
    }
    this.rows.replaceChildren(...rows);
  }

  private query(): TextQuery {
    return {
      query: this.input.value,
      caseSensitive: this.caseBox.checked,
      regex: this.regexBox.checked,
    };
  }

  private async startSearch(): Promise<void> {
    const run: SearchRun = { query: this.query(), done: false, pending: null };
    this.search = run;
    this.matches = [];
    this.matchIndex = -1;
    await this.more(run, 0);
    if (this.search !== run || run.failed) return;
    if (this.matches.length) this.show(0);
    else this.count.textContent = "0";
  }

  /** The next page of matches of `run` from `fromLine`; a page that fills up is continued later.
   * One request at a time: a second ask while one is out waits for that one. An answer for a
   * search that has been replaced is dropped. */
  private more(run: SearchRun, fromLine: number): Promise<void> {
    if (run.done) return Promise.resolve();
    run.pending ??= this.options
      .search(run.query, fromLine)
      .then((result) => {
        if (this.destroyed || this.search !== run) return;
        this.matches.push(...result.matches);
        // A cancelled search stopped early (a newer one from this window); it is not finished.
        run.done = result.done;
      })
      .catch((error: unknown) => {
        if (this.destroyed || this.search !== run) return;
        run.done = true;
        run.failed = true;
        this.count.textContent =
          errorCode(error) === "bad-request" ? "잘못된 정규식" : describeError(error);
      })
      .finally(() => {
        run.pending = null;
      });
    return run.pending;
  }

  private async step(delta: number): Promise<void> {
    const run = this.search;
    if (!run || !this.matches.length) return this.startSearch();
    let index = this.matchIndex + delta;
    if (index >= this.matches.length && !run.done) {
      await this.more(run, this.matches[this.matches.length - 1].line + 1);
      if (this.search !== run) return;
    }
    index = (index + this.matches.length) % this.matches.length;
    this.show(index);
  }

  private show(index: number): void {
    const done = this.search?.done ?? true;
    this.matchIndex = index;
    this.count.textContent = `${index + 1} / ${this.matches.length}${done ? "" : "+"}`;
    this.goToLine(this.matches[index].line);
  }
}

/** One search: the query as it was entered — a page fetched later continues that query, not
 * what the box holds by then. */
interface SearchRun {
  query: TextQuery;
  done: boolean;
  failed?: boolean;
  pending: Promise<void> | null;
}
