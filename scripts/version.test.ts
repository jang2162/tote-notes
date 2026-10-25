import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setVersion, versionProblems, versions } from "./version.ts";

let root: string;

const PACKAGE = (v: string) =>
  `{\n  "name": "tote-notes",\n  "version": "${v}",\n  "private": true\n}\n`;
const CONF = (v: string) =>
  `{\n  "productName": "tote",\n  "version": "${v}",\n  "app": { "windows": [] }\n}\n`;
const CARGO = (v: string) =>
  `[package]\nname = "tote"\nversion = "${v}"\nedition = "2021"\n\n[dependencies]\ntauri = { version = "2" }\nserde = { version = "1" }\n`;
const LOCK = (v: string) =>
  `[[package]]\nname = "serde"\nversion = "1.0.200"\n\n[[package]]\nname = "tote"\nversion = "${v}"\ndependencies = [\n "serde",\n]\n\n[[package]]\nname = "zip"\nversion = "2.4.1"\n`;

function write(versions: { pkg?: string; conf?: string; cargo?: string; lock?: string } = {}) {
  writeFileSync(join(root, "package.json"), PACKAGE(versions.pkg ?? "0.1.0"));
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), CONF(versions.conf ?? "0.1.0"));
  writeFileSync(join(root, "src-tauri/Cargo.toml"), CARGO(versions.cargo ?? "0.1.0"));
  writeFileSync(join(root, "src-tauri/Cargo.lock"), LOCK(versions.lock ?? "0.1.0"));
}
const read = (file: string) => readFileSync(join(root, file), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tote-version-"));
  mkdirSync(join(root, "src-tauri"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("versionProblems", () => {
  it("finds nothing when the four places agree", () => {
    write();
    expect(versionProblems(root)).toEqual([]);
    expect(versions(root).map((v) => v.version)).toEqual(["0.1.0", "0.1.0", "0.1.0", "0.1.0"]);
  });

  it("names the one file that differs", () => {
    write({ lock: "0.0.9" });
    const problems = versionProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("src-tauri/Cargo.lock");
  });

  it("rejects a package.json version that is not SemVer", () => {
    write({ pkg: "1.0", conf: "1.0", cargo: "1.0", lock: "1.0" });
    expect(versionProblems(root).join("\n")).toContain("SemVer");
  });

  it("takes the tag with or without refs/tags/ and refuses one for another version", () => {
    write();
    expect(versionProblems(root, "v0.1.0")).toEqual([]);
    expect(versionProblems(root, "refs/tags/v0.1.0")).toEqual([]);
    expect(versionProblems(root, "v0.1.1")).toEqual(["태그 v0.1.1 가 버전 v0.1.0 와 다르다"]);
  });
});

describe("setVersion", () => {
  it("writes the four places and leaves the dependency versions alone", () => {
    write();
    setVersion(root, "0.2.0");
    expect(versions(root).map((v) => v.version)).toEqual(["0.2.0", "0.2.0", "0.2.0", "0.2.0"]);
    expect(read("src-tauri/Cargo.toml")).toContain('tauri = { version = "2" }');
    expect(read("src-tauri/Cargo.lock")).toContain('name = "serde"\nversion = "1.0.200"');
    expect(read("src-tauri/Cargo.lock")).toContain('name = "zip"\nversion = "2.4.1"');
    expect(versionProblems(root)).toEqual([]);
  });

  it("refuses a leading v", () => {
    write();
    expect(() => setVersion(root, "v0.2.0")).toThrow();
    expect(versions(root).map((v) => v.version)).toEqual(["0.1.0", "0.1.0", "0.1.0", "0.1.0"]);
  });

  it("throws when a file no longer has the shape the place expects", () => {
    write();
    writeFileSync(
      join(root, "src-tauri/Cargo.lock"),
      LOCK("0.1.0").replace('"tote"', '"tote-app"'),
    );
    expect(() => setVersion(root, "0.2.0")).toThrow(/src-tauri\/Cargo\.lock/);
    // Nothing is half-written: the places before the broken one keep their version.
    expect(read("package.json")).toBe(PACKAGE("0.1.0"));
    expect(read("src-tauri/tauri.conf.json")).toBe(CONF("0.1.0"));
  });

  it("never takes a later table's version for the [package] one", () => {
    write();
    writeFileSync(
      join(root, "src-tauri/Cargo.toml"),
      `[package]\nname = "tote"\nedition = "2021"\n\n[dependencies.tauri]\nversion = "2"\n`,
    );
    expect(versions(root)[2].version).toBeNull();
    expect(() => setVersion(root, "0.2.0")).toThrow(/src-tauri\/Cargo\.toml/);
    expect(read("src-tauri/Cargo.toml")).toContain('[dependencies.tauri]\nversion = "2"');
  });
});
