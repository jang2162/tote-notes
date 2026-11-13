import { describe, expect, it } from "vitest";

import type { ExtensionRegistry, ThemeInfo } from "../backend/types";
import { choiceOf, themeOptions } from "./theme-options";

const summary = (id: string, displayName: string, source: "bundled" | "user") => ({
  id,
  version: "1.0.0",
  displayName,
  source,
  enabled: true,
  path: `/x/${id}`,
});

const theme = (extension: string, label: string, uiTheme = "vs-dark"): ThemeInfo => ({
  extension,
  label,
  uiTheme,
  path: `${label}.json`,
});

function registry(themes: ThemeInfo[]): ExtensionRegistry {
  return {
    extensions: [
      summary("someone.night", "Night Theme", "user"),
      summary("other.night", "Other Night", "user"),
      summary("tote.themes", "Tote Notes 기본 테마", "bundled"),
    ],
    languages: [],
    grammars: [],
    themes,
    viewers: [],
    problems: [],
  };
}

const bundled = [theme("tote.themes", "Light+", "vs"), theme("tote.themes", "Dark+")];

describe("themeOptions", () => {
  it("offers the three modes, then every theme of the registry in its order", () => {
    const options = themeOptions("auto", registry([theme("someone.night", "Night"), ...bundled]));
    expect(options.modes.map((o) => o.label)).toEqual(["자동", "라이트", "다크"]);
    expect(options.themes.map((o) => o.label)).toEqual(["Night", "Light+", "Dark+"]);
    expect(options.themes.every((o) => !o.disabled)).toBe(true);
    expect(options.selected).toBe("auto");
  });

  it("names the extension after each theme whose name another one has too", () => {
    const options = themeOptions(
      "dark",
      registry([theme("someone.night", "Night"), theme("other.night", "Night"), ...bundled]),
    );
    expect(options.themes.map((o) => o.label)).toEqual([
      "Night (Night Theme)",
      "Night (Other Night)",
      "Light+",
      "Dark+",
    ]);
    expect(options.selected).toBe("dark");
  });

  it("selects the picked theme, and each value comes back as the choice it stands for", () => {
    const night = { extension: "other.night", label: "Night" };
    const options = themeOptions(
      night,
      registry([theme("someone.night", "Night"), theme("other.night", "Night"), ...bundled]),
    );
    const picked = options.themes.find((o) => o.value === options.selected);
    expect(picked?.label).toBe("Night (Other Night)");
    expect(choiceOf(options.selected)).toEqual(night);
    for (const mode of ["auto", "light", "dark"] as const) expect(choiceOf(mode)).toBe(mode);
    expect(new Set([...options.modes, ...options.themes].map((o) => o.value)).size).toBe(7);
  });

  it("shows a picked theme the registry does not have as one that cannot be picked again", () => {
    const options = themeOptions({ extension: "someone.night", label: "Night" }, registry(bundled));
    expect(options.themes.map((o) => [o.label, !!o.disabled])).toEqual([
      ["Light+", false],
      ["Dark+", false],
      ["Night (찾을 수 없음, 지금은 자동)", true],
    ]);
    expect(options.themes.at(-1)?.value).toBe(options.selected);
    expect(choiceOf(options.selected)).toEqual({ extension: "someone.night", label: "Night" });
  });

  it("reads a missing choice, as an old fake seed has, as auto", () => {
    expect(themeOptions(undefined, registry(bundled)).selected).toBe("auto");
  });
});
