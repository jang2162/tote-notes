import { recordableAccelerator, sameAccelerator } from "../shortcuts/keys";
import { FAKE_FIXED_SHORTCUTS, resolveShortcuts, sanitizeShortcuts } from "./fake-shortcuts";
import type { GlobalShortcutCommand, GlobalShortcutTable } from "./types";

type Overrides = Record<string, string | null>;

/** The fake backend's copy of `GLOBAL_COMMANDS` in src-tauri/src/global_shortcuts.rs.
 * fake-global-shortcuts.test.ts holds it against the table Rust writes out. */
export const FAKE_GLOBAL_COMMANDS: Pick<GlobalShortcutCommand, "id" | "label" | "default">[] = [
  { id: "quick-note", label: "빠른 메모", default: "Ctrl+Alt+N" },
];

/** What a row says when macOS would not take its shortcut (`REGISTER_FAILED`). */
export const GLOBAL_REGISTER_FAILED = "다른 앱이 쓰고 있어 등록하지 못했습니다";

const appKeys = (appSaved: Overrides): string[] =>
  resolveShortcuts(sanitizeShortcuts(appSaved)).filter((keys) => keys !== null);

/** `stands`: recordable, no media key (the plugin hears those through an event tap), no fixed
 * shortcut, no key an app command has. */
function stands(keys: string, app: string[]): boolean {
  return (
    recordableAccelerator(keys) &&
    !/\+Media/i.test(keys) &&
    !FAKE_FIXED_SHORTCUTS.some((f) => sameAccelerator(keys, f.accelerator)) &&
    !app.some((a) => sameAccelerator(keys, a))
  );
}

/** `global_shortcuts::sanitize`: the entries of `saved` that can stand beside `appSaved`. */
export function sanitizeGlobalShortcuts(saved: Overrides, appSaved: Overrides): Overrides {
  const app = appKeys(appSaved);
  return Object.fromEntries(
    Object.entries(saved).filter(
      ([id, keys]) =>
        FAKE_GLOBAL_COMMANDS.some((c) => c.id === id) && (keys === null || stands(keys, app)),
    ),
  );
}

/** `global_shortcuts::validate`: the id Rust refuses a patch for, or null. */
export function refusedGlobalShortcut(saved: Overrides, appSaved: Overrides): string | null {
  const kept = sanitizeGlobalShortcuts(saved, appSaved);
  return (
    Object.keys(saved)
      .sort()
      .find((id) => !Object.hasOwn(kept, id)) ?? null
  );
}

/** `global_shortcuts::table`, with `refused` the keys macOS would not take. */
export function globalShortcutTable(
  saved: Overrides,
  appSaved: Overrides,
  refused: string[],
): GlobalShortcutTable {
  const kept = sanitizeGlobalShortcuts(saved, appSaved);
  const app = appKeys(appSaved);
  return {
    commands: FAKE_GLOBAL_COMMANDS.map((command) => {
      const yielded = !Object.hasOwn(kept, command.id) && !stands(command.default, app);
      const current = Object.hasOwn(kept, command.id)
        ? kept[command.id]
        : yielded
          ? null
          : command.default;
      const problem =
        current !== null && refused.some((keys) => sameAccelerator(keys, current))
          ? GLOBAL_REGISTER_FAILED
          : null;
      return {
        ...command,
        current,
        ...(yielded ? { yielded: true as const } : {}),
        ...(problem ? { problem } : {}),
      };
    }),
  };
}
