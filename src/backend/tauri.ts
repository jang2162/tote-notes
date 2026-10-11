import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";

import {
  BACKEND_ERROR_CODES,
  BackendError,
  type Backend,
  type BackendErrorCode,
  type ExtensionRegistry,
  type ExtensionSummary,
  type ExternalInfo,
  type FileSource,
  type MemoInfo,
  type PendingOpen,
  type Settings,
  type SettingsPatch,
  type TextQuery,
  type TextScan,
  type TextSearch,
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

export class TauriBackend implements Backend {
  private readonly window = getCurrentWebviewWindow();

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
  setMemoLanguage(id: string, language: string, ext: string) {
    return call<MemoInfo>("set_memo_language", { id, language, ext });
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

  readSession() {
    return call<string | null>("read_session");
  }
  writeSession(json: string) {
    return call<void>("write_session", { json });
  }
  takePendingOpens() {
    return call<PendingOpen[]>("take_pending_opens");
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

  listWorkspaces() {
    return call<WorkspaceListItem[]>("list_workspaces");
  }
  createWorkspace(name: string) {
    return call<void>("create_workspace", { name });
  }
  openWorkspace(path: string) {
    return call<void>("open_workspace", { path });
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

  flushDone(id: number) {
    return call<void>("flush_done", { id });
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
  patchSettings(patch: SettingsPatch) {
    return call<void>("patch_settings", { patch });
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
  async pickExtensionPackage() {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "확장 패키지", extensions: ["vsix", "zip"] }],
    });
    return typeof picked === "string" ? picked : null;
  }
  async pickFolder() {
    const picked = await open({ multiple: false, directory: true });
    return typeof picked === "string" ? picked : null;
  }

  onMenu(handler: (id: string) => void) {
    void this.window.listen<string>("tote://menu", (event) => handler(event.payload));
  }
  onFlush(handler: (id: number) => void) {
    void this.window.listen<number>("tote://flush", (event) => handler(event.payload));
  }
  onPending(handler: () => void) {
    void this.window.listen("tote://pending", () => handler());
  }
  onConfigChanged(handler: () => void) {
    void this.window.listen("tote://config", () => handler());
  }
  onFileDrop(handler: (paths: string[]) => void) {
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") handler(event.payload.paths);
    });
  }
}
