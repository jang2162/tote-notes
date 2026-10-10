/** The postMessage API between the host page and a viewer iframe (spec 「뷰어 API」). The
 * viewer has an opaque origin, so every message goes to `"*"` and the host checks the source
 * window instead. */

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
}

export type HostMessage =
  | ({ type: "init" } & ViewerInit)
  | { type: "theme"; theme: Record<string, string> }
  | { type: "resolved"; id: number; url: string | null };

export type ViewerMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "resolveRelative"; id: number; path: string };
