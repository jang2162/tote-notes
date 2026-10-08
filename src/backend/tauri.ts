import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";

import {
  BackendError,
  type Backend,
  type ExternalInfo,
  type MemoInfo,
  type PendingOpen,
  type WindowFrame,
  type WorkspaceInfo,
  type WorkspaceListItem,
} from "./types";

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
      throw new BackendError(e.code, typeof e.message === "string" ? e.message : e.code);
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

  onMenu(handler: (id: string) => void) {
    void this.window.listen<string>("tote://menu", (event) => handler(event.payload));
  }
  onFlush(handler: (id: number) => void) {
    void this.window.listen<number>("tote://flush", (event) => handler(event.payload));
  }
  onPending(handler: () => void) {
    void this.window.listen("tote://pending", () => handler());
  }
  onFileDrop(handler: (paths: string[]) => void) {
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") handler(event.payload.paths);
    });
  }
}
