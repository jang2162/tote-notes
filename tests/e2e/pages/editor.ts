import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorExtensions } from "../../../src/editor/setup";

const params = new URLSearchParams(location.search);
const view = new EditorView({
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc: params.get("doc") ?? "",
    extensions: editorExtensions({
      fileName: params.get("file") ?? "note.md",
      wrap: true,
      onUpdate: () => {},
    }),
  }),
});
view.focus();
// The specs drive and inspect the editor through these.
Object.assign(window, { view, EditorSelection });
