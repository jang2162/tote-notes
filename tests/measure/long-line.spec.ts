import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));

// The pre-registered rule of Task 14: the ladder, the metric, the pass line and the validity
// bounds. Nothing here changes after a run is looked at.
const LADDER = [20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
const BASELINE_LINES = 253;
const KEYS = 60;
const FRAME_SAMPLES = 120;
const RUNS = 2;
// `LONG_LINE_LIMIT` is one value for every format, so each of these is measured and the smaller
// boundary wins: code (no parser) and the memo default Markdown (Lezer parser attached).
const FILES = ["code.ts", "note.md"];
const VALID_FRAME_MS: [number, number] = [8, 20];
// What the rule says when every valid run fails every step: the highlight guard's own length.
const FLOOR = 20_000;

interface Sample {
  label: string;
  keys: number;
  p50: number;
  p95: number;
  frameMs: number;
  /** Every counted key's latency, in typing order. */
  samples: number[];
}

const p = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

async function frameInterval(page: Page): Promise<number> {
  const gaps = await page.evaluate(
    (n) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        let last = performance.now();
        const tick = (now: number) => {
          out.push(now - last);
          last = now;
          if (out.length >= n) resolve(out.slice(1));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    FRAME_SAMPLES,
  );
  return p(gaps, 0.5);
}

async function measure(page: Page, file: string, label: string, query: string): Promise<Sample> {
  await page.goto(`/tests/e2e/pages/editor.html?file=${file}&${query}`);
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.evaluate(() => {
    const samples: number[] = [];
    const view = window.view;
    // As the spike does (spikes/lab/src/perf/latency-page.ts): start at the keydown's own
    // timestamp, captured before CodeMirror's listener, end just after the paint (rAF, then a
    // timeout).
    view.dom.addEventListener(
      "keydown",
      (e) => {
        const start = e.timeStamp;
        const before = view.state.doc;
        requestAnimationFrame(() =>
          setTimeout(() => {
            if (view.state.doc !== before) samples.push(performance.now() - start);
          }, 0),
        );
      },
      { capture: true },
    );
    Object.assign(window, { __samples: samples });
  });
  const frameMs = await frameInterval(page);
  await page.keyboard.press("End");
  // `End` scrolls a long line; its own rAF must settle before the first counted key.
  await page.waitForTimeout(500);
  const before = await page.evaluate(
    () => (window as unknown as { __samples: number[] }).__samples.length,
  );
  for (let i = 0; i < KEYS; i++) {
    await page.keyboard.type("abcdefghij"[i % 10]);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(500);
  const all = await page.evaluate(() => (window as unknown as { __samples: number[] }).__samples);
  const samples = all.slice(before);
  return {
    label,
    keys: samples.length,
    p50: p(samples, 0.5),
    p95: p(samples, 0.95),
    frameMs,
    samples,
  };
}

test("long-line boundary", async ({ page }) => {
  const perFile: Record<
    string,
    { runs: Sample[][]; verdicts: ReturnType<typeof verdictOf>[]; boundary: number | null }
  > = {};
  const tables: string[] = [];
  for (const file of FILES) {
    const runs: Sample[][] = [];
    for (let run = 0; run < RUNS; run++) {
      const samples: Sample[] = [await measure(page, file, "baseline", `lines=${BASELINE_LINES}`)];
      for (const length of LADDER)
        samples.push(await measure(page, file, String(length), `longline=${length}`));
      runs.push(samples);
    }
    const verdicts = runs.map(verdictOf);
    // `null` only when a run is invalid; valid runs with no passing step fall to FLOOR.
    let boundary: number | null = null;
    if (verdicts.every((v) => v.valid)) {
      boundary = FLOOR;
      for (const length of LADDER) {
        if (verdicts.every((v) => v.passes.find((x) => x.length === length)?.ok)) boundary = length;
        else break;
      }
    }
    perFile[file] = { runs, verdicts, boundary };
    const lines = [
      `### ${file}`,
      "",
      "| run | label | keys | p50 | p95 | p95 − baseline | frame | verdict |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    runs.forEach((samples, run) => {
      const v = verdicts[run];
      for (const s of samples) {
        const pass = v.passes.find((x) => x.length === Number(s.label));
        lines.push(
          `| ${run + 1}${v.valid ? "" : " (invalid)"} | ${s.label} | ${s.keys} | ${s.p50.toFixed(1)} | ${s.p95.toFixed(1)} | ${pass ? pass.delta.toFixed(1) : "—"} | ${s.frameMs.toFixed(1)} | ${pass ? (pass.ok ? "된다" : "안 된다") : "기준선"} |`,
        );
      }
    });
    tables.push(lines.join("\n"));
  }
  const boundaries = FILES.map((f) => perFile[f].boundary);
  const boundary = boundaries.some((b) => b === null)
    ? null
    : Math.min(...(boundaries as number[]));
  const summary =
    boundary === null
      ? "실측 불가 — 잠정값 1,000,000 유지"
      : `경계 ${boundary.toLocaleString("ko-KR")}자 (${FILES.map((f) => `${f} ${perFile[f].boundary?.toLocaleString("ko-KR")}`).join(", ")} 중 작은 값)`;
  const table = tables.join("\n\n");
  console.log(`\n${table}\n\n${summary}\n`);
  mkdirSync(join(HERE, "results"), { recursive: true });
  writeFileSync(
    join(HERE, "results/long-line.json"),
    JSON.stringify({ perFile, boundary, table }, null, 2),
  );
});

function verdictOf(samples: Sample[]) {
  const baseline = samples[0];
  const T = baseline.frameMs;
  const valid = T >= VALID_FRAME_MS[0] && T <= VALID_FRAME_MS[1] && baseline.p95 <= 3 * T;
  const passes = samples.slice(1).map((s) => ({
    length: Number(s.label),
    delta: s.p95 - baseline.p95,
    ok: s.p95 - baseline.p95 <= T,
  }));
  return { valid, T, baseline, passes };
}
