import { describe, expect, it } from "vitest";

import { TS_SAMPLE, makeCodeFixture, makeLogFixture, makeSingleLineJson } from "./fixtures";

describe("fixtures", () => {
  it("code fixture reaches the target size without overshooting by more than one sample", () => {
    const text = makeCodeFixture(100_000);
    expect(text.length).toBeGreaterThanOrEqual(100_000);
    expect(text.length).toBeLessThan(100_000 + TS_SAMPLE.length);
  });

  it("json fixture is one valid line", () => {
    const text = makeSingleLineJson(100_000);
    expect(text.length).toBeGreaterThanOrEqual(100_000);
    expect(text.includes("\n")).toBe(false);
    expect(Array.isArray(JSON.parse(text))).toBe(true);
  });

  it("log fixture has exactly the requested line count", () => {
    expect(makeLogFixture(1_000).split("\n")).toHaveLength(1_000);
  });
});
