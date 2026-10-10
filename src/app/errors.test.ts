import { describe, expect, it } from "vitest";

import { BackendError } from "../backend/types";
import { describeError, ERROR_TEXT } from "./errors";

describe("describeError", () => {
  it("uses the Korean text for codes that have one and the message otherwise", () => {
    expect(describeError(new BackendError("already-exists", "x"))).toBe(
      ERROR_TEXT["already-exists"],
    );
    expect(describeError(new BackendError("io", "disk full"))).toBe("오류: disk full");
    expect(describeError(new Error("boom"))).toBe("오류: boom");
    expect(describeError("plain")).toBe("오류: plain");
  });
});
