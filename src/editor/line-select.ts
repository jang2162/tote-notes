import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { EditorView, lineNumbers, type BlockInfo } from "@codemirror/view";

import { settleComposition } from "./compose";

/** Whole lines: from the start of the first to the end of the last, its line break left out. */
export interface LineSpan {
  from: number;
  to: number;
}

/** The lines a gutter row stands for: one line, or every line of a block that holds several. */
export function spanOf(state: EditorState, block: { from: number; to: number }): LineSpan {
  return { from: state.doc.lineAt(block.from).from, to: state.doc.lineAt(block.to).to };
}

/** Where a selection by lines goes on from: the lines a gutter press started on, or the point a
 * selection made in the text is anchored at. */
export type LineAnchor = LineSpan | number;

/** The selection from `anchor` to the `target` lines, the head by whole lines: down, to the
 * target's end; up, to the target's start. The last line break is left out, unlike VS Code (the
 * user asked for it), so an empty line on its own is a cursor at its start. From lines, the anchor
 * is the start of them going down and their end going up, so they stay selected. From a point,
 * the anchor stays at the point, and on the point's own line the head comes back to it. */
export function spanLines(anchor: LineAnchor, target: LineSpan): { anchor: number; head: number } {
  if (typeof anchor === "number") {
    if (target.from > anchor) return { anchor, head: target.to };
    if (target.to < anchor) return { anchor, head: target.from };
    return { anchor, head: anchor };
  }
  if (target.from >= anchor.from)
    return { anchor: anchor.from, head: Math.max(target.to, anchor.to) };
  return { anchor: anchor.to, head: target.from };
}

const setLineAnchor = StateEffect.define<LineAnchor>();

/** Where a selection made from the gutter went on from, while that selection stands: ⇧click goes
 * on from there. An upward selection's anchor sits at the end of the line pressed, and going down
 * from that point would leave the line behind. Any other change of the selection or the text
 * forgets it. */
const lineAnchor = StateField.define<LineAnchor | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLineAnchor)) return effect.value;
    return tr.docChanged || tr.selection ? null : value;
  },
});

/** Where ⇧click goes on from: where the gutter selection went on from, or else the selection's
 * anchor, left where it is (VS Code). */
export function selectionAnchor(state: EditorState): LineAnchor {
  return state.field(lineAnchor, false) ?? state.selection.main.anchor;
}

/** The transaction that selects from `anchor` to `target`, keeping `anchor` for a later ⇧click. */
export function selectLines(state: EditorState, anchor: LineAnchor, target: LineSpan) {
  const { anchor: from, head } = spanLines(anchor, target);
  return state.update({
    selection: EditorSelection.single(from, head),
    effects: setLineAnchor.of(anchor),
    userEvent: "select.pointer",
  });
}

/** How far past the editor's top or bottom edge the pointer is, in pixels; 0 inside. */
function overshoot(view: EditorView, y: number): number {
  const rect = view.scrollDOM.getBoundingClientRect();
  return y < rect.top ? y - rect.top : y > rect.bottom ? y - rect.bottom : 0;
}

/** A press on the line numbers: selects that line, and the lines the pointer passes over while it
 * is held, scrolling when it is held past the editor's edge. With ⇧ it goes on from where the
 * selection started (`selectionAnchor`). A change to the text while it is held (a key, another window's change, a
 * pane swapping in another tab's state) ends the drag: the anchor is a place in the old text. */
function pressLineNumber(view: EditorView, block: BlockInfo, down: Event): boolean {
  const event = down as MouseEvent;
  if (event.button !== 0 || event.ctrlKey) return false;
  let anchor: LineAnchor | null = null;
  let doc = view.state.doc;
  let last = event.clientY;
  const selectAt = (y: number) => {
    if (!anchor) return;
    if (view.state.doc !== doc) return end();
    const target = view.lineBlockAtHeight(y - view.documentTop);
    view.dispatch(selectLines(view.state, anchor, spanOf(view.state, target)));
  };
  const scroll = setInterval(() => {
    const by = overshoot(view, last);
    if (!by) return;
    view.scrollDOM.scrollTop += by;
    selectAt(last);
  }, 50);
  const move = (moved: MouseEvent) => {
    if (moved.buttons === 0) return end();
    last = moved.clientY;
    selectAt(last);
  };
  const end = () => {
    clearInterval(scroll);
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", end);
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", end);
  // The pressed row, read again once Hangul being typed has landed: the text may have moved.
  const row = block.top + block.height / 2;
  const begin = () => {
    view.focus();
    doc = view.state.doc;
    const pressed = spanOf(view.state, view.lineBlockAtHeight(row));
    anchor = event.shiftKey ? selectionAnchor(view.state) : pressed;
    view.dispatch(selectLines(view.state, anchor, pressed));
    if (last !== event.clientY) selectAt(last);
  };
  // The press's default is prevented, so the focus goes neither to the gutter nor to the pane
  // around it (focusable); the editor takes it here. Hangul being typed lands first, where it was
  // typed, before the selection moves over it.
  if (view.composing) void settleComposition(view).then(begin);
  else begin();
  return true;
}

/** The line-number gutter, which selects lines when pressed (spec 「줄번호와 편집기 설정」). */
export function lineNumberGutter(): Extension {
  return [lineAnchor, lineNumbers({ domEventHandlers: { mousedown: pressLineNumber } })];
}
