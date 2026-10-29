import type { Backend, WorkspaceListItem } from "../backend/types";
import { h } from "./dom";
import { DRAG_START_PX } from "./tab-bar";
import { shortcutHint } from "./workspace-switcher";

export interface WorkspacesSectionOptions {
  backend: Backend;
  /** Subscribes to the workspace list changing, in this window or another; returns the
   * unsubscribe. */
  onWorkspacesChanged: (handler: () => void) => () => void;
  /** Says on the settings screen why a save or a read failed. */
  fail: (error: unknown) => void;
  /** A save went through: the reason a failed one gave is old news. */
  saved: () => void;
}

/** `list` with the item at `from` moved to `to`, the index it has once moved. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const moved = [...list];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  return moved;
}

/** Where row `from` of `rows` (their boxes as laid out, top to bottom) lands once moved by `dy`:
 * past every other row whose middle its own middle has gone by. Only the first `movable` rows are
 * places to land. */
export function landing(
  rows: readonly { top: number; height: number }[],
  from: number,
  movable: number,
  dy: number,
): number {
  const middle = (row: { top: number; height: number }) => row.top + row.height / 2;
  const at = middle(rows[from]) + dy;
  let to = 0;
  for (let index = 0; index < movable; index++) {
    if (index !== from && middle(rows[index]) < at) to++;
  }
  return to;
}

/** The ⌃ key of each workspace in `list`: only the shown ones count, so hiding one moves the keys
 * below it up. */
const keysOf = (list: readonly WorkspaceListItem[]) => {
  let shown = 0;
  return list.map((item) => (item.hidden ? null : shortcutHint(shown++)));
};

/** The workspaces as the section lists them: the ones there are, in their set order. Those with no
 * ID come last from the backend already. */
const arranged = (list: WorkspaceListItem[]) =>
  list
    .filter((item) => !item.missing)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));

/** The 워크스페이스 section (spec 「설정 화면 『워크스페이스』 구역」): the workspaces under the root in
 * the order the switcher and ⌃1 – ⌃9 follow, each with the ⌃ key that picks it and a 「숨김」 box.
 * A row is dragged to its new place, and each change is saved as it is made. */
export function workspacesSection(options: WorkspacesSectionOptions): {
  el: HTMLElement;
  /** Stops listening and calls off a drag. */
  dispose(): void;
} {
  const { backend } = options;
  let items: WorkspaceListItem[] = [];
  /** The list has been read once: before that, an empty list is not news. */
  let loaded = false;
  /** Bumped by every read and every change made here: a read answered after a later one, or after
   * a change, is out of date. */
  let version = 0;
  /** Calls off the press being followed, dragged or not yet. */
  let release: (() => void) | null = null;
  let dragging = false;
  /** The list changed while a row was pressed: it is read again once the row is let go. */
  let stale = false;
  let disposed = false;

  const list = h("ol", { class: "ws-order-list" });
  // Hidden until the first read: a read that fails leaves no empty box under its reason.
  const frame = h("div", { class: "ws-order-frame", hidden: true }, list);
  const empty = h("p", {
    class: "settings-note ws-order-empty",
    textContent: "워크스페이스 루트에 워크스페이스가 없습니다.",
    hidden: true,
  });
  const el = h(
    "div",
    { class: "ws-order" },
    h("p", {
      class: "settings-note ws-order-note",
      textContent:
        "끌어서 순서를 바꿉니다. 고르개와 ⌃1~⌃9 가 이 순서를 따릅니다. 숨긴 워크스페이스는 고르개에 보이지 않습니다.",
    }),
    frame,
    empty,
  );

  const rowEls = () => [...list.querySelectorAll<HTMLElement>(".ws-order-row")];

  const render = () => {
    // The rows are drawn anew: a 「숨김」 box toggled from the keyboard keeps the focus.
    const focused = document.activeElement;
    const focusedPath = list.contains(focused)
      ? focused?.closest<HTMLElement>(".ws-order-row")?.dataset.path
      : undefined;
    const keys = keysOf(items);
    list.replaceChildren(
      ...items.map((item, index) => {
        const name = item.name.normalize("NFC");
        const box = h("input", {
          type: "checkbox",
          name: "workspaceHidden",
          // Every box's label is 「숨김」: the name tells a screen reader whose it is.
          ariaLabel: `${name} 숨김`,
          checked: item.hidden,
          // With no ID the order file cannot name it (spec 「저장」).
          disabled: !item.orderable,
        });
        box.addEventListener("change", () => void hide(item.path, box.checked));
        const classes = [
          "ws-order-row",
          item.hidden && "hidden",
          !item.orderable && "fixed",
        ].filter(Boolean);
        const row = h(
          "li",
          { class: classes.join(" "), data: { path: item.path } },
          h("span", { class: "ws-order-grip", textContent: "⋮⋮", ariaHidden: "true" }),
          h("span", { class: "ws-order-name", textContent: name }),
          h("span", { class: "ws-order-key", textContent: keys[index] ?? "" }),
          h("label", {}, box, "숨김"),
        );
        row.addEventListener("pointerdown", (event) => press(index, event));
        return row;
      }),
    );
    frame.hidden = items.length === 0;
    empty.hidden = !loaded || items.length > 0;
    if (focusedPath !== undefined) {
      const row = rowEls().find((each) => each.dataset.path === focusedPath);
      row?.querySelector<HTMLInputElement>("input")?.focus();
    }
  };

  const load = async () => {
    const mine = ++version;
    try {
      const read = await backend.listWorkspaces();
      if (disposed || mine !== version) return;
      // Drawing now would pull the rows from under the pointer, pressed or dragging.
      if (release) {
        stale = true;
        return;
      }
      items = arranged(read);
      loaded = true;
      render();
    } catch (error) {
      if (!disposed && mine === version) options.fail(error);
    }
  };

  /** Saves the rows as they are drawn now. A save that fails says why and shows what is saved. */
  const save = async () => {
    ++version;
    try {
      await backend.setWorkspaceOrder(
        items.map((item) => item.path),
        items.filter((item) => item.hidden).map((item) => item.path),
      );
      if (!disposed) options.saved();
    } catch (error) {
      if (disposed) return;
      options.fail(error);
      await load();
    }
  };

  const hide = async (path: string, hidden: boolean) => {
    items = items.map((item) => (item.path === path ? { ...item, hidden } : item));
    render();
    await save();
  };

  /** Follows a press on row `from` until it is let go, as the tab bar follows a tab (`TabBar`):
   * pointer events, the listeners the window's. A press on the 「숨김」 box or its label is the box's.
   * Dragged, the row follows the pointer and the others step aside into the order it would leave,
   * their ⌃ keys with them; let go, that order is the one saved. */
  const press = (from: number, down: PointerEvent) => {
    if (down.button !== 0) return;
    if ((down.target as Element).closest("label, input")) return;
    // The backend leaves a row with no ID out of the order it saves: it stays last.
    if (!items[from]?.orderable) return;
    // A press whose release never came (let go out of the window, no move since) is over.
    release?.();
    const listening = new AbortController();
    // The rows with no ID come last: a row dragged lands before them.
    const fixedAt = items.findIndex((item) => !item.orderable);
    const movable = fixedAt < 0 ? items.length : fixedAt;
    const rows = rowEls();
    // As laid out: the transforms that move the rows leave these be.
    const boxes = rows.map((row) => ({ top: row.offsetTop, height: row.offsetHeight }));
    // The dragged row stays over the rows it can land among.
    const lowest = boxes[0].top - boxes[from].top;
    const highest =
      boxes[movable - 1].top + boxes[movable - 1].height - (boxes[from].top + boxes[from].height);
    /** The rows by their index in `items`, in the order shown now. */
    let order = items.map((_, index) => index);
    const ours = (event: PointerEvent) => event.pointerId === down.pointerId;

    /** Shows the rows in `order`, the dragged one `dy` from its place. */
    const draw = (dy: number) => {
      const keys = keysOf(order.map((index) => items[index]));
      let top = boxes[0].top;
      order.forEach((index, place) => {
        const row = rows[index];
        const shift = index === from ? dy : top - boxes[index].top;
        row.style.transform = shift ? `translateY(${shift}px)` : "";
        const key = row.querySelector(".ws-order-key");
        if (key) key.textContent = keys[place] ?? "";
        top += boxes[index].height;
      });
    };
    /** Puts the dragged row where the pointer is. Off the list's sides it goes back to its place,
     * and so would the drop. */
    const follow = (event: PointerEvent) => {
      const box = list.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right;
      const dy = event.clientY - down.clientY;
      order = items.map((_, index) => index);
      if (inside) order = moveItem(order, from, landing(boxes, from, movable, dy));
      draw(inside ? Math.min(highest, Math.max(lowest, dy)) : 0);
    };
    const finish = (drop: boolean) => {
      listening.abort();
      release = null;
      const dragged = dragging;
      dragging = false;
      list.classList.remove("sorting");
      rows[from].classList.remove("dragging");
      if (drop && dragged && order.some((index, place) => index !== place)) {
        items = order.map((index) => items[index]);
        render();
        // A save hears back as any change does: the list is read again then.
        stale = false;
        void save();
        return;
      }
      if (dragged) {
        order = items.map((_, index) => index);
        draw(0);
      }
      if (stale) {
        stale = false;
        void load();
      }
    };
    const cancel = () => finish(false);
    const up = (event: PointerEvent) => {
      if (!ours(event)) return;
      if (dragging) follow(event);
      finish(true);
    };
    const move = (event: PointerEvent) => {
      if (!ours(event)) return;
      // A move with no button down comes when the release did not, or before it: it lets go there,
      // which, for one let go out of the window, is where the pointer came back.
      if (event.buttons === 0) return dragging ? up(event) : cancel();
      if (!dragging) {
        const dx = event.clientX - down.clientX;
        const dy = event.clientY - down.clientY;
        if (Math.hypot(dx, dy) <= DRAG_START_PX) return;
        dragging = true;
        list.classList.add("sorting");
        rows[from].classList.add("dragging");
        try {
          list.setPointerCapture(event.pointerId);
        } catch {
          // The pointer is gone already (InvalidStateError): its pointerup ends the drag.
        }
      }
      follow(event);
    };
    // Before the settings screen's own Escape (the modal's, on the document): it stays open.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragging) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const listen = { signal: listening.signal };
    window.addEventListener("pointermove", move, listen);
    window.addEventListener("pointerup", up, listen);
    window.addEventListener("pointercancel", cancel, listen);
    window.addEventListener("blur", cancel, listen);
    window.addEventListener("keydown", key, { ...listen, capture: true });
    release = cancel;
  };

  // A read answered during a drag waits for the row to be let go (`load`).
  const unsubscribe = options.onWorkspacesChanged(() => void load());
  void load();

  return {
    el,
    dispose() {
      disposed = true;
      unsubscribe();
      release?.();
    },
  };
}
