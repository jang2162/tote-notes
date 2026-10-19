import { EditorSelection, type Text } from "@codemirror/state";

import type { Axis } from "../app/layout";
import type { WindowFrame } from "../backend/types";

/** The windows of one workspace on one device, `.tote/sessions/<device ID>.json` (spec 「세션」),
 * oldest-opened first. The backend gathers it from each window's layout and reads `frame` before
 * the window exists. Version 1 held one window as `{ version: 1, window?, activeTab, tabs }`. */
export interface SessionFile {
  version: 2;
  windows: WindowSession[];
}

/** One window's layout, which the window writes and reads through the backend. */
export interface WindowSession {
  /** Outer position and inner size in logical pixels. */
  frame?: WindowFrame;
  layout: SessionNode;
  /** Index of the focused pane among the panes read depth first. */
  focusedPane: number;
}

export interface PaneSession {
  tabs: SessionTab[];
  /** Index into `tabs`; 0 when the active tab was dropped or unset, -1 only when no tab is left. */
  activeTab: number;
}

export interface SessionSplit {
  axis: Axis;
  /** At least two. */
  children: SessionNode[];
  /** One share of the branch's extent per child, summing to 1. */
  shares: number[];
}

export type SessionNode = PaneSession | SessionSplit;

export function isSessionPane(node: SessionNode): node is PaneSession {
  return Array.isArray((node as PaneSession).tabs);
}

/** The panes of `node`, depth first. */
export function sessionPanes(node: SessionNode): PaneSession[] {
  return isSessionPane(node) ? [node] : node.children.flatMap(sessionPanes);
}

/** `EditorSelection.toJSON()`. */
export interface SelectionJSON {
  ranges: { anchor: number; head: number }[];
  main: number;
}

export type ViewMode = "edit" | "preview";

interface TabPlace {
  selection?: SelectionJSON;
  /** Document position at the top of the viewport. */
  scrollAnchor?: number;
  /** Edit or preview (spec 「세션」); left out when editing. */
  mode?: ViewMode;
  /** Memo tabs only: the tab holds 「내 버전」 of a conflict left open, and `memoId` is the memo
   * that kept the other app's text. The banner stays until the person closes it. */
  conflictKept?: { memoId: string };
}

export type SessionTab =
  | ({ kind: "memo"; memoId: string } & TabPlace)
  /** `language`: the language chosen in the status bar; a memo keeps it in index.json instead. */
  | ({ kind: "external"; deviceId: string; path: string; language?: string } & TabPlace);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPosition = (value: unknown): value is number => Number.isInteger(value);

/** Reads a session file leniently: a window, pane or tab that does not parse is dropped, not the
 * whole session. A version 1 file is one window with one pane. */
export function parseSessionFile(text: string | null): SessionFile {
  const file: SessionFile = { version: 2, windows: [] };
  let raw: unknown = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    return file;
  }
  if (!isObject(raw)) return file;
  if (Array.isArray(raw.windows)) {
    file.windows = raw.windows.filter(isObject).map(parseWindowSession);
  } else if (Array.isArray(raw.tabs)) {
    const pane = { tabs: raw.tabs, activeTab: raw.activeTab };
    file.windows = [parseWindowSession({ frame: raw.window, layout: pane, focusedPane: 0 })];
  }
  return file;
}

/** Lenient: a tab that does not parse is dropped; at least one pane. The layout is read as a tree,
 * or as the row of `panes` with `width`s that windows wrote before panes could be stacked. */
export function parseWindowSession(value: unknown): WindowSession {
  const raw = isObject(value) ? value : {};
  const layout = isObject(raw.layout) ? parseNode(raw.layout) : parseOldPanes(raw.panes);
  const focused = raw.focusedPane;
  const window: WindowSession = {
    layout,
    focusedPane:
      isPosition(focused) && focused >= 0 && focused < sessionPanes(layout).length ? focused : 0,
  };
  const frame = parseFrame(raw.frame);
  if (frame) window.frame = frame;
  return window;
}

function parseOldPanes(value: unknown): SessionNode {
  const raw = (Array.isArray(value) ? value : []).filter(isObject);
  if (raw.length === 0) return parsePane({});
  if (raw.length === 1) return parsePane(raw[0]);
  return {
    axis: "row",
    children: raw.map(parsePane),
    shares: normalizeWidths(raw.map((pane) => (isNumber(pane.width) ? pane.width : Number.NaN))),
  };
}

/** A pane, or a branch whose children are read the same way. A branch that cannot be laid out
 * keeps all the tabs it holds in one pane. */
function parseNode(raw: Json): SessionNode {
  if (Array.isArray(raw.tabs)) return parsePane(raw);
  const children = Array.isArray(raw.children) ? raw.children : [];
  if ((raw.axis !== "row" && raw.axis !== "column") || children.length === 0) {
    return parsePane({ tabs: tabsOf(raw), activeTab: 0 });
  }
  const shares =
    Array.isArray(raw.shares) && raw.shares.length === children.length ? raw.shares : [];
  const kept = children
    .map((child: unknown, index: number) => ({ child, share: shares[index] }))
    .filter((entry): entry is { child: Json; share: unknown } => isObject(entry.child));
  if (kept.length === 0) return parsePane({});
  if (kept.length === 1) return parseNode(kept[0].child);
  return {
    axis: raw.axis,
    children: kept.map(({ child }) => parseNode(child)),
    shares: normalizeWidths(kept.map(({ share }) => (isNumber(share) ? share : Number.NaN))),
  };
}

/** Every tab listed under `raw`, depth first, as written. */
function tabsOf(raw: Json): unknown[] {
  if (Array.isArray(raw.tabs)) return raw.tabs;
  return (Array.isArray(raw.children) ? raw.children : []).filter(isObject).flatMap(tabsOf);
}

/** Shares that sum to 1: `widths` over their sum, or equal shares when any of them is not a
 * positive number (a pane of no width could not be seen). */
export function normalizeWidths(widths: number[]): number[] {
  if (widths.some((width) => !isNumber(width) || width <= 0))
    return widths.map(() => 1 / widths.length);
  const sum = widths.reduce((total, width) => total + width, 0);
  return widths.map((width) => width / sum);
}

export function parsePane(raw: Json): PaneSession {
  const pane: PaneSession = { tabs: [], activeTab: -1 };
  if (!Array.isArray(raw.tabs)) return pane;
  const active = raw.activeTab;
  raw.tabs.forEach((value: unknown, index: number) => {
    const tab = parseTab(value);
    if (!tab) return;
    if (index === active) pane.activeTab = pane.tabs.length;
    pane.tabs.push(tab);
  });
  if (pane.activeTab < 0 && pane.tabs.length > 0) pane.activeTab = 0;
  return pane;
}

/** A session tab as `sessionTab` writes it — one window's tab handed to another, too — or null
 * for one that does not parse. */
export function parseTab(value: unknown): SessionTab | null {
  if (!isObject(value)) return null;
  const place: TabPlace = {};
  const selection = parseSelection(value.selection);
  if (selection) place.selection = selection;
  if (isNumber(value.scrollAnchor)) place.scrollAnchor = value.scrollAnchor;
  if (value.mode === "preview") place.mode = "preview";
  if (value.kind === "memo" && typeof value.memoId === "string") {
    if (isObject(value.conflictKept) && typeof value.conflictKept.memoId === "string") {
      place.conflictKept = { memoId: value.conflictKept.memoId };
    }
    return { kind: "memo", memoId: value.memoId, ...place };
  }
  if (
    value.kind === "external" &&
    typeof value.deviceId === "string" &&
    typeof value.path === "string"
  ) {
    const tab: SessionTab = {
      kind: "external",
      deviceId: value.deviceId,
      path: value.path,
      ...place,
    };
    if (typeof value.language === "string") tab.language = value.language;
    return tab;
  }
  return null;
}

function parseSelection(value: unknown): SelectionJSON | undefined {
  if (!isObject(value) || !Array.isArray(value.ranges)) return undefined;
  const ranges: SelectionJSON["ranges"] = [];
  let main = 0;
  value.ranges.forEach((r: unknown, index: number) => {
    if (!isObject(r) || !isPosition(r.anchor) || !isPosition(r.head)) return;
    // `main` indexes the original array; follow it through the ranges that were dropped.
    if (index === value.main) main = ranges.length;
    ranges.push({ anchor: r.anchor, head: r.head });
  });
  return ranges.length === 0 ? undefined : { ranges, main };
}

function parseFrame(value: unknown): WindowFrame | undefined {
  if (!isObject(value)) return undefined;
  const { x, y, width, height } = value;
  return isNumber(x) && isNumber(y) && isNumber(width) && isNumber(height)
    ? { x, y, width, height }
    : undefined;
}

/** `json` fitted to `doc`: positions past its end (the file shrank since) are pulled in. */
export function restoreSelection(json: SelectionJSON | undefined, doc: Text): EditorSelection {
  if (!json || json.ranges.length === 0) return EditorSelection.single(0);
  const clamp = (pos: number) => Math.max(0, Math.min(doc.length, pos));
  const ranges = json.ranges.map((r) => EditorSelection.range(clamp(r.anchor), clamp(r.head)));
  const main = json.main >= 0 && json.main < ranges.length ? json.main : 0;
  return EditorSelection.create(ranges, main);
}
