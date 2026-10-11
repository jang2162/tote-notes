/** Rebuilds the bundled extensions from their npm sources. Run it whenever bundled-languages.ts,
 * a viewer template or a vendor version changes: `pnpm sync:bundled`. The outputs are committed
 * so that cargo tests, the browser preview and the app see one and the same set. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_LICENSES,
  EXTRA_GRAMMARS,
  LANGUAGES,
  THEMES,
  type BundledLanguage,
} from "./bundled-languages.ts";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS_DIR = join(ROOT, "src-tauri/resources/extensions");
const FAKE_REGISTRY = join(ROOT, "src/backend/fake-registry.json");

interface LicenseMeta {
  license?: string;
  licenseUrl?: string;
}

export interface LicenseRow {
  name: string;
  spdx: string;
  url: string;
  note: string;
  /** The full license text, which MIT and its kin require every copy to carry. */
  text: string;
}

export interface NoticeBlock {
  files: string[];
  url: string;
  spdx: string;
  text: string;
}

/** Splits a tm-grammars / tm-themes NOTICE into its per-license blocks. A block is
 * `Files: … / License: <url> / SPDX: <id> / <long dashes> / <text>`, blocks are cut at the long
 * `====` lines, and the preamble (no `Files:`) is dropped. */
export function parseNotice(text: string): NoticeBlock[] {
  const blocks: NoticeBlock[] = [];
  for (const chunk of text.split(/^={20,}\s*$/m)) {
    const files = /^Files:[ \t]*(.+)$/m.exec(chunk);
    if (!files) continue;
    const dash = /^-{20,}\s*$/m.exec(chunk);
    if (!dash) throw new Error(`NOTICE block for ${files[1]} has no dashed line before its text`);
    blocks.push({
      files: files[1].split(",").map((f) => f.trim()),
      url: /^License:[ \t]*(.+)$/m.exec(chunk)?.[1].trim() ?? "",
      spdx: /^SPDX:[ \t]*(.+)$/m.exec(chunk)?.[1].trim() ?? "",
      text: chunk.slice(dash.index + dash[0].length).trim(),
    });
  }
  return blocks;
}

/** The license text of one grammar or theme: its NOTICE block, else the table's own text. */
export function licenseTextFor(
  name: string,
  blocks: NoticeBlock[],
  override?: BundledLanguage["license"],
): string {
  const block = blocks.find((b) => b.files.includes(`${name}.json`));
  const text = block?.text ?? override?.note;
  if (!text) throw new Error(`${name}: no license text in NOTICE or bundled-languages.ts`);
  return text;
}

export function checkLicense(
  name: string,
  meta: LicenseMeta,
  override: BundledLanguage["license"],
): Omit<LicenseRow, "text"> {
  const spdx = meta.license ?? override?.spdx;
  const url = meta.licenseUrl ?? override?.url;
  if (!spdx || !url)
    throw new Error(
      `${name}: no license recorded — add one to bundled-languages.ts after reading the source`,
    );
  if (!ALLOWED_LICENSES.includes(spdx))
    throw new Error(`${name}: license ${spdx} is not in the allowed list`);
  return { name, spdx, url, note: meta.license ? "" : (override?.note ?? "") };
}

export function languageConfiguration(lang: BundledLanguage): object {
  const comments: Record<string, unknown> = {};
  if (lang.comments?.line) comments.lineComment = lang.comments.line;
  if (lang.comments?.block) comments.blockComment = lang.comments.block;
  return {
    comments,
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
  };
}

export function manifestFor(
  languages: BundledLanguage[],
  extras: string[],
  scopes: Record<string, string>,
) {
  return {
    name: "languages",
    publisher: "tote",
    version: "1.0.0",
    displayName: "tote 기본 언어 묶음",
    contributes: {
      languages: languages.map((lang) => ({
        id: lang.id,
        aliases: lang.aliases,
        extensions: lang.extensions.map((e) => `.${e}`),
        filenames: lang.filenames ?? [],
        ...(lang.firstLine ? { firstLine: lang.firstLine } : {}),
        configuration: `./language-configuration/${lang.id}.json`,
      })),
      grammars: [
        ...languages
          .filter((lang) => lang.grammar)
          .map((lang) => ({
            language: lang.id,
            scopeName: scopes[lang.grammar!],
            path: `./grammars/${lang.grammar}.json`,
          })),
        ...extras.map((name) => ({ scopeName: scopes[name], path: `./grammars/${name}.json` })),
      ],
    },
  };
}

/** Fills the comment placeholder `__INLINE:<name>__` (slash-star … star-slash, which the
 * formatter leaves alone) with the vendor file's text and `__SCRIPT_HASHES__` with the
 * sha256 CSP sources of every inline script — the page then runs exactly those scripts. */
export function inlineViewer(template: string, vendor: Record<string, string>): string {
  let html = template.replace(/\/\*__INLINE:([\w-]+)__\*\//g, (_m, name: string) => {
    const text = vendor[name];
    if (text === undefined)
      throw new Error(`viewer template asks for a vendor file it was not given: ${name}`);
    if (/<\/script/i.test(text))
      throw new Error(`vendor file ${name} contains </script, which would end the inline script`);
    return text;
  });
  if (html.includes("__INLINE"))
    throw new Error(
      "viewer template still has an __INLINE placeholder inlineViewer could not read",
    );
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    hashes.push(`'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  }
  html = html.replace("__SCRIPT_HASHES__", hashes.join(" "));
  return html;
}

type Manifest = {
  name: string;
  publisher: string;
  version: string;
  displayName?: string;
  contributes?: {
    languages?: {
      id: string;
      aliases?: string[];
      extensions?: string[];
      filenames?: string[];
      firstLine?: string;
      configuration?: string;
    }[];
    grammars?: {
      language?: string;
      scopeName: string;
      path: string;
      embeddedLanguages?: Record<string, string>;
    }[];
    themes?: { label: string; uiTheme?: string; path: string }[];
  };
  tote?: {
    viewers?: { id: string; kind: "primary" | "preview"; extensions?: string[]; entry: string }[];
  };
};

const rel = (path: string) => path.replace(/^\.\//, "");

/** The registry shaped like the one Rust builds (extensions/registry.rs), made from the committed
 * manifests: the fake backend serves it so the browser preview sees the same languages and
 * viewers. Nothing here runs the Rust scanner. */
export function fakeRegistry(manifests: Manifest[]) {
  const id = (m: Manifest) => `${m.publisher}.${m.name}`;
  return {
    extensions: manifests.map((m) => ({
      id: id(m),
      version: m.version,
      displayName: m.displayName ?? m.name,
      source: "bundled",
      enabled: true,
      path: `/bundled/${id(m)}`,
    })),
    languages: manifests.flatMap((m) =>
      (m.contributes?.languages ?? []).map((lang) => {
        const grammar = (m.contributes?.grammars ?? []).find((g) => g.language === lang.id);
        return {
          id: lang.id,
          extension: id(m),
          aliases: lang.aliases ?? [],
          extensions: lang.extensions?.map((e) => e.replace(/^\./, "").toLowerCase()) ?? [],
          filenames: lang.filenames ?? [],
          firstLine: lang.firstLine ?? null,
          configuration: lang.configuration ? rel(lang.configuration) : null,
          grammar: grammar
            ? {
                scopeName: grammar.scopeName,
                path: rel(grammar.path),
                embeddedLanguages: grammar.embeddedLanguages ?? {},
              }
            : null,
        };
      }),
    ),
    grammars: manifests.flatMap((m) =>
      (m.contributes?.grammars ?? []).map((g) => ({
        extension: id(m),
        language: g.language ?? null,
        scopeName: g.scopeName,
        path: rel(g.path),
        embeddedLanguages: g.embeddedLanguages ?? {},
      })),
    ),
    themes: manifests.flatMap((m) =>
      (m.contributes?.themes ?? []).map((t) => ({
        extension: id(m),
        label: t.label,
        uiTheme: t.uiTheme ?? "vs-dark",
        path: rel(t.path),
      })),
    ),
    viewers: manifests.flatMap((m) =>
      (m.tote?.viewers ?? []).map((v) => ({
        extension: id(m),
        id: v.id,
        kind: v.kind,
        extensions: v.extensions ?? [],
        entry: rel(v.entry),
      })),
    ),
    problems: [],
  };
}

/** The table, then each distinct license text once under a heading of the names that use it. */
export function licensesMarkdown(title: string, rows: LicenseRow[]): string {
  const lines = [
    `# ${title}`,
    "",
    "| 이름 | 라이선스 | 원문 | 비고 |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) lines.push(`| ${row.name} | ${row.spdx} | ${row.url} | ${row.note} |`);
  const byText = new Map<string, string[]>();
  for (const row of rows) byText.set(row.text, [...(byText.get(row.text) ?? []), row.name]);
  for (const [text, names] of byText) lines.push("", `## ${names.join(", ")}`, "", text);
  return lines.join("\n") + "\n";
}

/** NOTICE files sit beside a file the packages' exports map does expose. */
function noticeBeside(exposed: string): NoticeBlock[] {
  return parseNotice(readFileSync(join(dirname(require.resolve(exposed)), "../NOTICE"), "utf8"));
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

async function syncLanguages() {
  const { grammars, injections } = await import("tm-grammars");
  const dir = join(EXTENSIONS_DIR, "tote.languages");
  rmSync(join(dir, "grammars"), { recursive: true, force: true });
  rmSync(join(dir, "language-configuration"), { recursive: true, force: true });
  const scopes: Record<string, string> = {};
  const rows: LicenseRow[] = [];
  const notice = noticeBeside("tm-grammars/grammars/markdown.json");
  const names = [...LANGUAGES.filter((l) => l.grammar).map((l) => l.grammar!), ...EXTRA_GRAMMARS];
  for (const name of names) {
    const info = [...grammars, ...injections].find((g) => g.name === name);
    if (!info) throw new Error(`tm-grammars has no grammar named ${name}`);
    const override = LANGUAGES.find((l) => l.grammar === name)?.license;
    rows.push({
      ...checkLicense(name, info, override),
      text: licenseTextFor(name, notice, override),
    });
    scopes[name] = info.scopeName;
    const text = readFileSync(require.resolve(`tm-grammars/grammars/${name}.json`), "utf8");
    mkdirSync(join(dir, "grammars"), { recursive: true });
    writeFileSync(join(dir, "grammars", `${name}.json`), text);
  }
  for (const lang of LANGUAGES)
    writeJson(join(dir, "language-configuration", `${lang.id}.json`), languageConfiguration(lang));
  writeJson(join(dir, "package.json"), manifestFor(LANGUAGES, EXTRA_GRAMMARS, scopes));
  writeFileSync(join(dir, "LICENSES.md"), licensesMarkdown("tote.languages — 문법 라이선스", rows));
}

async function syncThemes() {
  const { themes } = await import("tm-themes");
  const dir = join(EXTENSIONS_DIR, "tote.themes");
  rmSync(join(dir, "themes"), { recursive: true, force: true });
  const rows: LicenseRow[] = [];
  const notice = noticeBeside("tm-themes/themes/dark-plus.json");
  for (const theme of THEMES) {
    const info = themes.find((t) => t.name === theme.name);
    if (!info) throw new Error(`tm-themes has no theme named ${theme.name}`);
    rows.push({
      ...checkLicense(theme.name, info, undefined),
      text: licenseTextFor(theme.name, notice),
    });
    mkdirSync(join(dir, "themes"), { recursive: true });
    writeFileSync(
      join(dir, "themes", `${theme.name}.json`),
      readFileSync(require.resolve(`tm-themes/themes/${theme.name}.json`), "utf8"),
    );
  }
  writeJson(join(dir, "package.json"), {
    name: "themes",
    publisher: "tote",
    version: "1.0.0",
    displayName: "tote 기본 테마",
    contributes: {
      themes: THEMES.map((t) => ({
        label: t.label,
        uiTheme: t.uiTheme,
        path: `./themes/${t.name}.json`,
      })),
    },
  });
  writeFileSync(join(dir, "LICENSES.md"), licensesMarkdown("tote.themes — 테마 라이선스", rows));
}

/** Vendor files a viewer template may inline, by the name used in the `__INLINE:<name>__` comment. */
export function vendorFiles(): Record<string, string> {
  const marked = join(dirname(require.resolve("marked/package.json")), "lib/marked.umd.js");
  return { marked: readFileSync(marked, "utf8") };
}

function syncMarkdownPreviewLicense() {
  const license = readFileSync(
    join(dirname(require.resolve("marked/package.json")), "LICENSE"),
    "utf8",
  ).trim();
  writeFileSync(
    join(EXTENSIONS_DIR, "tote.markdown-preview", "LICENSES.md"),
    licensesMarkdown("tote.markdown-preview — 포함한 라이브러리", [
      {
        name: "marked",
        spdx: "MIT",
        url: "https://github.com/markedjs/marked/blob/master/LICENSE.md",
        note: "`viewer.html` 에 `lib/marked.umd.js` 가 그대로 들어 있다(`pnpm sync:bundled`)",
        text: license,
      },
    ]),
  );
}

function syncViewers() {
  const vendor = vendorFiles();
  for (const id of readdirSync(EXTENSIONS_DIR)) {
    const template = join(EXTENSIONS_DIR, id, "viewer.template.html");
    if (!existsSync(template)) continue;
    writeFileSync(
      join(EXTENSIONS_DIR, id, "viewer.html"),
      inlineViewer(readFileSync(template, "utf8"), vendor),
    );
  }
}

function syncFakeRegistry() {
  const manifests = readdirSync(EXTENSIONS_DIR)
    .sort()
    .filter((id) => existsSync(join(EXTENSIONS_DIR, id, "package.json")))
    .map(
      (id) =>
        JSON.parse(readFileSync(join(EXTENSIONS_DIR, id, "package.json"), "utf8")) as Manifest,
    );
  writeJson(FAKE_REGISTRY, fakeRegistry(manifests));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await syncLanguages();
  await syncThemes();
  syncMarkdownPreviewLicense();
  syncViewers();
  syncFakeRegistry();
  console.log("bundled extensions are up to date");
}
