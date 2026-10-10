import { h } from "../ui/dom";
import type { HostMessage, ViewerInit, ViewerMessage } from "./protocol";

/** No `allow-same-origin`: the frame gets an opaque origin and cannot reach the host page, its
 * storage or its Tauri API. No popups, forms or top navigation either. */
export const VIEWER_SANDBOX = "allow-scripts";
export const READY_TIMEOUT_MS = 5000;
export const NO_ANSWER = "뷰어가 응답하지 않습니다";

export interface ViewerHostOptions {
  url: string;
  readyTimeoutMs?: number;
  resolveRelative: (path: string) => Promise<string | null>;
  /** The viewer failed or never answered: show 「열 수 없음」 (spec 「뷰어」). */
  onError: (message: string) => void;
}

/** One viewer iframe and its side of the protocol. `start` queues `init` until `ready`. */
export class ViewerHost {
  readonly el: HTMLElement;
  private readonly frame: HTMLIFrameElement;
  private init: ViewerInit | null = null;
  private ready = false;
  private failed = false;
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
    this.init = init;
    if (this.ready) this.send({ type: "init", ...init });
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
