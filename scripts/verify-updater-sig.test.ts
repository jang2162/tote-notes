import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
