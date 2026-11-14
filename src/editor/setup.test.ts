import { insertNewlineAndIndent, toggleComment } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { EditorState, type Transaction } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import type { EditorIndent } from "../backend/types";
import {
  editorExtensions,
  indentEffect,
  insertIndent,
  languageDataEffect,
  wrapEffect,
  type EditorOptions,
} from "./setup";

describe("languageDataEffect", () => {
  it("swaps the comment tokens ⌘/ uses in a state built by editorExtensions", () => {
    let state = EditorState.create({
      doc: "x",
      extensions: editorExtensions({
        fileName: "a.txt",
        wrap: false,
        lineNumbers: false,
        onUpdate: () => {},
        languageData: { commentTokens: { line: "//" } },
      }),
    });
    const toggle = () =>
      toggleComment({
        state,
        dispatch: (tr: Transaction) => {
          state = tr.state;
        },
      });
    toggle();
    expect(state.doc.toString()).toBe("// x");
    toggle();
    state = state.update({ effects: languageDataEffect({ commentTokens: { line: "#" } }) }).state;
    toggle();
    expect(state.doc.toString()).toBe("# x");
  });
});

function stateWith(options: Partial<EditorOptions> = {}, doc = "x") {
  return EditorState.create({
    doc,
    extensions: editorExtensions({
      fileName: "a.txt",
      wrap: true,
      lineNumbers: false,
      onUpdate: () => {},
      ...options,
    }),
  });
}

describe("the indent setting", () => {
  it("sets the indent unit and keeps a tab four columns wide", () => {
    const unit = (s: EditorState) => [s.facet(indentUnit), s.tabSize];
    expect(unit(stateWith())).toEqual(["  ", 4]);
    expect(unit(stateWith({ indent: "spaces-2" }))).toEqual(["  ", 4]);
    expect(unit(stateWith({ indent: "spaces-4" }))).toEqual(["    ", 4]);
    expect(unit(stateWith({ indent: "tab" }))).toEqual(["\t", 4]);
    const changed = stateWith().update({ effects: indentEffect("tab") }).state;
    expect(unit(changed)).toEqual(["\t", 4]);
  });

  it("is what Tab puts in at the cursor, and ↩ indents with it", () => {
    const press = (indent: EditorIndent, command: Command, doc = "x") => {
      let s = stateWith({ indent }, doc);
      s = s.update({ selection: { anchor: doc.length } }).state;
      command({
        state: s,
        dispatch: (tr: Transaction) => {
          s = tr.state;
        },
      } as unknown as EditorView);
      return s.doc.toString();
    };
    expect(press("spaces-2", insertIndent)).toBe("x  ");
    expect(press("spaces-4", insertIndent)).toBe("x    ");
    expect(press("tab", insertIndent)).toBe("x\t");
    // The line's indentation is written again in the chosen unit.
    expect(press("tab", insertNewlineAndIndent, "    x")).toBe("    x\n\t");
    expect(press("spaces-2", insertNewlineAndIndent, "\tx")).toBe("\tx\n    ");
  });
});

describe("the wrap setting", () => {
  const wraps = (s: EditorState) =>
    s.facet(EditorView.contentAttributes).some((attrs) => {
      const value = typeof attrs === "function" ? null : attrs.class;
      return value?.includes("cm-lineWrapping") ?? false;
    });

  it("wraps when it is on and the lines are short enough", () => {
    expect(wraps(stateWith({ wrap: true }))).toBe(true);
    expect(wraps(stateWith({ wrap: false }))).toBe(false);
    expect(wraps(stateWith({ wrap: true, wrapFits: false }))).toBe(false);
  });

  it("switches in a state, and stays off where a line is too long", () => {
    const on = stateWith({ wrap: true });
    const off = on.update({ effects: wrapEffect(on, false) }).state;
    expect(wraps(off)).toBe(false);
    expect(wraps(off.update({ effects: wrapEffect(off, true) }).state)).toBe(true);
    const long = stateWith({ wrap: false, wrapFits: false });
    expect(wraps(long.update({ effects: wrapEffect(long, true) }).state)).toBe(false);
  });
});
