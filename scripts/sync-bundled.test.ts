import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_LICENSES,
  EXTRA_GRAMMARS,
  LANGUAGES,
  THEMES,
  VENDOR_GRAMMARS,
} from "./bundled-languages.ts";
import {
  checkLicense,
  fakeRegistry,
  inlineViewer,
  vendorFiles,
  languageConfiguration,
  licenseTextFor,
  licensesMarkdown,
  manifestFor,
  parseNotice,
  readVendored,
  VENDOR_DIR,
} from "./sync-bundled.ts";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
// The packages' exports map hides NOTICE, so it is found next to a file the map does expose.
const grammarsNotice = () =>
  readFileSync(
    join(dirname(require.resolve("tm-grammars/grammars/markdown.json")), "../NOTICE"),
    "utf8",
  );

describe("parseNotice", () => {
  it("splits the NOTICE into blocks with files, url, spdx and the full text", () => {
    const blocks = parseNotice(grammarsNotice());
    const vscode = blocks.find((b) => b.files.includes("markdown.json"))!;
    expect(vscode.spdx).toBe("MIT");
    expect(vscode.url).toBe("https://raw.githubusercontent.com/microsoft/vscode/main/LICENSE.txt");
    expect(vscode.text).toContain("Copyright (c) 2015 - present Microsoft Corporation");
    expect(vscode.text).toContain("Permission is hereby granted, free of charge");
    expect(vscode.files).toContain("cpp-macro.json");
  });
  it("gives every tm-grammars grammar a text: NOTICE for most, the override for yaml and toml", () => {
    const blocks = parseNotice(grammarsNotice());
    const vendored = new Set(VENDOR_GRAMMARS.map((v) => v.name));
    for (const lang of LANGUAGES.filter((l) => l.grammar && !vendored.has(l.grammar)))
      expect(licenseTextFor(lang.grammar!, blocks, lang.license).length).toBeGreaterThan(100);
    expect(
      licenseTextFor("yaml", blocks, LANGUAGES.find((l) => l.id === "yaml")!.license),
    ).toContain("Permission to copy, use, modify, sell and distribute");
    expect(() => licenseTextFor("no-such-grammar", blocks)).toThrow(/no license text/);
  });
  it("writes each distinct text once, headed by the names that use it", () => {
    const md = licensesMarkdown("t", [
      { name: "a", spdx: "MIT", url: "u", note: "", text: "TEXT-1" },
      { name: "b", spdx: "MIT", url: "u", note: "", text: "TEXT-1" },
      { name: "c", spdx: "textmate-bundle", url: "v", note: "n", text: "TEXT-2" },
    ]);
    expect(md.split("TEXT-1").length).toBe(2);
    expect(md).toMatch(/## a, b\n\nTEXT-1/);
    expect(md).toMatch(/## c\n\nTEXT-2/);
  });
});

describe("the selection table", () => {
  it("covers the spec's language list and names a grammar tm-grammars or the vendored set has", async () => {
    const { grammars, injections } = await import("tm-grammars");
    const names = new Set([...grammars, ...injections].map((g) => g.name));
    const ids = LANGUAGES.map((l) => l.id);
    for (const wanted of [
      "markdown",
      "plaintext",
      "shellscript",
      "json",
      "jsonc",
      "yaml",
      "toml",
      "ini",
      "dotenv",
      "javascript",
      "typescript",
      "python",
      "html",
      "css",
      "xml",
      "sql",
      "go",
      "rust",
      "java",
      "c",
      "cpp",
      "diff",
      "dockerfile",
      "makefile",
      "kotlin",
      "swift",
      "ruby",
      "lua",
      "csharp",
      "csv",
      "tsv",
      "php",
      "caddyfile",
      "jsp",
    ]) {
      expect(ids).toContain(wanted);
    }
    const vendored = new Set(VENDOR_GRAMMARS.map((v) => v.name));
    const known = (name: string) => names.has(name) || vendored.has(name);
    for (const lang of LANGUAGES) if (lang.grammar) expect(known(lang.grammar)).toBe(true);
    for (const extra of EXTRA_GRAMMARS) expect(known(extra)).toBe(true);
    // A vendored name never hides a tm-grammars one: the grammar file names would collide.
    for (const name of vendored) expect(names.has(name)).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lets no two languages claim the same extension or file name", () => {
    const owners = new Map<string, string[]>();
    for (const lang of LANGUAGES)
      for (const key of [
        ...lang.extensions.map((e) => `extension ${e.toLowerCase()}`),
        ...(lang.filenames ?? []).map((name) => `file name ${name}`),
      ])
        owners.set(key, [...(owners.get(key) ?? []), lang.id]);
    expect([...owners].filter(([, ids]) => ids.length > 1)).toEqual([]);
  });
});

describe("checkLicense", () => {
  it("takes the metadata's license when it is allowed and the table's note when it is missing", () => {
    expect(
      checkLicense("json", { license: "MIT", licenseUrl: "https://x/LICENSE" }, undefined),
    ).toEqual({
      name: "json",
      spdx: "MIT",
      url: "https://x/LICENSE",
      note: "",
    });
    expect(
      checkLicense(
        "yaml",
        {},
        { spdx: "textmate-bundle", url: "https://y", note: "Permission to copy…" },
      ),
    ).toEqual({
      name: "yaml",
      spdx: "textmate-bundle",
      url: "https://y",
      note: "Permission to copy…",
    });
  });

  it("refuses a missing or disallowed license", () => {
    expect(() =>
      checkLicense("ada", { license: "GPL-3.0", licenseUrl: "https://g" }, undefined),
    ).toThrow(/GPL-3.0/);
    expect(() => checkLicense("mystery", {}, undefined)).toThrow(/mystery/);
    expect(ALLOWED_LICENSES).toContain("MIT");
  });
});

describe("readVendored", () => {
  const grammar = '{"scopeName": "source.x", "patterns": []}\n';
  const vendor = {
    name: "x",
    source: "https://example.com/x.json",
    sha256: createHash("sha256").update(grammar).digest("hex"),
    license: { spdx: "MIT", url: "https://example.com/LICENSE" },
    note: "a note",
  };
  const dirWith = (text: string, license = "MIT License\n\nCopyright (c) someone\n") => {
    const dir = mkdtempSync(join(tmpdir(), "vendor-"));
    writeFileSync(join(dir, "x.json"), text);
    writeFileSync(join(dir, "x.LICENSE.txt"), license);
    return dir;
  };

  it("reads the grammar's scope, its text as fetched and its license file", () => {
    const read = readVendored(vendor, dirWith(grammar));
    expect(read.scopeName).toBe("source.x");
    expect(read.text).toBe(grammar);
    expect(read.license).toEqual({
      name: "x",
      spdx: "MIT",
      url: "https://example.com/LICENSE",
      note: "a note",
      text: "MIT License\n\nCopyright (c) someone",
    });
  });

  it("refuses a copy that is not the file fetched, reformatted or edited", () => {
    expect(() =>
      readVendored(vendor, dirWith('{ "scopeName": "source.x", "patterns": [] }\n')),
    ).toThrow(/not the one fetched from https:\/\/example.com\/x.json/);
  });

  it("refuses a license outside the allowed list", () => {
    expect(() =>
      readVendored({ ...vendor, license: { spdx: "GPL-3.0", url: "https://g" } }, dirWith(grammar)),
    ).toThrow(/GPL-3.0/);
  });

  it("finds every vendored grammar as fetched, and nothing in the folder the table leaves out", () => {
    for (const v of VENDOR_GRAMMARS) {
      const read = readVendored(v);
      expect(read.license.text).toContain("Permission is hereby granted");
      expect(v.source).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+\/[0-9a-f]{40}\//);
      expect(v.license.url).toMatch(/\/[0-9a-f]{40}\//);
    }
    const expected = VENDOR_GRAMMARS.flatMap((v) => [`${v.name}.json`, `${v.name}.LICENSE.txt`]);
    expect(
      readdirSync(VENDOR_DIR)
        .filter((f) => f !== "README.md")
        .sort(),
    ).toEqual(expected.sort());
  });
});

describe("languageConfiguration and manifestFor", () => {
  it("turns the table row into VS Code's language-configuration shape", () => {
    const config = languageConfiguration({
      id: "sql",
      aliases: ["SQL"],
      grammar: "sql",
      extensions: ["sql"],
      comments: { line: "--", block: ["/*", "*/"] },
    });
    expect(config).toEqual({
      comments: { lineComment: "--", blockComment: ["/*", "*/"] },
      brackets: [
        ["(", ")"],
        ["[", "]"],
        ["{", "}"],
      ],
      autoClosingPairs: [
        { open: "(", close: ")" },
        { open: "[", close: "]" },
        { open: "{", close: "}" },
        { open: '"', close: '"', notIn: ["string"] },
        { open: "'", close: "'", notIn: ["string", "comment"] },
      ],
    });
  });

  it("writes one language and one grammar contribution per row, extras without a language", () => {
    const manifest = manifestFor(
      [
        { id: "plaintext", aliases: ["Plain Text"], grammar: null, extensions: ["txt"] },
        { id: "c", aliases: ["C"], grammar: "c", extensions: ["c", "h"], firstLine: "^#!" },
      ],
      ["cpp-macro"],
      { c: "source.c", "cpp-macro": "source.cpp.embedded.macro" },
    );
    expect(manifest.name).toBe("languages");
    expect(manifest.publisher).toBe("tote");
    expect(manifest.contributes.languages).toEqual([
      {
        id: "plaintext",
        aliases: ["Plain Text"],
        extensions: [".txt"],
        filenames: [],
        configuration: "./language-configuration/plaintext.json",
      },
      {
        id: "c",
        aliases: ["C"],
        extensions: [".c", ".h"],
        filenames: [],
        firstLine: "^#!",
        configuration: "./language-configuration/c.json",
      },
    ]);
    expect(manifest.contributes.grammars).toEqual([
      { language: "c", scopeName: "source.c", path: "./grammars/c.json" },
      { scopeName: "source.cpp.embedded.macro", path: "./grammars/cpp-macro.json" },
    ]);
  });
});

describe("inlineViewer", () => {
  it("inlines vendor scripts and locks the CSP to the hashes of every inline script", () => {
    const template = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src __SCRIPT_HASHES__"><script>/*__INLINE:lib__*/</script><script>main()</script>`;
    const html = inlineViewer(template, { lib: "var lib = 1;" });
    expect(html).toContain("<script>var lib = 1;</script>");
    expect(html).not.toContain("__INLINE");
    const hashes = html.match(/'sha256-[A-Za-z0-9+/=]+'/g) ?? [];
    expect(hashes).toHaveLength(2);
    expect(html).not.toContain("__SCRIPT_HASHES__");
  });

  it("refuses a template that still has a placeholder after inlining", () => {
    expect(() => inlineViewer("<script>__INLINE: marked__;</script>", {})).toThrow(/__INLINE/);
  });

  it("refuses a vendor file that would end the inline script", () => {
    expect(() =>
      inlineViewer("<script>/*__INLINE:lib__*/</script>", { lib: "a</script>b" }),
    ).toThrow(/<\/script/);
  });

  it("refuses a template that names a vendor it was not given", () => {
    expect(() => inlineViewer("<script>/*__INLINE:nope__*/</script>", {})).toThrow(/nope/);
  });
});

describe("the generated viewers", () => {
  it("are what inlineViewer makes of their templates now (run pnpm sync:bundled when this fails)", () => {
    for (const id of ["tote.markdown-preview", "tote.media-viewer"]) {
      const dir = `src-tauri/resources/extensions/${id}`;
      expect(read(`${dir}/viewer.html`)).toBe(
        inlineViewer(read(`${dir}/viewer.template.html`), vendorFiles()),
      );
    }
  });
});

describe("the generated files", () => {
  it("are what the generator makes now (run pnpm sync:bundled when this fails)", async () => {
    const { grammars, injections } = await import("tm-grammars");
    const scopes: Record<string, string> = {};
    for (const g of [...grammars, ...injections]) scopes[g.name] = g.scopeName;
    for (const v of VENDOR_GRAMMARS) scopes[v.name] = readVendored(v).scopeName;
    const manifest = JSON.parse(read("src-tauri/resources/extensions/tote.languages/package.json"));
    expect(manifest).toEqual(manifestFor(LANGUAGES, EXTRA_GRAMMARS, scopes));
    for (const name of [
      ...LANGUAGES.flatMap((l) => (l.grammar ? [l.grammar] : [])),
      ...EXTRA_GRAMMARS,
    ])
      expect(read(`src-tauri/resources/extensions/tote.languages/grammars/${name}.json`)).toBe(
        VENDOR_GRAMMARS.some((v) => v.name === name)
          ? readFileSync(join(VENDOR_DIR, `${name}.json`), "utf8")
          : readFileSync(require.resolve(`tm-grammars/grammars/${name}.json`), "utf8"),
      );
    for (const lang of LANGUAGES)
      expect(
        JSON.parse(
          read(
            `src-tauri/resources/extensions/tote.languages/language-configuration/${lang.id}.json`,
          ),
        ),
      ).toEqual(languageConfiguration(lang));
    for (const theme of THEMES)
      expect(read(`src-tauri/resources/extensions/tote.themes/themes/${theme.name}.json`)).toBe(
        readFileSync(require.resolve(`tm-themes/themes/${theme.name}.json`), "utf8"),
      );
    expect(manifest.contributes.languages).toHaveLength(LANGUAGES.length);
    expect(manifest.contributes.grammars).toHaveLength(
      LANGUAGES.filter((l) => l.grammar).length + EXTRA_GRAMMARS.length,
    );
    for (const lang of LANGUAGES) {
      expect(() =>
        read(
          `src-tauri/resources/extensions/tote.languages/language-configuration/${lang.id}.json`,
        ),
      ).not.toThrow();
      if (lang.grammar) {
        const grammar = JSON.parse(
          read(`src-tauri/resources/extensions/tote.languages/grammars/${lang.grammar}.json`),
        );
        expect(typeof grammar.scopeName).toBe("string");
      }
    }
    const licenses = read("src-tauri/resources/extensions/tote.languages/LICENSES.md");
    for (const lang of LANGUAGES)
      if (lang.grammar) expect(licenses).toContain(`| ${lang.grammar} |`);
    for (const extra of EXTRA_GRAMMARS) expect(licenses).toContain(`| ${extra} |`);
    // The vendored grammars carry their own license files, not the tm-grammars NOTICE.
    expect(licenses).toContain("Copyright (c) 2023 Matthew Penner");
    expect(licenses).toContain("Copyright (c) 2017 Patrik Thorsson");
    for (const id of ["tote.languages", "tote.themes", "tote.markdown-preview"])
      expect(read(`src-tauri/resources/extensions/${id}/LICENSES.md`)).toContain("Copyright");
    const themes = JSON.parse(read("src-tauri/resources/extensions/tote.themes/package.json"));
    expect(themes.contributes.themes.map((t: { label: string }) => t.label)).toEqual(
      THEMES.map((t) => t.label),
    );
    for (const theme of THEMES) {
      const json = JSON.parse(
        read(`src-tauri/resources/extensions/tote.themes/themes/${theme.name}.json`),
      );
      expect(json.colors["editor.background"]).toMatch(/^#/);
      expect(Array.isArray(json.tokenColors)).toBe(true);
    }
    const fake = JSON.parse(read("src/backend/fake-registry.json"));
    expect(fake.extensions.map((e: { id: string }) => e.id)).toContain("tote.languages");
    expect(fake.languages.find((l: { id: string }) => l.id === "markdown").grammar.scopeName).toBe(
      "text.html.markdown",
    );
    expect(fake.themes).toHaveLength(THEMES.length);
    expect(
      fake.grammars.some((g: { scopeName: string }) => g.scopeName === "source.cpp.embedded.macro"),
    ).toBe(true);
    expect(fake.problems).toEqual([]);
  });

  it("match the fake registry built from the committed manifests", () => {
    const fake = JSON.parse(read("src/backend/fake-registry.json"));
    const manifests = fake.extensions.map((e: { id: string }) =>
      JSON.parse(read(`src-tauri/resources/extensions/${e.id}/package.json`)),
    );
    expect(fakeRegistry(manifests)).toEqual(fake);
  });
});
