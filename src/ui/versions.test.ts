import { describe, expect, it } from "vitest";
import { versionLabel } from "./versions";

describe("versionLabel", () => {
  it("shows one time for a version that is not a run", () => {
    expect(versionLabel({ snapshot: "20261012-153000", until: "20261012-153000" })).toBe(
      "2026-10-12 15:30:00",
    );
  });

  it("shows a run within one day as a time range", () => {
    expect(versionLabel({ snapshot: "20261012-075000", until: "20261012-083000" })).toBe(
      "2026-10-12 07:50:00 – 08:30:00",
    );
  });

  it("repeats the date when a run crosses midnight", () => {
    expect(versionLabel({ snapshot: "20261012-235000", until: "20261013-003000" })).toBe(
      "2026-10-12 23:50:00 – 2026-10-13 00:30:00",
    );
  });

  it("gives back the name when it is not a snapshot time", () => {
    expect(versionLabel({ snapshot: "weird", until: "weird" })).toBe("weird");
    expect(versionLabel({ snapshot: "20261012-153000", until: "weird" })).toBe("20261012-153000");
  });
});
