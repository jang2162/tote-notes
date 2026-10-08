import type { Text } from "@codemirror/state";

/** Spec 「제목 자동 생성」: the file-name stem a memo takes from its first non-blank line. */
export const TITLE_MAX_CHARS = 60;
export const UNTITLED = "untitled";
/** A title line further down is ignored; the check runs on every cursor move. */
const TITLE_SCAN_LINES = 1000;

const FORBIDDEN = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);

/** Control characters as Rust's `char::is_control` counts them (C0, DEL, C1): the backend
 * refuses names containing any. */
function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

export function titleFromLine(line: string): string {
  const cleaned = Array.from(line.normalize("NFC").replace(/^[\s#]+/, ""), (ch) =>
    FORBIDDEN.has(ch) || isControl(ch) ? " " : ch,
  ).join("");
  const stem = cleaned
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  // Code points, not grapheme clusters: 60 clusters of emoji could pass the 255-byte file name
  // limit (60 code points are at most 240 bytes). Flags and ZWJ sequences may be split.
  const cut = Array.from(stem).slice(0, TITLE_MAX_CHARS).join("").trim();
  return cut || UNTITLED;
}

/** The first non-blank line and its number (line 1 for a blank memo). */
export function titleLine(doc: Text): { text: string; number: number } {
  const last = Math.min(doc.lines, TITLE_SCAN_LINES);
  for (let n = 1; n <= last; n++) {
    const line = doc.line(n);
    if (line.text.trim() !== "") return { text: line.text, number: n };
  }
  return { text: "", number: 1 };
}

export function memoTitle(doc: Text): string {
  return titleFromLine(titleLine(doc).text);
}
