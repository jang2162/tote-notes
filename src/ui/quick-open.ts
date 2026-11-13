import type { MemoInfo } from "../backend/types";
import { isCompositionKey, isSubmitEnter, modal } from "./dialogs";
import { h, placeChildren } from "./dom";
import { visibleRows } from "./memo-list";
import {
  boldRuns,
  FileIndex,
  rankCommands,
  type CommandItem,
  type CommandResult,
  type FileResult,
} from "./quick-open-match";

/** What 빠른 열기 was closed with: a memo or an open file to show, or an app command to run. */
export type QuickOpenChoice =
  | { kind: "memo"; id: string }
  | { kind: "external"; path: string }
  | { kind: "command"; id: string };

export interface QuickOpenSource {
  /** The window's memos, as its memo list has them. */
  memos: readonly MemoInfo[];
  /** The external files open in any window; the box opens before they are in. */
  externals: Promise<readonly string[]>;
  commands: readonly CommandItem[];
}

/** What a query starts with to look for an app command instead of a memo. */
const COMMAND_PREFIX = ">";

let lists = 0;

/** A row's height, and the most rows in view at once (spec 「모양」); `.quick-open-row` and
 * `.quick-open-scroll` in styles.css hold the same. */
const ROW_HEIGHT = 28;
const ROWS_IN_VIEW = 10;

/** `name` with the characters at `indices` in bold, whole characters as people see them. */
function marked(name: string, indices: readonly number[]): HTMLElement {
  const el = h("span", { class: "quick-open-name" });
  for (const { text, bold } of boldRuns(name, indices))
    el.append(bold ? h("b", { textContent: text }) : text);
  return el;
}

type Row = { result: FileResult | CommandResult; choice: QuickOpenChoice };

function rowsFor(source: QuickOpenSource, files: FileIndex, value: string): Row[] {
  if (value.startsWith(COMMAND_PREFIX))
    return rankCommands(source.commands, value.slice(COMMAND_PREFIX.length)).map((result) => ({
      result,
      choice: { kind: "command", id: result.id },
    }));
  return files.rank(value).map((result) => ({
    result,
    choice:
      result.kind === "memo"
        ? { kind: "memo", id: result.id }
        : { kind: "external", path: result.path },
  }));
}

function drawRow(result: FileResult | CommandResult): HTMLElement[] {
  if ("kind" in result) {
    const name = marked(result.name, result.indices);
    return result.kind === "external"
      ? [name, h("span", { class: "quick-open-detail", textContent: result.dir })]
      : [name];
  }
  return [
    marked(result.label, result.indices),
    h("span", { class: "quick-open-detail", textContent: result.menu }),
    result.keys ? h("span", { class: "quick-open-keys", textContent: result.keys }) : null,
  ].filter((each): each is HTMLElement => each !== null);
}

/** 빠른 열기 (spec 2026-11-14): a box near the top of the window with a field and the memos and
 * open files whose names hold what is typed — or, after `>`, the app commands. ↑↓ pick, Enter or a
 * click takes the row picked; Escape or a press outside the box closes it (`modal`). An Enter or
 * an arrow that belongs to a Korean composition is the input method's. Only the rows in view are
 * drawn. */
export function quickOpen(source: QuickOpenSource): Promise<QuickOpenChoice | null> {
  return modal<QuickOpenChoice>((close) => {
    const listId = `quick-open-list-${++lists}`;
    const input = h("input", {
      type: "text",
      placeholder: "메모 이름 — 명령은 >",
      autocomplete: "off",
    });
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-label", "빠른 열기");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", listId);
    input.dataset.autofocus = "";
    const list = h("ul", { class: "quick-open-list", id: listId, role: "listbox" });
    const scroller = h("div", { class: "quick-open-scroll" }, list);
    // A div, not a paragraph: `modal` would name the dialog after the first paragraph.
    const none = h("div", { class: "quick-open-none", hidden: true });

    // Made ready once: each keystroke only searches it (spec 「성능」).
    const files = new FileIndex(source.memos);
    let rows: Row[] = [];
    /** The rows drawn for `rows`, by place: kept while the results stay, so a row pressed while
     * the list scrolls still gets its click. */
    let drawn = new Map<number, HTMLElement>();
    let picked = 0;

    const rowEl = (at: number): HTMLElement => {
      const had = drawn.get(at);
      if (had) return had;
      const row = rows[at];
      const li = h(
        "li",
        { class: "quick-open-row", id: `${listId}-${at}`, role: "option" },
        ...drawRow(row.result),
      );
      li.style.top = `${at * ROW_HEIGHT}px`;
      li.setAttribute("aria-setsize", String(rows.length));
      li.setAttribute("aria-posinset", String(at + 1));
      // The field keeps the keys while a row is pressed.
      li.addEventListener("mousedown", (event) => event.preventDefault());
      li.addEventListener("click", () => close(row.choice));
      drawn.set(at, li);
      return li;
    };

    /** Draws the rows in view, the one picked marked; before the box is laid out, as many as
     * the list shows. */
    const draw = () => {
      const height = scroller.clientHeight || ROWS_IN_VIEW * ROW_HEIGHT;
      const [start, end] = visibleRows(scroller.scrollTop, height, rows.length, ROW_HEIGHT);
      const wanted: HTMLElement[] = [];
      for (let at = start; at < end; at++) {
        const li = rowEl(at);
        li.classList.toggle("selected", at === picked);
        li.setAttribute("aria-selected", String(at === picked));
        wanted.push(li);
      }
      placeChildren(list, wanted);
      if (rows.length > 0) input.setAttribute("aria-activedescendant", `${listId}-${picked}`);
      else input.removeAttribute("aria-activedescendant");
    };

    const pick = (at: number) => {
      picked = Math.max(0, Math.min(at, rows.length - 1));
      // The row picked is in view, and so drawn.
      const top = picked * ROW_HEIGHT;
      const height = scroller.clientHeight || ROWS_IN_VIEW * ROW_HEIGHT;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (top + ROW_HEIGHT > scroller.scrollTop + height)
        scroller.scrollTop = top + ROW_HEIGHT - height;
      draw();
    };

    const render = (keepPick: boolean) => {
      rows = rowsFor(source, files, input.value);
      drawn = new Map();
      list.style.height = `${rows.length * ROW_HEIGHT}px`;
      if (!keepPick) scroller.scrollTop = 0;
      none.textContent = input.value.startsWith(COMMAND_PREFIX)
        ? "일치하는 명령이 없습니다"
        : "일치하는 메모가 없습니다";
      none.hidden = rows.length > 0;
      scroller.hidden = rows.length === 0;
      pick(keepPick ? picked : 0);
    };

    input.addEventListener("input", () => render(false));
    input.addEventListener("keydown", (event) => {
      if (isSubmitEnter(event)) {
        event.preventDefault();
        const row = rows[picked];
        if (row) close(row.choice);
        return;
      }
      if (isCompositionKey(event)) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        pick(picked + (event.key === "ArrowDown" ? 1 : -1));
      }
    });
    scroller.addEventListener("scroll", draw, { passive: true });
    void source.externals.then(
      (paths) => {
        files.setExternals(paths);
        render(true);
      },
      (error: unknown) => console.warn(error),
    );
    render(false);
    const dialog = h("div", { class: "modal quick-open", role: "dialog" }, input, scroller, none);
    dialog.setAttribute("aria-label", "빠른 열기");
    // A press outside the box closes it, as one outside the switcher's list does (spec 「키와
    // 누르기」); the question dialogs `modal` shows otherwise stay. Taken on the press, before
    // WebKit moves the keys off the field. `modal` puts the box in its backdrop once this returns.
    queueMicrotask(() => {
      const backdrop = dialog.parentElement;
      backdrop?.addEventListener("mousedown", (event) => {
        if (event.target !== backdrop) return;
        event.preventDefault();
        close(null);
      });
    });
    return dialog;
  });
}
