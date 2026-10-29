import type { KeyBinding } from "@codemirror/view";

import type { ShortcutTable } from "../backend/types";
import { editorKeymap } from "../editor/setup";
import { commandName } from "./command-names";

// Shortcuts are Tauri accelerators (`CmdOrCtrl+Shift+N`), read here the way muda 0.20 reads them
// (`parse_accelerator` in its accelerator/mod.rs) on macOS, so that the settings screen judges a
// key as the menu and `shortcuts::validate` in src-tauri/src/shortcuts.rs do.

const META = 1;
const CONTROL = 2;
const ALT = 4;
const SHIFT = 8;

const MODIFIERS: Record<string, number> = {
  OPTION: ALT,
  ALT,
  CONTROL,
  CTRL: CONTROL,
  COMMAND: META,
  CMD: META,
  SUPER: META,
  META,
  SHIFT,
  // macOS: ⌘.
  COMMANDORCONTROL: META,
  COMMANDORCTRL: META,
  CMDORCTRL: META,
  CMDORCONTROL: META,
};

/** The key names muda knows, upper-cased, to their `KeyboardEvent.code`. Only the keys a keyboard
 * of this app's users has: muda also knows media and browser keys, which no one records here. */
const CODES: Record<string, string> = (() => {
  const codes: Record<string, string> = {};
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    codes[letter] = codes[`KEY${letter}`] = `Key${letter}`;
  for (const digit of "0123456789") {
    codes[digit] = codes[`DIGIT${digit}`] = `Digit${digit}`;
    codes[`NUMPAD${digit}`] = codes[`NUM${digit}`] = `Numpad${digit}`;
  }
  for (let n = 1; n <= 35; n++) codes[`F${n}`] = `F${n}`;
  const named: [string[], string][] = [
    [["BACKQUOTE", "`"], "Backquote"],
    [["BACKSLASH", "\\"], "Backslash"],
    [["BRACKETLEFT", "["], "BracketLeft"],
    [["BRACKETRIGHT", "]"], "BracketRight"],
    [["COMMA", ","], "Comma"],
    [["EQUAL", "="], "Equal"],
    [["MINUS", "-"], "Minus"],
    [["PERIOD", "."], "Period"],
    [["QUOTE", "'"], "Quote"],
    [["SEMICOLON", ";"], "Semicolon"],
    [["SLASH", "/"], "Slash"],
    [["INTLBACKSLASH"], "IntlBackslash"],
    [["BACKSPACE"], "Backspace"],
    [["CAPSLOCK"], "CapsLock"],
    [["ENTER"], "Enter"],
    [["SPACE"], "Space"],
    [["TAB"], "Tab"],
    [["DELETE"], "Delete"],
    [["END"], "End"],
    [["HELP"], "Help"],
    [["HOME"], "Home"],
    [["INSERT"], "Insert"],
    [["PAGEDOWN"], "PageDown"],
    [["PAGEUP"], "PageUp"],
    [["ARROWDOWN", "DOWN"], "ArrowDown"],
    [["ARROWLEFT", "LEFT"], "ArrowLeft"],
    [["ARROWRIGHT", "RIGHT"], "ArrowRight"],
    [["ARROWUP", "UP"], "ArrowUp"],
    [["ESCAPE", "ESC"], "Escape"],
    [["NUMPADADD", "NUMADD", "NUMPADPLUS", "NUMPLUS"], "NumpadAdd"],
    [["NUMPADDECIMAL", "NUMDECIMAL"], "NumpadDecimal"],
    [["NUMPADDIVIDE", "NUMDIVIDE"], "NumpadDivide"],
    [["NUMPADENTER", "NUMENTER"], "NumpadEnter"],
    [["NUMPADEQUAL", "NUMEQUAL"], "NumpadEqual"],
    [["NUMPADMULTIPLY", "NUMMULTIPLY"], "NumpadMultiply"],
    [["NUMPADSUBTRACT", "NUMSUBTRACT"], "NumpadSubtract"],
  ];
  for (const [names, code] of named) for (const name of names) codes[name] = code;
  return codes;
})();

interface Keys {
  mods: number;
  code: string;
}

/** `parse_accelerator`: the key after the last `+` (a `+` itself when nothing follows it). */
function parse(accelerator: string): Keys | null {
  const text = accelerator.trim();
  if (!text) return null;
  const at = text.lastIndexOf("+");
  let modsText = "";
  let keyText = text;
  if (at >= 0) {
    const raw = text.slice(at + 1);
    if (raw.trim()) {
      modsText = text.slice(0, at);
      keyText = raw.trim();
    } else {
      modsText = text.slice(0, at).replace(/\++$/, "");
      keyText = "+";
    }
  }
  let mods = 0;
  if (modsText)
    for (const token of modsText.split("+")) {
      const mod = MODIFIERS[token.trim().toUpperCase()];
      if (mod === undefined) return null;
      mods |= mod;
    }
  const code = CODES[keyText.toUpperCase()];
  return code === undefined ? null : { mods, code };
}

/** Whether `a` and `b` are the same keys (`shortcuts::same`): `CmdOrCtrl`, `Cmd` and `Super`
 * are one key on macOS. A string that does not parse is the same as nothing. */
export function sameAccelerator(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  return x !== null && y !== null && x.mods === y.mods && x.code === y.code;
}

const F1_TO_F12 = /^F([1-9]|1[0-2])$/;

function recordable(keys: Keys): boolean {
  // muda cannot put IntlBackslash on a macOS menu item.
  if (keys.code === "IntlBackslash") return false;
  // A macOS menu fires a keypad key's item on a main-row key too: only the keypad's Enter is a
  // key of its own (`KEYPAD_TWINS`).
  if (keys.code.startsWith("Numpad") && keys.code !== "NumpadEnter") return false;
  return (
    (keys.mods & (META | CONTROL | ALT)) !== 0 || (keys.mods === 0 && F1_TO_F12.test(keys.code))
  );
}

/** Whether the settings screen could have recorded it (`recordable` in src-tauri/src/shortcuts.rs):
 * ⌘, ⌃ or ⌥ with a key, or F1–F12 with no modifier at all. A key alone or with only ⇧ — F keys
 * too — would be taken from typing. */
export function recordableAccelerator(accelerator: string): boolean {
  const keys = parse(accelerator);
  return keys !== null && recordable(keys);
}

const SYMBOLS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Home: "↖",
  End: "↘",
  PageUp: "⇞",
  PageDown: "⇟",
  NumpadEnter: "키패드 ↩",
};

/** The keypad keys a macOS menu cannot tell from a main-row key, and that key. AppKit leaves
 * `NSEventModifierFlagNumericPad` out when it matches a key equivalent, so an item on either fires
 * on both (settings smoke B-8; tried on a menu outside the app). Recorded as the main-row key,
 * the shortcut says what it does and meets the main-row key's command as the same key. The
 * keypad's ＋ and × are not recorded: their items fire on ⇧⌘= and ⇧⌘8 too, while an item on those
 * is not fired by the keypad, so neither name would say what the shortcut does. */
const KEYPAD_TWINS: Record<string, string> = {
  ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`Numpad${n}`, `${n}`])),
  NumpadSubtract: "-",
  NumpadDecimal: ".",
  NumpadDivide: "/",
  NumpadEqual: "=",
};

/** As macOS menus write it: ⌃⌥⇧⌘, then the key (`"CmdOrCtrl+Shift+N"` → `"⇧⌘N"`). A string that
 * does not parse is shown as it is. */
export function formatAccelerator(accelerator: string): string {
  const keys = parse(accelerator);
  if (!keys) return accelerator;
  const { mods, code } = keys;
  const key = /^(Key|Digit)/.test(code) ? code.slice(-1) : (SYMBOLS[code] ?? code);
  return (
    (mods & CONTROL ? "⌃" : "") +
    (mods & ALT ? "⌥" : "") +
    (mods & SHIFT ? "⇧" : "") +
    (mods & META ? "⌘" : "") +
    key
  );
}

/** The accelerator's name for a key `KeyboardEvent.code` gives; null for one not recorded. */
function keyOfCode(code: string): string | null {
  if (/^Key[A-Z]$|^Digit[0-9]$/.test(code)) return code.slice(-1);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code.startsWith("Arrow")) return code.slice(5) || null;
  const twin = KEYPAD_TWINS[code];
  if (twin) return twin;
  if (code === "NumpadEnter") return code;
  const char = SYMBOLS[code];
  if (char && char.length === 1 && "`\\[],=-.';/".includes(char)) return char;
  return ["Enter", "Tab", "Space", "Home", "End", "PageUp", "PageDown", "Insert", "Help"].includes(
    code,
  )
    ? code
    : null;
}

/** What a key pressed while recording means (spec 「화면」): Esc cancels and Backspace or Delete
 * clear, whatever modifiers are held; otherwise the accelerator, when the screen takes it (⌘, ⌃
 * or ⌥ with a key, or F1–F12 alone), else null — for a modifier on its own too. The key is read
 * from `code`, so ⌥ (`˜` for N) and the Korean input method (`ㅜ`) leave it the same. */
export function acceleratorFromEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string | "cancel" | "clear" | null {
  if (event.code === "Escape" || event.key === "Escape") return "cancel";
  if (["Backspace", "Delete"].includes(event.code) || ["Backspace", "Delete"].includes(event.key))
    return "clear";
  const key = keyOfCode(event.code);
  if (key === null) return null;
  const accelerator = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.metaKey ? "CmdOrCtrl" : "",
    event.shiftKey ? "Shift" : "",
    key,
  ]
    .filter(Boolean)
    .join("+");
  return recordableAccelerator(accelerator) ? accelerator : null;
}

const CM_MODIFIERS: Record<string, string> = {
  mod: "CmdOrCtrl",
  cmd: "CmdOrCtrl",
  meta: "CmdOrCtrl",
  m: "CmdOrCtrl",
  ctrl: "Ctrl",
  control: "Ctrl",
  c: "Ctrl",
  alt: "Alt",
  a: "Alt",
  shift: "Shift",
  s: "Shift",
};

/** A CodeMirror key name (`Shift-Mod-\\`, `Alt-ArrowUp`) as an accelerator, as macOS reads it
 * (`Mod` is ⌘); null for a sequence of keys or a key no accelerator names. */
function cmKeyToAccelerator(name: string): string | null {
  if (/ (?!$)/.test(name)) return null;
  const parts = name.split(/-(?!$)/);
  const key = parts.pop()!;
  const mods: string[] = [];
  for (const part of parts) {
    const mod = CM_MODIFIERS[part.toLowerCase()];
    if (!mod) return null;
    mods.push(mod);
  }
  let token: string | null;
  if (key === "Space" || key === " ") token = "Space";
  else if (/^[a-z0-9]$/i.test(key)) token = key.toUpperCase();
  else if ("`\\[],=-.';/".includes(key) && key.length === 1) token = key;
  else if (key.startsWith("Arrow")) token = key.slice(5);
  else if (/^F\d+$/.test(key)) token = key;
  else
    token = [
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Escape",
      "Insert",
    ].includes(key)
      ? key
      : null;
  if (token === null) return null;
  const accelerator = [...mods, token].join("+");
  return parse(accelerator) ? accelerator : null;
}

/** What `bindingsOf` names a function no module exports. */
export const UNNAMED_EDITOR_COMMAND = "편집기 명령";

interface EditorKey {
  accelerator: string;
  name: string;
  /** The key as CodeMirror names it in the keymap. */
  key: string;
}

function keysOf(keymap: readonly KeyBinding[]): EditorKey[] {
  return keymap.flatMap((binding) => {
    const name = binding.mac ?? binding.key;
    if (!name) return [];
    const found: EditorKey[] = [];
    const add = (key: string, run: KeyBinding["run"]) => {
      const accelerator = cmKeyToAccelerator(key);
      if (accelerator && run)
        found.push({ accelerator, name: commandName(run) ?? UNNAMED_EDITOR_COMMAND, key });
    };
    add(name, binding.run);
    if (binding.shift) add(`Shift-${name}`, binding.shift);
    return found;
  });
}

/** The keys of `keymap` as macOS has them (a binding's `mac` before its `key`; its `shift` is the
 * same key with ⇧), named after the export of the function they run (`commandName`), or 편집기 명령
 * for one no module exports. */
export function bindingsOf(keymap: readonly KeyBinding[]): { accelerator: string; name: string }[] {
  return keysOf(keymap).map(({ accelerator, name }) => ({ accelerator, name }));
}

let editorKeys: EditorKey[] | null = null;

/** The editor's keys (`keysOf`). Read from the keymap itself, so a keymap that changes leaves it
 * current. */
function editorKeysNow(): EditorKey[] {
  editorKeys ??= keysOf(editorKeymap);
  return editorKeys;
}

let bindings: { accelerator: string; name: string }[] | null = null;

/** The editor's keys (`bindingsOf`). */
export function editorBindings(): { accelerator: string; name: string }[] {
  bindings ??= editorKeysNow().map(({ accelerator, name }) => ({ accelerator, name }));
  return bindings;
}

/** Whether the editor runs its key `editor` on `accelerator`. CodeMirror goes by
 * `KeyboardEvent.key`, which is `Enter` for the keypad's ↩ too, so an editor key on ↩ runs on the
 * keypad's as well, while a macOS menu tells the two apart. The keypad's other keys are recorded as
 * their main-row twins (`KEYPAD_TWINS`). */
function editorRunsOn(editor: string, accelerator: string): boolean {
  const x = parse(editor);
  const y = parse(accelerator);
  if (x === null || y === null) return false;
  return x.mods === y.mods && x.code === (y.code === "NumpadEnter" ? "Enter" : y.code);
}

/** The keys the editor hears as one and the menu tells apart (`editorRunsOn`). */
const ENTERS = new Set(["Enter", "NumpadEnter"]);

/** Editor bindings for the app shortcuts that are editor keys too, which run the app command
 * (`run`) instead of the editor's, in the editor and in its search bar (spec 「무엇을 바꿀
 * 수 있나」, its 편집기 단축키 item). WKWebView hands a key to the page before the menu, and the editor takes it: without
 * these the editor would win where the settings screen says the menu does. Built for
 * `Prec.highest`, ahead of every editor binding of the same key. A key no editor binding has is
 * left to the menu. A shortcut on ↩ or the keypad's ↩ is matched on the event's `code`, as the
 * menu tells them apart: the other ↩ stays the editor's. */
export function menuKeymap(table: ShortcutTable, run: (id: string) => void): KeyBinding[] {
  return table.commands.flatMap(({ id, current }): KeyBinding[] => {
    if (current === null) return [];
    const keys = new Set(
      editorKeysNow()
        .filter((editor) => editorRunsOn(editor.accelerator, current))
        .map((editor) => editor.key),
    );
    if (keys.size === 0) return [];
    if (ENTERS.has(parse(current)!.code))
      return [
        {
          // `any` is what hears the event: a binding's `run` is given the view alone. Ahead of the
          // editor's bindings at `Prec.highest`, it is asked first for every key.
          any: (_view, event) => {
            const pressed = acceleratorFromEvent(event);
            if (pressed === null || !sameAccelerator(pressed, current)) return false;
            event.preventDefault();
            run(id);
            return true;
          },
          scope: "editor search-panel",
        },
      ];
    return [...keys].map((key) => ({
      key,
      run: () => {
        run(id);
        return true;
      },
      scope: "editor search-panel",
      preventDefault: true,
    }));
  });
}

export type Conflict =
  | { kind: "command"; id: string; label: string }
  | { kind: "fixed"; name: string }
  | { kind: "editor"; name: string };

/** What `accelerator` would clash with if command `id` took it: a fixed shortcut first, then
 * another command's shortcut as it is now, then an editor key (which only warns). */
export function conflict(table: ShortcutTable, id: string, accelerator: string): Conflict | null {
  const fixed = table.fixed.find((f) => sameAccelerator(f.accelerator, accelerator));
  if (fixed) return { kind: "fixed", name: fixed.name };
  const other = table.commands.find(
    (c) => c.id !== id && c.current !== null && sameAccelerator(c.current, accelerator),
  );
  if (other) return { kind: "command", id: other.id, label: other.label };
  const editor = editorBindings().find((b) => editorRunsOn(b.accelerator, accelerator));
  if (editor) return { kind: "editor", name: editor.name };
  return null;
}

/** The shortcut command `id` has now, as the screen writes it; null when it has none. */
export function shortcutHint(table: ShortcutTable, id: string): string | null {
  const current = table.commands.find((c) => c.id === id)?.current;
  return current ? formatAccelerator(current) : null;
}

/** The fixed shortcut named `name` — the menu item's name, as Rust's `FIXED` gives it; fixed ones
 * have no id — as the screen writes it; null when there is none. */
export function fixedShortcutHint(table: ShortcutTable, name: string): string | null {
  const fixed = table.fixed.find((f) => f.name === name);
  return fixed ? formatAccelerator(fixed.accelerator) : null;
}
