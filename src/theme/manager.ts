import type { Backend, ThemeInfo, ThemeMode } from "../backend/types";
import type { Registry } from "../extensions/registry";
import {
  DEFAULT_VARIABLES,
  loadTheme,
  themeKind,
  themeVariables,
  type Appearance,
  type VsCodeTheme,
} from "./vscode-theme";

export interface ActiveTheme {
  info: ThemeInfo | null;
  /** null when no theme could be read: the defaults of `appearance` apply. */
  theme: VsCodeTheme | null;
  /** The appearance `theme` is the default of: the mode's, or the OS appearance in auto. */
  appearance: Appearance;
  /** What the page is drawn as: the theme's kind (`themeKind`), `appearance` without a theme. */
  kind: Appearance;
  variables: Record<string, string>;
}

/** Narrower than `MediaQueryList`'s own signature so a test's stand-in fits. */
type Media = {
  matches: boolean;
  addEventListener(type: "change", fn: (e: { matches: boolean }) => void): void;
};

/** Which theme is on (spec 「테마」): the default one of the mode's appearance (the OS's in auto),
 * re-read when the appearance or the settings change. `apply` puts the variables on the page;
 * viewers and the highlighter follow through `onChange`. */
export class ThemeManager {
  active: ActiveTheme = {
    info: null,
    theme: null,
    appearance: "light",
    kind: "light",
    variables: DEFAULT_VARIABLES.light,
  };
  private readonly listeners: ((active: ActiveTheme) => void)[] = [];
  private readonly media: Media;
  private readonly apply: (active: ActiveTheme) => void;
  private generation = 0;

  constructor(
    private readonly backend: Backend,
    private readonly registry: () => Registry,
    options: { media?: Media; apply?: (active: ActiveTheme) => void } = {},
  ) {
    this.media = options.media ?? window.matchMedia("(prefers-color-scheme: dark)");
    this.apply = options.apply ?? applyToDocument;
  }

  async start(): Promise<void> {
    this.media.addEventListener("change", () => void this.refresh());
    await this.refresh();
  }

  onChange(listener: (active: ActiveTheme) => void): void {
    this.listeners.push(listener);
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    let appearance: Appearance = this.media.matches ? "dark" : "light";
    let info: ThemeInfo | null = null;
    let theme: VsCodeTheme | null = null;
    // A theme that cannot be had never stops the app (spec 「오류 처리」): the defaults apply.
    try {
      const settings = await this.backend.settings();
      // Read when the settings come: the OS may have changed meanwhile. Its change event brings
      // another refresh in every mode, which in light and dark lands on the same theme.
      appearance = appearanceOf(settings.theme.mode, this.media.matches);
      // The default of the appearance: a theme per appearance an older build saved is not read.
      info = this.registry().themeFor(null, appearance) ?? null;
      if (info) {
        const found = info;
        theme = await loadTheme(
          async (path) =>
            new TextDecoder().decode(await this.backend.readExtensionFile(found.extension, path)),
          found.path,
        );
      }
    } catch (error) {
      console.error("theme could not be read", error);
    }
    // A slower refresh must not land over a newer one.
    if (generation !== this.generation) return;
    const kind = theme ? themeKind(info?.uiTheme, theme.type, appearance) : appearance;
    const variables = theme ? themeVariables(theme, kind) : { ...DEFAULT_VARIABLES[kind] };
    this.active = { info: theme ? info : null, theme, appearance, kind, variables };
    this.apply(this.active);
    for (const listener of this.listeners) listener(this.active);
  }
}

/** The appearance `mode` picks: the OS appearance (`dark`, from `prefers-color-scheme`) in auto. Rust
 * forces the app's appearance in light and dark (src-tauri/src/app/appearance.rs), so there the
 * OS's would agree; the mode is read anyway, as the page may hear of the change first. */
export function appearanceOf(mode: ThemeMode | undefined, dark: boolean): Appearance {
  return mode === "light" || mode === "dark" ? mode : dark ? "dark" : "light";
}

export function applyToDocument(active: ActiveTheme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(active.variables)) root.style.setProperty(name, value);
  // The theme's kind, not the OS appearance: a light theme drawn in the dark appearance gets light
  // scroll bars and form controls.
  root.dataset.appearance = active.kind;
  root.style.colorScheme = active.kind;
}
