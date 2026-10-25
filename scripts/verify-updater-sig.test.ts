import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyUpdaterSignature } from "./verify-updater-sig.ts";

// Two throwaway keys made by the same CLI the release uses, and a file signed with the first.
let dir: string;
let data: Buffer;
let sig: string;
let pubkey: string;
let otherPubkey: string;

const tauri = (...args: string[]) =>
  execFileSync("pnpm", ["exec", "tauri", ...args], { encoding: "utf8", stdio: "pipe" });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tote-updater-sig-"));
  tauri("signer", "generate", "--ci", "-p", "test", "-w", join(dir, "k"));
  tauri("signer", "generate", "--ci", "-p", "test", "-w", join(dir, "other"));
  writeFileSync(join(dir, "tote.app.tar.gz"), "the update bundle");
  tauri(
    "signer",
    "sign",
    "-f",
    join(dir, "k"),
    "-p",
    "test",
    "--app-version",
    "0.1.0",
    join(dir, "tote.app.tar.gz"),
  );
  // Signed with no version, as `tauri signer sign` does without `--app-version`.
  writeFileSync(join(dir, "unversioned.tar.gz"), "the update bundle");
  tauri("signer", "sign", "-f", join(dir, "k"), "-p", "test", join(dir, "unversioned.tar.gz"));
  data = readFileSync(join(dir, "tote.app.tar.gz"));
  sig = readFileSync(join(dir, "tote.app.tar.gz.sig"), "utf8");
  pubkey = readFileSync(join(dir, "k.pub"), "utf8");
  otherPubkey = readFileSync(join(dir, "other.pub"), "utf8");
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("verifyUpdaterSignature", () => {
  it("takes the file signed with the key and reads the version it was signed for", () => {
    const result = verifyUpdaterSignature(data, sig, pubkey);
    expect(result.version).toBe("0.1.0");
    expect(result.trusted).toContain("version:0.1.0");
  });

  it("refuses another key's public key", () => {
    expect(() => verifyUpdaterSignature(data, sig, otherPubkey)).toThrow(/키 ID 가 다르다/);
  });

  it("refuses a file one byte off", () => {
    const changed = Buffer.from(data);
    changed[0] ^= 1;
    expect(() => verifyUpdaterSignature(changed, sig, pubkey)).toThrow(/파일 서명이 맞지 않는다/);
  });

  it("refuses a trusted comment changed after signing", () => {
    const lines = Buffer.from(sig.trim(), "base64").toString("utf8").split("\n");
    lines[2] = lines[2].replace("version:0.1.0", "version:9.9.9");
    const forged = Buffer.from(lines.join("\n")).toString("base64");
    expect(() => verifyUpdaterSignature(data, forged, pubkey)).toThrow(
      /신뢰 주석 서명이 맞지 않는다/,
    );
  });

  it("refuses the placeholder key the config ships with", () => {
    expect(() => verifyUpdaterSignature(data, sig, "REPLACE_WITH_UPDATER_PUBLIC_KEY")).toThrow(
      /공개 키 형식이 아니다/,
    );
  });

  it("refuses what is not a signature file", () => {
    expect(() => verifyUpdaterSignature(data, "bm90IGEgc2ln", pubkey)).toThrow(
      /서명 파일 형식이 아니다/,
    );
  });
});

// The version check is the CLI's, which the release workflow and scripts/update-local-test.sh run:
// the app has `requireSignedVersion` on, so a signature for another version or none is refused
// there.
describe("verify-updater-sig --version", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "verify-updater-sig.ts");
  const cli = (file: string, version: string) => {
    try {
      const out = execFileSync(
        process.execPath,
        [
          script,
          join(dir, file),
          join(dir, `${file}.sig`),
          "--pubkey",
          pubkey,
          "--version",
          version,
        ],
        { encoding: "utf8", stdio: "pipe" },
      );
      return { code: 0, out };
    } catch (error) {
      const e = error as { status: number; stderr: string };
      return { code: e.status, out: e.stderr };
    }
  };

  it("takes the version the file was signed for, with or without the v of the tag", () => {
    expect(cli("tote.app.tar.gz", "0.1.0").code).toBe(0);
    expect(cli("tote.app.tar.gz", "v0.1.0").code).toBe(0);
  });

  it("refuses another version", () => {
    expect(cli("tote.app.tar.gz", "0.1.1")).toEqual({
      code: 1,
      out: expect.stringContaining("서명에 적힌 버전 0.1.0 이 0.1.1 과 다르다"),
    });
  });

  it("refuses a signature with no version", () => {
    expect(cli("unversioned.tar.gz", "0.1.0")).toEqual({
      code: 1,
      out: expect.stringContaining("서명에 적힌 버전 (없음) 이 0.1.0 과 다르다"),
    });
  });
});
