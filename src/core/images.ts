/** Images a Markdown memo takes in by paste or drop: which files count, how large, what they are
 * named and how the memo links them (docs/superpowers/specs/2026-11-14-tote-notes-image-paste-design.md). */

import { splitName } from "./names";

/** One image may be this large and no larger. `MAX_IMAGE_BYTES` in
 * src-tauri/src/workspace/images.rs must agree. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** The extensions an image is known by. `IMAGE_EXTENSIONS` in src-tauri/src/workspace/images.rs
 * must agree. */
export const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/** The clipboard's image types a paste takes, with the extension the file gets. */
export const PASTED_IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const IMAGE_TOO_LARGE = "20MB 가 넘는 이미지는 넣을 수 없습니다";

export function isImageName(name: string): boolean {
  const { ext } = splitName(name);
  return ext !== "" && IMAGE_EXTENSIONS.includes(ext.toLowerCase());
}

/** `<memo name> 이미지.<ext>` for an image of `type` pasted in the memo `memoFile`. */
export function pastedImageName(memoFile: string, type: string): string {
  return `${splitName(memoFile).stem} 이미지.${PASTED_IMAGE_TYPES[type]}`;
}

/** `![](name)` as the preview reads it back: `marked` gives the address through `encodeURI` and
 * the viewer decodes it, so `%` is written `%25` (else `a%20b.png` would come back as `a b.png`),
 * and `<`·`>` cannot stand inside the angle brackets a space or a parenthesis needs. */
export function imageLink(name: string): string {
  const address = name.replace(/%/g, "%25").replace(/</g, "%3C").replace(/>/g, "%3E");
  return /[\s()]/.test(address) ? `![](<${address}>)` : `![](${address})`;
}
