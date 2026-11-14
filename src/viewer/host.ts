import { h } from "../ui/dom";
import type { CodeBlock, CodeColors, HostMessage, ViewerInit, ViewerMessage } from "./protocol";

/** No `allow-same-origin`: the frame gets an opaque origin and cannot reach the host page, its
 * storage or its Tauri API. No popups, forms or top navigation either. */
export const VIEWER_SANDBOX = "allow-scripts";
export const READY_TIMEOUT_MS = 5000;
export const NO_ANSWER = "뷰어가 응답하지 않습니다";
/** The longest link a viewer may ask to follow; a longer one is dropped. */
export const MAX_LINK_LENGTH = 8192;
/** The longest fence info word taken as a language name. */
const MAX_LANG_LENGTH = 64;

/** What a preview viewer may ask of its tab (spec 2026-11-14 md-preview). Each request is checked
 * here first: from this frame, of the right shape, and for the text on show. */
export interface PreviewRequests {
  /** Flip the `index`-th task's box of `drawn`, the text the viewer was last given. */
  toggleTask(index: number, drawn: string): void;
  /** `stale` turns true once the viewer has been given another text: the colours are not wanted. */
  highlight(blocks: CodeBlock[], stale: () => boolean): Promise<CodeColors[]>;
  openLink(href: string): void;
}

export interface ViewerHostOptions {
  url: string;
  readyTimeoutMs?: number;
  resolveRelative: (path: string) => Promise<string | null>;
  /** The viewer failed or never answered: show 「열 수 없음」 (spec 「뷰어」). */
  onError: (message: string) => void;
  /** Only a preview viewer gets these; another viewer's such requests are dropped. */
  preview?: PreviewRequests;
}

const isIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The blocks of a `highlight` request, or null when any of them is not of the shape. */
function codeBlocks(value: unknown): CodeBlock[] | null {
  if (!Array.isArray(value)) return null;
  const blocks: CodeBlock[] = [];
  for (const block of value as unknown[]) {
    if (!block || typeof block !== "object") return null;
    const { index, lang, code } = block as Record<string, unknown>;
    if (!isIndex(index) || typeof lang !== "string" || typeof code !== "string") return null;
    if (lang.length > MAX_LANG_LENGTH) continue;
    blocks.push({ index, lang, code });
  }
  return blocks;
}

/** One viewer iframe and its side of the protocol. `start` queues `init` until `ready`. */
export class ViewerHost {
  readonly el: HTMLElement;
  private readonly frame: HTMLIFrameElement;
  private init: ViewerInit | null = null;
  /** The number of the text last given to the viewer (`ViewerInit.version`). */
  private version = 0;
  private ready = false;
  private failed = false;
  /** The `req` of the latest colour request taken: an earlier one still on its way is not wanted
   * any more (a theme change asks again for the same text). */
  private colorReq: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onMessage = (event: MessageEvent<ViewerMessage>) => this.receive(event);

  constructor(private readonly options: ViewerHostOptions) {
    this.frame = h("iframe", { class: "viewer-frame", title: "뷰어" });
    this.frame.setAttribute("sandbox", VIEWER_SANDBOX);
    this.el = h("div", { class: "viewer-host" }, this.frame);
    window.addEventListener("message", this.onMessage);
    this.frame.src = options.url;
    this.timer = setTimeout(() => this.fail(NO_ANSWER), options.readyTimeoutMs ?? READY_TIMEOUT_MS);
  }

  start(init: ViewerInit): void {
    this.init = { ...init, version: ++this.version };
    if (this.ready) this.send({ type: "init", ...this.init });
  }

  /** A preview viewer draws `text` instead, where the reader was. */
  update(text: string): void {
    if (!this.init) return;
    this.init = { ...this.init, text, size: text.length, version: ++this.version };
    if (this.ready) this.send({ type: "update", text, version: this.version });
  }

  setTheme(theme: Record<string, string>): void {
    if (this.init) this.init = { ...this.init, theme };
    if (this.ready) this.send({ type: "theme", theme });
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    if (this.timer) clearTimeout(this.timer);
    this.frame.src = "about:blank";
    this.el.remove();
  }

  private receive(event: MessageEvent<ViewerMessage>): void {
    if (event.source !== this.frame.contentWindow || this.failed) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "ready":
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.ready = true;
        if (this.init) this.send({ type: "init", ...this.init });
        return;
      case "error":
        this.fail(typeof message.message === "string" ? message.message : "뷰어 오류");
        return;
      case "resolveRelative":
        if (typeof message.path !== "string" || typeof message.id !== "number") return;
        void this.options
          .resolveRelative(message.path)
          .catch(() => null)
          .then((url) => this.send({ type: "resolved", id: message.id, url }));
        return;
      case "toggleTask": {
        const { preview } = this.options;
        const text = this.init?.text;
        if (!preview || text === undefined || message.version !== this.version) return;
        if (!isIndex(message.index)) return;
        preview.toggleTask(message.index, text);
        return;
      }
      case "highlight": {
        const { preview } = this.options;
        const { version, req } = message;
        if (!preview || version !== this.version || !isIndex(req)) return;
        const blocks = codeBlocks(message.blocks);
        if (!blocks) return;
        this.colorReq = req;
        // A text drawn since, or a newer request for this one, asks for its own colours.
        const stale = () => version !== this.version || req !== this.colorReq || this.failed;
        void preview
          .highlight(blocks, stale)
          .catch((error: unknown) => {
            console.warn("preview code colours", error);
            return [];
          })
          .then((colors) => {
            if (!stale()) this.send({ type: "highlighted", version, req, blocks: colors });
          });
        return;
      }
      case "openLink":
        if (!this.options.preview || typeof message.href !== "string") return;
        if (message.href.length > MAX_LINK_LENGTH) return;
        this.options.preview.openLink(message.href);
        return;
    }
  }

  private send(message: HostMessage): void {
    this.frame.contentWindow?.postMessage(message, "*");
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    if (this.timer) clearTimeout(this.timer);
    this.options.onError(message);
  }
}
