import { mountImePage } from "./ime/ime-page";
import { exitApp, labEnv, recordResult } from "./lab-api";
import { mountLatencyPage } from "./perf/latency-page";
import { runSmokeAuto } from "./perf/smoke";
import { runThroughputAuto } from "./perf/throughput";
import { runViewerAuto } from "./viewer/host";

const app = document.querySelector<HTMLDivElement>("#app")!;
window.addEventListener("hashchange", () => location.reload());

async function main(): Promise<void> {
  const env = await labEnv();
  // Rust opens the small always-on-top auto window whenever TOTE_LAB_AUTO is set at all, so any
  // value (even empty or unknown) must end the run instead of leaving that window up.
  if (env.auto !== null) {
    switch (env.auto) {
      case "ping":
        await recordResult("ping", { ok: true, userAgent: navigator.userAgent });
        return exitApp();
      case "viewer":
        return runViewerAuto(env);
      case "throughput":
        return runThroughputAuto();
      case "smoke":
        return runSmokeAuto(app);
      default:
        await recordResult("error-unknown-auto", { auto: env.auto });
        return exitApp();
    }
  }
  if (location.hash === "#latency") return mountLatencyPage(app);
  if (location.hash === "#ime") return mountImePage(app);
  app.innerHTML = `
    <h1>tote lab</h1>
    <p>측정용 실험 앱이다. 제품 코드가 아니다.</p>
    <ul>
      <li><a href="#latency">입력 지연 측정</a></li>
      <li><a href="#ime">한글 IME 검사</a></li>
    </ul>`;
}

main().catch(async (err) => {
  app.textContent = String(err);
  console.error(err);
  // An auto run must never hang the caller; record the error and leave.
  const env = await labEnv().catch(() => null);
  if (env && env.auto !== null) {
    await recordResult(`error-${env.auto || "unknown-auto"}`, { error: String(err) }).catch(
      () => undefined,
    );
    await exitApp();
  }
});
