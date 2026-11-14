import { describe, expect, it } from "vitest";

import { eachInTurn, moveSummary, trashSummary } from "./list-actions";

describe("trashSummary", () => {
  it("counts what went, even one", () => {
    expect(trashSummary(["trashed"])).toEqual({
      text: "1개를 휴지통으로 옮겼습니다",
      tone: "normal",
    });
    expect(trashSummary(["trashed", "other", "trashed"])).toEqual({
      text: "2개를 휴지통으로 옮겼습니다",
      tone: "normal",
    });
  });

  it("says what stayed for want of a save, as an error", () => {
    expect(trashSummary(["trashed", "unsaved"])).toEqual({
      text: "1개를 휴지통으로 옮겼습니다 · 1개는 저장하지 못해 옮기지 않았습니다",
      tone: "error",
    });
  });

  it("leaves the status bar to the one that could not be saved, or to nothing", () => {
    expect(trashSummary(["unsaved"])).toBeNull();
    expect(trashSummary(["other"])).toBeNull();
    expect(trashSummary([])).toBeNull();
  });
});

describe("moveSummary", () => {
  it("counts what moved and names where", () => {
    expect(moveSummary(["moved", "moved"], "개인")).toEqual({
      text: "2개를 개인으로 옮겼습니다",
      tone: "normal",
    });
  });

  it("says how many did not, as an error", () => {
    expect(moveSummary(["moved", "kept", "other"], "회사")).toEqual({
      text: "1개를 회사로 옮겼습니다 · 1개는 옮기지 못했습니다",
      tone: "error",
    });
    expect(moveSummary(["kept"], "회사")).toBeNull();
  });
});

describe("eachInTurn", () => {
  it("goes on past one that throws, one at a time, and hands back the first error", async () => {
    const order: string[] = [];
    let running = 0;
    const { results, error } = await eachInTurn(["a", "b", "c"], async (id) => {
      running++;
      expect(running).toBe(1);
      order.push(id);
      await Promise.resolve();
      running--;
      if (id === "b") throw new Error("b failed");
      return id.toUpperCase();
    });
    expect(order).toEqual(["a", "b", "c"]);
    expect(results).toEqual(["A", "C"]);
    expect((error as Error).message).toBe("b failed");
  });
});
