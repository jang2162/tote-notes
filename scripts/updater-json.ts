/** Writes the file the app's updater reads (`latest.json`). The release workflow calls it for the
 * one universal build:
 *   node scripts/updater-json.ts --version 0.2.0 --url <.app.tar.gz URL> --sig <.app.tar.gz.sig>
 *     --out latest.json [--notes <text>] [--pub-date <RFC 3339>] [--allow-local-http]
 *
 * Format: https://v2.tauri.app/plugin/updater/ 「Static JSON File」. The app looks for its own
 * `darwin-aarch64` or `darwin-x86_64` key (`get_urls` in tauri-plugin-updater), so the universal
 * file goes under both. The plugin checks every entry before it compares versions, so each has
 * its url and signature. `--allow-local-http` is for scripts/update-local-test.sh only. */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLATFORMS = ["darwin-aarch64", "darwin-x86_64"] as const;
const LOCAL_HTTP = /^http:\/\/(127\.0\.0\.1|localhost):\d+\//;

export interface UpdaterJson {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<(typeof PLATFORMS)[number], { signature: string; url: string }>;
}

export function updaterJson(opts: {
  version: string;
  url: string;
  signature: string;
  notes?: string;
  pubDate?: string;
  allowLocalHttp?: boolean;
}): UpdaterJson {
  const { version, url, signature, notes = "", pubDate = new Date().toISOString() } = opts;
  if (!SEMVER.test(version)) throw new Error(`버전이 SemVer 가 아니다: ${version}`);
  const local = opts.allowLocalHttp === true && LOCAL_HTTP.test(url);
  if (!url.startsWith("https://") && !local) {
    throw new Error(`주소는 https 여야 한다(배포 빌드는 TLS 를 강제한다): ${url}`);
  }
  if (!signature.trim()) throw new Error("서명이 비었다");
  if (Number.isNaN(Date.parse(pubDate))) throw new Error(`pub_date 가 날짜가 아니다: ${pubDate}`);
  const entry = { signature: signature.trim(), url };
  return {
    version: version.replace(/^v/, ""),
    notes,
    pub_date: pubDate,
    platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const version = opt("--version");
  const url = opt("--url");
  const sig = opt("--sig");
  const out = opt("--out");
  if (!version || !url || !sig || !out) {
    console.error(
      "쓰는 법: node scripts/updater-json.ts --version <버전> --url <주소> --sig <.sig 파일> --out <파일> [--notes <글>] [--pub-date <날짜>] [--allow-local-http]",
    );
    process.exit(2);
  }
  try {
    const json = updaterJson({
      version,
      url,
      signature: readFileSync(sig, "utf8"),
      notes: opt("--notes"),
      pubDate: opt("--pub-date"),
      allowLocalHttp: args.includes("--allow-local-http"),
    });
    writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`${out}: ${json.version} → ${Object.keys(json.platforms).join(", ")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
