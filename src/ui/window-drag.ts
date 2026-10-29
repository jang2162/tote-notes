/** Makes the free space of `el` drag the window: a first press there (`isFree`, while `canDrag`)
 * hands itself to the system (`start`). With `onDouble`, a second press let go where it was made
 * calls it — Tauri's drag.js does the same on macOS, where a move between the two is a drag, not a
 * double click. Instead of `data-tauri-drag-region`, whose double click zooms everywhere: the tab
 * bar's opens a tab. The events go on as they would (a pane's focus, the tab bar's `dblclick`). */
export function dragsWindow(
  el: HTMLElement,
  options: {
    isFree(target: Element): boolean;
    canDrag(): boolean;
    start(): void;
    onDouble?: () => void;
  },
): void {
  let second: { x: number; y: number } | null = null;
  el.addEventListener("mousedown", (event) => {
    second = null;
    if (event.button !== 0 || !options.isFree(event.target as Element) || !options.canDrag())
      return;
    if (event.detail === 1) {
      // No text selection, no focus change: the system has the press from here.
      event.preventDefault();
      options.start();
    } else if (event.detail === 2 && options.onDouble) {
      second = { x: event.clientX, y: event.clientY };
    }
  });
  if (!options.onDouble) return;
  const onDouble = options.onDouble;
  el.addEventListener("mouseup", (event) => {
    const down = second;
    second = null;
    if (
      down &&
      event.detail === 2 &&
      event.clientX === down.x &&
      event.clientY === down.y &&
      options.isFree(event.target as Element)
    )
      onDouble();
  });
}
