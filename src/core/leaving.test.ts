import { afterEach, describe, expect, it, vi } from "vitest";

describe("pageLeaving", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is true once the page unloads and false again when it is shown", async () => {
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal("addEventListener", (type: string, listener: () => void) => {
      listeners[type] = listener;
    });
    vi.resetModules();
    const { pageLeaving } = await import("./leaving");
    expect(pageLeaving()).toBe(false);
    listeners.pagehide();
    expect(pageLeaving()).toBe(true);
    // Restored from the back/forward cache: real read failures warn again.
    listeners.pageshow();
    expect(pageLeaving()).toBe(false);
    listeners.beforeunload();
    expect(pageLeaving()).toBe(true);
    listeners.pageshow();
    expect(pageLeaving()).toBe(false);
  });
});
