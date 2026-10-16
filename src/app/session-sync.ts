import type { Backend, MemoInfo } from "../backend/types";
import { parseWindowSession, type SessionTab, type WindowSession } from "../core/session";
import { ExternalDoc, MemoDoc, type Doc } from "./docs";
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

/** Reads the session into `tabs` and builds the session from them. */
export class SessionSync {
  constructor(
    private readonly backend: Backend,
    private readonly tabs: Tabs,
    private readonly deviceId: string,
    private readonly memoInfo: (id: string) => MemoInfo | undefined,
    private readonly makeMemo: (info: MemoInfo) => MemoDoc,
    private readonly makeExternal: (path: string) => ExternalDoc,
  ) {}

  /** Fills `tabs` (which must be empty) from the window's first pane and returns the tab to
   * activate: the pane's active tab, else the last one, else null. A tab another window holds is
   * left out; the places are claimed in one call, so fifty tabs are not fifty round trips. Nothing
   * is read from disk here (spec 「세션」 — lazy). */
  async restore(): Promise<Doc | null> {
    const [pane] = parseWindowSession(parseJson(await this.backend.readWindowLayout())).panes;
    const found: { doc: Doc; tab: SessionTab; index: number }[] = [];
    for (const [index, tab] of pane.tabs.entries()) {
      const doc = this.docFor(tab, found);
      if (doc) found.push({ doc, tab, index });
    }
    const claims = found.length
      ? await this.backend.claimTabs(
          found.map(({ doc }) => doc.tabRef),
          false,
        )
      : [];
    let active: Doc | null = null;
    for (const [at, { doc, tab, index }] of found.entries()) {
      if (!claims[at]) continue;
      doc.restoreSelection = tab.selection;
      doc.scrollAnchor = tab.scrollAnchor ?? 0;
      doc.mode = tab.mode ?? "edit";
      if (doc instanceof MemoDoc && tab.kind === "memo" && tab.conflictKept)
        doc.keepConflict(tab.conflictKept.memoId);
      this.tabs.push(doc);
      if (index === pane.activeTab) active = doc;
    }
    return active ?? this.tabs.list.at(-1) ?? null;
  }

  async build(captureActive: () => void): Promise<WindowSession> {
    captureActive();
    const window: WindowSession = {
      panes: [
        {
          tabs: this.tabs.list.map((doc) => sessionTab(doc, this.deviceId)),
          activeTab: this.tabs.active ? this.tabs.indexOf(this.tabs.active) : -1,
          width: 1,
        },
      ],
      focusedPane: 0,
    };
    const frame = await this.backend.windowFrame();
    if (frame) window.frame = frame;
    return window;
  }

  /** The tab for `tab`, or null for one already among `found` or not to be shown here. */
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

/** `null` for no text or text that is not JSON: the window then starts with no tabs. */
function parseJson(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
