/** Keeps the product version in one place. The source is the root `package.json`; the other three
 * places follow it:
 *   node scripts/version.ts set 0.2.0      writes the version into all four places
 *   node scripts/version.ts check [v0.2.0] checks the four agree (and match the tag); exit 1 if not
 * The release workflow runs `check` with the tag it builds. Release steps: docs/guides/release-macos.md */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface Place {
  file: string;
  /** null when the file no longer has the shape the regular expression expects. */
  get: (text: string) => string | null;
  put: (text: string, version: string) => string;
}

export const PLACES: readonly Place[] = [
  {
    file: "package.json",
    get: (s) => JSON.parse(s).version ?? null,
    put: (s, v) => s.replace(/^( {2}"version": ")[^"]*(")/m, `$1${v}$2`),
  },
  {
    file: "src-tauri/tauri.conf.json",
    get: (s) => JSON.parse(s).version ?? null,
    put: (s, v) => s.replace(/^( {2}"version": ")[^"]*(")/m, `$1${v}$2`),
  },
  {
    // Only the [package] table's version, looked for before the next table so a dependency's
    // `version = "2"` never matches.
    file: "src-tauri/Cargo.toml",
    get: (s) => /^\[package\][^[]*?^version = "([^"]*)"/ms.exec(s)?.[1] ?? null,
    put: (s, v) => s.replace(/^(\[package\][^[]*?^version = ")[^"]*(")/ms, `$1${v}$2`),
  },
  {
    // `cargo build --locked` refuses a lock that disagrees with Cargo.toml, so it moves too.
    file: "src-tauri/Cargo.lock",
    get: (s) => /^name = "tote"\nversion = "([^"]*)"/m.exec(s)?.[1] ?? null,
    put: (s, v) => s.replace(/^(name = "tote"\nversion = ")[^"]*(")/m, `$1${v}$2`),
  },
];

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

export function versions(root: string): { file: string; version: string | null }[] {
  return PLACES.map((p) => ({ file: p.file, version: p.get(read(root, p.file)) }));
}

/** What is wrong with the versions; empty when they agree (and match the tag, when given). */
export function versionProblems(root: string, tag?: string): string[] {
  const list = versions(root);
  const want = list[0].version;
  const problems: string[] = [];
  if (!want || !SEMVER.test(want)) {
    problems.push(`package.json 의 version 이 SemVer 가 아니다: ${want}`);
  }
  for (const { file, version } of list.slice(1)) {
    if (version !== want) {
      problems.push(`${file}: ${version ?? "(찾지 못함)"} — package.json 은 ${want}`);
    }
  }
  if (tag !== undefined && tag.replace(/^refs\/tags\//, "") !== `v${want}`) {
    problems.push(`태그 ${tag} 가 버전 v${want} 와 다르다`);
  }
  return problems;
}

/** Writes `version` into every place. Throws before writing anything when the version is not
 * SemVer (a leading `v` included) or a file no longer has the shape its place expects. */
export function setVersion(root: string, version: string): void {
  if (!SEMVER.test(version)) {
    throw new Error(`SemVer 버전을 준다(앞에 v 없이): ${version}`);
  }
  const writes: { file: string; text: string }[] = [];
  for (const p of PLACES) {
    const before = read(root, p.file);
    const after = p.put(before, version);
    if (p.get(after) !== version) {
      throw new Error(
        `${p.file} 에서 버전 자리를 찾지 못했다 — scripts/version.ts 의 정규식을 파일 모양에 맞춘다`,
      );
    }
    if (after !== before) writes.push({ file: p.file, text: after });
  }
  for (const { file, text } of writes) writeFileSync(join(root, file), text);
}

function check(root: string, tag?: string): number {
  for (const { file, version } of versions(root)) console.log(`${version ?? "(없음)"}\t${file}`);
  const problems = versionProblems(root, tag);
  if (problems.length > 0) {
    console.error(
      `\n버전이 맞지 않는다:\n- ${problems.join("\n- ")}\n고치려면: pnpm version:set <버전>`,
    );
    return 1;
  }
  const want = versions(root)[0].version;
  console.log(`\n모두 ${want}${tag !== undefined ? `, 태그 ${tag} 와 같다` : ""}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "check") {
    process.exit(check(root, arg));
  } else if (cmd === "set" && arg !== undefined) {
    try {
      setVersion(root, arg);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
    process.exit(check(root));
  } else {
    console.error("쓰는 법: node scripts/version.ts set <버전> | check [태그]");
    process.exit(2);
  }
}
