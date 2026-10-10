import type { Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import type { Backend, LanguageInfo, MemoInfo, ViewerInfo } from "../backend/types";
import { splitName } from "../core/names";
import { WriteScheduler } from "../core/scheduler";
import {
  languageData,
  parseLanguageConfiguration,
  type LanguageData,
} from "../editor/language-config";
import {
  editorExtensions,
  highlightEffect,
  languageDataEffect,
  languageEffect,
} from "../editor/setup";
import { EMPTY_REGISTRY, languageLabelFor, Registry } from "../extensions/registry";
import { HighlightClient } from "../highlight/client";
import {
  HIGHLIGHT_LIMIT_CHARS,
  workerHighlighting,
  type WorkerHighlighting,
} from "../highlight/extension";
import { ThemeManager } from "../theme/manager";
import { tokenTheme } from "../theme/vscode-theme";
import { askUnsaved, pickLanguage, promptText, workspacePicker } from "../ui/dialogs";
import { h } from "../ui/dom";
import { MemoList } from "../ui/memo-list";
import { openSettings } from "../ui/settings";
import { StatusBar } from "../ui/status-bar";
import { TabBar } from "../ui/tab-bar";
import { ViewerHost } from "../viewer/host";
import { LargeTextViewer } from "../viewer/large-text";
import {
  ExternalDoc,
  importExternal,
  MemoDoc,
  type Change,
  type Doc,
  type DocHost,
  type Problem,
} from "./docs";
import { describeError } from "./errors";
import { SessionSync } from "./session-sync";
import { Surface } from "./surface";
import { Tabs } from "./tabs";

export { describeError, ERROR_TEXT } from "./errors";

/** The extensions and grammars that are on, with versions: equal signatures read the same files. */
function extensionSignature(registry: Registry): string {
  const { extensions, grammars } = registry.data;
  return JSON.stringify([
    extensions.map((e) => `${e.id}@${e.version}:${e.enabled}:${e.modified ?? 0}`),
    grammars.map((g) => `${g.extension}/${g.path}`),
  ]);
}

const SESSION_DELAY_MS = 1000;

export const NOT_OPENABLE = "열 수 없음";
export const OPEN_AS_TEXT = "텍스트로 열기";

const PROBLEM_TEXT: Record<Problem, string> = {
  binary: NOT_OPENABLE,
  "not-utf8": "텍스트로 열 수 없음",
  "too-large": "100MB 가 넘어 편집기로 열 수 없습니다",
  "long-line": "한 줄이 너무 길어 편집기로 열 수 없습니다",
  missing: "파일을 찾을 수 없습니다",
  unreadable: "파일을 읽지 못했습니다",
};

/** A panel on show that reads its file through tokens issued to `owner`; closing it revokes them. */
interface TokenPanel {
  doc: Doc;
  owner: string;
  host: { destroy(): void; setTheme?(theme: Record<string, string>): void };
}

/** One workspace window: menu actions, opening and closing, and what the status bar says. Tabs,
 * the session and the editor area live in `Tabs`, `SessionSync` and `Surface`. */
export class AppController implements DocHost {
  readonly writes = new WriteScheduler((_key, error) => this.report(error));
  readonly view = new EditorView();
  readonly tabs = new Tabs();
  readonly surface = new Surface(this.view);
  registry = new Registry(EMPTY_REGISTRY);
  readonly theme: ThemeManager;
  readonly highlight = new HighlightClient(
    new Worker(new URL("../highlight/worker.ts", import.meta.url), { type: "module" }),
    () => this.registry,
    (ext, path) => this.backend.readExtensionFile(ext, path),
  );
  /** Open settings screens listen here: the backend takes one config handler per window. */
  private settingsOpen = false;
  /** `extensionSignature` of the registry the caches were filled from. */
  private extensionSet = "";
  private readonly configListeners = new Set<() => void>();
  private readonly languageConfigs = new Map<string, Promise<LanguageData>>();
  /** Each tab's document in the highlight worker, kept from tab switch to tab switch. */
  private readonly highlights = new Map<Doc, { key: string; highlighting: WorkerHighlighting }>();
  private session!: SessionSync;
  private deviceId = "";
  /** Session writes wait until the restored tabs are in place. */
  private restoring = true;
  private readonly memoList = new MemoList((id) => void this.openMemo(id));
  private readonly tabBar = new TabBar({
    select: (id) => void this.activateTab(id),
    close: (id) => void this.closeTab(id),
  });
  private readonly statusBar = new StatusBar();
  private panel: TokenPanel | null = null;
  /** Numbers the views, so each owns its tokens alone: a tab left and come back to is a new one. */
  private views = 0;
  /** Numbers the large text searches of this window: the backend keeps only the latest one
   * running, so two viewers in one window must not reuse a number. */
  private searches = 0;

  constructor(
    root: HTMLElement,
    readonly backend: Backend,
  ) {
    // Not a field initializer: those run before the `backend` parameter property is assigned.
    this.theme = new ThemeManager(backend, () => this.registry);
    root.replaceChildren(
      this.memoList.el,
      h("main", { class: "main" }, this.tabBar.el, this.surface.el, this.statusBar.el),
    );
    this.view.scrollDOM.addEventListener("scroll", () => this.saveSessionSoon(), { passive: true });
  }

  async start(): Promise<void> {
    const info = await this.backend.workspaceInfo();
    this.deviceId = info.deviceId;
    document.title = info.name;
    await this.loadRegistry();
    this.extensionSet = extensionSignature(this.registry);
    this.backend.onConfigChanged(() => void this.onConfigChanged());
    this.theme.onChange((active) => {
      if (active.theme) void this.highlight.setTheme(tokenTheme(active.theme));
      this.panel?.host.setTheme?.(active.variables);
    });
    await this.theme.start();
    this.session = new SessionSync(
      this.backend,
      this.tabs,
      this.deviceId,
      (id) => this.memoList.get(id),
      (memo) => new MemoDoc(this, memo),
      (path) => new ExternalDoc(this, path),
    );
    this.backend.onMenu((id) => void this.onMenu(id));
    this.backend.onFlush((id) => void this.onFlush(id));
    this.backend.onPending(() => void this.drainPending());
    this.backend.onFileDrop((paths) => void this.openExternals(paths));
    // A window losing focus is a tab losing focus (spec 「저장」), and hidden windows barely run
    // timers — so write now rather than when the timer fires.
    window.addEventListener("blur", () => void this.tabs.active?.leave());
    window.addEventListener("focus", () => void this.refreshMemos());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void this.flushAll();
    });
    await this.refreshMemos();
    const first = await this.session.restore();
    if (first) await this.activate(first);
    else this.renderTabs();
    this.restoring = false;
    await this.drainPending();
  }

  private async loadRegistry(): Promise<void> {
    try {
      this.registry = new Registry(await this.backend.extensionRegistry());
    } catch (error) {
      this.report(error);
    }
  }

  /** Settings or extensions changed (this window's settings screen or another's). */
  private async onConfigChanged(): Promise<void> {
    await this.loadRegistry();
    // An extension may have been reinstalled, replaced, removed or switched: what was read from
    // its files is stale. Open documents keep what they have; the next language open reads again.
    // Theme and root changes leave the set alone and keep the caches.
    const signature = extensionSignature(this.registry);
    if (signature !== this.extensionSet) {
      this.extensionSet = signature;
      this.languageConfigs.clear();
      this.highlight.forgetGrammars();
    }
    await this.theme.refresh();
    for (const listener of this.configListeners) listener();
  }

  extensions(doc: Doc, options: { wrap: boolean; text: string }) {
    // A new state: the worker's copy of the old text is no use to it.
    this.dropHighlight(doc);
    return editorExtensions({
      fileName: doc.fileName,
      languageId: this.languageOf(doc)?.id,
      wrap: options.wrap,
      languageData: doc.languageData,
      highlight: this.highlightFor(doc, options.text.length),
      onUpdate: (update) => this.onUpdate(doc, update),
    });
  }

  /** The tab's highlighting for its current language: the same extension (and worker document)
   * while the language stays, a new one when it changes. */
  private highlightFor(doc: Doc, length: number): Extension {
    const lang = this.languageOf(doc);
    const key =
      lang?.grammar && length <= HIGHLIGHT_LIMIT_CHARS ? `${lang.extension}:${lang.id}` : null;
    const current = this.highlights.get(doc);
    if (current && current.key === key) return current.highlighting.extension;
    this.dropHighlight(doc);
    if (!lang || !key) return [];
    const highlighting = workerHighlighting(this.highlight, lang);
    this.highlights.set(doc, { key, highlighting });
    return highlighting.extension;
  }

  private dropHighlight(doc: Doc): void {
    this.highlights.get(doc)?.highlighting.close();
    this.highlights.delete(doc);
  }

  languages(): LanguageInfo[] {
    return this.registry.languages;
  }

  /** The language of a tab: the chosen one, else the file name's (spec 「편집기」). */
  languageOf(doc: Doc): LanguageInfo | undefined {
    return (
      (doc.language && this.registry.language(doc.language)) ||
      this.registry.languageForFile(doc.fileName)
    );
  }

  /** language-configuration.json of `lang`, read once per language. */
  languageConfig(lang: LanguageInfo | undefined): Promise<LanguageData> {
    if (!lang?.configuration) return Promise.resolve({});
    const key = `${lang.extension}/${lang.configuration}`;
    let pending = this.languageConfigs.get(key);
    if (!pending) {
      pending = this.backend
        .readExtensionFile(lang.extension, lang.configuration)
        .then((bytes) => languageData(parseLanguageConfiguration(new TextDecoder().decode(bytes))))
        .catch((error: unknown) => {
          console.warn(`language configuration of ${lang.id} could not be read`, error);
          return {};
        });
      this.languageConfigs.set(key, pending);
    }
    return pending;
  }

  changed(doc: Doc, change: Change): void {
    const active = doc === this.tabs.active;
    if (doc instanceof MemoDoc && (change === "info" || change === "language"))
      this.memoList.upsert(doc.info);
    if (doc instanceof MemoDoc && change === "deleted") this.memoList.remove(doc.info.id);
    if (change === "language") {
      this.reconfigureLanguage(doc);
      // An external file's pick lives in the session only.
      this.saveSessionSoon();
    }
    if (active && change === "notice") this.statusBar.setMessage(doc.notice ?? "");
    if (active && change === "saved" && doc instanceof ExternalDoc)
      this.statusBar.setMessage("저장됨");
    // A memo that saved after a failed save no longer has the error to show.
    if (active && change === "saved" && doc instanceof MemoDoc && this.statusBar.showsError)
      this.statusBar.setMessage("");
    if (change === "error") this.report(doc.error);
    this.renderTabs();
  }

  async openMemo(id: string): Promise<void> {
    let doc: Doc | undefined = this.tabs.memo(id);
    if (!doc) {
      let info: MemoInfo | undefined = this.memoList.get(id);
      if (!info) {
        await this.refreshMemos();
        info = this.memoList.get(id);
      }
      if (!info) return this.report(new Error("메모를 찾을 수 없습니다"));
      doc = this.tabs.insertAfterActive(new MemoDoc(this, info));
    }
    await this.activate(doc);
  }

  async openExternal(path: string): Promise<void> {
    await this.activate(
      this.tabs.external(path) ?? this.tabs.insertAfterActive(new ExternalDoc(this, path)),
    );
  }

  async newMemo(): Promise<void> {
    const info = await this.backend.createMemo();
    this.memoList.upsert(info);
    const doc = this.tabs.insertAfterActive(new MemoDoc(this, info));
    doc.startEmpty();
    await this.activate(doc);
  }

  async closeTab(tabId: string): Promise<void> {
    const doc = this.tabs.byId(tabId);
    if (!doc) return;
    this.capture(doc);
    if (!(await doc.close(() => askUnsaved(doc.title)))) {
      if (doc === this.tabs.active) this.view.focus();
      return;
    }
    const wasActive = doc === this.tabs.active;
    if (this.panel?.doc === doc) this.closePanel();
    const next = this.tabs.remove(doc);
    this.dropHighlight(doc);
    if (wasActive) {
      if (next) await this.activate(next);
      else this.showEmpty();
    }
    this.renderTabs();
    this.saveSessionSoon();
  }

  /** Everything written now — tab edits, titles and the session (window close, quit, hiding). */
  async flushAll(): Promise<void> {
    await Promise.all(
      this.tabs.list.map((doc) => doc.flush().catch((error: unknown) => this.report(error))),
    );
    if (!this.restoring) await this.saveSessionNow();
  }

  private async onFlush(id: number): Promise<void> {
    try {
      await this.flushAll();
    } finally {
      await this.backend.flushDone(id);
    }
  }

  private onUpdate(doc: Doc, update: ViewUpdate): void {
    doc.update(update);
    if (doc !== this.tabs.active || !(update.docChanged || update.selectionSet)) return;
    this.statusBar.setPosition(update.state);
    this.saveSessionSoon();
  }

  private activateTab(tabId: string): Promise<void> {
    const doc = this.tabs.byId(tabId);
    return doc ? this.activate(doc) : Promise.resolve();
  }

  private async activate(doc: Doc): Promise<void> {
    const previous = this.tabs.active;
    if (previous === doc) return;
    if (previous) {
      this.capture(previous);
      void previous.leave();
    }
    this.tabs.active = doc;
    this.renderTabs();
    // The switch lets go of the tab left at once, whatever the new tab shows and however long it
    // takes to come (a read, a token, a scan): keys typed meanwhile are dropped, not saved there.
    this.surface.showNothing();
    await doc.ensureLoaded();
    // Loading can mark the tab dirty (a restored draft), which the render above could not know.
    this.renderTabs();
    if (this.tabs.active !== doc) return; // another tab was picked while this one loaded
    this.show(doc);
    this.saveSessionSoon();
  }

  private show(doc: Doc): void {
    this.closePanel();
    const state = doc.problem ? null : doc.state;
    this.memoList.setActive(doc instanceof MemoDoc ? doc.info.id : null);
    this.showLanguage(doc);
    this.statusBar.setMessage(doc.notice ?? "");
    if (state) {
      const preview =
        doc.mode === "preview" ? this.registry.viewerFor(doc.fileName, "preview") : undefined;
      if (preview) {
        this.openViewer(doc, preview, state.doc.toString());
        this.statusBar.setPosition(null);
        // A notice of the document (a restored draft) is not to be hidden by the mode's hint.
        if (!doc.notice) this.statusBar.setMessage("미리보기 · ⇧⌘V 로 편집");
        return;
      }
      // The language may have changed under a preview (detection on leaving), taking its viewer.
      doc.mode = "edit";
      this.surface.showEditor(state, doc.scrollAnchor);
      this.statusBar.setPosition(this.view.state);
      return;
    }
    this.statusBar.setPosition(null);
    if (doc.problem === "too-large" || doc.problem === "long-line") {
      void this.openLargeText(doc);
      return;
    }
    const viewer =
      doc.problem === "binary" && !doc.forceText
        ? this.registry.viewerFor(doc.fileName, "primary")
        : undefined;
    if (viewer) this.openViewer(doc, viewer);
    else this.showProblem(doc);
  }

  /** The large text viewer on show (public: the UI tests call `goToLine`). */
  get largeText(): { doc: Doc; viewer: LargeTextViewer; owner: string } | null {
    const open = this.panel;
    if (!open || !(open.host instanceof LargeTextViewer)) return null;
    return { doc: open.doc, viewer: open.host, owner: open.owner };
  }

  private showProblem(doc: Doc): void {
    // Only a file whose kind is not text may still be text (spec 「뷰어」); a missing, too large
    // or unreadable file, or bytes already read as text, would come back the same.
    const fallback =
      doc.problem === "binary"
        ? { label: OPEN_AS_TEXT, run: () => void this.openAsText(doc) }
        : undefined;
    this.surface.showPlaceholder(PROBLEM_TEXT[doc.problem ?? "unreadable"], fallback);
  }

  private async openAsText(doc: Doc): Promise<void> {
    await doc.openAsText();
    if (doc === this.tabs.active) this.show(doc);
  }

  /** A viewer for `doc` (spec 「뷰어」): a primary viewer for a file the editor cannot show gets a
   * token URL, a preview viewer gets `text` — the text as it is now. The token lives as long as
   * this view: leaving the tab, closing it or a viewer failure revokes it. */
  private openViewer(doc: Doc, viewer: ViewerInfo, text?: string): void {
    const owner = `${doc.tabId}:${viewer.id}:${++this.views}`;
    const fallBack = () => {
      // Another view took over meanwhile; this one is already gone.
      if (this.panel !== panel) return;
      this.closePanel();
      if (doc !== this.tabs.active) return;
      if (text === undefined) return this.showProblem(doc);
      // A preview that fails leaves the text readable and editable (「텍스트로 열기」 is for a file
      // whose kind is not text), so go back to the editor.
      doc.mode = "edit";
      this.show(doc);
      this.statusBar.setMessage("미리보기를 열 수 없어 편집으로 돌아왔습니다", "error");
      this.saveSessionSoon();
    };
    const host = new ViewerHost({
      url: this.backend.viewerUrl(viewer.extension, viewer.entry),
      resolveRelative: async (path) => {
        if (this.panel !== panel) return null;
        const url = await this.backend.resolveRelative(doc.source, path, owner);
        if (this.panel === panel) return url;
        // The view closed while this was on its way: its tokens were revoked before this one.
        this.revoke(owner);
        return null;
      },
      onError: (message) => {
        console.warn(`viewer ${viewer.id}: ${message}`);
        fallBack();
      },
    });
    const panel: TokenPanel = { doc, owner, host };
    this.panel = panel;
    this.surface.showPanel(host.el);
    const base = {
      fileName: doc.fileName,
      extension: splitName(doc.fileName).ext.toLowerCase(),
      theme: this.theme.active.variables,
    };
    if (text !== undefined) {
      host.start({ ...base, size: text.length, text });
      return;
    }
    void this.backend
      .issueFileToken(doc.source, owner)
      .then((url) => {
        if (this.panel !== panel) return;
        host.start({
          ...base,
          size: doc instanceof MemoDoc ? doc.info.size : (doc as ExternalDoc).size,
          url,
        });
      })
      .catch((error: unknown) => {
        this.report(error);
        fallBack();
      });
  }

  /** The read-only large text viewer (spec 「크기별 단계」). Its token lives as long as the view. */
  private async openLargeText(doc: Doc): Promise<void> {
    const view = ++this.views;
    const owner = `${doc.tabId}:large-text:${view}`;
    // Another tab or view was shown while this one was on its way.
    const stale = () => this.tabs.active !== doc || this.views !== view;
    try {
      const [url, scan] = await Promise.all([
        this.backend.issueFileToken(doc.source, owner),
        this.backend.scanText(doc.source),
      ]);
      if (stale()) return this.revoke(owner);
      const viewer = new LargeTextViewer({
        url,
        scan,
        fileName: doc.fileName,
        search: (query, fromLine) =>
          this.backend.searchText(doc.source, query, fromLine, ++this.searches),
      });
      this.panel = { doc, owner, host: viewer };
      this.surface.showPanel(viewer.el);
      this.statusBar.setMessage("읽기 전용 · 대용량 텍스트 뷰어");
    } catch (error) {
      this.revoke(owner);
      if (stale()) return;
      this.report(error);
      this.showProblem(doc);
    }
  }

  private closePanel(): void {
    const open = this.panel;
    if (!open) return;
    this.panel = null;
    open.host.destroy();
    this.revoke(open.owner);
  }

  private revoke(owner: string): void {
    void this.backend.revokeFileTokens(owner).catch((error: unknown) => console.warn(error));
  }

  private showEmpty(): void {
    this.closePanel();
    this.surface.showEmpty();
    this.memoList.setActive(null);
    this.statusBar.setPosition(null);
    this.statusBar.setLanguage("");
    this.statusBar.setMessage("");
  }

  /** The view holds the live state of the active tab; keep where it is scrolled to. */
  private capture(doc: Doc): void {
    if (doc !== this.tabs.active || !doc.state || this.view.state !== doc.state) return;
    if (!this.surface.showsEditor) return;
    doc.scrollAnchor = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop).from;
  }

  private renderTabs(): void {
    this.tabBar.render(
      this.tabs.list.map((doc) => ({
        id: doc.tabId,
        title: doc.title,
        hint: doc.hint,
        dirty: doc.dirty,
        external: doc.kind === "external",
        active: doc === this.tabs.active,
      })),
    );
  }

  private async openExternals(paths: string[]): Promise<void> {
    for (const path of paths) await this.openExternal(path);
  }

  private async cycleTab(step: number): Promise<void> {
    const next = this.tabs.cycle(step);
    if (next) await this.activate(next);
  }

  private saveSessionSoon(): void {
    if (!this.restoring)
      this.writes.schedule("session", SESSION_DELAY_MS, () => this.writeSession());
  }

  private async saveSessionNow(): Promise<void> {
    this.writes.schedule("session", 0, () => this.writeSession());
    await this.writes.flush("session");
  }

  private async writeSession(): Promise<void> {
    const session = await this.session.build(() => {
      if (this.tabs.active) this.capture(this.tabs.active);
    });
    await this.backend.writeSession(JSON.stringify(session));
  }

  private async drainPending(): Promise<void> {
    if (this.restoring) return;
    for (const open of await this.backend.takePendingOpens()) {
      if (open.kind === "memo") {
        await this.refreshMemos();
        await this.openMemo(open.id);
      } else {
        await this.openExternal(open.path);
      }
    }
  }

  private async onMenu(id: string): Promise<void> {
    try {
      switch (id) {
        case "new-memo":
          return await this.newMemo();
        case "open-file":
          return await this.openExternals(await this.backend.pickFiles());
        case "save":
          return await this.saveActive();
        case "import":
          return await this.importActive();
        case "rename":
          return await this.renameActive();
        case "close-tab":
          return this.tabs.active
            ? await this.closeTab(this.tabs.active.tabId)
            : await this.backend.closeWindow();
        case "next-tab":
          return await this.cycleTab(1);
        case "prev-tab":
          return await this.cycleTab(-1);
        case "toggle-preview":
          return await this.togglePreview();
        case "open-workspace":
        case "new-workspace":
          return await this.showPicker();
        case "settings":
          return await this.showSettings();
      }
    } catch (error) {
      this.report(error);
    }
  }

  /** ⇧⌘V (spec 「마크다운 미리보기」): per tab, with the text as it is right now. */
  async togglePreview(): Promise<void> {
    const doc = this.tabs.active;
    if (!doc || !this.registry.viewerFor(doc.fileName, "preview")) return;
    // A tab just picked may still be reading its file: its `show` comes first, then this switch.
    await doc.ensureLoaded();
    if (this.tabs.active !== doc || !doc.state || doc.problem) return;
    // `capture` reads the scroll only while the editor shows, so a preview keeps the anchor.
    this.capture(doc);
    await doc.leave();
    if (this.tabs.active !== doc) return;
    doc.mode = doc.mode === "preview" ? "edit" : "preview";
    this.show(doc);
    this.saveSessionSoon();
  }

  private async saveActive(): Promise<void> {
    const doc = this.tabs.active;
    if (doc instanceof ExternalDoc) await doc.save();
    else if (doc instanceof MemoDoc) await doc.saveNow();
  }

  private async importActive(): Promise<void> {
    const doc = this.tabs.active;
    if (!(doc instanceof ExternalDoc)) return;
    this.capture(doc);
    const memo = await importExternal(doc, this);
    this.tabs.list[this.tabs.indexOf(doc)] = memo;
    this.dropHighlight(doc);
    this.memoList.upsert(memo.info);
    this.tabs.active = null;
    await this.activate(memo);
    if (memo.error) this.report(memo.error);
    else this.statusBar.setMessage("워크스페이스로 가져왔습니다");
  }

  private async renameActive(): Promise<void> {
    const doc = this.tabs.active;
    if (!(doc instanceof MemoDoc)) return;
    const name = await promptText("새 파일 이름", doc.info.file);
    this.view.focus();
    const file = name?.trim();
    if (!file || file === doc.info.file) return;
    await doc.rename(file);
  }

  private async showPicker(): Promise<void> {
    const items = await this.backend.listWorkspaces();
    await workspacePicker(items, {
      open: (path) =>
        void this.backend.openWorkspace(path).catch((error: unknown) => this.report(error)),
      create: async (name) => {
        try {
          await this.backend.createWorkspace(name);
          return null;
        } catch (error) {
          return describeError(error);
        }
      },
    });
    if (this.tabs.active) this.view.focus();
  }

  private async showSettings(): Promise<void> {
    // The native menu works under a modal: a second ⌘, must not pile a second screen on the first.
    if (this.settingsOpen) return;
    this.settingsOpen = true;
    const subscribers = new Set<() => void>();
    await openSettings({
      backend: this.backend,
      registry: () => this.registry,
      onConfigChanged: (handler) => {
        subscribers.add(handler);
        this.configListeners.add(handler);
        return () => {
          subscribers.delete(handler);
          this.configListeners.delete(handler);
        };
      },
    });
    // Escape closes the screen without its unsubscribe.
    for (const handler of subscribers) this.configListeners.delete(handler);
    this.settingsOpen = false;
    if (this.tabs.active) this.view.focus();
  }

  private reconfigureLanguage(doc: Doc): void {
    if (!doc.state) return;
    const effects = [
      languageEffect(doc.fileName, this.languageOf(doc)?.id),
      languageDataEffect(doc.languageData),
      highlightEffect(this.highlightFor(doc, doc.state.doc.length)),
    ];
    if (doc === this.tabs.active && this.view.state === doc.state) this.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
    if (doc === this.tabs.active) this.showLanguage(doc);
  }

  /** The status bar's language; a button for a tab showing text. */
  private showLanguage(doc: Doc): void {
    const label = languageLabelFor(this.languageOf(doc), doc.fileName);
    const editable = doc.state && !doc.problem;
    this.statusBar.setLanguage(label, editable ? () => void this.pickLanguageFor(doc) : undefined);
  }

  private async pickLanguageFor(doc: Doc): Promise<void> {
    const current = this.languageOf(doc)?.id ?? null;
    const picked = await pickLanguage(this.registry.languages, current);
    this.view.focus();
    if (!picked || picked.id === current) return;
    try {
      await doc.changeLanguage(picked);
    } catch (error) {
      this.report(error);
    }
  }

  private async refreshMemos(): Promise<void> {
    try {
      this.memoList.setMemos(await this.backend.listMemos());
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    console.error(error);
    this.statusBar.setMessage(describeError(error), "error");
  }
}
