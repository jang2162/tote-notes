import type { Text } from "@codemirror/state";

import type { LanguageInfo } from "../backend/types";

export function firstLineOf(text: string): string {
  const end = text.search(/\r?\n/);
  return end === -1 ? text : text.slice(0, end);
}

/** `firstLine` patterns by source, compiled once (`null`: not a valid expression). */
const patterns = new Map<string, RegExp | null>();

function firstLinePattern(source: string): RegExp | null {
  let pattern = patterns.get(source);
  if (pattern === undefined) {
    try {
      pattern = new RegExp(source);
    } catch {
      pattern = null;
    }
    patterns.set(source, pattern);
  }
  return pattern;
}

function firstNonBlank(text: string | Text): string | undefined {
  if (typeof text === "string") return /\S/.exec(text)?.[0];
  for (const iter = text.iter(); !iter.next().done;) {
    const found = /\S/.exec(iter.value);
    if (found) return found[0];
  }
  return undefined;
}

/** Spec 「편집기」: only the sure cases — the first line matches a language's `firstLine`
 * (a shebang, an XML declaration), or the whole text is JSON that starts with `{` or `[`.
 * Anything else is `null`; nothing is guessed from content shape. A document is copied whole
 * only when it starts with `{` or `[`: this runs whenever the cursor leaves line 1 of a
 * Markdown memo, and nearly all of them are neither. */
export function detectLanguage(
  text: string | Text,
  languages: readonly LanguageInfo[],
): LanguageInfo | null {
  const first = typeof text === "string" ? firstLineOf(text) : text.line(1).text;
  if (first.trim() !== "") {
    for (const lang of languages) {
      if (lang.firstLine && firstLinePattern(lang.firstLine)?.test(first)) return lang;
    }
  }
  const start = firstNonBlank(text);
  if (start === "{" || start === "[") {
    try {
      JSON.parse(text.toString());
      return languages.find((l) => l.id === "json") ?? null;
    } catch {
      return null;
    }
  }
  return null;
}
