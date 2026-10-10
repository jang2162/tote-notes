/** The bundled language pack (spec 「번들 확장」 2). Grammars are copied from npm `tm-grammars`
 * by sync-bundled.ts, which also checks each grammar's license against ALLOWED_LICENSES. */

export interface BundledLanguage {
  id: string;
  aliases: string[];
  /** The tm-grammars name; null for languages without a grammar. */
  grammar: string | null;
  /** Without the dot. */
  extensions: string[];
  filenames?: string[];
  /** A JavaScript regular expression tried against the first line (spec 「편집기」). */
  firstLine?: string;
  comments?: { line?: string; block?: [string, string] };
  /** Only for grammars whose tm-grammars metadata carries no license: the license as read from
   * the source's README, with where it was read. */
  license?: { spdx: string; url: string; note: string };
}

/** SPDX ids the pack may ship. `textmate-bundle` is the permission sentence of the TextMate
 * bundles ("Permission to copy, use, modify, sell and distribute this software is granted"),
 * which has no SPDX id. */
export const ALLOWED_LICENSES = [
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "ISC",
  "textmate-bundle",
];

const TEXTMATE_BUNDLE_NOTE =
  'Permission to copy, use, modify, sell and distribute this software is granted. This software is provided "as is" without express or implied warranty, and with no claim as to its suitability for any purpose.';

const C_COMMENTS = { line: "//", block: ["/*", "*/"] as [string, string] };
const HASH = { line: "#" };

export const LANGUAGES: BundledLanguage[] = [
  { id: "plaintext", aliases: ["Plain Text"], grammar: null, extensions: ["txt", "text"] },
  {
    id: "markdown",
    aliases: ["Markdown"],
    grammar: "markdown",
    extensions: ["md", "markdown"],
    comments: { block: ["<!--", "-->"] },
  },
  {
    id: "shellscript",
    aliases: ["Shell Script"],
    grammar: "shellscript",
    extensions: ["sh", "bash", "zsh", "command"],
    filenames: [".bashrc", ".zshrc", ".profile", ".bash_profile"],
    firstLine: "^#!.*\\b(bash|zsh|sh|ksh|dash)\\b",
    comments: HASH,
  },
  { id: "json", aliases: ["JSON"], grammar: "json", extensions: ["json"] },
  {
    id: "jsonc",
    aliases: ["JSON with Comments"],
    grammar: "jsonc",
    extensions: ["jsonc", "json5"],
    filenames: ["tsconfig.json", "jsconfig.json", ".eslintrc", "settings.json"],
    comments: C_COMMENTS,
  },
  {
    id: "yaml",
    aliases: ["YAML"],
    grammar: "yaml",
    extensions: ["yaml", "yml"],
    comments: HASH,
    license: {
      spdx: "textmate-bundle",
      url: "https://github.com/textmate/yaml.tmbundle/blob/master/README.mdown",
      note: TEXTMATE_BUNDLE_NOTE,
    },
  },
  {
    id: "toml",
    aliases: ["TOML"],
    grammar: "toml",
    extensions: ["toml"],
    comments: HASH,
    license: {
      spdx: "textmate-bundle",
      url: "https://github.com/textmate/toml.tmbundle/blob/master/README.mdown",
      note: TEXTMATE_BUNDLE_NOTE,
    },
  },
  {
    id: "ini",
    aliases: ["INI"],
    grammar: "ini",
    extensions: ["ini", "cfg", "conf"],
    filenames: [".editorconfig", ".gitconfig"],
    comments: { line: ";" },
  },
  {
    id: "dotenv",
    aliases: ["Dotenv"],
    grammar: "dotenv",
    extensions: ["env"],
    filenames: [".env", ".env.local", ".env.example"],
    comments: HASH,
  },
  {
    id: "javascript",
    aliases: ["JavaScript"],
    grammar: "javascript",
    extensions: ["js", "mjs", "cjs", "jsx"],
    firstLine: "^#!.*\\bnode\\b",
    comments: C_COMMENTS,
  },
  {
    id: "typescript",
    aliases: ["TypeScript"],
    grammar: "typescript",
    extensions: ["ts", "mts", "cts"],
    comments: C_COMMENTS,
  },
  {
    id: "python",
    aliases: ["Python"],
    grammar: "python",
    extensions: ["py", "pyi"],
    firstLine: "^#!.*\\bpython[0-9.]*\\b",
    comments: HASH,
  },
  {
    id: "html",
    aliases: ["HTML"],
    grammar: "html",
    extensions: ["html", "htm"],
    firstLine: "^\\s*<!doctype html",
    comments: { block: ["<!--", "-->"] },
  },
  {
    id: "css",
    aliases: ["CSS"],
    grammar: "css",
    extensions: ["css"],
    comments: { block: ["/*", "*/"] },
  },
  {
    id: "xml",
    aliases: ["XML"],
    grammar: "xml",
    extensions: ["xml", "svg", "plist", "xsl", "xslt"],
    firstLine: "^\\s*<\\?xml",
    comments: { block: ["<!--", "-->"] },
  },
  {
    id: "sql",
    aliases: ["SQL"],
    grammar: "sql",
    extensions: ["sql"],
    comments: { line: "--", block: ["/*", "*/"] },
  },
  { id: "go", aliases: ["Go"], grammar: "go", extensions: ["go"], comments: C_COMMENTS },
  { id: "rust", aliases: ["Rust"], grammar: "rust", extensions: ["rs"], comments: C_COMMENTS },
  { id: "java", aliases: ["Java"], grammar: "java", extensions: ["java"], comments: C_COMMENTS },
  { id: "c", aliases: ["C"], grammar: "c", extensions: ["c", "h"], comments: C_COMMENTS },
  {
    id: "cpp",
    aliases: ["C++"],
    grammar: "cpp",
    extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
    comments: C_COMMENTS,
  },
  { id: "diff", aliases: ["Diff"], grammar: "diff", extensions: ["diff", "patch"] },
  {
    id: "dockerfile",
    aliases: ["Dockerfile"],
    grammar: "docker",
    extensions: ["dockerfile"],
    filenames: ["Dockerfile", "Containerfile"],
    comments: HASH,
  },
  {
    id: "makefile",
    aliases: ["Makefile"],
    grammar: "make",
    extensions: ["mk", "mak"],
    filenames: ["Makefile", "makefile", "GNUmakefile"],
    comments: HASH,
  },
];

/** Grammars shipped for `include` only (no language of their own): cpp includes its macro grammar. */
export const EXTRA_GRAMMARS = ["cpp-macro"];

/** VS Code's own defaults (MIT), from tm-themes. */
export const THEMES = [
  { name: "light-plus", label: "Light+", uiTheme: "vs" },
  { name: "dark-plus", label: "Dark+", uiTheme: "vs-dark" },
];
