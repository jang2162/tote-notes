import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { defaultFakeData, FakeBackend, memoryStorage } from "../backend/fake";
import type { ExtensionRegistry, ThemeInfo } from "../backend/types";
import { Registry } from "../extensions/registry";
import { contrastRatio } from "./contrast";
import { applyToDocument, ThemeManager, type ActiveTheme } from "./manager";
import { DEFAULT_VARIABLES } from "./vscode-theme";

const registry = new Registry({
  extensions: [],
  languages: [],
  grammars: [],
  themes: [
    { extension: "tote.themes", label: "Light+", uiTheme: "vs", path: "themes/light.json" },
    { extension: "tote.themes", label: "Dark+", uiTheme: "vs-dark", path: "themes/dark.json" },
    { extension: "someone.night", label: "Night", uiTheme: "vs-dark", path: "night.json" },
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

  it("uses the configured theme and re-reads it when the settings change", async () => {
    const { backend, manager, media } = setup(true);
    await manager.start();
    expect(manager.active.info?.label).toBe("Dark+");
    const changes: string[] = [];
    manager.onChange((a) => void changes.push(a.info?.label ?? "none"));
    backend.data.settings.theme.dark = { extension: "someone.night", label: "Night" };
    await manager.refresh();
    expect(manager.active.info?.label).toBe("Night");
    expect(manager.active.variables["--bg"]).toBe("#000000");
    expect(changes).toEqual(["Night"]);
    media.flip(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(changes).toEqual(["Night", "Light+"]);
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
    backend.data.settings.theme.dark = { extension: "tote.themes", label: "Dark+" };
    const older = manager.refresh(); // blocks on the slow read
    backend.data.settings.theme.dark = { extension: "someone.night", label: "Night" };
    await manager.refresh(); // newer, reads Night at once
    gate.release();
    await older;
    expect(manager.active.info?.label).toBe("Night");
    expect(applied.map((a) => a.info?.label)).toEqual(["Dark+", "Night"]);
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

  for (const info of bundled.themes) {
    for (const slot of ["light", "dark"] as const) {
      it(`${info.label} in the ${slot} slot keeps every text readable`, async () => {
        const backend = new FakeBackend(
          memoryStorage(JSON.stringify({ ...defaultFakeData(), extensionFiles: bundled.files })),
        );
        backend.data.settings.theme[slot] = { extension: info.extension, label: info.label };
        const manager = new ThemeManager(
          backend,
          () => new Registry({ ...registry.data, themes: bundled.themes }),
          { media: media(slot === "dark").query, apply: () => {} },
        );
        await manager.start();
        expect(manager.active.info?.label).toBe(info.label);
        expect(manager.active.appearance).toBe(slot);
        const v = manager.active.variables;
        const ratios = TEXTS.map(([fg, bg, what]) => ({
          what,
          ratio: Math.round(contrastRatio(v[fg], v[bg]) * 100) / 100,
        }));
        expect(ratios.filter((r) => r.ratio < 4.5)).toEqual([]);
      });
    }
  }

  it("takes the colours a theme leaves out from its kind, not from the slot", async () => {
    const backend = new FakeBackend(
      memoryStorage(JSON.stringify({ ...defaultFakeData(), extensionFiles: bundled.files })),
    );
    backend.data.settings.theme.dark = { extension: "tote.themes", label: "Light+" };
    const manager = new ThemeManager(
      backend,
      () => new Registry({ ...registry.data, themes: bundled.themes }),
      { media: media(true).query, apply: () => {} },
    );
    await manager.start();
    expect(manager.active.kind).toBe("light");
    expect(manager.active.variables["--input-bg"]).toBe(DEFAULT_VARIABLES.light["--input-bg"]);
    expect(manager.active.variables["--sidebar-bg"]).toBe(DEFAULT_VARIABLES.light["--sidebar-bg"]);
  });
});

describe("applyToDocument", () => {
  it("draws the page as the theme's kind, not the slot it was picked for", () => {
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
      // Light+ in the dark slot.
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
