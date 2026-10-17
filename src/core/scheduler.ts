type Write = () => Promise<void>;

interface Slot {
  timer: ReturnType<typeof setTimeout> | null;
  next: Write | null;
  running: Promise<void> | null;
}

/** Delayed writes, one queue per key. A newer write replaces a pending one, two writes of a key
 * never overlap, and `flush` runs the pending write at once — the safety net for timers that a
 * hidden window barely runs (spec 「저장」). */
export class WriteScheduler {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly onError: (key: string, error: unknown) => void) {}

  schedule(key: string, delayMs: number, write: Write): void {
    const slot = this.slot(key);
    slot.next = write;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => void this.flush(key), delayMs);
  }

  /** Runs the pending write of `key` now and resolves once no write of it is left. */
  async flush(key: string): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot) return;
    for (;;) {
      if (slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      if (slot.running) {
        await slot.running;
        continue;
      }
      const write = slot.next;
      if (!write) return;
      slot.next = null;
      slot.running = write()
        .catch((error: unknown) => {
          // A throwing handler must not reject the flush: ⌘Q waits on every key at once.
          try {
            this.onError(key, error);
          } catch {}
        })
        .finally(() => {
          slot.running = null;
        });
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((key) => this.flush(key)));
  }

  /** A write of `key` is waiting for its delay or running. */
  pending(key: string): boolean {
    const slot = this.slots.get(key);
    return slot !== undefined && (slot.next !== null || slot.running !== null);
  }

  /** Drops the pending write of `key`; one already running still finishes. */
  cancel(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    slot.next = null;
  }

  private slot(key: string): Slot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { timer: null, next: null, running: null };
      this.slots.set(key, slot);
    }
    return slot;
  }
}
