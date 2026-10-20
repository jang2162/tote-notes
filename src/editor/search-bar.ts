import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  runScopeHandlers,
  type Command,
  type EditorView,
  type KeyBinding,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";

import { h } from "../ui/dom";
import { countLabel, countMatches } from "./search-count";

/** `openSearchPanel`, which also selects the query when the find field already has the focus
 * (CodeMirror only selects it when it moves the focus there). */
export const openSearchBar: Command = (view) => {
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>(".find-bar-input");
  if (field && field === view.root.activeElement) field.select();
  return true;
};

/** Unfolds (`true`) or folds the bar's replace row. */
export const setReplaceOpen = StateEffect.define<boolean>();

/** Whether the bar shows its replace row. It lives in the tab's state next to CodeMirror's search
 * state, so a bar closed and opened again with ⌘F comes back as it was left. */
export const replaceOpen = StateField.define<boolean>({
  create: () => false,
  update(open, tr) {
    for (const effect of tr.effects) if (effect.is(setReplaceOpen)) open = effect.value;
    return open;
  },
});

/** `replaceOpen` in `state`; folded in a state without the bar. */
function isReplaceOpen(state: EditorState): boolean {
  return state.field(replaceOpen, false) ?? false;
}

/** ⌥⌘F: `openSearchBar` with the replace row unfolded. The focus still goes to the find field. */
export const openSearchWithReplace: Command = (view) => {
  if (!isReplaceOpen(view.state)) view.dispatch({ effects: setReplaceOpen.of(true) });
  return openSearchBar(view);
};

let panelOpener: StateEffect<unknown> | undefined;

/** CodeMirror's effect that opens the search panel, which it does not export: it is taken from
 * what `openSearchPanel` dispatches for a closed panel, the one case that touches nothing of the
 * view but its state and `dispatch`. */
function openPanelEffect(): StateEffect<unknown> {
  if (!panelOpener) {
    let effects: readonly StateEffect<unknown>[] = [];
    const view = {
      state: EditorState.create({ extensions: search() }),
      dispatch: (spec: { effects: readonly StateEffect<unknown>[] }) => (effects = spec.effects),
    };
    openSearchPanel(view as unknown as EditorView);
    panelOpener = effects.find((effect) => !effect.is(setSearchQuery));
    if (!panelOpener) throw new Error("openSearchPanel dispatched no panel effect");
  }
  return panelOpener;
}

/** The effects that open the bar in a new state of `from`'s tab as it is open in `from` — query,
 * options and replace row — or none when it is closed there. A reload builds a new state, which
 * would otherwise drop the bar from under the search going on in it. */
export function carrySearch(from: EditorState): StateEffect<unknown>[] {
  if (!searchPanelOpen(from)) return [];
  return [
    setSearchQuery.of(getSearchQuery(from)),
    setReplaceOpen.of(isReplaceOpen(from)),
    openPanelEffect(),
  ];
}

/** The bar's own editor keys, tried ahead of `searchKeymap` in `editorKeymap`. */
export const searchBarKeymap: readonly KeyBinding[] = [
  { key: "Mod-f", run: openSearchBar, scope: "editor search-panel" },
  {
    key: "Mod-Alt-f",
    run: openSearchWithReplace,
    scope: "editor search-panel",
    preventDefault: true,
  },
];

type ToggleName = "case" | "word" | "re";

/** A button whose click keeps the focus where it was, so the field being typed in stays ready. */
function textButton(name: string, text: string, className = "find-bar-button") {
  const element = h("button", { type: "button", name, class: className }, text);
  element.addEventListener("mousedown", (event) => event.preventDefault());
  return element;
}

/** `textButton` for a symbol, which says what it does in its tooltip and label. */
function button(name: string, label: string, text: string, className: string) {
  const element = textButton(name, text, className);
  element.title = label;
  element.setAttribute("aria-label", label);
  return element;
}

function setPressed(element: HTMLElement, on: boolean) {
  element.setAttribute("aria-pressed", String(on));
}

/** The find panel: a field with its option toggles, the result count, and the step, replace and
 * close buttons; below it the replace row, folded unless `replaceOpen`. Search, highlighting and
 * the commands stay CodeMirror's. */
class SearchBar implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly input: HTMLInputElement;
  private readonly toggles: Record<ToggleName, HTMLButtonElement>;
  private readonly count: HTMLElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly replaceToggle: HTMLButtonElement;
  private readonly replaceRow: HTMLElement;
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
    this.replaceToggle = button("replace-toggle", "바꾸기 펼치기", "⇄", "find-bar-icon");
    this.replaceToggle.addEventListener("click", () =>
      view.dispatch({ effects: setReplaceOpen.of(!isReplaceOpen(view.state)) }),
    );
    const close = button("close", "닫기", "×", "find-bar-icon");
    close.addEventListener("click", () => closeSearchPanel(view));
    this.replaceInput = h("input", {
      type: "text",
      name: "replace",
      placeholder: "바꿀 내용",
      class: "find-bar-input",
    });
    this.replaceInput.setAttribute("aria-label", "바꿀 내용");
    this.replaceInput.addEventListener("input", () => this.commit());
    const replace = textButton("replace", "바꾸기");
    replace.addEventListener("click", () => replaceNext(view));
    const replaceEvery = textButton("replace-all", "모두 바꾸기");
    replaceEvery.addEventListener("click", () => replaceAll(view));
    this.replaceRow = h(
      "div",
      { class: "find-bar-replace" },
      h("div", { class: "find-bar-field" }, this.replaceInput),
      h("div", { class: "find-bar-actions" }, replace, replaceEvery),
    );

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
        h("div", { class: "find-bar-actions" }, this.count, prev, next, this.replaceToggle, close),
      ),
      this.replaceRow,
    );
    this.dom.addEventListener("keydown", (event) => this.keydown(event));
    this.show(this.query);
    this.showReplace(isReplaceOpen(view.state));
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
    const open = isReplaceOpen(update.state);
    // The row's `hidden` mirrors the field: shown while open, so equal values mean they disagree.
    if (this.replaceRow.hidden === open) this.showReplace(open);
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
    } else if (
      event.key === "Enter" &&
      event.target === this.replaceInput &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      (event.metaKey ? replaceAll : replaceNext)(this.view);
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
      replace: this.replaceInput.value,
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
    if (this.replaceInput.value !== query.replace) this.replaceInput.value = query.replace;
    setPressed(this.toggles.case, query.caseSensitive);
    setPressed(this.toggles.word, query.wholeWord);
    setPressed(this.toggles.re, query.regexp);
    this.markInvalid(query);
  }

  private showReplace(open: boolean) {
    this.replaceRow.hidden = !open;
    setPressed(this.replaceToggle, open);
    // ⇄ keeps the focus where it was: folding the row away from under it hands it to the find field.
    if (!open && this.replaceRow.contains(this.view.root.activeElement)) this.input.focus();
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
    // Only a change: the count is a live region, and a rewrite reads it out again.
    if (this.count.textContent !== label) this.count.textContent = label;
    this.count.classList.toggle("find-bar-error", query.search !== "" && !query.valid);
  }
}

/** CodeMirror's search with the find bar for its panel, at the top of the editor. */
export function searchBar(): Extension {
  return [replaceOpen, search({ top: true, createPanel: (view) => new SearchBar(view) })];
}
