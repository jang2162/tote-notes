import { EditorView, type ViewUpdate } from "@codemirror/view";

import type { Backend, MemoInfo } from "../backend/types";
import { WriteScheduler } from "../core/scheduler";
import { editorExtensions, languageEffect } from "../editor/setup";
import { EMPTY_REGISTRY, Registry } from "../extensions/registry";
import { ThemeManager } from "../theme/manager";
import { askUnsaved, promptText, workspacePicker } from "../ui/dialogs";
import { h } from "../ui/dom";
import { MemoList } from "../ui/memo-list";
import { languageLabel, StatusBar } from "../ui/status-bar";
import { TabBar } from "../ui/tab-bar";
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

const SESSION_DELAY_MS = 1000;

const PROBLEM_TEXT: Record<Problem, string> = {
  binary: "텍스트로 열 수 없음",
  "too-large": "100MB 가 넘는 파일은 아직 열 수 없습니다",
  missing: "파일을 찾을 수 없습니다",
  unreadable: "파일을 읽지 못했습니다",
};

/** One workspace window: menu actions, opening and closing, and what the status bar says. Tabs,
 * the session and the editor area live in `Tabs`, `SessionSync` and `Surface`. */
export class AppController implements DocHost {
  readonly writes = new WriteScheduler((_key, error) => this.report(error));
  readonly view = new EditorView();
  readonly tabs = new Tabs();
  readonly surface = new Surface(this.view);
  registry = new Registry(EMPTY_REGISTRY);
  readonly theme: ThemeManager;
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
    this.backend.onConfigChanged(() => void this.onConfigChanged());
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
    await this.theme.refresh();
  }

  extensions(doc: Doc, options: { wrap: boolean }) {
    return editorExtensions({
      fileName: doc.fileName,
      wrap: options.wrap,
      onUpdate: (update) => this.onUpdate(doc, update),
    });
  }

  changed(doc: Doc, change: Change): void {
    const active = doc === this.tabs.active;
    if (doc instanceof MemoDoc && (change === "info" || change === "language"))
      this.memoList.upsert(doc.info);
    if (doc instanceof MemoDoc && change === "deleted") this.memoList.remove(doc.info.id);
    if (change === "language") this.reconfigureLanguage(doc);
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
    const next = this.tabs.remove(doc);
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
    await doc.ensureLoaded();
    // Loading can mark the tab dirty (a restored draft), which the render above could not know.
    this.renderTabs();
    if (this.tabs.active !== doc) return; // another tab was picked while this one loaded
    this.show(doc);
    this.saveSessionSoon();
  }

  private show(doc: Doc): void {
    const state = doc.problem ? null : doc.state;
    this.memoList.setActive(doc instanceof MemoDoc ? doc.info.id : null);
    this.statusBar.setLanguage(languageLabel(doc.fileName));
    this.statusBar.setMessage(doc.notice ?? "");
    if (!state) {
      this.surface.showPlaceholder(PROBLEM_TEXT[doc.problem ?? "unreadable"]);
      this.statusBar.setPosition(null);
      return;
    }
    this.surface.showEditor(state, doc.scrollAnchor);
    this.statusBar.setPosition(this.view.state);
  }

  private showEmpty(): void {
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
        case "open-workspace":
        case "new-workspace":
          return await this.showPicker();
      }
    } catch (error) {
      this.report(error);
    }
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
    this.memoList.upsert(memo.info);
    this.tabs.active = null;
    await this.activate(memo);
    this.statusBar.setMessage("워크스페이스로 가져왔습니다");
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

  private reconfigureLanguage(doc: Doc): void {
    if (!doc.state) return;
    const effects = languageEffect(doc.fileName);
    if (doc === this.tabs.active && this.view.state === doc.state) this.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
    if (doc === this.tabs.active) this.statusBar.setLanguage(languageLabel(doc.fileName));
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
