import { EditorState, type StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `openSearchPanel` stays CodeMirror's unless a test makes it fail: `carrySearch` takes the effect
// that opens the panel from it.
vi.mock("@codemirror/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/search")>();
  return { ...actual, openSearchPanel: vi.fn(actual.openSearchPanel) };
});

type Search = typeof import("@codemirror/search");
type Bar = typeof import("./search-bar");

/** A fresh copy of both modules: `carrySearch` keeps the effect it took once. */
async function load(): Promise<{ search: Search; bar: Bar }> {
  vi.resetModules();
  return { search: await import("@codemirror/search"), bar: await import("./search-bar") };
}

/** `state` with its search panel opened on `query`, as ⌘F leaves it. */
function opened(search: Search, state: EditorState, query: string): EditorState {
  const view = {
    state,
    dispatch(spec: { effects: readonly StateEffect<unknown>[] }) {
      view.state = view.state.update(spec).state;
    },
  };
  search.openSearchPanel(view as unknown as EditorView);
  view.dispatch({ effects: [search.setSearchQuery.of(new search.SearchQuery({ search: query }))] });
  return view.state;
}

describe("carrySearch", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("opens the bar in a new state with the query it had", async () => {
    const { search, bar } = await load();
    const extensions = bar.searchBar();
    const from = opened(search, EditorState.create({ doc: "alpha", extensions }), "alpha");
    expect(search.searchPanelOpen(from)).toBe(true);

    const fresh = EditorState.create({ doc: "alpha alpha", extensions });
    const to = fresh.update({ effects: bar.carrySearch(from) }).state;
    expect(search.searchPanelOpen(to)).toBe(true);
    expect(search.getSearchQuery(to).eq(search.getSearchQuery(from))).toBe(true);
  });

  it("carries nothing from a closed bar", async () => {
    const { bar } = await load();
    expect(bar.carrySearch(EditorState.create({ extensions: bar.searchBar() }))).toEqual([]);
  });

  it("falls back to a closed bar when the panel's effect cannot be had", async () => {
    const { search, bar } = await load();
    const extensions = bar.searchBar();
    const from = opened(search, EditorState.create({ doc: "alpha", extensions }), "alpha");
    vi.mocked(search.openSearchPanel).mockImplementation(() => {
      throw new TypeError("view.dom is undefined");
    });

    expect(bar.carrySearch(from)).toEqual([]);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
