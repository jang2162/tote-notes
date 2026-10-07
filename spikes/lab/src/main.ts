import { exitApp, labEnv, recordResult } from "./lab-api";
import { runViewerAuto } from "./viewer/host";

const app = document.querySelector<HTMLDivElement>("#app")!;

async function main(): Promise<void> {
  const env = await labEnv();
  switch (env.auto) {
    case "ping":
      await recordResult("ping", { ok: true, userAgent: navigator.userAgent });
      return exitApp();
    case "viewer":
      return runViewerAuto(env);
  }
  app.innerHTML = `<h1>tote lab</h1><p>측정용 실험 앱이다. 제품 코드가 아니다.</p>`;
}

main().catch(async (err) => {
  app.textContent = String(err);
  console.error(err);
  // An auto run must never hang the caller; record the error and leave.
  const env = await labEnv().catch(() => null);
  if (env?.auto) {
    await recordResult(`error-${env.auto}`, { error: String(err) }).catch(() => undefined);
    await exitApp();
  }
});
