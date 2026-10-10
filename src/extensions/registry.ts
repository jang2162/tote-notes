import type {
  ExtensionRegistry,
  GrammarRef,
  LanguageInfo,
  ThemeInfo,
  ThemeRef,
  ViewerInfo,
  ViewerKind,
} from "../backend/types";
import { splitName } from "../core/names";

export const EMPTY_REGISTRY: ExtensionRegistry = {
  extensions: [],
  languages: [],
  grammars: [],
  themes: [],
  viewers: [],
  problems: [],
};

/** Read-side of the extension registry (spec 「설치와 로딩」): which language, viewer and theme
 * a file or setting maps to. The backend already ordered `languages` by precedence. */
export class Registry {
  constructor(readonly data: ExtensionRegistry) {}

  /** The first language claiming the exact file name, else the first claiming its extension. */
  languageForFile(fileName: string): LanguageInfo | undefined {
    const byName = this.data.languages.find((l) => l.filenames.includes(fileName));
    if (byName) return byName;
    const ext = splitName(fileName).ext.toLowerCase();
    return ext ? this.data.languages.find((l) => l.extensions.includes(ext)) : undefined;
  }

  language(id: string): LanguageInfo | undefined {
    return this.data.languages.find((l) => l.id === id);
  }

  /** For the picker: one entry per id (the winning one), by display name. */
  get languages(): LanguageInfo[] {
    const seen = new Set<string>();
    const unique = this.data.languages.filter((l) => !seen.has(l.id) && seen.add(l.id));
    return unique.sort((a, b) => label(a).localeCompare(label(b), "en"));
  }

  viewerFor(fileName: string, kind: ViewerKind): ViewerInfo | undefined {
    const ext = splitName(fileName).ext.toLowerCase();
    return ext
      ? this.data.viewers.find((v) => v.kind === kind && v.extensions.includes(ext))
      : undefined;
  }

  grammarForScope(scopeName: string): GrammarRef | undefined {
    return this.data.grammars.find((g) => g.scopeName === scopeName);
  }

  get themes(): ThemeInfo[] {
    return this.data.themes;
  }

  /** The referenced theme when it is installed, else the first theme of the appearance. */
  themeFor(ref: ThemeRef | null, appearance: "light" | "dark"): ThemeInfo | undefined {
    const wanted =
      ref && this.data.themes.find((t) => t.extension === ref.extension && t.label === ref.label);
    if (wanted) return wanted;
    const dark = (t: ThemeInfo) => t.uiTheme === "vs-dark" || t.uiTheme === "hc-black";
    return this.data.themes.find((t) => dark(t) === (appearance === "dark")) ?? this.data.themes[0];
  }
}

const label = (lang: LanguageInfo) => lang.aliases[0] ?? lang.id;

/** What the status bar shows for a file. */
export function languageLabelFor(lang: LanguageInfo | undefined, fileName: string): string {
  if (lang) return label(lang);
  const ext = splitName(fileName).ext;
  return ext ? ext.toUpperCase() : "텍스트";
}
