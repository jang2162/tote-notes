import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  search,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import {
  runScopeHandlers,
  type EditorView,
  type KeyBinding,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";

import { h } from "../ui/dom";
import { countLabel, countMatches } from "./search-count";

/** The bar's own editor keys, tried ahead of `searchKeymap` in `editorKeymap`. */
export const searchBarKeymap: readonly KeyBinding[] = [];

type ToggleName = "case" | "word" | "re";

function button(name: string, label: string, text: string, className: string) {
  const element = h("button", { type: "button", name, class: className, title: label }, text);
  element.setAttribute("aria-label", label);
  // Clicking keeps the focus where it was, so the find field stays ready for typing.
  element.addEventListener("mousedown", (event) => event.preventDefault());
  return element;
}

function setPressed(element: HTMLElement, on: boolean) {
  element.setAttribute("aria-pressed", String(on));
}

/** The find panel: a field with its option toggles, the result count, and the step, replace and
 * close buttons. Search, highlighting and the commands stay CodeMirror's. */
class SearchBar implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly input: HTMLInputElement;
  private readonly toggles: Record<ToggleName, HTMLButtonElement>;
  private readonly count: HTMLElement;
  private query: SearchQuery;
  private frame = 0;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.input = h("input", {
      type: "text",
      name: "search",
      placeholder: "찾기",
      class: "find-bar-input",
    });
    this.input.setAttribute("main-field", "true");
    this.input.setAttribute("aria-label", "찾기");
    this.input.addEventListener("input", () => this.commit());
    this.toggles = {
      case: button("case", "대소문자 구분", "Aa", "find-bar-toggle"),
      word: button("word", "단어 단위", "ab", "find-bar-toggle"),
      re: button("re", "정규식", ".*", "find-bar-toggle"),
    };
    for (const toggle of Object.values(this.toggles))
      toggle.addEventListener("click", () => {
        setPressed(toggle, toggle.getAttribute("aria-pressed") !== "true");
        this.commit();
      });
    this.count = h("span", { class: "find-bar-count" });
    this.count.setAttribute("aria-live", "polite");
    const prev = button("prev", "이전 결과", "↑", "find-bar-icon");
    prev.addEventListener("click", () => findPrevious(view));
    const next = button("next", "다음 결과", "↓", "find-bar-icon");
    next.addEventListener("click", () => findNext(view));
    // A place only: the replace row comes with the next step of the plan.
    const replaceToggle = button("replace-toggle", "바꾸기 펼치기", "⇄", "find-bar-icon");
    setPressed(replaceToggle, false);
    const close = button("close", "닫기", "×", "find-bar-icon");
    close.addEventListener("click", () => closeSearchPanel(view));

    this.dom = h(
      "div",
      { class: "find-bar" },
      h(
        "div",
        { class: "find-bar-find" },
        h(
          "div",
          { class: "find-bar-field" },
          this.input,
          this.toggles.case,
          this.toggles.word,
          this.toggles.re,
        ),
        this.count,
        prev,
        next,
        replaceToggle,
        close,
      ),
    );
    this.dom.addEventListener("keydown", (event) => this.keydown(event));
    this.show(this.query);
    this.recount();
  }

  mount() {
    this.input.focus();
    this.input.select();
  }

  update(update: ViewUpdate) {
    const query = getSearchQuery(update.state);
    const changed = !query.eq(this.query);
    // ⌘F with text selected hands the panel a new query; typing here does not reach this branch,
    // since `commit` keeps `this.query` up to date first.
    if (changed) this.show(query);
    if (changed || update.docChanged || update.selectionSet) this.scheduleCount();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
  }

  private keydown(event: KeyboardEvent) {
    // The Enter that commits a Korean syllable belongs to the input method. WebKit can send that
    // keydown after compositionend, with `isComposing` false but key code 229.
    if (event.isComposing || event.keyCode === 229) return;
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
    } else if (event.key === "Enter" && event.target === this.input) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    }
  }

  private commit() {
    const pressed = (name: ToggleName) =>
      this.toggles[name].getAttribute("aria-pressed") === "true";
    const query = new SearchQuery({
      search: this.input.value,
      caseSensitive: pressed("case"),
      wholeWord: pressed("word"),
      regexp: pressed("re"),
      literal: this.query.literal,
      replace: this.query.replace,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.markInvalid(query);
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    // `update` sees no change of query for this one, so it does not count.
    this.scheduleCount();
  }

  private show(query: SearchQuery) {
    this.query = query;
    if (this.input.value !== query.search) this.input.value = query.search;
    setPressed(this.toggles.case, query.caseSensitive);
    setPressed(this.toggles.word, query.wholeWord);
    setPressed(this.toggles.re, query.regexp);
    this.markInvalid(query);
  }

  private markInvalid(query: SearchQuery) {
    const invalid = query.search !== "" && !query.valid;
    if (invalid) this.input.setAttribute("aria-invalid", "true");
    else this.input.removeAttribute("aria-invalid");
  }

  // One count a frame: typing fast, or a key held down, does not scan the memo per keystroke.
  private scheduleCount() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.recount();
    });
  }

  private recount() {
    const query = this.query;
    const label = countLabel(query, query.valid ? countMatches(this.view.state, query) : null);
    this.count.textContent = label;
    this.count.classList.toggle("find-bar-error", query.search !== "" && !query.valid);
  }
}

/** CodeMirror's search with the find bar for its panel, at the top of the editor. */
export function searchBar(): Extension {
  return search({ top: true, createPanel: (view) => new SearchBar(view) });
}
