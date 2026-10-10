import type { TextQuery, TextScan, TextSearch } from "../backend/types";
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
  const top = virtualTop(scrollTop, height, lineCount);
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
  private readonly scroller = h("div", { class: "large-text-scroller" }, this.rows);
  private readonly count = h("span", { class: "large-text-count" });
  private readonly input = h("input", { type: "search", placeholder: "파일 안 찾기" });
  private readonly caseBox = h("input", { type: "checkbox" });
  private readonly regexBox = h("input", { type: "checkbox" });
  private readonly resize = new ResizeObserver(() => void this.render());
  private readonly pages = new Map<number, Promise<string[]>>();
  private current = -1;
  private matches: { line: number; column: number }[] = [];
  private matchIndex = -1;
  private searchDone = true;
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
    this.scroller.addEventListener("scroll", () => void this.render(), { passive: true });
    this.resize.observe(this.scroller);
  }

  goToLine(line: number): void {
    this.current = line;
    const height = this.scroller.clientHeight;
    this.scroller.scrollTop = scrollTopFor(
      Math.max(0, line * LINE_HEIGHT - height / 2),
      height,
      this.options.scan.lineCount,
    );
    void this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.resize.disconnect();
    this.el.remove();
  }

  private page(index: number): Promise<string[]> {
    let pending = this.pages.get(index);
    if (!pending) {
      const [start, end] = pageRange(this.options.scan, index);
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
    const { lineCount } = this.options.scan;
    const [from, to] = visibleLines(scrollTop, clientHeight, lineCount);
    // Rows sit where the viewport is; on a scaled file their offset from it is the unscaled one.
    const shift = scrollTop - virtualTop(scrollTop, clientHeight, lineCount);
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
    this.matches = [];
    this.matchIndex = -1;
    this.searchDone = false;
    await this.more(0);
    if (this.matches.length) this.show(0);
    else this.count.textContent = "0";
  }

  /** Fetches the next page of matches from `fromLine`; a page that fills up is continued later. */
  private async more(fromLine: number): Promise<void> {
    if (this.searchDone) return;
    try {
      const result = await this.options.search(this.query(), fromLine);
      if (this.destroyed) return;
      this.matches.push(...result.matches);
      this.searchDone = result.done || result.cancelled;
    } catch (error) {
      this.searchDone = true;
      this.count.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  private async step(delta: number): Promise<void> {
    if (!this.matches.length) return this.startSearch();
    let index = this.matchIndex + delta;
    if (index >= this.matches.length && !this.searchDone) {
      await this.more(this.matches[this.matches.length - 1].line + 1);
    }
    index = (index + this.matches.length) % this.matches.length;
    this.show(index);
  }

  private show(index: number): void {
    this.matchIndex = index;
    this.count.textContent = `${index + 1} / ${this.matches.length}${this.searchDone ? "" : "+"}`;
    this.goToLine(this.matches[index].line);
  }
}
