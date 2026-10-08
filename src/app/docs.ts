import { EditorState, type EditorSelection, type Extension, type Text } from "@codemirror/state";

import { errorCode, type Backend, type MemoInfo } from "../backend/types";
import { decodeText, encodeText, longestLine, type Eol } from "../core/codec";
import { basename, splitName } from "../core/names";
import type { WriteScheduler } from "../core/scheduler";
import { restoreSelection, type SelectionJSON } from "../core/session";
import { memoTitle, titleLine } from "../core/title";

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

export type Problem = "binary" | "too-large" | "missing" | "unreadable";
export type Change = "info" | "language" | "dirty" | "saved" | "deleted" | "notice" | "error";
export type CloseAsk = () => Promise<"save" | "discard" | "cancel">;

/** What a document needs from the window around it. */
export interface DocHost {
  backend: Backend;
  writes: WriteScheduler;
  /** Editor extensions for a state of `doc`, including the listener that calls `doc.update`. */
  extensions(doc: Doc, options: { wrap: boolean }): Extension[];
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

/** The main cursor just left the title line (the first non-blank one): time for the title. */
export function leftTitleLine(update: DocUpdate): boolean {
  const lineOf = (state: EditorState) => state.doc.lineAt(state.selection.main.head).number;
  return (
    lineOf(update.startState) === titleLine(update.startState.doc).number &&
    lineOf(update.state) !== titleLine(update.state.doc).number
  );
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
  /** The session's selection, applied when the text first loads. */
  restoreSelection: SelectionJSON | undefined;
  protected eol: Eol = "\n";
  protected bom = false;
  private loading: Promise<void> | null = null;

  constructor(protected readonly host: DocHost) {}

  abstract get fileName(): string;
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

  protected encode(text: Text): Uint8Array {
    return encodeText(text.sliceString(0, text.length, this.eol), this.bom);
  }

  protected fail(error: unknown): void {
    this.error = error;
    this.host.changed(this, "error");
  }

  /** Builds the editor state for `text`, with `selection` or else the session's. */
  protected setText(text: string, selection?: EditorSelection): void {
    let state = EditorState.create({
      doc: text,
      extensions: this.host.extensions(this, { wrap: longestLine(text) <= WRAP_LIMIT }),
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
      this.problem = "binary";
      return;
    }
    this.eol = decoded.eol;
    this.bom = decoded.bom;
    this.setText(decoded.text);
    this.loaded();
  }
}

export class MemoDoc extends Doc {
  readonly kind = "memo" as const;
  private savedText: Text | null = null;
  private retitling: Promise<void> | null = null;

  constructor(
    host: DocHost,
    public info: MemoInfo,
  ) {
    super(host);
  }

  get fileName() {
    return this.info.file;
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
    this.setText("");
    this.loaded();
  }

  /** Takes over text, selection and line format from the tab it replaces (an import), whose text
   * is exactly what the import wrote. */
  adopt(from: EditorState, format: { eol: Eol; bom: boolean }): void {
    this.eol = format.eol;
    this.bom = format.bom;
    this.setText(from.doc.toString(), from.selection);
    this.loaded();
  }

  protected loaded(): void {
    this.savedText = this.state?.doc ?? null;
  }

  protected async read(): Promise<Uint8Array | Problem> {
    if (this.info.kind !== "text") return "binary";
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
    if ((update.docChanged || update.selectionSet) && leftTitleLine(update)) void this.retitle();
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

  saveNow(): Promise<void> {
    return this.host.writes.flush(this.saveKey);
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

  async leave(): Promise<void> {
    await this.saveNow();
    await this.retitle();
  }

  flush(): Promise<void> {
    return this.leave();
  }

  async close(): Promise<boolean> {
    await this.saveNow();
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
    this.host.changed(this, extensionChanged ? "language" : "info");
  }
}

export class ExternalDoc extends Doc {
  readonly kind = "external" as const;
  /** Edited since the last ⌘S (or restored from a draft). */
  modified = false;
  exists = false;

  constructor(
    host: DocHost,
    readonly path: string,
  ) {
    super(host);
  }

  get fileName() {
    return basename(this.path);
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
    if (info.kind !== "text") return "binary";
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
      await this.host.backend.keepExternalDraft(this.path, this.encode(this.state.doc));
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

  leave(): Promise<void> {
    return this.host.writes.flush(this.draftKey);
  }

  flush(): Promise<void> {
    return this.leave();
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
  if (ext.state) memo.adopt(ext.state, ext.lineFormat);
  return memo;
}
