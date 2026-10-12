import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  writeCode,
  writeMarkdownTwin,
  writeMemoWorkspace,
  writeRestoreWorkspace,
} from "./perf-fixtures.ts";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tote-perf-fixtures-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("perf fixtures", () => {
  it("the markdown twin has the same code inside a ts fence", () => {
    const dir = scratch();
    writeCode(join(dir, "code.ts"), 4096);
    writeMarkdownTwin(join(dir, "code.ts"), join(dir, "code.md"));
    const code = readFileSync(join(dir, "code.ts"), "utf8");
    expect(code.length).toBeGreaterThan(4096);
    expect(code.split("\n").at(0)).toBe('const v0 = f(0) + "text"; // c');
    expect(readFileSync(join(dir, "code.md"), "utf8")).toBe("```ts\n" + code + "```\n");
  });

  it("the memo workspace has ten thousand indexed memos", () => {
    const root = join(scratch(), "memos-10k");
    writeMemoWorkspace(root, 10_000);
    expect(readJson(join(root, ".tote/workspace.json"))).toMatchObject({ version: 1 });
    const memos = readJson(join(root, ".tote/index.json")).memos as Record<
      string,
      { file: string }
    >;
    const files = Object.values(memos).map((memo) => memo.file);
    expect(files).toHaveLength(10_000);
    expect(new Set(files).size).toBe(10_000);
    const onDisk = readdirSync(root).filter((name) => !name.startsWith("."));
    expect(onDisk.sort()).toEqual([...files].sort());
    // `needle-50` is in one memo of every hundred: 100 files.
    const withNeedle = files.filter((file) =>
      /needle-50$/m.test(readFileSync(join(root, file), "utf8")),
    );
    expect(withNeedle).toHaveLength(100);
    const size = statSync(join(root, files[0])).size;
    expect(size).toBeGreaterThan(1800);
    expect(size).toBeLessThan(2400);
  });

  it("the restore workspace's session opens fifty memos, the last one active", () => {
    const root = join(scratch(), "restore-50");
    writeRestoreWorkspace(root, "device-1");
    const memos = readJson(join(root, ".tote/index.json")).memos as Record<string, unknown>;
    const session = readJson(join(root, ".tote/sessions/device-1.json"));
    expect(session.tabs).toHaveLength(50);
    expect(session.activeTab).toBe(49);
    for (const tab of session.tabs) {
      expect(tab.kind).toBe("memo");
      expect(memos[tab.memoId]).toBeDefined();
    }
    const file = (memos[session.tabs[0].memoId] as { file: string }).file;
    expect(existsSync(join(root, file))).toBe(true);
    expect(statSync(join(root, file)).size).toBeGreaterThan(19_000);
  });
});
