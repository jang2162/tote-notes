/** Reads the runs `scripts/measure-perf.sh` collected and judges them by the pre-registered rules
 * (tests/measure/perf.md): `node scripts/perf-summary.ts <results dir>` prints a Markdown table;
 * `--check <file> <results dir>` exits 1 when a scenario of the runs named `<file>` has two or
 * more invalid runs and must be run again. `--frameless`: the runs were made in the background,
 * where the scenarios timed to an animation frame cannot be measured. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNS = 5;

export interface Scenario {
  id: string;
  title: string;
  /** The runs are `perf-<file>-<1..5>.jsonl`; two scenarios may read the same runs. */
  file: string;
  /** Mark names; one ending in `:` stands for any one `<from><key>`, and `to` then must be the
   * same key's (the same tab, the same search). */
  from: string;
  /** Absent: the metric is the `value` of the single `from` line, not a difference. */
  to?: string;
  /** `from` and `to` come in pairs, as many as there were: the metric is the sum of the pairs. */
  pairs?: boolean;
  /** Milliseconds; `null` when the scenario is only recorded. */
  targetMs: number | null;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "cold-start",
    title: "콜드 스타트",
    file: "cold-start",
    from: "process-start",
    to: "app-ready",
    targetMs: 1500,
  },
  ...(
    [
      ["open-ts-10mb", "파일 열기 code-10mb.ts", 500],
      ["open-md-10mb", "파일 열기 code-10mb.md", 500],
      ["open-ts-100mb", "파일 열기 code-100mb.ts", 1000],
      ["open-json-10mb", "파일 열기 json-10mb-one-line.json", 1000],
      ["open-log-100k", "파일 열기 log-100k.log", 500],
    ] as const
  ).map(([file, title, targetMs]) => ({
    id: file,
    title,
    file,
    from: "open-start:",
    to: "open-first-paint:",
    targetMs,
  })),
  ...(
    [
      ["open-ts-10mb", "첫 색칠 code-10mb.ts"],
      ["open-md-10mb", "첫 색칠 code-10mb.md"],
    ] as const
  ).map(([file, title]) => ({
    id: `tokens-${file.slice("open-".length)}`,
    title,
    file,
    from: "open-start:",
    to: "open-first-tokens:",
    targetMs: 1500,
  })),
  {
    id: "list-10k",
    title: "메모 목록 첫 수신 메모 1만 개",
    file: "list-10k",
    from: "process-start",
    to: "memos-listed",
    targetMs: 1500,
  },
  {
    id: "list-10k-ready",
    title: "콜드 스타트 메모 1만 개",
    file: "list-10k",
    from: "process-start",
    to: "app-ready",
    targetMs: 1500,
  },
  {
    id: "restore-50",
    title: "세션 복원 탭 50개",
    file: "restore-50",
    from: "process-start",
    to: "restore-done",
    targetMs: 1000,
  },
  {
    id: "search-literal",
    title: "검색 메모 1만 개 (needle-50)",
    file: "search-literal",
    from: "search-start:",
    to: "search-done:",
    targetMs: 1000,
  },
  {
    id: "search-regex",
    title: "검색 정규식 (needle-\\d+5$)",
    file: "search-regex",
    from: "search-start:",
    to: "search-done:",
    targetMs: 2000,
  },
  ...(
    [
      ["watch-10k", "감시 배치, 메모 1만 개 워크스페이스에 저장 하나"],
      ["watch-50", "감시 배치, 메모 50개 워크스페이스에 저장 하나(비교 기준)"],
    ] as const
  ).map(([file, title]) => ({
    id: file,
    title,
    file,
    from: "watch-batch-start",
    to: "watch-batch-done",
    pairs: true,
    targetMs: null,
  })),
  {
    id: "memory",
    title: "메모리 RSS(KB), code-100mb.ts 뷰어 10초 뒤",
    file: "memory",
    from: "rss-kb",
    targetMs: null,
  },
];

interface Mark {
  t: number;
  name: string;
  value?: number;
}

export type Metric = { ok: true; value: number } | { ok: false; reason: string };

function parse(text: string): Mark[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Mark);
}

/** The lines named `name`, or whose name starts with it when it ends in `:`. */
const matching = (marks: Mark[], name: string) =>
  marks.filter((mark) => (name.endsWith(":") ? mark.name.startsWith(name) : mark.name === name));

/** One run's metric. A run without its marks, or with one of them twice, is invalid. */
export function metricOf(text: string | null, scenario: Scenario): Metric {
  if (text === null) return { ok: false, reason: "no perf.jsonl" };
  let marks: Mark[];
  try {
    marks = parse(text);
  } catch {
    return { ok: false, reason: "a line is not JSON" };
  }
  if (scenario.pairs) return pairsOf(marks, scenario);
  const from = matching(marks, scenario.from);
  if (from.length !== 1) return { ok: false, reason: `${from.length} × ${scenario.from}` };
  if (scenario.to === undefined) {
    const value = from[0].value;
    return typeof value === "number" ? { ok: true, value } : { ok: false, reason: "no value" };
  }
  const to = matching(marks, scenario.to);
  if (to.length !== 1) return { ok: false, reason: `${to.length} × ${scenario.to}` };
  const key = scenario.from.endsWith(":") ? from[0].name.slice(scenario.from.length) : "";
  if (scenario.to.endsWith(":") && to[0].name !== scenario.to + key)
    return { ok: false, reason: `${to[0].name} does not follow ${from[0].name}` };
  return { ok: true, value: to[0].t - from[0].t };
}

/** The sum of `from` → `to` pairs, each `to` the next mark after its `from`. */
function pairsOf(marks: Mark[], scenario: Scenario): Metric {
  const ends = marks.filter((mark) => mark.name === scenario.from || mark.name === scenario.to);
  if (!ends.length) return { ok: false, reason: `no ${scenario.from}` };
  let sum = 0;
  for (let i = 0; i < ends.length; i += 2) {
    const [start, done] = [ends[i], ends[i + 1]];
    if (start.name !== scenario.from || done?.name !== scenario.to)
      return { ok: false, reason: `unpaired ${start.name} at ${start.t}` };
    sum += done.t - start.t;
  }
  return { ok: true, value: sum };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest rank: of five runs, the largest. */
export function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

export type Verdict = "된다" | "조건부" | "안 된다" | "기록만" | "실측 불가";

export function verdict(medianMs: number, targetMs: number | null): Verdict {
  if (targetMs === null) return "기록만";
  if (medianMs <= targetMs) return "된다";
  return medianMs <= 2 * targetMs ? "조건부" : "안 된다";
}

export interface Summary {
  scenario: Scenario;
  /** The valid runs' values, in run order. */
  values: number[];
  invalid: number;
  reasons: string[];
  median: number | null;
  p95: number | null;
  verdict: Verdict;
  /** Two or more invalid runs: the whole scenario is run again (once). */
  rerun: boolean;
}

/** Marks a window makes in an animation frame, which a background window (TOTE_BACKGROUND) never
 * gets: a scenario ending in one is measured with the window on screen only. */
const FRAME_MARKS = ["open-first-paint:", "restore-done"];

export function summarize(
  scenario: Scenario,
  runs: (string | null)[],
  options: { frameless?: boolean } = {},
): Summary {
  if (options.frameless && FRAME_MARKS.includes(scenario.to ?? "")) {
    return {
      scenario,
      values: [],
      invalid: 0,
      reasons: ["background window: no animation frame"],
      median: null,
      p95: null,
      verdict: "실측 불가",
      rerun: false,
    };
  }
  const values: number[] = [];
  const reasons: string[] = [];
  runs.forEach((text, i) => {
    const metric = metricOf(text, scenario);
    if (metric.ok) values.push(metric.value);
    else reasons.push(`run ${i + 1}: ${metric.reason}`);
  });
  const invalid = runs.length - values.length;
  const rerun = invalid >= 2;
  const mid = values.length ? median(values) : null;
  return {
    scenario,
    values,
    invalid,
    reasons,
    median: mid,
    p95: values.length ? p95(values) : null,
    verdict: rerun || mid === null ? "실측 불가" : verdict(mid, scenario.targetMs),
    rerun,
  };
}

function readRuns(dir: string, file: string): (string | null)[] {
  return Array.from({ length: RUNS }, (_, i) => {
    const path = join(dir, `perf-${file}-${i + 1}.jsonl`);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  });
}

const fmt = (value: number | null) => (value === null ? "—" : value.toFixed(1));

export function table(summaries: Summary[]): string {
  const rows = summaries.map((s) =>
    [
      s.scenario.title,
      s.scenario.targetMs === null ? "—" : String(s.scenario.targetMs),
      s.values.map((v) => v.toFixed(1)).join(", ") || "—",
      fmt(s.median),
      fmt(s.p95),
      String(s.invalid),
      s.verdict,
    ].join(" | "),
  );
  return [
    "| 시나리오 | 목표(ms) | 회별 값 | 중앙값 | p95 | 무효 | 판정 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const frameless = process.argv.includes("--frameless");
  const args = process.argv.slice(2).filter((arg) => arg !== "--frameless");
  if (args[0] === "--check") {
    const [, file, dir] = args;
    const summaries = SCENARIOS.filter((s) => s.file === file).map((s) =>
      summarize(s, readRuns(dir, file), { frameless }),
    );
    for (const s of summaries)
      for (const reason of s.reasons) console.error(`${s.scenario.id}: ${reason}`);
    process.exit(summaries.some((s) => s.rerun) ? 1 : 0);
  }
  const dir = args[0];
  if (!dir) {
    console.error("usage: node scripts/perf-summary.ts [--check <file>] <results dir>");
    process.exit(2);
  }
  const summaries = SCENARIOS.map((s) => summarize(s, readRuns(dir, s.file), { frameless }));
  console.log(table(summaries));
  for (const s of summaries)
    for (const reason of s.reasons) console.log(`- ${s.scenario.id} 무효: ${reason}`);
}
