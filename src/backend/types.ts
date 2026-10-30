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
  /** At the top of the memo list (spec 2026-10-30 「고정」); left out when not. */
  pinned?: boolean;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  /** The window's title: the name, numbered from the workspace's second window on. */
  title: string;
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

/** What a `tote` request left for this window: something to open, or why it failed — or a new
 * version to ask about now (the menu's check: `AppCore::offer_update` in src-tauri/src/app/mod.rs)
 * or to put the update button up for (`AppCore::announce_update`). */
export type PendingOpen =
  | { kind: "memo"; id: string }
  | { kind: "external"; path: string }
  | { kind: "notice"; message: string }
  | ({ kind: "update" } & UpdateOffer)
  | { kind: "updateFound"; version: string };

/** A release newer than this one (`UpdateOffer` in src-tauri/src/app/update.rs). */
export interface UpdateOffer {
  version: string;
  current: string;
  /** The release notes; `null` when the release has none. */
  notes: string | null;
  /** How far this run went with an update (`OfferStatus`): another window is downloading it, or
   * one is installed and only the restart is left. */
  status: "available" | "installing" | "installed";
}

/** How far `installUpdate` is: bytes downloaded (`total` unknown without a length), then the
 * install. */
export type UpdateProgress =
  | { kind: "progress"; done: number; total: number | null }
  | { kind: "installing" };

/** An item of `showPopupMenu`; with `checked` it is a check item, ticked or not. */
export interface PopupMenuItem {
  id: string;
  text: string;
  checked?: boolean;
}

/** A tab as every window names it (src-tauri/src/app/places.rs): a memo of this window's
 * workspace, or an external file. */
export type TabRef = { kind: "memo"; id: string } | { kind: "external"; path: string };

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

// --- Workspace search (src-tauri/src/search/mod.rs) ------------------------------------------

/** The same shape as the large text viewer's query. */
export type SearchQuery = TextQuery;

/** `TOTE_PERF_SEARCH` (and `TOTE_PERF_SEARCH_REGEX=1`) of a measurement run. */
export interface PerfSearch {
  query: string;
  regex: boolean;
}

/** `enabled`: the app runs with `TOTE_PERF=1`, so marks are kept — otherwise none are sent. */
export interface PerfConfig {
  enabled: boolean;
  search: PerfSearch | null;
}

/** A matching line (`Match`). A line with several matches is one, at the first. */
export interface SearchMatch {
  /** 0-based. */
  line: number;
  /** Characters before the match in the whole line — not in `text`, which may be cut. */
  column: number;
  /** At most 160 characters around the match; a cut end is marked with `…`. */
  text: string;
  /** Context lines, cut the same way. A line between two close matches is only in the earlier
   * one's `after`. */
  before: string[];
  after: string[];
}

/** One file's matches as soon as it is done, in no fixed order, then one `done`. */
export type SearchEvent =
  | { kind: "file"; memoId: string; file: string; matches: SearchMatch[] }
  | { kind: "done"; filesSearched: number; truncated: boolean; cancelled: boolean };

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
  editor: EditorSettings;
  /** The check for a new version at launch (src-tauri/src/app/update.rs). */
  updates: { autoCheck: boolean };
  /** Command id → the shortcut it has instead of its default, `null` for none. Rust leaves it out
   * of the JSON when nothing is saved. Read the shortcuts from `Backend.shortcutTable()`. */
  shortcuts?: Record<string, string | null>;
}

/** `EditorSettings` in src-tauri/src/appdata.rs. `fontFamily` is empty for the stylesheet's own. */
export interface EditorSettings {
  lineNumbers: boolean;
  /** 11–24; Rust clamps what a patch asks for. */
  fontSize: number;
  fontFamily: string;
}

/** The smallest and largest editor font size (`FONT_SIZES` in src-tauri/src/appdata.rs). */
export const EDITOR_FONT_SIZE_MIN = 11;
export const EDITOR_FONT_SIZE_MAX = 24;

/** `WorkspaceRoots` in src-tauri/src/app/commands.rs: absolute paths, and the default as the
 * settings screen shows it (home as `~`). */
export interface WorkspaceRoots {
  current: string;
  default: string;
  defaultShown: string;
}

/** The settings fields one change names (`SettingsPatch` in src-tauri/src/appdata.rs). A key left
 * out is kept as it is; `null` clears it. */
export interface SettingsPatch {
  workspaceRoot?: string | null;
  themeLight?: ThemeRef | null;
  themeDark?: ThemeRef | null;
  precedence?: "user" | "bundled";
  editorLineNumbers?: boolean;
  editorFontSize?: number;
  editorFontFamily?: string;
  updatesAutoCheck?: boolean;
  /** The whole map: a command left out goes back to its default. Refused (`bad-request`) when an
   * entry breaks a rule (`shortcuts::validate` in src-tauri/src/shortcuts.rs). */
  shortcuts?: Record<string, string | null>;
  /** The saved map `shortcuts` was made from. When it is no longer the saved one (another window
   * saved meanwhile), the whole patch is refused with `bad-request` "shortcuts changed". */
  shortcutsExpected?: Record<string, string | null>;
}

/** `ShortcutTable` in src-tauri/src/shortcuts.rs. Shortcuts are Tauri accelerators
 * (`CmdOrCtrl+Shift+N`). */
export interface ShortcutTable {
  /** Every app command, in menu order. */
  commands: ShortcutCommand[];
  /** Shortcuts no command may take. */
  fixed: FixedShortcut[];
}

export interface ShortcutCommand {
  id: string;
  /** The menu item's name. */
  label: string;
  /** The submenu it is in. */
  menu: string;
  default: string | null;
  /** Set when its default gives way to a key saved for another command, instead of beating it. */
  yields?: true;
  /** Set when its default is not in force because a saved key has it: `current` is empty without
   * an entry in the saved map, unlike an entry of the person's. */
  yielded?: true;
  /** The shortcut it has now: a saved one, else the default. */
  current: string | null;
}

export interface FixedShortcut {
  name: string;
  accelerator: string;
}

export interface WorkspaceListItem {
  name: string;
  path: string;
  open: boolean;
  /** How many windows show it. */
  windows: number;
  /** In the recent list, but its folder or `.tote/workspace.json` is gone. */
  missing: boolean;
  /** Its place in the set order, from 0, the hidden ones counted too, so not its ⌃ number.
   * `null` when `missing`. */
  order: number | null;
  /** Left out of the switcher; 「워크스페이스 열기…」 (the 파일 menu's) still lists it. */
  hidden: boolean;
  /** Its ID can be read, so the order file can name it. */
  orderable: boolean;
}

/** A memo's copy in a backup snapshot (`Version` in src-tauri/src/backup/versions.rs).
 * `snapshot` is the folder name, `YYYYMMDD-HHMMSS` in local time. `until` is the last snapshot
 * holding the same text; it equals `snapshot` when the text was backed up once. */
export interface Version {
  snapshot: string;
  until: string;
  file: string;
  size: number;
  sha256: string;
}

/** What another app did to a workspace's files (`Change` in src-tauri/src/workspace/mod.rs). */
export type WorkspaceChange =
  | { kind: "modified"; id: string }
  | { kind: "added"; id: string; file: string }
  | { kind: "removed"; id: string; file: string }
  | { kind: "renamed"; id: string; from: string; to: string };

/** What another app did to an open external file (`ExternalState` in src-tauri/src/persist/external.rs). */
export type ExternalState = "modified" | "removed";

/** The payload of `tote://outside` (`OutsideChange` in src-tauri/src/app/mod.rs). `path` is the
 * path the window gave `watchExternal`. */
export type OutsideChange =
  | { kind: "workspace"; changes: WorkspaceChange[] }
  | { kind: "external"; path: string; state: ExternalState };

/** What a flush round is for (`FlushGoal::kind` in src-tauri/src/app/flush.rs): the window
 * closes, the window switches its workspace, or the app quits. */
export type FlushGoal = "close" | "switch" | "quit";

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
  "window-busy",
  // A read refused after the file's first bytes: it is not text (`persist::read_text`).
  "not-text",
  // The update's (src-tauri/src/app/commands.rs `install_update`, `restart_for_update`).
  "no-update",
  "update-failed",
  "not-installed",
  "busy",
  "installing",
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

/** What the native side tells a page about its window before the page runs. */
export interface WindowStart {
  label: string;
  /** The window's title bar is overlaid (macOS): the tab row sits on the traffic-light line. */
  macTitlebar: boolean;
  /** The sidebar was collapsed in the window's saved layout. */
  sidebarCollapsed: boolean;
  /** The sidebar's width in the window's saved layout, 240 when it holds none it can use. */
  sidebarWidth: number;
}

export interface Backend {
  /** The same value every call; read once as the window starts. */
  windowStart(): WindowStart;
  /** Hands the pointer press that is going on to the system, which drags the window. */
  startWindowDrag(): Promise<void>;
  /** Zooms the window, or restores it from zoomed (the title bar's double click). */
  toggleWindowZoom(): Promise<void>;
  workspaceInfo(): Promise<WorkspaceInfo>;
  listMemos(): Promise<MemoInfo[]>;
  createMemo(): Promise<MemoInfo>;
  readMemo(id: string): Promise<Uint8Array>;
  writeMemo(id: string, bytes: Uint8Array): Promise<MemoInfo>;
  retitleMemo(id: string, stem: string): Promise<MemoInfo>;
  renameMemo(id: string, file: string): Promise<MemoInfo>;
  /** Pins the memo to the top of the memo list, or lets it go; every window's list follows. */
  setMemoPinned(id: string, pinned: boolean): Promise<MemoInfo>;
  setMemoLanguage(id: string, language: string, ext: string): Promise<MemoInfo>;
  deleteMemo(id: string): Promise<void>;
  importMemo(fileName: string, bytes: Uint8Array): Promise<MemoInfo>;
  importFile(path: string): Promise<MemoInfo>;

  /** This window's layout in the session (`WindowSession`), `null` when it has none. */
  readWindowLayout(): Promise<string | null>;
  /** Writes this window's layout; the backend puts it in the session file with the layouts of the
   * workspace's other windows. */
  writeWindowLayout(json: string): Promise<void>;
  takePendingOpens(): Promise<PendingOpen[]>;
  /** Claims `tabs` for this window before it shows them (one memo or file in one place), one
   * answer each: false when another window has the tab. With `reveal`, that window comes forward
   * and shows it. */
  claimTabs(tabs: TabRef[], reveal: boolean): Promise<boolean[]>;
  /** This window closed the tab: another window may open it. */
  releaseTab(tab: TabRef): Promise<void>;
  /** Moves the tab `ref` out of this window: `tab` is its session entry (`SessionTab`, as JSON).
   * Without `at` it goes into a new window of this workspace, which opens with it alone, a little
   * off this one. With `at`, the screen point it was let go on outside this window, it joins the
   * window of this workspace there (`"moved"`: that window gets it through `onAdopt`), else a new
   * window opens with its top-left corner there. A new window's tab has its place and its line in
   * the session before the window is made; when it cannot be made the tab stays here. */
  tearOffTab(tab: string, ref: TabRef, at?: { x: number; y: number }): Promise<"moved" | "window">;
  /** A native pop-up menu at the pointer (a tab's, a memo row's, the sort's): the `id` of the item
   * picked, `null` when it closed without a pick. */
  showPopupMenu(items: PopupMenuItem[]): Promise<string | null>;

  openExternal(path: string): Promise<ExternalInfo>;
  readExternal(path: string): Promise<Uint8Array>;
  readExternalDraft(path: string): Promise<Uint8Array>;
  keepExternalDraft(path: string, bytes: Uint8Array): Promise<void>;
  discardExternalDraft(path: string): Promise<void>;
  saveExternal(path: string, bytes: Uint8Array): Promise<void>;
  /** Changes other apps make to the file come as `onOutsideChange`. Counted: each call needs an
   * `unwatchExternal`. */
  watchExternal(path: string): Promise<void>;
  unwatchExternal(path: string): Promise<void>;

  /** The workspaces under the workspace root, most recently used first, then the recent ones that
   * are gone. The switcher sorts them by `order`. */
  listWorkspaces(): Promise<WorkspaceListItem[]>;
  /** Saves the switcher's order — every workspace under the root, by path — and the ones it hides;
   * every window's switcher follows (`onWorkspacesChanged`). */
  setWorkspaceOrder(order: string[], hidden: string[]): Promise<void>;
  /** Makes a workspace under the workspace root and returns its folder. No window opens on it:
   * the window that asked switches to it (`switchWorkspace`). */
  createWorkspace(name: string): Promise<string>;
  /** Opens the workspace in a window of its own, or brings forward the window showing it. */
  openWorkspace(path: string): Promise<void>;
  /** This window shows the workspace at `path`: `"focused"` when it shows it already or another
   * window showing it came forward (this window stays), `"switching"` when this window writes its
   * tabs (`onFlush`) and then reloads on it. `not-a-workspace` when `path` is not one. */
  switchWorkspace(path: string): Promise<"focused" | "switching">;
  /** The workspace listed at `from` now lives at `to`; opens it. `not-a-workspace` when `to` is
   * not one. */
  relocateWorkspace(from: string, to: string): Promise<void>;

  /** The memo's earlier versions in this workspace's backups, newest first, only where the text
   * differs from the next older one (spec 「백업」 복원). */
  listVersions(id: string): Promise<Version[]>;
  readVersion(snapshot: string, file: string): Promise<Uint8Array>;
  /** Shows this workspace's backup folder in Finder. */
  revealBackups(): Promise<void>;

  /** Where this window is, for the session; `null` where there is no native window. */
  windowFrame(): Promise<WindowFrame | null>;
  /** The 「파일 열기」 dialog; empty when cancelled. */
  pickFiles(): Promise<string[]>;
  /** Answers flush round `id`; `blocked` says what could not be written (the quit asks first).
   * `false` when the round was settled without this answer — its timeout ran out — and the window
   * is not going: a page that let go of its panes for it takes them back. */
  flushDone(id: number, blocked?: string): Promise<boolean>;
  closeWindow(): Promise<void>;
  extensionRegistry(): Promise<ExtensionRegistry>;
  /** A file inside an installed extension, by the path its manifest uses. */
  readExtensionFile(extensionId: string, path: string): Promise<Uint8Array>;
  /** `already-installed` when the id exists and `replace` is false. */
  installExtension(path: string, replace: boolean): Promise<ExtensionSummary>;
  removeExtension(id: string): Promise<void>;
  setExtensionEnabled(id: string, enabled: boolean): Promise<void>;
  settings(): Promise<Settings>;
  /** The workspace root in use and the one an unset `workspaceRoot` means. */
  workspaceRoots(): Promise<WorkspaceRoots>;
  /** Saves only the fields `patch` names, so two windows changing different fields keep both. */
  patchSettings(patch: SettingsPatch): Promise<void>;
  /** The app commands with their shortcuts as the saved settings make them. */
  shortcutTable(): Promise<ShortcutTable>;
  /** Takes the menu's shortcuts off while this window records one (`on`), and puts them back.
   * The app also puts them back once this window loses focus or closes. */
  suspendShortcuts(on: boolean): Promise<void>;
  /** Runs app command `id` as its menu item would in this window: the editor had a key the menu
   * has too, and the menu wins. */
  runMenuCommand(id: string): Promise<void>;
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
  /** Searches the workspace's memos (spec 「워크스페이스 검색」), each file's matches handed to
   * `onEvent` as they come, then `done`. Settles when the search ends, which in the app may be
   * before the last events arrive (they come on a channel, not with the answer): what a search
   * found is read from its events. A newer `requestId` from this window cancels older ones.
   * `bad-request` when the pattern is not a valid regex. */
  searchWorkspace(
    query: SearchQuery,
    requestId: number,
    onEvent: (event: SearchEvent) => void,
  ): Promise<void>;
  /** Stops this window's running workspace search, as a newer one would. */
  cancelWorkspaceSearch(): Promise<void>;
  /** The update found in this run as it stands now (`current_update`), for the update button;
   * `null` before one is found. */
  currentUpdate(): Promise<UpdateOffer | null>;
  /** Downloads and installs the update this window was offered, telling `onProgress` how far it
   * is. Only ever after the person said so. The running app stays as it is until
   * `restartForUpdate`. `update-failed` says why it did not install; it can be tried again. */
  installUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void>;
  /** Writes every window, then starts the installed version. `busy` while another window closes,
   * switches or quits; `not-installed` when nothing was installed in this run. A restart the
   * person called off at the question about unsaved memos comes as `onRestartOff`. */
  restartForUpdate(): Promise<void>;
  /** The restart for the installed update is off: it starts with the next launch. Returns the
   * function that stops listening. */
  onRestartOff(handler: () => void): () => void;
  /** A timing mark for the performance measurement (tests/measure/perf.md); kept only when the
   * app runs with `TOTE_PERF=1`. Fire and forget. */
  perfMark(name: string): void;
  /** Whether marks are kept, and the workspace search a measurement run asks for once the window
   * is ready. */
  perfConfig(): Promise<PerfConfig>;
  /** The 「확장 설치」 dialog (.vsix / .zip); null when cancelled. */
  pickExtensionPackage(): Promise<string | null>;
  /** The folder dialog, opening at `start` when given. Without it the dialog starts where it was
   * last, from where a hidden folder such as `~/.tote` cannot be walked into. */
  pickFolder(start?: string): Promise<string | null>;
  /** Settings or the extension set changed somewhere (this window included). */
  onConfigChanged(handler: () => void): void;

  onMenu(handler: (id: string) => void): void;
  onFlush(handler: (id: number, goal: FlushGoal) => void): void;
  /** The close or switch this window wrote its tabs for is off (「취소」, the workspace could not
   * be opened, another window shows it): the window stays as it was. */
  onStay(handler: () => void): void;
  onPending(handler: () => void): void;
  onFileDrop(handler: (paths: string[]) => void): void;
  /** Another app changed this window's workspace or one of its watched external files. */
  onOutsideChange(handler: (change: OutsideChange) => void): void;
  /** Another window changed the memo list of this window's workspace. */
  onMemosChanged(handler: () => void): void;
  /** Another window asked for a tab this window holds: show it. */
  onReveal(handler: (tab: TabRef) => void): void;
  /** Another window of this workspace let its tab go on this one (`tearOffTab`): its session entry
   * as JSON, and where it was let go in this window, in CSS pixels from the top-left corner. The
   * tab's place is this window's already. Resolves once the handler listens: the native side sends
   * the tab from the moment the page has started (`workspaceInfo`), and does not keep it. */
  onAdopt(handler: (tab: string, x: number, y: number) => void): Promise<void>;
  /** A workspace was made, a window came to show another workspace, or the order or the hidden
   * ones changed: the switcher lists them again. */
  onWorkspacesChanged(handler: () => void): void;
  /** Whether the window is in macOS full screen: once as the page starts, then at each change. */
  onFullscreen(handler: (fullscreen: boolean) => void): void;
}
