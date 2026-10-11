import { describe, expect, it } from "vitest";

import {
  continueRange,
  displayLine,
  DISPLAY_LINE_LIMIT,
  LINE_HEIGHT,
  MAX_SCROLL_HEIGHT,
  pageOf,
  pageRange,
  scanBytes,
  scrollTopFor,
  virtualTop,
  visibleLines,
} from "./large-text";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("scanBytes", () => {
  it("matches the Rust scan: lines, checkpoints every 1000 lines, longest line in bytes", () => {
    const text = Array.from({ length: 2500 }, (_, i) => `줄 ${i}`).join("\n");
    const scan = scanBytes(utf8(text));
    expect(scan.lineCount).toBe(2500);
    expect(scan.size).toBe(utf8(text).length);
    expect(scan.checkpoints).toHaveLength(3);
    expect(scan.checkpoints[0]).toBe(0);
    expect(scan.checkpoints[1]).toBe(
      utf8(text.split("\n").slice(0, 1000).join("\n") + "\n").length,
    );
    expect(scan.longestLine).toBe(utf8("줄 2499").length);
    expect(scanBytes(utf8(""))).toEqual({
      size: 0,
      lineCount: 1,
      checkpoints: [0],
      longestLine: 0,
    });
    expect(scanBytes(utf8("a\nbb\n")).lineCount).toBe(3);
  });
});

describe("paging", () => {
  const scan = { size: 100, lineCount: 2500, checkpoints: [0, 40, 80], longestLine: 5 };
  it("maps lines to pages and pages to byte ranges ending at the next checkpoint or the file end", () => {
    expect(pageOf(0)).toBe(0);
    expect(pageOf(999)).toBe(0);
    expect(pageOf(1000)).toBe(1);
    expect(pageRange(scan, 0)).toEqual([0, 40]);
    expect(pageRange(scan, 1)).toEqual([40, 80]);
    expect(pageRange(scan, 2)).toEqual([80, 100]);
  });

  it("visibleLines covers the viewport with a margin and stays inside the file", () => {
    expect(visibleLines(0, 200, 2500)).toEqual([0, 30]);
    expect(visibleLines(49_900, 200, 2500)).toEqual([2475, 2500]);
    expect(visibleLines(0, 200, 3)).toEqual([0, 3]);
  });

  it("past MAX_SCROLL_HEIGHT the scroll range is scaled onto the whole file", () => {
    // WebKit clips an element near 2^25 px: 6 million lines at full height would leave everything
    // past line ~1.67 million out of reach.
    const lineCount = 6_000_002;
    const height = 200;
    const bottom = MAX_SCROLL_HEIGHT - height;
    expect(visibleLines(bottom, height, lineCount)[1]).toBe(lineCount);
    const line = 4_321_000;
    const top = scrollTopFor(line * LINE_HEIGHT - height / 2, height, lineCount);
    expect(top).toBeLessThanOrEqual(bottom);
    const [from, to] = visibleLines(top, height, lineCount);
    expect(from).toBeLessThanOrEqual(line);
    expect(to).toBeGreaterThan(line);
    expect(virtualTop(top, height, lineCount)).toBeCloseTo(line * LINE_HEIGHT - height / 2, 3);
    // A file that fits is not scaled.
    expect(scrollTopFor(1000, height, 2500)).toBe(1000);
    expect(virtualTop(1000, height, 2500)).toBe(1000);
  });
});

describe("continueRange", () => {
  it("asks for the rest after an answer shorter than the request, and stops at its end", () => {
    expect(continueRange([0, 9_999_999], "bytes 0-8388607/20000000")).toEqual([
      8_388_608, 9_999_999,
    ]);
    expect(continueRange([8_388_608, 9_999_999], "bytes 8388608-9999999/20000000")).toBeNull();
  });
});

describe("displayLine", () => {
  it("strips a trailing CR and cuts a line past the display limit with its length", () => {
    expect(displayLine("abc\r")).toBe("abc");
    const long = "y".repeat(DISPLAY_LINE_LIMIT + 5);
    expect(displayLine(long)).toBe(
      `${"y".repeat(DISPLAY_LINE_LIMIT)} … (${DISPLAY_LINE_LIMIT + 5}자)`,
    );
  });
});
