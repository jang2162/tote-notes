import { exitApp, issueFileToken, type LabEnv, recordResult } from "../lab-api";

type ViewerLog = Record<string, unknown>;

async function runCase(videoPath: string, imagePath: string | null): Promise<ViewerLog> {
  const videoUrl = await issueFileToken(videoPath);
  const imageUrl = imagePath ? await issueFileToken(imagePath) : null;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.style.cssText = "width:640px;height:420px;border:1px solid #888";
  // The listener goes in before the iframe exists so its first "ready" cannot be missed.
  const result = new Promise<ViewerLog>((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: "no result within 40s" }), 40_000);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      if (e.data?.type === "ready") {
        iframe.contentWindow?.postMessage({ type: "init", videoUrl, imageUrl }, "*");
      }
      if (e.data?.type === "result") {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(e.data.result as ViewerLog);
      }
    };
    window.addEventListener("message", onMessage);
  });
  iframe.src = "/viewer/sandbox.html";
  document.body.append(iframe);
  const log = await result;
  iframe.remove();
  return log;
}

export async function runViewerAuto(env: LabEnv): Promise<void> {
  const cases: [string, string | null][] = [
    ["faststart", env.video],
    ["moov-at-end", env.video2],
  ];
  const results: Record<string, unknown> = { userAgent: navigator.userAgent };
  for (const [name, path] of cases) {
    results[name] = path ? await runCase(path, env.image) : { skipped: "env not set" };
  }
  await recordResult("viewer", results);
  await exitApp();
}
