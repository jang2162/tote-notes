import { isolateHistory } from "@codemirror/commands";
import {
  EditorState,
  type EditorSelection,
  type Extension,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import {
  errorCode,
  type Backend,
  type ExternalState,
  type FileSource,
  type LanguageInfo,
  type MemoInfo,
  type WorkspaceChange,
} from "../backend/types";
import { decodeText, encodeText, longestLine, type Eol } from "../core/codec";
import { detectLanguage } from "../core/language";
import { basename, splitName } from "../core/names";
import type { WriteScheduler } from "../core/scheduler";
import { restoreSelection, type SelectionJSON, type ViewMode } from "../core/session";
import { memoTitle, titleLine } from "../core/title";
import type { LanguageData } from "../editor/language-config";
import type { BannerAction, BannerState } from "../ui/banner";

// Spec 「저장」·「크기별 단계」.
export const MEMO_SAVE_DELAY_MS = 500;
export const LARGE_MEMO_SAVE_DELAY_MS = 3000;
/** The spec's 1 MB, measured in UTF-16 units: counting UTF-8 bytes on every keystroke would cost
 * what the longer delay saves. */
export const LARGE_MEMO_CHARS = 1_000_000;
export const DRAFT_DELAY_MS = 1000;
/** Spec 「오류 처리」: a failed save keeps the text in memory and tries again this often. */
export const SAVE_RETRY_MS = 5000;
/** Bigger files open in the large text viewer instead of loading into the editor.
 * Same value as `MAX_EDITOR_BYTES` in src-tauri/src/persist/external.rs. */
export const MAX_EDITOR_BYTES = 100 * 1024 * 1024;
/** A line longer than this sends the file to the large text viewer (spec 「크기별 단계」).
 * Measured with `pnpm measure:long-line` (keydown → next frame, p95 against a 253-line
 * baseline, headless WebKit): the largest ladder step within one frame of the baseline in two
 * runs, and the smaller of the two formats' values (`code.ts` 5,000,000, `note.md` 200,000; both
 * measured by the pre-registered procedure, see the measurement report). Re-measure after changing the editor's extensions. */
export const LONG_LINE_LIMIT = 200_000;
/** Soft wrap stays off above this line length (the same limit highlighting uses): wrapping one
 * huge line costs seconds. */
export const WRAP_LIMIT = 20_000;

export const RECOVERED_NOTICE = "원래 파일을 찾지 못해 새 메모로 저장했습니다";
// Spec 「외부 변경」.
export const CONFLICT_TEXT = "다른 앱이 이 파일을 바꿨습니다. 어느 쪽을 둘까요?";
export const DELETED_TEXT = "파일이 지워졌습니다. 다시 저장하거나 탭을 닫을 수 있습니다";
export const DISK_VERSION = "디스크 버전";
export const MY_VERSION = "내 버전";
export const RESAVE = "다시 저장";
export const CONFLICT_KEPT_NOTICE =
  "다른 앱이 바꾼 파일은 그대로 두고 내 버전을 새 메모로 저장했습니다";
export const CHOOSE_VERSION_FIRST = "먼저 디스크 버전과 내 버전 중 하나를 고르세요";

/** `binary`: the kind (by file name) is not text, so the bytes were not read; `not-utf8`: they
 * were read as text and are not UTF-8 (or hold a NUL). */
export type Problem = "binary" | "not-utf8" | "too-large" | "long-line" | "missing" | "unreadable";
/** `reloaded`: the text was read again after another app changed the file, as a new state. */
export type Change =
  | "info"
  | "language"
  | "dirty"
  | "saved"
  | "deleted"
  | "notice"
  | "error"
  | "banner"
  | "reloaded";
export type CloseAsk = () => Promise<"save" | "discard" | "cancel">;

/** What a document needs from the window around it. */
export interface DocHost {
  backend: Backend;
  writes: WriteScheduler;
  /** The window's editor. It shows the active tab's state, and its listener calls `doc.update`. */
  view: Pick<EditorView, "state" | "dispatch">;
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
  /** The last write of the tab's text failed: it is only in memory, and a retry is scheduled. */
  saveFailed = false;
  /** What the tab asks about its file (another app changed or deleted it); kept while the tab is
   * left and come back to. */
  banner: BannerState | null = null;
  protected eol: Eol = "\n";
  protected bom = false;
  private loading: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
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

  /** A write of the tab's text failed: the tab says so and `retry` runs again in SAVE_RETRY_MS. */
  protected failSave(error: unknown, key: string, retry: () => Promise<void>): void {
    this.saveFailed = true;
    this.retryLater(key, retry);
    this.fail(error);
  }

  /** The wait is a timer of its own, not the scheduler's delay: a flush runs what the key's slot
   * holds until it is empty, so a retry waiting there would run again at once — forever, while
   * the disk stays full. */
  protected retryLater(key: string, retry: () => Promise<void>): void {
    this.cancelRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.host.writes.schedule(key, 0, retry);
      void this.host.writes.flush(key);
    }, SAVE_RETRY_MS);
  }

  protected cancelRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Nothing is left to write: the retry and the failed mark go. */
  protected clearSaveFailed(): void {
    this.cancelRetry();
    if (!this.saveFailed) return;
    this.saveFailed = false;
    this.host.changed(this, "dirty");
  }

  /** The state is built at once and the language data follows (the host swaps it in). */
  protected fetchLanguageData(): void {
    void this.refreshLanguage();
  }

  protected setBanner(banner: BannerState | null): void {
    this.banner = banner;
    this.host.changed(this, "banner");
  }

  /** The conflict banner: 「디스크 버전」 runs `takeDisk`, 「내 버전」 runs `keepMine`. */
  protected conflictBanner(takeDisk: () => Promise<void>, keepMine: () => Promise<void>): void {
    if (this.banner?.kind === "conflict") return;
    this.setBanner({
      kind: "conflict",
      text: CONFLICT_TEXT,
      actions: [this.action(DISK_VERSION, takeDisk), this.action(MY_VERSION, keepMine)],
    });
  }

  protected deletedBanner(resave: () => Promise<unknown>): void {
    this.setBanner({ kind: "deleted", text: DELETED_TEXT, actions: [this.action(RESAVE, resave)] });
  }

  /** A banner button: the click does not wait, and a failure is reported like any other. */
  private action(label: string, run: () => Promise<unknown>): BannerAction {
    return { label, run: () => void run().catch((error: unknown) => this.fail(error)) };
  }

  /** Builds the editor state for `text`, with the selection `select` gives for it or else the
   * session's. */
  protected setText(
    text: string,
    select?: (doc: Text) => EditorSelection,
    longest: number = longestLine(text),
  ): void {
    let state = EditorState.create({
      doc: text,
      extensions: this.host.extensions(this, { wrap: longest <= WRAP_LIMIT, text }),
    });
    const wanted = select
      ? select(state.doc)
      : this.restoreSelection && restoreSelection(this.restoreSelection, state.doc);
    if (wanted) state = state.update({ selection: wanted }).state;
    this.state = state;
  }

  /** The file as another app left it, with the selection kept (pulled in when the text got
   * shorter). A new state rather than a transaction: a reload is not an edit, so it is not
   * written back, and ⌘Z does not step into the text it replaced. Called only when nothing is
   * unsaved, so the undo history is all it drops. */
  protected reload(bytes: Uint8Array): void {
    const decoded = decodeText(bytes);
    const longest = decoded ? longestLine(decoded.text) : 0;
    if (!decoded || longest > LONG_LINE_LIMIT) {
      this.state = null;
      this.problem = decoded ? "long-line" : "not-utf8";
    } else {
      this.eol = decoded.eol;
      this.bom = decoded.bom;
      const selection = this.state?.selection.toJSON() as SelectionJSON | undefined;
      this.setText(decoded.text, (doc) => restoreSelection(selection, doc), longest);
      this.loaded();
    }
    this.host.changed(this, "reloaded");
  }

  /** A tab that could not show its text (not UTF-8, a line too long) reads the file again after
   * another app changed it: the change may have mended it. A tab never read stays unread. */
  protected async retryProblem(): Promise<void> {
    if (this.problem !== "not-utf8" && this.problem !== "long-line") return;
    this.problem = null;
    this.error = null;
    await this.ensureLoaded();
    this.host.changed(this, "reloaded");
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
    const longest = longestLine(decoded.text);
    if (longest > LONG_LINE_LIMIT) {
      this.problem = "long-line";
      return;
    }
    this.eol = decoded.eol;
    this.bom = decoded.bom;
    // Not awaited: the configuration is a read of its own, and the tab would wait for it.
    this.fetchLanguageData();
    this.setText(decoded.text, undefined, longest);
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
    this.setText(from.doc.toString(), () => from.selection);
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
    // Undone back to what is saved: a failed save has nothing left to write.
    if (!text || text === this.savedText) return this.clearSaveFailed();
    // Writing now would answer the conflict banner for the person: the save waits for the choice
    // (or for the window to close, `flush`).
    if (this.banner?.kind === "conflict") return;
    const retry = () => this.save();
    try {
      this.setInfo(await this.host.backend.writeMemo(this.info.id, this.encode(text)));
    } catch (error) {
      if (errorCode(error) !== "unknown-memo") return this.failSave(error, this.saveKey, retry);
      // The file went away under us (renamed or deleted in Finder). Typed text must survive, so
      // it becomes a new memo instead of failing every save from here on.
      try {
        this.setInfo(await this.recover(this.encode(text)));
      } catch (again) {
        return this.failSave(again, this.saveKey, retry);
      }
      this.notice = RECOVERED_NOTICE;
      this.host.changed(this, "notice");
    }
    this.savedText = text;
    this.error = null;
    this.clearSaveFailed();
    // The file is there again.
    if (this.banner?.kind === "deleted") this.setBanner(null);
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

  /** Writes the text whatever tote last saved: the file is gone (「다시 저장」) or holds another
   * app's text (「내 버전」), so text equal to the last save must still go. */
  async resave(): Promise<void> {
    this.savedText = null;
    await this.saveNow();
  }

  private get unsaved(): boolean {
    return this.state !== null && this.state.doc !== this.savedText;
  }

  /** Another app changed the workspace (spec 「외부 변경」). A modification is read again when
   * nothing here is unsaved, and asked about when something is; a removal keeps the text and
   * offers to write it back; a rename only moves the name. */
  async onOutside(change: WorkspaceChange): Promise<void> {
    switch (change.kind) {
      case "modified":
        return this.outsideModified();
      case "removed":
        // Not read yet: there is no text to write back, and showing it says the file is missing.
        if (!this.state) return;
        // Nothing unsaved either: 「다시 저장」 must write all the same (`resave`).
        return this.deletedBanner(() => this.resave());
      case "renamed":
        // Named in Finder: tote stops naming it, as the index does.
        return this.setInfo({ ...this.info, file: change.to, autoTitle: false });
      case "added":
        return;
    }
  }

  private async outsideModified(): Promise<void> {
    // Not read yet, or not shown as text: it reads the file as it is when it is shown.
    if (!this.state) return this.retryProblem();
    if (this.unsaved) return this.raiseConflict();
    let bytes: Uint8Array;
    try {
      bytes = await this.host.backend.readMemo(this.info.id);
    } catch (error) {
      return this.fail(error);
    }
    // Typed while it was read: that text must not be replaced.
    if (this.unsaved) return this.raiseConflict();
    this.reload(bytes);
    if (this.banner) this.setBanner(null);
  }

  private raiseConflict(): void {
    this.conflictBanner(
      () => this.takeDisk(),
      async () => {
        this.setBanner(null);
        await this.resave();
      },
    );
  }

  /** 「디스크 버전」: the unsaved text goes for the file's. */
  private async takeDisk(): Promise<void> {
    this.host.writes.cancel(this.saveKey);
    this.cancelRetry();
    let bytes: Uint8Array;
    try {
      bytes = await this.host.backend.readMemo(this.info.id);
    } catch (error) {
      return this.fail(error);
    }
    this.reload(bytes);
    this.setBanner(null);
    this.clearSaveFailed();
  }

  /** Where a search match is (`line` 0-based, `column` in characters): clamped to the end of the
   * line, or of the text, if they are shorter now than when the search read the file. The search
   * counts characters and CodeMirror UTF-16 units — the same in the BMP, Hangul included; each
   * emoji or other astral character before the match puts this one short. */
  positionOf(line: number, column: number): number {
    const text = this.state?.doc;
    if (!text) return 0;
    if (line >= text.lines) return text.length;
    const at = text.line(line + 1);
    return Math.min(at.from + column, at.to);
  }

  /** 「이 버전으로 되돌리기」 (spec 「백업」 복원): the whole text becomes `text` in one transaction,
   * so one ⌘Z brings back what was there, and it saves as typing does. */
  restoreText(text: string): void {
    const start = this.state;
    if (!start) return;
    const spec: TransactionSpec = {
      changes: { from: 0, to: start.doc.length, insert: text },
      userEvent: "input.restore",
      selection: { anchor: 0 },
      // An undo step of its own: typing just before or after must not join it.
      annotations: isolateHistory.of("full"),
    };
    if (this.host.view.state === start) {
      this.host.view.dispatch(spec);
      return;
    }
    const tr = start.update(spec);
    this.update({ state: tr.state, startState: start, docChanged: true, selectionSet: true });
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

  /** The window closes or the app quits with a conflict nobody answered: neither side is dropped.
   * The file keeps the other app's text and 「내 버전」 becomes a new memo, as a save into a
   * vanished file does (`recover`) — one write, so the flush round stays quick. Also when the text
   * was undone back to the last save: the file no longer holds it. When the write fails the save
   * counts as failed, which makes the quit ask first. */
  async flush(): Promise<void> {
    if (this.banner?.kind === "conflict" && this.state) {
      const text = this.state.doc;
      try {
        this.setInfo(await this.recover(this.encode(text)));
      } catch (error) {
        return this.failSave(error, this.saveKey, () => this.save());
      }
      this.savedText = text;
      this.notice = CONFLICT_KEPT_NOTICE;
      this.host.changed(this, "notice");
      this.setBanner(null);
      this.clearSaveFailed();
    }
    return this.leave();
  }

  async close(): Promise<boolean> {
    await this.saveNow();
    // Still unsaved: keep the tab, and the text in it, rather than lose what the error was about.
    // A conflict waits for its answer even when the text is the saved one: the file is not.
    if (this.unsaved || this.banner?.kind === "conflict") return false;
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
  /** `watchExternal` was asked for this tab and not yet undone. */
  private watching = false;

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
    this.watch();
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
      if (info.draft.diskChanged) this.draftOverChangedFile(info.exists);
      return draft;
    }
    if (!this.forceText && info.kind !== "text") return "binary";
    if (info.size > MAX_EDITOR_BYTES) return "too-large";
    return info.exists ? this.host.backend.readExternal(this.path) : new Uint8Array();
  }

  /** Spec 「외부 변경」: a draft over a file that changed since asks which to keep. 「내 버전」
   * leaves the edits unsaved, for ⌘S — a draft is written only when the person saves. A file
   * gone since has no disk version to take: the deleted banner offers to write it back. */
  private draftOverChangedFile(exists: boolean): void {
    if (!exists) return this.deletedBanner(() => this.save());
    this.conflictBanner(
      () => this.takeDisk(),
      async () => this.setBanner(null),
    );
  }

  /** Another app changed or removed the file (`watchExternal`). A clean tab reads it again; one
   * with edits since ⌘S asks, 「내 버전」 being a save. */
  async onOutside(change: ExternalState): Promise<void> {
    // Not read yet, or not shown as text: it reads the file as it is when it is shown.
    if (!this.state) return change === "modified" ? this.retryProblem() : undefined;
    if (change === "removed") {
      this.exists = false;
      return this.deletedBanner(() => this.save());
    }
    if (this.modified) return this.raiseConflict();
    let bytes: Uint8Array;
    try {
      bytes = await this.host.backend.readExternal(this.path);
    } catch (error) {
      return this.fail(error);
    }
    if (this.modified) return this.raiseConflict();
    this.exists = true;
    this.size = bytes.length;
    this.reload(bytes);
    if (this.banner) this.setBanner(null);
  }

  private raiseConflict(): void {
    this.conflictBanner(
      () => this.takeDisk(),
      async () => {
        await this.save();
      },
    );
  }

  /** 「디스크 버전」: the edits and their draft go for the file's text. */
  private async takeDisk(): Promise<void> {
    let bytes: Uint8Array;
    try {
      await this.discard();
      bytes = await this.host.backend.readExternal(this.path);
    } catch (error) {
      return this.fail(error);
    }
    this.exists = true;
    this.size = bytes.length;
    this.reload(bytes);
    this.setBanner(null);
  }

  /** Changes other apps make to the file come to `onOutside` from here on. */
  private watch(): void {
    if (this.watching) return;
    this.watching = true;
    this.host.backend
      .watchExternal(this.path)
      .catch((error: unknown) => console.warn(`cannot watch ${this.path}`, error));
  }

  /** The tab closed, or became a memo. */
  stopWatching(): void {
    if (!this.watching) return;
    this.watching = false;
    this.host.backend
      .unwatchExternal(this.path)
      .catch((error: unknown) => console.warn(`cannot stop watching ${this.path}`, error));
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

  /** Losing the edits since the last ⌘S is a loss too, so a failed draft is retried like a memo. */
  private async keepDraft(): Promise<void> {
    if (!this.modified || !this.state) return this.clearSaveFailed();
    try {
      await this.host.backend.keepExternalDraft(this.path, this.encode(this.state.doc));
    } catch (error) {
      return this.failSave(error, this.draftKey, () => this.keepDraft());
    }
    this.clearSaveFailed();
  }

  /** ⌘S. Returns whether the file was written. */
  async save(): Promise<boolean> {
    if (!this.state) return true;
    await this.settleDraft();
    const text = this.state.doc;
    try {
      await this.host.backend.saveExternal(this.path, this.encode(text));
    } catch (error) {
      // Settling dropped a draft retry; the edits still need their draft.
      if (this.saveFailed) this.retryLater(this.draftKey, () => this.keepDraft());
      this.fail(error);
      return false;
    }
    this.exists = true;
    this.notice = null;
    this.error = null;
    this.clearSaveFailed();
    // Saving is a choice too: what is on disk is now the tab's.
    if (this.banner) this.setBanner(null);
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
    this.clearSaveFailed();
    await this.host.backend.discardExternalDraft(this.path);
    this.host.changed(this, "dirty");
  }

  /** A failed `keepDraft` leaves the scheduler's slot empty, so a second try is made here: this
   * is what the window close and quit run, and the draft is all that survives them. */
  async leave(): Promise<void> {
    await this.host.writes.flush(this.draftKey);
    if (!this.saveFailed) return;
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
    const closed = await this.mayClose(ask);
    if (closed) this.stopWatching();
    return closed;
  }

  private async mayClose(ask: CloseAsk): Promise<boolean> {
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
    this.cancelRetry();
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
  ext.stopWatching();
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
