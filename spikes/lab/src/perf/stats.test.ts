import { describe, expect, it } from "vitest";

import { percentile, summarize } from "./stats";

describe("stats", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("uses nearest-rank percentiles", () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 95)).toBe(95);
    expect(percentile(oneToHundred, 100)).toBe(100);
  });

  it("returns NaN for no samples instead of a misleading zero", () => {
    expect(percentile([], 50)).toBeNaN();
    expect(summarize([]).count).toBe(0);
  });

  it("summarize sorts unsorted samples", () => {
    expect(summarize([30, 10, 20])).toEqual({ count: 3, p50: 20, p95: 30, max: 30 });
  });
});
