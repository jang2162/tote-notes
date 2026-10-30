import { Channel, invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";

import { parseSidebarWidth, SIDEBAR_WIDTH } from "../core/sidebar-width";

import {
  BACKEND_ERROR_CODES,
  BackendError,
  type Backend,
  type BackendErrorCode,
  type ExtensionRegistry,
  type ExtensionSummary,
  type ExternalInfo,
  type FileSource,
  type FlushGoal,
  type MemoInfo,
  type OutsideChange,
  type PendingOpen,
  type PopupMenuItem,
  type ContentHit,
  type TabRef,
  type PerfConfig,
  type SearchEvent,
  type SearchQuery,
  type Settings,
  type WindowStart,
  type WorkspaceRoots,
  type SettingsPatch,
  type ShortcutTable,
  type TextQuery,
  type TextScan,
  type TextSearch,
  type UpdateOffer,
  type UpdateProgress,
  type Version,
  type WindowFrame,
  type WorkspaceInfo,
  type WorkspaceListItem,
} from "./types";

const errorCodeOf = (code: string): BackendErrorCode =>
  BACKEND_ERROR_CODES.find((known) => known === code) ?? "app";

async function call<T>(
  cmd: string,
  args?: InvokeArgs,
  headers?: Record<string, string>,
): Promise<T> {
  try {
    return await invoke<T>(cmd, args, headers ? { headers } : undefined);
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null;
    if (e && typeof e === "object" && typeof e.code === "string") {
      // The IPC boundary is untyped, and nothing ties Rust's codes to the list: one it adds
      // before the list follows folds into "app" instead of passing as a code the UI never handles.
      const code = errorCodeOf(e.code);
      throw new BackendError(code, typeof e.message === "string" ? e.message : e.code);
    }
    throw new BackendError("app", String(err));
  }
}

const bytesOf = (buffer: ArrayBuffer) => new Uint8Array(buffer);
// Header values must be ASCII; names and paths are Korean as often as not.
const enc = encodeURIComponent;

declare global {
  interface Window {
    __TOTE_WINDOW_START__?: unknown;
  }
}

export class TauriBackend implements Backend {
  private readonly window = getCurrentWebviewWindow();
  private readonly start = this.readStart();

  // Each field is checked on its own: anything but the right type is the plain default.
  private readStart(): WindowStart {
    const raw = globalThis.window?.__TOTE_WINDOW_START__;
    const given = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      label: typeof given.label === "string" ? given.label : this.window.label,
      macTitlebar: given.macTitlebar === true,
      sidebarCollapsed: given.sidebarCollapsed === true,
      sidebarWidth: parseSidebarWidth(given.sidebarWidth) ?? SIDEBAR_WIDTH.default,
    };
  }

  windowStart() {
    return this.start;
  }
  startWindowDrag() {
    return this.window.startDragging();
  }
  toggleWindowZoom() {
    return this.window.toggleMaximize();
  }

  workspaceInfo() {
    return call<WorkspaceInfo>("workspace_info");
  }
  listMemos() {
    return call<MemoInfo[]>("list_memos");
  }
  createMemo() {
    return call<MemoInfo>("create_memo");
  }
  async readMemo(id: string) {
    return bytesOf(await call<ArrayBuffer>("read_memo", { id }));
  }
  writeMemo(id: string, bytes: Uint8Array) {
    return call<MemoInfo>("write_memo", bytes, { "x-memo-id": enc(id) });
  }
  retitleMemo(id: string, stem: string) {
    return call<MemoInfo>("retitle_memo", { id, stem });
  }
  renameMemo(id: string, file: string) {
    return call<MemoInfo>("rename_memo", { id, file });
  }
  memoViewed(id: string) {
    return call<MemoInfo>("memo_viewed", { id });
  }
  setMemoPinned(id: string, pinned: boolean) {
    return call<MemoInfo>("set_memo_pinned", { id, pinned });
  }
  setMemoLanguage(id: string, language: string, ext: string, detected = false) {
    return call<MemoInfo>("set_memo_language", { id, language, ext, detected });
  }
  deleteMemo(id: string) {
    return call<void>("delete_memo", { id });
  }
  importMemo(fileName: string, bytes: Uint8Array) {
    return call<MemoInfo>("import_memo", bytes, { "x-file-name": enc(fileName) });
  }
  importFile(path: string) {
    return call<MemoInfo>("import_file", { path });
  }

  readWindowLayout() {
    return call<string | null>("read_window_layout");
  }
  writeWindowLayout(json: string) {
    return call<void>("write_window_layout", { json });
  }
  takePendingOpens() {
    return call<PendingOpen[]>("take_pending_opens");
  }
  claimTabs(tabs: TabRef[], reveal: boolean) {
    return call<boolean[]>("claim_tabs", { tabs, reveal });
  }
  releaseTab(tab: TabRef) {
    return call<void>("release_tab", { tab });
  }
  tearOffTab(tab: string, ref: TabRef, at?: { x: number; y: number }) {
    return call<"moved" | "window">("tear_off_tab", { tab, tabRef: ref, at: at ?? null });
  }
  showPopupMenu(items: PopupMenuItem[]) {
    return call<string | null>("show_popup_menu", { items });
  }

  openExternal(path: string) {
    return call<ExternalInfo>("open_external", { path });
  }
  async readExternal(path: string) {
    return bytesOf(await call<ArrayBuffer>("read_external", { path }));
  }
  async readExternalDraft(path: string) {
    return bytesOf(await call<ArrayBuffer>("read_external_draft", { path }));
  }
  keepExternalDraft(path: string, bytes: Uint8Array) {
    return call<void>("keep_external_draft", bytes, { "x-path": enc(path) });
  }
  discardExternalDraft(path: string) {
    return call<void>("discard_external_draft", { path });
  }
  async saveExternal(path: string, bytes: Uint8Array) {
    await call<number>("save_external", bytes, { "x-path": enc(path) });
  }
  watchExternal(path: string) {
    return call<void>("watch_external", { path });
  }
  unwatchExternal(path: string) {
    return call<void>("unwatch_external", { path });
  }

  listWorkspaces() {
    return call<WorkspaceListItem[]>("list_workspaces");
  }
  setWorkspaceOrder(order: string[], hidden: string[]) {
    return call<void>("set_workspace_order", { order, hidden });
  }
  createWorkspace(name: string) {
    return call<string>("create_workspace", { name });
  }
  switchWorkspace(path: string) {
    return call<"focused" | "switching">("switch_workspace", { path });
  }

  listVersions(id: string) {
    return call<Version[]>("list_versions", { id });
  }
  async readVersion(snapshot: string, file: string) {
    return bytesOf(await call<ArrayBuffer>("read_version", { snapshot, file }));
  }
  revealBackups() {
    return call<void>("reveal_backups");
  }

  async windowFrame(): Promise<WindowFrame> {
    const scale = await this.window.scaleFactor();
    const position = (await this.window.outerPosition()).toLogical(scale);
    const size = (await this.window.innerSize()).toLogical(scale);
    return { x: position.x, y: position.y, width: size.width, height: size.height };
  }

  async pickFiles() {
    return (await open({ multiple: true, directory: false })) ?? [];
  }

  flushDone(id: number, blocked?: string) {
    return call<boolean>("flush_done", { id, blocked });
  }
  closeWindow() {
    return call<void>("close_window");
  }

  extensionRegistry() {
    return call<ExtensionRegistry>("extension_registry");
  }
  async readExtensionFile(extensionId: string, path: string) {
    return bytesOf(await call<ArrayBuffer>("read_extension_file", { extensionId, path }));
  }
  installExtension(path: string, replace: boolean) {
    return call<ExtensionSummary>("install_extension", { path, replace });
  }
  removeExtension(id: string) {
    return call<void>("remove_extension", { id });
  }
  setExtensionEnabled(id: string, enabled: boolean) {
    return call<void>("set_extension_enabled", { id, enabled });
  }
  settings() {
    return call<Settings>("get_settings");
  }
  workspaceRoots() {
    return call<WorkspaceRoots>("workspace_roots");
  }
  patchSettings(patch: SettingsPatch) {
    return call<void>("patch_settings", { patch });
  }
  shortcutTable() {
    return call<ShortcutTable>("shortcut_table");
  }
  suspendShortcuts(on: boolean) {
    return call<void>("suspend_shortcuts", { on });
  }
  runMenuCommand(id: string) {
    return call<void>("run_menu_command", { id });
  }
  viewerUrl(extensionId: string, entry: string) {
    return `tote-ext://localhost/${encodeURIComponent(extensionId)}/${entry.split("/").map(encodeURIComponent).join("/")}`;
  }
  issueFileToken(source: FileSource, owner: string) {
    return call<string>("issue_file_token", { source, owner });
  }
  revokeFileTokens(owner: string) {
    return call<void>("revoke_file_tokens", { owner });
  }
  resolveRelative(source: FileSource, relative: string, owner: string) {
    return call<string | null>("resolve_relative", { source, relative, owner });
  }
  scanText(source: FileSource) {
    return call<TextScan>("scan_text", { source });
  }
  searchText(source: FileSource, query: TextQuery, fromLine: number, requestId: number) {
    return call<TextSearch>("search_text", { source, query, fromLine, requestId });
  }
  cancelTextSearch() {
    return call<void>("cancel_text_search");
  }
  searchWorkspace(query: SearchQuery, requestId: number, onEvent: (event: SearchEvent) => void) {
    return call<void>("search_workspace", {
      query,
      requestId,
      onEvent: new Channel<SearchEvent>(onEvent),
    });
  }
  cancelWorkspaceSearch() {
    return call<void>("cancel_workspace_search");
  }
  findInMemos(queries: string[], requestId: number) {
    return call<ContentHit[] | null>("find_in_memos", { queries, requestId });
  }
  cancelMemoFilter() {
    return call<void>("cancel_memo_filter");
  }
  currentUpdate() {
    return call<UpdateOffer | null>("current_update");
  }
  installUpdate(onProgress: (progress: UpdateProgress) => void) {
    return call<void>("install_update", { onProgress: new Channel<UpdateProgress>(onProgress) });
  }
  restartForUpdate() {
    return call<void>("restart_for_update");
  }
  perfMark(name: string) {
    // A mark must never be what fails a window.
    void call<void>("perf_mark", { name }).catch(() => {});
  }
  perfConfig() {
    return call<PerfConfig>("perf_config");
  }
  async pickExtensionPackage() {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "확장 패키지", extensions: ["vsix", "zip"] }],
    });
    return typeof picked === "string" ? picked : null;
  }
  async pickFolder(start?: string) {
    const picked = await open({ multiple: false, directory: true, defaultPath: start });
    return typeof picked === "string" ? picked : null;
  }

  onMenu(handler: (id: string) => void) {
    void this.window.listen<string>("tote://menu", (event) => handler(event.payload));
  }
  onFlush(handler: (id: number, goal: FlushGoal) => void) {
    void this.window.listen<{ id: number; goal: FlushGoal }>("tote://flush", (event) =>
      handler(event.payload.id, event.payload.goal),
    );
  }
  onStay(handler: () => void) {
    void this.window.listen("tote://stay", () => handler());
  }
  onPending(handler: () => void) {
    void this.window.listen("tote://pending", () => handler());
  }
  onFullscreen(handler: (fullscreen: boolean) => void) {
    // tao marks the window in or out of full screen before the resize that ends the transition.
    // Only the latest ask's answer counts: answers to asks made one after another can cross.
    let asks = 0;
    let told: boolean | null = null;
    const ask = async () => {
      const at = ++asks;
      const fullscreen = await this.window.isFullscreen();
      if (at !== asks || fullscreen === told) return;
      told = fullscreen;
      handler(fullscreen);
    };
    // A failed ask leaves the room as it is; the next resize asks again.
    void this.window.onResized(() => void ask().catch(() => {}));
    void ask().catch(() => {});
  }
  onRestartOff(handler: () => void) {
    // Sent to every window (`Step::RestartOff`); only a dialog waiting on the restart listens.
    let stopped = false;
    let unlisten: (() => void) | null = null;
    void this.window
      .listen("tote://restart-off", () => handler())
      .then((stop) => {
        if (stopped) stop();
        else unlisten = stop;
      });
    return () => {
      stopped = true;
      unlisten?.();
    };
  }
  onConfigChanged(handler: () => void) {
    void this.window.listen("tote://config", () => handler());
  }
  onOutsideChange(handler: (change: OutsideChange) => void) {
    void this.window.listen<OutsideChange>("tote://outside", (event) => handler(event.payload));
  }
  onMemosChanged(handler: () => void) {
    void this.window.listen("tote://memos", () => handler());
  }
  onReveal(handler: (tab: TabRef) => void) {
    void this.window.listen<TabRef>("tote://reveal", (event) => handler(event.payload));
  }
  async onAdopt(handler: (tab: string, x: number, y: number) => void) {
    await this.window.listen<{ tab: string; x: number; y: number }>("tote://adopt", (event) =>
      handler(event.payload.tab, event.payload.x, event.payload.y),
    );
  }
  onWorkspacesChanged(handler: () => void) {
    void this.window.listen("tote://workspaces", () => handler());
  }
  onFileDrop(handler: (paths: string[]) => void) {
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") handler(event.payload.paths);
    });
  }
}
