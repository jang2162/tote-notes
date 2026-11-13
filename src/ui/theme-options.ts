import type { ExtensionRegistry, ThemeChoice, ThemeMode, ThemeRef } from "../backend/types";

export interface ThemeOption {
  /** The option's value: a mode as it is, a theme as `themeValue` encodes it. */
  value: string;
  label: string;
  /** A picked theme the registry does not have: shown, not offered (theme picker spec 「고르개」). */
  disabled?: boolean;
}

export interface ThemeOptions {
  modes: ThemeOption[];
  /** The registry's themes, in its order, under their own group. */
  themes: ThemeOption[];
  /** The value of the option `choice` stands for. */
  selected: string;
}

const MODES: [ThemeMode, string][] = [
  ["auto", "자동"],
  ["light", "라이트"],
  ["dark", "다크"],
];

/** A JSON array, which no mode's value starts like. */
const themeValue = (ref: ThemeRef) => JSON.stringify([ref.extension, ref.label]);

/** The choice an option's value stands for. */
export function choiceOf(value: string): ThemeChoice {
  if (!value.startsWith("[")) return value as ThemeMode;
  const [extension, label] = JSON.parse(value) as [string, string];
  return { extension, label };
}

/** The 「테마」 picker's options (theme picker spec 「고르개」): the modes, then every theme of the
 * registry by its label, the extension's name after one whose label another theme has too. */
export function themeOptions(
  choice: ThemeChoice | undefined,
  registry: ExtensionRegistry,
): ThemeOptions {
  const count = new Map<string, number>();
  for (const t of registry.themes) count.set(t.label, (count.get(t.label) ?? 0) + 1);
  const nameOf = (id: string) => registry.extensions.find((e) => e.id === id)?.displayName ?? id;
  const themes: ThemeOption[] = registry.themes.map((t) => ({
    value: themeValue(t),
    label: count.get(t.label)! > 1 ? `${t.label} (${nameOf(t.extension)})` : t.label,
  }));
  const modes = MODES.map(([value, label]) => ({ value, label }));
  if (typeof choice !== "object") return { modes, themes, selected: choice ?? "auto" };
  const selected = themeValue(choice);
  if (!themes.some((o) => o.value === selected))
    themes.push({
      value: selected,
      label: `${choice.label} (찾을 수 없음, 지금은 자동)`,
      disabled: true,
    });
  return { modes, themes, selected };
}
