import { describe, expect, it } from "vitest";

import {
  median,
  metricOf,
  p95,
  SCENARIOS,
  summarize,
  verdict,
  type Scenario,
} from "./perf-summary.ts";

const line = (t: number, name: string) => JSON.stringify({ t, name, pid: 1 });

const OPEN: Scenario = {
  id: "open",
  title: "열기",
  file: "open",
  from: "open-start:",
  to: "open-first-paint:",
  targetMs: 500,
};

describe("perf summary", () => {
  it("takes the median and the nearest-rank p95 of the runs", () => {
    expect(median([30, 10, 20, 50, 40])).toBe(30);
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(p95([30, 10, 20, 50, 40])).toBe(50);
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
  });

  it("measures from the first mark to the second of the same tab", () => {
    const text = [
      line(0, "process-start"),
      line(100, "open-start:t3"),
      line(340, "open-first-paint:t3"),
    ];
    expect(metricOf(text.join("\n"), OPEN)).toEqual({ ok: true, value: 240 });
  });

  it("a run with a missing or repeated mark is invalid", () => {
    const missing = [line(100, "open-start:t3")].join("\n");
    const twice = [
      line(100, "open-start:t3"),
      line(200, "open-start:t4"),
      line(340, "open-first-paint:t4"),
    ].join("\n");
    const otherTab = [line(100, "open-start:t3"), line(340, "open-first-paint:t4")].join("\n");
    expect(metricOf(missing, OPEN)).toMatchObject({ ok: false });
    expect(metricOf(twice, OPEN)).toMatchObject({ ok: false });
    expect(metricOf(otherTab, OPEN)).toMatchObject({ ok: false });
    expect(metricOf(null, OPEN)).toMatchObject({ ok: false });
  });

  it("a paired metric adds up every start-to-done pair of the run", () => {
    const watch: Scenario = {
      id: "watch",
      title: "감시",
      file: "watch",
      from: "watch-batch-start",
      to: "watch-batch-done",
      pairs: true,
      targetMs: null,
    };
    const two = [
      line(10, "watch-batch-start"),
      line(14, "watch-batch-done"),
      line(300, "watch-batch-start"),
      line(306, "watch-batch-done"),
    ].join("\n");
    expect(metricOf(two, watch)).toEqual({ ok: true, value: 10 });
    expect(metricOf(line(10, "watch-batch-start"), watch)).toMatchObject({ ok: false });
    expect(metricOf("", watch)).toMatchObject({ ok: false });
  });

  it("in the background a metric timed to a frame cannot be measured and asks for no rerun", () => {
    const summary = summarize(OPEN, [null, null, null, null, null], { frameless: true });
    expect(summary).toMatchObject({ verdict: "실측 불가", rerun: false, invalid: 0 });
    expect(summary.reasons).toEqual(["background window: no animation frame"]);
    const cold = summarize(SCENARIOS[0], [null, null, null, null, null], { frameless: true });
    expect(cold).toMatchObject({ rerun: true, invalid: 5 });
  });

  it("judges the median against the target and twice the target", () => {
    expect(verdict(500, 500)).toBe("된다");
    expect(verdict(1000, 500)).toBe("조건부");
    expect(verdict(1001, 500)).toBe("안 된다");
    expect(verdict(5, null)).toBe("기록만");
  });

  it("two invalid runs ask for the scenario again; one is left out", () => {
    const good = (ms: number) =>
      [line(0, "open-start:t1"), line(ms, "open-first-paint:t1")].join("\n");
    const one = summarize(OPEN, [good(100), good(200), null, good(300), good(400)]);
    expect(one).toMatchObject({
      values: [100, 200, 300, 400],
      invalid: 1,
      median: 250,
      rerun: false,
    });
    expect(one.verdict).toBe("된다");
    const two = summarize(OPEN, [good(100), null, null, good(300), good(400)]);
    expect(two).toMatchObject({ invalid: 2, rerun: true });
  });
});
