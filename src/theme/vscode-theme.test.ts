import { describe, expect, it } from "vitest";

import {
  DEFAULT_VARIABLES,
  loadTheme,
  themeKind,
  themeVariables,
  tokenTheme,
} from "./vscode-theme";

describe("themeVariables", () => {
  it("maps the colour keys tote uses and falls back per key to the appearance's default", () => {
    const vars = themeVariables(
      {
        colors: {
          "editor.background": "#1E1E1E",
          "editor.foreground": "#D4D4D4",
          "sideBar.background": "#252526",
          "editor.selectionBackground": "#264F78",
          focusBorder: "#007FD4",
          "editor.lineHighlightBackground": "#ffffff0A",
        },
      },
      "dark",
    );
    expect(vars["--bg"]).toBe("#1E1E1E");
    expect(vars["--fg"]).toBe("#D4D4D4");
    expect(vars["--sidebar-bg"]).toBe("#252526");
    expect(vars["--selection"]).toBe("#264F78");
    expect(vars["--accent"]).toBe("#007FD4");
    expect(vars["--active-line"]).toBe("#ffffff0A");
    // Not in the theme: the dark default, not the light one and not undefined.
    expect(vars["--danger"]).toBe(DEFAULT_VARIABLES.dark["--danger"]);
    // No line-number colours in the theme: the dark default, which a previous theme's must not outlive.
    expect(vars["--line-number"]).toBe(DEFAULT_VARIABLES.dark["--line-number"]);
    expect(vars["--cursor"]).toBe("#D4D4D4"); // falls through editorCursor.foreground to the foreground
    expect(Object.keys(vars).sort()).toEqual(Object.keys(DEFAULT_VARIABLES.light).sort());
  });

  it("takes the text on the accent colour from button.foreground", () => {
    const vars = themeVariables(
      { colors: { "button.background": "#0E639C", "button.foreground": "#123456" } },
      "dark",
    );
    expect(vars["--accent-fg"]).toBe("#123456");
    expect(themeVariables({ colors: {} }, "light")["--accent-fg"]).toBe(
      DEFAULT_VARIABLES.light["--accent-fg"],
    );
  });

  it("keeps button.foreground off an accent that did not come from button.background", () => {
    // No accent in the theme: tote's own accent keeps its own text.
    expect(
      themeVariables({ colors: { "button.foreground": "#123456" } }, "dark")["--accent-fg"],
    ).toBe(DEFAULT_VARIABLES.dark["--accent-fg"]);
    // An accent from focusBorder or textLink.foreground: the accent text that reads better on it.
    const dark = DEFAULT_VARIABLES.dark["--accent-fg"];
    const light = DEFAULT_VARIABLES.light["--accent-fg"];
    const on = (colors: Record<string, string>, appearance: "light" | "dark") =>
      themeVariables({ colors: { "button.foreground": "#123456", ...colors } }, appearance)[
        "--accent-fg"
      ];
    expect(on({ focusBorder: "#0E639C" }, "dark")).toBe(light);
    expect(on({ "textLink.foreground": "#9CDCFE" }, "light")).toBe(dark);
  });

  it("gives a button.background without button.foreground the accent text that reads better", () => {
    const vars = themeVariables({ colors: { "button.background": "#9CDCFE" } }, "light");
    expect(vars["--accent-fg"]).toBe(DEFAULT_VARIABLES.dark["--accent-fg"]);
  });

  it("fills the line-number variables from the theme's gutter colours", () => {
    const vars = themeVariables(
      {
        colors: {
          "editorLineNumber.foreground": "#111111",
          "editorLineNumber.activeForeground": "#222222",
        },
      },
      "light",
    );
    expect(vars["--line-number"]).toBe("#111111");
    expect(vars["--line-number-active"]).toBe("#222222");
  });

  it("takes the first key present in a key list", () => {
    const vars = themeVariables(
      { colors: { "textLink.foreground": "#3794FF", "button.background": "#0E639C" } },
      "light",
    );
    expect(vars["--accent"]).toBe("#0E639C");
  });
});

describe("themeVariables find colours", () => {
  it("a theme without the find colours keeps the defaults", () => {
    for (const appearance of ["light", "dark"] as const) {
      const vars = themeVariables({ colors: {} }, appearance);
      for (const name of [
        "--input-bg",
        "--search-match",
        "--search-match-current",
        "--search-match-border",
      ]) {
        expect(vars[name]).toBe(DEFAULT_VARIABLES[appearance][name]);
      }
    }
  });

  it("maps the VS Code find colours", () => {
    const vars = themeVariables(
      {
        colors: {
          "input.background": "#111111",
          "editor.findMatchHighlightBackground": "#22222280",
          "editor.findMatchBackground": "#333333",
          "editor.findMatchBorder": "#444444",
        },
      },
      "dark",
    );
    expect(vars["--input-bg"]).toBe("#111111");
    expect(vars["--search-match"]).toBe("#22222280");
    expect(vars["--search-match-current"]).toBe("#333333");
    expect(vars["--search-match-border"]).toBe("#444444");
  });
});

describe("themeVariables colour check", () => {
  it("drops values that are not colour literals", () => {
    const vars = themeVariables(
      {
        colors: {
          "editor.background": "url(https://x)",
          "editor.foreground": "red;background:url(x)",
          focusBorder: "rgb(10, 20, 30)",
          "editorCursor.foreground": "hsla(120deg 50% 50% / 0.5)",
          "editor.selectionBackground": "#12345678",
        },
      },
      "light",
    );
    expect(vars["--bg"]).toBe(DEFAULT_VARIABLES.light["--bg"]);
    expect(vars["--fg"]).toBe(DEFAULT_VARIABLES.light["--fg"]);
    expect(vars["--accent"]).toBe("rgb(10, 20, 30)");
    expect(vars["--cursor"]).toBe("hsla(120deg 50% 50% / 0.5)");
    expect(vars["--selection"]).toBe("#12345678");
  });
});

describe("loadTheme", () => {
  it("resolves an include and reads JSONC", async () => {
    const files: Record<string, string> = {
      "themes/dark.json": `{
        // the real Dark Modern does exactly this
        "include": "./dark_vs.json",
        "colors": { "editor.background": "#1F1F1F", },
        "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#569CD6" } },],
      }`,
      "themes/dark_vs.json": `{
        "colors": { "editor.background": "#1E1E1E", "editor.foreground": "#D4D4D4" },
        "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#6A9955" } }]
      }`,
    };
    const theme = await loadTheme(
      async (path) => files[path] ?? Promise.reject(new Error(path)),
      "themes/dark.json",
    );
    expect(theme.colors).toEqual({
      "editor.background": "#1F1F1F",
      "editor.foreground": "#D4D4D4",
    });
    expect(theme.tokenColors.map((t) => t.scope)).toEqual(["comment", "keyword"]);
  });

  it("stops following includes that loop", async () => {
    const files: Record<string, string> = {
      "a.json": `{ "include": "./b.json" }`,
      "b.json": `{ "include": "./a.json", "colors": {} }`,
    };
    const theme = await loadTheme(async (path) => files[path], "a.json");
    expect(theme.colors).toEqual({});
  });

  it("tolerates a theme without colors or tokenColors", async () => {
    const theme = await loadTheme(async () => `{ "name": "bare" }`, "bare.json");
    expect(theme).toEqual({ name: "bare", colors: {}, tokenColors: [] });
  });
});

describe("tokenTheme", () => {
  it("puts the editor colours first and keeps the token rules in order", () => {
    const raw = tokenTheme({
      name: "t",
      colors: { "editor.foreground": "#ccc", "editor.background": "#111" },
      tokenColors: [
        { scope: "comment", settings: { foreground: "#888", fontStyle: "italic" } },
        { settings: { foreground: "#eee" } }, // a global rule without scope: VS Code themes start with these
        { scope: ["keyword", "storage"], settings: {} },
      ],
    });
    expect(raw.name).toBe("t");
    expect(raw.settings[0]).toEqual({ settings: { foreground: "#ccc", background: "#111" } });
    expect(raw.settings.slice(1)).toEqual([
      { scope: "comment", settings: { foreground: "#888", fontStyle: "italic" } },
      { settings: { foreground: "#eee" } },
      { scope: ["keyword", "storage"], settings: {} },
    ]);
  });
});

describe("themeKind", () => {
  it("reads the manifest's uiTheme first, then the theme's type, then the slot", () => {
    expect(themeKind("vs", "dark", "dark")).toBe("light");
    expect(themeKind("hc-light", undefined, "dark")).toBe("light");
    expect(themeKind("vs-dark", "light", "light")).toBe("dark");
    expect(themeKind("hc-black", undefined, "light")).toBe("dark");
    expect(themeKind("nope", "light", "dark")).toBe("light");
    expect(themeKind(undefined, "hc", "light")).toBe("dark");
    expect(themeKind(undefined, "hcLight", "dark")).toBe("light");
    expect(themeKind(undefined, undefined, "dark")).toBe("dark");
    expect(themeKind("", "nope", "light")).toBe("light");
  });

  it("takes a name the object prototype has for an unknown kind", () => {
    expect(themeKind("constructor", "light", "dark")).toBe("light");
    expect(themeKind("toString", undefined, "dark")).toBe("dark");
    expect(themeKind(undefined, "__proto__", "light")).toBe("light");
    expect(themeKind("hasOwnProperty", "valueOf", "dark")).toBe("dark");
    // What the kind is for: the defaults the theme's colours are laid over.
    const kind = themeKind("constructor", "toString", "dark");
    expect(themeVariables({ colors: {} }, kind)["--bg"]).toBe(DEFAULT_VARIABLES.dark["--bg"]);
  });
});
