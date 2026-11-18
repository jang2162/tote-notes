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
import { bracketMatching, foldKeymap, indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Facet, Prec, type Extension } from "@codemirror/state";
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

import type { EditorIndent } from "../backend/types";
import { splitName } from "../core/names";
import { altMouseSelection } from "./alt-mouse";
import { folding, foldFits } from "./folding";
import { historyStaysWithTheKeys } from "./history-menu";
import { imageInput, type ImageHost } from "./image-paste";
import { multiRangeIme, redoWithCursors, undoWithCursors } from "./ime";
import { DEFAULT_LANGUAGE_DATA, type LanguageData } from "./language-config";
import { lineNumberGutter } from "./line-select";
import { searchBar, searchBarKeymap } from "./search-bar";

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
  { key: "Mod-Shift-z", run: redoWithCursors, preventDefault: true },
  { key: "Tab", run: insertIndent, shift: indentLess },
];

/** Every key binding of the editor, in the order they are tried. The shortcut settings read the
 * editor keys an app shortcut would hide from here (`editorBindings` in src/shortcuts/keys.ts). */
export const editorKeymap: readonly KeyBinding[] = [
  ...zedKeymap,
  ...closeBracketsKeymap,
  ...defaultKeymap,
  ...searchBarKeymap,
  ...searchKeymap,
  ...historyKeymap,
  ...foldKeymap,
];

const language = new Compartment();

/** Markdown gets its editing aids (list continuation) from the bundled parser and keymap. Colours
 * come from TextMate highlighting, so no highlight style is attached here. The registry's
 * language decides when there is one (an `.md` file shown as Python is not Markdown); without
 * one, the extension does. */
export function languageFor(fileName: string, languageId?: string): Extension {
  if (languageId !== undefined) return languageId === "markdown" ? markdown() : [];
  const ext = splitName(fileName).ext.toLowerCase();
  return ext === "md" || ext === "markdown" ? markdown() : [];
}

/** Switches the language of a state built by `editorExtensions` (after a rename or a pick). */
export function languageEffect(fileName: string, languageId?: string) {
  return language.reconfigure(languageFor(fileName, languageId));
}

const configuration = new Compartment();

// Ahead of the bundled parser's data (Markdown's `<!--` comment): the configuration file is
// what decides ⌘/ and bracket closing.
function languageDataExtension(data: LanguageData): Extension {
  return Prec.high(EditorState.languageData.of(() => [data]));
}

/** Swaps the language-configuration data of a state built by `editorExtensions`. */
export function languageDataEffect(data: LanguageData) {
  return configuration.reconfigure(languageDataExtension(data));
}

const lineNumberSlot = new Compartment();

/** Shows or hides the gutter of a state built by `editorExtensions` (the line-number setting). */
export function lineNumbersEffect(on: boolean) {
  return lineNumberSlot.reconfigure(on ? lineNumberGutter() : []);
}

const wrapSlot = new Compartment();

/** Whether the state's lines were short enough to wrap when it was made (`WRAP_LIMIT` in
 * src/app/docs.ts); the wrap setting cannot turn wrapping on where they were not. */
const wrapFitsFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.every(Boolean),
});

function wrapping(on: boolean, fits: boolean): Extension {
  return on && fits ? EditorView.lineWrapping : [];
}

/** Turns soft wrap on or off in `state`, built by `editorExtensions` (the wrap setting). */
export function wrapEffect(state: EditorState, on: boolean) {
  return wrapSlot.reconfigure(wrapping(on, state.facet(wrapFitsFacet)));
}

const indentSlot = new Compartment();

const INDENT_UNITS: Record<EditorIndent, string> = {
  "spaces-2": "  ",
  "spaces-4": "    ",
  tab: "\t",
};

/** A tab is four columns wide whatever the indent setting: CodeMirror's default, which the editor
 * showed before there was a setting. */
const TAB_SIZE = 4;

function indentation(indent: EditorIndent): Extension {
  return [indentUnit.of(INDENT_UNITS[indent]), EditorState.tabSize.of(TAB_SIZE)];
}

/** Swaps the indent unit of a state built by `editorExtensions` (the indent setting). */
export function indentEffect(indent: EditorIndent) {
  return indentSlot.reconfigure(indentation(indent));
}

const foldSlot = new Compartment();

/** Shows or hides the fold markers of `state`, built by `editorExtensions` (the fold setting). */
export function foldGutterEffect(state: EditorState, on: boolean) {
  return foldSlot.reconfigure(folding({ fits: state.facet(foldFits), gutter: on }));
}

const menuKeySlot = new Compartment();

function menuKeys(bindings: readonly KeyBinding[]): Extension {
  return Prec.highest(keymap.of(bindings));
}

/** Swaps the app shortcuts that win over the editor's keys in a state built by `editorExtensions`
 * (`menuKeymap` in src/shortcuts/keys.ts). */
export function menuKeysEffect(bindings: readonly KeyBinding[]) {
  return menuKeySlot.reconfigure(menuKeys(bindings));
}

/** The editor's font, as CSS values. */
export interface EditorFont {
  family: string;
  size: string;
}

const fontSlot = new Compartment();

/** The font goes in through the theme, not only the CSS variables: CodeMirror reads its line
 * heights again only when its theme changes or it redraws, since the content is as tall as the
 * pane whatever the font. Read through the variables alone, a new font size left the line numbers
 * at the old line height until the window was resized. */
function fontTheme(font: EditorFont): Extension {
  return EditorView.theme({ ".cm-scroller": { fontFamily: font.family, fontSize: font.size } });
}

/** Swaps the font of a state built by `editorExtensions` (the font settings). */
export function fontEffect(font: EditorFont) {
  return fontSlot.reconfigure(fontTheme(font));
}

const highlightSlot = new Compartment();

/** Swaps the TextMate colours of a state built by `editorExtensions` (`workerHighlighting`'s
 * extension, or nothing). */
export function highlightEffect(extension: Extension) {
  return highlightSlot.reconfigure(extension);
}

/** The text's line height, in ems of the text. */
const LINE_HEIGHT = 1.55;
/** The line numbers' text size against the body's (memo trash spec 「줄번호 글자 크기」). */
const LINE_NUMBER_SCALE = 0.85;

/** Colours come from the CSS variables in styles.css, which the theme manager fills from the selected theme. */
const appTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)" },
  // CodeMirror's own theme draws a dotted ring round the focused editor, right under the tab bar;
  // the cursor and the current line already say where the keys go.
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { lineHeight: String(LINE_HEIGHT) },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--line-number, var(--muted))",
    border: "none",
  },
  // The smaller numbers keep the body's line height, in their own ems, so each sits in the middle
  // of a line box as tall as its line's.
  ".cm-lineNumbers .cm-gutterElement": {
    fontSize: `${LINE_NUMBER_SCALE}em`,
    lineHeight: `${LINE_HEIGHT / LINE_NUMBER_SCALE}em`,
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--active-line)",
    color: "var(--line-number-active, var(--fg))",
  },
  ".cm-content": { caretColor: "var(--cursor)", padding: "8px 0" },
  ".cm-line": { padding: "0 16px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--cursor)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--search-match-current)",
    outline: "1px solid var(--search-match-border)",
  },
  ".cm-panels": { backgroundColor: "var(--panel-bg)", color: "var(--fg)" },
  "&.cm-focused .cm-matchingBracket, .cm-matchingBracket": {
    backgroundColor: "var(--bracket-match)",
    outline: "1px solid var(--bracket-match-border)",
  },
  "&.cm-focused .cm-nonmatchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "transparent",
    color: "var(--danger)",
  },
  ".cm-foldGutter .cm-gutterElement": {
    padding: "0 4px",
    cursor: "pointer",
    color: "var(--line-number, var(--muted))",
  },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--fg)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--panel-bg)",
    border: "1px solid var(--border)",
    color: "var(--muted)",
    margin: "0 2px",
    padding: "0 4px",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
});

export interface EditorOptions {
  fileName: string;
  /** The registry's language id for the file, when it has one (`languageFor`). */
  languageId?: string;
  /** Soft wrap (the setting). */
  wrap: boolean;
  /** The lines are short enough to wrap cheaply (`WRAP_LIMIT` in src/app/docs.ts); when not, the
   * state never wraps. True when absent. */
  wrapFits?: boolean;
  /** The indent setting; two spaces when absent. */
  indent?: EditorIndent;
  /** The fold markers (the setting); shown when absent. */
  foldGutter?: boolean;
  /** The text is short enough to fold (`foldsAt` in src/editor/folding.ts); when not, nothing
   * folds. True when absent. */
  foldFits?: boolean;
  /** The line-number gutter (the editor setting). */
  lineNumbers: boolean;
  /** The font settings; styles.css's `--editor-font` and `--editor-size` when absent. */
  font?: EditorFont;
  /** The app shortcuts that are editor keys too, which run the app command instead
   * (`menuKeymap`); none when absent. */
  menuKeys?: readonly KeyBinding[];
  onUpdate: (update: ViewUpdate) => void;
  /** From the language's configuration file: comment tokens, bracket pairs, word characters. */
  languageData?: LanguageData;
  /** TextMate colours (`workerHighlighting`); absent for plain text and over the size limit. */
  highlight?: Extension;
  /** A trashed memo: nothing edits the text, whatever key, paste, drop or command tries. */
  readOnly?: boolean;
  /** A memo's: pasted and dropped images go into its workspace (src/editor/image-paste.ts). */
  images?: ImageHost;
}

/** CodeMirror's read-only flag turns away typing, paste, drop and its own commands; the filter
 * also stops the app's commands that dispatch changes themselves (Tab's `insertIndent`, the
 * multi-cursor composition). Focus, selection, copy and the find bar still work. */
const readOnly: Extension = [
  EditorState.readOnly.of(true),
  EditorState.changeFilter.of(() => false),
];

export function editorExtensions(options: EditorOptions): Extension[] {
  return [
    history(),
    historyStaysWithTheKeys,
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    altMouseSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSpecialChars(),
    highlightSelectionMatches(),
    bracketMatching(),
    closeBrackets(),
    searchBar(),
    multiRangeIme,
    wrapFitsFacet.of(options.wrapFits ?? true),
    wrapSlot.of(wrapping(options.wrap, options.wrapFits ?? true)),
    indentSlot.of(indentation(options.indent ?? "spaces-2")),
    language.of(languageFor(options.fileName, options.languageId)),
    configuration.of(languageDataExtension(options.languageData ?? DEFAULT_LANGUAGE_DATA)),
    menuKeySlot.of(menuKeys(options.menuKeys ?? [])),
    keymap.of(editorKeymap),
    lineNumberSlot.of(options.lineNumbers ? lineNumberGutter() : []),
    foldFits.of(options.foldFits ?? true),
    foldSlot.of(folding({ fits: options.foldFits ?? true, gutter: options.foldGutter ?? true })),
    fontSlot.of(
      fontTheme(options.font ?? { family: "var(--editor-font)", size: "var(--editor-size)" }),
    ),
    highlightSlot.of(options.highlight ?? []),
    appTheme,
    options.readOnly ? readOnly : [],
    options.images ? imageInput(options.images) : [],
    EditorView.updateListener.of(options.onUpdate),
  ];
}
