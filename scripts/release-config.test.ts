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
  it("names the app com.develma.totenotes and the debug build apart from it", () => {
    // Fixed once released: a new identifier makes an update look like another app.
    expect(conf.identifier).toBe("com.develma.totenotes");
    expect(conf.productName).toBe("tote");
    // Apart, so the debug app and the installed one never take each other's single instance.
    expect(dev.identifier).toBe("com.develma.totenotes.dev");
    expect(dev.productName).toBe("tote-dev");
  });

  it("bundles a DMG under the hardened runtime for macOS 13", () => {
    expect(conf.bundle.targets).toEqual(expect.arrayContaining(["app", "dmg"]));
    expect(conf.bundle.macOS.hardenedRuntime).toBe(true);
    expect(conf.bundle.macOS.minimumSystemVersion).toBe("13.0");
    // The workflow turns it on with --config; set here, every local build without the update
    // key would fail.
    expect(conf.bundle.createUpdaterArtifacts).not.toBe(true);
  });

  it("keeps the page's connections to the app itself", () => {
    // Update checks leave from Rust; the page never talks to github.com.
    expect(conf.app.security.csp["connect-src"]).toBe("ipc: http://ipc.localhost tote-file:");
  });

  it("leaves no trace of the old identifier outside the dated history", () => {
    // Plans, specs and reports under docs/superpowers are history and keep the name they had.
    let found = "";
    try {
      found = execFileSync(
        "git",
        ["grep", "-nE", String.raw`dev\.tote\.note|dev_tote_note`, "--", ".", ":!docs/superpowers"],
        { cwd: ROOT, encoding: "utf8" },
      );
    } catch (error) {
      // git grep exits 1 when nothing matches.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    expect(found).toBe("");
  });
});
