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
const VALID_FRAME_MS: [number, number] = [8, 20];
// What the rule says when every valid run fails every step: the highlight guard's own length.
const FLOOR = 20_000;

interface Sample {
  label: string;
  keys: number;
  p50: number;
  p95: number;
  frameMs: number;
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

async function measure(page: Page, label: string, query: string): Promise<Sample> {
  await page.goto(`/tests/e2e/pages/editor.html?file=code.ts&${query}`);
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.evaluate(() => {
    const samples: number[] = [];
    const view = window.view;
    window.addEventListener(
      "keydown",
      () => {
        const t0 = performance.now();
        const before = view.state.doc;
        requestAnimationFrame(() => {
          if (view.state.doc !== before) samples.push(performance.now() - t0);
        });
      },
      true,
    );
    Object.assign(window, { __samples: samples });
  });
  const frameMs = await frameInterval(page);
  await page.keyboard.press("End");
  for (let i = 0; i < KEYS; i++) {
    await page.keyboard.type("abcdefghij"[i % 10]);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(200);
  const samples = await page.evaluate(
    () => (window as unknown as { __samples: number[] }).__samples,
  );
  return { label, keys: samples.length, p50: p(samples, 0.5), p95: p(samples, 0.95), frameMs };
}

test("long-line boundary", async ({ page }) => {
  const runs: Sample[][] = [];
  for (let run = 0; run < RUNS; run++) {
    const samples: Sample[] = [await measure(page, "baseline", `lines=${BASELINE_LINES}`)];
    for (const length of LADDER)
      samples.push(await measure(page, String(length), `longline=${length}`));
    runs.push(samples);
  }
  const verdicts = runs.map((samples) => {
    const baseline = samples[0];
    const T = baseline.frameMs;
    const valid = T >= VALID_FRAME_MS[0] && T <= VALID_FRAME_MS[1] && baseline.p95 <= 3 * T;
    const passes = samples.slice(1).map((s) => ({
      length: Number(s.label),
      delta: s.p95 - baseline.p95,
      ok: s.p95 - baseline.p95 <= T,
    }));
    return { valid, T, baseline, passes };
  });
  // `null` only when a run is invalid; valid runs with no passing step fall to FLOOR.
  let boundary: number | null = null;
  if (verdicts.every((v) => v.valid)) {
    boundary = FLOOR;
    for (const length of LADDER) {
      if (verdicts.every((v) => v.passes.find((x) => x.length === length)?.ok)) boundary = length;
      else break;
    }
  }
  const lines = [
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
  const summary =
    boundary === null
      ? "실측 불가 — 잠정값 1,000,000 유지"
      : `경계 ${boundary.toLocaleString("ko-KR")}자`;
  const table = lines.join("\n");
  console.log(`\n${table}\n\n${summary}\n`);
  mkdirSync(join(HERE, "results"), { recursive: true });
  writeFileSync(
    join(HERE, "results/long-line.json"),
    JSON.stringify({ runs, verdicts, boundary, table }, null, 2),
  );
});
