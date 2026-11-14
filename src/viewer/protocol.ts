/** The postMessage API between the host page and a viewer iframe (spec 「뷰어 API」, and spec
 * 2026-11-14 md-preview 「뷰어 API 추가」). The viewer has an opaque origin, so every message goes
 * to `"*"` and the host checks the source window instead. */

export interface ViewerInit {
  fileName: string;
  extension: string;
  size: number;
  /** A token URL — a primary viewer reads the file through it. */
  url?: string;
  /** The text of a preview viewer's file, as it was when the preview opened. */
  text?: string;
  /** The CSS variables of the current theme (`--bg`, `--fg`, …). */
  theme: Record<string, string>;
  /** Numbers the texts a preview viewer is given: a request names the one it was drawn from. */
  version?: number;
  /** The tab takes no edits: a preview's checkboxes cannot be pressed. */
  readOnly?: boolean;
}

/** A code block of the preview, as the viewer drew it: `lang` is its fence's info word. */
export interface CodeBlock {
  index: number;
  lang: string;
  code: string;
}

/** A piece of a code line: its text, its colour (`#` hex) and `fontStyle` (1 italic, 2 bold,
 * 4 underline, 8 strikethrough — the worker's bits). */
export interface CodeSpan {
  text: string;
  color?: string;
  fontStyle: number;
}

export interface CodeColors {
  index: number;
  lines: CodeSpan[][];
}

export type HostMessage =
  | ({ type: "init" } & ViewerInit)
  | { type: "theme"; theme: Record<string, string> }
  | { type: "resolved"; id: number; url: string | null }
  /** The text changed (a checkbox pressed): drawn again where the reader was. */
  | { type: "update"; text: string; version: number }
  | { type: "highlighted"; version: number; req: number; blocks: CodeColors[] };

export type ViewerMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "resolveRelative"; id: number; path: string }
  | { type: "toggleTask"; version: number; index: number }
  | { type: "highlight"; version: number; req: number; blocks: CodeBlock[] }
  | { type: "openLink"; href: string };
