import { describe, expect, it } from "vitest";

import type { WindowStart } from "../backend/types";
import { startsCollapsed, storeCollapsed, storedCollapsed } from "./sidebar-state";

const startWith = (sidebarCollapsed: boolean): WindowStart => ({
  label: "ws-1",
  macTitlebar: false,
  sidebarCollapsed,
});

/** A storage of `items`, as `sessionStorage` would be. */
function storageOf(items: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(items));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

const throws = (): never => {
  throw new Error("SecurityError");
};

describe("the sidebar's collapsed state", () => {
  it("prefers what the page kept over the start value", () => {
    const kept = (value: string) => () => storageOf({ "tote.sidebarCollapsed.ws-1": value });
    expect(startsCollapsed(startWith(false), storedCollapsed(kept("true"), "ws-1"))).toBe(true);
    expect(startsCollapsed(startWith(true), storedCollapsed(kept("false"), "ws-1"))).toBe(false);
  });

  it("falls back to the start value for nothing, garbage or a storage that throws", () => {
    const storages: (() => Pick<Storage, "getItem"> | null)[] = [
      () => null,
      () => storageOf(),
      () => storageOf({ "tote.sidebarCollapsed.ws-1": "1" }),
      () => ({ getItem: throws }),
      throws,
    ];
    for (const storage of storages) {
      expect(storedCollapsed(storage, "ws-1")).toBeNull();
      for (const start of [true, false])
        expect(startsCollapsed(startWith(start), storedCollapsed(storage, "ws-1"))).toBe(start);
    }
  });

  it("keys by the window, and a storage that throws on write is no failure", () => {
    const storage = storageOf();
    storeCollapsed(() => storage, "ws-1", true);
    expect(storedCollapsed(() => storage, "ws-1")).toBe(true);
    expect(storedCollapsed(() => storage, "ws-2")).toBeNull();
    storeCollapsed(() => storage, "ws-1", false);
    expect(storedCollapsed(() => storage, "ws-1")).toBe(false);
    expect(() => storeCollapsed(() => ({ setItem: throws }), "ws-1", true)).not.toThrow();
    expect(() => storeCollapsed(throws, "ws-1", true)).not.toThrow();
    expect(() => storeCollapsed(() => null, "ws-1", true)).not.toThrow();
  });
});
