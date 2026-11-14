/** What a link clicked in the Markdown preview leads to (spec 2026-11-14 md-preview 「링크」). */
export type LinkTarget =
  /** Opened by the system's own app: the backend's `open_link` takes these schemes alone. */
  | { kind: "web"; url: string }
  /** A heading or element of the preview itself: the viewer scrolls to it. */
  | { kind: "anchor"; fragment: string }
  /** A path relative to the tab's file, decoded, its query and fragment left out. */
  | { kind: "file"; path: string }
  | { kind: "refused" };

/** The status bar's line for a link to a file that is not a memo of the workspace. */
export const LINK_OUTSIDE = "워크스페이스 밖의 파일은 열지 않습니다";
export const linkMissing = (name: string): string => `워크스페이스에 없는 메모입니다: ${name}`;

/** The schemes `open_link` takes (src-tauri/src/app/links.rs `OPENABLE_SCHEMES`). */
export const OPENABLE_SCHEMES = ["http", "https", "mailto"];
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/** The longest URL `open_link` takes, in UTF-8 bytes (src-tauri/src/app/links.rs `MAX_URL_LENGTH`). */
export const MAX_URL_LENGTH = 8192;

/** What `open_link` takes, checked the same way (src-tauri/src/app/links.rs `check_url`): one of
 * the three schemes, no space or control character, not too long. */
export function isOpenableLink(url: string): boolean {
  if (new TextEncoder().encode(url).length > MAX_URL_LENGTH) return false;
  if (/[\s\p{Cc}]/u.test(url)) return false;
  const scheme = SCHEME.exec(url)?.[1].toLowerCase();
  return scheme !== undefined && OPENABLE_SCHEMES.includes(scheme);
}

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** `href` as the preview's link carries it — percent-encoded by marked. */
export function classifyLink(href: string): LinkTarget {
  const link = href.trim();
  if (!link) return { kind: "refused" };
  if (link.startsWith("#")) {
    const fragment = decode(link.slice(1));
    return fragment === null ? { kind: "refused" } : { kind: "anchor", fragment };
  }
  const scheme = SCHEME.exec(link)?.[1].toLowerCase();
  if (scheme !== undefined) {
    return isOpenableLink(link) ? { kind: "web", url: link } : { kind: "refused" };
  }
  // `//host/…` takes the page's scheme; `/…` is a path from the disk's root, which no memo has.
  if (link.startsWith("/")) return { kind: "refused" };
  const path = decode(link.split(/[?#]/, 1)[0]);
  return path ? { kind: "file", path } : { kind: "refused" };
}

/** Joins and resolves `.` and `..`; null when `..` climbs past the root. */
function resolve(dir: string, path: string): string[] | null {
  const parts: string[] = [];
  for (const part of `${dir}/${path}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return parts;
}

/** The memo a relative link `path` names, read from the folder of the tab's file (`dir`: the
 * workspace's folder for a memo): the workspace is flat (core spec 「워크스페이스」), so only a file
 * right in `workspace` can be one. Names come back in NFC, as the memo list has them. */
export function memoOfLink(
  path: string,
  dir: string,
  workspace: string,
): { kind: "memo"; name: string } | { kind: "outside" } {
  const target = resolve(dir.normalize("NFC"), path.normalize("NFC"));
  const root = resolve(workspace.normalize("NFC"), "");
  // A path ending in `/` names a folder.
  if (!target || !root || path.endsWith("/") || target.length !== root.length + 1)
    return { kind: "outside" };
  if (root.some((part, i) => target[i] !== part)) return { kind: "outside" };
  return { kind: "memo", name: target[target.length - 1] };
}
