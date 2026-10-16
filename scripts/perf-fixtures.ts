/** The file set of the performance measurement (tests/measure/perf.md): `pnpm perf:fixtures <dir>`.
 * Code files of 1, 10 and 100MB with a Markdown twin of the first two (memos are Markdown), a
 * one-line 10MB JSON, a 100,000-line log, and the workspaces the measurement opens — ten
 * thousand memos to search, fifty memos with a session of fifty tabs, an empty one — plus the
 * `machine.json` whose device ID names that session. */

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIB = 1024 * 1024;
/** Bytes gathered before each write of a large file. */
const CHUNK = MIB;

/** Writes the lines `line(0)`, `line(1)`, … to `path` until it is larger than `minBytes`. */
function writeLines(path: string, minBytes: number, line: (i: number) => string): void {
  const fd = openSync(path, "w");
  try {
    let size = 0;
    let chunk = "";
    for (let i = 0; size <= minBytes; i++) {
      const text = line(i) + "\n";
      chunk += text;
      size += Buffer.byteLength(text);
      if (chunk.length >= CHUNK) {
        writeSync(fd, chunk);
        chunk = "";
      }
    }
    writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
}

/** TypeScript of more than `minBytes`, one short statement a line. */
export function writeCode(path: string, minBytes: number): void {
  writeLines(path, minBytes, (i) => `const v${i} = f(${i}) + "text"; // c`);
}

/** The code at `codePath` as a memo has it: inside a ` ```ts ` fence. */
export function writeMarkdownTwin(codePath: string, path: string): void {
  writeFileSync(path, "```ts\n" + readFileSync(codePath, "utf8") + "```\n");
}

/** `{"k":[…]}` on a single line of more than `minBytes`. */
export function writeOneLineJson(path: string, minBytes: number): void {
  const fd = openSync(path, "w");
  try {
    let size = 0;
    let chunk = '{"k":[';
    for (let i = 0; size <= minBytes; i++) {
      const item = `${i ? "," : ""}{"id":${i},"name":"item-${i}","tags":["a","b"]}`;
      chunk += item;
      size += item.length;
      if (chunk.length >= CHUNK) {
        writeSync(fd, chunk);
        chunk = "";
      }
    }
    writeSync(fd, chunk + "]}\n");
  } finally {
    closeSync(fd);
  }
}

export function writeLog(path: string, lines: number): void {
  const fd = openSync(path, "w");
  try {
    let chunk = "";
    for (let i = 0; i < lines; i++) {
      chunk += `2026-10-12T00:00:00.000Z INFO worker-${i} handled request ${i} in ${i % 997}ms\n`;
      if (chunk.length >= CHUNK) {
        writeSync(fd, chunk);
        chunk = "";
      }
    }
    writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
}

const SENTENCES = [
  "오늘 회의에서 다음 분기 계획을 정리했다.",
  "The build finished without warnings after the cache was cleared.",
  "장보기 목록: 우유, 계란, 사과, 커피 원두.",
  "Remember to rotate the API keys before the release on Friday.",
  "주말에는 산책을 하고 책을 두 장 읽었다.",
  "Latency went down once the index was moved to local disk.",
  "새 프로젝트의 이름은 아직 정하지 못했다.",
  "Notes from the call: ship the beta, then collect feedback.",
];

/** About 2KB of Korean and English sentences, ending with the line `찾을 표시 needle-<n>`. */
function memoText(i: number, minBytes: number, needle: number): string {
  let text = `# 메모 ${i}\n\n`;
  for (let s = i; Buffer.byteLength(text) < minBytes; s++) {
    text += `${SENTENCES[s % SENTENCES.length]} (${i}-${s})\n`;
  }
  return `${text}찾을 표시 needle-${needle}\n`;
}

/** A tote workspace (`.tote/workspace.json` and `index.json`) holding `files`, as file name →
 * text. Returns the memo IDs in the order of `files`. */
function writeWorkspace(root: string, files: [string, string][]): string[] {
  mkdirSync(join(root, ".tote"), { recursive: true });
  writeFileSync(
    join(root, ".tote/workspace.json"),
    JSON.stringify({ version: 1, id: randomUUID() }),
  );
  const ids: string[] = [];
  const memos: Record<string, { file: string; autoTitle: boolean }> = {};
  for (const [file, text] of files) {
    writeFileSync(join(root, file), text);
    const id = randomUUID();
    ids.push(id);
    // `autoTitle: false`: tote must not rename the files the measurement names.
    memos[id] = { file, autoTitle: false };
  }
  writeFileSync(join(root, ".tote/index.json"), JSON.stringify({ version: 1, memos }));
  return ids;
}

const memoName = (i: number) => `memo-${String(i).padStart(5, "0")}.md`;

/** `count` memos of about 2KB. Memo `i` ends with `needle-<i % 100>`: each needle is in one memo
 * of every hundred, so `needle-50` is in `count / 100` of them. */
export function writeMemoWorkspace(root: string, count: number): void {
  writeWorkspace(
    root,
    Array.from({ length: count }, (_, i) => [memoName(i), memoText(i, 1900, i % 100)]),
  );
}

/** Fifty memos of about 20KB and this device's session with a tab for each, the last active. */
export function writeRestoreWorkspace(root: string, deviceId: string): void {
  const ids = writeWorkspace(
    root,
    Array.from({ length: 50 }, (_, i) => [memoName(i), memoText(i, 20_000, i % 100)]),
  );
  mkdirSync(join(root, ".tote/sessions"), { recursive: true });
  writeFileSync(
    join(root, ".tote/sessions", `${deviceId}.json`),
    // Version 1 on purpose: the measured restore also goes through reading the old format.
    JSON.stringify({
      version: 1,
      activeTab: ids.length - 1,
      tabs: ids.map((memoId) => ({ kind: "memo", memoId, scrollAnchor: 0 })),
    }),
  );
}

export function writeFixtures(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const deviceId = randomUUID();
  writeFileSync(
    join(dir, "machine.json"),
    JSON.stringify({ version: 1, deviceId, deviceName: "perf" }),
  );
  for (const [name, mib] of [
    ["code-1mb", 1],
    ["code-10mb", 10],
    ["code-100mb", 100],
  ] as const) {
    writeCode(join(dir, `${name}.ts`), mib * MIB);
    if (mib < 100) writeMarkdownTwin(join(dir, `${name}.ts`), join(dir, `${name}.md`));
  }
  writeOneLineJson(join(dir, "json-10mb-one-line.json"), 10 * MIB);
  writeLog(join(dir, "log-100k.log"), 100_000);
  writeMemoWorkspace(join(dir, "memos-10k"), 10_000);
  writeRestoreWorkspace(join(dir, "restore-50"), deviceId);
  writeWorkspace(join(dir, "empty"), []);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: pnpm perf:fixtures <dir>");
    process.exit(2);
  }
  writeFixtures(dir);
  console.log(`perf fixtures written to ${dir}`);
}
