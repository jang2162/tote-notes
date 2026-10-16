import { ExternalDoc, MemoDoc, type Doc } from "./docs";

/** The ordered tabs of one window and which one is active. No DOM, no backend: the controller
 * asks it where things go and renders the answer. */
export class Tabs {
  private readonly docs: Doc[] = [];
  active: Doc | null = null;

  /** In tab order. Changed only through the methods below. */
  get list(): readonly Doc[] {
    return this.docs;
  }

  /** Appends `doc` as the last tab (the session's tabs, in their order). */
  push(doc: Doc): void {
    this.docs.push(doc);
  }

  /** New tabs open right after the active one. */
  insertAfterActive<D extends Doc>(doc: D): D {
    const at = this.active ? this.list.indexOf(this.active) + 1 : this.list.length;
    this.docs.splice(at, 0, doc);
    return doc;
  }

  /** Puts `doc` at `index` of the list as it is now — a tab dropped there. A tab of this list
   * moves from where it was; the active one stays active. */
  place<D extends Doc>(doc: D, index: number): D {
    const at = this.docs.indexOf(doc);
    if (at >= 0) {
      this.docs.splice(at, 1);
      if (at < index) index--;
    }
    this.docs.splice(Math.min(index, this.docs.length), 0, doc);
    return doc;
  }

  /** Puts `next` in `doc`'s place; when `doc` is no longer open (closed meanwhile), `next` opens
   * after the active tab instead of being lost. */
  replace<D extends Doc>(doc: Doc, next: D): D {
    const index = this.list.indexOf(doc);
    if (index < 0) return this.insertAfterActive(next);
    this.docs[index] = next;
    return next;
  }

  /** Takes `doc` out. When it was active, `active` becomes null and the tab that should take its
   * place is returned: the next one, else the previous one, else null. */
  remove(doc: Doc): Doc | null {
    const index = this.list.indexOf(doc);
    if (index < 0) return null;
    this.docs.splice(index, 1);
    if (doc !== this.active) return null;
    this.active = null;
    return this.list[index] ?? this.list[index - 1] ?? null;
  }

  cycle(step: number): Doc | null {
    if (!this.active || this.list.length < 2) return null;
    const index = this.list.indexOf(this.active);
    return this.list[(index + step + this.list.length) % this.list.length];
  }

  indexOf(doc: Doc): number {
    return this.list.indexOf(doc);
  }

  byId(tabId: string): Doc | undefined {
    return this.list.find((d) => d.tabId === tabId);
  }

  memo(id: string): MemoDoc | undefined {
    return this.list.find((d): d is MemoDoc => d instanceof MemoDoc && d.info.id === id);
  }

  external(path: string): ExternalDoc | undefined {
    return this.list.find((d): d is ExternalDoc => d instanceof ExternalDoc && d.path === path);
  }
}
