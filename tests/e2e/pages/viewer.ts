import { ViewerHost, type PreviewRequests } from "../../../src/viewer/host";

const params = new URLSearchParams(location.search);
const log = document.getElementById("log")!;
// `?preview=1`: a preview viewer's host, its requests written down in `previewCalls`; `?text=`
// is the text it is given, `?readonly` makes the tab read-only.
const previewCalls: unknown[][] = [];
const preview: PreviewRequests | undefined = params.has("preview")
  ? {
      toggleTask: (index, drawn) => void previewCalls.push(["toggleTask", index, drawn]),
      highlight: async (blocks) => {
        previewCalls.push(["highlight", blocks]);
        return [{ index: 0, lines: [[{ text: "a", color: "#ff0000", fontStyle: 0 }]] }];
      },
      openLink: (href) => void previewCalls.push(["openLink", href]),
    }
  : undefined;
const host = new ViewerHost({
  url: params.get("viewer") ?? "/tests/e2e/pages/viewers/echo.html",
  readyTimeoutMs: Number(params.get("timeout") ?? 5000),
  resolveRelative: async (path) => (path === "pic.png" ? "data:image/png;base64,AAAA" : null),
  onError: (message) => {
    log.textContent = `error: ${message}`;
  },
  preview,
});
document.getElementById("host")!.append(host.el);
host.start(
  preview
    ? {
        fileName: "할일.md",
        extension: "md",
        size: 7,
        text: params.get("text") ?? "- [ ] a",
        theme: {},
        readOnly: params.has("readonly"),
      }
    : {
        fileName: "사진.png",
        extension: "png",
        size: 3,
        url: "data:image/png;base64,AAAA",
        theme: { "--bg": "rgb(1, 2, 3)" },
      },
);
Object.assign(window, { previewCalls });
Object.assign(window, { viewerHost: host });

// `?intruder=1`: another frame posts an error to this page, as any window could.
if (params.has("intruder")) {
  const intruder = document.createElement("iframe");
  intruder.setAttribute("sandbox", "allow-scripts");
  // With `?preview=1` it asks what a preview viewer may ask, in the shapes that are taken.
  intruder.srcdoc = params.has("preview")
    ? `<script>
        parent.postMessage({ type: "toggleTask", version: 1, index: 0 }, "*");
        parent.postMessage({ type: "openLink", href: "https://example.com/intruder" }, "*");
        parent.postMessage({ type: "highlight", version: 1, req: 1, blocks: [] }, "*");
        parent.postMessage({ type: "error", message: "intruder" }, "*");
      </script>`
    : `<script>parent.postMessage({ type: "error", message: "intruder" }, "*")</script>`;
  // Added after the host's listener, so the host has seen the message when this marks it.
  addEventListener("message", (e) => {
    if (e.source === intruder.contentWindow && e.data?.type === "error")
      document.body.dataset.intruder = "seen";
  });
  document.body.append(intruder);
}
