import { invoke } from "@tauri-apps/api/core";

import { exitApp, issueFileToken, type LabEnv, recordResult } from "../lab-api";

type ViewerLog = Record<string, unknown>;

// Must stay above the sandbox's own timeouts (15 + 15 + 10 s plus two 5 s probe fetches).
// The perl alarm in the README must be larger than (number of cases) x CASE_TIMEOUT_MS.
const CASE_TIMEOUT_MS = 90_000;

async function runCase(
  page: string,
  videoPath: string,
  imagePath: string | null,
): Promise<ViewerLog> {
  const videoUrl = await issueFileToken(videoPath);
  const imageUrl = imagePath ? await issueFileToken(imagePath) : null;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.style.cssText = "width:640px;height:420px;border:1px solid #888";
  // The frame reports its log after every stage so a timeout still keeps what was measured.
  let lastLog: ViewerLog = {};
  // The listener goes in before the iframe exists so its first "ready" cannot be missed.
  const result = new Promise<ViewerLog>((resolve) => {
    const timer = setTimeout(
      () => resolve({ ...lastLog, timeout: `no result within ${CASE_TIMEOUT_MS / 1000}s` }),
      CASE_TIMEOUT_MS,
    );
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      if (e.data?.type === "ready") {
        iframe.contentWindow?.postMessage({ type: "init", videoUrl, imageUrl }, "*");
      }
      if (e.data?.type === "progress") {
        lastLog = e.data.log as ViewerLog;
      }
      if (e.data?.type === "result") {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(e.data.result as ViewerLog);
      }
    };
    window.addEventListener("message", onMessage);
  });
  iframe.src = page;
  document.body.append(iframe);
  const log = await result;
  iframe.remove();
  return log;
}

export async function runViewerAuto(env: LabEnv): Promise<void> {
  const nocsp = env.viewerPage === "nocsp";
  const page = nocsp ? "/viewer/sandbox-nocsp.html" : "/viewer/sandbox.html";
  const cases: [string, string | null][] = [
    ["faststart", env.video],
    ["moov-at-end", env.video2],
  ];
  // Positive control: a legitimate call from the main frame must print "[ipc-probe] reached source=host".
  await invoke("ipc_probe", { source: "host" });
  const results: Record<string, unknown> = { userAgent: navigator.userAgent, viewerPage: page };
  for (const [name, path] of cases) {
    results[name] = path ? await runCase(page, path, env.image) : { skipped: "env not set" };
  }
  await recordResult(nocsp ? "viewer-nocsp" : "viewer", results);
  await exitApp();
}
