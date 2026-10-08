import { describe, expect, it } from "vitest";

import { basename, splitName } from "./names";

describe("splitName", () => {
  it("splits at the last dot", () => {
    expect(splitName("회의 준비.md")).toEqual({ stem: "회의 준비", ext: "md" });
    expect(splitName("archive.tar.gz")).toEqual({ stem: "archive.tar", ext: "gz" });
  });

  it("keeps a leading dot in the stem and reads no dot as no extension", () => {
    expect(splitName(".env")).toEqual({ stem: ".env", ext: "" });
    expect(splitName("Makefile")).toEqual({ stem: "Makefile", ext: "" });
    expect(splitName("a.")).toEqual({ stem: "a", ext: "" });
  });
});

describe("basename", () => {
  it("takes the last path component", () => {
    expect(basename("/Users/me/스크립트/deploy.sh")).toBe("deploy.sh");
    expect(basename("deploy.sh")).toBe("deploy.sh");
  });
});
