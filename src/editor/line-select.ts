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

/** The selection from the `anchor` lines to the `target` lines, whole lines, as VS Code selects
 * from its line numbers: down, from the anchor's start to past the target's line break; up, from
 * past the anchor's line break to the target's start. The last line has no line break to take. */
export function spanLines(
  anchor: LineSpan,
  target: LineSpan,
  length: number,
): { anchor: number; head: number } {
  const past = (to: number) => (to < length ? to + 1 : to);
  if (target.from >= anchor.from)
    return { anchor: anchor.from, head: past(Math.max(target.to, anchor.to)) };
  return { anchor: past(anchor.to), head: target.from };
}

const setLineAnchor = StateEffect.define<LineSpan>();

/** The lines a selection made from the gutter started on, while that selection stands: ⇧click
 * goes on from them. Any other change of the selection or the text forgets them. */
const lineAnchor = StateField.define<LineSpan | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLineAnchor)) return effect.value;
    return tr.docChanged || tr.selection ? null : value;
  },
});

/** Where ⇧click goes on from: the lines the gutter selection started on, or else the line of the
 * selection's anchor. */
export function anchorLines(state: EditorState): LineSpan {
  return (
    state.field(lineAnchor, false) ?? spanOf(state, state.doc.lineAt(state.selection.main.anchor))
  );
}

/** The transaction that selects from `anchor` to `target`, keeping `anchor` for a later ⇧click. */
export function selectLines(state: EditorState, anchor: LineSpan, target: LineSpan) {
  const { anchor: from, head } = spanLines(anchor, target, state.doc.length);
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
 * is held, scrolling when it is held past the editor's edge. With ⇧ it goes on from the lines the
 * selection started on. A change to the text while it is held (a key, another window's change, a
 * pane swapping in another tab's state) ends the drag: the anchor is a place in the old text. */
function pressLineNumber(view: EditorView, block: BlockInfo, down: Event): boolean {
  const event = down as MouseEvent;
  if (event.button !== 0 || event.ctrlKey) return false;
  let anchor: LineSpan | null = null;
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
    anchor = event.shiftKey ? anchorLines(view.state) : pressed;
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
