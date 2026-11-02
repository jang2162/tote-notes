import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { defaultFakeData, FakeBackend, memoryStorage } from "../backend/fake";
import type { ExtensionRegistry, ThemeInfo } from "../backend/types";
import { Registry } from "../extensions/registry";
import { contrastRatio } from "./contrast";
import { applyToDocument, ThemeManager, type ActiveTheme } from "./manager";
import { DEFAULT_VARIABLES, loadTheme, themeKind, themeVariables } from "./vscode-theme";

const summary = (id: string, source: "bundled" | "user") => ({
  id,
  version: "1.0.0",
  displayName: id,
  source,
  enabled: true,
  path: `/x/${id}`,
});

/** In the order Rust builds it by default (precedence 「user」): the user's extension first. */
const registry = new Registry({
  extensions: [summary("someone.night", "user"), summary("tote.themes", "bundled")],
  languages: [],
  grammars: [],
  themes: [
    { extension: "someone.night", label: "Night", uiTheme: "vs-dark", path: "night.json" },
    { extension: "someone.night", label: "Day", uiTheme: "vs", path: "day.json" },
    { extension: "tote.themes", label: "Light+", uiTheme: "vs", path: "themes/light.json" },
    { extension: "tote.themes", label: "Dark+", uiTheme: "vs-dark", path: "themes/dark.json" },
  ],
  viewers: [],
  problems: [],
} as ExtensionRegistry);

function media(dark: boolean) {
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  return {
    query: {
      matches: dark,
      addEventListener: (_: "change", fn: (e: { matches: boolean }) => void) =>
        void listeners.push(fn),
    },
    flip(toDark: boolean) {
      this.query.matches = toDark;
      for (const fn of listeners) fn({ matches: toDark });
    },
  };
}

function setup(dark: boolean) {
  const backend = new FakeBackend(
    memoryStorage(
      JSON.stringify({
        ...defaultFakeData(),
        extensionFiles: {
          "tote.themes/themes/light.json": `{ "colors": { "editor.background": "#ffffff" }, "tokenColors": [] }`,
          "tote.themes/themes/dark.json": `{ "colors": { "editor.background": "#1e1e1e" }, "tokenColors": [] }`,
          "someone.night/night.json": `{ "colors": { "editor.background": "#000000" } }`,
          "someone.night/day.json": `{ "colors": { "editor.background": "#fffff0" } }`,
        },
      }),
    ),
  );
  const applied: ActiveTheme[] = [];
  const m = media(dark);
  const manager = new ThemeManager(backend, () => registry, {
    media: m.query,
    apply: (a) => void applied.push(a),
  });
  return { backend, manager, applied, media: m };
}

describe("ThemeManager", () => {
  it("picks the theme for the OS appearance and follows a change", async () => {
    const { manager, applied, media } = setup(false);
    await manager.start();
    expect(manager.active.info?.label).toBe("Light+");
    expect(manager.active.variables["--bg"]).toBe("#ffffff");
    expect(applied).toHaveLength(1);
    media.flip(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.active.info?.label).toBe("Dark+");
    expect(manager.active.variables["--bg"]).toBe("#1e1e1e");
    expect(manager.active.appearance).toBe("dark");
  });

  it("draws the default theme of the appearance, whatever theme a slot of the settings names", async () => {
    const { backend, manager, media } = setup(true);
    // What an older build saved for each appearance (spec 「테마」: kept in the file, not read).
    Object.assign(backend.data.settings.theme, {
      light: { extension: "someone.night", label: "Night" },
      dark: { extension: "someone.night", label: "Night" },
    });
    await manager.start();
    expect(manager.active.info?.label).toBe("Dark+");
    expect(manager.active.variables["--bg"]).toBe("#1e1e1e");
    media.flip(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.active.info?.label).toBe("Light+");
    await backend.patchSettings({ themeMode: "dark" });
    await manager.refresh();
    expect(manager.active.info?.label).toBe("Dark+");
  });

  it("draws the bundled theme of the appearance though a user extension's theme comes first", async () => {
    const { backend, manager, media } = setup(true);
    await manager.start();
    expect(manager.active.info?.label).toBe("Dark+");
    expect(manager.active.variables["--bg"]).toBe("#1e1e1e");
    media.flip(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.active.info?.label).toBe("Light+");
    expect(manager.active.variables["--bg"]).toBe("#ffffff");
    await backend.patchSettings({ themeMode: "dark" });
    await manager.refresh();
    expect(manager.active.info?.label).toBe("Dark+");
  });

  it("keeps the appearance the mode names whatever the OS appearance, and follows it again on auto", async () => {
    const { backend, manager, media } = setup(false);
    backend.data.settings.theme.mode = "dark";
    await manager.start();
    expect(manager.active.info?.label).toBe("Dark+");
    expect(manager.active.appearance).toBe("dark");
    expect(manager.active.kind).toBe("dark");
    media.flip(true);
    media.flip(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.active.info?.label).toBe("Dark+");

    await backend.patchSettings({ themeMode: "light" });
    media.flip(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.active.info?.label).toBe("Light+");
    expect(manager.active.appearance).toBe("light");

    await backend.patchSettings({ themeMode: "auto" });
    await manager.refresh();
    expect(manager.active.info?.label).toBe("Dark+");
    media.flip(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.active.info?.label).toBe("Light+");
  });

  it("falls back to the defaults when the theme file cannot be read", async () => {
    const { backend, manager } = setup(true);
    delete backend.data.extensionFiles["tote.themes/themes/dark.json"];
    await manager.start();
    expect(manager.active.theme).toBeNull();
    expect(manager.active.variables["--bg"]).toBe("#1e1f22");
  });
});

describe("ThemeManager failures and races", () => {
  it("applies the defaults and does not throw when settings() rejects", async () => {
    const { backend, manager, applied } = setup(true);
    backend.settings = () => Promise.reject(new Error("no settings"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(manager.start()).resolves.toBeUndefined();
    error.mockRestore();
    expect(applied).toHaveLength(1);
    expect(manager.active.theme).toBeNull();
    expect(manager.active.variables["--bg"]).toBe("#1e1f22");
  });

  it("lets the newer refresh win when an older one finishes later", async () => {
    const { backend, manager, applied } = setup(true);
    await manager.start();
    const gate: { release: () => void } = { release: () => {} };
    const slow = new Promise<void>((r) => (gate.release = r));
    const read = backend.readExtensionFile.bind(backend);
    let first = true;
    backend.readExtensionFile = async (ext, path) => {
      if (first) {
        first = false;
        await slow;
      }
      return read(ext, path);
    };
    const older = manager.refresh(); // blocks on the slow read of Dark+
    backend.data.settings.theme.mode = "light";
    await manager.refresh(); // newer, reads Light+ at once
    gate.release();
    await older;
    expect(manager.active.info?.label).toBe("Light+");
    expect(applied.map((a) => a.info?.label)).toEqual(["Dark+", "Light+"]);
  });
});

/** The bundled themes as the registry lists them, and their files, read from the bundle. */
const BUNDLED = new URL("../../src-tauri/resources/extensions/tote.themes/", import.meta.url);
const bundled: { themes: ThemeInfo[]; files: Record<string, string> } = (() => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", BUNDLED), "utf8")) as {
    contributes: { themes: { label: string; uiTheme: string; path: string }[] };
  };
  const themes = manifest.contributes.themes.map((t) => ({
    extension: "tote.themes",
    label: t.label,
    uiTheme: t.uiTheme,
    path: t.path.replace(/^\.\//, ""),
  }));
  const files = Object.fromEntries(
    themes.map((t) => [`tote.themes/${t.path}`, readFileSync(new URL(t.path, BUNDLED), "utf8")]),
  );
  return { themes, files };
})();

describe("ThemeManager with the bundled themes", () => {
  /** Texts and what they sit on, each at least 4.5:1 (spec 「색」 · 대비 기준). */
  const TEXTS: [string, string, string][] = [
    ["--fg", "--input-bg", "text in the find field"],
    ["--muted", "--input-bg", "placeholder and count in the find field"],
    ["--fg", "--panel-bg", "the find bar's buttons"],
    ["--muted", "--panel-bg", "the find bar's idle toggles"],
    ["--fg", "--sidebar-bg", "the memo names in the sidebar"],
    ["--muted", "--sidebar-bg", "secondary text in the sidebar"],
    ["--fg", "--bg", "the editor's text"],
    ["--muted", "--bg", "secondary text on the page"],
  ];

  const unreadable = (v: Record<string, string>) =>
    TEXTS.map(([fg, bg, what]) => ({
      what,
      ratio: Math.round(contrastRatio(v[fg], v[bg]) * 100) / 100,
    })).filter((r) => r.ratio < 4.5);

  for (const mode of ["light", "dark"] as const) {
    it(`the ${mode} mode's theme keeps every text readable`, async () => {
      const backend = new FakeBackend(
        memoryStorage(JSON.stringify({ ...defaultFakeData(), extensionFiles: bundled.files })),
      );
      backend.data.settings.theme.mode = mode;
      const manager = new ThemeManager(
        backend,
        () => new Registry({ ...registry.data, themes: bundled.themes }),
        { media: media(mode !== "dark").query, apply: () => {} },
      );
      await manager.start();
      expect(manager.active.info?.label).toBe(mode === "dark" ? "Dark+" : "Light+");
      expect(unreadable(manager.active.variables)).toEqual([]);
    });
  }

  // Whichever appearance it is drawn in: a theme the picker offers later (spec 「테마」) may sit
  // in either.
  for (const info of bundled.themes) {
    for (const appearance of ["light", "dark"] as const) {
      it(`${info.label} drawn in the ${appearance} appearance keeps every text readable`, async () => {
        const theme = await loadTheme(
          async (path) => bundled.files[`tote.themes/${path}`],
          info.path,
        );
        const kind = themeKind(info.uiTheme, theme.type, appearance);
        expect(unreadable(themeVariables(theme, kind))).toEqual([]);
      });
    }
  }

  it("takes the colours a theme leaves out from its kind, not from the appearance", async () => {
    const info = bundled.themes.find((t) => t.label === "Light+")!;
    const theme = await loadTheme(async (path) => bundled.files[`tote.themes/${path}`], info.path);
    const kind = themeKind(info.uiTheme, theme.type, "dark");
    expect(kind).toBe("light");
    const variables = themeVariables(theme, kind);
    expect(variables["--input-bg"]).toBe(DEFAULT_VARIABLES.light["--input-bg"]);
    expect(variables["--sidebar-bg"]).toBe(DEFAULT_VARIABLES.light["--sidebar-bg"]);
  });
});

describe("applyToDocument", () => {
  it("draws the page as the theme's kind, not the appearance it was picked for", () => {
    const properties: Record<string, string> = {};
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        colorScheme: "",
        setProperty: (name: string, value: string) => void (properties[name] = value),
      },
    };
    vi.stubGlobal("document", { documentElement: root });
    try {
      // Light+ in the dark appearance.
      applyToDocument({
        info: null,
        theme: null,
        appearance: "dark",
        kind: "light",
        variables: { "--bg": "#ffffff" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.appearance).toBe("light");
    expect(properties).toEqual({ "--bg": "#ffffff" });
  });
});
