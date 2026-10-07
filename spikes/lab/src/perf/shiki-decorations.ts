import { type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import type { Engine, Lang, WorkerReply } from "./worker-protocol";

const setHighlight = StateEffect.define<DecorationSet>();

// Decorations live in a field so the async worker reply can replace them with a plain dispatch,
// and edits in between just map the old ones instead of dropping all color.
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setHighlight)) return e.value;
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const highlightCount = (view: EditorView): number => view.state.field(highlightField).size;

export function decorationsIn(view: EditorView, from: number, to: number): number {
  let count = 0;
  view.state.field(highlightField).between(from, to, () => {
    count++;
  });
  return count;
}

export interface LineDecoration {
  /** Offset from the start of the line. */
  start: number;
  length: number;
  style: string;
}

/** Decorations that lie inside one line (1-based), as plain data so two lines can be compared. */
export function lineDecorations(view: EditorView, lineNo: number): LineDecoration[] {
  const line = view.state.doc.line(lineNo);
  const found: LineDecoration[] = [];
  view.state.field(highlightField).between(line.from, line.to, (from, to, value) => {
    if (from < line.from || to > line.to) return;
    found.push({ start: from - line.from, length: to - from, style: value.spec.attributes.style });
  });
  return found;
}

type TokensReply = Extract<WorkerReply, { type: "tokens-result" }>;

export function workerHighlighting(worker: Worker, engine: Engine, lang: Lang): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private version = 0;
      private reqId = 0;
      private pending: { reqId: number; version: number } | null = null;
      private timer: ReturnType<typeof setTimeout> | null = null;

      constructor(private readonly view: EditorView) {
        worker.postMessage({ type: "open", engine, lang, text: view.state.doc.toString() });
        worker.addEventListener("message", this.onMessage);
        this.schedule();
      }

      update(u: ViewUpdate): void {
        if (u.docChanged) {
          this.version++;
          this.sendEdit(u);
        }
        if (u.docChanged || u.viewportChanged) this.schedule();
      }

      destroy(): void {
        worker.removeEventListener("message", this.onMessage);
        if (this.timer) clearTimeout(this.timer);
      }

      private onMessage = (e: MessageEvent<WorkerReply>): void => {
        const pending = this.pending;
        if (e.data.type !== "tokens-result" || !pending || e.data.reqId !== pending.reqId) return;
        const stale = pending.version !== this.version;
        this.pending = null;
        // Tokens for an older document would land on the wrong characters; ask again instead.
        if (stale) return this.schedule();
        this.view.dispatch({ effects: setHighlight.of(this.build(e.data)) });
      };

      // One edit message per transaction: replace the old line span covering every change
      // with the new line span, which also stays correct for multi-cursor edits.
      private sendEdit(u: ViewUpdate): void {
        let fromA = Infinity;
        let toA = -1;
        let fromB = Infinity;
        let toB = -1;
        u.changes.iterChangedRanges((fa, ta, fb, tb) => {
          fromA = Math.min(fromA, fa);
          toA = Math.max(toA, ta);
          fromB = Math.min(fromB, fb);
          toB = Math.max(toB, tb);
        });
        const oldDoc = u.startState.doc;
        const newDoc = u.state.doc;
        const firstLine = newDoc.lineAt(fromB).number;
        const lastLine = newDoc.lineAt(toB).number;
        worker.postMessage({
          type: "edit",
          fromLine: oldDoc.lineAt(fromA).number - 1,
          toLine: oldDoc.lineAt(toA).number,
          insert: newDoc
            .sliceString(newDoc.line(firstLine).from, newDoc.line(lastLine).to)
            .split("\n"),
        });
      }

      private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.request(), 30);
      }

      private request(): void {
        const doc = this.view.state.doc;
        const { from, to } = this.view.viewport;
        this.pending = { reqId: ++this.reqId, version: this.version };
        worker.postMessage({
          type: "tokens",
          reqId: this.reqId,
          from: doc.lineAt(from).number - 1,
          to: doc.lineAt(to).number,
        });
      }

      private build(reply: TokensReply): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = this.view.state.doc;
        reply.lines.forEach((tokens, i) => {
          const lineNo = reply.from + i + 1;
          if (lineNo > doc.lines) return;
          const line = doc.line(lineNo);
          for (const t of tokens) {
            if (!t.color || t.content.length === 0) continue;
            const from = line.from + t.offset;
            const to = Math.min(from + t.content.length, line.to);
            if (from < to)
              builder.add(from, to, Decoration.mark({ attributes: { style: `color:${t.color}` } }));
          }
        });
        return builder.finish();
      }
    },
  );
  return [highlightField, plugin];
}
