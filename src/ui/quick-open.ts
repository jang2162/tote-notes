import type { MemoInfo } from "../backend/types";
import { isCompositionKey, isSubmitEnter, modal } from "./dialogs";
import { h } from "./dom";
import {
  rankCommands,
  rankFiles,
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

/** `name` with the characters at `indices` (code points) in bold. */
function marked(name: string, indices: readonly number[]): HTMLElement {
  const el = h("span", { class: "quick-open-name" });
  const hit = new Set(indices);
  let run = "";
  let bold = false;
  const flush = () => {
    if (run) el.append(bold ? h("b", { textContent: run }) : run);
    run = "";
  };
  Array.from(name).forEach((char, at) => {
    if (hit.has(at) !== bold) {
      flush();
      bold = !bold;
    }
    run += char;
  });
  flush();
  return el;
}

type Row = { result: FileResult | CommandResult; choice: QuickOpenChoice };

function rowsFor(source: QuickOpenSource, externals: readonly string[], value: string): Row[] {
  if (value.startsWith(COMMAND_PREFIX))
    return rankCommands(source.commands, value.slice(COMMAND_PREFIX.length)).map((result) => ({
      result,
      choice: { kind: "command", id: result.id },
    }));
  return rankFiles(source.memos, externals, value).map((result) => ({
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
 * click takes the row picked; Escape closes it (`modal`). An Enter or an arrow that belongs to a
 * Korean composition is the input method's. */
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
    // A div, not a paragraph: `modal` would name the dialog after the first paragraph.
    const none = h("div", { class: "quick-open-none", hidden: true });

    let externals: readonly string[] = [];
    let rows: Row[] = [];
    let picked = 0;

    const pick = (at: number) => {
      picked = Math.max(0, Math.min(at, rows.length - 1));
      [...list.children].forEach((li, index) => {
        li.classList.toggle("selected", index === picked);
        li.setAttribute("aria-selected", String(index === picked));
        if (index === picked) {
          input.setAttribute("aria-activedescendant", li.id);
          li.scrollIntoView?.({ block: "nearest" });
        }
      });
      if (rows.length === 0) input.removeAttribute("aria-activedescendant");
    };

    const render = (keepPick: boolean) => {
      rows = rowsFor(source, externals, input.value);
      list.replaceChildren(
        ...rows.map((row, index) => {
          const li = h(
            "li",
            { class: "quick-open-row", id: `${listId}-${index}`, role: "option" },
            ...drawRow(row.result),
          );
          // The field keeps the keys while a row is pressed.
          li.addEventListener("mousedown", (event) => event.preventDefault());
          li.addEventListener("click", () => close(row.choice));
          return li;
        }),
      );
      none.textContent = input.value.startsWith(COMMAND_PREFIX)
        ? "일치하는 명령이 없습니다"
        : "일치하는 메모가 없습니다";
      none.hidden = rows.length > 0;
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
    void source.externals.then(
      (paths) => {
        externals = paths;
        render(true);
      },
      (error: unknown) => console.warn(error),
    );
    render(false);
    const dialog = h("div", { class: "modal quick-open", role: "dialog" }, input, list, none);
    dialog.setAttribute("aria-label", "빠른 열기");
    return dialog;
  });
}
