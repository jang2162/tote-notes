import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  copyLineDown,
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  selectLine,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  type Command,
  type KeyBinding,
  type ViewUpdate,
} from "@codemirror/view";

import { splitName } from "../core/names";
import { altMouseSelection } from "./alt-mouse";
import { multiRangeIme, undoWithCursors } from "./ime";
import { DEFAULT_LANGUAGE_DATA, type LanguageData } from "./language-config";

/** Tab: an indent unit at every cursor; with text selected, indents the selected lines. */
export const insertIndent: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
  view.dispatch(
    state.update(state.replaceSelection(state.facet(indentUnit)), {
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/** The Zed bindings CodeMirror's keymaps lack or bind elsewhere; the rest of the plan's key table
 * is CodeMirror's default. */
export const zedKeymap: KeyBinding[] = [
  { key: "Mod-l", run: selectLine, preventDefault: true },
  { key: "Mod-Shift-d", run: copyLineDown, preventDefault: true },
  { key: "Mod-z", run: undoWithCursors, preventDefault: true },
  { key: "Tab", run: insertIndent, shift: indentLess },
];

const language = new Compartment();

/** Markdown gets its editing aids (list continuation) from the bundled parser and keymap. Colours
 * come later from TextMate highlighting, so no highlight style is attached here. */
export function languageFor(fileName: string): Extension {
  const ext = splitName(fileName).ext.toLowerCase();
  return ext === "md" || ext === "markdown" ? markdown() : [];
}

/** Switches the language of a state built by `editorExtensions` (after a rename). */
export function languageEffect(fileName: string) {
  return language.reconfigure(languageFor(fileName));
}

const configuration = new Compartment();

function languageDataExtension(data: LanguageData): Extension {
  return EditorState.languageData.of(() => [data]);
}

/** Swaps the language-configuration data of a state built by `editorExtensions`. */
export function languageDataEffect(data: LanguageData) {
  return configuration.reconfigure(languageDataExtension(data));
}

/** Colours come from the CSS variables in styles.css, which a later plan fills from the theme. */
const appTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font)",
    fontSize: "var(--editor-size)",
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--cursor)", padding: "8px 0" },
  ".cm-line": { padding: "0 16px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--cursor)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  ".cm-panels": { backgroundColor: "var(--panel-bg)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
});

export interface EditorOptions {
  fileName: string;
  /** Soft wrap; off when a line is too long to wrap cheaply (`WRAP_LIMIT` in src/app/docs.ts). */
  wrap: boolean;
  onUpdate: (update: ViewUpdate) => void;
  /** From the language's configuration file: comment tokens, bracket pairs, word characters. */
  languageData?: LanguageData;
}

export function editorExtensions(options: EditorOptions): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    altMouseSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSpecialChars(),
    highlightSelectionMatches(),
    closeBrackets(),
    search({ top: true }),
    multiRangeIme,
    options.wrap ? EditorView.lineWrapping : [],
    language.of(languageFor(options.fileName)),
    configuration.of(languageDataExtension(options.languageData ?? DEFAULT_LANGUAGE_DATA)),
    keymap.of([
      ...zedKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
    ]),
    appTheme,
    EditorView.updateListener.of(options.onUpdate),
  ];
}
