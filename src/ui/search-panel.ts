import { displayName } from "../app/docs";
import { describeError } from "../app/errors";
import { errorCode, type SearchEvent, type SearchMatch, type SearchQuery } from "../backend/types";
import { h } from "./dom";

/** Spec 「워크스페이스 검색」: a search starts once typing pauses this long. */
export const SEARCH_DEBOUNCE_MS = 150;
export const SEARCHING = "검색 중…";
export const BAD_REGEX = "잘못된 정규식";
export const TOO_MANY = "결과가 많아 일부만 보입니다";

type FileEvent = Extract<SearchEvent, { kind: "file" }>;

/** What results are grouped by: one group a memo. */
export function groupKey(event: FileEvent): string {
  return event.memoId;
}

export function countOf(events: readonly SearchEvent[]): {
  files: number;
  matches: number;
  truncated: boolean;
} {
  const files = new Set<string>();
  let matches = 0;
  let truncated = false;
  for (const event of events) {
    if (event.kind === "file") {
      files.add(groupKey(event));
      matches += event.matches.length;
    } else {
      truncated ||= event.truncated;
    }
  }
  return { files: files.size, matches, truncated };
}

/** The status line once `events` have come: `previous` until the search is done. A cancelled
 * search keeps it too — what stopped it (a newer search, a closed panel) says what to show. */
export function statusOf(events: readonly SearchEvent[], previous: string): string {
  const done = events.find((event) => event.kind === "done");
  if (!done || done.cancelled) return previous;
  const count = countOf(events);
  return count.truncated ? TOO_MANY : `${count.files}개 파일에서 ${count.matches}개`;
}

export interface SearchPanelOptions {
  search(query: SearchQuery, onEvent: (event: SearchEvent) => void): Promise<void>;
  /** Stops the running search on the native side. */
  cancel(): void;
  /** `line` is 0-based; `column` counts characters in the whole line. */
  open(memoId: string, line: number, column: number): void;
  onEscape(): void;
}

function toggle(label: string, title: string, name: string): HTMLButtonElement {
  const button = h("button", {
    type: "button",
    class: `search-toggle ${name}`,
    textContent: label,
    title,
  });
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () =>
    button.setAttribute("aria-pressed", String(!pressed(button))),
  );
  return button;
}

const pressed = (button: HTMLButtonElement) => button.getAttribute("aria-pressed") === "true";

function resultLine(index: number, text: string, kind: "hit" | "context"): HTMLElement {
  return h(
    "div",
    { class: `search-line ${kind}` },
    h("span", { class: "search-line-number", textContent: String(index + 1) }),
    h("span", { class: "search-line-text", textContent: text }),
  );
}

/** The sidebar's search across the workspace's memos (spec 「워크스페이스 검색」): results stream
 * in grouped by memo, each match with the lines around it; a click opens the memo there. */
export class SearchPanel {
  // Not type="search": WebKit clears such a field on Escape, and Escape here closes the panel.
  private readonly input = h("input", {
    type: "text",
    placeholder: "워크스페이스 검색",
    class: "search-input",
  });
  private readonly caseToggle = toggle("Aa", "대소문자 구분", "search-toggle-case");
  private readonly regexToggle = toggle(".*", "정규식", "search-toggle-regex");
  private readonly status = h("div", { class: "search-status" });
  private readonly results = h("div", { class: "search-results" });
  readonly el = h(
    "div",
    { class: "search-panel" },
    h("div", { class: "search-bar" }, this.input, this.caseToggle, this.regexToggle),
    this.status,
    this.results,
  );
  /** Numbers this panel's searches: only the latest one's events are drawn. A late event of an
   * earlier one — the native side stops it only at its next file — would mix two queries. */
  private runs = 0;
  private events: SearchEvent[] = [];
  private searching = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The latest search was stopped, or never started, because the panel closed: showing the
   * panel again runs it. */
  private interrupted = false;

  constructor(private readonly options: SearchPanelOptions) {
    this.input.spellcheck = false;
    this.input.addEventListener("input", () => this.searchSoon());
    for (const button of [this.caseToggle, this.regexToggle]) {
      button.addEventListener("click", () => this.searchNow());
    }
    this.el.addEventListener("keydown", (event) => {
      // Escape while composing Hangul only ends the composition.
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      this.stop();
      this.options.onEscape();
    });
  }

  focus(): void {
    this.input.focus();
    this.input.select();
    if (this.interrupted) this.searchNow();
  }

  private searchSoon(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.searchNow(), SEARCH_DEBOUNCE_MS);
  }

  private searchNow(): void {
    this.clearTimer();
    const run = ++this.runs;
    this.events = [];
    this.results.replaceChildren();
    this.interrupted = false;
    const query: SearchQuery = {
      query: this.input.value,
      caseSensitive: pressed(this.caseToggle),
      regex: pressed(this.regexToggle),
    };
    if (!query.query) {
      if (this.searching) this.options.cancel();
      this.searching = false;
      this.status.textContent = "";
      return;
    }
    this.searching = true;
    this.status.textContent = SEARCHING;
    this.options
      .search(query, (event) => {
        if (run === this.runs) this.receive(event);
      })
      .catch((error: unknown) => {
        if (run !== this.runs) return;
        this.searching = false;
        if (errorCode(error) === "bad-request") {
          this.status.textContent = BAD_REGEX;
        } else {
          console.error(error);
          this.status.textContent = describeError(error);
        }
      });
  }

  private receive(event: SearchEvent): void {
    this.events.push(event);
    if (event.kind === "file") this.results.append(this.group(event));
    else this.searching = false;
    this.status.textContent = statusOf(this.events, this.status.textContent ?? "");
  }

  /** Escape: the running or pending search is dropped, and the native side stops reading. */
  private stop(): void {
    if (this.searching || this.timer !== null) {
      this.runs++;
      this.searching = false;
      this.interrupted = true;
      this.status.textContent = "";
    }
    this.clearTimer();
    this.options.cancel();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private group(event: FileEvent): HTMLElement {
    const details = h(
      "details",
      { class: "search-file", open: true },
      h(
        "summary",
        { class: "search-file-summary", title: event.file },
        h("span", { class: "search-file-title", textContent: displayName(event.file) }),
        h("span", { class: "search-file-count", textContent: String(event.matches.length) }),
      ),
    );
    for (const match of event.matches) details.append(this.matchRow(event.memoId, match));
    return details;
  }

  /** The match with its context lines, numbered. The matches of a file come in line order and a
   * line between two close ones is only the earlier one's `after`, so drawn one after another
   * they read as the file does, nothing missing between them. */
  private matchRow(memoId: string, match: SearchMatch): HTMLElement {
    const first = match.line - match.before.length;
    const row = h(
      "div",
      { class: "search-match" },
      ...match.before.map((text, i) => resultLine(first + i, text, "context")),
      resultLine(match.line, match.text, "hit"),
      ...match.after.map((text, i) => resultLine(match.line + 1 + i, text, "context")),
    );
    row.addEventListener("click", () => this.options.open(memoId, match.line, match.column));
    return row;
  }
}
