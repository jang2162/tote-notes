import { describe, expect, it } from "vitest";

import { updaterJson } from "./updater-json.ts";

const URL =
  "https://github.com/jang2162/tote-notes/releases/download/v0.1.0/tote_0.1.0_universal.app.tar.gz";
const base = { version: "0.1.0", url: URL, signature: "c2lnbmF0dXJl\n" };

describe("updaterJson", () => {
  it("puts the one universal file under both Mac architectures", () => {
    const json = updaterJson({ ...base, notes: "고친 것", pubDate: "2026-10-25T00:00:00Z" });
    const entry = { url: URL, signature: "c2lnbmF0dXJl" };
    expect(json).toEqual({
      version: "0.1.0",
      notes: "고친 것",
      pub_date: "2026-10-25T00:00:00Z",
      platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
    });
  });

  it("drops the tag's leading v", () => {
    expect(updaterJson({ ...base, version: "v0.2.0" }).version).toBe("0.2.0");
  });

  it("takes https only, and plain http on this machine only when asked", () => {
    expect(() => updaterJson({ ...base, url: "http://github.com/x.tar.gz" })).toThrow(/https/);
    expect(
      updaterJson({ ...base, url: "http://127.0.0.1:18765/x.tar.gz", allowLocalHttp: true })
        .platforms["darwin-aarch64"].url,
    ).toBe("http://127.0.0.1:18765/x.tar.gz");
    expect(
      updaterJson({ ...base, url: "http://localhost:18765/x.tar.gz", allowLocalHttp: true }),
    ).toBeTruthy();
    expect(() => updaterJson({ ...base, url: "http://127.0.0.1:18765/x.tar.gz" })).toThrow();
    expect(() =>
      updaterJson({ ...base, url: "http://example.com/x.tar.gz", allowLocalHttp: true }),
    ).toThrow();
    expect(() =>
      updaterJson({ ...base, url: "http://127.0.0.1.example.com/x", allowLocalHttp: true }),
    ).toThrow();
  });

  it("refuses an empty signature, a date that is not one and a version that is not SemVer", () => {
    expect(() => updaterJson({ ...base, signature: " \n" })).toThrow(/서명/);
    expect(() => updaterJson({ ...base, pubDate: "어제" })).toThrow(/pub_date/);
    expect(() => updaterJson({ ...base, version: "1.0" })).toThrow(/SemVer/);
  });
});
