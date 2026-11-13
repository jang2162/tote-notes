import { describe, expect, it } from "vitest";

import { BACKEND_ERROR_CODES, BackendError } from "../backend/types";
import { describeError, ERROR_LEAD, ERROR_TEXT } from "./errors";

describe("describeError", () => {
  it("uses the Korean text for codes that have one and the message otherwise", () => {
    expect(describeError(new BackendError("already-exists", "x"))).toBe(
      ERROR_TEXT["already-exists"],
    );
    expect(describeError(new Error("boom"))).toBe("오류: boom");
    expect(describeError("plain")).toBe("오류: plain");
  });

  it("leads an io failure in Korean and keeps the system's own words after it", () => {
    const full = new BackendError("io", "No space left on device (os error 28)");
    expect(describeError(full)).toBe(
      "작업을 마치지 못했습니다: No space left on device (os error 28)",
    );
  });

  it("says a memo that is gone in Korean", () => {
    expect(describeError(new BackendError("unknown-memo", "unknown memo 0193"))).toBe(
      "메모를 찾을 수 없습니다",
    );
  });

  it("gives no code both a whole sentence and a lead", () => {
    for (const code of BACKEND_ERROR_CODES)
      expect(code in ERROR_TEXT && code in ERROR_LEAD, code).toBe(false);
  });
});
