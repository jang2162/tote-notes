import { describe, expect, it } from "vitest";

import fake from "../backend/fake-registry.json";
import type { ExtensionRegistry, LanguageInfo, ViewerInfo } from "../backend/types";
import { languageLabelFor, Registry } from "./registry";

const bundled = new Registry(fake as ExtensionRegistry);

const lang = (id: string, extension: string, patch: Partial<LanguageInfo> = {}): LanguageInfo => ({
  id,
  extension,
  aliases: [id],
  extensions: [],
  filenames: [],
  firstLine: null,
  configuration: null,
  grammar: null,
  ...patch,
});

const viewer = (id: string, kind: ViewerInfo["kind"], extensions: string[]): ViewerInfo => ({
  extension: `tote.${id}`,
  id,
  kind,
  extensions,
  entry: "viewer.html",
});

describe("Registry.languageForFile", () => {
  it("matches a file name exactly before an extension, case-insensitively for extensions", () => {
    expect(bundled.languageForFile("Makefile")?.id).toBe("makefile");
    expect(bundled.languageForFile("회의.MD")?.id).toBe("markdown");
    expect(bundled.languageForFile("tsconfig.json")?.id).toBe("jsonc");
    expect(bundled.languageForFile("data.json")?.id).toBe("json");
    expect(bundled.languageForFile("Dockerfile")?.id).toBe("dockerfile");
    expect(bundled.languageForFile("noext")).toBeUndefined();
    expect(bundled.languageForFile("x.unknown")).toBeUndefined();
  });

  it("takes the first language that claims the extension — the registry's order is precedence", () => {
    const registry = new Registry({
      extensions: [],
      languages: [
        lang("better-md", "someone.ext", { extensions: ["md"] }),
        lang("markdown", "tote.languages", { extensions: ["md"] }),
      ],
      grammars: [],
      themes: [],
      viewers: [],
      problems: [],
    });
    expect(registry.languageForFile("a.md")?.id).toBe("better-md");
    expect(registry.language("markdown")?.extension).toBe("tote.languages");
  });

  it("lists each id once, sorted by its first alias", () => {
    const registry = new Registry({
      extensions: [],
      languages: [
        lang("markdown", "user.ext", { aliases: ["Markdown"] }),
        lang("markdown", "tote.languages", { aliases: ["Markdown"] }),
        lang("c", "tote.languages", { aliases: ["C"] }),
      ],
      grammars: [],
      themes: [],
      viewers: [],
      problems: [],
    });
    expect(registry.languages.map((l) => [l.id, l.extension])).toEqual([
      ["c", "tote.languages"],
      ["markdown", "user.ext"],
    ]);
  });
});

describe("Registry.viewerFor and themeFor", () => {
  // The bundled viewers arrive with the viewer tasks, so the lookup is checked on a registry
  // that carries test viewers (the fake registry has none yet).
  it("finds a viewer by extension and kind", () => {
    const registry = new Registry({
      ...(fake as ExtensionRegistry),
      viewers: [
        viewer("markdown", "preview", ["md", "markdown"]),
        viewer("media", "primary", ["jpg"]),
      ],
    });
    expect(registry.viewerFor("a.md", "preview")?.id).toBe("markdown");
    expect(registry.viewerFor("a.md", "primary")).toBeUndefined();
    expect(registry.viewerFor("photo.JPG", "primary")?.id).toBe("media");
    expect(registry.viewerFor("doc.pdf", "primary")).toBeUndefined();
    expect(registry.viewerFor("noext", "primary")).toBeUndefined();
  });

  it("resolves a theme reference, else the first theme of the appearance", () => {
    expect(bundled.themeFor({ extension: "tote.themes", label: "Dark+" }, "light")?.label).toBe(
      "Dark+",
    );
    expect(bundled.themeFor(null, "light")?.label).toBe("Light+");
    expect(bundled.themeFor(null, "dark")?.label).toBe("Dark+");
    expect(bundled.themeFor({ extension: "gone.ext", label: "Night" }, "dark")?.label).toBe(
      "Dark+",
    );
  });
});

describe("languageLabelFor", () => {
  it("prefers the alias, then the id, then the upper-cased extension, then 텍스트", () => {
    expect(languageLabelFor(lang("python", "e", { aliases: ["Python", "py"] }), "a.py")).toBe(
      "Python",
    );
    expect(languageLabelFor(lang("python", "e", { aliases: [] }), "a.py")).toBe("python");
    expect(languageLabelFor(undefined, "a.xyz")).toBe("XYZ");
    expect(languageLabelFor(undefined, "noext")).toBe("텍스트");
  });
});
