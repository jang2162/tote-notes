import { describe, expect, it } from "vitest";

import { namingText } from "./dialogs";

const dialog = (...texts: (string | null)[]) => ({
  querySelectorAll: () => texts.map((textContent) => ({ textContent })),
});

describe("namingText", () => {
  it("skips a heading or paragraph with no text in it", () => {
    expect(namingText(dialog("", "  ", null, "이름"))?.textContent).toBe("이름");
  });

  it("finds nothing when none has text", () => {
    expect(namingText(dialog("", " "))).toBeUndefined();
  });
});
