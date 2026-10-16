import { afterEach, describe, expect, it, vi } from "vitest";

import { settleComposition } from "./compose";

/** An editor's `composing` and a `contentDOM` built on node's EventTarget, counting blurs. */
function fakeView(composing: boolean, onBlur: (dom: EventTarget) => void = () => {}) {
  const dom = Object.assign(new EventTarget(), {
    blurs: 0,
    blur() {
      dom.blurs++;
      onBlur(dom);
    },
  });
  const view = { composing, contentDOM: dom as unknown as HTMLElement };
  return { view, dom };
}

/** Whether `promise` has settled once the pending callbacks have run. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe("settleComposition", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns at once when nothing is composing", async () => {
    const { view, dom } = fakeView(false);
    expect(await settled(settleComposition(view))).toBe(true);
    expect(dom.blurs).toBe(0);
  });

  it("blurs and waits for compositionend", async () => {
    const { view, dom } = fakeView(true);
    const settling = settleComposition(view);
    expect(dom.blurs).toBe(1);
    expect(await settled(settling)).toBe(false);
    view.composing = false;
    dom.dispatchEvent(new Event("compositionend"));
    expect(await settled(settling)).toBe(true);
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const { view, dom } = fakeView(true);
    let done = false;
    void settleComposition(view).then(() => (done = true));
    expect(dom.blurs).toBe(1);
    await vi.advanceTimersByTimeAsync(149);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("catches a compositionend sent during blur", async () => {
    vi.useFakeTimers();
    const { view } = fakeView(true, (dom) => dom.dispatchEvent(new Event("compositionend")));
    let done = false;
    void settleComposition(view).then(() => (done = true));
    // No timer runs: the end came inside `blur`, before a listener added after it could hear it.
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
