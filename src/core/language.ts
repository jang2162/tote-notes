import type { LanguageInfo } from "../backend/types";

export function firstLineOf(text: string): string {
  const end = text.search(/\r?\n/);
  return end === -1 ? text : text.slice(0, end);
}

/** Spec 「편집기」: only the sure cases — the first line matches a language's `firstLine`
 * (a shebang, an XML declaration), or the whole text is JSON that starts with `{` or `[`.
 * Anything else is `null`; nothing is guessed from content shape. */
export function detectLanguage(
  text: string,
  languages: readonly LanguageInfo[],
): LanguageInfo | null {
  const first = firstLineOf(text);
  if (first.trim() !== "") {
    for (const lang of languages) {
      if (!lang.firstLine) continue;
      let pattern: RegExp;
      try {
        pattern = new RegExp(lang.firstLine);
      } catch {
        continue;
      }
      if (pattern.test(first)) return lang;
    }
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(text);
      return languages.find((l) => l.id === "json") ?? null;
    } catch {
      return null;
    }
  }
  return null;
}
