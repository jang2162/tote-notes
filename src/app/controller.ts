import { EditorView, type ViewUpdate } from "@codemirror/view";

import { errorCode, type Backend } from "../backend/types";
import { WriteScheduler } from "../core/scheduler";
import { parseSession, type SessionFile, type SessionTab } from "../core/session";
import { editorExtensions, languageEffect } from "../editor/setup";
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

const SESSION_DELAY_MS = 1000;

const PROBLEM_TEXT: Record<Problem, string> = {
  binary: "텍스트로 열 수 없음",
  "too-large": "100MB 가 넘는 파일은 아직 열 수 없습니다",
  missing: "파일을 찾을 수 없습니다",
  unreadable: "파일을 읽지 못했습니다",
};

const ERROR_TEXT: Record<string, string> = {
  "already-exists": "같은 이름이 이미 있습니다",
  "invalid-name": "쓸 수 없는 이름입니다",
  "not-found": "파일을 찾을 수 없습니다",
};

export function describeError(err: unknown): string {
  const code = errorCode(err);
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  return `오류: ${err instanceof Error ? err.message : String(err)}`;
}

/** One workspace window: its tabs, the editor, the sidebar, the session and the menu actions. */
export class AppController implements DocHost {
  readonly writes = new WriteScheduler((_key, error) => this.report(error));
  readonly view = new EditorView();
  private tabs: Doc[] = [];
  private active: Doc | null = null;
  private deviceId = "";
  /** Session writes wait until the restored tabs are in place. */
  private restoring = true;
  private readonly memoList = new MemoList((id) => void this.openMemo(id));
  private readonly tabBar = new TabBar({
    select: (id) => void this.activateTab(id),
    close: (id) => void this.closeTab(id),
  });
  private readonly statusBar = new StatusBar();
  // CodeMirror's own CSS sets `display` on .cm-editor with !important, so its host is what hides.
  private readonly editorHost = h("div", { class: "editor-host" }, this.view.dom);
  private readonly placeholder = h("div", { class: "editor-placeholder" });

  constructor(
    root: HTMLElement,
    readonly backend: Backend,
  ) {
    const editorArea = h("div", { class: "editor-area" }, this.editorHost, this.placeholder);
    root.replaceChildren(
      this.memoList.el,
      h("main", { class: "main" }, this.tabBar.el, editorArea, this.statusBar.el),
    );
    this.view.scrollDOM.addEventListener("scroll", () => this.saveSessionSoon(), { passive: true });
    this.showEmpty();
  }

  async start(): Promise<void> {
    const info = await this.backend.workspaceInfo();
    this.deviceId = info.deviceId;
    document.title = info.name;
    this.backend.onMenu((id) => void this.onMenu(id));
    this.backend.onFlush((id) => void this.onFlush(id));
    this.backend.onPending(() => void this.drainPending());
    this.backend.onFileDrop((paths) => void this.openExternals(paths));
    // A window losing focus is a tab losing focus (spec 「저장」), and hidden windows barely run
    // timers — so write now rather than when the timer fires.
    window.addEventListener("blur", () => void this.active?.leave());
    window.addEventListener("focus", () => void this.refreshMemos());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void this.flushAll();
    });
    await this.refreshMemos();
    await this.restoreSession();
    this.restoring = false;
    await this.drainPending();
  }

  extensions(doc: Doc, options: { wrap: boolean }) {
    return editorExtensions({
      fileName: doc.fileName,
      wrap: options.wrap,
      onUpdate: (update) => this.onUpdate(doc, update),
    });
  }

  changed(doc: Doc, change: Change): void {
    if (doc instanceof MemoDoc && (change === "info" || change === "language"))
      this.memoList.upsert(doc.info);
    if (doc instanceof MemoDoc && change === "deleted") this.memoList.remove(doc.info.id);
    if (change === "language") this.reconfigureLanguage(doc);
    if (doc === this.active && change === "notice") this.statusBar.setMessage(doc.notice ?? "");
    if (doc === this.active && change === "saved" && doc instanceof ExternalDoc)
      this.statusBar.setMessage("저장됨");
    if (change === "error") this.report(doc.error);
    this.renderTabs();
  }

  async openMemo(id: string): Promise<void> {
    let doc: Doc | undefined = this.findMemo(id);
    if (!doc) {
      let info = this.memoList.get(id);
      if (!info) {
        await this.refreshMemos();
        info = this.memoList.get(id);
      }
      if (!info) return this.report(new Error("메모를 찾을 수 없습니다"));
      doc = this.insertTab(new MemoDoc(this, info));
    }
    await this.activate(doc);
  }

  async openExternal(path: string): Promise<void> {
    await this.activate(this.findExternal(path) ?? this.insertTab(new ExternalDoc(this, path)));
  }

  async newMemo(): Promise<void> {
    const info = await this.backend.createMemo();
    this.memoList.upsert(info);
    const doc = this.insertTab(new MemoDoc(this, info));
    doc.startEmpty();
    await this.activate(doc);
  }

  async closeTab(tabId: string): Promise<void> {
    const doc = this.tabs.find((d) => d.tabId === tabId);
    if (!doc) return;
    this.capture(doc);
    if (!(await doc.close(() => askUnsaved(doc.title)))) {
      if (doc === this.active) this.view.focus();
      return;
    }
    const index = this.tabs.indexOf(doc);
    this.tabs.splice(index, 1);
    if (doc === this.active) {
      this.active = null;
      const next = this.tabs[index] ?? this.tabs[index - 1];
      if (next) await this.activate(next);
      else this.showEmpty();
    }
    this.renderTabs();
    this.saveSessionSoon();
  }

  /** Everything written now — tab edits, titles and the session (window close, quit, hiding). */
  async flushAll(): Promise<void> {
    await Promise.all(
      this.tabs.map((doc) => doc.flush().catch((error: unknown) => this.report(error))),
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
    if (doc !== this.active || !(update.docChanged || update.selectionSet)) return;
    this.statusBar.setPosition(update.state);
    this.saveSessionSoon();
  }

  private async restoreSession(): Promise<void> {
    const session = parseSession(await this.backend.readSession());
    let active: Doc | null = null;
    for (const [index, tab] of session.tabs.entries()) {
      const doc = this.docFor(tab);
      if (!doc) continue;
      doc.restoreSelection = tab.selection;
      doc.scrollAnchor = tab.scrollAnchor ?? 0;
      this.tabs.push(doc);
      if (index === session.activeTab) active = doc;
    }
    const first = active ?? this.tabs.at(-1);
    if (first) await this.activate(first);
    else this.renderTabs();
  }

  private docFor(tab: SessionTab): Doc | null {
    if (tab.kind === "memo") {
      const info = this.memoList.get(tab.memoId);
      return info && !this.findMemo(info.id) ? new MemoDoc(this, info) : null;
    }
    // Another device's external file has no contents here; how to show it is the sync spec's call.
    if (tab.deviceId !== this.deviceId || this.findExternal(tab.path)) return null;
    return new ExternalDoc(this, tab.path);
  }

  private findMemo(id: string): MemoDoc | undefined {
    return this.tabs.find((doc): doc is MemoDoc => doc instanceof MemoDoc && doc.info.id === id);
  }

  private findExternal(path: string): ExternalDoc | undefined {
    return this.tabs.find(
      (doc): doc is ExternalDoc => doc instanceof ExternalDoc && doc.path === path,
    );
  }

  /** New tabs open right after the active one. */
  private insertTab<D extends Doc>(doc: D): D {
    const at = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, doc);
    return doc;
  }

  private activateTab(tabId: string): Promise<void> {
    const doc = this.tabs.find((d) => d.tabId === tabId);
    return doc ? this.activate(doc) : Promise.resolve();
  }

  private async activate(doc: Doc): Promise<void> {
    const previous = this.active;
    if (previous === doc) return;
    if (previous) {
      this.capture(previous);
      void previous.leave();
    }
    this.active = doc;
    this.renderTabs();
    await doc.ensureLoaded();
    // Loading can mark the tab dirty (a restored draft), which the render above could not know.
    this.renderTabs();
    if (this.active !== doc) return; // another tab was picked while this one loaded
    this.show(doc);
    this.saveSessionSoon();
  }

  private show(doc: Doc): void {
    const state = doc.problem ? null : doc.state;
    this.editorHost.hidden = !state;
    this.placeholder.hidden = Boolean(state);
    this.memoList.setActive(doc instanceof MemoDoc ? doc.info.id : null);
    this.statusBar.setLanguage(languageLabel(doc.fileName));
    this.statusBar.setMessage(doc.notice ?? "");
    if (!state) {
      this.placeholder.textContent = PROBLEM_TEXT[doc.problem ?? "unreadable"];
      this.statusBar.setPosition(null);
      return;
    }
    this.view.setState(state);
    const anchor = Math.min(doc.scrollAnchor, state.doc.length);
    this.view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: "start" }) });
    this.view.requestMeasure();
    this.statusBar.setPosition(this.view.state);
    this.view.focus();
  }

  private showEmpty(): void {
    this.editorHost.hidden = true;
    this.placeholder.hidden = false;
    this.placeholder.textContent = "⌘N 으로 새 메모를 만드세요";
    this.memoList.setActive(null);
    this.statusBar.setPosition(null);
    this.statusBar.setLanguage("");
    this.statusBar.setMessage("");
  }

  /** The view holds the live state of the active tab; keep where it is scrolled to. */
  private capture(doc: Doc): void {
    if (doc !== this.active || !doc.state || this.view.state !== doc.state) return;
    doc.scrollAnchor = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop).from;
  }

  private renderTabs(): void {
    this.tabBar.render(
      this.tabs.map((doc) => ({
        id: doc.tabId,
        title: doc.title,
        hint: doc.hint,
        dirty: doc.dirty,
        external: doc.kind === "external",
        active: doc === this.active,
      })),
    );
  }

  private async openExternals(paths: string[]): Promise<void> {
    for (const path of paths) await this.openExternal(path);
  }

  private async cycleTab(step: number): Promise<void> {
    if (!this.active || this.tabs.length < 2) return;
    const index = this.tabs.indexOf(this.active);
    await this.activate(this.tabs[(index + step + this.tabs.length) % this.tabs.length]);
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
    if (this.active) this.capture(this.active);
    const session: SessionFile = {
      version: 1,
      activeTab: this.active ? this.tabs.indexOf(this.active) : -1,
      tabs: this.tabs.map((doc) => this.sessionTab(doc)),
    };
    const frame = await this.backend.windowFrame();
    if (frame) session.window = frame;
    await this.backend.writeSession(JSON.stringify(session));
  }

  private sessionTab(doc: Doc): SessionTab {
    const place = { selection: doc.selectionJSON, scrollAnchor: doc.scrollAnchor };
    if (doc instanceof MemoDoc) return { kind: "memo", memoId: doc.info.id, ...place };
    // Spec 「동기화 대비」: external entries always carry the device they belong to.
    return { kind: "external", deviceId: this.deviceId, path: (doc as ExternalDoc).path, ...place };
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
          return this.active
            ? await this.closeTab(this.active.tabId)
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
    const doc = this.active;
    if (doc instanceof ExternalDoc) await doc.save();
    else if (doc instanceof MemoDoc) await doc.saveNow();
  }

  private async importActive(): Promise<void> {
    const doc = this.active;
    if (!(doc instanceof ExternalDoc)) return;
    this.capture(doc);
    const memo = await importExternal(doc, this);
    this.tabs[this.tabs.indexOf(doc)] = memo;
    this.memoList.upsert(memo.info);
    this.active = null;
    await this.activate(memo);
    this.statusBar.setMessage("워크스페이스로 가져왔습니다");
  }

  private async renameActive(): Promise<void> {
    const doc = this.active;
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
    if (this.active) this.view.focus();
  }

  private reconfigureLanguage(doc: Doc): void {
    if (!doc.state) return;
    const effects = languageEffect(doc.fileName);
    if (doc === this.active && this.view.state === doc.state) this.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
    if (doc === this.active) this.statusBar.setLanguage(languageLabel(doc.fileName));
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
