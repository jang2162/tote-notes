import type { Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import type {
  Backend,
  FlushGoal,
  LanguageInfo,
  MemoInfo,
  OutsideChange,
  PerfConfig,
  TabRef,
} from "../backend/types";
import { decodeText } from "../core/codec";
import { WriteScheduler } from "../core/scheduler";
import { settleComposition } from "../editor/compose";
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
import { railItems, railShortcut, WorkspaceRail, type RailItem } from "../ui/rail";
import { SearchPanel } from "../ui/search-panel";
import { openSettings } from "../ui/settings";
import { Sidebar } from "../ui/sidebar";
import { StatusBar } from "../ui/status-bar";
import type { TabDrag } from "../ui/tab-bar";
import { openVersions } from "../ui/versions";
import type { LargeTextViewer } from "../viewer/large-text";
import {
  CHOOSE_VERSION_FIRST,
  ExternalDoc,
  importExternal,
  MemoDoc,
  type Change,
  type Doc,
  type DocHost,
} from "./docs";
import { describeError } from "./errors";
import { canSplit, remove, resize, split } from "./layout";
import { Pane, type PaneHost } from "./pane";
import { sessionTab, SessionSync } from "./session-sync";

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
/** How long another window's changes to the memo list are gathered before one listing. */
const MEMOS_GATHER_MS = 300;

export const VERSIONS_ONLY_IN_MEMOS = "메모 탭에서만 쓸 수 있습니다";
export const NO_VERSIONS = "이전 버전이 없습니다";
export const TOO_NARROW_TO_SPLIT = "창이 좁아 나눌 수 없습니다";
export const NOT_MOVED_TO_NEW_WINDOW = "저장하지 못해 새 창으로 옮기지 않았습니다";
/** 「탭을 새 창으로 옮기기」: an item of the window menu and of a tab's context menu. */
export const MOVE_TAB_TO_NEW_WINDOW = "move-tab-to-new-window";
const NEW_WORKSPACE_NAME = "새 워크스페이스 이름";
/** The strip along the editing area's right edge where a dragged tab opens a new pane. */
export const DROP_EDGE_PX = 48;

/** Where a dragged tab would go (`AppController.dropTarget`). */
type DropTarget = "edge" | { pane: Pane; index: number } | null;

const sameTab = (a: TabRef, b: TabRef) =>
  a.kind === "memo"
    ? b.kind === "memo" && a.id === b.id
    : b.kind === "external" && a.path === b.path;

/** One workspace window: the workspace rail, the sidebar, the status bar, menu actions, opening and
 * closing tabs, the session and the places its tabs hold. Each editor pane — its tabs, tab bar and
 * editor area — is a `Pane`; the session is read and written by `SessionSync`. */
export class AppController implements DocHost, PaneHost {
  readonly writes = new WriteScheduler((_key, error) => this.report(error));
  /** The window's panes, left to right; at least one. */
  readonly panes: Pane[];
  /** The pane the keys, the menu, the memo list and the status bar act on. */
  focused: Pane;
  /** The window wrote its tabs to close or to switch its workspace (`leave`). */
  leaving = false;
  /** The panes' shares of the editing area's width (`layout.ts`), one per pane. */
  private widths = [1];
  private readonly panesEl = h("div", { class: "panes" });
  registry = new Registry(EMPTY_REGISTRY);
  readonly theme: ThemeManager;
  readonly highlight = new HighlightClient(
    new Worker(new URL("../highlight/worker.ts", import.meta.url), { type: "module" }),
    () => this.registry,
    (ext, path) => this.backend.readExtensionFile(ext, path),
  );
  /** Open settings screens listen here: the backend takes one config handler per window. */
  private settingsOpen = false;
  private versionsOpen = false;
  /** `extensionSignature` of the registry the caches were filled from. */
  private extensionSet = "";
  private readonly configListeners = new Set<() => void>();
  private readonly languageConfigs = new Map<string, Promise<LanguageData>>();
  /** Each tab's document in the highlight worker, kept from tab switch to tab switch. */
  private readonly highlights = new Map<Doc, { key: string; highlighting: WorkerHighlighting }>();
  /** The place each open tab holds among every window's tabs (`Backend.claimTabs`): what it was
   * claimed as, which a memo saved under a new ID no longer is. */
  private readonly held = new Map<Doc, TabRef>();
  private session!: SessionSync;
  private deviceId = "";
  /** Session writes wait until the restored tabs are in place. */
  private restoring = true;
  /** A memo listing has come through. The session is restored only after one: without the memos
   * its memo tabs have nothing to stand for, and a session written then would drop them. */
  private memosLoaded = false;
  /** Another window's change to the memo list is waiting to be read (`MEMOS_GATHER_MS`). */
  private memosChangedSoon: number | null = null;
  private readonly memoList = new MemoList((id) => void this.openMemo(id));
  private readonly searchPanel = new SearchPanel({
    search: (query, onEvent) =>
      this.backend.searchWorkspace(query, ++this.workspaceSearches, onEvent),
    cancel: () =>
      void this.backend.cancelWorkspaceSearch().catch((error: unknown) => console.warn(error)),
    open: (id, line, column) =>
      void this.openMatch(id, line, column).catch((error: unknown) => this.report(error)),
    onEscape: () => this.closeSearch(),
    mark: (name) => this.mark(name),
  });
  private readonly sidebar = new Sidebar(this.memoList, this.searchPanel);
  private readonly rail = new WorkspaceRail({
    pick: (item) => void this.switchTo(item.path),
    add: () => void this.newWorkspace(),
  });
  /** What the rail shows, for ⌃1 – ⌃9. */
  private railList: RailItem[] = [];
  /** The folder of the workspace the window shows. */
  private workspacePath = "";
  private readonly statusBar = new StatusBar();
  /** Numbers the panes of this window, for their ids. */
  private paneCount = 0;
  /** Numbers the large text searches of this window (`PaneHost.nextTextSearch`). */
  private searches = 0;
  /** Numbers the workspace searches of this window, apart from `searches`: the backend keeps one
   * of each running. Starts at 1 — 0 is `cancelWorkspaceSearch`'s. */
  private workspaceSearches = 0;
  /** The tabs that have had their first colours (`open-first-tokens`) — a timing mark,
   * tests/measure/perf.md. */
  private readonly coloured = new Set<string>();
  /** Marks are sent only when the app keeps them (`TOTE_PERF=1`); asked once as the window starts. */
  private perf: PerfConfig = { enabled: false, search: null };

  constructor(
    root: HTMLElement,
    readonly backend: Backend,
  ) {
    // Not a field initializer: those run before the `backend` parameter property is assigned.
    this.theme = new ThemeManager(backend, () => this.registry);
    this.focused = this.makePane();
    this.panes = [this.focused];
    this.panesEl.append(this.focused.el);
    this.syncPanes();
    root.replaceChildren(
      this.rail.el,
      this.sidebar.el,
      h("main", { class: "main" }, this.panesEl, this.statusBar.el),
    );
  }

  /** The focused pane's editor (the UI tests drive it). */
  get view(): EditorView {
    return this.focused.view;
  }

  /** The large text viewer on show in the focused pane (public: the UI tests call `goToLine`). */
  get largeText(): { doc: Doc; viewer: LargeTextViewer; owner: string } | null {
    return this.focused.largeText;
  }

  /** Every open tab of the window, pane by pane. */
  private get docs(): Doc[] {
    return this.panes.flatMap((pane) => pane.tabs.list);
  }

  /** The pane showing `doc`: the focused one for a tab not in a pane yet. */
  private paneOf(doc: Doc): Pane {
    return this.panes.find((pane) => pane.tabs.list.includes(doc)) ?? this.focused;
  }

  viewOf(doc: Doc): EditorView {
    return this.paneOf(doc).view;
  }

  private memoTab(id: string): MemoDoc | undefined {
    for (const pane of this.panes) {
      const doc = pane.tabs.memo(id);
      if (doc) return doc;
    }
    return undefined;
  }

  private externalTab(path: string): ExternalDoc | undefined {
    for (const pane of this.panes) {
      const doc = pane.tabs.external(path);
      if (doc) return doc;
    }
    return undefined;
  }

  private isActive(doc: Doc): boolean {
    return this.paneOf(doc).tabs.active === doc;
  }

  statusOf(pane: Pane): StatusBar | null {
    return pane === this.focused ? this.statusBar : null;
  }

  showing(pane: Pane, doc: Doc | null): void {
    if (pane !== this.focused) return;
    this.memoList.setActive(doc instanceof MemoDoc ? doc.info.id : null);
    if (doc) this.showLanguage(doc);
    else this.statusBar.setLanguage("");
  }

  nextTextSearch(): number {
    return ++this.searches;
  }

  async start(): Promise<void> {
    const [info, perf] = await Promise.all([
      // The first call of a page: after a switch it lets the window write again
      // (`AppCore::page_started`). The rail and ⌃1–⌃9 are wired after it, so an old page has
      // always made it before its window switches.
      this.backend.workspaceInfo(),
      // A mark must never be what fails a window.
      this.backend.perfConfig().catch(() => this.perf),
    ]);
    this.perf = perf;
    this.deviceId = info.deviceId;
    this.workspacePath = info.path;
    document.title = info.title;
    void this.refreshRail();
    this.backend.onWorkspacesChanged(() => void this.refreshRail());
    // In the capture phase: the editor and the dialogs see the keys after this.
    document.addEventListener(
      "keydown",
      (event) => {
        const index = railShortcut(event);
        const item = index === null ? undefined : this.railList[index];
        // A window that answered a close or a switch has no tabs left to write; a dialog keeps the
        // window until it is answered.
        if (!item || this.leaving || document.querySelector(".modal")) return;
        event.preventDefault();
        event.stopPropagation();
        void this.switchTo(item.path);
      },
      true,
    );
    await this.loadRegistry();
    this.extensionSet = extensionSignature(this.registry);
    this.backend.onConfigChanged(() => void this.onConfigChanged());
    this.theme.onChange((active) => {
      if (active.theme) void this.highlight.setTheme(tokenTheme(active.theme));
      for (const pane of this.panes) pane.setViewerTheme(active.variables);
    });
    await this.theme.start();
    this.session = new SessionSync(
      this.backend,
      () => ({
        panes: this.panes,
        widths: this.widths,
        focusedPane: this.panes.indexOf(this.focused),
      }),
      this.deviceId,
      (id) => this.memoList.get(id),
      (memo) => new MemoDoc(this, memo),
      (path) => new ExternalDoc(this, path),
    );
    this.backend.onMenu((id) => void this.onMenu(id));
    this.backend.onFlush((id, goal) => void this.onFlush(id, goal));
    this.backend.onStay(() => this.stay());
    this.backend.onPending(() => void this.drainPending());
    this.backend.onFileDrop((paths) => void this.openExternals(paths));
    this.backend.onOutsideChange((change) => void this.onOutside(change));
    this.backend.onMemosChanged(() => this.memosChanged());
    this.backend.onReveal((tab) => void this.reveal(tab));
    // A window losing focus is a tab losing focus (spec 「저장」), and hidden windows barely run
    // timers — so write now rather than when the timer fires.
    window.addEventListener("blur", () => {
      void this.focused.tabs.active?.leave();
      // A click in a viewer's frame sends no mousedown here, only the focus into the frame: the
      // pane holding the frame becomes the focused one. The frame has the focus a tick later.
      setTimeout(() => {
        const frame = document.activeElement;
        if (!(frame instanceof HTMLIFrameElement)) return;
        const pane = this.panes.find((each) => each.el.contains(frame));
        if (pane) void this.focusOn(pane);
      }, 0);
    });
    window.addEventListener("focus", () => {
      void this.refreshMemos();
      void this.refreshRail();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void this.flushAll(false);
    });
    // Restores the session if it lists the memos; else the next listing that does (focus).
    await this.refreshMemos();
    // Memos are markdown: the first ⌘N then finds its grammars in the worker already.
    const markdown = this.registry.language("markdown");
    if (markdown) this.highlight.preload(markdown);
    this.mark("app-ready");
    // A measurement run's search (TOTE_PERF_SEARCH), run as if typed into the panel.
    const search = this.perf.search;
    if (search) {
      this.sidebar.show("search");
      this.searchPanel.run(search.query, search.regex);
    }
  }

  private async restoreSession(): Promise<void> {
    const restored = await this.session.restore();
    while (this.panes.length < restored.panes.length) {
      const pane = this.makePane();
      this.panes.push(pane);
      this.mountPane(pane);
    }
    this.widths = restored.widths;
    restored.panes.forEach(({ tabs }, index) => {
      for (const doc of tabs) {
        this.panes[index].tabs.push(doc);
        this.held.set(doc, doc.tabRef);
      }
    });
    this.setFocused(this.panes[restored.focusedPane]);
    this.syncPanes();
    // Each pane shows its active tab; only the focused one takes the keys.
    await Promise.all(
      restored.panes.map(({ active }, index) => {
        const pane = this.panes[index];
        if (active) return pane.activate(active);
        pane.renderTabs();
        return undefined;
      }),
    );
    this.restoring = false;
    this.markNextFrame("restore-done");
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
    // its files is stale, so every open tab reads its language again. Theme and root changes
    // leave the set alone and keep the caches.
    const signature = extensionSignature(this.registry);
    if (signature !== this.extensionSet) {
      this.extensionSet = signature;
      this.languageConfigs.clear();
      this.highlight.forgetGrammars();
      for (const doc of this.docs) void doc.refreshLanguage();
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
    const highlighting = workerHighlighting(this.highlight, lang, () => {
      if (!this.perf.enabled || this.coloured.has(doc.tabId)) return;
      this.coloured.add(doc.tabId);
      this.mark(`open-first-tokens:${doc.tabId}`);
    });
    this.highlights.set(doc, { key, highlighting });
    if (this.isActive(doc)) this.syncHighlightVisibility();
    return highlighting.extension;
  }

  /** Tells the worker which documents are on screen: it works on those first, and the hidden
   * tabs' documents only as far as they were shown. */
  syncHighlightVisibility(): void {
    this.highlight.setVisible(
      this.panes.flatMap((pane) => {
        const active = pane.tabs.active && this.highlights.get(pane.tabs.active);
        return active ? [active.highlighting.doc] : [];
      }),
    );
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
    const pane = this.paneOf(doc);
    const active = doc === pane.tabs.active;
    const status = this.statusOf(pane);
    if (doc instanceof MemoDoc && (change === "info" || change === "language"))
      this.memoList.upsert(doc.info);
    // A save that recovered a vanished memo gave the tab a new memo.
    if (active && status && doc instanceof MemoDoc && change === "info")
      this.memoList.setActive(doc.info.id);
    if (doc instanceof MemoDoc && change === "deleted") this.memoList.remove(doc.info.id);
    if (change === "info") this.followPlace(doc);
    if (change === "language") {
      this.reconfigureLanguage(doc);
      // An external file's pick lives in the session only.
      this.saveSessionSoon();
    }
    if (active && change === "notice") status?.setMessage(doc.notice ?? "");
    if (active && change === "banner") pane.surface.banner.render(doc.banner);
    // The kept-conflict banner is in the session until the person closes it.
    if (change === "banner" && doc instanceof MemoDoc) this.saveSessionSoon();
    if (active && change === "reloaded") pane.showReloaded(doc);
    if (active && change === "saved" && doc instanceof ExternalDoc) status?.setMessage("저장됨");
    // A memo that saved after a failed save no longer has the error to show.
    if (active && change === "saved" && doc instanceof MemoDoc && status?.showsError)
      status.setMessage("");
    // A draft kept on a retry: the failure's message is no longer true either.
    if (active && change === "recovered" && status?.showsError) status.setMessage("");
    if (change === "error") this.report(doc.error);
    pane.renderTabs();
  }

  memoInfo(id: string): MemoInfo | undefined {
    return this.memoList.get(id);
  }

  async openMemo(id: string): Promise<void> {
    let doc: Doc | undefined = this.memoTab(id);
    if (!doc) {
      let info: MemoInfo | undefined = this.memoList.get(id);
      if (!info) {
        await this.refreshMemos();
        info = this.memoList.get(id);
      }
      if (!info) return this.report(new Error("메모를 찾을 수 없습니다"));
      if (!(await this.claim({ kind: "memo", id }))) return;
      // Another request may have opened it while the claim was on its way.
      doc = this.memoTab(id) ?? this.insertClaimed(new MemoDoc(this, info));
    }
    await this.showTab(doc);
  }

  async openExternal(path: string): Promise<void> {
    let doc: Doc | undefined = this.externalTab(path);
    if (!doc) {
      if (!(await this.claim({ kind: "external", path }))) return;
      doc = this.externalTab(path) ?? this.insertClaimed(new ExternalDoc(this, path));
    }
    await this.showTab(doc);
  }

  async newMemo(): Promise<void> {
    const info = await this.backend.createMemo();
    this.memoList.upsert(info);
    if (!(await this.claim({ kind: "memo", id: info.id }))) return;
    const doc = this.insertClaimed(new MemoDoc(this, info));
    doc.startEmpty();
    await this.showTab(doc);
  }

  async closeTab(tabId: string): Promise<void> {
    const doc = this.docs.find((each) => each.tabId === tabId);
    if (!doc) return;
    const pane = this.paneOf(doc);
    pane.capture(doc);
    if (!(await doc.close(() => askUnsaved(doc.title)))) {
      // Kept open for an answer the banner is asking for: say so, or ⌘W seems to do nothing.
      if (doc.banner?.kind === "conflict") this.statusBar.setMessage(CHOOSE_VERSION_FIRST);
      if (doc === pane.tabs.active) pane.view.focus();
      return;
    }
    const shown = pane.detach(doc);
    this.release(doc);
    this.dropHighlight(doc);
    this.coloured.delete(doc.tabId);
    await shown;
    if (pane.tabs.list.length === 0) this.closePane(pane);
    this.saveSessionSoon();
  }

  /** Shows `doc` in the pane that has it, and focuses that pane. */
  private async showTab(doc: Doc): Promise<void> {
    const pane = this.paneOf(doc);
    await this.focusOn(pane);
    await pane.activate(doc);
  }

  /** Moves `doc` to `index` of `to`'s tabs (as they are before the move; `to` may be its own pane),
   * where it is the active tab of the focused pane. It is the same tab, not saved on the way: its
   * text, edit history and place go with it. A pane it leaves empty closes. */
  async moveTab(doc: Doc, to: Pane, index: number): Promise<void> {
    await settleComposition(this.focused.view);
    // Closed, or its pane closed, while the composition ended.
    if (!this.docs.includes(doc) || !this.panes.includes(to)) return;
    await this.relocate(doc, to, index);
  }

  /** Moves `doc` into a new pane right of the rightmost one, which gives it half its width. */
  async moveTabToNewPane(doc: Doc): Promise<void> {
    await settleComposition(this.focused.view);
    const from = this.paneOf(doc);
    if (!from.tabs.list.includes(doc)) return;
    const at = this.panes.length - 1;
    // The rightmost pane's only tab is where a new pane would put it already.
    if (from === this.panes[at] && from.tabs.list.length === 1) return;
    if (!canSplit(this.widths, at, this.areaWidth())) {
      this.statusBar.setMessage(TOO_NARROW_TO_SPLIT);
      return;
    }
    await this.relocate(doc, this.openPaneAfter(at), 0);
  }

  /** Moves `doc` into a new window of this workspace (「탭을 새 창으로 옮기기」), which opens with
   * it alone and reads it afresh: a memo is saved first, an external file's edits kept as its
   * draft. When that fails, or a banner still asks about the file, the tab stays and the status
   * bar says so. Leaving, the tab is not closed — a blank new memo is not deleted: it is the other
   * window's now. Returns whether it moved. */
  async tearOff(doc: Doc): Promise<boolean> {
    await settleComposition(this.focused.view);
    if (!this.docs.includes(doc)) return false;
    // The editor lets go of the tab first: a key typed while it is written and handed over would
    // reach a tab that is leaving, and its late save would land after the new window has read it.
    const from = this.paneOf(doc);
    doc.leaving = true;
    if (doc === from.tabs.active) {
      from.capture(doc);
      from.surface.showNothing();
    }
    // The tab stays: it is shown again where it is now, if it is the active tab there.
    const stay = () => {
      doc.leaving = false;
      const pane = this.paneOf(doc);
      if (!this.docs.includes(doc) || doc !== pane.tabs.active) return;
      pane.show(doc);
      if (pane === this.focused) pane.takeKeys();
    };
    let handed: boolean;
    try {
      handed = await doc.handOver();
    } catch (error) {
      stay();
      this.report(error);
      return false;
    }
    if (!handed) {
      stay();
      // After `show`, which puts the tab's own notice in the status bar.
      this.statusBar.setMessage(NOT_MOVED_TO_NEW_WINDOW, "error");
      return false;
    }
    // Closed while it was written.
    if (!this.docs.includes(doc)) return false;
    const pane = this.paneOf(doc);
    try {
      await this.backend.tearOffTab(JSON.stringify(sessionTab(doc, this.deviceId)), doc.tabRef);
    } catch (error) {
      stay();
      this.report(error);
      return false;
    }
    // The backend gave its place to the new window: there is nothing to release.
    this.held.delete(doc);
    const shown = pane.detach(doc);
    if (doc instanceof ExternalDoc) doc.stopWatching();
    this.dropHighlight(doc);
    this.coloured.delete(doc.tabId);
    await shown;
    if (pane.tabs.list.length === 0) this.closePane(pane);
    this.saveSessionSoon();
    return true;
  }

  async tabMenu(tabId: string): Promise<void> {
    const doc = this.docs.find((each) => each.tabId === tabId);
    if (!doc) return;
    const picked = await this.backend.showTabMenu([
      { id: MOVE_TAB_TO_NEW_WINDOW, text: "탭을 새 창으로 옮기기" },
    ]);
    if (picked === MOVE_TAB_TO_NEW_WINDOW) await this.tearOff(doc);
  }

  /** `moveTab` once any composition has ended. */
  private async relocate(doc: Doc, to: Pane, index: number): Promise<void> {
    const from = this.paneOf(doc);
    const left = this.focused;
    let shown: Promise<void> | undefined;
    if (from !== to) {
      from.capture(doc);
      shown = from.detach(doc);
    }
    to.tabs.place(doc, index);
    if (left !== to) {
      this.setFocused(to);
      if (left !== from) void left.tabs.active?.leave();
    }
    to.renderTabs();
    await Promise.all([shown, to.activate(doc)]);
    if (from.tabs.list.length === 0) this.closePane(from);
    this.saveSessionSoon();
  }

  dragTab(tabId: string): TabDrag {
    const edge = h("div", { class: "pane-drop-edge" });
    this.panesEl.append(edge);
    let marked: Pane | null = null;
    const mark = (target: DropTarget) => {
      marked?.tabBar.markDrop(null);
      marked = null;
      edge.classList.toggle("active", target === "edge");
      if (!target || target === "edge") return;
      marked = target.pane;
      marked.tabBar.markDrop(target.index);
    };
    const end = () => {
      mark(null);
      edge.remove();
    };
    return {
      over: (x, y) => mark(this.dropTarget(x, y)),
      drop: (x, y) => {
        const target = this.dropTarget(x, y);
        end();
        const doc = this.docs.find((each) => each.tabId === tabId);
        if (!doc || !target) return;
        const moved =
          target === "edge"
            ? this.moveTabToNewPane(doc)
            : this.moveTab(doc, target.pane, target.index);
        void moved.catch((error: unknown) => this.report(error));
      },
      cancel: end,
    };
  }

  /** Where a tab dropped at (`x`, `y`) goes: the right edge of the editing area (a new pane), a
   * place in a pane's tab bar, or — anywhere else in a pane — the end of its tabs. */
  private dropTarget(x: number, y: number): DropTarget {
    const area = this.panesEl.getBoundingClientRect();
    if (x < area.left || x > area.right || y < area.top || y > area.bottom) return null;
    if (x >= area.right - DROP_EDGE_PX) return "edge";
    const hit = document.elementsFromPoint(x, y);
    const pane = this.panes.find((each) => hit.includes(each.el));
    if (!pane) return null;
    const index = hit.includes(pane.tabBar.el) ? pane.tabBar.indexAt(x) : pane.tabs.list.length;
    return { pane, index };
  }

  private makePane(): Pane {
    const pane = new Pane(`pane-${++this.paneCount}`, this);
    // A click anywhere in a pane — its tab bar, its editor — focuses it.
    pane.el.addEventListener("mousedown", () => void this.focusOn(pane), { capture: true });
    return pane;
  }

  /** Puts `pane`, already in `panes`, on screen in its place, a divider between it and its
   * neighbour. The other panes stay where they are in the DOM: one moved would lose its focus, and
   * its viewer frame would load again. */
  private mountPane(pane: Pane): void {
    const index = this.panes.indexOf(pane);
    if (index > 0) this.panes[index - 1].el.after(this.divider(), pane.el);
    else this.panesEl.prepend(pane.el, this.divider());
  }

  /** The panes' widths, which is focused, and what an empty pane says, as they are now. */
  private syncPanes(): void {
    this.panesEl.classList.toggle("split", this.panes.length > 1);
    this.syncWidths();
    for (const pane of this.panes) {
      pane.el.classList.toggle("focused", pane === this.focused);
      if (pane.tabs.list.length === 0) pane.showEmptyText();
    }
  }

  private syncWidths(): void {
    this.panes.forEach((pane, index) => (pane.el.style.flexGrow = String(this.widths[index])));
  }

  /** The editing area's width: the panes', without the dividers between them. */
  private areaWidth(): number {
    return this.panes.reduce((sum, pane) => sum + pane.el.getBoundingClientRect().width, 0);
  }

  /** The boundary between the pane on its left and the one on its right; dragged, it moves. */
  private divider(): HTMLElement {
    const el = h("div", { class: "pane-divider" });
    el.addEventListener("pointerdown", (down) => {
      const boundary = this.panes.findIndex((pane) => pane.el === el.previousElementSibling);
      if (boundary < 0 || down.button !== 0) return;
      down.preventDefault();
      el.setPointerCapture(down.pointerId);
      const start = this.widths;
      const area = this.areaWidth();
      const end = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", end);
        el.removeEventListener("pointercancel", end);
        this.saveSessionSoon();
      };
      const move = (event: PointerEvent) => {
        // A pane opened or closed under the drag: its widths no longer fit.
        if (this.widths.length !== start.length) return end();
        this.widths = resize(start, boundary, event.clientX - down.clientX, area);
        this.syncWidths();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
    return el;
  }

  /** ⌘\: the focused pane gives the right half of its width to a new pane, which takes the
   * active tab and the focus — or opens empty when that tab is the pane's only one. */
  async splitPane(): Promise<void> {
    const from = this.focused;
    await settleComposition(from.view);
    if (this.focused !== from) return;
    const at = this.panes.indexOf(from);
    if (!canSplit(this.widths, at, this.areaWidth())) {
      this.statusBar.setMessage(TOO_NARROW_TO_SPLIT);
      return;
    }
    const moving = from.tabs.list.length > 1 ? from.tabs.active : null;
    const pane = this.openPaneAfter(at);
    this.setFocused(pane);
    if (moving) await this.relocate(moving, pane, 0);
    else void from.tabs.active?.leave();
  }

  /** A new, empty pane right of pane `at`, which gives it the right half of its width. */
  private openPaneAfter(at: number): Pane {
    const pane = this.makePane();
    this.panes.splice(at + 1, 0, pane);
    this.widths = split(this.widths, at);
    this.mountPane(pane);
    this.syncPanes();
    return pane;
  }

  /** ⌥⌘← / ⌥⌘→: the pane left or right of the focused one; nothing past either end. */
  async focusPane(step: -1 | 1): Promise<void> {
    const next = this.panes[this.panes.indexOf(this.focused) + step];
    if (next) await this.focusOn(next);
  }

  /** Closes `pane`, which has no tabs; the window's only pane stays. Its width goes to its left
   * neighbour (the right one when it is leftmost), and so does the focus when it had it. */
  closePane(pane: Pane): void {
    const at = this.panes.indexOf(pane);
    if (at < 0 || this.panes.length < 2) return;
    this.panes.splice(at, 1);
    this.widths = remove(this.widths, at);
    // Its divider is the one on its left, or on its right when it was leftmost.
    (pane.el.previousElementSibling ?? pane.el.nextElementSibling)?.remove();
    pane.el.remove();
    pane.closePanel();
    pane.view.destroy();
    if (this.focused === pane) this.setFocused(this.panes[Math.max(at - 1, 0)]);
    this.syncPanes();
    this.saveSessionSoon();
  }

  /** Moves the focus to `pane`. A composition in the pane left lands there first (core spec
   * 「편집기」), then its tab is left as a tab losing focus is: its title is made, it saves. */
  private async focusOn(pane: Pane): Promise<void> {
    const left = this.focused;
    if (pane === left) return;
    await settleComposition(left.view);
    // Closed meanwhile, or the focus went elsewhere while the composition ended.
    if (!this.panes.includes(pane) || this.focused !== left) return;
    this.setFocused(pane);
    void left.tabs.active?.leave();
  }

  /** The keys, the menu, the memo list and the status bar go to `pane` from now. */
  private setFocused(pane: Pane): void {
    this.focused = pane;
    for (const each of this.panes) each.el.classList.toggle("focused", each === pane);
    pane.showStatus();
    pane.takeKeys();
    this.saveSessionSoon();
  }

  /** Claims `tab` for this window before a tab is made for it. False when another window holds
   * it: the backend has brought that window forward to show it, and nothing opens here. */
  private async claim(tab: TabRef): Promise<boolean> {
    try {
      const [claimed] = await this.backend.claimTabs([tab], true);
      return claimed;
    } catch (error) {
      // A place that cannot be asked for is taken as given: the tab opens here rather than not at
      // all, and the console says why it may be open twice.
      console.error(error);
      return true;
    }
  }

  private insertClaimed<D extends Doc>(doc: D): D {
    this.held.set(doc, doc.tabRef);
    return this.focused.tabs.insertAfterActive(doc);
  }

  /** `doc` took a tab over under a name of its own (an import): the place goes with the name. */
  private hold(doc: Doc): void {
    this.held.set(doc, doc.tabRef);
    void this.backend.claimTabs([doc.tabRef], false).catch((error: unknown) => console.warn(error));
  }

  private release(doc: Doc): void {
    const held = this.held.get(doc);
    if (!held) return;
    this.held.delete(doc);
    void this.backend.releaseTab(held).catch((error: unknown) => console.warn(error));
  }

  /** A save that recovered a vanished memo gave the tab a new memo ID: its place follows. */
  private followPlace(doc: Doc): void {
    const held = this.held.get(doc);
    if (!held || sameTab(held, doc.tabRef)) return;
    this.release(doc);
    this.hold(doc);
  }

  /** Another window asked for a tab this window holds. */
  private async reveal(tab: TabRef): Promise<void> {
    const doc = tab.kind === "memo" ? this.memoTab(tab.id) : this.externalTab(tab.path);
    if (doc) await this.showTab(doc);
  }

  /** Everything written now — tab edits, titles and the session. `closing` (the window closes or
   * the app quits) also settles what waits for a choice, a conflicted memo; a window that only
   * hides leaves that open. */
  async flushAll(closing = true): Promise<void> {
    await Promise.all(
      this.docs.map((doc) =>
        (closing ? doc.flush() : doc.leave()).catch((error: unknown) => this.report(error)),
      ),
    );
    await this.saveSessionNow();
  }

  /** Answers with what is still only in memory: the native side asks before closing over it. A
   * window that closes or switches lets go of its tabs before it answers (`leave`). */
  private async onFlush(id: number, goal: FlushGoal): Promise<void> {
    try {
      // A syllable still being composed goes into its own tab before the tabs are written
      // (closing, quitting, switching the workspace).
      await Promise.all(this.panes.map((pane) => settleComposition(pane.view)));
      await this.flushAll(true);
      // The window stays open until the native side acts on the answer, and a key typed after the
      // tabs are written would be lost with it. The editors take keys while the tabs are written:
      // what came in meanwhile is written too before the answer.
      if (goal !== "quit") this.leave();
      if (this.docs.some((doc) => doc.unwritten)) await this.flushAll(true);
    } finally {
      const failed = this.docs.filter((doc) => doc.saveFailed).length;
      await this.backend.flushDone(id, failed ? `저장하지 못한 메모 ${failed}개` : undefined);
    }
  }

  /** The window wrote its tabs to close or to switch its workspace (`onFlush`): every pane lets go
   * of its tab until the window goes, or stays (`stay`). A tab opened meanwhile is not shown
   * either (`Pane.show`). */
  leave(): void {
    this.leaving = true;
    for (const pane of this.panes) {
      const active = pane.tabs.active;
      if (active) pane.capture(active);
      pane.surface.showNothing();
    }
  }

  /** The close or switch is off (`tote://stay`): each pane shows its tab again, and the focused
   * pane takes the keys. */
  stay(): void {
    if (!this.leaving) return;
    this.leaving = false;
    for (const pane of this.panes) {
      const active = pane.tabs.active;
      if (active) pane.show(active);
      else pane.showEmptyText();
    }
    this.focused.takeKeys();
  }

  private onUpdate(doc: Doc, update: ViewUpdate): void {
    doc.update(update);
    const pane = this.paneOf(doc);
    if (doc !== pane.tabs.active || !(update.docChanged || update.selectionSet)) return;
    this.statusOf(pane)?.setPosition(update.state);
    this.saveSessionSoon();
  }

  /** Another app changed the workspace or a watched file (spec 「외부 변경」): each tab it names
   * reacts, then the memo list is listed again (names, order, added and removed memos). */
  private async onOutside(change: OutsideChange): Promise<void> {
    try {
      if (change.kind === "external") {
        await this.externalTab(change.path)?.onOutside(change.state);
        return;
      }
      for (const each of change.changes) await this.memoTab(each.id)?.onOutside(each);
    } catch (error) {
      this.report(error);
    }
    if (change.kind === "workspace") await this.refreshMemos();
  }

  mark(name: string): void {
    if (this.perf.enabled) this.backend.perfMark(name);
  }

  markNextFrame(name: string): void {
    if (this.perf.enabled) requestAnimationFrame(() => this.backend.perfMark(name));
  }

  private async openExternals(paths: string[]): Promise<void> {
    for (const path of paths) await this.openExternal(path);
  }

  private async cycleTab(step: number): Promise<void> {
    const next = this.focused.tabs.cycle(step);
    if (next) await this.focused.activate(next);
  }

  saveSessionSoon(): void {
    if (!this.restoring)
      this.writes.schedule("session", SESSION_DELAY_MS, () => this.writeSession());
  }

  private async saveSessionNow(): Promise<void> {
    if (this.restoring) return;
    this.writes.schedule("session", 0, () => this.writeSession());
    await this.writes.flush("session");
  }

  private async writeSession(): Promise<void> {
    const session = await this.session.build(() => {
      for (const pane of this.panes) if (pane.tabs.active) pane.capture(pane.tabs.active);
    });
    await this.backend.writeWindowLayout(JSON.stringify(session));
  }

  private async drainPending(): Promise<void> {
    if (this.restoring) return;
    const notices: string[] = [];
    for (const open of await this.backend.takePendingOpens()) {
      if (open.kind === "memo") {
        await this.refreshMemos();
        await this.openMemo(open.id);
      } else if (open.kind === "external") {
        await this.openExternal(open.path);
      } else {
        notices.push(open.message);
      }
    }
    // After the opens: showing a tab sets the status bar, which would wipe a failure of the same
    // request (`tote -i 없는.txt 있는.txt`) before anyone saw it.
    if (notices.length) this.statusBar.setMessage(notices.join(" · "), "error");
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
          if (this.focused.tabs.active) return await this.closeTab(this.focused.tabs.active.tabId);
          // An empty pane closes; the only one stays, and the window closes instead.
          if (this.panes.length > 1) return this.closePane(this.focused);
          return await this.backend.closeWindow();
        case "split-pane":
          return await this.splitPane();
        case "focus-pane-left":
          return await this.focusPane(-1);
        case "focus-pane-right":
          return await this.focusPane(1);
        case MOVE_TAB_TO_NEW_WINDOW:
          if (this.focused.tabs.active) await this.tearOff(this.focused.tabs.active);
          return;
        case "next-tab":
          return await this.cycleTab(1);
        case "prev-tab":
          return await this.cycleTab(-1);
        case "toggle-preview":
          return await this.togglePreview();
        case "open-workspace":
          return await this.showPicker();
        case "new-workspace":
          return await this.newWorkspace();
        case "settings":
          return await this.showSettings();
        case "versions":
          return await this.showVersions();
        case "reveal-backups":
          return await this.backend.revealBackups();
        case "search-workspace":
          this.sidebar.show("search");
          return this.searchPanel.focus();
      }
    } catch (error) {
      this.report(error);
    }
  }

  /** The search panel's Escape: back to the memo list and the tab. */
  private closeSearch(): void {
    this.sidebar.show("memos");
    if (this.focused.tabs.active) this.focused.view.focus();
  }

  /** A search result (spec 「워크스페이스 검색」): the memo's tab, its cursor on the match. */
  private async openMatch(id: string, line: number, column: number): Promise<void> {
    // Set before the tab opens, on the pane it opens in: its viewer may be on show before
    // `openMemo` returns.
    const open = this.memoTab(id);
    (open ? this.paneOf(open) : this.focused).pendingLine = { memoId: id, line };
    await this.openMemo(id);
    const doc = this.memoTab(id);
    if (!doc) return;
    await doc.ensureLoaded();
    const pane = this.paneOf(doc);
    if (doc !== pane.tabs.active) return;
    // A viewer already on show takes the line now; one on its way, in `openLargeText`.
    if (pane.largeText?.doc === doc) pane.takePendingLine(doc);
    if (doc.problem === "too-large" || doc.problem === "long-line") return;
    pane.pendingLine = null;
    if (!doc.state || doc.problem) return;
    const spec = { selection: { anchor: doc.positionOf(line, column) }, scrollIntoView: true };
    if (pane.view.state === doc.state) {
      pane.view.dispatch(spec);
      pane.view.focus();
      return;
    }
    // A Markdown preview on show: the editor takes up from there on ⇧⌘V.
    const start = doc.state;
    const { state } = start.update(spec);
    doc.update({ state, startState: start, docChanged: false, selectionSet: true });
    doc.scrollAnchor = state.doc.lineAt(state.selection.main.head).from;
  }

  /** ⇧⌘V (spec 「마크다운 미리보기」): per tab, with the text as it is right now. */
  async togglePreview(): Promise<void> {
    const pane = this.focused;
    const doc = pane.tabs.active;
    if (!doc || !this.registry.viewerFor(doc.fileName, "preview")) return;
    // A tab just picked may still be reading its file: its `show` comes first, then this switch.
    await doc.ensureLoaded();
    if (pane.tabs.active !== doc || !doc.state || doc.problem) return;
    // `capture` reads the scroll only while the editor shows, so a preview keeps the anchor.
    pane.capture(doc);
    await doc.leave();
    if (pane.tabs.active !== doc) return;
    doc.mode = doc.mode === "preview" ? "edit" : "preview";
    pane.show(doc);
    this.saveSessionSoon();
  }

  private async saveActive(): Promise<void> {
    const doc = this.focused.tabs.active;
    if (doc instanceof ExternalDoc) await doc.save();
    else if (doc instanceof MemoDoc) await doc.saveNow();
  }

  private async importActive(): Promise<void> {
    const pane = this.focused;
    const doc = pane.tabs.active;
    if (!(doc instanceof ExternalDoc)) return;
    pane.capture(doc);
    const memo = await importExternal(doc, this);
    pane.tabs.replace(doc, memo);
    this.release(doc);
    this.hold(memo);
    this.dropHighlight(doc);
    this.memoList.upsert(memo.info);
    pane.tabs.active = null;
    await pane.activate(memo);
    if (memo.error) this.report(memo.error);
    else this.statusBar.setMessage("워크스페이스로 가져왔습니다");
  }

  private async renameActive(): Promise<void> {
    const pane = this.focused;
    const doc = pane.tabs.active;
    if (!(doc instanceof MemoDoc)) return;
    const name = await promptText("새 파일 이름", doc.info.file);
    pane.view.focus();
    const file = name?.trim();
    if (!file || file === doc.info.file) return;
    await doc.rename(file);
  }

  private async refreshRail(): Promise<void> {
    try {
      this.railList = railItems(await this.backend.listWorkspaces(), this.workspacePath);
      this.rail.render(this.railList);
    } catch (error) {
      console.warn(error);
    }
  }

  /** The rail and ⌃1 – ⌃9: this window shows the workspace at `path`. The backend has the window
   * write its tabs (`onFlush`), then reloads it; a workspace another window shows comes forward
   * instead. */
  private async switchTo(path: string): Promise<void> {
    this.mark("switch-click");
    try {
      await this.backend.switchWorkspace(path);
    } catch (error) {
      this.report(error);
    }
  }

  /** The rail's `+` and 「새 워크스페이스…」: a workspace made wherever it is asked for opens in
   * this window. */
  private async newWorkspace(): Promise<void> {
    const name = (await promptText(NEW_WORKSPACE_NAME, ""))?.trim();
    if (!name) {
      if (this.focused.tabs.active) this.focused.view.focus();
      return;
    }
    try {
      await this.backend.switchWorkspace(await this.backend.createWorkspace(name));
    } catch (error) {
      this.report(error);
    }
  }

  private async showPicker(): Promise<void> {
    const items = await this.backend.listWorkspaces();
    await workspacePicker(items, {
      open: (path) =>
        void this.backend.openWorkspace(path).catch((error: unknown) => this.report(error)),
      // Made here, it opens in this window; one picked opens in a window of its own.
      create: async (name) => {
        try {
          const path = await this.backend.createWorkspace(name);
          void this.backend.switchWorkspace(path).catch((error: unknown) => this.report(error));
          return null;
        } catch (error) {
          return describeError(error);
        }
      },
      relocate: async (from) => {
        try {
          const to = await this.backend.pickFolder();
          if (to === null) return "";
          await this.backend.relocateWorkspace(from, to);
          return null;
        } catch (error) {
          return describeError(error);
        }
      },
    });
    if (this.focused.tabs.active) this.focused.view.focus();
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
    if (this.focused.tabs.active) this.focused.view.focus();
  }

  /** 「이전 버전…」 (spec 「백업」 복원): the active memo's backed-up versions. The one picked
   * replaces the text as a single edit — ⌘Z takes it back — and saves like any edit. */
  async showVersions(): Promise<void> {
    // The native menu works under a modal: a second pick must not stack a second dialog, nor
    // start one while the first is still listing.
    if (this.versionsOpen) return;
    this.versionsOpen = true;
    try {
      await this.pickVersion();
    } finally {
      this.versionsOpen = false;
    }
    if (this.focused.tabs.active) this.focused.view.focus();
  }

  private async pickVersion(): Promise<void> {
    const pane = this.focused;
    const doc = pane.tabs.active;
    if (doc) await doc.ensureLoaded();
    if (!(doc instanceof MemoDoc) || doc !== pane.tabs.active || !doc.state || doc.problem) {
      this.statusBar.setMessage(VERSIONS_ONLY_IN_MEMOS);
      return;
    }
    const versions = await this.backend.listVersions(doc.info.id);
    if (!versions.length) {
      this.statusBar.setMessage(NO_VERSIONS);
      return;
    }
    const picked = await openVersions(versions, async (version) => {
      const bytes = await this.backend.readVersion(version.snapshot, version.file);
      const decoded = decodeText(bytes);
      if (!decoded) throw new Error("텍스트로 읽을 수 없는 버전입니다");
      return decoded.text;
    });
    // The tab may have closed while the dialog was open: its text goes nowhere then.
    if (!picked || !this.docs.includes(doc)) return;
    doc.restoreText(picked.text);
    // A preview shows the text it was given; give it the restored one.
    const shown = this.paneOf(doc);
    if (doc === shown.tabs.active && doc.mode === "preview") shown.show(doc);
  }

  private reconfigureLanguage(doc: Doc): void {
    if (!doc.state) return;
    const effects = [
      languageEffect(doc.fileName, this.languageOf(doc)?.id),
      languageDataEffect(doc.languageData),
      highlightEffect(this.highlightFor(doc, doc.state.doc.length)),
    ];
    const pane = this.paneOf(doc);
    if (doc === pane.tabs.active && pane.view.state === doc.state) pane.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
    if (doc === pane.tabs.active && pane === this.focused) this.showLanguage(doc);
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
    this.paneOf(doc).view.focus();
    if (!picked || picked.id === current) return;
    try {
      await doc.changeLanguage(picked);
    } catch (error) {
      this.report(error);
    }
  }

  /** Another window changed the memo list: a burst of them (typing that renames a memo, an
   * import of many files) is read once. */
  private memosChanged(): void {
    if (this.memosChangedSoon !== null) return;
    this.memosChangedSoon = window.setTimeout(() => {
      this.memosChangedSoon = null;
      void this.refreshMemos();
    }, MEMOS_GATHER_MS);
  }

  private async refreshMemos(): Promise<void> {
    try {
      this.memoList.setMemos(await this.backend.listMemos());
    } catch (error) {
      this.report(error);
      return;
    }
    if (this.memosLoaded) return;
    this.memosLoaded = true;
    try {
      await this.restoreSession();
    } catch (error) {
      // The next listing tries again: a window that never restores never writes its session.
      this.memosLoaded = false;
      this.report(error);
      return;
    }
    await this.drainPending();
  }

  report(error: unknown): void {
    console.error(error);
    this.statusBar.setMessage(describeError(error), "error");
  }
}
