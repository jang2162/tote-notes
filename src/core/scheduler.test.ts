import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WriteScheduler } from "./scheduler";

describe("WriteScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes once, after changes stop for the delay", async () => {
    const writes: string[] = [];
    const s = new WriteScheduler(() => {});
    s.schedule("a", 500, async () => void writes.push("first"));
    await vi.advanceTimersByTimeAsync(300);
    s.schedule("a", 500, async () => void writes.push("second"));
    await vi.advanceTimersByTimeAsync(499);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual(["second"]);
  });

  it("flush writes now and the timer then has nothing left", async () => {
    const writes: string[] = [];
    const s = new WriteScheduler(() => {});
    s.schedule("a", 5000, async () => void writes.push("x"));
    await s.flush("a");
    expect(writes).toEqual(["x"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toEqual(["x"]);
  });

  it("never runs two writes of one key at once", async () => {
    let running = 0;
    let most = 0;
    let finished = 0;
    const slow = () =>
      new Promise<void>((resolve) => {
        running++;
        most = Math.max(most, running);
        setTimeout(() => {
          running--;
          finished++;
          resolve();
        }, 100);
      });
    const s = new WriteScheduler(() => {});
    s.schedule("a", 0, slow);
    await vi.advanceTimersByTimeAsync(10);
    s.schedule("a", 0, slow);
    await vi.advanceTimersByTimeAsync(500);
    expect(most).toBe(1);
    // The write scheduled while the first ran is not dropped; it runs after it.
    expect(finished).toBe(2);
  });

  it("flush waits for a write that is already running", async () => {
    let done = false;
    const s = new WriteScheduler(() => {});
    s.schedule(
      "a",
      0,
      () => new Promise<void>((resolve) => setTimeout(() => resolve(void (done = true)), 100)),
    );
    await vi.advanceTimersByTimeAsync(1);
    const flushed = s.flush("a");
    let settled = false;
    void flushed.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await flushed;
    expect(done).toBe(true);
  });

  it("cancel drops a pending write", async () => {
    const writes: string[] = [];
    const s = new WriteScheduler(() => {});
    s.schedule("a", 100, async () => void writes.push("x"));
    s.cancel("a");
    await vi.advanceTimersByTimeAsync(1000);
    await s.flush("a");
    expect(writes).toEqual([]);
  });

  it("reports a failed write and keeps going", async () => {
    const errors: unknown[] = [];
    const writes: string[] = [];
    const s = new WriteScheduler((_key, error) => errors.push(error));
    s.schedule("a", 0, async () => {
      throw new Error("disk full");
    });
    await vi.advanceTimersByTimeAsync(1);
    s.schedule("a", 0, async () => void writes.push("retry"));
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toHaveLength(1);
    expect(writes).toEqual(["retry"]);
  });

  it("flushAll covers every key, even when onError throws", async () => {
    const writes: string[] = [];
    const s = new WriteScheduler(() => {
      throw new Error("ui bug");
    });
    s.schedule("bad", 9999, async () => {
      throw new Error("disk full");
    });
    s.schedule("a", 9999, async () => void writes.push("a"));
    s.schedule("b", 9999, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      writes.push("b");
    });
    const flushed = s.flushAll();
    await vi.advanceTimersByTimeAsync(50);
    await flushed;
    expect(writes.sort()).toEqual(["a", "b"]);
  });
});
