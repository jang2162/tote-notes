import { toggleComment } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { editorExtensions, languageDataEffect } from "./setup";

describe("languageDataEffect", () => {
  it("swaps the comment tokens ⌘/ uses in a state built by editorExtensions", () => {
    let state = EditorState.create({
      doc: "x",
      extensions: editorExtensions({
        fileName: "a.txt",
        wrap: false,
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
