/** Splits `name` at its last dot. A leading dot belongs to the stem; no dot means no extension.
 * `split_name` in src-tauri/src/workspace/names.rs must agree. */
export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot + 1) } : { stem: name, ext: "" };
}

/** The last component of a POSIX path. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
