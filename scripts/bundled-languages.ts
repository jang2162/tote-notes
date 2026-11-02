/** The bundled language pack (spec 「번들 확장」 2). Grammars are copied from npm `tm-grammars`,
 * or from scripts/vendor-grammars for the few it lacks (VENDOR_GRAMMARS), by sync-bundled.ts,
 * which also checks each grammar's license against ALLOWED_LICENSES. */

export interface BundledLanguage {
  id: string;
  aliases: string[];
  /** The tm-grammars name, or a VENDOR_GRAMMARS name; null for languages without a grammar. */
  grammar: string | null;
  /** Without the dot. */
  extensions: string[];
  filenames?: string[];
  /** A JavaScript regular expression tried against the first line (spec 「편집기」). */
  firstLine?: string;
  comments?: { line?: string; block?: [string, string] };
  /** Only for grammars whose tm-grammars metadata carries no license: the license as read from
   * the source's README, with where it was read. `note` is also the license text that
   * LICENSES.md ships for the grammar, since NOTICE has no block for it. */
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
    // Compose files, under the names Docker's documentation gives them. VS Code's own `dockercompose`
    // language also takes `compose.*.yml` and `*docker*compose*.yml`, which only a pattern
    // reaches; those end in .yml/.yaml and are YAML by their extension anyway.
    filenames: ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
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
  // From here on the ids, extensions, file names, first lines and comments are VS Code's: its
  // built-in extensions where it has one, else the extension the grammar comes from (Kotlin:
  // fwcd/vscode-kotlin; CSV, TSV: mechatroner/vscode_rainbow_csv).
  {
    id: "kotlin",
    aliases: ["Kotlin"],
    grammar: "kotlin",
    extensions: ["kt", "kts"],
    comments: C_COMMENTS,
  },
  {
    id: "swift",
    aliases: ["Swift"],
    grammar: "swift",
    extensions: ["swift"],
    comments: C_COMMENTS,
  },
  {
    id: "ruby",
    aliases: ["Ruby"],
    grammar: "ruby",
    extensions: ["rb", "rbx", "rjs", "gemspec", "rake", "ru", "erb", "podspec", "rbi"],
    // VS Code lists these in lower case and matches them ignoring case; here a name matches
    // exactly, so they are written as the tools spell them.
    filenames: [
      "Rakefile",
      "Gemfile",
      "Guardfile",
      "Podfile",
      "Capfile",
      "Cheffile",
      "Hobofile",
      "Vagrantfile",
      "Appraisals",
      "Rantfile",
      "Berksfile",
      "Berksfile.lock",
      "Thorfile",
      "Puppetfile",
      "Dangerfile",
      "Brewfile",
      "Fastfile",
      "Appfile",
      "Deliverfile",
      "Matchfile",
      "Scanfile",
      "Snapfile",
      "Gymfile",
    ],
    firstLine: "^#!\\s*/.*\\bruby\\b",
    comments: { line: "#", block: ["=begin", "=end"] },
  },
  {
    id: "lua",
    aliases: ["Lua"],
    grammar: "lua",
    extensions: ["lua"],
    comments: { line: "--", block: ["--[[", "]]"] },
  },
  {
    id: "csharp",
    aliases: ["C#"],
    grammar: "csharp",
    extensions: ["cs", "csx", "cake"],
    comments: C_COMMENTS,
  },
  { id: "csv", aliases: ["CSV"], grammar: "csv", extensions: ["csv"] },
  { id: "tsv", aliases: ["TSV"], grammar: "tsv", extensions: ["tsv", "tab"] },
  {
    id: "php",
    aliases: ["PHP"],
    // VS Code gives PHP files its HTML-with-PHP grammar: tm-grammars' `php` alone reads a whole
    // file as code, HTML included. That one is shipped for the wrapper to include.
    grammar: "php-html",
    extensions: ["php", "php4", "php5", "phtml", "ctp"],
    firstLine: "^#!\\s*/.*\\bphp\\b",
    comments: C_COMMENTS,
  },
  // No built-in VS Code definition: these follow the extension the grammar comes from.
  {
    id: "caddyfile",
    aliases: ["Caddyfile"],
    grammar: "caddyfile",
    // The extension lists `Caddyfile`, `*.Caddyfile` and their lower case among its
    // "extensions", which VS Code matches as an ending of the name.
    extensions: ["caddyfile"],
    filenames: ["Caddyfile", "caddyfile"],
    comments: HASH,
  },
  {
    id: "jsp",
    aliases: ["Java Server Pages"],
    grammar: "jsp",
    extensions: ["jsp", "jspf", "tag"],
    comments: { block: ["<%--", "--%>"] },
  },
];

/** Grammars shipped for `include` only (no language of their own): cpp includes its macro
 * grammar; PHP's HTML wrapper includes PHP itself and the HTML derivative it builds on. */
export const EXTRA_GRAMMARS = ["cpp-macro", "php", "html-derivative"];

/** A grammar tm-grammars does not carry, kept in scripts/vendor-grammars as `<name>.json`, byte
 * for byte the file at `source`, with the license file of the same commit beside it as
 * `<name>.LICENSE.txt`. Nothing is fetched while syncing: to move to a newer commit, fetch both
 * files from it and change `source`, `sha256` and the license url here (README.md there). */
export interface VendorGrammar {
  name: string;
  /** The file as fetched, at a commit. */
  source: string;
  /** sha256 of the file, hex: sync refuses a vendored copy that differs from what was fetched. */
  sha256: string;
  license: { spdx: string; url: string };
  /** Shown in LICENSES.md beside the license. */
  note?: string;
}

export const VENDOR_GRAMMARS: VendorGrammar[] = [
  {
    name: "php-html",
    // The commit tm-grammars took its `php` from, so the wrapper and what it wraps match.
    source:
      "https://raw.githubusercontent.com/microsoft/vscode/af600487b1e94374d9f48f57cbf2cad24656b07f/extensions/php/syntaxes/html.tmLanguage.json",
    sha256: "4eec00e50017cd82b3e2473ed9f774a9be6b1bb2de11371a0bf2785c3ae8b4f1",
    license: {
      spdx: "MIT",
      url: "https://github.com/microsoft/vscode/blob/af600487b1e94374d9f48f57cbf2cad24656b07f/LICENSE.txt",
    },
  },
  {
    name: "caddyfile",
    source:
      "https://raw.githubusercontent.com/caddyserver/vscode-caddyfile/9ba30fcec02e257776188ca66ed47fc210e86b26/syntaxes/caddyfile.tmLanguage.json",
    sha256: "04fb1be35db8b8fd7e7bb7cf3cab934d61c5758dd7910316feaf08e9d749346e",
    license: {
      spdx: "MIT",
      url: "https://github.com/caddyserver/vscode-caddyfile/blob/9ba30fcec02e257776188ca66ed47fc210e86b26/LICENSE",
    },
  },
  {
    name: "jsp",
    source:
      "https://raw.githubusercontent.com/pthorsson/vscode-jsp/fe811b1196530672cae7aa7f774393fb615a21bd/syntaxes/jsp.tmLanguage.json",
    sha256: "b844285c42f69b2a9dc5b7cea4a773991d99ad216a6659a036c9ae43b5cb61ef",
    license: {
      spdx: "MIT",
      url: "https://github.com/pthorsson/vscode-jsp/blob/fe811b1196530672cae7aa7f774393fb615a21bd/LICENSE",
    },
    note: "TextMate java.tmbundle 의 `Java Server Pages (JSP).tmLanguage` 를 JSON 으로 옮긴 것(uuid 만 다르다). 그 원본은 textmate-bundle 허가문을 따른다",
  },
];

/** VS Code's own defaults (MIT), from tm-themes. */
export const THEMES = [
  { name: "light-plus", label: "Light+", uiTheme: "vs" },
  { name: "dark-plus", label: "Dark+", uiTheme: "vs-dark" },
];
