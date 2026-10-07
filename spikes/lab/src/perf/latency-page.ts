import { EditorView, basicSetup } from "codemirror";

import { recordResult } from "../lab-api";
import { makeCodeFixture, makeLogFixture, makeSingleLineJson } from "./fixtures";
import { highlightCount, workerHighlighting } from "./shiki-decorations";
import { summarize } from "./stats";
import type { Engine, Lang, WorkerReply } from "./worker-protocol";

export const LATENCY_FIXTURES: Record<string, { lang: Lang; make: () => string }> = {
  // Baseline of the same session: same code generator and worker pipeline, 253 lines.
  "code-small": { lang: "typescript", make: () => makeCodeFixture(6_000) },
  "code-10mb": { lang: "typescript", make: () => makeCodeFixture(10_000_000) },
  "json-10mb-one-line": { lang: "json", make: () => makeSingleLineJson(10_000_000) },
  "log-100k": { lang: "log", make: () => makeLogFixture(100_000) },
};

export interface OpenedEditor {
  view: EditorView;
  openMs: number;
  /** `error` replies plus `worker.onerror` events so far; counted only, highlighting is unchanged. */
  workerErrors(): number;
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
  let workerErrors = 0;
  worker.addEventListener("message", (e: MessageEvent<WorkerReply>) => {
    if (e.data.type === "error") workerErrors++;
  });
  worker.addEventListener("error", () => {
    workerErrors++;
  });
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
        workerErrors: () => workerErrors,
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

interface KeySample {
  key: string;
  /** True for IME composition keys (`isComposing` or keyCode 229). */
  isComposing: boolean;
  /** Whether the document changed between the keydown and the paint after it. */
  docChanged: boolean;
  ms: number;
}

interface Session {
  editor: OpenedEditor;
  fixture: string;
  engine: Engine;
  keys: KeySample[];
  frames: number[];
  /** Every rAF interval while the session ran, to know the real refresh period. */
  intervals: number[];
  stop(): void;
}

const MENU_LINK = `<a href="#">← 메뉴</a>`;

export function mountLatencyPage(root: HTMLElement): void {
  root.innerHTML = `
    <style>#lat-editor .cm-editor{height:100%}</style>
    <p>${MENU_LINK}</p>
    <h1>입력 지연 측정</h1>
    <p>파일과 엔진을 고르고 「열기」. 편집기를 눌러 20초 이상 영문으로만 타이핑하고, 크게 스크롤한 뒤(json 한 줄 파일은 가로로) 「저장」. 한글은 저장한 뒤에 쳐서 눈으로만 본다. 창을 다른 창으로 가리지 않는다. 파일마다 따로 열어 저장한다.</p>
    <select id="lat-fixture">${Object.keys(LATENCY_FIXTURES)
      .map((k) => `<option>${k}</option>`)
      .join("")}</select>
    <select id="lat-engine"><option>oniguruma</option><option>javascript</option></select>
    <button id="lat-open">열기</button> <button id="lat-save">저장</button>
    <div id="lat-save-status"></div>
    <pre id="lat-stats"></pre>
    <div id="lat-editor" style="height:65vh;border:1px solid #888;overflow:hidden"></div>`;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  let current: Session | null = null;

  const snapshot = (s: Session) => ({
    fixture: s.fixture,
    engine: s.engine,
    openMs: s.editor.openMs,
    // Only keys that changed the document: Shift, arrows and PageDown just wait for a frame.
    keys: summarize(s.keys.filter((k) => k.docChanged).map((k) => k.ms)),
    keyEvents: s.keys.length,
    composingKeys: s.keys.filter((k) => k.isComposing).length,
    composingKeysChanged: s.keys.filter((k) => k.isComposing && k.docChanged).length,
    // Judge keys.p95 against the baseline fixture of the same session, in units of this period.
    frameIntervalMs: summarize(s.intervals).p50,
    frameIntervalSamples: s.intervals.length,
    scrollFrames: s.frames.length,
    scrollFramesOver25ms: s.frames.filter((f) => f > 25).length,
    highlightDecorations: highlightCount(s.editor.view),
    workerErrors: s.editor.workerErrors(),
  });

  const openButton = $<HTMLButtonElement>("#lat-open");
  openButton.addEventListener("click", async () => {
    // Making a 10MB fixture blocks the page, so a second click would otherwise build a second editor.
    openButton.disabled = true;
    try {
      current?.stop();
      current = null;
      $("#lat-editor").replaceChildren();
      $("#lat-save-status").textContent = "";
      const fixture = $<HTMLSelectElement>("#lat-fixture").value;
      const engine = $<HTMLSelectElement>("#lat-engine").value as Engine;
      const { lang, make } = LATENCY_FIXTURES[fixture];
      $("#lat-stats").textContent = "여는 중…";
      const editor = await openEditor($("#lat-editor"), make(), engine, lang);
      const keys: KeySample[] = [];
      const frames: number[] = [];
      const intervals: number[] = [];
      const session: Session = {
        editor,
        fixture,
        engine,
        keys,
        frames,
        intervals,
        stop: () => undefined,
      };
      const render = () => {
        $("#lat-stats").textContent = JSON.stringify(snapshot(session), null, 2);
      };
      // Capture on an ancestor so this runs before CodeMirror's own keydown listener: keymap edits
      // (Enter, Backspace, Delete) change the document synchronously inside that listener.
      editor.view.dom.addEventListener(
        "keydown",
        (e) => {
          const start = e.timeStamp;
          const docBefore = editor.view.state.doc;
          const key = e.key;
          const isComposing = e.isComposing || e.keyCode === 229;
          // rAF runs right before the paint; the timeout lands just after it.
          requestAnimationFrame(() =>
            setTimeout(() => {
              keys.push({
                key,
                isComposing,
                docChanged: editor.view.state.doc !== docBefore,
                ms: performance.now() - start,
              });
              render();
            }, 0),
          );
        },
        { capture: true },
      );
      let lastScroll = -Infinity;
      editor.view.scrollDOM.addEventListener("scroll", () => {
        lastScroll = performance.now();
      });
      let prev = performance.now();
      let raf = 0;
      const loop = (t: number) => {
        intervals.push(t - prev);
        if (t - lastScroll < 100) frames.push(t - prev);
        prev = t;
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      // Highlight state arrives asynchronously, so the panel also refreshes without key presses.
      const timer = setInterval(render, 500);
      session.stop = () => {
        cancelAnimationFrame(raf);
        clearInterval(timer);
        editor.destroy();
      };
      current = session;
      render();
    } finally {
      openButton.disabled = false;
    }
  });

  $("#lat-save").addEventListener("click", async () => {
    const session = current;
    if (!session) return;
    const status = $("#lat-save-status");
    // Taken before the await: opening another file while saving must not change what is reported.
    const saved = snapshot(session);
    try {
      await recordResult(`latency-${session.fixture}-${session.engine}`, {
        userAgent: navigator.userAgent,
        ...saved,
        keySamples: session.keys,
      });
      status.textContent = `저장됨 (keys ${saved.keys.count}개)`;
    } catch (err) {
      status.textContent = `저장 실패: ${String(err)}`;
    }
  });
}
