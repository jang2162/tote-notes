import { basename, splitName } from "../core/names";
import { scanBytes } from "../viewer/large-text";
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
  type MemoInfo,
  type OutsideChange,
  type PendingOpen,
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
 * their base — and keeps everything in one JSON blob, so reloading the page acts as a restart. */

export const FAKE_STORAGE_KEY = "tote-fake";

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
  /** How many `listMemos` calls from now fail with `io`. Absent in old seeds. */
  failListMemos?: number;
  /** How many `writeMemo` calls from now fail with `io`, as on a full disk. Absent in old seeds. */
  failWrites?: number;
  /** Memo ID → its versions in the backups, in any order. `listVersions` lists them newest first
   * and does not compare neighbours: a seed lists only versions that differ. Absent in old seeds. */
  backups?: Record<string, { snapshot: string; file: string; text: string }[]>;
  /** `revealBackups` calls. Absent in old seeds. */
  revealed?: number;
  /** `backupNow` calls that went through. Absent in old seeds. */
  backedUp?: number;
  /** External path → how many `watchExternal` calls are not yet undone. Absent in old seeds. */
  watched?: Record<string, number>;
}

export interface FakeStorage {
  load(): string | null;
  save(text: string): void;
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
    workspace: { id: "workspace-1", name: "메모", path: "/fake/메모", deviceId: "device-1" },
    memos: {},
    session: null,
    files: {},
    drafts: {},
    pending: [],
    workspaces: [{ name: "메모", path: "/fake/메모", open: true, missing: false }],
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

export class FakeBackend implements Backend {
  data: FakeData;
  /** The base of each opened external file, held in memory like the Rust side does. */
  private bases: Record<string, string | null> = {};
  private readonly handlers = {
    menu: [] as ((id: string) => void)[],
    flush: [] as ((id: number) => void)[],
    pending: [] as (() => void)[],
    drop: [] as ((paths: string[]) => void)[],
    config: [] as (() => void)[],
    outside: [] as ((change: OutsideChange) => void)[],
  };

  constructor(private readonly storage: FakeStorage = memoryStorage()) {
    const saved = storage.load();
    this.data = saved ? (JSON.parse(saved) as FakeData) : defaultFakeData();
  }

  static fromSessionStorage(): FakeBackend {
    return new FakeBackend({
      load: () => sessionStorage.getItem(FAKE_STORAGE_KEY),
      save: (text) => sessionStorage.setItem(FAKE_STORAGE_KEY, text),
    });
  }

  // What tests do as the native side.

  menu(id: string): void {
    for (const handler of this.handlers.menu) handler(id);
  }
  config(): void {
    for (const handler of this.handlers.config) handler();
  }
  requestFlush(id: number): void {
    for (const handler of this.handlers.flush) handler(id);
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
    return this.add(this.freeName("untitled", "md"), true, new Uint8Array());
  }

  async readMemo(id: string) {
    const memo = this.memo(id);
    this.data.reads[id] = (this.data.reads[id] ?? 0) + 1;
    this.commit();
    return fromBase64(memo.data);
  }

  async writeMemo(id: string, bytes: Uint8Array) {
    if (this.data.failWrites) {
      this.data.failWrites -= 1;
      this.commit();
      throw new BackendError("io", "no space left on device");
    }
    const memo = this.memo(id);
    memo.data = toBase64(bytes);
    memo.modifiedMs = this.tick();
    this.commit();
    return this.info(id, memo);
  }

  async retitleMemo(id: string, stem: string) {
    const memo = this.memo(id);
    if (memo.autoTitle) {
      const { ext } = splitName(memo.file);
      if (!validName(ext ? `${stem}.${ext}` : stem)) throw new BackendError("invalid-name", stem);
      memo.file = this.freeName(stem, ext, id);
      this.commit();
    }
    return this.info(id, memo);
  }

  async renameMemo(id: string, name: string) {
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
    return this.info(id, memo);
  }

  async setMemoLanguage(id: string, language: string, ext: string) {
    const memo = this.memo(id);
    const { stem, ext: current } = splitName(memo.file);
    if (current.toLowerCase() !== ext.toLowerCase()) {
      if (!validName(`${stem}.${ext}`)) throw new BackendError("invalid-name", ext);
      memo.file = this.freeName(stem, ext, id);
    }
    memo.language = language;
    this.commit();
    return this.info(id, memo);
  }

  async deleteMemo(id: string) {
    this.memo(id);
    delete this.data.memos[id];
    this.commit();
  }

  async importMemo(fileName: string, bytes: Uint8Array) {
    if (!validName(fileName)) throw new BackendError("invalid-name", fileName);
    const { stem, ext } = splitName(fileName);
    return this.add(this.freeName(stem, ext), false, bytes);
  }

  async importFile(path: string) {
    const data = this.data.files[path];
    if (data === undefined) throw new BackendError("not-found", path);
    return this.importMemo(basename(path), fromBase64(data));
  }

  async readSession() {
    return this.data.session;
  }

  async writeSession(json: string) {
    this.data.session = json;
    this.commit();
  }

  async takePendingOpens() {
    const pending = this.data.pending;
    this.data.pending = [];
    this.commit();
    return pending;
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
    this.data.workspaces.push({ name, path: `/fake/${name}`, open: true, missing: false });
    this.commit();
  }

  async openWorkspace(path: string) {
    const workspace = this.data.workspaces.find((w) => w.path === path);
    if (workspace) workspace.open = true;
    this.commit();
  }

  async relocateWorkspace(from: string, to: string) {
    if (this.data.notWorkspaces.includes(to))
      throw new BackendError("not-a-workspace", `${to} is not a tote workspace`);
    this.data.relocations.push({ from, to });
    const item = this.data.workspaces.find((w) => w.path === from);
    if (item) Object.assign(item, { path: to, open: true, missing: false });
    this.commit();
  }

  async listVersions(id: string): Promise<Version[]> {
    const versions = [...(this.data.backups?.[id] ?? [])].sort((a, b) =>
      a.snapshot < b.snapshot ? 1 : a.snapshot > b.snapshot ? -1 : 0,
    );
    return Promise.all(
      versions.map(async ({ snapshot, file, text }) => {
        const size = new TextEncoder().encode(text).length;
        return { snapshot, file, size, sha256: await sha256(text) };
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

  async backupNow() {
    this.data.backedUp = (this.data.backedUp ?? 0) + 1;
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
  }

  async closeWindow() {
    this.data.windowClosed = true;
    this.commit();
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
    let pattern: RegExp;
    try {
      pattern = new RegExp(
        query.regex ? query.query : query.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        query.caseSensitive ? "g" : "gi",
      );
    } catch (error) {
      throw new BackendError("bad-request", String(error));
    }
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
  onFlush(handler: (id: number) => void) {
    this.handlers.flush.push(handler);
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

  private memo(id: string): FakeMemo {
    const memo = this.data.memos[id];
    if (!memo) throw new BackendError("unknown-memo", `no memo with id ${id}`);
    return memo;
  }

  private add(file: string, autoTitle: boolean, bytes: Uint8Array): MemoInfo {
    const id = crypto.randomUUID();
    this.data.memos[id] = { file, autoTitle, data: toBase64(bytes), modifiedMs: this.tick() };
    this.commit();
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
    this.storage.save(JSON.stringify(this.data));
  }
}
