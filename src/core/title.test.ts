import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { memoTitle, titleFromLine, titleLine } from "./title";

describe("titleFromLine", () => {
  it("strips heading marks and leading space", () => {
    expect(titleFromLine("  ## 회의 준비")).toBe("회의 준비");
  });

  it("turns characters a file name cannot hold into spaces", () => {
    expect(titleFromLine('a/b:c*d?"e<f>g|h\\i')).toBe("a b c d e f g h i");
  });

  it("collapses spaces and drops leading dots", () => {
    expect(titleFromLine("  ..  숨김   파일 ")).toBe("숨김 파일");
    expect(titleFromLine("# .env 설정")).toBe("env 설정");
  });

  it("keeps surrogate pairs whole when cutting at 60 characters", () => {
    const title = titleFromLine("가".repeat(59) + "😀😀");
    expect(Array.from(title)).toHaveLength(60);
    expect(title.endsWith("😀")).toBe(true);
  });

  it("falls back to untitled", () => {
    expect(titleFromLine("###")).toBe("untitled");
    expect(titleFromLine("")).toBe("untitled");
  });

  it("composes decomposed Hangul", () => {
    expect(titleFromLine("한")).toBe("한");
  });

  it("drops control characters", () => {
    expect(titleFromLine("a\tb\u0007c\u0085d")).toBe("a b c d");
  });
});

describe("titleLine and memoTitle", () => {
  it("take the first non-blank line", () => {
    const doc = Text.of(["", "   ", "# 제목", "본문"]);
    expect(titleLine(doc)).toEqual({ text: "# 제목", number: 3 });
    expect(memoTitle(doc)).toBe("제목");
  });

  it("call a blank memo untitled, on line 1", () => {
    const doc = Text.of(["", ""]);
    expect(titleLine(doc)).toEqual({ text: "", number: 1 });
    expect(memoTitle(doc)).toBe("untitled");
  });
});
