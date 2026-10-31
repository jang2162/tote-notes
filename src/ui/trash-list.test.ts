import { describe, expect, it } from "vitest";

import type { TrashedInfo } from "../backend/types";
import { trashButtonTitle } from "./trash-button";
import { deletedLabel, trashView } from "./trash-list";

const item = (id: string, deletedMs: number, file = `${id}.md`): TrashedInfo => ({
  id,
  file,
  deletedMs,
  autoTitle: false,
  kind: "text",
});

describe("trashView", () => {
  it("trash list shows newest first, says when empty and disables 비우기", () => {
    const full = trashView([item("a", 1), item("c", 3), item("b", 2)]);
    expect(full.rows.map((row) => row.id)).toEqual(["c", "b", "a"]);
    expect(full).toMatchObject({ heading: "휴지통 3", none: null, canEmpty: true });
    expect(full.rows[0]).toMatchObject({ stem: "c", ext: "md", file: "c.md" });

    const empty = trashView([]);
    expect(empty).toEqual({
      rows: [],
      heading: "휴지통 0",
      none: "휴지통이 비었습니다",
      canEmpty: false,
    });
  });

  it("names a row as the memo list does: the name, the extension apart", () => {
    const [noExt, dotted] = trashView([item("a", 2, "README"), item("b", 1, "회의.록.txt")]).rows;
    expect(noExt).toMatchObject({ stem: "README", ext: "" });
    expect(dotted).toMatchObject({ stem: "회의.록", ext: "txt" });
  });
});

describe("deletedLabel", () => {
  it("is the local date and time to the minute", () => {
    expect(deletedLabel(new Date(2026, 10, 1, 9, 5, 59).getTime())).toBe("2026-11-01 09:05");
    expect(deletedLabel(new Date(2026, 0, 31, 23, 0).getTime())).toBe("2026-01-31 23:00");
  });
});

describe("trashButtonTitle", () => {
  it("counts what the trash holds", () => {
    expect(trashButtonTitle(0)).toBe("휴지통 (0개)");
    expect(trashButtonTitle(12)).toBe("휴지통 (12개)");
  });
});
