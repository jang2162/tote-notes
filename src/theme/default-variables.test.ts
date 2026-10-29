import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_VARIABLES, type Appearance } from "./vscode-theme";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** The text between the braces opened right after `header` in `within`. */
function block(header: string, within = css): string {
  const start = within.indexOf(header);
  if (start < 0) throw new Error(`no ${header}`);
  const open = within.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < within.length; i++) {
    if (within[i] === "{") depth++;
    if (within[i] === "}" && --depth === 0) return within.slice(open + 1, i);
  }
  throw new Error(`${header} is not closed`);
}

/** The `--name: value` declarations of one block, comments cut and values on one line. */
function variables(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [, name, value] of text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    found[name] = value.replace(/\s+/g, " ").trim();
  return found;
}

/** Variables styles.css carries that are not theme colours, so `DEFAULT_VARIABLES` has no entry,
 * with the value each appearance has. Pinned here so that dropping one from the css, or changing
 * it there, is noticed too. */
const SAME = (value: string) => ({ light: value, dark: value });
const NOT_THEMED: Record<string, { light: string; dark: string }> = {
  "--large-text-font": SAME('ui-monospace, "SF Mono", Menlo, "Apple SD Gothic Neo", monospace'),
  "--large-text-size": SAME("14px"),
  "--editor-font": SAME("var(--large-text-font)"),
  "--editor-size": SAME("14px"),
  "--focus-ring-room": SAME("4px"),
  "--top-row-height": SAME("36px"),
  "--traffic-lights-width": SAME("80px"),
  "--sidebar-width": SAME("240px"),
};

describe("styles.css and DEFAULT_VARIABLES", () => {
  const dark = block("@media (prefers-color-scheme: dark)");
  const sources: Record<Appearance, Record<string, string>> = {
    light: variables(block(":root")),
    // The dark block overrides the light one key by key.
    dark: { ...variables(block(":root")), ...variables(block(":root", dark)) },
  };
  for (const appearance of ["light", "dark"] as Appearance[]) {
    it(`${appearance}: both carry the same keys`, () => {
      const inCss = Object.keys(sources[appearance]).filter((k) => !(k in NOT_THEMED));
      const inCode = Object.keys(DEFAULT_VARIABLES[appearance]);
      expect({
        onlyInCss: inCss.filter((k) => !inCode.includes(k)),
        onlyInCode: inCode.filter((k) => !inCss.includes(k)),
      }).toEqual({ onlyInCss: [], onlyInCode: [] });
    });

    it(`${appearance}: both carry the same values`, () => {
      const differing = Object.entries(DEFAULT_VARIABLES[appearance])
        .filter(([key, value]) => sources[appearance][key] !== value)
        .map(([key, value]) => `${key}: code ${value}, css ${sources[appearance][key]}`);
      expect(differing).toEqual([]);
    });

    it(`${appearance}: the variables that are not themed keep their values`, () => {
      const differing = Object.entries(NOT_THEMED)
        .filter(([key, value]) => sources[appearance][key] !== value[appearance])
        .map(
          ([key, value]) => `${key}: pinned ${value[appearance]}, css ${sources[appearance][key]}`,
        );
      expect(differing).toEqual([]);
    });
  }
});
