import type { Backend, MemoInfo, TabRef } from "../backend/types";
import {
  parseWindowSession,
  sessionPanes,
  type SessionNode,
  type SessionTab,
  type WindowSession,
} from "../core/session";
import { ExternalDoc, MemoDoc, type Doc } from "./docs";
import type { LayoutNode } from "./layout";
import type { Tabs } from "./tabs";

/** The session tab for `doc`. Defaults are left out so a session written by an older build and
 * one written now read the same. */
export function sessionTab(doc: Doc, deviceId: string): SessionTab {
  const place: { selection?: SessionTab["selection"]; scrollAnchor: number; mode?: "preview" } = {
    scrollAnchor: doc.scrollAnchor,
  };
  if (doc.selectionJSON) place.selection = doc.selectionJSON;
  if (doc.mode === "preview") place.mode = "preview";
  if (doc instanceof MemoDoc) {
    const tab: SessionTab = { kind: "memo", memoId: doc.info.id, ...place };
    if (doc.conflictKept) tab.conflictKept = { memoId: doc.conflictKept.memoId };
    return tab;
  }
  const external = doc as ExternalDoc;
  // Spec 「동기화 대비」: external entries always carry the device they belong to.
  const tab: SessionTab = { kind: "external", deviceId, path: external.path, ...place };
  if (external.language) tab.language = external.language;
  return tab;
}

/** The window a session is built from. */
export interface SessionLayout {
  readonly layout: LayoutNode;
  /** The pane of each of `layout`'s leaves, by id. */
  readonly panes: ReadonlyMap<string, { readonly tabs: Tabs }>;
  /** Index of the focused pane among the leaves, depth first. */
  readonly focusedPane: number;
}

/** What `restore` brings back for the window to lay out. */
export interface RestoredLayout {
  /** The session's tree, whose panes are `panes`, depth first. */
  layout: SessionNode;
  /** One per pane of `layout`, in the order of its leaves (depth first): its tabs in order and the
   * one to activate — the pane's active tab, else its last one, else null. */
  panes: { tabs: Doc[]; active: Doc | null }[];
  focusedPane: number;
}

/** Reads the window's session into tabs for its panes and builds the session from the panes. */
export class SessionSync {
  constructor(
    private readonly backend: Backend,
    private readonly layout: () => SessionLayout,
    private readonly deviceId: string,
    private readonly memoInfo: (id: string) => MemoInfo | undefined,
    private readonly makeMemo: (info: MemoInfo) => MemoDoc,
    private readonly makeExternal: (path: string) => ExternalDoc,
  ) {}

  /** The tabs of the session's panes, made but not yet in any pane. A tab listed twice is kept
   * where it comes first, the panes read left to right; a tab another window holds is left out.
   * The places are claimed in one call, so fifty tabs are not fifty round trips. Nothing is read
   * from disk here (spec 「세션」 — lazy). A pane whose tabs are all left out comes back empty. */
  async restore(): Promise<RestoredLayout> {
    const window = parseWindowSession(parseJson(await this.backend.readWindowLayout()));
    const found: { doc: Doc; tab: SessionTab; pane: number; index: number }[] = [];
    const sessionPaneList = sessionPanes(window.layout);
    for (const [pane, { tabs }] of sessionPaneList.entries()) {
      for (const [index, tab] of tabs.entries()) {
        const doc = this.docFor(tab, found);
        if (doc) found.push({ doc, tab, pane, index });
      }
    }
    const claims = found.length
      ? await claimPlaces(
          this.backend,
          found.map(({ doc }) => doc.tabRef),
          false,
        )
      : [];
    const panes = sessionPaneList.map(() => ({ tabs: [] as Doc[], active: null as Doc | null }));
    for (const [at, { doc, tab, pane, index }] of found.entries()) {
      if (!claims[at]) continue;
      doc.restoreSelection = tab.selection;
      doc.scrollAnchor = tab.scrollAnchor ?? 0;
      doc.mode = tab.mode ?? "edit";
      if (doc instanceof MemoDoc && tab.kind === "memo" && tab.conflictKept)
        doc.keepConflict(tab.conflictKept.memoId);
      panes[pane].tabs.push(doc);
      if (index === sessionPaneList[pane].activeTab) panes[pane].active = doc;
    }
    for (const pane of panes) pane.active ??= pane.tabs.at(-1) ?? null;
    return { layout: window.layout, panes, focusedPane: window.focusedPane };
  }

  async build(captureActive: () => void): Promise<WindowSession> {
    captureActive();
    const { layout, panes, focusedPane } = this.layout();
    const nodeOf = (node: LayoutNode): SessionNode => {
      if (node.kind === "split") {
        return { axis: node.axis, children: node.children.map(nodeOf), shares: [...node.shares] };
      }
      const tabs = panes.get(node.id)!.tabs;
      return {
        tabs: tabs.list.map((doc) => sessionTab(doc, this.deviceId)),
        activeTab: tabs.active ? tabs.indexOf(tabs.active) : -1,
      };
    };
    const window: WindowSession = { layout: nodeOf(layout), focusedPane };
    const frame = await this.backend.windowFrame();
    if (frame) window.frame = frame;
    return window;
  }

  /** The tab for `tab`, or null for one already among `found` (in any pane) or not to be shown
   * here. */
  private docFor(tab: SessionTab, found: readonly { doc: Doc }[]): Doc | null {
    const open = (same: (doc: Doc) => boolean) => found.some(({ doc }) => same(doc));
    if (tab.kind === "memo") {
      const info = this.memoInfo(tab.memoId);
      if (!info || open((doc) => doc instanceof MemoDoc && doc.info.id === info.id)) return null;
      return this.makeMemo(info);
    }
    // Another device's external file has no contents here; how to show it is the sync spec's call.
    if (tab.deviceId !== this.deviceId) return null;
    if (open((doc) => doc instanceof ExternalDoc && doc.path === tab.path)) return null;
    const doc = this.makeExternal(tab.path);
    doc.language = tab.language ?? null;
    return doc;
  }
}

/** The places of `refs` among every window's tabs (`Backend.claimTabs`); `reveal` brings forward
 * the window holding one. When they cannot be asked for, all are taken as given: the tabs open
 * here rather than not at all, and the console says why one may be open twice. */
export async function claimPlaces(
  backend: Backend,
  refs: TabRef[],
  reveal: boolean,
): Promise<boolean[]> {
  try {
    return await backend.claimTabs(refs, reveal);
  } catch (error) {
    console.error(error);
    return refs.map(() => true);
  }
}

/** `null` for no text or text that is not JSON: the window then starts with no tabs. */
function parseJson(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
