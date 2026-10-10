import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import type { LanguageInfo } from "../backend/types";
import type { HighlightClient } from "./client";

/** Above this (UTF-16 units, the way the memo size is measured) highlighting is off and the
 * document is never sent to the worker (spec 「크기별 단계」 — 20MB). Counting characters, not
 * bytes, is the approximation `LARGE_MEMO_CHARS` makes too: text that is mostly Hangul (three
 * UTF-8 bytes a character) stays highlighted up to about 60MB. */
export const HIGHLIGHT_LIMIT_CHARS = 20_000_000;
/** Viewport and edit requests settle for this long before the worker is asked. */
const REQUEST_DELAY_MS = 30;

const setHighlight = StateEffect.define<DecorationSet>();

// Decorations live in a field so the async worker reply can replace them with a plain dispatch,
// and edits in between map the old ones instead of dropping all colour.
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setHighlight)) return e.value;
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const marks = new Map<string, Decoration>();
function mark(foreground: number, fontStyle: number): Decoration {
  const classes = [`tm-c${foreground}`];
  if (fontStyle & 1) classes.push("tm-i");
  if (fontStyle & 2) classes.push("tm-b");
  if (fontStyle & 4) classes.push("tm-u");
  if (fontStyle & 8) classes.push("tm-s");
  const key = classes.join(" ");
  let deco = marks.get(key);
  if (!deco) {
    deco = Decoration.mark({ class: key });
    marks.set(key, deco);
  }
  return deco;
}

/** TextMate colours for one editor state. The worker gets the text on creation, every change
 * as a line replacement, and a request for the visible lines after each change or scroll. */
export function workerHighlighting(client: HighlightClient, lang: LanguageInfo): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private readonly doc = client.nextDocId();
      private version = 0;
      private open: Promise<boolean>;
      private timer: ReturnType<typeof setTimeout> | null = null;
      private destroyed = false;
      private readonly unsubscribe: () => void;

      constructor(private readonly view: EditorView) {
        this.open = client.open(this.doc, lang, view.state.doc.toString());
        void this.open.then((ok) => ok && this.schedule());
        // The decorations carry the old theme's colour ids until they are asked for again.
        this.unsubscribe = client.onThemeChange(() => this.schedule());
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.version++;
          this.sendEdit(update);
        }
        if (update.docChanged || update.viewportChanged) this.schedule();
      }

      destroy(): void {
        this.destroyed = true;
        this.unsubscribe();
        if (this.timer) clearTimeout(this.timer);
        client.close(this.doc);
      }

      // One edit message per update: the old line span covering every change becomes the new
      // line span, which stays right for multi-cursor edits too.
      private sendEdit(update: ViewUpdate): void {
        let fromA = Infinity;
        let toA = -1;
        let fromB = Infinity;
        let toB = -1;
        update.changes.iterChangedRanges((fa, ta, fb, tb) => {
          fromA = Math.min(fromA, fa);
          toA = Math.max(toA, ta);
          fromB = Math.min(fromB, fb);
          toB = Math.max(toB, tb);
        });
        const oldDoc = update.startState.doc;
        const newDoc = update.state.doc;
        const firstLine = newDoc.lineAt(fromB).number;
        const lastLine = newDoc.lineAt(toB).number;
        client.edit(
          this.doc,
          oldDoc.lineAt(fromA).number - 1,
          oldDoc.lineAt(toA).number,
          newDoc.sliceString(newDoc.line(firstLine).from, newDoc.line(lastLine).to).split("\n"),
        );
      }

      private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.request(), REQUEST_DELAY_MS);
      }

      private async request(): Promise<void> {
        if (!(await this.open) || this.destroyed) return;
        const version = this.version;
        const { from, to } = this.view.viewport;
        const doc = this.view.state.doc;
        const first = doc.lineAt(from).number - 1;
        const lines = await client.tokens(this.doc, first, doc.lineAt(to).number);
        if (!lines || this.destroyed) return;
        // Tokens for an older document would land on the wrong characters; ask again instead.
        if (version !== this.version) return this.schedule();
        this.view.dispatch({ effects: setHighlight.of(this.build(first, lines)) });
      }

      private build(first: number, lines: Uint32Array[]): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = this.view.state.doc;
        lines.forEach((tokens, i) => {
          const lineNo = first + i + 1;
          if (lineNo > doc.lines) return;
          const line = doc.line(lineNo);
          for (let t = 0; t < tokens.length; t += 3) {
            const start = line.from + tokens[t];
            const end = t + 3 < tokens.length ? line.from + tokens[t + 3] : line.to;
            if (start < end && end <= line.to)
              builder.add(start, end, mark(tokens[t + 1], tokens[t + 2]));
          }
        });
        return builder.finish();
      }
    },
  );
  return [highlightField, plugin];
}
