/** Checks an update file's signature (.sig) against the public key the app carries. The release
 * workflow runs it before anything is uploaded:
 *   node scripts/verify-updater-sig.ts <file> <file.sig> [--pubkey <base64> | --config <tauri.conf.json>]
 *     [--version <version>]
 * Without a key it reads `plugins.updater.pubkey` of src-tauri/tauri.conf.json.
 *
 * Why apart from the build: the build succeeds even when the signing key (a CI secret) and the
 * public key in the app are not a pair, and every installed app would then fail the update
 * quietly. The format is minisign, checked as the app checks it (`verify_signature` in
 * tauri-plugin-updater): the file signature (prehashed with BLAKE2b-512 for `ED`), the global
 * signature over the trusted comment, and the key ID. */

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** minisign public key: base64(text) → its second line in base64 → "Ed" + key ID (8) + key (32). */
function parsePublicKey(b64: string): { keyId: Buffer; key: KeyObject } {
  const text = Buffer.from(b64.trim(), "base64").toString("utf8");
  const line = text.split("\n").find((l) => l.trim() && !l.startsWith("untrusted comment:"));
  const raw = line ? Buffer.from(line.trim(), "base64") : Buffer.alloc(0);
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") {
    throw new Error(
      "공개 키 형식이 아니다 — src-tauri/tauri.conf.json 의 plugins.updater.pubkey 에 `tauri signer generate` 가 만든 .pub 파일 내용을 넣는다(docs/guides/release-macos.md)",
    );
  }
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw.subarray(10)]);
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({ key: der, format: "der", type: "spki" }),
  };
}

/** minisign signature: base64(text) → [untrusted comment, signature, trusted comment, global]. */
function parseSignature(b64: string) {
  const lines = Buffer.from(b64.trim(), "base64").toString("utf8").split("\n");
  const sig = Buffer.from(lines[1] ?? "", "base64");
  const prefix = "trusted comment: ";
  const trusted = lines[2]?.startsWith(prefix) ? lines[2].slice(prefix.length) : null;
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (sig.length !== 74 || trusted === null || global.length !== 64) {
    throw new Error("서명 파일 형식이 아니다(.sig 파일 내용 그대로여야 한다)");
  }
  const alg = sig.subarray(0, 2).toString();
  if (alg !== "Ed" && alg !== "ED") throw new Error(`모르는 서명 방식 ${alg}`);
  return { alg, keyId: sig.subarray(2, 10), sig: sig.subarray(10), trusted, global };
}

const keyIdHex = (id: Buffer) => Buffer.from(id).reverse().toString("hex").toUpperCase();

/** Throws, saying why, unless `data` was signed by the key `pubkeyB64` names. */
export function verifyUpdaterSignature(
  data: Buffer,
  sigB64: string,
  pubkeyB64: string,
): { trusted: string; version: string | null } {
  const pk = parsePublicKey(pubkeyB64);
  const s = parseSignature(sigB64);
  if (!pk.keyId.equals(s.keyId)) {
    throw new Error(
      `키 ID 가 다르다 — 서명 ${keyIdHex(s.keyId)}, 공개 키 ${keyIdHex(pk.keyId)}. CI 의 TAURI_SIGNING_PRIVATE_KEY 와 tauri.conf.json 의 pubkey 가 짝이 아니다`,
    );
  }
  const message = s.alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, pk.key, s.sig)) {
    throw new Error("파일 서명이 맞지 않는다(파일이 바뀌었거나 다른 키로 서명했다)");
  }
  const covered = Buffer.concat([s.sig, Buffer.from(s.trusted, "utf8")]);
  if (!verify(null, covered, pk.key, s.global)) throw new Error("신뢰 주석 서명이 맞지 않는다");
  const field = s.trusted.split("\t").find((f) => f.startsWith("version:"));
  return { trusted: s.trusted, version: field?.slice("version:".length) ?? null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  let pubkey = opt("--pubkey");
  const config = opt("--config") ?? join(root, "src-tauri/tauri.conf.json");
  const version = opt("--version");
  const [file, sigFile] = args;
  if (!file || !sigFile) {
    console.error(
      "쓰는 법: node scripts/verify-updater-sig.ts <파일> <파일.sig> [--pubkey <base64> | --config <tauri.conf.json>] [--version <버전>]",
    );
    process.exit(2);
  }
  try {
    pubkey ??= JSON.parse(readFileSync(config, "utf8")).plugins?.updater?.pubkey ?? "";
    const result = verifyUpdaterSignature(
      readFileSync(file),
      readFileSync(sigFile, "utf8"),
      pubkey as string,
    );
    // The app has `requireSignedVersion` on: a signature without the version is refused there.
    const want = version?.replace(/^v/, "");
    if (want !== undefined && result.version?.replace(/^v/, "") !== want) {
      throw new Error(`서명에 적힌 버전 ${result.version ?? "(없음)"} 이 ${version} 과 다르다`);
    }
    console.log(`서명 확인: ${file} (trusted comment: ${result.trusted})`);
  } catch (error) {
    console.error(`업데이트 서명 검증 실패: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
