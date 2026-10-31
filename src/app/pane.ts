import { EditorView } from "@codemirror/view";

import { errorCode, type Backend, type FileSource, type ViewerInfo } from "../backend/types";
import { splitName } from "../core/names";
import type { Registry } from "../extensions/registry";
import type { ThemeManager } from "../theme/manager";
import { h } from "../ui/dom";
import type { StatusBar } from "../ui/status-bar";
import { TabBar, type TabDrag } from "../ui/tab-bar";
import { dragsWindow } from "../ui/window-drag";
import { ViewerHost } from "../viewer/host";
import { LargeTextViewer } from "../viewer/large-text";
import { MemoDoc, type Doc, type ExternalDoc, type Problem } from "./docs";
import { describeError } from "./errors";
import { Surface } from "./surface";
import { Tabs } from "./tabs";

export const NOT_OPENABLE = "열 수 없음";
export const OPEN_AS_TEXT = "텍스트로 열기";
/** What an empty pane says, however many panes the window has. */
export const EMPTY_TITLE = "새 메모를 만드세요";
export const EMPTY_NEW_MEMO = "새 메모";

/** The empty pane's hint, naming the shortcut `new-memo` has now (`shortcut`, as written); none
 * while the shortcuts are not read, rather than a sentence that may change (`undefined`). */
export function emptyHint(shortcut: string | null | undefined): string {
  if (shortcut === undefined) return "";
  return shortcut
    ? `메모 목록에서 메모를 열거나 ${shortcut} 을 누르세요`
    : "메모 목록에서 메모를 여세요";
}

const PROBLEM_TEXT: Record<Problem, string> = {
  binary: NOT_OPENABLE,
  "not-utf8": "텍스트로 열 수 없음",
  "too-large": "100MB 가 넘어 편집기로 열 수 없습니다",
  "long-line": "한 줄이 너무 길어 편집기로 열 수 없습니다",
  missing: "파일을 찾을 수 없습니다",
  unreadable: "파일을 읽지 못했습니다",
};

/** The status bar's hint over a preview, naming the shortcut `toggle-preview` has now. */
function previewHint(shortcut: string | null | undefined): string {
  return shortcut ? `미리보기 · ${shortcut} 로 편집` : "미리보기";
}
const LARGE_TEXT_HINT = "읽기 전용 · 대용량 텍스트 뷰어";

/** A panel on show that reads its file through tokens issued to `owner`; closing it revokes them. */
interface TokenPanel {
  doc: Doc;
  owner: string;
  host: { destroy(): void; setTheme?(theme: Record<string, string>): void };
}

/** What a pane needs from its window. */
export interface PaneHost {
  readonly backend: Backend;
  readonly registry: Registry;
  readonly theme: ThemeManager;
  /** The window's panes in the order of its layout's leaves (depth first). */
  readonly panes: readonly Pane[];
  /** The pane the keys, the menu and the status bar go to. */
  readonly focused: Pane;
  /** The window wrote its tabs to close or to switch its workspace: no pane shows a tab until it
   * stays (`AppController.leave`). */
  readonly leaving: boolean;
  /** The status bar while it speaks for `pane` (the focused pane), else null. */
  statusOf(pane: Pane): StatusBar | null;
  /** `pane` now shows `doc`, or nothing: the memo list and the status bar's language follow. */
  showing(pane: Pane, doc: Doc | null): void;
  /** Tells the highlight worker which documents are on screen: every pane's active tab. */
  syncHighlightVisibility(): void;
  /** The tab came on show in a pane: a memo's viewed time is now (spec 2026-10-30 「정렬」). */
  viewed(doc: Doc): void;
  /** The shortcut app command `id` has now, as written (`shortcutHint` in src/shortcuts/keys.ts);
   * null when it has none, undefined while the table is not read. */
  shortcutHint(id: string): string | null | undefined;
  /** Numbers the large text searches of the window: the backend keeps only the latest one
   * running, so two viewers in one window must not reuse a number. */
  nextTextSearch(): number;
  closeTab(tabId: string): Promise<void>;
  /** Tab `tabId` of a pane has started to be dragged: the window says where it may go. */
  dragTab(tabId: string): TabDrag;
  /** Tab `tabId` of a pane was right-clicked: its context menu. */
  tabMenu(tabId: string): Promise<void>;
  /** A new memo in `pane`, which takes the focus: after its active tab, or as its last tab. */
  newMemoIn(pane: Pane, at: "after-active" | "end"): Promise<void>;
  /** Whether a press on `pane`'s tab bar may drag the window: laid out for macOS, and the pane on
   * the window's top line. */
  canDragWindow(pane: Pane): boolean;
  /** Hands the press going on to the system, which drags the window. */
  dragWindow(): void;
  saveSessionSoon(): void;
  report(error: unknown): void;
  mark(name: string): void;
  markNextFrame(name: string): void;
}

/** One editor pane of a window: its tab bar, its tabs, and the editor area showing the active
 * one — the editor, a placeholder or a viewer panel. */
export class Pane {
  readonly view = new EditorView();
  readonly tabs = new Tabs();
  readonly surface = new Surface(this.view);
  readonly tabBar = new TabBar({
    select: (id) => void this.activateTab(id),
    close: (id) => void this.host.closeTab(id),
    drag: (id) => this.host.dragTab(id),
    menu: (id) => void this.host.tabMenu(id),
    newTab: () => void this.host.newMemoIn(this, "end"),
  });
  /** The pane's top row: the tab bar, and in front of it the lead when this is the top left pane
   * (`attachLead`), whatever the sidebar's state; the lead shows only while it is collapsed. */
  readonly head: HTMLElement = h("div", { class: "pane-head" }, this.tabBar.el);
  /** Focusable, to take the keys while it shows no editor (`takeKeys`). */
  readonly el: HTMLElement = h("div", { class: "pane", tabIndex: -1 }, this.head, this.surface.el);
  /** A search result's line in a memo the large text viewer shows, for the viewer to go to once
   * it is open: it opens on its own time, after the click is handled. */
  pendingLine: { memoId: string; line: number } | null = null;
  private panel: TokenPanel | null = null;
  /** Numbers the views, so each owns its tokens alone: a tab left and come back to is a new one. */
  private views = 0;
  /** The tab whose activation waits for its first frame (`open-first-paint`) — a timing mark,
   * tests/measure/perf.md. */
  private painting: string | null = null;

  constructor(
    readonly id: string,
    private readonly host: PaneHost,
  ) {
    this.view.scrollDOM.addEventListener("scroll", () => this.host.saveSessionSoon(), {
      passive: true,
    });
    // The bar's own free space, as its `dblclick` reads it; the tabs drag themselves.
    dragsWindow(this.tabBar.el, {
      isFree: (target) => target === this.tabBar.el,
      canDrag: () => this.host.canDragWindow(this),
      start: () => this.host.dragWindow(),
    });
  }

  /** Puts `lead` in front of the tab bar, taking it from the pane that had it. */
  attachLead(lead: HTMLElement): void {
    if (lead.parentElement !== this.head) this.head.prepend(lead);
  }

  /** The large text viewer on show (public: the UI tests call `goToLine`). */
  get largeText(): { doc: Doc; viewer: LargeTextViewer; owner: string } | null {
    const open = this.panel;
    if (!open || !(open.host instanceof LargeTextViewer)) return null;
    return { doc: open.doc, viewer: open.host, owner: open.owner };
  }

  async activate(doc: Doc): Promise<void> {
    const previous = this.tabs.active;
    if (previous === doc) return;
    this.host.mark(`open-start:${doc.tabId}`);
    this.painting = doc.tabId;
    if (!(doc instanceof MemoDoc) || doc.info.id !== this.pendingLine?.memoId)
      this.pendingLine = null;
    if (previous) {
      this.capture(previous);
      void previous.leave();
    }
    this.tabs.active = doc;
    this.host.viewed(doc);
    this.host.syncHighlightVisibility();
    this.renderTabs();
    // The switch lets go of the tab left at once, whatever the new tab shows and however long it
    // takes to come (a read, a token, a scan): keys typed meanwhile are dropped, not saved there.
    this.surface.showNothing();
    this.surface.banner.render(doc.banner);
    await doc.ensureLoaded();
    // Loading can mark the tab dirty (a restored draft), which the render above could not know.
    this.renderTabs();
    if (this.tabs.active !== doc) return; // another tab was picked while this one loaded
    this.show(doc);
    this.host.saveSessionSoon();
  }

  private activateTab(tabId: string): Promise<void> {
    const doc = this.tabs.byId(tabId);
    return doc ? this.activate(doc) : Promise.resolve();
  }

  /** The active tab's text was read again. The view still holds the old state, so the scroll is
   * taken from it before the new one goes in. */
  showReloaded(doc: Doc): void {
    const editing = doc.state && !doc.problem && doc.mode === "edit";
    if (!editing || !this.surface.showsEditor) return this.show(doc);
    doc.scrollAnchor = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop).from;
    this.surface.replaceState(doc.state!, doc.scrollAnchor);
    this.host.statusOf(this)?.setPosition(this.view.state);
  }

  show(doc: Doc): void {
    // Its text is written for good: a key typed into it now would be lost with the window, or land
    // after the new window has read the tab.
    if (doc.leaving || this.host.leaving) {
      this.surface.showNothing();
      return;
    }
    this.closePanel();
    this.surface.banner.render(doc.banner);
    const state = doc.problem ? null : doc.state;
    this.host.showing(this, doc);
    const status = this.host.statusOf(this);
    status?.setMessage(doc.notice ?? "");
    // A trashed memo has no file a viewer could read — a preview's pictures included: its text
    // shows in the editor or not at all.
    const source = doc.source;
    if (state) {
      const preview =
        doc.mode === "preview" && source
          ? this.host.registry.viewerFor(doc.fileName, "preview")
          : undefined;
      if (preview) {
        this.openViewer(doc, source!, preview, state.doc.toString());
        this.keepKeys();
        status?.setPosition(null);
        // A notice of the document (a restored draft) is not to be hidden by the mode's hint.
        if (!doc.notice) status?.setMessage(this.previewHint());
        return;
      }
      // The language may have changed under a preview (detection on leaving), taking its viewer.
      doc.mode = "edit";
      this.surface.showEditor(state, doc.scrollAnchor, this.host.focused === this);
      this.markPainted(doc);
      status?.setPosition(this.view.state);
      return;
    }
    status?.setPosition(null);
    this.keepKeys();
    if (source && (doc.problem === "too-large" || doc.problem === "long-line")) {
      void this.openLargeText(doc, source);
      return;
    }
    const viewer =
      source && doc.problem === "binary" && !doc.forceText
        ? this.host.registry.viewerFor(doc.fileName, "primary")
        : undefined;
    if (viewer) this.openViewer(doc, source!, viewer);
    else this.showProblem(doc);
  }

  showEmpty(): void {
    this.closePanel();
    this.surface.banner.hide();
    this.showEmptyText();
    this.keepKeys();
    this.host.showing(this, null);
    const status = this.host.statusOf(this);
    status?.setPosition(null);
    status?.setMessage("");
  }

  /** Gives this pane the keys: its editor when it shows one, else the pane itself, so that no
   * other pane's editor goes on typing into a memo the person is not looking at. A viewer frame of
   * this pane keeps them: it was clicked to be used. */
  takeKeys(): void {
    if (this.surface.showsEditor) return this.view.focus();
    const active = document.activeElement;
    if (active instanceof HTMLIFrameElement && this.el.contains(active)) return;
    this.el.focus({ preventScroll: true });
  }

  /** The focused pane has stopped showing an editor: keys that were in a pane come here. Keys in
   * the sidebar or a dialog stay there. */
  private keepKeys(): void {
    if (this.host.focused === this && document.activeElement?.closest(".pane")) this.takeKeys();
  }

  /** The placeholder of a pane with no tabs. */
  showEmptyText(): void {
    this.surface.showEmpty({
      title: EMPTY_TITLE,
      hint: emptyHint(this.host.shortcutHint("new-memo")),
      action: { label: EMPTY_NEW_MEMO, run: () => void this.host.newMemoIn(this, "after-active") },
    });
  }

  /** The status bar has just come to speak for this pane: it shows what `show` put there. */
  showStatus(): void {
    const doc = this.tabs.active;
    this.host.showing(this, doc);
    const status = this.host.statusOf(this);
    if (!status) return;
    status.setPosition(doc && this.surface.showsEditor ? this.view.state : null);
    let message = doc?.notice ?? "";
    if (doc && !message && this.panel)
      message = this.largeText ? LARGE_TEXT_HINT : doc.mode === "preview" ? this.previewHint() : "";
    status.setMessage(message);
  }

  /** The app's shortcuts changed: the hints that name one say the shortcut there is now. */
  shortcutsChanged(): void {
    if (this.tabs.list.length === 0) this.showEmptyText();
    const doc = this.tabs.active;
    if (doc && !doc.notice && this.panel && !this.largeText && doc.mode === "preview")
      this.host.statusOf(this)?.setMessage(this.previewHint());
  }

  private previewHint(): string {
    return previewHint(this.host.shortcutHint("toggle-preview"));
  }

  /** Takes `doc` out of this pane, open as it is: its panel closes, the tab next to it (or
   * nothing) is shown when it was the active one, and the tab bar is drawn again. What closing a
   * tab or moving it elsewhere does here. The part up to showing the next tab is done by the
   * time this returns its promise. */
  async detach(doc: Doc): Promise<void> {
    const wasActive = doc === this.tabs.active;
    if (this.panel?.doc === doc) this.closePanel();
    const next = this.tabs.remove(doc);
    if (wasActive) {
      if (next) await this.activate(next);
      else {
        this.host.syncHighlightVisibility();
        this.showEmpty();
      }
    }
    this.renderTabs();
  }

  /** The view holds the live state of the active tab; keep where it is scrolled to. */
  capture(doc: Doc): void {
    if (doc !== this.tabs.active || !doc.state || this.view.state !== doc.state) return;
    if (!this.surface.showsEditor) return;
    doc.scrollAnchor = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop).from;
  }

  renderTabs(): void {
    this.tabBar.render(
      this.tabs.list.map((doc) => ({
        id: doc.tabId,
        title: doc.title,
        hint: doc.saveFailed ? `${doc.hint}\n저장 실패: ${describeError(doc.error)}` : doc.hint,
        dirty: doc.dirty,
        failed: doc.saveFailed,
        external: doc.kind === "external",
        trashed: doc.kind === "trashed",
        active: doc === this.tabs.active,
      })),
    );
  }

  /** The viewer on show takes the new theme's colours. */
  setViewerTheme(variables: Record<string, string>): void {
    this.panel?.host.setTheme?.(variables);
  }

  takePendingLine(doc: Doc): void {
    const pending = this.pendingLine;
    const open = this.largeText;
    if (!pending || !open || open.doc !== doc) return;
    if (!(doc instanceof MemoDoc) || doc.info.id !== pending.memoId) return;
    this.pendingLine = null;
    open.viewer.goToLine(pending.line);
  }

  closePanel(): void {
    const open = this.panel;
    if (!open) return;
    this.panel = null;
    open.host.destroy();
    this.revoke(open.owner);
    // A search through a file of gigabytes would otherwise read on for nobody.
    if (open.host instanceof LargeTextViewer) {
      void this.host.backend.cancelTextSearch().catch((error: unknown) => console.warn(error));
    }
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

  /** The owner of a view's tokens. The pane's id keeps it apart from another pane's view of the
   * same tab, whose count is its own. */
  private nextOwner(doc: Doc, what: string): string {
    return `${this.id}:${doc.tabId}:${what}:${++this.views}`;
  }

  /** A viewer for `doc` (spec 「뷰어」): a primary viewer for a file the editor cannot show gets a
   * token URL, a preview viewer gets `text` — the text as it is now. The token lives as long as
   * this view: leaving the tab, closing it or a viewer failure revokes it. */
  private openViewer(doc: Doc, source: FileSource, viewer: ViewerInfo, text?: string): void {
    const owner = this.nextOwner(doc, viewer.id);
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
      this.host.statusOf(this)?.setMessage("미리보기를 열 수 없어 편집으로 돌아왔습니다", "error");
      this.host.saveSessionSoon();
    };
    const host = new ViewerHost({
      url: this.host.backend.viewerUrl(viewer.extension, viewer.entry),
      resolveRelative: async (path) => {
        if (this.panel !== panel) return null;
        const url = await this.host.backend.resolveRelative(source, path, owner);
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
    this.markPainted(doc);
    const base = {
      fileName: doc.fileName,
      extension: splitName(doc.fileName).ext.toLowerCase(),
      theme: this.host.theme.active.variables,
    };
    if (text !== undefined) {
      host.start({ ...base, size: text.length, text });
      return;
    }
    void this.host.backend
      .issueFileToken(source, owner)
      .then((url) => {
        if (this.panel !== panel) return;
        host.start({
          ...base,
          size: doc instanceof MemoDoc ? doc.info.size : (doc as ExternalDoc).size,
          url,
        });
      })
      .catch((error: unknown) => {
        this.host.report(error);
        fallBack();
      });
  }

  /** The read-only large text viewer (spec 「크기별 단계」). Its token lives as long as the view. */
  private async openLargeText(doc: Doc, source: FileSource): Promise<void> {
    const owner = this.nextOwner(doc, "large-text");
    const view = this.views;
    // Another tab or view was shown while this one was on its way.
    const stale = () => this.tabs.active !== doc || this.views !== view;
    try {
      const [url, scan] = await Promise.all([
        this.host.backend.issueFileToken(source, owner),
        this.host.backend.scanText(source),
      ]);
      if (stale()) return this.revoke(owner);
      const viewer = new LargeTextViewer({
        url,
        scan,
        fileName: doc.fileName,
        search: (query, fromLine) =>
          this.host.backend.searchText(source, query, fromLine, this.host.nextTextSearch()),
      });
      this.panel = { doc, owner, host: viewer };
      this.surface.showPanel(viewer.el);
      this.markPainted(doc);
      this.host.statusOf(this)?.setMessage(LARGE_TEXT_HINT);
      this.takePendingLine(doc);
    } catch (error) {
      // The viewer is not coming: the line must not wait for the next time the tab opens.
      if (doc instanceof MemoDoc && this.pendingLine?.memoId === doc.info.id)
        this.pendingLine = null;
      this.revoke(owner);
      if (stale()) return;
      // Not text after all, by its first bytes (a video named `.ts` over 100MB): said as a text
      // file that is not text is, not as a failure.
      if (errorCode(error) === "not-text") doc.problem = "not-utf8";
      else this.host.report(error);
      this.showProblem(doc);
    }
  }

  /** `open-first-paint`: the frame after the tab being activated first shows its editor or
   * panel. */
  private markPainted(doc: Doc): void {
    if (this.painting !== doc.tabId) return;
    this.painting = null;
    this.host.markNextFrame(`open-first-paint:${doc.tabId}`);
  }

  private revoke(owner: string): void {
    void this.host.backend.revokeFileTokens(owner).catch((error: unknown) => console.warn(error));
  }
}
