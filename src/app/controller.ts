import type { Extension } from "@codemirror/state";
import { EditorView, type KeyBinding, type ViewUpdate } from "@codemirror/view";

import type {
  Backend,
  FlushGoal,
  LanguageInfo,
  MemoInfo,
  OutsideChange,
  PerfConfig,
  Settings,
  ShortcutTable,
  TabRef,
} from "../backend/types";
import { decodeText } from "../core/codec";
import { pageLeaving } from "../core/leaving";
import { WriteScheduler } from "../core/scheduler";
import {
  isSessionPane,
  parseTab,
  parseWindowSession,
  sessionPanes,
  type SessionNode,
  type SessionTab,
} from "../core/session";
import { settleComposition } from "../editor/compose";
import { runHistoryMenu } from "../editor/history-menu";
import {
  languageData,
  parseLanguageConfiguration,
  type LanguageData,
} from "../editor/language-config";
import {
  editorExtensions,
  type EditorFont,
  highlightEffect,
  languageDataEffect,
  languageEffect,
  fontEffect,
  lineNumbersEffect,
  menuKeysEffect,
} from "../editor/setup";
import { EMPTY_REGISTRY, languageLabelFor, Registry } from "../extensions/registry";
import { HighlightClient } from "../highlight/client";
import {
  HIGHLIGHT_LIMIT_CHARS,
  workerHighlighting,
  type WorkerHighlighting,
} from "../highlight/extension";
import {
  fixedShortcutHint,
  menuKeymap,
  SETTINGS_FIXED_NAME,
  shortcutHint,
} from "../shortcuts/keys";
import { ThemeManager } from "../theme/manager";
import { tokenTheme } from "../theme/vscode-theme";
import { askUnsaved, pickLanguage, promptText, workspacePicker } from "../ui/dialogs";
import { h } from "../ui/dom";
import { MemoList } from "../ui/memo-list";
import { SearchPanel } from "../ui/search-panel";
import { openSettings, type SettingsSection } from "../ui/settings";
import { SettingsButton } from "../ui/settings-button";
import { UpdateButton } from "../ui/update-button";
import { openUpdateDialog } from "../ui/update-dialog";
import { Sidebar } from "../ui/sidebar";
import { StatusBar } from "../ui/status-bar";
import type { TabDrag } from "../ui/tab-bar";
import { openVersions } from "../ui/versions";
import {
  switcherItems,
  switcherShortcut,
  WorkspaceSwitcher,
  type SwitcherItem,
} from "../ui/workspace-switcher";
import type { LargeTextViewer } from "../viewer/large-text";
import {
  asksAboutFile,
  CHOOSE_VERSION_FIRST,
  ExternalDoc,
  importExternal,
  MemoDoc,
  type Change,
  type Doc,
  type DocHost,
} from "./docs";
import { editorFontStack } from "./editor-font";
import { describeError } from "./errors";
import {
  canSplitRect,
  dividersOf,
  dropZone,
  heirOf,
  leaf,
  leafIds,
  neighbor,
  rectsOf,
  removeLeaf,
  resizeAt,
  splitAt,
  type Divider,
  type LayoutNode,
  type Rect,
  type Side,
  type Zone,
} from "./layout";
import { Pane, type PaneHost } from "./pane";
import { claimPlaces, parseJson, sessionTab, SessionSync } from "./session-sync";

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
export const NOT_MOVED_WITH_BANNER = "충돌·삭제 알림이 떠 있어 새 창으로 옮기지 않았습니다";
export const NOT_MOVED_TO_NEW_WINDOW = "저장하지 못해 새 창으로 옮기지 않았습니다";
/** 「탭을 새 창으로 옮기기」: an item of the window menu and of a tab's context menu. */
export const MOVE_TAB_TO_NEW_WINDOW = "move-tab-to-new-window";
const SPLIT_TAB_ITEMS: { id: string; text: string; side: Side }[] = [
  { id: "split-tab-left", text: "왼쪽으로 나누기", side: "left" },
  { id: "split-tab-right", text: "오른쪽으로 나누기", side: "right" },
  { id: "split-tab-top", text: "위로 나누기", side: "top" },
  { id: "split-tab-bottom", text: "아래로 나누기", side: "bottom" },
];
const NEW_WORKSPACE_NAME = "새 워크스페이스 이름";

/** Where a dragged tab would go (`AppController.dropTarget`): a place in a pane's tab bar, or a
 * zone of a pane's body — the whole pane, or a side split off for it. */
type DropTarget = { pane: Pane; index: number } | { pane: Pane; zone: Zone } | null;

/** The leaf a drop mask stands for while it asks the layout where a split would put a new pane. */
const MASK_ID = "drop-mask";

const sameTab = (a: TabRef, b: TabRef) =>
  a.kind === "memo"
    ? b.kind === "memo" && a.id === b.id
    : b.kind === "external" && a.path === b.path;

/** The place a session entry stands for among every window's tabs. */
const refOf = (tab: SessionTab): TabRef =>
  tab.kind === "memo" ? { kind: "memo", id: tab.memoId } : { kind: "external", path: tab.path };

/** A pane this near the editing area's left or top edge (a fraction of it) is at that edge. */
const EDGE = 1e-9;

/** The session's tree with `ids` for its panes, depth first. */
function layoutOf(node: SessionNode, ids: readonly string[]): LayoutNode {
  let next = 0;
  const walk = (each: SessionNode): LayoutNode =>
    isSessionPane(each)
      ? leaf(ids[next++])
      : {
          kind: "split",
          axis: each.axis,
          children: each.children.map(walk),
          shares: [...each.shares],
        };
  return walk(node);
}

/** Puts `el` at `rect` of the editing area. A boundary's grip leaves its thin side (`thin`) to the
 * style. */
function place(el: HTMLElement, rect: Rect, thin?: "width" | "height"): void {
  const percent = (fraction: number) => `${fraction * 100}%`;
  el.style.left = percent(rect.x);
  el.style.top = percent(rect.y);
  el.style.width = thin === "width" ? "" : percent(rect.width);
  el.style.height = thin === "height" ? "" : percent(rect.height);
}

/** One workspace window: the sidebar with its workspace switcher, the status bar, menu actions, opening and
 * closing tabs, the session and the places its tabs hold. Each editor pane — its tabs, tab bar and
 * editor area — is a `Pane`; the session is read and written by `SessionSync`. */
export class AppController implements DocHost, PaneHost {
  readonly writes = new WriteScheduler((_key, error) => this.report(error));
  /** The window's panes in the order of `layout`'s leaves (depth first); at least one. */
  readonly panes: Pane[];
  /** The pane the keys, the menu, the memo list and the status bar act on. */
  focused: Pane;
  /** The window wrote its tabs to close or to switch its workspace (`leave`). */
  leaving = false;
  /** What had the keys outside the panes as the window left — the search box, the memo list's
   * filter — for `stay` to give them back to. */
  private keysBeforeLeaving: HTMLElement | null = null;
  /** How the panes share the editing area (`layout.ts`); its leaves are the panes' ids. */
  private layout: LayoutNode;
  /** The boundaries between the panes as `layoutPanes` last put them, and their grips. */
  private boundaries: Divider[] = [];
  private readonly grips: HTMLElement[] = [];
  private readonly panesEl = h("div", { class: "panes" });
  /** Where a tab dragged over a pane's body would land; in `panesEl` only while it is shown. */
  private readonly dropMask = h("div", { class: "drop-mask" });
  registry = new Registry(EMPTY_REGISTRY);
  readonly theme: ThemeManager;
  readonly highlight = new HighlightClient(
    new Worker(new URL("../highlight/worker.ts", import.meta.url), { type: "module" }),
    () => this.registry,
    (ext, path) => this.backend.readExtensionFile(ext, path),
  );
  /** Open settings screens listen here: the backend takes one config handler per window. */
  private settingsOpen = false;
  /** The section the settings screen showed last; the window forgets it as it closes. */
  private settingsSection: SettingsSection = "general";
  private versionsOpen = false;
  /** `extensionSignature` of the registry the caches were filled from. */
  private extensionSet = "";
  /** The settings as of the last config change; the editor reads its options from here. */
  private settings: Settings = {
    theme: { light: null, dark: null },
    extensions: { disabled: [], precedence: "user" },
    editor: { lineNumbers: true, fontSize: 14, fontFamily: "" },
    updates: { autoCheck: true },
  };
  /** The app commands' shortcuts as of the last config change; the hints that name one read it.
   * Null until it is first read (a failed first read too: the empty panes then show no hint). */
  private shortcuts: ShortcutTable | null = null;
  /** The font the editors were last given (`fontEffect`). */
  private appliedFont: EditorFont | null = null;
  /** The editors' bindings for the app shortcuts that are editor keys too (`menuKeymap`). */
  private menuKeys: KeyBinding[] = [];
  private readonly configListeners = new Set<() => void>();
  /** The settings screen's 워크스페이스 section, while it is open: it hears the list change as the
   * switcher does. */
  private readonly workspaceListeners = new Set<() => void>();
  /** The language-configuration reads by file, settled once a failure has been warned about
   * (public: the UI tests wait for them). */
  readonly languageConfigs = new Map<string, Promise<LanguageData>>();
  /** Each tab's document in the highlight worker, kept from tab switch to tab switch. */
  private readonly highlights = new Map<Doc, { key: string; highlighting: WorkerHighlighting }>();
  /** The place each open tab holds among every window's tabs (`Backend.claimTabs`): what it was
   * claimed as, which a memo saved under a new ID no longer is. */
  private readonly held = new Map<Doc, TabRef>();
  private session!: SessionSync;
  private deviceId = "";
  /** Session writes wait until the restored tabs are in place. */
  private restoring = true;
  /** Tabs handed to this window while it restores (`onAdopt`): a restore neither shows a tab nor
   * writes the session, so they are adopted once it is done. */
  private pendingAdopts: { tab: SessionTab; x: number; y: number }[] = [];
  /** Tabs handed to this window being adopted once its restore is done (`adoptTab`): a round
   * waits for them before it lets go of the window's tabs (`onFlush`). */
  private readonly adopting = new Set<Promise<void>>();
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
  private readonly switcher = new WorkspaceSwitcher({
    pick: (item) => void this.switchTo(item.path),
    create: () => void this.newWorkspace(),
    open: () => void this.showPicker().catch((error: unknown) => this.report(error)),
  });
  /** Goes by the menu item's id, so `showSettings`'s one-screen guard holds for it too. */
  private readonly settingsButton = new SettingsButton(() => void this.onMenu("settings"));
  private readonly updateButton = new UpdateButton(
    () => void this.openCurrentUpdate().catch((error: unknown) => this.report(error)),
  );
  private readonly sidebar = new Sidebar(
    this.switcher,
    this.memoList,
    this.searchPanel,
    this.settingsButton,
    this.updateButton,
  );
  /** What the switcher lists, for ⌃1 – ⌃9. */
  private switcherList: SwitcherItem[] = [];
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
    this.layout = leaf(this.focused.id);
    this.panesEl.append(this.focused.el);
    this.syncPanes();
    root.replaceChildren(
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
    // Before the page counts as started: from then on the native side sends this window the tabs
    // let go over it, and an event no one listens for is gone. Until the restore is done they
    // wait (`pendingAdopts`), so all the handler needs is there from the start.
    await this.backend.onAdopt((json, x, y) => {
      const tab = parseTab(parseJson(json));
      if (!tab) this.report(new Error(`not a tab: ${json}`));
      else if (this.restoring) this.pendingAdopts.push({ tab, x, y });
      else {
        const adopted: Promise<void> = this.adoptTab(tab, x, y)
          .catch((error: unknown) => this.report(error))
          .finally(() => this.adopting.delete(adopted));
        this.adopting.add(adopted);
      }
    });
    const first = Promise.all([
      // The first call of a page: after a switch it lets the window write again
      // (`AppCore::page_started`). The switcher and ⌃1–⌃9 are wired after it, so an old page has
      // always made it before its window switches.
      this.backend.workspaceInfo(),
      // A mark must never be what fails a window.
      this.backend.perfConfig().catch(() => this.perf),
    ]);
    // Alongside everything up to the session: the empty panes show no hint until it is read.
    const shortcutsRead = this.loadShortcuts().then((changed) => {
      if (changed) this.shortcutsChanged();
    });
    const [info, perf] = await first;
    this.perf = perf;
    this.deviceId = info.deviceId;
    this.workspacePath = info.path;
    document.title = info.title;
    void this.refreshSwitcher();
    this.backend.onWorkspacesChanged(() => {
      void this.refreshSwitcher();
      for (const listener of this.workspaceListeners) listener();
    });
    // In the capture phase: the editor and the dialogs see the keys after this.
    document.addEventListener(
      "keydown",
      (event) => {
        const index = switcherShortcut(event);
        const item = index === null ? undefined : this.switcherList[index];
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
    await Promise.all([this.loadSettings(), shortcutsRead]);
    this.applyEditorFont();
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
        layout: this.layout,
        panes: new Map(this.panes.map((pane) => [pane.id, pane])),
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
      void this.refreshSwitcher();
      // A first read that failed left the empty panes without their hint: read it again.
      if (!this.shortcuts) void this.loadShortcuts().then((c) => c && this.shortcutsChanged());
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
    // A pane for each of the session's, in its order; the window's own come first.
    const panes = restored.panes.map((_, index) => this.panes[index] ?? this.makePane());
    for (const pane of panes) if (!this.panes.includes(pane)) this.panesEl.append(pane.el);
    let layout = layoutOf(
      restored.layout,
      panes.map((pane) => pane.id),
    );
    // Split before the session was read: those panes stay, on the right.
    for (const extra of this.panes.slice(panes.length))
      layout = splitAt(layout, leafIds(layout).at(-1)!, "right", extra.id);
    this.arrange(layout, panes);
    restored.panes.forEach(({ tabs }, index) => {
      for (const doc of tabs) {
        panes[index].tabs.push(doc);
        this.held.set(doc, doc.tabRef);
      }
    });
    this.setFocused(panes[restored.focusedPane]);
    this.syncPanes();
    // Each pane shows its active tab; only the focused one takes the keys.
    await Promise.all(
      restored.panes.map(({ active }, index) => {
        const pane = panes[index];
        if (active) return pane.activate(active);
        pane.renderTabs();
        return undefined;
      }),
    );
    this.restoring = false;
    this.markNextFrame("restore-done");
    // Counted among the tabs being adopted from the moment the restore is done, in the same step:
    // a round answered while they are still being placed waits for them (`onFlush`).
    const adopted: Promise<void> = (async () => {
      for (const { tab, x, y } of this.pendingAdopts.splice(0))
        await this.adoptTab(tab, x, y).catch((error: unknown) => this.report(error));
    })().finally(() => this.adopting.delete(adopted));
    this.adopting.add(adopted);
    await adopted;
  }

  private async loadRegistry(): Promise<void> {
    try {
      this.registry = new Registry(await this.backend.extensionRegistry());
    } catch (error) {
      this.report(error);
    }
  }

  /** A failed read keeps what the editor has (or, at the start, the defaults). */
  private async loadSettings(): Promise<void> {
    try {
      this.settings = await this.backend.settings();
    } catch (error) {
      this.report(error);
    }
  }

  /** Whether the table read is another than the one there was. A failed read keeps that one. */
  private async loadShortcuts(): Promise<boolean> {
    try {
      const table = await this.backend.shortcutTable();
      const changed = JSON.stringify(table) !== JSON.stringify(this.shortcuts);
      this.shortcuts = table;
      return changed;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  shortcutHint(id: string): string | null | undefined {
    return this.shortcuts ? shortcutHint(this.shortcuts, id) : undefined;
  }

  /** The empty panes, the status bar and the settings button name the shortcuts there are now, and
   * the editors give the keys the menu has too to the menu. */
  private shortcutsChanged(): void {
    this.settingsButton.setShortcut(
      this.shortcuts && fixedShortcutHint(this.shortcuts, SETTINGS_FIXED_NAME),
    );
    this.menuKeys = this.shortcuts
      ? menuKeymap(this.shortcuts, (id) => void this.runMenuCommand(id))
      : [];
    for (const doc of this.docs) this.reconfigureMenuKeys(doc);
    for (const pane of this.panes) pane.shortcutsChanged();
  }

  private async runMenuCommand(id: string): Promise<void> {
    try {
      await this.backend.runMenuCommand(id);
    } catch (error) {
      this.report(error);
    }
  }

  /** The font variables live on the root, where the theme's variables are not: a theme never
   * names them. An empty family removes the variable, so styles.css's default shows. */
  private applyEditorFont(): void {
    const { fontSize, fontFamily } = this.settings.editor;
    const style = document.documentElement.style;
    style.setProperty("--editor-size", `${fontSize}px`);
    // A value CSS cannot read is dropped by setProperty, so the last one is removed first.
    style.removeProperty("--editor-font");
    const stack = editorFontStack(fontFamily);
    if (stack) style.setProperty("--editor-font", stack);
    const font = this.editorFont();
    if (font.family === this.appliedFont?.family && font.size === this.appliedFont.size) return;
    this.appliedFont = font;
    for (const doc of this.docs) this.reconfigureFont(doc);
  }

  /** The editors' font as the settings make it (`fontEffect`). */
  private editorFont(): EditorFont {
    const { fontSize, fontFamily } = this.settings.editor;
    return {
      family: editorFontStack(fontFamily) || "var(--large-text-font)",
      size: `${fontSize}px`,
    };
  }

  /** Settings or extensions changed (this window's settings screen or another's). */
  private async onConfigChanged(): Promise<void> {
    const lineNumbers = this.settings.editor.lineNumbers;
    const [, shortcuts] = await Promise.all([this.loadSettings(), this.loadShortcuts()]);
    this.applyEditorFont();
    if (this.settings.editor.lineNumbers !== lineNumbers) {
      for (const doc of this.docs) this.reconfigureLineNumbers(doc);
    }
    if (shortcuts) this.shortcutsChanged();
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
      lineNumbers: this.settings.editor.lineNumbers,
      font: this.editorFont(),
      menuKeys: this.menuKeys,
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
          if (!pageLeaving())
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
    // Not on "language": that is the language data arriving, which leaves the info as it was and
    // may land after a removal has been listed — upserting then brings the gone memo back.
    if (doc instanceof MemoDoc && change === "info") this.memoList.upsert(doc.info);
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

  /** `line` (a search result) is the line a large text viewer opens at: set on the pane the tab
   * lands in, which is the focused one only until the claim and the listing have answered. */
  async openMemo(id: string, line?: number): Promise<void> {
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
    // Before the tab is shown: its viewer may be on show before `openMemo` returns.
    if (line !== undefined) this.paneOf(doc).pendingLine = { memoId: id, line };
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
    await this.newMemoIn(this.focused, "after-active");
  }

  async newMemoIn(pane: Pane, at: "after-active" | "end"): Promise<void> {
    await this.focusOn(pane);
    // Closed, or the focus went elsewhere while a composition ended.
    if (this.focused !== pane || !this.panes.includes(pane)) return;
    const info = await this.backend.createMemo();
    this.memoList.upsert(info);
    if (!(await this.claim({ kind: "memo", id: info.id }))) return;
    const doc = this.insertClaimed(new MemoDoc(this, info), at);
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
    await this.takeOut(pane, doc);
  }

  /** Takes `doc` out of `pane` for good (closed, or gone to another window): its place is let go
   * of unless it is no longer held, and a pane left empty closes. */
  private async takeOut(pane: Pane, doc: Doc): Promise<void> {
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

  /** Moves `doc` into a new window of this workspace (「탭을 새 창으로 옮기기」), which opens with
   * it alone and reads it afresh: a memo is saved first, an external file's edits kept as its
   * draft. When that fails, or a banner still asks about the file, the tab stays and the status
   * bar says so. Leaving, the tab is not closed — a blank new memo is not deleted: it is the other
   * window's now. Returns whether it moved. Dragged out of the window, `at` is the screen point it
   * was let go at: the tab goes to the window of this workspace there, else a new window there
   * (`Backend.tearOffTab`). */
  async tearOff(doc: Doc, at?: { x: number; y: number }): Promise<boolean> {
    await settleComposition(this.focused.view);
    // Already on its way: the tab stays in its bar while it is written, and can be dragged out or
    // picked from its menu again. A second hand-over would be refused by the backend once the first
    // is through, and its `stay` would show a tab that is gone.
    if (!this.docs.includes(doc) || doc.leaving) return false;
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
      const asks = asksAboutFile(doc.banner);
      this.statusBar.setMessage(asks ? NOT_MOVED_WITH_BANNER : NOT_MOVED_TO_NEW_WINDOW, "error");
      return false;
    }
    // Closed while it was written.
    if (!this.docs.includes(doc)) return false;
    const pane = this.paneOf(doc);
    try {
      await this.backend.tearOffTab(JSON.stringify(sessionTab(doc, this.deviceId)), doc.tabRef, at);
    } catch (error) {
      stay();
      this.report(error);
      return false;
    }
    // The backend gave its place to the new window: there is nothing to release.
    this.held.delete(doc);
    if (doc instanceof ExternalDoc) doc.stopWatching();
    await this.takeOut(pane, doc);
    // At once, not on its timer: the window the tab went to has it in its session already.
    await this.saveSessionNow();
    return true;
  }

  async tabMenu(tabId: string): Promise<void> {
    const doc = this.docs.find((each) => each.tabId === tabId);
    if (!doc) return;
    const picked = await this.backend.showTabMenu([
      ...SPLIT_TAB_ITEMS.map(({ id, text }) => ({ id, text })),
      { id: MOVE_TAB_TO_NEW_WINDOW, text: "탭을 새 창으로 옮기기" },
    ]);
    if (picked === MOVE_TAB_TO_NEW_WINDOW) await this.tearOff(doc);
    const split = SPLIT_TAB_ITEMS.find((item) => item.id === picked);
    if (!split || !this.docs.includes(doc)) return;
    // The split is of the pane the tab is in, which is the focused one from here.
    await this.focusOn(this.paneOf(doc));
    await this.splitPane(split.side, doc);
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
    try {
      await Promise.all([shown, to.activate(doc)]);
    } finally {
      // The tab has moved whether or not it could be shown: the empty pane goes, the session follows.
      if (from.tabs.list.length === 0) this.closePane(from);
      this.saveSessionSoon();
    }
  }

  dragTab(tabId: string): TabDrag {
    let marked: Pane | null = null;
    let dimmed: Pane | null = null;
    const dragged = () => this.docs.find((each) => each.tabId === tabId);
    const outside = (x: number, y: number) =>
      x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight;
    // Out of the window the tab is left dimmed in its bar, and no place in this window is marked.
    const dim = (doc: Doc | undefined) => {
      dimmed?.tabBar.markOut(null);
      dimmed = doc ? this.paneOf(doc) : null;
      dimmed?.tabBar.markOut(tabId);
    };
    // A place in a tab bar is marked there, a zone of a pane's body by the mask; never both.
    const mark = (target: DropTarget) => {
      marked?.tabBar.markDrop(null);
      marked = null;
      if (target && "index" in target) {
        marked = target.pane;
        target.pane.tabBar.markDrop(target.index);
      }
      this.showDropMask(target && "zone" in target ? target : null);
    };
    return {
      over: (x, y) => {
        const doc = dragged();
        dim(outside(x, y) ? doc : undefined);
        mark(outside(x, y) ? null : this.dropTarget(x, y, doc));
      },
      drop: (x, y, screenX, screenY) => {
        const doc = dragged();
        dim(undefined);
        if (doc && outside(x, y)) {
          mark(null);
          void this.tearOff(doc, { x: screenX, y: screenY }).catch((error: unknown) =>
            this.report(error),
          );
          return;
        }
        const target = this.dropTarget(x, y, doc);
        mark(null);
        if (!doc || !target) return;
        const moved =
          "index" in target
            ? this.moveTab(doc, target.pane, target.index)
            : target.zone === "center"
              ? this.moveTab(doc, target.pane, target.pane.tabs.list.length)
              : this.splitWithTab(doc, target.pane, target.zone);
        void moved.catch((error: unknown) => this.report(error));
      },
      cancel: () => {
        dim(undefined);
        mark(null);
      },
    };
  }

  /** Where `doc`, dropped at (`x`, `y`), would go: a place in a pane's tab bar, or a zone of a
   * pane's body (`dropZone`) — a side the pane is too small to split toward is its center. Nothing
   * for a side of `doc`'s own pane when it is that pane's only tab: there is nothing to split. */
  private dropTarget(x: number, y: number, doc: Doc | undefined): DropTarget {
    const hit = document.elementsFromPoint(x, y);
    const pane = this.panes.find((each) => hit.includes(each.el));
    if (!pane) return null;
    if (hit.includes(pane.tabBar.el)) return { pane, index: pane.tabBar.indexAt(x) };
    const zone = dropZone(pane.surface.el.getBoundingClientRect(), x, y);
    if (zone === "center") return { pane, zone };
    if (pane.tabs.list.length === 1 && pane.tabs.list[0] === doc) return null;
    return { pane, zone: canSplitRect(this.rectPx(pane), zone) ? zone : "center" };
  }

  /** Shows over `target`'s pane where a drop would put the tab — the pane, or the half a split
   * would give the new pane, as the layout would have it — or, for null, takes the mask away. */
  private showDropMask(target: { pane: Pane; zone: Zone } | null): void {
    const rect = !target
      ? undefined
      : target.zone === "center"
        ? rectsOf(this.layout).get(target.pane.id)
        : rectsOf(splitAt(this.layout, target.pane.id, target.zone, MASK_ID)).get(MASK_ID);
    if (!rect) {
      this.dropMask.remove();
      return;
    }
    // Placed before it is shown: a mask appearing does not slide in from where it last was.
    place(this.dropMask, rect);
    if (!this.dropMask.isConnected) this.panesEl.append(this.dropMask);
  }

  /** Splits `to` and puts `doc` in the new pane on `side` — a tab dropped on that edge of `to` —
   * once any composition has ended, as `moveTab` does. It splits as the mask showed when the tab
   * was let go; the pane is not measured again. A pane it leaves empty closes. */
  private async splitWithTab(doc: Doc, to: Pane, side: Side): Promise<void> {
    await settleComposition(this.focused.view);
    // Closed, or its pane closed, while the composition ended.
    if (!this.docs.includes(doc) || !this.panes.includes(to)) return;
    if (to.tabs.list.length === 1 && to.tabs.list[0] === doc) return;
    const pane = this.makePane();
    this.panesEl.append(pane.el);
    this.arrange(splitAt(this.layout, to.id, side, pane.id), [pane]);
    await this.relocate(doc, pane, 0);
  }

  private makePane(): Pane {
    const pane = new Pane(`pane-${++this.paneCount}`, this);
    // A click anywhere in a pane — its tab bar, its editor — focuses it.
    pane.el.addEventListener("mousedown", () => void this.focusOn(pane), { capture: true });
    return pane;
  }

  /** `layout` is the window's from now on: `panes` follows its leaves — the panes there are and
   * `added` — and they are laid out by it. A pane no leaf names is no longer the window's. */
  private arrange(layout: LayoutNode, added: readonly Pane[] = []): void {
    const byId = new Map([...this.panes, ...added].map((pane) => [pane.id, pane]));
    this.layout = layout;
    this.panes.splice(0, this.panes.length, ...leafIds(layout).flatMap((id) => byId.get(id) ?? []));
    this.syncPanes();
  }

  /** Where the panes lie, which is focused, and what an empty pane says, as they are now. */
  private syncPanes(): void {
    this.panesEl.classList.toggle("split", this.panes.length > 1);
    this.layoutPanes();
    for (const pane of this.panes) {
      pane.el.classList.toggle("focused", pane === this.focused);
      if (pane.tabs.list.length === 0) pane.showEmptyText();
    }
  }

  /** Puts every pane and boundary grip where `layout` has it. In percentages of the editing area,
   * so a window resized needs no new layout, and a pane under its minimum still shows. Panes keep
   * their place in the DOM: one moved would lose its focus, and its viewer frame would load
   * again. */
  layoutPanes(): void {
    const rects = rectsOf(this.layout);
    for (const pane of this.panes) {
      const rect = rects.get(pane.id);
      if (!rect) continue;
      place(pane.el, rect);
      // The line between two panes is the border of the one right of it or below it.
      pane.el.classList.toggle("after-left", rect.x > EDGE);
      pane.el.classList.toggle("after-top", rect.y > EDGE);
    }
    this.boundaries = dividersOf(this.layout);
    while (this.grips.length < this.boundaries.length) {
      const grip = this.grip();
      this.grips.push(grip);
      this.panesEl.append(grip);
    }
    for (const grip of this.grips.splice(this.boundaries.length)) grip.remove();
    this.boundaries.forEach((boundary, index) => {
      const grip = this.grips[index];
      const across = boundary.axis === "column";
      grip.classList.toggle("column", across);
      place(grip, boundary.rect, across ? "height" : "width");
    });
  }

  /** The pane's place in the editing area, in pixels. */
  private rectPx(pane: Pane): Rect {
    const rect = rectsOf(this.layout).get(pane.id) ?? { x: 0, y: 0, width: 1, height: 1 };
    const { width, height } = this.panesEl.getBoundingClientRect();
    return {
      x: rect.x * width,
      y: rect.y * height,
      width: rect.width * width,
      height: rect.height * height,
    };
  }

  /** A grip over a boundary between panes (`boundaries`, by its own place in `grips`); dragged, the
   * boundary moves. */
  private grip(): HTMLElement {
    const el = h("div", { class: "pane-divider" });
    el.addEventListener("pointerdown", (down) => {
      const boundary = this.boundaries[this.grips.indexOf(el)];
      if (!boundary || down.button !== 0) return;
      down.preventDefault();
      el.setPointerCapture(down.pointerId);
      const start = this.layout;
      const { width, height } = this.panesEl.getBoundingClientRect();
      let current = start;
      const end = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", end);
        el.removeEventListener("pointercancel", end);
        this.saveSessionSoon();
      };
      const move = (event: PointerEvent) => {
        // A pane opened or closed under the drag: the boundary is no longer the one taken.
        if (this.layout !== current) return end();
        const delta =
          boundary.axis === "row" ? event.clientX - down.clientX : event.clientY - down.clientY;
        current = resizeAt(start, boundary.path, boundary.index, delta, { width, height });
        this.layout = current;
        this.layoutPanes();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
    return el;
  }

  /** ⌘\ and ⇧⌘\: the focused pane gives its half on `side` to a new pane, which takes `doc` — by
   * default the focused pane's active tab — and the focus. The new pane opens empty for `null`, or
   * when `doc` is the focused pane's only tab. */
  async splitPane(side: Side = "right", doc?: Doc | null): Promise<void> {
    const from = this.focused;
    await settleComposition(from.view);
    if (this.focused !== from) return;
    if (!canSplitRect(this.rectPx(from), side)) {
      this.statusBar.setMessage(TOO_NARROW_TO_SPLIT);
      return;
    }
    const chosen = doc === undefined ? from.tabs.active : doc;
    const alone = from.tabs.list.length === 1 && from.tabs.list[0] === chosen;
    const moving = chosen && !alone && this.docs.includes(chosen) ? chosen : null;
    const pane = this.makePane();
    this.panesEl.append(pane.el);
    this.arrange(splitAt(this.layout, from.id, side, pane.id), [pane]);
    this.setFocused(pane);
    if (moving) await this.relocate(moving, pane, 0);
    else void from.tabs.active?.leave();
  }

  /** ⌥⌘ and an arrow: the pane on `side` of the focused one; nothing when there is none. */
  focusPane(side: Side): void {
    const id = neighbor(rectsOf(this.layout), this.focused.id, side);
    const next = this.panes.find((pane) => pane.id === id);
    if (next) void this.focusOn(next).catch((error: unknown) => this.report(error));
  }

  /** Closes `pane`, which has no tabs; the window's only pane stays. Its room goes as `removeLeaf`
   * gives it — to the pane before it in its branch, the one after when it is first — and the focus,
   * when it had it, to the first pane of what took the room. */
  closePane(pane: Pane): void {
    if (!this.panes.includes(pane) || this.panes.length < 2 || pane.tabs.list.length) return;
    const heir = this.panes.find((each) => each.id === heirOf(this.layout, pane.id));
    pane.el.remove();
    pane.closePanel();
    pane.view.destroy();
    this.arrange(removeLeaf(this.layout, pane.id));
    if (this.focused === pane) this.setFocused(heir ?? this.panes[0]);
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
    const [claimed] = await claimPlaces(this.backend, [tab], true);
    return claimed;
  }

  private insertClaimed<D extends Doc>(doc: D, at: "after-active" | "end" = "after-active"): D {
    this.held.set(doc, doc.tabRef);
    if (at === "end") return this.focused.tabs.place(doc, this.focused.tabs.list.length);
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

  /** Another window asked for a tab this window holds. One it holds without a tab — handed over
   * before this page heard of it (`onAdopt`) — opens here: no window would show it otherwise. A
   * restore under way makes the tabs of the session, which may hold it. */
  private async reveal(tab: TabRef): Promise<void> {
    const doc = tab.kind === "memo" ? this.memoTab(tab.id) : this.externalTab(tab.path);
    if (doc) await this.showTab(doc);
    else if (this.restoring) return;
    else if (tab.kind === "memo") await this.openMemo(tab.id);
    else await this.openExternal(tab.path);
  }

  /** Another window of this workspace let `tab` go over this one at (`x`, `y`), its place already
   * this window's (`onAdopt`): it opens as the last tab of the pane there, else of the focused
   * pane, and is shown. The session is written at once, not on its timer: the other window has
   * written its own without the tab, and an app quitting between the two would lose its place. */
  async adoptTab(tab: SessionTab, x: number, y: number): Promise<void> {
    const open = () =>
      tab.kind === "memo" ? this.memoTab(tab.memoId) : this.externalTab(tab.path);
    let doc: Doc | null | undefined = open();
    // Made in the other window a moment ago, the memo may not be listed here yet. A reveal of the
    // tab may open it meanwhile: then that tab is the one.
    if (!doc && tab.kind === "memo" && !this.memoList.get(tab.memoId)) {
      await this.refreshMemos();
      doc = open();
    }
    if (!doc) {
      doc = this.session.tabFor(tab);
      if (!doc) {
        // Its place is this window's already: no other window could take the tab again.
        void this.backend.releaseTab(refOf(tab)).catch((error: unknown) => console.warn(error));
        return this.report(new Error("메모를 찾을 수 없습니다"));
      }
      const hit = document.elementsFromPoint(x, y);
      const pane = this.panes.find((each) => hit.includes(each.el)) ?? this.focused;
      this.held.set(doc, doc.tabRef);
      pane.tabs.place(doc, pane.tabs.list.length);
    }
    await this.showTab(doc);
    await this.saveSessionNow();
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
    if (this.restoring && this.pendingAdopts.length > 0)
      await this.writeHandedTabs().catch((error: unknown) => this.report(error));
    await this.saveSessionNow();
  }

  /** A window still restoring writes no session, and the tabs handed to it meanwhile wait for the
   * restore (`pendingAdopts`) while their places are this window's already. Should it close or the
   * app quit first, they would be in no window's layout: they go behind the first pane's tabs in the
   * layout the native side has for the window, which a window with none yet gets with one pane.
   * Not `SessionSync.build`: with the panes not restored it would write them empty over the saved
   * ones. A tab the layout has already is left where it is, so a second flush adds nothing. */
  private async writeHandedTabs(): Promise<void> {
    const saved = parseWindowSession(parseJson(await this.backend.readWindowLayout()));
    // Done meanwhile: the restore made the session's tabs and writes them with these.
    if (!this.restoring) return;
    const panes = sessionPanes(saved.layout);
    const has = (tab: SessionTab) =>
      panes.some((pane) => pane.tabs.some((each) => sameTab(refOf(each), refOf(tab))));
    const handed = this.pendingAdopts.map(({ tab }) => tab).filter((tab) => !has(tab));
    if (handed.length === 0) return;
    const [first] = panes;
    first.tabs.push(...handed);
    // Adopting shows the tab: the last one handed over is the one in front.
    first.activeTab = first.tabs.length - 1;
    await this.backend.writeWindowLayout(JSON.stringify(saved));
  }

  /** Answers with what is still only in memory: the native side asks before closing over it. A
   * window that closes or switches lets go of its tabs before it answers (`leave`). */
  private async onFlush(id: number, goal: FlushGoal): Promise<void> {
    try {
      // A syllable still being composed goes into its own tab before the tabs are written
      // (closing, quitting, switching the workspace).
      await this.settleCompositions();
      await this.flushAll(true);
      // A tab still being adopted writes the session once it is placed: a window closing over it
      // would take it along. After the tabs are written, which do not wait on it: the round runs
      // out of time, and a window it closes then goes with what it has written.
      await Promise.allSettled(this.adopting);
      // The window stays open until the native side acts on the answer, and a key typed after the
      // tabs are written would be lost with it. The editors take keys while the tabs are written:
      // what came in meanwhile is written too before the answer.
      if (goal !== "quit") this.leave();
      if (this.docs.some((doc) => doc.unwritten)) await this.flushAll(true);
    } finally {
      const failed = this.docs.filter((doc) => doc.saveFailed).length;
      const leaving = await this.backend.flushDone(
        id,
        failed ? `저장하지 못한 메모 ${failed}개` : undefined,
      );
      // The round was settled at its timeout, before this answer, and the window stays: no
      // `tote://stay` comes after it.
      if (!leaving && goal !== "quit") this.stay();
    }
  }

  /** The window wrote its tabs to close or to switch its workspace (`onFlush`): every pane lets go
   * of its tab until the window goes, or stays (`stay`). A tab opened meanwhile is not shown
   * either (`Pane.show`). */
  leave(): void {
    // A second round while leaving (⌘W after a switch answered) finds the keys nowhere by now.
    if (!this.leaving) {
      const active = document.activeElement;
      this.keysBeforeLeaving =
        active instanceof HTMLElement && active !== document.body && !this.panesEl.contains(active)
          ? active
          : null;
    }
    this.leaving = true;
    for (const pane of this.panes) {
      const active = pane.tabs.active;
      if (active) pane.capture(active);
      pane.surface.showNothing();
    }
  }

  /** The close or switch is off (`tote://stay`): each pane shows its tab again, and the keys go
   * back where they were before the window left — the focused pane, unless they were outside the
   * panes. */
  stay(): void {
    if (!this.leaving) return;
    this.leaving = false;
    for (const pane of this.panes) {
      const active = pane.tabs.active;
      if (active) pane.show(active);
      else pane.showEmptyText();
    }
    // Only if still there and shown: WebKit keeps the keys in an element hidden since the last
    // layout (the search panel closed meanwhile), and drops them at the next one. The rects lay the
    // page out first.
    const before = this.keysBeforeLeaving?.getClientRects().length ? this.keysBeforeLeaving : null;
    this.keysBeforeLeaving = null;
    before?.focus({ preventScroll: true });
    if (!before || document.activeElement !== before) this.focused.takeKeys();
  }

  /** A syllable still being composed goes into its own tab before the window writes its tabs or
   * another window comes forward. */
  private async settleCompositions(): Promise<void> {
    await Promise.all(this.panes.map((pane) => settleComposition(pane.view)));
  }

  private onUpdate(doc: Doc, update: ViewUpdate): void {
    // From a state the tab has replaced since: a reread puts the new text in, then reads the scroll
    // position, which runs the view's pending measure on the old state. It must not bring it back.
    if (update.startState !== doc.state) {
      // A measure carries nothing to keep. An edit does: nothing should put a shown tab's text in
      // from outside the editor and leave the editor on the old one, so say so if something does.
      if (update.docChanged) console.warn("an edit from a state the tab has replaced was dropped");
      return;
    }
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
      } else if (open.kind === "update") {
        // Not awaited: the dialog stays up while the rest of the opens go on.
        void openUpdateDialog(this.backend, open);
      } else if (open.kind === "updateFound") {
        this.updateButton.show(open.version);
      } else {
        notices.push(open.message);
      }
    }
    // After the opens: showing a tab sets the status bar, which would wipe a failure of the same
    // request (`tote -i 없는.txt 있는.txt`) before anyone saw it.
    if (notices.length) this.statusBar.setMessage(notices.join(" · "), "error");
  }

  /** The update button: asks as the update stands now, not as it stood when the button went up —
   * another window may have begun downloading it, or installed it, since. */
  private async openCurrentUpdate(): Promise<void> {
    const offer = await this.backend.currentUpdate();
    if (offer) await openUpdateDialog(this.backend, offer);
    else this.updateButton.hide();
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
          return await this.splitPane("right");
        case "split-pane-down":
          return await this.splitPane("bottom");
        case "focus-pane-left":
          return this.focusPane("left");
        case "focus-pane-right":
          return this.focusPane("right");
        case "focus-pane-up":
          return this.focusPane("top");
        case "focus-pane-down":
          return this.focusPane("bottom");
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
        case "undo":
        case "redo": {
          const pane = this.focused;
          return runHistoryMenu(id, {
            el: pane.el,
            editor: pane.surface.showsEditor ? pane.view : null,
          });
        }
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
    await this.openMemo(id, line);
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

  private async refreshSwitcher(): Promise<void> {
    try {
      const list = await this.backend.listWorkspaces();
      this.switcherList = switcherItems(list, this.workspacePath);
      // Hidden or not, this window's workspace names the button.
      const current = list.find((item) => item.path === this.workspacePath);
      this.switcher.render(this.switcherList, current?.name.normalize("NFC") ?? "");
    } catch (error) {
      console.warn(error);
    }
  }

  /** The switcher and ⌃1 – ⌃9: this window shows the workspace at `path`. The backend has the window
   * write its tabs (`onFlush`), then reloads it; a workspace another window shows comes forward
   * instead. */
  private async switchTo(path: string): Promise<void> {
    // The window answered a close or a switch: it has no tabs left to write.
    if (this.leaving) return;
    this.mark("switch-click");
    // ⌃1 – ⌃9 take no focus, and a workspace another window shows comes forward without a round
    // (`onFlush`) to end the composition.
    await this.settleCompositions();
    try {
      await this.backend.switchWorkspace(path);
    } catch (error) {
      this.report(error);
      // The folder may be gone since the list was read: ask again so the switcher drops it.
      void this.refreshSwitcher();
    }
  }

  /** The switcher's 「새 워크스페이스…」 and the menu's: a workspace made wherever it is asked for opens in
   * this window. */
  private async newWorkspace(): Promise<void> {
    if (this.leaving) return;
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
    await openSettings({
      backend: this.backend,
      registry: () => this.registry,
      onConfigChanged: (handler) => {
        this.configListeners.add(handler);
        return () => this.configListeners.delete(handler);
      },
      onWorkspacesChanged: (handler) => {
        this.workspaceListeners.add(handler);
        return () => this.workspaceListeners.delete(handler);
      },
      section: this.settingsSection,
      onSection: (section) => (this.settingsSection = section),
    });
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

  private reconfigureFont(doc: Doc): void {
    if (!doc.state) return;
    const effects = [fontEffect(this.editorFont())];
    const pane = this.paneOf(doc);
    if (doc === pane.tabs.active && pane.view.state === doc.state) pane.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
  }

  private reconfigureMenuKeys(doc: Doc): void {
    if (!doc.state) return;
    const effects = [menuKeysEffect(this.menuKeys)];
    const pane = this.paneOf(doc);
    if (doc === pane.tabs.active && pane.view.state === doc.state) pane.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
  }

  /** Tabs of a viewer have no editor state: only text tabs carry a gutter. */
  private reconfigureLineNumbers(doc: Doc): void {
    if (!doc.state) return;
    const effects = [lineNumbersEffect(this.settings.editor.lineNumbers)];
    const pane = this.paneOf(doc);
    if (doc === pane.tabs.active && pane.view.state === doc.state) pane.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
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
