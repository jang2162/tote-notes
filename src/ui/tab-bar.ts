import { h } from "./dom";

export interface TabView {
  id: string;
  title: string;
  hint: string;
  dirty: boolean;
  /** The last save failed; the text is only in memory until a retry succeeds. */
  failed: boolean;
  external: boolean;
  /** A trashed memo's read-only tab: its title is dimmed. Absent counts as false. */
  trashed?: boolean;
  active: boolean;
}

/** How far a pressed tab moves before it is being dragged; less is a click. */
export const DRAG_START_PX = 4;

/** A tab's box in its bar as laid out — the transforms of a preview leave it be — in the bar's
 * content's coordinates, however far the bar is scrolled. */
export interface TabBox {
  left: number;
  width: number;
}

const middleOf = (tab: TabBox) => tab.left + tab.width / 2;

/** Where a tab from another bar whose middle is at `middle` lands among `tabs` (left to right):
 * past every tab whose middle it has reached. Returns its index once it is there. */
export function landing(tabs: readonly TabBox[], middle: number): number {
  return tabs.filter((tab) => middleOf(tab) <= middle).length;
}

/** Where tab `from` of `tabs`, dragged in its own bar with its left edge at `left`, lands among the
 * others: a tab gives way once the dragged tab's leading edge goes over two thirds of it — its
 * right edge past the left two thirds of a tab right of it, its left edge past the right two
 * thirds of a tab left of it (spec 「끌어 온 탭 바 자기 위」). Returns its index once it is
 * there, the others counted without it. */
export function ownLanding(tabs: readonly TabBox[], from: number, left: number): number {
  const right = left + tabs[from].width;
  let to = 0;
  tabs.forEach((tab, index) => {
    const twoThirds = (tab.width * 2) / 3;
    // A tab left of it stays before it until it gives way; one right of it comes before it once it
    // has.
    if (index < from && left >= tab.left + tab.width - twoThirds) to++;
    if (index > from && right > tab.left + twoThirds) to++;
  });
  return to;
}

/** How `tabs` show a tab dragged over their bar: where it lands (`to`) and how far each tab moves
 * for that, by index. Dragged in its own bar — tab `from`, its left edge at `left` — the others
 * step aside into the order it would leave (`ownLanding`), and it stays between the bar's first and
 * last places however far past them it goes. From another bar, `width` wide with its middle at
 * `middle`, the tabs from where it would go on (`landing`) open a gap for it. */
export function arrange(
  tabs: readonly TabBox[],
  dragged: { from: number; left: number } | { from: null; middle: number; width: number },
): { to: number; shifts: number[] } {
  if (dragged.from === null) {
    const to = landing(tabs, dragged.middle);
    return { to, shifts: tabs.map((_, index) => (index < to ? 0 : dragged.width)) };
  }
  const { from } = dragged;
  const own = tabs[from];
  const to = ownLanding(tabs, from, dragged.left);
  const first = tabs[0].left;
  const last = tabs[tabs.length - 1];
  const order = tabs.map((_, index) => index).filter((index) => index !== from);
  order.splice(to, 0, from);
  const shifts = tabs.map(() => 0);
  let left = first;
  for (const index of order) {
    shifts[index] = left - tabs[index].left;
    left += tabs[index].width;
  }
  const held = Math.min(last.left + last.width - own.width, Math.max(first, dragged.left));
  shifts[from] = held - own.left;
  return { to, shifts };
}

/** A tab dragged over a bar (`TabBar.preview`): tab `id`, `width` wide, with the pointer at `x` in
 * client coordinates. */
export interface TabPreview {
  id: string;
  width: number;
  x: number;
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
  /** The tab dragged away from this bar, dimmed while it is (`markOut`). */
  private out: string | null = null;
  /** The tab of this bar being dragged and how far right of its left edge it was pressed: over this
   * bar it follows the pointer from there. */
  private held: { id: string; grab: number } | null = null;
  /** The preview shown (`preview`), shown again as the bar is drawn again. */
  private shown: TabPreview | null = null;

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
    // Before the preview: the active tab is scrolled to where it is laid out, not where it is shown.
    this.el.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (this.shown) this.show();
  }

  /** Shows the tabs as they would be with `drag` let go over this bar (`arrange`): only how they
   * look — their order, as the tabs and a screen reader know it, is the same until a drop moves
   * the tab. A bar with no tabs is marked as a whole. Null puts every tab back. Returns where the
   * tab goes, the index `Tabs.place` takes: a drop there lands it in the place shown. */
  preview(drag: TabPreview): number;
  preview(drag: null): void;
  preview(drag: TabPreview | null): number {
    this.shown = drag;
    return this.show();
  }

  /** Dims tab `id`, dragged away from this bar — over another one, or out of the window; null takes
   * that away. It stays dimmed as the bar is drawn again. */
  markOut(id: string | null): void {
    this.out = id;
    for (const el of this.tabEls()) el.classList.toggle("dragging-out", el.dataset.id === id);
  }

  /** How wide tab `id` is laid out; 0 when it is not in this bar. */
  widthOf(id: string): number {
    return this.tabEls().find((el) => el.dataset.id === id)?.offsetWidth ?? 0;
  }

  private tabEls(): HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>(".tab")];
  }

  /** Client `x` in the bar's content's coordinates, those of `TabBox`. */
  private contentX(x: number): number {
    return x - this.el.getBoundingClientRect().left - this.el.clientLeft + this.el.scrollLeft;
  }

  /** `arrange` for `drag` over this bar as it is laid out now. Tab `id` is this bar's own when it is
   * in it: held where it was pressed, or by its middle when no press is followed here. */
  private arrangement(drag: TabPreview): { from: number | null; to: number; shifts: number[] } {
    const els = this.tabEls();
    // The bar is their offset parent (styles.css): offsets are in its content, transforms left out.
    const tabs = els.map((el) => ({ left: el.offsetLeft, width: el.offsetWidth }));
    const at = this.contentX(drag.x);
    const from = els.findIndex((el) => el.dataset.id === drag.id);
    if (from < 0)
      return { from: null, ...arrange(tabs, { from: null, middle: at, width: drag.width }) };
    const grab = this.held?.id === drag.id ? this.held.grab : tabs[from].width / 2;
    return { from, ...arrange(tabs, { from, left: at - grab }) };
  }

  private show(): number {
    const els = this.tabEls();
    this.el.classList.toggle("drop-into", this.shown !== null && els.length === 0);
    const { from, to, shifts } = this.shown
      ? this.arrangement(this.shown)
      : { from: null, to: 0, shifts: els.map(() => 0) };
    els.forEach((el, index) => {
      el.style.transform = shifts[index] ? `translateX(${shifts[index]}px)` : "";
      el.classList.toggle("dragging", index === from);
    });
    // `Tabs.place` counts the tab's own place, which it still holds: past it, one more.
    return from !== null && to >= from ? to + 1 : to;
  }

  private tab(tab: TabView): HTMLElement {
    // Beside the role=tab element, not in it: a tab's children are presentational, so a close
    // button inside would not be in the accessibility tree and its name would join the tab's
    // ("가 탭 닫기"). And WebKit presses the first button inside a role=tab element in the tab's
    // place (`nativeActionElement` in AccessibilityNodeObject.cpp), so VoiceOver choosing the tab
    // would close it. Out of the keys' Tab order, as the tabs are. Named after its tab: listed
    // apart from the tabs (VoiceOver's rotor), every button would read the same.
    const name = `${tab.title} 탭 닫기`;
    const close = h("button", {
      type: "button",
      class: "tab-close",
      tabIndex: -1,
      ariaLabel: name,
      title: name,
      textContent: "×",
    });
    // The mouse leaves the keys where they were. A button WebKit gives the focus to would hold it
    // unseen once the pointer is gone (a press dragged off, or a tab that is not active), and Space
    // or Enter there would close the tab. An accessibility press and `click()` come with no
    // mousedown.
    close.addEventListener("mousedown", (event) => event.preventDefault());
    close.addEventListener("click", () => this.actions.close(tab.id));
    const classes = [
      "tab",
      tab.active && "active",
      tab.dirty && "dirty",
      tab.failed && "failed",
      tab.external && "external",
      tab.trashed && "trashed",
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
        this.follow(tab.id, event, el);
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

  /** Follows a press on tab `id` (`pressed`) until it is let go. Pointer events rather than HTML5 drag and
   * drop: the spike could not confirm the latter between tab bars in the app's webview. The tab's
   * element is drawn again as it is selected, so the listeners are the window's. */
  private follow(id: string, down: PointerEvent, pressed: HTMLElement): void {
    let drag: TabDrag | null = null;
    const listening = new AbortController();
    // Measured now: selecting the tab may scroll the bar before the drag starts.
    const grab = this.contentX(down.clientX) - pressed.offsetLeft;
    const stop = () => {
      listening.abort();
      this.held = null;
    };
    const ours = (event: PointerEvent) => event.pointerId === down.pointerId;
    const move = (event: PointerEvent) => {
      if (!ours(event)) return;
      // The release out of the window may never arrive: a move with no button down is the end.
      if (drag && event.buttons === 0) return cancel();
      if (!drag) {
        const dx = event.clientX - down.clientX;
        const dy = event.clientY - down.clientY;
        if (Math.hypot(dx, dy) <= DRAG_START_PX) return;
        this.held = { id, grab };
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
      // Still held while it is dropped: the drop goes where the tab is shown, held where it was.
      try {
        drag?.drop(event.clientX, event.clientY, event.screenX, event.screenY);
      } finally {
        stop();
      }
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
