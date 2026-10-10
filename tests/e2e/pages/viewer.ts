import { ViewerHost } from "../../../src/viewer/host";

const params = new URLSearchParams(location.search);
const log = document.getElementById("log")!;
const host = new ViewerHost({
  url: params.get("viewer") ?? "/tests/e2e/pages/viewers/echo.html",
  readyTimeoutMs: Number(params.get("timeout") ?? 5000),
  resolveRelative: async (path) => (path === "pic.png" ? "data:image/png;base64,AAAA" : null),
  onError: (message) => {
    log.textContent = `error: ${message}`;
  },
});
document.getElementById("host")!.append(host.el);
host.start({
  fileName: "사진.png",
  extension: "png",
  size: 3,
  url: "data:image/png;base64,AAAA",
  theme: { "--bg": "rgb(1, 2, 3)" },
});
Object.assign(window, { viewerHost: host });

// `?intruder=1`: another frame posts an error to this page, as any window could.
if (params.has("intruder")) {
  const intruder = document.createElement("iframe");
  intruder.setAttribute("sandbox", "allow-scripts");
  intruder.srcdoc = `<script>parent.postMessage({ type: "error", message: "intruder" }, "*")</script>`;
  // Added after the host's listener, so the host has seen the message when this marks it.
  addEventListener("message", (e) => {
    if (e.source === intruder.contentWindow) document.body.dataset.intruder = "seen";
  });
  document.body.append(intruder);
}
