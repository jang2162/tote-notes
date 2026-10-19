import type { Backend, ShortcutCommand, ShortcutTable } from "../backend/types";
import { describeError } from "../app/errors";
import {
  acceleratorFromEvent,
  conflict,
  formatAccelerator,
  sameAccelerator,
  UNNAMED_EDITOR_COMMAND,
} from "../shortcuts/keys";
import { confirm } from "./dialogs";
import { h } from "./dom";

export interface ShortcutsSectionOptions {
  backend: Backend;
  /** Subscribes to config changes; returns the unsubscribe. */
  onConfigChanged: (handler: () => void) => () => void;
}

/** What a row says under it after a key it did not take, or a save that failed. */
type Note =
  | { kind: "taken"; id: string; label: string; accelerator: string }
  | { kind: "fixed"; name: string }
  | { kind: "error"; message: string };

type Shortcuts = Record<string, string | null>;

const same = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && sameAccelerator(a, b));
const shown = (accelerator: string | null) =>
  accelerator === null ? "없음" : formatAccelerator(accelerator);
const MODIFIER_SYMBOLS = "⌃⌥⇧⌘";

/** Whether a row whose name is `name` and whose shortcut is `keys` answers `query`: a part of its
 * name, its shortcut as the screen writes it, or modifiers alone (「⌘」) that the shortcut holds.
 * A shortcut is not matched by a part: 「⌘N」 is not ⇧⌘N. */
function matches(query: string, name: string, keys: string | null): boolean {
  if (!query) return true;
  if (name.toLowerCase().includes(query.toLowerCase())) return true;
  if (keys === null) return false;
  if ([...query].every((char) => MODIFIER_SYMBOLS.includes(char)))
    return [...query].every((char) => keys.includes(char));
  return keys.toUpperCase() === query.toUpperCase();
}

const masked = (name: string) =>
  name === UNNAMED_EDITOR_COMMAND ? "편집기 단축키를 가립니다" : `편집기의 ${name} 을 가립니다`;

/** The 단축키 section: every app command with its shortcut, which a click records anew, and the
 * fixed shortcuts below. The map saved is always whole: the commands whose shortcut is not their
 * default (`SettingsPatch.shortcuts`). */
export function shortcutsSection(options: ShortcutsSectionOptions): HTMLElement {
  const { backend } = options;
  let table: ShortcutTable | null = null;
  /** The command whose row listens for keys now. */
  let recording: string | null = null;
  const notes = new Map<string, Note>();
  /** The row saved last, whose editor warning is news to read out. */
  let announced: string | null = null;
  /** What the rows were last drawn from: a table read again that is the same still redraws them
   * when a note or the row saved last changed since, as when the change was heard (and the table
   * read) before the save returned. */
  const drawing = () => JSON.stringify([table, [...notes], announced]);
  let drawn = "";

  const search = h("input", { type: "search", name: "shortcutSearch", placeholder: "명령 검색" });
  search.spellcheck = false;
  search.setAttribute("aria-label", "명령 검색");
  const problem = h("p", { class: "shortcut-problem" });
  problem.setAttribute("aria-live", "polite");
  const list = h("div", { class: "shortcut-list" });
  const none = h("p", { class: "settings-note", textContent: "맞는 명령이 없습니다" });
  const fixedRows = h("div", { class: "shortcut-fixed-list" });
  const fixedGroup = h(
    "section",
    { class: "shortcut-fixed" },
    h("h2", { class: "shortcut-fixed-title", textContent: "고정" }),
    fixedRows,
  );
  const resetAll = h("button", { textContent: "모두 기본값으로" });

  const fail = (error: unknown) => {
    problem.textContent = describeError(error);
  };
  const keysOf = (id: string) =>
    list.querySelector<HTMLButtonElement>(`.shortcut-row[data-command="${id}"] .shortcut-keys`);
  const commandOf = (id: string) => table?.commands.find((command) => command.id === id);

  // The keys go to the row alone while it records: the window hears them before the editor, the
  // dialogs (Escape) and anything else on the page.
  const onKey = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== "keydown" || recording === null) return;
    const result = acceleratorFromEvent(event);
    if (result === null) return;
    const id = recording;
    stop();
    if (result === "cancel") return;
    take(id, result === "clear" ? null : result);
  };
  const onOutside = (event: Event) => {
    if (recording === null) return;
    if (!(event.target instanceof Node && keysOf(recording)?.contains(event.target))) stop();
  };
  const onLeave = () => stop();
  // A dialog opened from the menu while recording puts the focus in its own input.
  const onFocus = (event: FocusEvent) => {
    if (recording === null) return;
    if (!(event.target instanceof Node && keysOf(recording)?.contains(event.target))) stop();
  };

  const start = (id: string) => {
    if (!table || recording === id) return;
    stop();
    recording = id;
    notes.clear();
    announced = null;
    render();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onLeave);
    window.addEventListener("pagehide", onLeave);
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("focusin", onFocus, true);
    void backend.suspendShortcuts(true).catch(fail);
  };
  /** Ends a recording, every way one ends, with the menu's shortcuts given back once. Only the row's
   * button changes: a click that ended it lands on the element it was pressed on. */
  function stop() {
    if (recording === null) return;
    const id = recording;
    recording = null;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    window.removeEventListener("blur", onLeave);
    window.removeEventListener("pagehide", onLeave);
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("focusin", onFocus, true);
    void backend.suspendShortcuts(false).catch(fail);
    const keys = keysOf(id);
    const command = commandOf(id);
    if (keys && command) {
      keys.textContent = shown(command.current);
      keys.classList.remove("recording");
    }
  }

  /** A key recorded for `id` (`null`: none): saved, unless it is a fixed key or another
   * command's, which the row says instead. */
  const take = (id: string, accelerator: string | null) => {
    const command = commandOf(id);
    if (!table || !command || same(accelerator, command.current)) return;
    const clash = accelerator === null ? null : conflict(table, id, accelerator);
    if (clash?.kind === "fixed") notes.set(id, { kind: "fixed", name: clash.name });
    else if (clash?.kind === "command")
      notes.set(id, { kind: "taken", id: clash.id, label: clash.label, accelerator: accelerator! });
    else return void commit(id, { [id]: accelerator });
    render();
  };

  /** Saves the table with `changes` made, as the whole map. A failure is said under row `id`, and
   * the table stays as it was: the same key can be tried again. */
  const commit = async (id: string, changes: Shortcuts) => {
    if (!table) return;
    const map: Shortcuts = {};
    for (const command of table.commands) {
      const keys = Object.hasOwn(changes, command.id) ? changes[command.id] : command.current;
      if (!same(keys, command.default)) map[command.id] = keys;
    }
    try {
      await backend.patchSettings({ shortcuts: map });
    } catch (error) {
      notes.set(id, { kind: "error", message: describeError(error) });
      render();
      return;
    }
    for (const changed of Object.keys(changes)) notes.delete(changed);
    notes.delete(id);
    announced = id;
    await load();
  };

  const note = (command: ShortcutCommand): HTMLElement | null => {
    const said = notes.get(command.id);
    if (said?.kind === "taken") {
      const swap = h("button", { textContent: "바꾸기" });
      swap.addEventListener(
        "click",
        () => void commit(command.id, { [said.id]: null, [command.id]: said.accelerator }),
      );
      return h(
        "div",
        { class: "shortcut-note error", role: "status" },
        h("span", { textContent: `${said.label} 에 이미 쓰고 있습니다` }),
        swap,
      );
    }
    if (said?.kind === "fixed")
      return h("div", {
        class: "shortcut-note error",
        role: "status",
        textContent: `${said.name} 에 고정된 단축키입니다`,
      });
    if (said?.kind === "error")
      return h("div", { class: "shortcut-note error", role: "status", textContent: said.message });
    const clash = table && command.current ? conflict(table, command.id, command.current) : null;
    if (clash?.kind !== "editor") return null;
    const warning = h("div", { class: "shortcut-note warning", textContent: masked(clash.name) });
    if (announced === command.id) warning.setAttribute("role", "status");
    return warning;
  };

  const row = (command: ShortcutCommand): HTMLElement => {
    const nameId = `shortcut-name-${command.id}`;
    const keys = h("button", {
      class: "shortcut-keys",
      id: `shortcut-keys-${command.id}`,
      textContent: recording === command.id ? "키를 누르세요" : shown(command.current),
    });
    keys.classList.toggle("recording", recording === command.id);
    keys.setAttribute("aria-labelledby", `${nameId} ${keys.id}`);
    keys.addEventListener("click", () => start(command.id));
    const changed = !same(command.current, command.default);
    let reset: HTMLButtonElement | null = null;
    if (changed) {
      reset = h("button", { class: "shortcut-reset", textContent: "되돌리기" });
      // The default may be another command's by now: it goes the way a recorded key does.
      reset.addEventListener("click", () => take(command.id, command.default));
    }
    return h(
      "div",
      { class: `shortcut-row${changed ? " changed" : ""}`, data: { command: command.id } },
      h(
        "span",
        { class: "shortcut-label" },
        h("span", { class: "shortcut-name", id: nameId, textContent: command.label }),
        h("span", { class: "shortcut-menu", textContent: command.menu }),
      ),
      keys,
      h("span", {
        class: "shortcut-default",
        textContent: changed ? `기본값 ${shown(command.default)}` : "기본값",
      }),
      reset,
      note(command),
    );
  };

  function render() {
    if (!table) return;
    drawn = drawing();
    // A rebuilt row takes the focus its old one had, or its reset button that is gone now.
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && list.contains(active)
        ? active.closest<HTMLElement>(".shortcut-row")?.dataset.command
        : undefined;
    list.replaceChildren(...table.commands.map(row));
    fixedRows.replaceChildren(
      ...table.fixed.map((fixed) =>
        h(
          "div",
          { class: "shortcut-fixed-row" },
          h("span", { class: "shortcut-name", textContent: fixed.name }),
          h("span", {
            class: "shortcut-fixed-keys",
            textContent: formatAccelerator(fixed.accelerator),
          }),
        ),
      ),
    );
    resetAll.disabled = table.commands.every((command) => same(command.current, command.default));
    filter();
    if (focused) keysOf(focused)?.focus();
  }

  function filter() {
    if (!table) return;
    const query = search.value.trim();
    let any = false;
    table.commands.forEach((command, at) => {
      const hit = matches(query, command.label, command.current && shown(command.current));
      (list.children[at] as HTMLElement).hidden = !hit;
      any ||= hit;
    });
    let anyFixed = false;
    table.fixed.forEach((fixed, at) => {
      const hit = matches(query, fixed.name, formatAccelerator(fixed.accelerator));
      (fixedRows.children[at] as HTMLElement).hidden = !hit;
      anyFixed ||= hit;
    });
    none.hidden = any || anyFixed;
    fixedGroup.hidden = !anyFixed;
  }
  search.addEventListener("input", filter);

  let loads = 0;
  /** Reads the table again. One that changed — saved here or in another window — ends a
   * recording, whose row may have another shortcut now, and the notes about the old one. */
  const load = async () => {
    const at = ++loads;
    try {
      const next = await backend.shortcutTable();
      if (at !== loads) return;
      problem.textContent = "";
      if (table && JSON.stringify(next) === JSON.stringify(table)) {
        if (drawing() !== drawn) render();
        return;
      }
      stop();
      if (table) notes.clear();
      table = next;
      render();
    } catch (error) {
      if (at === loads) fail(error);
    }
  };
  options.onConfigChanged(() => void load());

  resetAll.addEventListener("click", async () => {
    stop();
    if (!(await confirm("모든 단축키를 기본값으로 되돌릴까요?", "되돌리기"))) return;
    try {
      await backend.patchSettings({ shortcuts: {} });
    } catch (error) {
      return fail(error);
    }
    await load();
  });

  void load();
  return h(
    "div",
    { class: "shortcut-settings" },
    search,
    problem,
    list,
    none,
    fixedGroup,
    h("div", { class: "settings-row shortcut-footer" }, resetAll),
  );
}
