// The memo list's and the trash list's keys and picks (docs/superpowers/specs/2026-11-14-tote-
// notes-list-keyboard-design.md): which rows are picked, the current row the keys move, and the
// row a ⇧ run starts from. Rows go by their memo ID, so a list drawn again keeps them.

import { isCompositionKey } from "./dialogs";

/** What a key pressed in a list asks for, or `null` for a key the list leaves alone. */
export type ListKey =
  | {
      kind: "move";
      to: "up" | "down" | "first" | "last" | "page-up" | "page-down";
      extend: boolean;
    }
  | { kind: "open"; toEditor: boolean }
  | { kind: "delete" }
  | { kind: "menu" }
  | { kind: "all" }
  /** A key held down repeating one that acts: taken, and nothing done — a held ⌘⌫ would move
   * memo after memo to the trash, the next row being current after each. */
  | { kind: "held" };

const MOVES: Record<string, Extract<ListKey, { kind: "move" }>["to"]> = {
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "first",
  End: "last",
  PageUp: "page-up",
  PageDown: "page-down",
};

/** A Latin letter by the letter, as the native menus match their keys — on AZERTY, A sits where
 * US has Q, and ⌘Q there must go on to quit. Any other key by its place (`code`), as the shortcut
 * recorder reads it (`acceleratorFromEvent`, src/shortcuts/keys.ts): the Korean input method
 * sends ⌘A as `ㅁ`. */
function keyName(event: KeyboardEvent): string {
  if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
  return event.code || event.key;
}

export function listKey(event: KeyboardEvent): ListKey | null {
  if (isCompositionKey(event) || event.altKey || event.ctrlKey) return null;
  const { metaKey: meta, shiftKey: shift } = event;
  const key = keyName(event);
  const to = MOVES[key];
  // Held down, a move goes on moving.
  if (to) return meta ? null : { kind: "move", to, extend: shift };
  const action = actionOf(key, meta, shift);
  return action && event.repeat ? { kind: "held" } : action;
}

function actionOf(key: string, meta: boolean, shift: boolean): ListKey | null {
  if ((key === "Enter" || key === "NumpadEnter") && !shift) return { kind: "open", toEditor: meta };
  if (key === "Backspace" && meta && !shift) return { kind: "delete" };
  if (key === "KeyA" && meta && !shift) return { kind: "all" };
  if ((key === "F10" && shift && !meta) || (key === "ContextMenu" && !meta))
    return { kind: "menu" };
  return null;
}

export class ListSelection {
  private order: string[] = [];
  private picked = new Set<string>();
  /** The row the keys are on. */
  cursor: string | null = null;
  /** Where a ⇧ run starts. */
  private anchor: string | null = null;

  isPicked(id: string): boolean {
    return this.picked.has(id);
  }

  get size(): number {
    return this.picked.size;
  }

  /** The rows as they are shown now. One no longer shown is no longer picked; a current row that
   * went hands over to the row now in its place, picked when nothing else is. */
  setOrder(order: readonly string[]): void {
    const at = this.cursor === null ? -1 : this.order.indexOf(this.cursor);
    this.order = [...order];
    const shown = new Set(order);
    for (const id of this.picked) if (!shown.has(id)) this.picked.delete(id);
    if (this.anchor !== null && !shown.has(this.anchor)) this.anchor = null;
    if (this.cursor === null || shown.has(this.cursor)) return;
    this.cursor = at >= 0 && order.length ? order[Math.min(at, order.length - 1)] : null;
    this.anchor = this.cursor;
    if (this.cursor !== null && this.picked.size === 0) this.picked.add(this.cursor);
  }

  /** The current row's place in the order; -1 with none. */
  get index(): number {
    return this.cursor === null ? -1 : this.order.indexOf(this.cursor);
  }

  /** `by` rows on; from no current row, any move lands on the first. */
  step(by: number, extend: boolean): void {
    const at = this.index;
    this.moveTo(at < 0 ? 0 : at + by, extend);
  }

  to(end: "first" | "last", extend: boolean): void {
    this.moveTo(end === "first" ? 0 : this.order.length - 1, extend);
  }

  private moveTo(index: number, extend: boolean): void {
    if (this.order.length === 0) return;
    const id = this.order[Math.max(0, Math.min(index, this.order.length - 1))];
    if (extend) {
      this.anchor ??= this.cursor ?? id;
      this.cursor = id;
      this.pickRun();
    } else this.only(id);
  }

  /** A press on a row: ⌘ adds or takes it out, ⇧ picks the run up to it, else it alone. */
  press(id: string, how: { toggle?: boolean; range?: boolean }): void {
    if (how.range) {
      this.anchor ??= this.cursor ?? id;
      this.cursor = id;
      this.pickRun();
    } else if (how.toggle) {
      // A row taken out is no place to start a run from: the run starts where it did.
      if (this.picked.delete(id)) this.anchor ??= id;
      else {
        this.picked.add(id);
        this.anchor = id;
      }
      this.cursor = id;
    } else this.only(id);
  }

  selectAll(): void {
    this.picked = new Set(this.order);
  }

  /** The row `id` alone, current and where a run starts. */
  only(id: string): void {
    this.picked = new Set([id]);
    this.cursor = id;
    this.anchor = id;
  }

  /** What a menu opened on `id` acts on: everything picked when `id` is among it, else `id` picked
   * alone. */
  menuFor(id: string | null): string[] {
    if (id === null) return [];
    if (!this.picked.has(id)) this.only(id);
    return this.targets();
  }

  /** What is picked, in the list's order; with nothing picked, the current row. */
  targets(): string[] {
    if (this.picked.size === 0) return this.cursor === null ? [] : [this.cursor];
    return this.order.filter((id) => this.picked.has(id));
  }

  private pickRun(): void {
    const from = this.order.indexOf(this.anchor!);
    const to = this.order.indexOf(this.cursor!);
    const [start, end] = from <= to ? [from, to] : [to, from];
    this.picked = new Set(this.order.slice(start, end + 1));
  }
}
