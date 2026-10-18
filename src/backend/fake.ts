import { basename, splitName } from "../core/names";
import { parseSessionFile, type SessionTab } from "../core/session";
import { scanBytes } from "../viewer/large-text";
import { FakeHub, type HubEvent, type HubState } from "./fake-hub";
import fakeRegistry from "./fake-registry.json" with { type: "json" };
import {
  BackendError,
  type Backend,
  type ExtensionProblem,
  type ExtensionRegistry,
  type ExtensionSummary,
  type ExternalInfo,
  type FileKind,
  type FileSource,
  type FlushGoal,
  type MemoInfo,
  type OutsideChange,
  type PendingOpen,
  type TabRef,
  type SearchEvent,
  type SearchMatch,
  type SearchQuery,
  type Settings,
  type SettingsPatch,
  type TextMatch,
  type TextQuery,
  type Version,
  type ViewerInfo,
  type WindowFrame,
  type WorkspaceInfo,
  type WorkspaceListItem,
} from "./types";

/** An in-memory `Backend` for the browser preview and the UI tests. It follows the Rust side's
 * rules where the UI depends on them — APFS-style name collisions, `autoTitle`, drafts that keep
 * their base — and keeps everything in one JSON blob, so reloading the page acts as a restart.
 * With a `FakeHub` (a page opened as `?window=ws-<n>`) the pages of a browser context are the
 * windows of one workspace and share the blob. */

export const FAKE_STORAGE_KEY = "tote-fake";
/** The label of the window the page stands for, without a hub. */
export const FAKE_LABEL = "ws-1";

const placeKey = (tab: TabRef) => (tab.kind === "memo" ? `memo:${tab.id}` : `external:${tab.path}`);

export interface FakeMemo {
  file: string;
  autoTitle: boolean;
  language?: string;
  /** Contents, base64. */
  data: string;
  modifiedMs: number;
}

export interface FakeData {
  workspace: WorkspaceInfo;
  memos: Record<string, FakeMemo>;
  /** The whole session file, version 1 or 2; this window is its first window. */
  session: string | null;
  /** External files by absolute path, base64. */
  files: Record<string, string>;
  drafts: Record<string, { base: string | null; data: string }>;
  pending: PendingOpen[];
  workspaces: WorkspaceListItem[];
  /** What the next 「파일 열기」 dialog returns. */
  picks: string[];
  /** Every `relocateWorkspace` call, in order. */
  relocations: { from: string; to: string }[];
  /** Folders `relocateWorkspace` refuses with `not-a-workspace`. */
  notWorkspaces: string[];
  clock: number;
  /** `readMemo` calls per memo ID — lets tests check that a restore loads lazily. */
  reads: Record<string, number>;
  flushed: { id: number; blocked?: string }[];
  windowClosed: boolean;
  settings: Settings;
  /** Extensions the fake "installed"; they contribute nothing but a row in the list. */
  userExtensions: ExtensionSummary[];
  /** What `installExtension(path)` finds at a path: the manifest identity of the package. */
  packages: Record<
    string,
    { name: string; publisher: string; version: string; displayName?: string }
  >;
  /** `"<extension id>/<path>"` → file text. Missing entries are fetched from the dev server. */
  extensionFiles: Record<string, string>;
  /** Problems the fake registry reports besides the bundled ones' (none). Absent in old seeds. */
  problems?: ExtensionProblem[];
  /** Installs so far: each stamps its extension's `modified`, as a new folder would. */
  installs?: number;
  /** Viewers added to the bundled ones, each with the page that stands in for it — the UI tests
   * open file types through them that no bundled viewer opens yet. */
  extraViewers: { info: ViewerInfo; url: string }[];
  /** Owner → the names of the files issued to it and not yet revoked; tests check the
   * revocation. Names, not the data: URLs — a big file's would overflow sessionStorage. */
  tokens: Record<string, string[]>;
  /** `cancelTextSearch` calls; the fake's searches finish at once, so tests count the asks. */
  textSearchCancelled: number;
  /** Workspace searches stopped before they finished — by a newer one or by
   * `cancelWorkspaceSearch` — so tests can count them. Absent in old seeds. */
  workspaceSearchCancelled?: number;
  /** Every `searchWorkspace` call, in order. Absent in old seeds. */
  workspaceSearchCalls?: { query: SearchQuery; requestId: number }[];
  /** How long a workspace search waits before each memo, so a test can start another meanwhile;
   * without it each memo waits a microtask. Absent in old seeds. */
  searchDelayMs?: number;
  /** A workspace search checks for a cancel before it takes a memo, not after the wait: a memo
   * taken just before a newer search came is still searched and sent, as the app's threads do
   * with the file in hand. Absent in old seeds. */
  searchFinishesTakenMemo?: boolean;
  /** `file` events a workspace search sent after a newer one or a cancel had stopped it. Absent
   * in old seeds. */
  workspaceSearchLateFiles?: number;
  /** How many `listMemos` calls from now fail with `io`. Absent in old seeds. */
  failListMemos?: number;
  /** `listMemos` calls so far. Absent in old seeds. */
  listMemosCalls?: number;
  /** How many `writeMemo` calls from now fail with `io`, as on a full disk. Absent in old seeds. */
  failWrites?: number;
  /** Memo ID → its copies in the backups, in any order. `listVersions` lists them newest first and
   * folds a run of equal texts into one version. Absent in old seeds. */
  backups?: Record<string, { snapshot: string; file: string; text: string }[]>;
  /** `revealBackups` calls. Absent in old seeds. */
  revealed?: number;
  /** External path → how many `watchExternal` calls are not yet undone. Absent in old seeds. */
  watched?: Record<string, number>;
  /** The place registry: `memo:<id>` or `external:<path>` → the label of the window holding the
   * tab. This page is window `FAKE_LABEL`; a test seeds another label for a tab open elsewhere.
   * Absent in old seeds. */
  places?: Record<string, string>;
  /** The reveals `claimTabs` asked of other windows, in order. Absent in old seeds. */
  reveals?: { label: string; tab: TabRef }[];
  /** The tabs `tearOffTab` moved into new windows, in order. Absent in old seeds. */
  tornOff?: { tab: SessionTab }[];
  /** What a tab's context menu returns: the id of the item to pick, or null for none. */
  tabMenuPick?: string | null;
  /** Workspaces a switch fails to open once this window has written its tabs, as
   * `Workspace::open` failing in `prepare_switch`: the window stays and says so. Absent in old
   * seeds. */
  unopenable?: string[];
  /** The items of every tab context menu shown, in order. Absent in old seeds. */
  tabMenus?: { id: string; text: string }[][];
  /** The windows, with a hub (`FakeHub`). Absent without one. */
  hub?: HubState;
  /** The workspaces other than `workspace`, by path, each as `workspace`, `memos` and `session`
   * hold the current one: `switchWorkspace` trades the current one for one of these. Absent in old
   * seeds. */
  otherWorkspaces?: Record<
    string,
    { workspace: WorkspaceInfo; memos: Record<string, FakeMemo>; session: string | null }
  >;
  /** The workspace whose window `switchWorkspace` brought forward last, by path. */
  focusedWorkspace?: string;
  /** Timing marks are kept, as with `TOTE_PERF=1`; they go into `marks`. Absent in old seeds. */
  perf?: boolean;
  marks?: string[];
}

export interface FakeStorage {
  load(): string | null;
  save(text: string): void;
  /** Other pages write it too: it is read again before use. */
  shared?: boolean;
}

export function memoryStorage(initial: string | null = null): FakeStorage {
  let text = initial;
  return {
    load: () => text,
    save: (next) => {
      text = next;
    },
  };
}

export function defaultFakeData(): FakeData {
  return {
    workspace: {
      id: "workspace-1",
      name: "메모",
      title: "메모",
      path: "/fake/메모",
      deviceId: "device-1",
    },
    memos: {},
    session: null,
    files: {},
    drafts: {},
    pending: [],
    workspaces: [{ name: "메모", path: "/fake/메모", open: true, windows: 1, missing: false }],
    picks: [],
    relocations: [],
    notWorkspaces: [],
    clock: 1000,
    reads: {},
    flushed: [],
    windowClosed: false,
    settings: {
      workspaceRoot: null,
      theme: { light: null, dark: null },
      extensions: { disabled: [], precedence: "user" },
    },
    userExtensions: [],
    packages: {},
    extensionFiles: {},
    extraViewers: [],
    tokens: {},
    textSearchCancelled: 0,
  };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
}

/** Seed helpers for tests. */
export function fakeFile(contents: string | Uint8Array): string {
  return toBase64(typeof contents === "string" ? new TextEncoder().encode(contents) : contents);
}

export function fakeMemo(
  file: string,
  contents: string,
  options: { autoTitle?: boolean; modifiedMs?: number } = {},
): FakeMemo {
  return {
    file,
    autoTitle: options.autoTitle ?? false,
    data: fakeFile(contents),
    modifiedMs: options.modifiedMs ?? 1,
  };
}

// Mirrors kind_for in src-tauri/src/workspace/memo.rs.
const KINDS: Record<string, FileKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  avif: "image",
  mp4: "video",
  mov: "video",
  m4v: "video",
  webm: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  aac: "audio",
  flac: "audio",
  ogg: "audio",
  aiff: "audio",
  pdf: "document",
};
const kindOf = (name: string): FileKind => KINDS[splitName(name).ext.toLowerCase()] ?? "text";
/** APFS treats names equal after composition and case folding as one name. */
const sameName = (a: string, b: string) =>
  a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
/** Mirrors `is_valid_file_name` in src-tauri/src/workspace/names.rs. */
const validName = (name: string) =>
  name !== "" &&
  new TextEncoder().encode(name).length <= 255 &&
  name.trim() === name &&
  !name.startsWith(".") &&
  !/[/\\:*?"<>|]|\p{Cc}/u.test(name);
// What the tote-file scheme sends as Content-Type (`content_type` in src-tauri/src/files/range.rs,
// the part the media viewer plays); the fake hands the bytes over as data: URLs.
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};
const dataUrl = (name: string, data: string) =>
  `data:${MIME[splitName(name).ext.toLowerCase()] ?? "application/octet-stream"};base64,${data}`;

const decode = (data: string) => new TextDecoder().decode(fromBase64(data));

/** `query` as a JS regex, `bad-request` when it is not one. */
function searchPattern(query: TextQuery, flags: string): RegExp {
  try {
    return new RegExp(
      query.regex ? query.query : query.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      query.caseSensitive ? flags : `${flags}i`,
    );
  } catch (error) {
    throw new BackendError("bad-request", String(error));
  }
}

// The limits of src-tauri/src/search/mod.rs.
const SEARCH_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SEARCH_MAX_MATCHES = 2000;
const SEARCH_MAX_MATCHES_PER_FILE = 200;

export class FakeBackend implements Backend {
  private current: FakeData;
  /** The stored text `current` was read from or saved as: shared storage is read again only when
   * another page has changed it. */
  private stored: string | null;
  /** The base of each opened external file, held in memory like the Rust side does. */
  private bases: Record<string, string | null> = {};
  /** The number of the workspace search allowed to go on; 0 for none. */
  private liveWorkspaceSearch = 0;
  private readonly handlers = {
    menu: [] as ((id: string) => void)[],
    flush: [] as ((id: number, goal: FlushGoal) => void)[],
    stay: [] as (() => void)[],
    pending: [] as (() => void)[],
    drop: [] as ((paths: string[]) => void)[],
    config: [] as (() => void)[],
    outside: [] as ((change: OutsideChange) => void)[],
    memos: [] as (() => void)[],
    reveal: [] as ((tab: TabRef) => void)[],
    workspaces: [] as (() => void)[],
  };
  /** The fake's own flush rounds (`switchWorkspace`), waiting on this window's answer. */
  private readonly flushWaiters = new Map<number, (blocked: string | undefined) => void>();
  private flushRounds = 0;
  /** The window the page stands for. */
  private readonly label: string;
  /** Set as a switch reloads the page, as the native side marks the window (`page_started` in
   * src-tauri/src/app/mod.rs): the old page's last writes — its blur, its timers — must not land in
   * the workspace it is leaving for. */
  private switching = false;
  /** Runs once as the next window layout is written while a switch's flush round is open — the
   * round's last write — so a test can type while the round writes the tabs. A write of the
   * session's own timer before the round does not use it up. */
  whileWritingLayout: (() => void) | null = null;
  /** The switch's flush round is waiting for this window's answer (`flushThisWindow`). */
  private roundOpen = false;
  /** How long a switch waits after this window's answer before it swaps the workspace and reloads
   * the page: the gap between the round's answer and `switch_window` on the native side, where
   * writes are still taken. */
  switchDelayMs = 0;
  /** Set by a test to hold the next switch at the same place as `switchDelayMs` until it resolves
   * the promise. */
  switchGate: Promise<void> | null = null;
  /** Set by a test to hold the next `tearOffTab` until it resolves the promise. */
  tearOffGate: Promise<void> | null = null;
  /** Set by a test to answer `flushDone` as the native side does for a round its timeout already
   * settled while the window stays: the page takes its panes back. */
  staleFlush = false;

  constructor(
    private readonly storage: FakeStorage = memoryStorage(),
    private readonly hub: FakeHub | null = null,
  ) {
    this.stored = storage.load();
    this.current = this.stored ? (JSON.parse(this.stored) as FakeData) : defaultFakeData();
    this.label = hub?.label ?? FAKE_LABEL;
    if (!hub) return;
    hub.register(this.data);
    this.commit();
    hub.listen((event) => this.heard(event));
  }

  static fromSessionStorage(): FakeBackend {
    return new FakeBackend({
      load: () => sessionStorage.getItem(FAKE_STORAGE_KEY),
      save: (text) => sessionStorage.setItem(FAKE_STORAGE_KEY, text),
    });
  }

  /** The page of window `label` among the pages sharing `localStorage`. */
  static fromHub(label: string): FakeBackend {
    const storage: FakeStorage = {
      load: () => localStorage.getItem(FAKE_STORAGE_KEY),
      save: (text) => localStorage.setItem(FAKE_STORAGE_KEY, text),
      shared: true,
    };
    return new FakeBackend(storage, new FakeHub(label));
  }

  get data(): FakeData {
    if (this.storage.shared) {
      const text = this.storage.load();
      if (text !== null && text !== this.stored) {
        this.current = JSON.parse(text) as FakeData;
        this.stored = text;
      }
    }
    return this.current;
  }

  // What tests do as the native side.

  menu(id: string): void {
    // ⌥⌘N is the native side's own: it opens the window.
    if (id === "new-window" && this.hub) {
      this.hub.open(this.hub.openFresh(this.data));
      this.commit();
      return;
    }
    for (const handler of this.handlers.menu) handler(id);
  }
  /** What the native side does once this window is gone (with a hub). */
  closed(): void {
    this.hub?.closed(this.data);
    this.commit();
  }
  /** What the native side does as the app quits (with a hub): every window's layout stays. */
  quit(): void {
    this.hub?.quit(this.data);
    this.commit();
  }
  config(): void {
    for (const handler of this.handlers.config) handler();
  }
  requestFlush(id: number, goal: FlushGoal = "quit"): void {
    for (const handler of this.handlers.flush) handler(id, goal);
  }
  /** The close or switch this window wrote its tabs for is off, as `tote://stay` tells it. */
  stay(): void {
    for (const handler of this.handlers.stay) handler();
  }
  poke(): void {
    for (const handler of this.handlers.pending) handler();
  }
  /** A `tote` request that failed, as the native side queues it for this window. */
  notice(message: string): void {
    this.data.pending.push({ kind: "notice", message });
    this.commit();
    this.poke();
  }
  /** Another app changed something, as the watcher reports it. The test changes `data` first. */
  outside(change: OutsideChange): void {
    for (const handler of this.handlers.outside) handler(change);
  }
  /** Another window changed the memo list, as the native side tells this one. The test changes
   * `data` first. */
  memosChanged(): void {
    for (const handler of this.handlers.memos) handler();
  }
  /** Another window asked for a tab this one holds. */
  reveal(tab: TabRef): void {
    for (const handler of this.handlers.reveal) handler(tab);
  }
  /** A workspace was made, or a window came to show another one. */
  workspacesChanged(): void {
    for (const handler of this.handlers.workspaces) handler();
  }
  /** Another window's page told this one what the native side would. */
  private heard(event: HubEvent): void {
    if (event.type === "flush") this.requestFlush(event.id, event.goal);
    else if (event.type === "memos") this.memosChanged();
    else if (event.type === "reveal") this.reveal(event.tab);
    else if (event.type === "workspaces") this.workspacesChanged();
  }
  /** The memo list changed: the other windows read it again, as the native side tells them. */
  private memosTouched(): void {
    this.hub?.send(this.hub.siblings(this.data), { type: "memos" });
  }
  dropFiles(paths: string[]): void {
    for (const handler of this.handlers.drop) handler(paths);
  }
  memoText(id: string): string | null {
    const memo = this.data.memos[id];
    return memo ? decode(memo.data) : null;
  }
  memoTextByFile(file: string): string | null {
    const memo = Object.values(this.data.memos).find((m) => m.file === file);
    return memo ? decode(memo.data) : null;
  }
  fileText(path: string): string | null {
    const data = this.data.files[path];
    return data === undefined ? null : decode(data);
  }

  // Backend.

  async workspaceInfo() {
    return this.data.workspace;
  }

  async listMemos() {
    this.data.listMemosCalls = (this.data.listMemosCalls ?? 0) + 1;
    this.commit();
    if (this.data.failListMemos) {
      this.data.failListMemos -= 1;
      this.commit();
      throw new BackendError("io", "the workspace could not be read");
    }
    return Object.entries(this.data.memos)
      .map(([id, memo]) => this.info(id, memo))
      .sort(
        (a, b) => b.modifiedMs - a.modifiedMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
      );
  }

  async createMemo() {
    this.refuseWhileSwitching();
    return this.add(this.freeName("untitled", "md"), true, new Uint8Array());
  }

  async readMemo(id: string) {
    const memo = this.memo(id);
    this.data.reads[id] = (this.data.reads[id] ?? 0) + 1;
    this.commit();
    return fromBase64(memo.data);
  }

  async writeMemo(id: string, bytes: Uint8Array) {
    this.refuseWhileSwitching();
    if (this.data.failWrites) {
      this.data.failWrites -= 1;
      this.commit();
      throw new BackendError("io", "no space left on device");
    }
    const memo = this.memo(id);
    memo.data = toBase64(bytes);
    memo.modifiedMs = this.tick();
    this.commit();
    this.memosTouched();
    return this.info(id, memo);
  }

  async retitleMemo(id: string, stem: string) {
    this.refuseWhileSwitching();
    const memo = this.memo(id);
    if (memo.autoTitle) {
      const { ext } = splitName(memo.file);
      if (!validName(ext ? `${stem}.${ext}` : stem)) throw new BackendError("invalid-name", stem);
      memo.file = this.freeName(stem, ext, id);
      this.commit();
      this.memosTouched();
    }
    return this.info(id, memo);
  }

  async renameMemo(id: string, name: string) {
    this.refuseWhileSwitching();
    const memo = this.memo(id);
    const file = name.trim();
    if (!validName(file)) throw new BackendError("invalid-name", file);
    if (
      Object.entries(this.data.memos).some(([other, m]) => other !== id && sameName(m.file, file))
    ) {
      throw new BackendError("already-exists", file);
    }
    if (splitName(memo.file).ext.toLowerCase() !== splitName(file).ext.toLowerCase())
      delete memo.language;
    memo.file = file;
    memo.autoTitle = false;
    this.commit();
    this.memosTouched();
    return this.info(id, memo);
  }

  async setMemoLanguage(id: string, language: string, ext: string) {
    this.refuseWhileSwitching();
    const memo = this.memo(id);
    const { stem, ext: current } = splitName(memo.file);
    if (current.toLowerCase() !== ext.toLowerCase()) {
      if (!validName(`${stem}.${ext}`)) throw new BackendError("invalid-name", ext);
      memo.file = this.freeName(stem, ext, id);
    }
    memo.language = language;
    this.commit();
    this.memosTouched();
    return this.info(id, memo);
  }

  async deleteMemo(id: string) {
    this.refuseWhileSwitching();
    this.memo(id);
    delete this.data.memos[id];
    this.commit();
    this.memosTouched();
  }

  async importMemo(fileName: string, bytes: Uint8Array) {
    this.refuseWhileSwitching();
    if (!validName(fileName)) throw new BackendError("invalid-name", fileName);
    const { stem, ext } = splitName(fileName);
    return this.add(this.freeName(stem, ext), false, bytes);
  }

  async importFile(path: string) {
    const data = this.data.files[path];
    if (data === undefined) throw new BackendError("not-found", path);
    return this.importMemo(basename(path), fromBase64(data));
  }

  async readWindowLayout() {
    if (this.hub) {
      const layout = this.hub.layout(this.data);
      return layout === null ? null : JSON.stringify(layout);
    }
    const [window] = parseSessionFile(this.data.session).windows;
    return window ? JSON.stringify(window) : null;
  }

  async writeWindowLayout(json: string) {
    this.refuseWhileSwitching();
    if (this.roundOpen) {
      const typing = this.whileWritingLayout;
      this.whileWritingLayout = null;
      typing?.();
    }
    if (this.hub) this.hub.writeLayout(this.data, JSON.parse(json));
    else this.data.session = JSON.stringify({ version: 2, windows: [JSON.parse(json)] });
    this.commit();
  }

  async takePendingOpens() {
    const pending = this.data.pending;
    this.data.pending = [];
    this.commit();
    return pending;
  }

  async claimTabs(tabs: TabRef[], reveal: boolean) {
    this.refuseWhileSwitching();
    const places = (this.data.places ??= {});
    const claims = tabs.map((tab) => {
      const owner = places[placeKey(tab)];
      if (owner === undefined || owner === this.label) {
        places[placeKey(tab)] = this.label;
        return true;
      }
      if (reveal) {
        (this.data.reveals ??= []).push({ label: owner, tab });
        this.hub?.reveal(this.data, owner, tab);
      }
      return false;
    });
    this.commit();
    return claims;
  }

  async releaseTab(tab: TabRef) {
    if (this.switching) return;
    const places = this.data.places ?? {};
    if (places[placeKey(tab)] !== this.label) return;
    delete places[placeKey(tab)];
    this.commit();
  }

  async tearOffTab(tab: string, ref: TabRef) {
    this.refuseWhileSwitching();
    const gate = this.tearOffGate;
    this.tearOffGate = null;
    await gate;
    const entry: unknown = JSON.parse(tab);
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new BackendError("bad-request", "a tab is a JSON object");
    const places = (this.data.places ??= {});
    if (places[placeKey(ref)] !== this.label)
      throw new BackendError("io", `${this.label} does not hold the tab`);
    (this.data.tornOff ??= []).push({ tab: entry as SessionTab });
    if (this.hub) {
      const label = this.hub.adopt(this.data, entry, ref);
      this.commit();
      this.hub.open(label);
      return;
    }
    places[placeKey(ref)] = `ws-${this.data.tornOff.length + 1}`;
    this.commit();
  }

  async showTabMenu(items: { id: string; text: string }[]) {
    (this.data.tabMenus ??= []).push(items);
    this.commit();
    return this.data.tabMenuPick ?? null;
  }

  async openExternal(path: string): Promise<ExternalInfo> {
    const data = this.data.files[path];
    const draft = this.data.drafts[path];
    this.bases[path] = draft ? draft.base : (data ?? null);
    return {
      path,
      exists: data !== undefined,
      size: data === undefined ? 0 : fromBase64(data).length,
      kind: kindOf(path),
      draft: draft ? { diskChanged: draft.base !== (data ?? null) } : null,
    };
  }

  /** An open file without a draft takes what was read as its base, as the Rust side does. */
  async readExternal(path: string) {
    const data = this.data.files[path];
    if (path in this.bases && !this.data.drafts[path]) this.bases[path] = data ?? null;
    return data === undefined ? new Uint8Array() : fromBase64(data);
  }

  async readExternalDraft(path: string) {
    const draft = this.data.drafts[path];
    if (!draft) throw new BackendError("not-found", path);
    return fromBase64(draft.data);
  }

  async keepExternalDraft(path: string, bytes: Uint8Array) {
    const base = path in this.bases ? this.bases[path] : (this.data.files[path] ?? null);
    this.data.drafts[path] = { base, data: toBase64(bytes) };
    this.commit();
  }

  async discardExternalDraft(path: string) {
    delete this.data.drafts[path];
    this.commit();
  }

  async saveExternal(path: string, bytes: Uint8Array) {
    const data = toBase64(bytes);
    this.data.files[path] = data;
    delete this.data.drafts[path];
    this.bases[path] = data;
    this.commit();
  }

  async watchExternal(path: string) {
    const watched = (this.data.watched ??= {});
    watched[path] = (watched[path] ?? 0) + 1;
    this.commit();
  }

  async unwatchExternal(path: string) {
    const watched = (this.data.watched ??= {});
    if (!watched[path]) return;
    watched[path] -= 1;
    if (watched[path] === 0) delete watched[path];
    this.commit();
  }

  async listWorkspaces() {
    return this.data.workspaces;
  }

  async createWorkspace(name: string) {
    if (!validName(name)) throw new BackendError("invalid-name", name);
    if (this.data.workspaces.some((w) => sameName(w.name, name)))
      throw new BackendError("already-exists", name);
    const path = `/fake/${name}`;
    this.data.workspaces.push({ name, path, open: false, windows: 0, missing: false });
    (this.data.otherWorkspaces ??= {})[path] = {
      workspace: {
        id: `workspace-${name}`,
        name,
        title: name,
        path,
        deviceId: this.data.workspace.deviceId,
      },
      memos: {},
      session: null,
    };
    this.commit();
    return path;
  }

  /** The native side's switch (`windows::switch`, `lifecycle::switch_window`): a workspace a window
   * shows already comes forward and this window stays; any other is switched to after this
   * window writes its tabs, the current workspace taking its place among `otherWorkspaces`, and
   * the page reloads as the app's does. With a hub, whose windows share one workspace's memos,
   * the window only leaves it in the counts and tells the others; its page stays. */
  async switchWorkspace(path: string): Promise<"focused" | "switching"> {
    if (path === this.data.workspace.path) return "focused";
    const target = this.data.workspaces.find((w) => w.path === path);
    if (target && target.windows > 0) {
      this.data.focusedWorkspace = path;
      this.commit();
      return "focused";
    }
    const other = this.data.otherWorkspaces?.[path];
    if (!target || !other)
      throw new BackendError("not-a-workspace", `${path} is not a tote workspace`);
    // A tab that could not be written: the native side asks, and the fake takes 「취소」.
    if ((await this.flushThisWindow()) !== undefined) {
      this.stay();
      return "switching";
    }
    if (this.switchDelayMs) await new Promise((resolve) => setTimeout(resolve, this.switchDelayMs));
    const gate = this.switchGate;
    this.switchGate = null;
    await gate;
    if (this.data.unopenable?.includes(path)) {
      this.notice(`워크스페이스를 열지 못했습니다: ${path} cannot be opened`);
      this.stay();
      return "switching";
    }
    const data = this.data;
    const left = data.workspaces.find((w) => w.path === data.workspace.path);
    if (left) Object.assign(left, { windows: left.windows - 1, open: left.windows > 1 });
    Object.assign(target, { windows: target.windows + 1, open: true });
    if (this.hub) {
      this.commit();
      this.hub.send(this.hub.siblings(data), { type: "workspaces" });
      return "switching";
    }
    const others = (data.otherWorkspaces ??= {});
    others[data.workspace.path] = {
      workspace: data.workspace,
      memos: data.memos,
      session: data.session,
    };
    delete others[path];
    Object.assign(data, { workspace: other.workspace, memos: other.memos, session: other.session });
    data.pending = [];
    const places = data.places ?? {};
    for (const [key, owner] of Object.entries(places)) if (owner === this.label) delete places[key];
    this.commit();
    this.switching = true;
    location.reload();
    return "switching";
  }

  private refuseWhileSwitching(): void {
    if (this.switching)
      throw new BackendError("bad-request", `${this.label} is switching workspaces`);
  }

  /** Asks this window to write everything (`onFlush`) and waits for its answer. */
  private flushThisWindow(): Promise<string | undefined> {
    // Apart from the ids tests hand `requestFlush`.
    const id = 1_000_000 + ++this.flushRounds;
    const answered = new Promise<string | undefined>((resolve) =>
      this.flushWaiters.set(id, resolve),
    );
    this.roundOpen = true;
    this.requestFlush(id, "switch");
    return answered.finally(() => {
      this.roundOpen = false;
    });
  }

  async openWorkspace(path: string) {
    const workspace = this.data.workspaces.find((w) => w.path === path);
    if (workspace && !workspace.open) Object.assign(workspace, { open: true, windows: 1 });
    this.commit();
  }

  async relocateWorkspace(from: string, to: string) {
    if (this.data.notWorkspaces.includes(to))
      throw new BackendError("not-a-workspace", `${to} is not a tote workspace`);
    this.data.relocations.push({ from, to });
    const item = this.data.workspaces.find((w) => w.path === from);
    if (item) Object.assign(item, { path: to, open: true, windows: 1, missing: false });
    this.commit();
  }

  async listVersions(id: string): Promise<Version[]> {
    const copies = [...(this.data.backups?.[id] ?? [])].sort((a, b) =>
      a.snapshot < b.snapshot ? 1 : a.snapshot > b.snapshot ? -1 : 0,
    );
    const runs: { snapshot: string; until: string; file: string; text: string }[] = [];
    for (const copy of copies) {
      const run = runs.at(-1);
      if (run && run.text === copy.text) {
        run.snapshot = copy.snapshot;
        run.file = copy.file;
      } else {
        runs.push({ ...copy, until: copy.snapshot });
      }
    }
    return Promise.all(
      runs.map(async ({ snapshot, until, file, text }) => {
        const size = new TextEncoder().encode(text).length;
        return { snapshot, until, file, size, sha256: await sha256(text) };
      }),
    );
  }

  async readVersion(snapshot: string, file: string) {
    const version = Object.values(this.data.backups ?? {})
      .flat()
      .find((v) => v.snapshot === snapshot && v.file === file);
    if (!version) throw new BackendError("not-found", `${snapshot}/${file}`);
    return new TextEncoder().encode(version.text);
  }

  async revealBackups() {
    this.data.revealed = (this.data.revealed ?? 0) + 1;
    this.commit();
  }

  async windowFrame(): Promise<WindowFrame | null> {
    return null;
  }

  async pickFiles() {
    const picks = this.data.picks;
    this.data.picks = [];
    this.commit();
    return picks;
  }

  async flushDone(id: number, blocked?: string) {
    this.data.flushed.push(blocked === undefined ? { id } : { id, blocked });
    this.commit();
    this.flushWaiters.get(id)?.(blocked);
    this.flushWaiters.delete(id);
    return !this.staleFlush;
  }

  async closeWindow() {
    this.data.windowClosed = true;
    this.commit();
    if (!this.hub) return;
    this.closed();
    window.close();
  }

  async extensionRegistry(): Promise<ExtensionRegistry> {
    // Bundled extensions cannot be switched off, as in the real registry.
    const bundled = fakeRegistry as ExtensionRegistry;
    const user = this.data.userExtensions.map((e) => ({
      ...e,
      enabled: !this.data.settings.extensions.disabled.includes(e.id),
    }));
    return {
      ...bundled,
      extensions: [...bundled.extensions, ...user],
      problems: [...bundled.problems, ...(this.data.problems ?? [])],
      viewers: [...bundled.viewers, ...this.data.extraViewers.map((v) => v.info)],
    };
  }

  async readExtensionFile(extensionId: string, path: string) {
    const text = this.data.extensionFiles[`${extensionId}/${path}`];
    if (text !== undefined) return new TextEncoder().encode(text);
    if (typeof fetch !== "function" || typeof location === "undefined")
      throw new BackendError("not-found", `${extensionId}/${path}`);
    const response = await fetch(this.viewerUrl(extensionId, path));
    if (!response.ok) throw new BackendError("not-found", `${extensionId}/${path}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async installExtension(path: string, replace: boolean) {
    const pkg = this.data.packages[path];
    if (!pkg) throw new BackendError("invalid-extension", path);
    const id = `${pkg.publisher}.${pkg.name}`;
    const existing = this.data.userExtensions.find((e) => e.id === id);
    if (existing && !replace)
      throw new BackendError("already-installed", `${id} ${existing.version}`);
    this.data.userExtensions = this.data.userExtensions.filter((e) => e.id !== id);
    const summary: ExtensionSummary = {
      id,
      version: pkg.version,
      displayName: pkg.displayName ?? pkg.name,
      source: "user",
      enabled: true,
      path: `/fake/extensions/${id}@${pkg.version}`,
      modified: (this.data.installs = (this.data.installs ?? 0) + 1),
    };
    this.data.userExtensions.push(summary);
    this.commit();
    this.config();
    return summary;
  }

  async removeExtension(id: string) {
    if (!this.data.userExtensions.some((e) => e.id === id)) throw new BackendError("not-found", id);
    this.data.userExtensions = this.data.userExtensions.filter((e) => e.id !== id);
    this.data.settings.extensions.disabled = this.data.settings.extensions.disabled.filter(
      (d) => d !== id,
    );
    this.commit();
    this.config();
  }

  async setExtensionEnabled(id: string, enabled: boolean) {
    const disabled = this.data.settings.extensions.disabled.filter((d) => d !== id);
    if (!enabled) disabled.push(id);
    this.data.settings.extensions.disabled = disabled;
    this.commit();
    this.config();
  }

  async settings() {
    return structuredClone(this.data.settings);
  }

  async patchSettings(patch: SettingsPatch) {
    const settings = this.data.settings;
    // `undefined` is what JSON leaves out on the way to Rust: such a field is kept.
    if (patch.workspaceRoot !== undefined) settings.workspaceRoot = patch.workspaceRoot;
    if (patch.themeLight !== undefined) settings.theme.light = structuredClone(patch.themeLight);
    if (patch.themeDark !== undefined) settings.theme.dark = structuredClone(patch.themeDark);
    if (patch.precedence !== undefined) settings.extensions.precedence = patch.precedence;
    this.commit();
    this.config();
  }

  viewerUrl(extensionId: string, entry: string) {
    const extra = this.data.extraViewers.find(
      (v) => v.info.extension === extensionId && v.info.entry === entry,
    );
    return extra?.url ?? `/extensions/${encodeURIComponent(extensionId)}/${entry}`;
  }

  private sourceBytes(source: FileSource): {
    name: string;
    data: string;
    folder: Record<string, string>;
    dirKey: (name: string) => string;
  } | null {
    if (source.kind === "memo") {
      const memo = this.data.memos[source.id];
      if (!memo) return null;
      const folder: Record<string, string> = {};
      for (const m of Object.values(this.data.memos)) folder[m.file] = m.data;
      return { name: memo.file, data: memo.data, folder, dirKey: (n) => n };
    }
    const data = this.data.files[source.path];
    if (data === undefined) return null;
    const dir = source.path.slice(0, source.path.lastIndexOf("/") + 1);
    return { name: basename(source.path), data, folder: this.data.files, dirKey: (n) => dir + n };
  }

  async issueFileToken(source: FileSource, owner: string) {
    const found = this.sourceBytes(source);
    if (!found) throw new BackendError("not-found", JSON.stringify(source));
    return this.issue(owner, found.name, found.data);
  }

  async revokeFileTokens(owner: string) {
    delete this.data.tokens[owner];
    this.commit();
  }

  async resolveRelative(source: FileSource, relative: string, owner: string) {
    const name = relative.startsWith("./") ? relative.slice(2) : relative;
    if (!name || name.includes("/") || name === "..") return null;
    const found = this.sourceBytes(source);
    const data = found?.folder[found.dirKey(name)];
    if (data === undefined) return null;
    return this.issue(owner, name, data);
  }

  async scanText(source: FileSource) {
    const found = this.sourceBytes(source);
    if (!found) throw new BackendError("not-found", JSON.stringify(source));
    return scanBytes(fromBase64(found.data));
  }

  async searchText(source: FileSource, query: TextQuery, fromLine: number, _requestId: number) {
    const found = this.sourceBytes(source);
    if (!found) throw new BackendError("not-found", JSON.stringify(source));
    const lines = new TextDecoder().decode(fromBase64(found.data)).split("\n");
    const pattern = searchPattern(query, "g");
    const matches: TextMatch[] = [];
    if (query.query) {
      for (let line = fromLine; line < lines.length; line++) {
        for (const m of lines[line].replace(/\r$/, "").matchAll(pattern)) {
          matches.push({
            line,
            column: new TextEncoder().encode(lines[line].slice(0, m.index)).length,
          });
          if (matches.length >= 200) return { matches, done: false, cancelled: false };
        }
      }
    }
    return { matches, done: true, cancelled: false };
  }

  async cancelTextSearch() {
    this.data.textSearchCancelled++;
    this.commit();
  }

  /** As `search_workspace` does, one memo after another in seed order: a newer `requestId` or
   * `cancelWorkspaceSearch` stops it before its next memo, the same limits truncate it, and
   * context lines follow the searcher's rule — a line between two close matches is only in the
   * earlier one's `after`. Lines are not cut to 160 characters. */
  async searchWorkspace(
    query: SearchQuery,
    requestId: number,
    onEvent: (event: SearchEvent) => void,
  ): Promise<void> {
    (this.data.workspaceSearchCalls ??= []).push({ query, requestId });
    this.commit();
    // Before the pattern is checked, as in Rust: even a bad one cancels the search before it.
    this.liveWorkspaceSearch = requestId;
    const pattern = searchPattern(query, "");
    let searched = 0;
    let total = 0;
    let truncated = false;
    let cancelled = false;
    const stopped = () => {
      if (this.liveWorkspaceSearch === requestId) return false;
      cancelled = true;
      this.data.workspaceSearchCancelled = (this.data.workspaceSearchCancelled ?? 0) + 1;
      this.commit();
      return true;
    };
    const takeFirst = this.data.searchFinishesTakenMemo === true;
    for (const [memoId, memo] of query.query ? Object.entries(this.data.memos) : []) {
      if (takeFirst && stopped()) break;
      await (this.data.searchDelayMs
        ? new Promise((resolve) => setTimeout(resolve, this.data.searchDelayMs))
        : new Promise<void>((resolve) => queueMicrotask(resolve)));
      if (!takeFirst && stopped()) break;
      const bytes = fromBase64(memo.data);
      if (bytes.length > SEARCH_MAX_FILE_BYTES || bytes.subarray(0, 8192).includes(0)) continue;
      searched++;
      const lines = new TextDecoder().decode(bytes).split("\n");
      const matches: SearchMatch[] = [];
      // The last line already sent, as a match or as context.
      let sent = -1;
      for (let line = 0; line < lines.length; line++) {
        const text = lines[line].replace(/\r$/, "");
        const found = pattern.exec(text);
        const last = matches.at(-1);
        if (!found) {
          if (last && last.line === line - 1) {
            last.after.push(text);
            sent = line;
          }
          continue;
        }
        if (matches.length === SEARCH_MAX_MATCHES_PER_FILE || total === SEARCH_MAX_MATCHES) {
          truncated = true;
          break;
        }
        total++;
        const before = line > 0 && line - 1 > sent ? [lines[line - 1].replace(/\r$/, "")] : [];
        matches.push({
          line,
          // Characters, as Rust counts them — not UTF-16 units.
          column: Array.from(text.slice(0, found.index)).length,
          text,
          before,
          after: [],
        });
        sent = line;
      }
      if (matches.length) {
        if (this.liveWorkspaceSearch !== requestId) {
          this.data.workspaceSearchLateFiles = (this.data.workspaceSearchLateFiles ?? 0) + 1;
          this.commit();
        }
        onEvent({ kind: "file", memoId, file: memo.file, matches });
      }
      // A match past the search's limit ends it; one past a file's only ends the file.
      if (total === SEARCH_MAX_MATCHES && truncated) break;
    }
    onEvent({ kind: "done", filesSearched: searched, truncated, cancelled });
  }

  async cancelWorkspaceSearch() {
    // 0 is no search's number: the running one stops before its next memo and counts itself.
    this.liveWorkspaceSearch = 0;
  }

  /** The measurement runs against the app only; a test that turns `perf` on sees the marks. */
  perfMark(name: string) {
    if (!this.data.perf) return;
    (this.data.marks ??= []).push(name);
    this.commit();
  }

  async perfConfig() {
    return { enabled: this.data.perf ?? false, search: null };
  }

  private issue(owner: string, name: string, data: string): string {
    (this.data.tokens[owner] ??= []).push(name);
    this.commit();
    return dataUrl(name, data);
  }

  async pickExtensionPackage() {
    const picked = this.data.picks.shift() ?? null;
    this.commit();
    return picked;
  }

  async pickFolder() {
    const picked = this.data.picks.shift() ?? null;
    this.commit();
    return picked;
  }

  onConfigChanged(handler: () => void) {
    this.handlers.config.push(handler);
  }

  onMenu(handler: (id: string) => void) {
    this.handlers.menu.push(handler);
  }
  onFlush(handler: (id: number, goal: FlushGoal) => void) {
    this.handlers.flush.push(handler);
  }
  onStay(handler: () => void) {
    this.handlers.stay.push(handler);
  }
  onPending(handler: () => void) {
    this.handlers.pending.push(handler);
  }
  onFileDrop(handler: (paths: string[]) => void) {
    this.handlers.drop.push(handler);
  }
  onOutsideChange(handler: (change: OutsideChange) => void) {
    this.handlers.outside.push(handler);
  }
  onMemosChanged(handler: () => void) {
    this.handlers.memos.push(handler);
  }
  onReveal(handler: (tab: TabRef) => void) {
    this.handlers.reveal.push(handler);
  }
  onWorkspacesChanged(handler: () => void) {
    this.handlers.workspaces.push(handler);
  }

  private memo(id: string): FakeMemo {
    const memo = this.data.memos[id];
    if (!memo) throw new BackendError("unknown-memo", `no memo with id ${id}`);
    return memo;
  }

  private add(file: string, autoTitle: boolean, bytes: Uint8Array): MemoInfo {
    const id = crypto.randomUUID();
    this.data.memos[id] = { file, autoTitle, data: toBase64(bytes), modifiedMs: this.tick() };
    this.commit();
    this.memosTouched();
    return this.info(id, this.data.memos[id]);
  }

  private info(id: string, memo: FakeMemo): MemoInfo {
    return {
      id,
      file: memo.file,
      autoTitle: memo.autoTitle,
      modifiedMs: memo.modifiedMs,
      size: fromBase64(memo.data).length,
      kind: kindOf(memo.file),
      ...(memo.language ? { language: memo.language } : {}),
    };
  }

  /** Mirrors `unique_file_name`: `stem.ext`, `stem 2.ext`, … skipping names another memo has. */
  private freeName(stem: string, ext: string, own?: string): string {
    const join = (s: string) => (ext ? `${s}.${ext}` : s);
    const taken = (name: string) =>
      Object.entries(this.data.memos).some(([id, memo]) => id !== own && sameName(memo.file, name));
    let candidate = join(stem);
    for (let n = 2; taken(candidate); n++) candidate = join(`${stem} ${n}`);
    return candidate;
  }

  private tick(): number {
    this.data.clock += 1;
    return this.data.clock;
  }

  private commit(): void {
    this.stored = JSON.stringify(this.current);
    this.storage.save(this.stored);
  }
}
