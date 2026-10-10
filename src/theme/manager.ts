import type { Backend, ThemeInfo, ThemeRef } from "../backend/types";
import type { Registry } from "../extensions/registry";
import {
  DEFAULT_VARIABLES,
  loadTheme,
  themeVariables,
  type Appearance,
  type VsCodeTheme,
} from "./vscode-theme";

export interface ActiveTheme {
  info: ThemeInfo | null;
  /** null when no theme could be read: the defaults of `appearance` apply. */
  theme: VsCodeTheme | null;
  appearance: Appearance;
  variables: Record<string, string>;
}

/** Narrower than `MediaQueryList`'s own signature so a test's stand-in fits. */
type Media = {
  matches: boolean;
  addEventListener(type: "change", fn: (e: { matches: boolean }) => void): void;
};

/** Which theme is on (spec 「테마」): the configured one for the OS appearance, re-read when the
 * appearance or the settings change. `apply` puts the variables on the page; viewers and the
 * highlighter follow through `onChange`. */
export class ThemeManager {
  active: ActiveTheme = {
    info: null,
    theme: null,
    appearance: "light",
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
    const appearance: Appearance = this.media.matches ? "dark" : "light";
    let info: ThemeInfo | null = null;
    let theme: VsCodeTheme | null = null;
    // A theme that cannot be had never stops the app (spec 「오류 처리」): the defaults apply.
    try {
      const settings = await this.backend.settings();
      const ref: ThemeRef | null = settings.theme[appearance];
      info = this.registry().themeFor(ref, appearance) ?? null;
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
    const variables = theme
      ? themeVariables(theme, appearance)
      : { ...DEFAULT_VARIABLES[appearance] };
    this.active = { info: theme ? info : null, theme, appearance, variables };
    this.apply(this.active);
    for (const listener of this.listeners) listener(this.active);
  }
}

export function applyToDocument(active: ActiveTheme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(active.variables)) root.style.setProperty(name, value);
  root.dataset.appearance = active.appearance;
  root.style.colorScheme = active.appearance;
}
