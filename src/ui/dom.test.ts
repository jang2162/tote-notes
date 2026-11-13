import { describe, expect, it } from "vitest";

import { placeChildren } from "./dom";

/** As much of a DOM parent and its children as `placeChildren` uses (the tests run without a
 * DOM), keeping count of which children were ever put in or taken out. */
class Child {
  parent: Parent | null = null;

  constructor(readonly name: string) {}

  get nextSibling(): Child | null {
    const siblings = this.parent?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.touched.add(this.name);
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

class Parent {
  children: Child[] = [];
  /** The children taken out of the parent or put into it since it was made. */
  readonly touched = new Set<string>();

  constructor(names: string) {
    for (const name of names) this.insertBefore(new Child(name), null);
    this.touched.clear();
  }

  get firstChild(): Child | null {
    return this.children[0] ?? null;
  }

  get childNodes(): Child[] {
    return [...this.children];
  }

  insertBefore(child: Child, before: Child | null): Child {
    child.remove();
    this.touched.add(child.name);
    const at = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(at, 0, child);
    child.parent = this;
    return child;
  }

  get names(): string {
    return this.children.map((child) => child.name).join("");
  }
}

/** `placeChildren` on a parent holding `from` (a letter a child), wanting `to`: a letter that is
 * in both is the same child, a capital in `to` a new child. Returns the order it left and the
 * children it touched. */
function place(from: string, to: string): { order: string; touched: string } {
  const parent = new Parent(from);
  const had = new Map(parent.children.map((child) => [child.name, child]));
  const wanted = [...to].map((name) => had.get(name) ?? new Child(name));
  placeChildren(parent as unknown as HTMLElement, wanted as unknown as HTMLElement[]);
  return { order: parent.names, touched: [...parent.touched].sort().join("") };
}

describe("placeChildren", () => {
  it("leaves the children as they are when they are the ones wanted", () => {
    expect(place("abc", "abc")).toEqual({ order: "abc", touched: "" });
  });

  it("touches none of the children after one that is made anew", () => {
    // `a` goes and `A` comes in its place: `b` and `c` stay where they are.
    expect(place("abc", "Abc")).toEqual({ order: "Abc", touched: "Aa" });
    expect(place("abcd", "aBcd")).toEqual({ order: "aBcd", touched: "Bb" });
    expect(place("abc", "ABc")).toEqual({ order: "ABc", touched: "ABab" });
  });

  it("touches none of the children around one that goes or comes", () => {
    expect(place("abc", "ac")).toEqual({ order: "ac", touched: "b" });
    expect(place("abc", "bc")).toEqual({ order: "bc", touched: "a" });
    expect(place("ac", "aBc")).toEqual({ order: "aBc", touched: "B" });
    expect(place("ab", "abC")).toEqual({ order: "abC", touched: "C" });
    expect(place("", "AB")).toEqual({ order: "AB", touched: "AB" });
    expect(place("ab", "")).toEqual({ order: "", touched: "ab" });
  });

  it("moves only the child that comes forward", () => {
    expect(place("abcd", "cabd")).toEqual({ order: "cabd", touched: "c" });
    expect(place("abcd", "dabc")).toEqual({ order: "dabc", touched: "d" });
  });

  // Not the fewest moves there could be (`a` alone): the walk keeps the child it stands at.
  it("moves the children a child falls back past, and not that child", () => {
    expect(place("abcd", "bcad")).toEqual({ order: "bcad", touched: "bc" });
  });

  it("puts the children in the order wanted whatever the order was", () => {
    for (const to of ["cba", "bca", "bac", "acb", "Xcb", "bXa", "cYbZ"])
      expect(place("abc", to).order, to).toBe(to);
  });
});
