const QUOTED = /^(["'])(?:\\.|(?!\1)[^\\])*\1$/;
const IDENTIFIER = /^-?[_a-zA-Z\u0080-\uFFFF][-_a-zA-Z0-9\u0080-\uFFFF]*$/u;
/** Words that make a whole `font-family` invalid when written bare. */
const RESERVED = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);

/** One family of a list as CSS reads it: kept when CSS can read it bare or it is quoted already,
 * else quoted. */
function family(name: string): string {
  if (QUOTED.test(name)) return name;
  const words = name.split(/\s+/);
  const bare =
    words.every((word) => IDENTIFIER.test(word)) &&
    !(words.length === 1 && RESERVED.has(name.toLowerCase()));
  return bare ? words.join(" ") : `"${name.replace(/["\\]/g, "\\$&")}"`;
}

/** The editor's `--editor-font` for the family the settings name (a name or a list), with the
 * default stack (`--large-text-font` in styles.css) after it. A family that is not installed then
 * falls back to the default monospace instead of the browser's serif, and a name CSS cannot read
 * bare (`3270 Nope`) is quoted rather than making the whole declaration invalid. Empty for no
 * family: the default stack stands. */
export function editorFontStack(setting: string): string {
  const families = (setting.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,]+/g) ?? [])
    .map((part) => part.trim())
    .filter(Boolean)
    .map(family);
  return families.length ? `${families.join(", ")}, var(--large-text-font)` : "";
}
