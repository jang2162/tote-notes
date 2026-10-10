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
