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

/** What a `tote` request left for this window: something to open, or why it failed. */
export type PendingOpen =
  | { kind: "memo"; id: string }
  | { kind: "external"; path: string }
  | { kind: "notice"; message: string };

/** A file a viewer or the large text viewer reads, named the way the tabs name them. */
export type FileSource = { kind: "memo"; id: string } | { kind: "external"; path: string };

// --- Large text viewer (src-tauri/src/files/text.rs) ----------------------------------------

export interface TextScan {
  size: number;
  lineCount: number;
  checkpoints: number[];
  longestLine: number;
}

export interface TextQuery {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
}

export interface TextMatch {
  line: number;
  column: number;
}

export interface TextSearch {
  matches: TextMatch[];
  done: boolean;
  cancelled: boolean;
}

// --- Extensions (src-tauri/src/extensions/registry.rs) ---------------------------------------

export interface ExtensionSummary {
  id: string;
  version: string;
  displayName: string;
  source: "bundled" | "user";
  enabled: boolean;
  path: string;
  /** When the folder was made (ms). A same-version replace changes it. Absent in the fake's
   * bundled list. */
  modified?: number;
}

export interface GrammarInfo {
  scopeName: string;
  path: string;
  embeddedLanguages: Record<string, string>;
}

export interface LanguageInfo {
  id: string;
  /** The id of the extension contributing it. */
  extension: string;
  aliases: string[];
  /** Lower-case, without the dot. */
  extensions: string[];
  filenames: string[];
  firstLine: string | null;
  configuration: string | null;
  grammar: GrammarInfo | null;
}

export interface ThemeInfo {
  extension: string;
  label: string;
  /** VS Code's `uiTheme`: `vs` (light), `vs-dark`, `hc-black`, `hc-light`. */
  uiTheme: string;
  path: string;
}

export type ViewerKind = "primary" | "preview";

export interface ViewerInfo {
  extension: string;
  id: string;
  kind: ViewerKind;
  extensions: string[];
  entry: string;
}

export interface ExtensionProblem {
  path: string;
  message: string;
}

export interface GrammarRef {
  extension: string;
  language: string | null;
  scopeName: string;
  path: string;
  embeddedLanguages: Record<string, string>;
}

export interface ExtensionRegistry {
  extensions: ExtensionSummary[];
  /** In precedence order: the first language claiming a file wins. */
  languages: LanguageInfo[];
  /** Every grammar, for `include` lookups by scope name. */
  grammars: GrammarRef[];
  themes: ThemeInfo[];
  viewers: ViewerInfo[];
  problems: ExtensionProblem[];
}

export interface ThemeRef {
  extension: string;
  label: string;
}

/** `settings.json` (src-tauri/src/appdata.rs). The Rust side leaves `workspaceRoot` out of the
 * JSON when it is unset, so it arrives as `undefined` rather than `null`. */
export interface Settings {
  workspaceRoot?: string | null;
  theme: { light: ThemeRef | null; dark: ThemeRef | null };
  extensions: { disabled: string[]; precedence: "user" | "bundled" };
}

/** The settings fields one change names (`SettingsPatch` in src-tauri/src/appdata.rs). A key left
 * out is kept as it is; `null` clears it. */
export interface SettingsPatch {
  workspaceRoot?: string | null;
  themeLight?: ThemeRef | null;
  themeDark?: ThemeRef | null;
  precedence?: "user" | "bundled";
}

export interface WorkspaceListItem {
  name: string;
  path: string;
  open: boolean;
  /** In the recent list, but its folder or `.tote/workspace.json` is gone. */
  missing: boolean;
}

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The codes `CommandError` can carry (src-tauri/src/app/commands.rs). */
export const BACKEND_ERROR_CODES = [
  "not-a-workspace",
  "already-exists",
  "invalid-name",
  "unknown-memo",
  "not-found",
  "bad-request",
  "io",
  "app",
  "no-workspace",
  "already-installed",
  "invalid-extension",
] as const;
export type BackendErrorCode = (typeof BACKEND_ERROR_CODES)[number];

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
  setMemoLanguage(id: string, language: string, ext: string): Promise<MemoInfo>;
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
  /** The workspace listed at `from` now lives at `to`; opens it. `not-a-workspace` when `to` is
   * not one. */
  relocateWorkspace(from: string, to: string): Promise<void>;

  /** Where this window is, for the session; `null` where there is no native window. */
  windowFrame(): Promise<WindowFrame | null>;
  /** The 「파일 열기」 dialog; empty when cancelled. */
  pickFiles(): Promise<string[]>;
  /** Answers flush round `id`; `blocked` says what could not be written (the quit asks first). */
  flushDone(id: number, blocked?: string): Promise<void>;
  closeWindow(): Promise<void>;
  extensionRegistry(): Promise<ExtensionRegistry>;
  /** A file inside an installed extension, by the path its manifest uses. */
  readExtensionFile(extensionId: string, path: string): Promise<Uint8Array>;
  /** `already-installed` when the id exists and `replace` is false. */
  installExtension(path: string, replace: boolean): Promise<ExtensionSummary>;
  removeExtension(id: string): Promise<void>;
  setExtensionEnabled(id: string, enabled: boolean): Promise<void>;
  settings(): Promise<Settings>;
  /** Saves only the fields `patch` names, so two windows changing different fields keep both. */
  patchSettings(patch: SettingsPatch): Promise<void>;
  /** Where a bundled viewer page loads from. */
  viewerUrl(extensionId: string, entry: string): string;
  /** A URL only this view may use for the file; revoked with `revokeFileTokens(owner)`. */
  issueFileToken(source: FileSource, owner: string): Promise<string>;
  revokeFileTokens(owner: string): Promise<void>;
  /** A token URL for a file in the same folder as `source`, or null (spec 「뷰어 API」). */
  resolveRelative(source: FileSource, relative: string, owner: string): Promise<string | null>;
  /** Line count and page offsets of a file for the large text viewer. */
  scanText(source: FileSource): Promise<TextScan>;
  /** A page of matches from `fromLine`; a newer `requestId` from this window cancels older
   * ones. `bad-request` when the pattern is not a valid regex. */
  searchText(
    source: FileSource,
    query: TextQuery,
    fromLine: number,
    requestId: number,
  ): Promise<TextSearch>;
  /** Stops this window's running `searchText`, as a newer one would. */
  cancelTextSearch(): Promise<void>;
  /** The 「확장 설치」 dialog (.vsix / .zip); null when cancelled. */
  pickExtensionPackage(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  /** Settings or the extension set changed somewhere (this window included). */
  onConfigChanged(handler: () => void): void;

  onMenu(handler: (id: string) => void): void;
  onFlush(handler: (id: number) => void): void;
  onPending(handler: () => void): void;
  onFileDrop(handler: (paths: string[]) => void): void;
}
