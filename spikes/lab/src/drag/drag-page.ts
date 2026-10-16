import { recordResult, windowGeometry } from "../lab-api";

interface LogEntry {
  t: number;
  kind: string;
  target: string;
  screenX: number;
  screenY: number;
  clientX: number;
  clientY: number;
  dropEffect?: string;
  insideWindow: boolean;
  window: { screenX: number; screenY: number; innerWidth: number; innerHeight: number };
  note?: string;
}

const TABS = ["a.md", "b.md", "c.md"];
const DRAG_EVENTS = ["dragstart", "dragenter", "dragover", "drop", "dragend"] as const;
const POINTER_EVENTS = ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const;

/** Where the pointer or the drop ended, judged against the page's own viewport. screenX/Y are the
 * only coordinates that still mean something once the pointer is outside the window. */
function insideWindow(screenX: number, screenY: number): boolean {
  // window.screenX/Y is the window's top-left in screen points; innerWidth/Height is the page size.
  const left = window.screenX;
  const top = window.screenY;
  return (
    screenX >= left &&
    screenX <= left + window.outerWidth &&
    screenY >= top &&
    screenY <= top + window.outerHeight
  );
}

function barHtml(id: string, tabs: string[], mode: "html5" | "pointer"): string {
  const items = tabs
    .map(
      (name) =>
        `<span class="tab" data-tab="${name}" data-mode="${mode}" ${mode === "html5" ? 'draggable="true"' : ""}>${name}</span>`,
    )
    .join("");
  return `<div class="bar" id="${id}" data-mode="${mode}">${items}</div>`;
}

/** Manual mode: drag the tabs by hand (or with `orca computer`) and every drag and pointer event
 * lands in results/drag.json with time, coordinates, dropEffect and the window rectangle. The file
 * is rewritten after each event, so closing the window ends the run. */
export function mountDragPage(app: HTMLElement): void {
  app.innerHTML = `
    <style>
      body { font: 14px system-ui; margin: 12px; }
      .bar { display: flex; gap: 6px; padding: 8px; margin: 6px 0; background: #eee; min-height: 32px; }
      .bar.over { background: #cfe8ff; }
      .tab { padding: 6px 12px; background: #fff; border: 1px solid #999; cursor: grab; user-select: none; touch-action: none; }
      pre { height: 280px; overflow: auto; background: #111; color: #9f9; padding: 8px; font-size: 11px; }
    </style>
    <h2>drag 측정 — HTML5 끌어 놓기</h2>
    ${barHtml("bar-1", TABS, "html5")}
    ${barHtml("bar-2", [], "html5")}
    <h2>포인터 이벤트 끌기</h2>
    ${barHtml("pbar-1", ["p1.md", "p2.md", "p3.md"], "pointer")}
    ${barHtml("pbar-2", [], "pointer")}
    <p>절차: ① 탭을 다른 바에 놓기 ② 탭을 창 밖(바탕 화면)에 놓기 ③ 끌다가 Esc — 각 세 번. 창을 닫으면 끝난다.</p>
    <pre id="log"></pre>`;
  const log = app.querySelector<HTMLPreElement>("#log")!;
  const entries: LogEntry[] = [];
  let escCount = 0;

  const save = () => {
    void recordResult("drag", { entries, escCount, windowGeometry: lastGeometry });
  };
  let lastGeometry: unknown = null;
  void windowGeometry().then((g) => (lastGeometry = g));

  const push = (kind: string, ev: MouseEvent | null, target: string, extra?: Partial<LogEntry>) => {
    const screenX = ev?.screenX ?? 0;
    const screenY = ev?.screenY ?? 0;
    const entry: LogEntry = {
      t: Math.round(performance.now()),
      kind,
      target,
      screenX,
      screenY,
      clientX: ev?.clientX ?? 0,
      clientY: ev?.clientY ?? 0,
      insideWindow: insideWindow(screenX, screenY),
      window: {
        screenX: window.screenX,
        screenY: window.screenY,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      },
      ...extra,
    };
    if (ev instanceof DragEvent) entry.dropEffect = ev.dataTransfer?.dropEffect;
    // dragover and pointermove fire continuously; the log keeps only their first and last per run.
    const prev = entries[entries.length - 1];
    if ((kind === "dragover" || kind === "pointermove") && prev?.kind === kind) {
      entries[entries.length - 1] = entry;
    } else {
      entries.push(entry);
    }
    log.textContent = entries
      .slice(-40)
      .map(
        (e) =>
          `${e.t} ${e.kind} ${e.target} screen=${e.screenX},${e.screenY} client=${e.clientX},${e.clientY} effect=${e.dropEffect ?? "-"} inside=${e.insideWindow}${e.note ? " " + e.note : ""}`,
      )
      .join("\n");
    log.scrollTop = log.scrollHeight;
    save();
  };

  const nameOf = (el: EventTarget | null) =>
    el instanceof HTMLElement ? (el.dataset.tab ?? el.id ?? el.className) : "?";

  for (const type of DRAG_EVENTS) {
    document.addEventListener(type, (ev) => {
      const e = ev as DragEvent;
      // Without preventDefault on dragover/dragenter the bar is not a drop target at all.
      if (
        (type === "dragover" || type === "dragenter") &&
        (e.target as HTMLElement).closest?.(".bar")
      ) {
        e.preventDefault();
      }
      if (type === "drop") e.preventDefault();
      push(type, e, nameOf(e.target));
    });
  }
  document.addEventListener("dragstart", (ev) =>
    ev.dataTransfer?.setData("text/plain", nameOf(ev.target)),
  );

  // The pointer variant: after setPointerCapture the pointerup still arrives with outside coordinates.
  for (const type of POINTER_EVENTS) {
    document.addEventListener(type, (ev) => {
      const e = ev as PointerEvent;
      const tab = (e.target as HTMLElement).closest?.<HTMLElement>(".tab[data-mode=pointer]");
      if (!tab) return;
      if (type === "pointerdown") tab.setPointerCapture(e.pointerId);
      push(type, e, nameOf(tab), { note: `captured=${tab.hasPointerCapture(e.pointerId)}` });
    });
  }
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    escCount += 1;
    push("escape", null, "window", { note: `count=${escCount}` });
  });
  window.addEventListener("blur", () => push("window-blur", null, "window"));
  window.addEventListener("focus", () => push("window-focus", null, "window"));
}
