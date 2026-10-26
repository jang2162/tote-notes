/** The values the shipped app must keep (docs/superpowers/specs/2026-10-25-tote-notes-mac-distribution-design.md):
 * one place guards them so a config edit that would break the release or the updates fails here. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const conf = json("src-tauri/tauri.conf.json");
const dev = json("src-tauri/tauri.dev.conf.json");

describe("the release config", () => {
  it("names the app Tote Notes, com.develma.totenotes, and the debug build apart from it", () => {
    // Fixed once released: a new identifier makes an update look like another app.
    expect(conf.identifier).toBe("com.develma.totenotes");
    expect(conf.productName).toBe("Tote Notes");
    // `Contents/MacOS/tote`: the `tote` script in the bundle runs it by that name
    // (src-tauri/resources/tote), and the update relaunches it (src-tauri/src/app/update.rs).
    expect(conf.mainBinaryName).toBe("tote");
    // Apart, so the debug app and the installed one never take each other's single instance.
    expect(dev.identifier).toBe("com.develma.totenotes.dev");
    expect(dev.productName).toBe("Tote Notes Dev");
    expect(dev.mainBinaryName).toBeUndefined();
  });

  it("looks for the bundles under the app's name and releases them without spaces", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/release-macos.yml"), "utf8");
    const name = conf.productName;
    expect(workflow).toContain(`app="$BUNDLE/macos/${name}.app"`);
    expect(workflow).toContain(`dmg="$BUNDLE/dmg/${name}_\${VERSION}_universal.dmg"`);
    expect(workflow).toContain(`TAR_PATH=$BUNDLE/macos/${name}.app.tar.gz`);
    // GitHub turns a space in an asset name into a dot, and latest.json would point at nothing.
    const base = /base="([^"]*)"/.exec(workflow)?.[1];
    expect(base).toBe(`${name.replaceAll(" ", "-")}_\${VERSION}_universal`);
  });

  it("bundles a DMG under the hardened runtime for macOS 13", () => {
    expect(conf.bundle.targets).toEqual(expect.arrayContaining(["app", "dmg"]));
    expect(conf.bundle.macOS.hardenedRuntime).toBe(true);
    expect(conf.bundle.macOS.minimumSystemVersion).toBe("13.0");
    // The workflow turns it on with --config; set here, every local build without the update
    // key would fail.
    expect(conf.bundle.createUpdaterArtifacts).not.toBe(true);
  });

  it("asks for no entitlements under the hardened runtime", () => {
    // A tote bundle signed ad hoc with the runtime on starts, takes a `tote` command through the
    // single instance and logs no refusal without any: the app is not sandboxed, and WebKit runs
    // the page's JavaScript and WebAssembly in its own process. Add one only for a thing that is
    // refused, with the refusal it fixes.
    expect(conf.bundle.macOS.entitlements).toBeUndefined();
  });

  it("offers tote in Finder for the text it colours, without taking another app's files", () => {
    // Every extension a bundled language claims: tote edits any file that is not media or a PDF
    // (`kind_for`, src-tauri/src/workspace/memo.rs), and these are the ones it highlights.
    // `.plist` is left out — most of them are binary.
    const languages = json("src-tauri/resources/extensions/tote.languages/package.json").contributes
      .languages as { extensions?: string[] }[];
    const claimed = new Set(languages.flatMap((l) => (l.extensions ?? []).map((e) => e.slice(1))));
    claimed.delete("plist");
    // The bundler turns these extensions into content types (`extension_to_uti` in tauri-utils)
    // and writes them into the same entry, and macOS ignores an entry's extensions once it names
    // content types: they are named as types in an entry of their own.
    const typed: Record<string, string> = {
      txt: "public.plain-text",
      html: "public.html",
      htm: "public.html",
      json: "public.json",
      xml: "public.xml",
      svg: "public.svg-image",
    };
    const [byExtension, byType] = conf.bundle.fileAssociations;
    expect(byExtension.contentTypes).toBeUndefined();
    expect(byExtension.ext.filter((e: string) => e in typed)).toEqual([]);
    expect(byType.ext).toEqual([]);
    expect(new Set(byType.contentTypes)).toEqual(new Set(Object.values(typed)));
    expect(new Set([...byExtension.ext, ...Object.keys(typed)])).toEqual(claimed);
    for (const association of conf.bundle.fileAssociations) {
      // Alternate: listed under 「다음으로 열기」, never made the default over the person's choice.
      expect(association).toMatchObject({ role: "Editor", rank: "Alternate" });
    }
  });

  it("keeps the page's connections to the app itself", () => {
    // Update checks leave from Rust; the page never talks to github.com.
    expect(conf.app.security.csp["connect-src"]).toBe("ipc: http://ipc.localhost tote-file:");
  });

  it("checks for updates at the releases' latest.json, signed for the version announced", () => {
    const updater = conf.plugins.updater;
    expect(updater.endpoints).toEqual([
      "https://github.com/jang2162/tote-notes/releases/latest/download/latest.json",
    ]);
    // Without it, an old signed bundle could be announced under a higher version.
    expect(updater.requireSignedVersion).toBe(true);
    // The placeholder until the key is made (docs/guides/release-macos.md); the release fails on it.
    expect(updater.pubkey).toBeTruthy();
  });

  it("gives the page no updater or process permission", () => {
    // The check, the download and the restart are Rust's (src-tauri/src/app/update.rs).
    expect(json("src-tauri/capabilities/default.json").permissions).toEqual([
      "core:default",
      "dialog:allow-open",
    ]);
  });

  it("leaves no trace of the old identifier outside the dated history", () => {
    // Plans, specs and reports under docs/superpowers are history and keep the name they had.
    // Put together so this file does not match itself; `[._]` takes the socket's spelling too.
    const old = ["dev", "tote", "note"].join("[._]");
    let found = "";
    try {
      found = execFileSync("git", ["grep", "-nE", old, "--", ".", ":!docs/superpowers"], {
        cwd: ROOT,
        encoding: "utf8",
      });
    } catch (error) {
      // git grep exits 1 when nothing matches.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    expect(found).toBe("");
  });
});
