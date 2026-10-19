import { parseSessionFile } from "../core/session";
import type { FakeData } from "./fake";
import type { FlushGoal, TabRef } from "./types";

/** Windows for the fake backend: the pages of one browser context stand for the app's windows on
 * one workspace. They share the fake's data through `localStorage` and hear what the native side
 * would tell them on a `BroadcastChannel`; each page is the window its URL names
 * (`?window=ws-<n>`), and a new window is a page it opens. The bookkeeping follows the Rust side's
 * rules (src-tauri/src/app/mod.rs): the session file holds the open windows' layouts in opening
 * order, a window closing drops its layout unless it is the last, and a quit keeps them all. */

export const HUB_CHANNEL = "tote-fake";

/** What the native side tells a window, sent by another window's page. */
export type HubEvent =
  | { type: "flush"; id: number; goal: FlushGoal }
  | { type: "memos" }
  | { type: "reveal"; tab: TabRef }
  | { type: "adopt"; tab: string; x: number; y: number }
  | { type: "workspaces" };

interface HubMessage {
  to: string[];
  event: HubEvent;
}

/** The windows part of `FakeData`. */
export interface HubState {
  /** The open windows in opening order, each with the layout it wrote last, else the one it opened
   * with. */
  windows: { label: string; layout: unknown }[];
  /** The number of the last label handed out. */
  labels: number;
  /** The window a reveal brought forward last. */
  focused: string | null;
}

const placeKey = (tab: TabRef) => (tab.kind === "memo" ? `memo:${tab.id}` : `external:${tab.path}`);

export class FakeHub {
  private readonly channel = new BroadcastChannel(HUB_CHANNEL);

  constructor(readonly label: string) {}

  /** Hands the events sent to this window to `handler`. */
  listen(handler: (event: HubEvent) => void): void {
    this.channel.onmessage = (message: MessageEvent<HubMessage>) => {
      if (message.data.to.includes(this.label)) handler(message.data.event);
    };
  }

  send(to: string[], event: HubEvent): void {
    if (to.length) this.channel.postMessage({ to, event } satisfies HubMessage);
  }

  /** The page has started. A window the hub knows — made by `adopt` or `openFresh`, or a page
   * loaded again — keeps its layout; any other is reopened from the next layout of the session
   * file, as at launch. */
  register(data: FakeData): void {
    const hub = state(data);
    hub.labels = Math.max(hub.labels, Number(this.label.replace(/^ws-/, "")) || 0);
    if (hub.windows.some((window) => window.label === this.label)) return;
    const saved = parseSessionFile(data.session).windows;
    hub.windows.push({ label: this.label, layout: saved[hub.windows.length] ?? null });
  }

  /** The other windows. */
  siblings(data: FakeData): string[] {
    return state(data)
      .windows.map((window) => window.label)
      .filter((label) => label !== this.label);
  }

  layout(data: FakeData): unknown {
    return state(data).windows.find((window) => window.label === this.label)?.layout ?? null;
  }

  /** This window wrote its layout: the session file is written again with the others'. A window
   * gone — the app quitting — changes nothing. */
  writeLayout(data: FakeData, layout: unknown): void {
    const window = state(data).windows.find((each) => each.label === this.label);
    if (!window) return;
    window.layout = layout;
    writeSession(data);
  }

  /** Another window holds `tab`: the native side brings it forward and has it show the tab. */
  reveal(data: FakeData, owner: string, tab: TabRef): void {
    state(data).focused = owner;
    this.send([owner], { type: "reveal", tab });
  }

  /** This window's tab `ref` (`tab`, its session entry as JSON) was let go over window `to` of
   * this workspace at (`x`, `y`) in it: the place is that window's, and the native side brings it
   * forward and hands it the tab. */
  moveTo(data: FakeData, to: string, tab: string, ref: TabRef, x: number, y: number): void {
    (data.places ??= {})[placeKey(ref)] = to;
    state(data).focused = to;
    this.send([to], { type: "adopt", tab, x, y });
  }

  /** ⌥⌘N: a new, empty window. Returns its label. */
  openFresh(data: FakeData): string {
    const label = nextLabel(data);
    state(data).windows.push({ label, layout: null });
    return label;
  }

  /** This window's tab `ref` (`tab`, its session entry) goes to a new window, in the session and
   * in the places before the window is made. Returns the new window's label. */
  adopt(data: FakeData, tab: unknown, ref: TabRef): string {
    const label = nextLabel(data);
    state(data).windows.push({
      label,
      layout: { panes: [{ tabs: [tab], activeTab: 0, width: 1 }], focusedPane: 0 },
    });
    (data.places ??= {})[placeKey(ref)] = label;
    writeSession(data);
    return label;
  }

  /** Opens the page of window `label`. */
  open(label: string): void {
    window.open(`/?window=${label}`);
  }

  /** The window has gone: its places are free, and its layout leaves the session file unless it
   * was the last window. */
  closed(data: FakeData): void {
    const hub = state(data);
    hub.windows = hub.windows.filter((window) => window.label !== this.label);
    const places = data.places ?? {};
    for (const [key, owner] of Object.entries(places)) if (owner === this.label) delete places[key];
    if (hub.windows.length) writeSession(data);
  }

  /** The app quits: the session file keeps every window's layout, the windows reopen in that order
   * at the next start, and the places — in memory only — go. Writes from pages still open after
   * this change nothing. */
  quit(data: FakeData): void {
    writeSession(data);
    data.hub = { windows: [], labels: 0, focused: null };
    data.places = {};
  }
}

function state(data: FakeData): HubState {
  return (data.hub ??= { windows: [], labels: 0, focused: null });
}

function nextLabel(data: FakeData): string {
  return `ws-${++state(data).labels}`;
}

function writeSession(data: FakeData): void {
  const windows = state(data)
    .windows.map((window) => window.layout)
    .filter((layout) => layout !== null);
  data.session = JSON.stringify({ version: 2, windows });
}
