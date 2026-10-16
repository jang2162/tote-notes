import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { defaultFakeData, FakeBackend, memoryStorage } from "../backend/fake";
import { WriteScheduler } from "../core/scheduler";
import { ExternalDoc, MemoDoc, type DocHost } from "./docs";
import { Tabs } from "./tabs";

function host(): DocHost {
  const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
  return {
    backend,
    writes: new WriteScheduler(() => {}),
    view: { state: EditorState.create(), dispatch: () => {} },
    extensions: () => [],
    languageConfig: async () => ({}),
    languageOf: () => undefined,
    languages: () => [],
    changed: () => {},
    memoInfo: () => undefined,
    openMemo: () => {},
  };
}

const memo = (h: DocHost, id: string) =>
  new MemoDoc(h, { id, file: `${id}.md`, autoTitle: false, modifiedMs: 0, size: 0, kind: "text" });

describe("Tabs", () => {
  it("inserts after the active tab and finds by id, memo and path", () => {
    const h = host();
    const tabs = new Tabs();
    const a = tabs.insertAfterActive(memo(h, "a"));
    const c = tabs.insertAfterActive(memo(h, "c"));
    tabs.active = a;
    const b = tabs.insertAfterActive(new ExternalDoc(h, "/x/b.sh"));
    expect(tabs.list).toEqual([a, b, c]);
    expect(tabs.byId(b.tabId)).toBe(b);
    expect(tabs.memo("c")).toBe(c);
    expect(tabs.external("/x/b.sh")).toBe(b);
    expect(tabs.external("/none")).toBeUndefined();
  });

  it("replace swaps in place, or opens after the active tab when the old one is gone", () => {
    const h = host();
    const tabs = new Tabs();
    const a = tabs.insertAfterActive(memo(h, "a"));
    const x = tabs.insertAfterActive(new ExternalDoc(h, "/x/x.sh"));
    const b = tabs.insertAfterActive(memo(h, "b"));
    const m1 = memo(h, "m1");
    expect(tabs.replace(x, m1)).toBe(m1);
    expect(tabs.list).toEqual([a, m1, b]);
    tabs.active = a;
    const m2 = memo(h, "m2");
    tabs.replace(x, m2);
    expect(tabs.list).toEqual([a, m2, m1, b]);
  });

  it("removing the active tab names the neighbour to show", () => {
    const h = host();
    const tabs = new Tabs();
    const a = tabs.insertAfterActive(memo(h, "a"));
    const b = tabs.insertAfterActive(memo(h, "b"));
    const c = tabs.insertAfterActive(memo(h, "c"));
    tabs.active = c;
    expect(tabs.remove(c)).toBe(b); // the last tab: the one before it
    expect(tabs.active).toBeNull();
    tabs.active = a;
    expect(tabs.remove(a)).toBe(b); // a middle or first tab: the one after it
    tabs.active = b;
    expect(tabs.remove(b)).toBeNull();
    expect(tabs.list).toEqual([]);
  });

  it("closing the middle tab keeps the order of the rest and activates the next", () => {
    const h = host();
    const tabs = new Tabs();
    const a = tabs.insertAfterActive(memo(h, "a"));
    const b = tabs.insertAfterActive(memo(h, "b"));
    const c = tabs.insertAfterActive(memo(h, "c"));
    const d = tabs.insertAfterActive(memo(h, "d"));
    expect(tabs.list).toEqual([a, b, c, d]);
    tabs.active = b;
    expect(tabs.remove(b)).toBe(c);
    expect(tabs.list).toEqual([a, c, d]);
  });

  it("removing an inactive tab keeps the active one", () => {
    const h = host();
    const tabs = new Tabs();
    const a = tabs.insertAfterActive(memo(h, "a"));
    const b = tabs.insertAfterActive(memo(h, "b"));
    tabs.active = b;
    expect(tabs.remove(a)).toBeNull();
    expect(tabs.active).toBe(b);
  });

  it("cycles with wrap-around and does nothing with fewer than two tabs", () => {
    const h = host();
    const tabs = new Tabs();
    const a = tabs.insertAfterActive(memo(h, "a"));
    tabs.active = a;
    expect(tabs.cycle(1)).toBeNull();
    const b = tabs.insertAfterActive(memo(h, "b"));
    // `cycle` only names the next tab; the controller makes it active.
    expect(tabs.cycle(1)).toBe(b);
    tabs.active = b;
    expect(tabs.cycle(1)).toBe(a);
    tabs.active = a;
    expect(tabs.cycle(-1)).toBe(b);
  });
});
