import { describe, expect, it } from "vitest";

import { contrastRatio } from "./contrast";
import { DEFAULT_VARIABLES, type Appearance } from "./vscode-theme";

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 2);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 2);
  });

  it("mixes a translucent foreground over the background", () => {
    const ratio = contrastRatio("rgb(0 0 0 / 50%)", "#ffffff");
    expect(ratio).toBeGreaterThanOrEqual(3.9);
    expect(ratio).toBeLessThanOrEqual(4.1);
  });

  it("mixes a translucent background over the base", () => {
    expect(contrastRatio("#000000", "rgba(0, 0, 0, 0.5)", "#ffffff")).toBeLessThan(
      contrastRatio("#000000", "#ffffff"),
    );
    expect(contrastRatio("#ffffff", "#00000080", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "rgb(127 127 127)"),
      2,
    );
  });

  it("reads #rgb and throws on a colour it cannot read", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 2);
    expect(() => contrastRatio("#zzz", "#fff")).toThrow();
  });
});

describe("search bar colours", () => {
  for (const appearance of ["light", "dark"] as Appearance[]) {
    const v = DEFAULT_VARIABLES[appearance];
    const text: [string, string, string, string?][] = [
      ["--fg", "--input-bg", "text in the find field"],
      ["--muted", "--input-bg", "placeholder and count"],
      ["--muted", "--panel-bg", "idle toggle and icon"],
      ["--fg", "--panel-bg", "button label"],
      ["--danger", "--panel-bg", "invalid regexp message"],
      ["--fg", "--search-match", "a match", "--bg"],
      ["--fg", "--search-match-current", "the current match", "--bg"],
    ];
    for (const [fg, bg, what, base] of text) {
      it(`${appearance}: ${fg} on ${bg} (${what}) is at least 4.5`, () => {
        expect(contrastRatio(v[fg], v[bg], base ? v[base] : undefined)).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${appearance}: --accent on --input-bg (focus, pressed toggle) is at least 3`, () => {
      expect(contrastRatio(v["--accent"], v["--input-bg"])).toBeGreaterThanOrEqual(3);
    });
    it(`${appearance}: --search-match-border on --bg is at least 3`, () => {
      expect(contrastRatio(v["--search-match-border"], v["--bg"])).toBeGreaterThanOrEqual(3);
    });
  }
});
