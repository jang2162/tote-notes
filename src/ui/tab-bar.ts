import { h } from "./dom";

export interface TabView {
  id: string;
  title: string;
  hint: string;
  dirty: boolean;
  /** The last save failed; the text is only in memory until a retry succeeds. */
  failed: boolean;
  external: boolean;
  active: boolean;
}

/** How far a pressed tab moves before it is being dragged; less is a click. */
export const DRAG_START_PX = 4;

/** Where a tab dropped at `x` goes among `tabs` (their client boxes, left to right): before the
 * first tab whose middle is right of `x`, else at the end. */
export function dropIndex(tabs: { left: number; width: number }[], x: number): number {
  const index = tabs.findIndex((tab) => x < tab.left + tab.width / 2);
  return index < 0 ? tabs.length : index;
}

/** A tab being dragged, in client coordinates — out of the window too, past its edges: it goes
 * `over` places, then is dropped or, on Esc, called off. A drop also says where it was let go on
 * the screen (`screenX`, `screenY`). */
export interface TabDrag {
  over(x: number, y: number): void;
  drop(x: number, y: number, screenX: number, screenY: number): void;
  cancel(): void;
}

export class TabBar {
  readonly el = h("div", { class: "tabbar", role: "tablist" });
  /** The tab dragged out of the window, dimmed while it is (`markOut`). */
  private out: string | null = null;

  constructor(
    private readonly actions: {
      select(id: string): void;
      close(id: string): void;
      /** Tab `id` has started to be dragged. */
      drag(id: string): TabDrag;
      /** Tab `id` was right-clicked: its context menu. */
      menu(id: string): void;
      /** The bar itself, not a tab, was double clicked. */
      newTab(): void;
    },
  ) {
    // Only the bar's own free space: a tab or its close button is the event's target there.
    this.el.addEventListener("dblclick", (event) => {
      if (event.target === this.el) this.actions.newTab();
    });
  }

  render(tabs: TabView[]): void {
    this.el.replaceChildren(...tabs.map((tab) => this.tab(tab)));
    this.el.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Where a tab dropped at `x` goes in this bar (`dropIndex`). */
  indexAt(x: number): number {
    return dropIndex(
      this.tabEls().map((el) => el.getBoundingClientRect()),
      x,
    );
  }

  /** Marks where a dropped tab would go: before tab `index`, after the last one, or — with no
   * tabs — the bar itself. Null takes the mark away. */
  markDrop(index: number | null): void {
    const tabs = this.tabEls();
    for (const el of tabs) el.classList.remove("drop-before", "drop-after");
    this.el.classList.toggle("drop-into", index !== null && tabs.length === 0);
    if (index === null || tabs.length === 0) return;
    if (index < tabs.length) tabs[index].classList.add("drop-before");
    else tabs[tabs.length - 1].classList.add("drop-after");
  }

  /** Dims tab `id`, dragged out of the window; null takes that away. It stays dimmed as the bar is
   * drawn again. */
  markOut(id: string | null): void {
    this.out = id;
    for (const el of this.tabEls()) el.classList.toggle("dragging-out", el.dataset.id === id);
  }

  private tabEls(): HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>(".tab")];
  }

  private tab(tab: TabView): HTMLElement {
    // Beside the role=tab element, not in it: a tab's children are presentational, so a close
    // button inside would not be in the accessibility tree and its name would join the tab's
    // ("가 탭 닫기"). And WebKit presses the first button inside a role=tab element in the tab's
    // place (`nativeActionElement` in AccessibilityNodeObject.cpp), so VoiceOver choosing the tab
    // would close it. Out of the keys' Tab order, as the tabs are.
    const close = h("button", {
      type: "button",
      class: "tab-close",
      tabIndex: -1,
      ariaLabel: "탭 닫기",
      title: "탭 닫기",
      textContent: "×",
    });
    close.addEventListener("click", () => this.actions.close(tab.id));
    const classes = [
      "tab",
      tab.active && "active",
      tab.dirty && "dirty",
      tab.failed && "failed",
      tab.external && "external",
      tab.id === this.out && "dragging-out",
    ]
      .filter(Boolean)
      .join(" ");
    const el = h(
      "div",
      { class: classes, role: "none", data: { id: tab.id } },
      h(
        "div",
        { class: "tab-label", role: "tab", ariaSelected: String(tab.active), title: tab.hint },
        h("span", { class: "tab-title", textContent: tab.title }),
      ),
      close,
    );
    el.addEventListener("pointerdown", (event) => {
      if (event.button === 0 && !(event.target as Element).closest(".tab-close"))
        this.follow(tab.id, event);
    });
    el.addEventListener("mousedown", (event) => {
      if (event.button === 0 && !(event.target as Element).closest(".tab-close"))
        this.actions.select(tab.id);
    });
    // A click no pointer made (an accessibility press, `click()`): the mouse selects on mousedown.
    el.addEventListener("click", (event) => {
      if (event.detail === 0 && !(event.target as Element).closest(".tab-close"))
        this.actions.select(tab.id);
    });
    el.addEventListener("auxclick", (event) => {
      if (event.button === 1) this.actions.close(tab.id);
    });
    el.addEventListener("contextmenu", (event) => {
      // The webview's own menu (Reload, Inspect Element) is no use on a tab.
      event.preventDefault();
      this.actions.menu(tab.id);
    });
    return el;
  }

  /** Follows a press on tab `id` until it is let go. Pointer events rather than HTML5 drag and
   * drop: the spike could not confirm the latter between tab bars in the app's webview. The tab's
   * element is drawn again as it is selected, so the listeners are the window's. */
  private follow(id: string, down: PointerEvent): void {
    let drag: TabDrag | null = null;
    const listening = new AbortController();
    const stop = () => listening.abort();
    const ours = (event: PointerEvent) => event.pointerId === down.pointerId;
    const move = (event: PointerEvent) => {
      if (!ours(event)) return;
      // The release out of the window may never arrive: a move with no button down is the end.
      if (drag && event.buttons === 0) return cancel();
      if (!drag) {
        const dx = event.clientX - down.clientX;
        const dy = event.clientY - down.clientY;
        if (Math.hypot(dx, dy) <= DRAG_START_PX) return;
        drag = this.actions.drag(id);
        // Over a viewer's frame the moves would go to the frame's document. Without the capture the
        // drag still follows the pointer over the page.
        try {
          this.el.setPointerCapture(event.pointerId);
        } catch {
          // The pointer is gone already (InvalidStateError): its pointerup ends the drag.
        }
      }
      drag.over(event.clientX, event.clientY);
    };
    const up = (event: PointerEvent) => {
      if (!ours(event)) return;
      stop();
      drag?.drop(event.clientX, event.clientY, event.screenX, event.screenY);
    };
    const cancel = () => {
      stop();
      drag?.cancel();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const options = { signal: listening.signal };
    // The pointer leaving the window goes on with the drag: a drop out there tears the tab off.
    // Whether the app's webview sends a `blur` as it leaves is not confirmed in the app yet (Task 1
    // of the free splits plan); if it does, the `blur` below calls such drags off.
    window.addEventListener("pointermove", move, options);
    window.addEventListener("pointerup", up, options);
    window.addEventListener("pointercancel", cancel, options);
    window.addEventListener("blur", cancel, options);
    window.addEventListener("keydown", key, { ...options, capture: true });
  }
}
