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

/** Where a row let go at `y` goes among `rows` (their client boxes, top to bottom): before the
 * first row whose middle is below `y`, else after the last. */
function slotAt(rows: { top: number; height: number }[], y: number): number {
  const index = rows.findIndex((row) => y < row.top + row.height / 2);
  return index < 0 ? rows.length : index;
}

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
  const drop = h("div", { class: "ws-order-drop", hidden: true });
  const frame = h("div", { class: "ws-order-frame" }, list, drop);
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
    // Only the shown ones count: hiding one moves the keys below it up.
    let shown = 0;
    list.replaceChildren(
      ...items.map((item, index) => {
        const key = item.hidden ? null : shortcutHint(shown++);
        const box = h("input", {
          type: "checkbox",
          name: "workspaceHidden",
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
          h("span", { class: "ws-order-name", textContent: item.name.normalize("NFC") }),
          h("span", { class: "ws-order-key", textContent: key ?? "" }),
          h("label", {}, box, "숨김"),
        );
        row.addEventListener("pointerdown", (event) => press(index, event));
        return row;
      }),
    );
    frame.hidden = items.length === 0;
    empty.hidden = !loaded || items.length > 0;
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

  /** Shows the bar before row `slot`, or after the last row. */
  const showDrop = (slot: number) => {
    const rows = rowEls();
    const top = frame.getBoundingClientRect().top;
    const at =
      slot < rows.length
        ? rows[slot].getBoundingClientRect().top
        : rows[rows.length - 1].getBoundingClientRect().bottom;
    drop.style.top = `${at - top}px`;
    drop.hidden = false;
  };

  /** Follows a press on row `from` until it is let go, as the tab bar follows a tab (`TabBar`):
   * pointer events, the listeners the window's. A press on the 「숨김」 box or its label is the box's. */
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
    const lastSlot = fixedAt < 0 ? items.length : fixedAt;
    let slot = from;
    const ours = (event: PointerEvent) => event.pointerId === down.pointerId;
    const finish = (to: number | null) => {
      listening.abort();
      release = null;
      const dragged = dragging;
      dragging = false;
      drop.hidden = true;
      rowEls()[from]?.classList.remove("dragging");
      if (dragged && to !== null && to !== from) {
        items = moveItem(items, from, to);
        render();
        // A save hears back as any change does: the list is read again then.
        stale = false;
        void save();
        return;
      }
      if (stale) {
        stale = false;
        void load();
      }
    };
    const cancel = () => finish(null);
    const move = (event: PointerEvent) => {
      if (!ours(event)) return;
      // A release out of the window may never arrive: a move with no button down is the end.
      if (event.buttons === 0) return cancel();
      if (!dragging) {
        const dx = event.clientX - down.clientX;
        const dy = event.clientY - down.clientY;
        if (Math.hypot(dx, dy) <= DRAG_START_PX) return;
        dragging = true;
        rowEls()[from]?.classList.add("dragging");
        try {
          list.setPointerCapture(event.pointerId);
        } catch {
          // The pointer is gone already (InvalidStateError): its pointerup ends the drag.
        }
      }
      slot = Math.min(
        lastSlot,
        slotAt(
          rowEls().map((row) => row.getBoundingClientRect()),
          event.clientY,
        ),
      );
      showDrop(slot);
    };
    const up = (event: PointerEvent) => {
      if (!ours(event)) return;
      const box = list.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      // A slot below the row's own is one place less once the row is out of the list.
      finish(inside ? (slot > from ? slot - 1 : slot) : null);
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
