import { EditorSelection, type Text } from "@codemirror/state";

import type { WindowFrame } from "../backend/types";

/** One workspace window on one device, `.tote/sessions/<device ID>.json` (spec 「세션」). The
 * backend only checks that it is a JSON object and reads `window` before the window exists. */
export interface SessionFile {
  version: 1;
  /** Outer position and inner size in logical pixels. */
  window?: WindowFrame;
  /** Index into `tabs`; 0 when the active tab was dropped or unset, -1 only when no tab is left. */
  activeTab: number;
  tabs: SessionTab[];
}

/** `EditorSelection.toJSON()`. */
export interface SelectionJSON {
  ranges: { anchor: number; head: number }[];
  main: number;
}

interface TabPlace {
  selection?: SelectionJSON;
  /** Document position at the top of the viewport. */
  scrollAnchor?: number;
}

export type SessionTab =
  | ({ kind: "memo"; memoId: string } & TabPlace)
  | ({ kind: "external"; deviceId: string; path: string } & TabPlace);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPosition = (value: unknown): value is number => Number.isInteger(value);

/** Reads a session leniently: a tab that does not parse is dropped, not the whole session. */
export function parseSession(text: string | null): SessionFile {
  const session: SessionFile = { version: 1, activeTab: -1, tabs: [] };
  let raw: unknown = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    return session;
  }
  if (!isObject(raw) || !Array.isArray(raw.tabs)) return session;
  const active = raw.activeTab;
  raw.tabs.forEach((value: unknown, index: number) => {
    const tab = parseTab(value);
    if (!tab) return;
    if (index === active) session.activeTab = session.tabs.length;
    session.tabs.push(tab);
  });
  if (session.activeTab < 0 && session.tabs.length > 0) session.activeTab = 0;
  const frame = parseFrame(raw.window);
  if (frame) session.window = frame;
  return session;
}

function parseTab(value: unknown): SessionTab | null {
  if (!isObject(value)) return null;
  const place: TabPlace = {};
  const selection = parseSelection(value.selection);
  if (selection) place.selection = selection;
  if (isNumber(value.scrollAnchor)) place.scrollAnchor = value.scrollAnchor;
  if (value.kind === "memo" && typeof value.memoId === "string") {
    return { kind: "memo", memoId: value.memoId, ...place };
  }
  if (
    value.kind === "external" &&
    typeof value.deviceId === "string" &&
    typeof value.path === "string"
  ) {
    return { kind: "external", deviceId: value.deviceId, path: value.path, ...place };
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
