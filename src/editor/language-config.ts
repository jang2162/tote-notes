import type { CloseBracketConfig } from "@codemirror/autocomplete";
import type { CommentTokens } from "@codemirror/commands";

import { parseJsonc } from "../core/jsonc";

/** The parts of VS Code's language-configuration.json tote uses (spec 「편집기」: ⌘/, bracket
 * closing, word boundaries). */
export interface LanguageConfiguration {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: ({ open: string; close: string; notIn?: string[] } | [string, string])[];
  wordPattern?: string | { pattern: string; flags?: string };
}

/** CodeMirror's language data, the keys `toggleComment`, `closeBrackets` and the word
 * categorizer read. */
export interface LanguageData {
  commentTokens?: CommentTokens;
  closeBrackets?: CloseBracketConfig;
  wordChars?: string;
}

export const DEFAULT_LANGUAGE_DATA: LanguageData = {};

/** The file is an extension's, so anything that is not a JSON object reads as the plain
 * configuration rather than failing the file it belongs to (spec 「오류 처리」). */
export function parseLanguageConfiguration(text: string): LanguageConfiguration {
  let raw: unknown;
  try {
    raw = parseJsonc<unknown>(text);
  } catch {
    return {};
  }
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as LanguageConfiguration)
    : {};
}

/** The types say what a well-formed file holds; every value is checked anyway, since the file
 * may hold anything. */
export function languageData(config: LanguageConfiguration): LanguageData {
  const data: LanguageData = {};
  const comments: CommentTokens = {};
  if (typeof config.comments?.lineComment === "string") comments.line = config.comments.lineComment;
  const block = config.comments?.blockComment;
  if (
    Array.isArray(block) &&
    block.length === 2 &&
    typeof block[0] === "string" &&
    typeof block[1] === "string"
  )
    comments.block = { open: block[0], close: block[1] };
  if (comments.line || comments.block) data.commentTokens = comments;
  const pairList = config.autoClosingPairs ?? config.brackets;
  const pairs = (Array.isArray(pairList) ? pairList : [])
    .map((pair: unknown) =>
      Array.isArray(pair)
        ? pair[0]
        : pair && typeof pair === "object"
          ? (pair as { open?: unknown }).open
          : null,
    )
    .filter((open): open is string => typeof open === "string" && open.length > 0);
  if (pairs.length) data.closeBrackets = { brackets: [...new Set(pairs)] };
  const pattern = wordPattern(config.wordPattern);
  if (pattern) {
    const chars = wordCharsFor(pattern);
    if (chars) data.wordChars = chars;
  }
  return data;
}

function wordPattern(raw: LanguageConfiguration["wordPattern"]): RegExp | null {
  const source = typeof raw === "string" ? raw : raw?.pattern;
  if (typeof source !== "string") return null;
  try {
    return new RegExp(source, typeof raw === "object" ? (raw.flags ?? "") : "");
  } catch {
    return null;
  }
}

/** CodeMirror takes word characters as a string of extra characters, VS Code as a pattern.
 * The ASCII punctuation the pattern accepts as a whole word is what counts as extra here. */
export function wordCharsFor(pattern: RegExp): string {
  const whole = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gy]/g, ""));
  let chars = "";
  for (let code = 0x21; code <= 0x7e; code++) {
    const ch = String.fromCharCode(code);
    if (/[A-Za-z0-9_]/.test(ch)) continue;
    if (whole.test(ch)) chars += ch;
  }
  return chars;
}
