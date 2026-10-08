/** What the frontend asks of the native side (src-tauri/src/app/commands.rs). The app runs on
 * `TauriBackend`; the browser preview and the UI tests run on `FakeBackend`, an in-memory
 * stand-in with the same behaviour. */

export type FileKind = "text" | "image" | "video" | "audio" | "document";

export interface MemoInfo {
  id: string;
  file: string;
  autoTitle: boolean;
  language?: string;
  modifiedMs: number;
  size: number;
  kind: FileKind;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  deviceId: string;
}

export interface ExternalInfo {
  path: string;
  exists: boolean;
  size: number;
  kind: FileKind;
  /** An unsaved draft is waiting; `diskChanged` says the file changed after editing started. */
  draft: { diskChanged: boolean } | null;
}

export type PendingOpen = { kind: "memo"; id: string } | { kind: "external"; path: string };

export interface WorkspaceListItem {
  name: string;
  path: string;
  open: boolean;
}

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The codes `CommandError` can carry (src-tauri/src/app/commands.rs). */
export type BackendErrorCode =
  | "not-a-workspace"
  | "already-exists"
  | "invalid-name"
  | "unknown-memo"
  | "not-found"
  | "bad-request"
  | "io"
  | "app"
  | "no-workspace";

/** A rejected call. `code` comes from `CommandError` on the Rust side. */
export class BackendError extends Error {
  readonly code: BackendErrorCode;

  constructor(code: BackendErrorCode, message: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}

export function errorCode(err: unknown): BackendErrorCode | null {
  return err instanceof BackendError ? err.code : null;
}

export interface Backend {
  workspaceInfo(): Promise<WorkspaceInfo>;
  listMemos(): Promise<MemoInfo[]>;
  createMemo(): Promise<MemoInfo>;
  readMemo(id: string): Promise<Uint8Array>;
  writeMemo(id: string, bytes: Uint8Array): Promise<MemoInfo>;
  retitleMemo(id: string, stem: string): Promise<MemoInfo>;
  renameMemo(id: string, file: string): Promise<MemoInfo>;
  deleteMemo(id: string): Promise<void>;
  importMemo(fileName: string, bytes: Uint8Array): Promise<MemoInfo>;
  importFile(path: string): Promise<MemoInfo>;

  readSession(): Promise<string | null>;
  writeSession(json: string): Promise<void>;
  takePendingOpens(): Promise<PendingOpen[]>;

  openExternal(path: string): Promise<ExternalInfo>;
  readExternal(path: string): Promise<Uint8Array>;
  readExternalDraft(path: string): Promise<Uint8Array>;
  keepExternalDraft(path: string, bytes: Uint8Array): Promise<void>;
  discardExternalDraft(path: string): Promise<void>;
  saveExternal(path: string, bytes: Uint8Array): Promise<void>;

  listWorkspaces(): Promise<WorkspaceListItem[]>;
  createWorkspace(name: string): Promise<void>;
  openWorkspace(path: string): Promise<void>;

  /** Where this window is, for the session; `null` where there is no native window. */
  windowFrame(): Promise<WindowFrame | null>;
  /** The 「파일 열기」 dialog; empty when cancelled. */
  pickFiles(): Promise<string[]>;
  flushDone(id: number): Promise<void>;
  closeWindow(): Promise<void>;

  onMenu(handler: (id: string) => void): void;
  onFlush(handler: (id: number) => void): void;
  onPending(handler: () => void): void;
  onFileDrop(handler: (paths: string[]) => void): void;
}
