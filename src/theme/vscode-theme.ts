import type { IRawTheme } from "@shikijs/vscode-textmate";

import { parseJsonc } from "../core/jsonc";

export type Appearance = "light" | "dark";

export interface TokenColor {
  name?: string;
  scope?: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

/** A VS Code colour theme (`contributes.themes[].path`), with any `include` already folded in. */
export interface VsCodeTheme {
  name?: string;
  type?: string;
  colors: Record<string, string>;
  tokenColors: TokenColor[];
}

/** The CSS variables styles.css uses and the VS Code colour keys that fill them, first present
 * key wins (spec 「테마」: only the keys tote's UI has a use for). */
export const CSS_VARIABLES: { variable: string; keys: string[] }[] = [
  { variable: "--bg", keys: ["editor.background"] },
  { variable: "--fg", keys: ["editor.foreground", "foreground"] },
  {
    variable: "--muted",
    keys: ["descriptionForeground", "disabledForeground", "tab.inactiveForeground"],
  },
  {
    variable: "--border",
    keys: ["editorGroup.border", "panel.border", "sideBar.border", "contrastBorder"],
  },
  { variable: "--accent", keys: ["button.background", "focusBorder", "textLink.foreground"] },
  { variable: "--danger", keys: ["errorForeground", "editorError.foreground"] },
  { variable: "--sidebar-bg", keys: ["sideBar.background", "editorGroupHeader.tabsBackground"] },
  {
    variable: "--active-bg",
    keys: ["list.activeSelectionBackground", "list.inactiveSelectionBackground"],
  },
  { variable: "--active-line", keys: ["editor.lineHighlightBackground"] },
  { variable: "--selection", keys: ["editor.selectionBackground"] },
  { variable: "--selection-match", keys: ["editor.selectionHighlightBackground"] },
  { variable: "--cursor", keys: ["editorCursor.foreground", "editor.foreground", "foreground"] },
  { variable: "--panel-bg", keys: ["editorWidget.background", "sideBar.background"] },
];

/** The values styles.css carries for each appearance; the theme overrides key by key. */
export const DEFAULT_VARIABLES: Record<Appearance, Record<string, string>> = {
  light: {
    "--bg": "#ffffff",
    "--fg": "#1f2328",
    "--muted": "#6e7781",
    "--border": "#d8dee4",
    "--accent": "#0969da",
    "--danger": "#cf222e",
    "--sidebar-bg": "#f6f8fa",
    "--active-bg": "#dbeafe",
    "--active-line": "rgb(0 0 0 / 3%)",
    "--selection": "#b6d6fd",
    "--selection-match": "rgb(255 200 0 / 25%)",
    "--cursor": "#1f2328",
    "--panel-bg": "#f6f8fa",
  },
  dark: {
    "--bg": "#1e1f22",
    "--fg": "#dcdee3",
    "--muted": "#8b9099",
    "--border": "#34363c",
    "--accent": "#4c9aff",
    "--danger": "#ff7b72",
    "--sidebar-bg": "#191a1d",
    "--active-bg": "#263449",
    "--active-line": "rgb(255 255 255 / 4%)",
    "--selection": "#2f4f7a",
    "--selection-match": "rgb(255 200 0 / 18%)",
    "--cursor": "#dcdee3",
    "--panel-bg": "#191a1d",
  },
};

/** A colour literal and nothing else: a theme value ends up in CSS custom properties, where
 * `url(...)` would reach the network (spec 「허용 범위」) and `;` would add declarations. */
const COLOR =
  /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|hsl)a?\(\s*[\d.]+(%|deg)?(\s*[,\s/]\s*[\d.]+(%|deg)?){2,3}\s*\))$/i;

export function themeVariables(
  theme: Pick<VsCodeTheme, "colors">,
  appearance: Appearance,
): Record<string, string> {
  const vars = { ...DEFAULT_VARIABLES[appearance] };
  for (const { variable, keys } of CSS_VARIABLES) {
    const key = keys.find(
      (k) => typeof theme.colors[k] === "string" && COLOR.test(theme.colors[k]),
    );
    if (key) vars[variable] = theme.colors[key];
  }
  return vars;
}

const INCLUDE_DEPTH = 5;

/** Reads a theme file with `read` (paths relative to the extension folder). An `include` is
 * read first and this file's colours and rules go over it, as VS Code does. */
export async function loadTheme(
  read: (path: string) => Promise<string>,
  path: string,
): Promise<VsCodeTheme> {
  return loadThemeAt(read, path, new Set());
}

async function loadThemeAt(
  read: (path: string) => Promise<string>,
  path: string,
  seen: Set<string>,
): Promise<VsCodeTheme> {
  const raw = parseJsonc<Partial<VsCodeTheme> & { include?: string }>(await read(path)) ?? {};
  let base: VsCodeTheme = { colors: {}, tokenColors: [] };
  if (typeof raw.include === "string" && seen.size < INCLUDE_DEPTH && !seen.has(path)) {
    seen.add(path);
    const included = resolveRelative(path, raw.include);
    if (!seen.has(included)) base = await loadThemeAt(read, included, seen);
  }
  const theme: VsCodeTheme = {
    colors: { ...base.colors, ...(isRecord(raw.colors) ? raw.colors : {}) },
    tokenColors: [
      ...base.tokenColors,
      ...(Array.isArray(raw.tokenColors) ? raw.tokenColors.filter(isTokenColor) : []),
    ],
  };
  const name = raw.name ?? base.name;
  if (name) theme.name = name;
  const type = raw.type ?? base.type;
  if (type) theme.type = type;
  return theme;
}

function resolveRelative(from: string, include: string): string {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  const parts: string[] = [];
  for (const part of (dir + include).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

const isRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isTokenColor = (v: unknown): v is TokenColor =>
  isRecord(v) && isRecord((v as { settings?: unknown }).settings);

/** The theme as the TextMate registry takes it: the editor's own colours as the first,
 * scope-less rule, then the token rules. */
export function tokenTheme(theme: VsCodeTheme): IRawTheme {
  const base: TokenColor["settings"] = {};
  if (theme.colors["editor.foreground"]) base.foreground = theme.colors["editor.foreground"];
  if (theme.colors["editor.background"]) base.background = theme.colors["editor.background"];
  return { name: theme.name, settings: [{ settings: base }, ...theme.tokenColors] };
}
