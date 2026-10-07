import { EditorView, basicSetup } from "codemirror";

import { recordResult } from "../lab-api";
import { makeCodeFixture, makeLogFixture, makeSingleLineJson } from "./fixtures";
import { workerHighlighting } from "./shiki-decorations";
import { summarize } from "./stats";
import type { Engine, Lang } from "./worker-protocol";

export const LATENCY_FIXTURES: Record<string, { lang: Lang; make: () => string }> = {
  "code-10mb": { lang: "typescript", make: () => makeCodeFixture(10_000_000) },
  "json-10mb-one-line": { lang: "json", make: () => makeSingleLineJson(10_000_000) },
  "log-100k": { lang: "log", make: () => makeLogFixture(100_000) },
};

export interface OpenedEditor {
  view: EditorView;
  openMs: number;
  destroy(): void;
}

/** Resolves after the first frame following creation; falls back to 1s when frames are throttled. */
export function openEditor(
  parent: HTMLElement,
  text: string,
  engine: Engine,
  lang: Lang,
): Promise<OpenedEditor> {
  const worker = new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module" });
  const t0 = performance.now();
  const view = new EditorView({
    doc: text,
    parent,
    extensions: [basicSetup, workerHighlighting(worker, engine, lang)],
  });
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve({
        view,
        openMs: performance.now() - t0,
        destroy() {
          view.destroy();
          worker.terminate();
        },
      });
    };
    requestAnimationFrame(done);
    setTimeout(done, 1_000);
  });
}

interface Session {
  editor: OpenedEditor;
  fixture: string;
  engine: Engine;
  keys: number[];
  frames: number[];
  stop(): void;
}

export function mountLatencyPage(root: HTMLElement): void {
  root.innerHTML = `
    <h1>입력 지연 측정</h1>
    <p>파일과 엔진을 고르고 「열기」. 편집기를 눌러 20초 이상 타이핑(영문·한글 섞어서)하고, 위아래로 크게 스크롤한 뒤 「저장」. 창을 다른 창으로 가리지 않는다.</p>
    <select id="lat-fixture">${Object.keys(LATENCY_FIXTURES)
      .map((k) => `<option>${k}</option>`)
      .join("")}</select>
    <select id="lat-engine"><option>oniguruma</option><option>javascript</option></select>
    <button id="lat-open">열기</button> <button id="lat-save">저장</button>
    <pre id="lat-stats"></pre>
    <div id="lat-editor" style="height:65vh;border:1px solid #888;overflow:hidden"></div>`;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  let current: Session | null = null;

  const snapshot = (s: Session) => ({
    fixture: s.fixture,
    engine: s.engine,
    openMs: s.editor.openMs,
    keys: summarize(s.keys),
    scrollFrames: s.frames.length,
    scrollFramesOver25ms: s.frames.filter((f) => f > 25).length,
  });

  $("#lat-open").addEventListener("click", async () => {
    current?.stop();
    current = null;
    const fixture = $<HTMLSelectElement>("#lat-fixture").value;
    const engine = $<HTMLSelectElement>("#lat-engine").value as Engine;
    const { lang, make } = LATENCY_FIXTURES[fixture];
    $("#lat-stats").textContent = "여는 중…";
    const editor = await openEditor($("#lat-editor"), make(), engine, lang);
    const keys: number[] = [];
    const frames: number[] = [];
    const session: Session = { editor, fixture, engine, keys, frames, stop: () => undefined };
    const render = () => {
      $("#lat-stats").textContent = JSON.stringify(snapshot(session), null, 2);
    };
    editor.view.contentDOM.addEventListener("keydown", (e) => {
      const start = e.timeStamp;
      // rAF runs right before the paint; the timeout lands just after it.
      requestAnimationFrame(() =>
        setTimeout(() => {
          keys.push(performance.now() - start);
          render();
        }, 0),
      );
    });
    let lastScroll = -Infinity;
    editor.view.scrollDOM.addEventListener("scroll", () => {
      lastScroll = performance.now();
    });
    let prev = performance.now();
    let raf = 0;
    const loop = (t: number) => {
      if (t - lastScroll < 100) frames.push(t - prev);
      prev = t;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    session.stop = () => {
      cancelAnimationFrame(raf);
      editor.destroy();
    };
    current = session;
    render();
  });

  $("#lat-save").addEventListener("click", async () => {
    if (!current) return;
    await recordResult(`latency-${current.fixture}-${current.engine}`, {
      userAgent: navigator.userAgent,
      ...snapshot(current),
      keySamples: current.keys,
    });
    $("#lat-stats").textContent += "\n저장됨";
  });
}
