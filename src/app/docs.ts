import { EditorState, type EditorSelection, type Extension, type Text } from "@codemirror/state";

import {
  errorCode,
  type Backend,
  type FileSource,
  type LanguageInfo,
  type MemoInfo,
} from "../backend/types";
import { decodeText, encodeText, longestLine, type Eol } from "../core/codec";
import { detectLanguage } from "../core/language";
import { basename, splitName } from "../core/names";
import type { WriteScheduler } from "../core/scheduler";
import { restoreSelection, type SelectionJSON, type ViewMode } from "../core/session";
import { memoTitle, titleLine } from "../core/title";
import type { LanguageData } from "../editor/language-config";

// Spec 「저장」·「크기별 단계」.
export const MEMO_SAVE_DELAY_MS = 500;
export const LARGE_MEMO_SAVE_DELAY_MS = 3000;
/** The spec's 1 MB, measured in UTF-16 units: counting UTF-8 bytes on every keystroke would cost
 * what the longer delay saves. */
export const LARGE_MEMO_CHARS = 1_000_000;
export const DRAFT_DELAY_MS = 1000;
/** Bigger files wait for the large text viewer (a later plan) instead of loading into the editor.
 * Same value as `MAX_EDITOR_BYTES` in src-tauri/src/persist/external.rs. */
export const MAX_EDITOR_BYTES = 100 * 1024 * 1024;
/** Soft wrap stays off above this line length (the same limit highlighting uses): wrapping one
 * huge line costs seconds. */
export const WRAP_LIMIT = 20_000;

export const RECOVERED_NOTICE = "원래 파일을 찾지 못해 새 메모로 저장했습니다";
export const DRAFT_RESTORED_NOTICE =
  "보관한 수정분을 복원했습니다 — 그사이 디스크의 파일이 바뀌었습니다";

/** `binary`: the kind (by file name) is not text, so the bytes were not read; `not-utf8`: they
 * were read as text and are not UTF-8 (or hold a NUL). */
export type Problem = "binary" | "not-utf8" | "too-large" | "missing" | "unreadable";
export type Change = "info" | "language" | "dirty" | "saved" | "deleted" | "notice" | "error";
export type CloseAsk = () => Promise<"save" | "discard" | "cancel">;

/** What a document needs from the window around it. */
export interface DocHost {
  backend: Backend;
  writes: WriteScheduler;
  /** Editor extensions for a state of `doc` holding `text`, including the listener that calls
   * `doc.update`. */
  extensions(doc: Doc, options: { wrap: boolean; text: string }): Extension[];
  /** The language-configuration data of `doc`'s language (`{}` when it has none). */
  languageConfig(lang: LanguageInfo | undefined): Promise<LanguageData>;
  languageOf(doc: Doc): LanguageInfo | undefined;
  /** Every language the registry knows, one per id (the picker's list). */
  languages(): LanguageInfo[];
  /** Something the tab bar, memo list or status bar shows about `doc` changed. */
  changed(doc: Doc, change: Change): void;
}

/** The parts of a CodeMirror `ViewUpdate` a document reacts to. */
export interface DocUpdate {
  state: EditorState;
  startState: EditorState;
  docChanged: boolean;
  selectionSet: boolean;
}

/** A memo's tab title: Markdown memos drop `.md`; anything else keeps its extension. */
export function displayName(file: string): string {
  const { stem, ext } = splitName(file);
  return ext.toLowerCase() === "md" ? stem : file;
}

export function isBlank(text: Text): boolean {
  for (const iter = text.iter(); !iter.next().done;) {
    if (/\S/.test(iter.value)) return false;
  }
  return true;
}

const cursorLine = (state: EditorState) => state.doc.lineAt(state.selection.main.head).number;

/** The main cursor just left the title line (the first non-blank one): time for the title. */
export function leftTitleLine(update: DocUpdate): boolean {
  return (
    cursorLine(update.startState) === titleLine(update.startState.doc).number &&
    cursorLine(update.state) !== titleLine(update.state.doc).number
  );
}

/** The main cursor just left line 1, where a shebang sits: time for language detection. Not the
 * title moment — the title skips a shebang, so its line is further down. */
export function leftFirstLine(update: DocUpdate): boolean {
  return cursorLine(update.startState) === 1 && cursorLine(update.state) !== 1;
}

/** One tab's document. The editor view shows the active one; every document keeps its own
 * `EditorState`, so switching tabs keeps undo history, selection and scroll. */
export abstract class Doc {
  abstract readonly kind: "memo" | "external";
  /** Names the tab. A memo tab keeps it when its memo changes (save recovery, import). */
  readonly tabId = crypto.randomUUID();
  state: EditorState | null = null;
  problem: Problem | null = null;
  error: unknown = null;
  notice: string | null = null;
  /** Document position at the top of the viewport, kept in the session. */
  scrollAnchor = 0;
  /** Edit or preview; only Markdown tabs ever leave "edit" (Task 12). */
  mode: ViewMode = "edit";
  /** The language the person picked in the status bar (`null`: decided by the file name). A memo
   * mirrors `info.language`; an external file keeps it in the session. */
  language: string | null = null;
  /** Comment tokens, brackets and word characters of the language (its configuration file). */
  languageData: LanguageData = {};
  /** The session's selection, applied when the text first loads. */
  restoreSelection: SelectionJSON | undefined;
  /** 「텍스트로 열기」: read the bytes as text no matter what the kind says. */
  forceText = false;
  protected eol: Eol = "\n";
  protected bom = false;
  private loading: Promise<void> | null = null;
  /** Counts `refreshLanguage` calls: only the latest one's answer is applied. */
  private languageRequest = 0;

  constructor(protected readonly host: DocHost) {}

  abstract get fileName(): string;
  abstract get source(): FileSource;
  abstract get title(): string;
  abstract get hint(): string;
  abstract get dirty(): boolean;
  /** The tab lost focus: write what is pending. */
  abstract leave(): Promise<void>;
  /** The window closes or the app quits: write everything, without asking. */
  abstract flush(): Promise<void>;
  /** The tab is closing; `false` keeps it open. */
  abstract close(ask: CloseAsk): Promise<boolean>;
  protected abstract read(): Promise<Uint8Array | Problem>;
  protected abstract edited(): void;
  protected loaded(): void {}

  get selectionJSON(): SelectionJSON | undefined {
    return this.state ? (this.state.selection.toJSON() as SelectionJSON) : this.restoreSelection;
  }

  /** Reads the file the first time the tab is shown (spec 「세션」 — lazy loading). */
  ensureLoaded(): Promise<void> {
    if (this.state || this.problem) return Promise.resolve();
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  update(update: DocUpdate): void {
    this.state = update.state;
    if (update.docChanged) this.edited();
  }

  /** Reloads the language-configuration data for the current language and tells the host, which
   * reconfigures the editor (comment tokens, brackets, highlighting). */
  async refreshLanguage(): Promise<void> {
    const request = ++this.languageRequest;
    const data = await this.host.languageConfig(this.host.languageOf(this));
    // Overtaken by a later change, whose answer may already be in: this one is for an old language.
    if (request !== this.languageRequest) return;
    this.languageData = data;
    this.host.changed(this, "language");
  }

  async openAsText(): Promise<void> {
    this.mode = "edit";
    this.forceText = true;
    this.problem = null;
    this.state = null;
    await this.ensureLoaded();
  }

  /** The language picked in the status bar. */
  abstract changeLanguage(lang: LanguageInfo): Promise<void>;

  protected encode(text: Text): Uint8Array {
    return encodeText(text.sliceString(0, text.length, this.eol), this.bom);
  }

  protected fail(error: unknown): void {
    this.error = error;
    this.host.changed(this, "error");
  }

  /** For text set without a read: the state is built at once and the language data follows. */
  protected fetchLanguageData(): void {
    void this.refreshLanguage();
  }

  /** Builds the editor state for `text`, with `selection` or else the session's. */
  protected setText(text: string, selection?: EditorSelection): void {
    let state = EditorState.create({
      doc: text,
      extensions: this.host.extensions(this, { wrap: longestLine(text) <= WRAP_LIMIT, text }),
    });
    const wanted =
      selection ?? (this.restoreSelection && restoreSelection(this.restoreSelection, state.doc));
    if (wanted) state = state.update({ selection: wanted }).state;
    this.state = state;
  }

  private async load(): Promise<void> {
    let bytes: Uint8Array | Problem;
    try {
      bytes = await this.read();
    } catch (error) {
      const code = errorCode(error);
      this.problem = code === "not-found" || code === "unknown-memo" ? "missing" : "unreadable";
      this.error = error;
      return;
    }
    if (typeof bytes === "string") {
      this.problem = bytes;
      return;
    }
    const decoded = decodeText(bytes);
    if (!decoded) {
      this.problem = "not-utf8";
      return;
    }
    this.eol = decoded.eol;
    this.bom = decoded.bom;
    this.languageData = await this.host.languageConfig(this.host.languageOf(this));
    this.setText(decoded.text);
    this.loaded();
  }
}

export class MemoDoc extends Doc {
  readonly kind = "memo" as const;
  private savedText: Text | null = null;
  private retitling: Promise<void> | null = null;
  private detecting: Promise<void> | null = null;

  constructor(
    host: DocHost,
    public info: MemoInfo,
  ) {
    super(host);
    this.language = info.language ?? null;
  }

  get fileName() {
    return this.info.file;
  }
  get source(): FileSource {
    return { kind: "memo", id: this.info.id };
  }
  get title() {
    return displayName(this.info.file);
  }
  get hint() {
    return this.info.file;
  }
  /** Memos save themselves; their tab never carries the unsaved mark. */
  get dirty() {
    return false;
  }
  private get saveKey() {
    return `${this.tabId}:save`;
  }

  /** A memo created empty skips the read. */
  startEmpty(): void {
    this.fetchLanguageData();
    this.setText("");
    this.loaded();
  }

  /** Takes over text, selection and line format from the tab it replaces (an import), whose text
   * is exactly what the import wrote. */
  adopt(from: EditorState, format: { eol: Eol; bom: boolean }): void {
    this.eol = format.eol;
    this.bom = format.bom;
    this.fetchLanguageData();
    this.setText(from.doc.toString(), from.selection);
    this.loaded();
  }

  protected loaded(): void {
    this.savedText = this.state?.doc ?? null;
  }

  protected async read(): Promise<Uint8Array | Problem> {
    if (!this.forceText && this.info.kind !== "text") return "binary";
    if (this.info.size > MAX_EDITOR_BYTES) return "too-large";
    return this.host.backend.readMemo(this.info.id);
  }

  protected edited(): void {
    const large = (this.state?.doc.length ?? 0) > LARGE_MEMO_CHARS;
    this.host.writes.schedule(
      this.saveKey,
      large ? LARGE_MEMO_SAVE_DELAY_MS : MEMO_SAVE_DELAY_MS,
      () => this.save(),
    );
  }

  update(update: DocUpdate): void {
    super.update(update);
    if (!(update.docChanged || update.selectionSet)) return;
    if (leftTitleLine(update)) void this.retitle();
    if (leftFirstLine(update)) void this.detect();
  }

  async save(): Promise<void> {
    const text = this.state?.doc;
    if (!text || text === this.savedText) return;
    try {
      this.setInfo(await this.host.backend.writeMemo(this.info.id, this.encode(text)));
    } catch (error) {
      if (errorCode(error) !== "unknown-memo") return this.fail(error);
      // The file went away under us (renamed or deleted in Finder). Typed text must survive, so
      // it becomes a new memo instead of failing every save from here on.
      try {
        this.setInfo(await this.recover(this.encode(text)));
      } catch (again) {
        return this.fail(again);
      }
      this.notice = RECOVERED_NOTICE;
      this.host.changed(this, "notice");
    }
    this.savedText = text;
    this.error = null;
    this.host.changed(this, "saved");
  }

  /** One call per name, under the old name first: a create-then-write pair would leave an empty
   * memo behind whenever the write fails, and would turn `deploy.sh` into `untitled.md`. The
   * name is checked before anything is made, so an `invalid-name` try leaves nothing behind. The
   * fallbacks are for files tote cannot name itself (a `할 일?.md` made in Finder). */
  private async recover(bytes: Uint8Array): Promise<MemoInfo> {
    const { ext } = splitName(this.info.file);
    const names = [this.info.file, ext ? `untitled.${ext}` : "untitled", "untitled.md"];
    for (const [i, name] of names.entries()) {
      try {
        return await this.host.backend.importMemo(name, bytes);
      } catch (error) {
        if (errorCode(error) !== "invalid-name" || i === names.length - 1) throw error;
      }
    }
    throw new Error("unreachable");
  }

  /** A save that failed has left the scheduler's slot empty, so `flush` alone would write nothing
   * and the text typed since would be lost on close; one more try costs nothing when it is saved. */
  async saveNow(): Promise<void> {
    await this.host.writes.flush(this.saveKey);
    if (this.unsaved) {
      this.host.writes.schedule(this.saveKey, 0, () => this.save());
      await this.host.writes.flush(this.saveKey);
    }
  }

  private get unsaved(): boolean {
    return this.state !== null && this.state.doc !== this.savedText;
  }

  /** Applies the automatic title (spec 「제목 자동 생성」). Cheap to call often: the backend is
   * asked only when the title differs from the file name. */
  retitle(): Promise<void> {
    if (!this.info.autoTitle || !this.state) return Promise.resolve();
    const stem = memoTitle(this.state.doc);
    if (stem === splitName(this.info.file).stem) return Promise.resolve();
    this.retitling ??= this.host.backend
      .retitleMemo(this.info.id, stem)
      .then(
        (info) => this.setInfo(info),
        (error: unknown) => this.fail(error),
      )
      .finally(() => {
        this.retitling = null;
      });
    return this.retitling;
  }

  /** A name the person chose; automatic titles stop for this memo. */
  async rename(file: string): Promise<void> {
    await this.saveNow();
    this.setInfo(await this.host.backend.renameMemo(this.info.id, file));
  }

  /** Spec 「편집기」: the file takes the language's first extension, the index keeps the id. */
  async changeLanguage(lang: LanguageInfo): Promise<void> {
    await this.saveNow();
    const ext = lang.extensions[0] ?? splitName(this.info.file).ext;
    this.info = await this.host.backend.setMemoLanguage(this.info.id, lang.id, ext);
    this.language = lang.id;
    this.host.changed(this, "info");
    await this.refreshLanguage();
  }

  /** Automatic detection (spec 「편집기」): only a `.md` memo without a language whose name tote
   * still gives (a name the person chose is not undone), only up and away from Markdown, when the
   * cursor leaves line 1 and when the tab is left. */
  private detect(): Promise<void> {
    this.detecting ??= this.runDetect().finally(() => {
      this.detecting = null;
    });
    return this.detecting;
  }

  private async runDetect(): Promise<void> {
    // A title rename in flight goes first: both move the file, and the later answer wins.
    await this.retitling;
    if (
      this.info.language ||
      !this.info.autoTitle ||
      splitName(this.info.file).ext.toLowerCase() !== "md" ||
      !this.state
    )
      return;
    const found = detectLanguage(this.state.doc, this.host.languages());
    if (!found || found.id === "markdown") return;
    try {
      await this.changeLanguage(found);
    } catch (error) {
      this.fail(error);
    }
  }

  async leave(): Promise<void> {
    await this.saveNow();
    await this.retitle();
    await this.detect();
  }

  flush(): Promise<void> {
    return this.leave();
  }

  async close(): Promise<boolean> {
    await this.saveNow();
    // Still unsaved: keep the tab, and the text in it, rather than lose what the error was about.
    if (this.unsaved) return false;
    // An empty new memo leaves no file behind (spec 「세션」); "new" means tote still names it.
    if (this.info.autoTitle && this.state && isBlank(this.state.doc)) {
      try {
        await this.host.backend.deleteMemo(this.info.id);
        this.host.changed(this, "deleted");
      } catch (error) {
        this.fail(error);
      }
      return true;
    }
    await this.retitle();
    return true;
  }

  private setInfo(info: MemoInfo): void {
    const extensionChanged = splitName(info.file).ext !== splitName(this.info.file).ext;
    this.info = info;
    this.language = info.language ?? null;
    this.host.changed(this, "info");
    // A new extension is a new language: its configuration is read, then the editor follows.
    if (extensionChanged) void this.refreshLanguage();
  }
}

export class ExternalDoc extends Doc {
  readonly kind = "external" as const;
  /** Edited since the last ⌘S (or restored from a draft). */
  modified = false;
  exists = false;
  /** Bytes on disk when the file was read; a viewer is told it. */
  size = 0;
  private draftFailed = false;

  constructor(
    host: DocHost,
    readonly path: string,
  ) {
    super(host);
  }

  get fileName() {
    return basename(this.path);
  }
  get source(): FileSource {
    return { kind: "external", path: this.path };
  }
  get title() {
    return basename(this.path);
  }
  get hint() {
    return this.path;
  }
  get dirty() {
    return this.modified;
  }
  get lineFormat(): { eol: Eol; bom: boolean } {
    return { eol: this.eol, bom: this.bom };
  }
  private get draftKey() {
    return `${this.tabId}:draft`;
  }

  /** The bytes as they stand, for an import; `null` when the file is not open as text. */
  currentBytes(): Uint8Array | null {
    return this.state ? this.encode(this.state.doc) : null;
  }

  protected async read(): Promise<Uint8Array | Problem> {
    const info = await this.host.backend.openExternal(this.path);
    this.exists = info.exists;
    this.size = info.size;
    if (info.draft) {
      const draft = await this.host.backend.readExternalDraft(this.path);
      // ⌘S writes the file before it drops the draft, so a draft that failed to go leaves one
      // equal to the disk. Opening that as "modified" would warn about edits that are saved.
      if (
        info.draft.diskChanged &&
        info.exists &&
        info.kind === "text" &&
        info.size === draft.length &&
        (await this.dropDraftEqualToDisk(draft))
      ) {
        return draft;
      }
      this.modified = true;
      if (info.draft.diskChanged) this.notice = DRAFT_RESTORED_NOTICE;
      return draft;
    }
    if (!this.forceText && info.kind !== "text") return "binary";
    if (info.size > MAX_EDITOR_BYTES) return "too-large";
    return info.exists ? this.host.backend.readExternal(this.path) : new Uint8Array();
  }

  /** Best effort: on any failure the draft stays and opens as a draft. Drops it only when it is
   * byte-for-byte the disk's, then asks to open again so the backend's base is the disk's hash
   * rather than the dead draft's (a later edit would otherwise look like "disk changed"). */
  private async dropDraftEqualToDisk(draft: Uint8Array): Promise<boolean> {
    try {
      if (!sameBytes(draft, await this.host.backend.readExternal(this.path))) return false;
      await this.host.backend.discardExternalDraft(this.path);
      await this.host.backend.openExternal(this.path);
      return true;
    } catch {
      return false;
    }
  }

  protected edited(): void {
    if (!this.modified) {
      this.modified = true;
      this.host.changed(this, "dirty");
    }
    this.host.writes.schedule(this.draftKey, DRAFT_DELAY_MS, () => this.keepDraft());
  }

  private async keepDraft(): Promise<void> {
    if (this.modified && this.state) {
      try {
        await this.host.backend.keepExternalDraft(this.path, this.encode(this.state.doc));
        this.draftFailed = false;
      } catch (error) {
        this.draftFailed = true;
        throw error;
      }
    }
  }

  /** ⌘S. Returns whether the file was written. */
  async save(): Promise<boolean> {
    if (!this.state) return true;
    await this.settleDraft();
    const text = this.state.doc;
    try {
      await this.host.backend.saveExternal(this.path, this.encode(text));
    } catch (error) {
      this.fail(error);
      return false;
    }
    this.exists = true;
    this.notice = null;
    this.error = null;
    if (this.state.doc === text) this.modified = false;
    // Typed while saving: those edits are still unsaved and need their draft.
    else this.host.writes.schedule(this.draftKey, DRAFT_DELAY_MS, () => this.keepDraft());
    this.host.changed(this, "saved");
    return true;
  }

  /** 「버리기」: the file stays as it is on disk and the draft goes. */
  async discard(): Promise<void> {
    await this.settleDraft();
    this.modified = false;
    await this.host.backend.discardExternalDraft(this.path);
    this.host.changed(this, "dirty");
  }

  /** A failed `keepDraft` leaves the scheduler's slot empty, so a second try is made here: this
   * is what the window close and quit run, and the draft is all that survives them. */
  async leave(): Promise<void> {
    await this.host.writes.flush(this.draftKey);
    if (!this.draftFailed) return;
    this.host.writes.schedule(this.draftKey, 0, () => this.keepDraft());
    await this.host.writes.flush(this.draftKey);
  }

  flush(): Promise<void> {
    return this.leave();
  }

  /** The choice lives in the session only; the file on disk is not touched. */
  async changeLanguage(lang: LanguageInfo): Promise<void> {
    this.language = lang.id;
    await this.refreshLanguage();
  }

  async close(ask: CloseAsk): Promise<boolean> {
    if (!this.modified) return true;
    const choice = await ask();
    if (choice === "cancel") return false;
    if (choice === "save") return this.save();
    await this.discard();
    return true;
  }

  /** No draft write pending or running: one landing after a save or discard would bring the
   * draft back. */
  private async settleDraft(): Promise<void> {
    this.host.writes.cancel(this.draftKey);
    await this.host.writes.flush(this.draftKey);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** 「워크스페이스로 가져오기」 (spec 「가져오기」): copies the external file — with its unsaved edits —
 * into the workspace and returns the memo that takes over its tab. The original is left as it is. */
export async function importExternal(ext: ExternalDoc, host: DocHost): Promise<MemoDoc> {
  const bytes = ext.currentBytes();
  const info = bytes
    ? await host.backend.importMemo(ext.fileName, bytes)
    : await host.backend.importFile(ext.path);
  await ext.discard();
  const memo = new MemoDoc(host, info);
  memo.scrollAnchor = ext.scrollAnchor;
  memo.mode = ext.mode;
  if (ext.state) memo.adopt(ext.state, ext.lineFormat);
  // A language picked for the file stays with the text; as a memo it is kept the memo way. The
  // import has happened by then, so a failure here leaves it standing: `memo.error` says why,
  // for the caller to show once the memo has the tab (another import would make a second memo).
  const lang = ext.language && host.languages().find((l) => l.id === ext.language);
  if (lang) {
    try {
      await memo.changeLanguage(lang);
    } catch (error) {
      memo.error = error;
    }
  }
  return memo;
}
