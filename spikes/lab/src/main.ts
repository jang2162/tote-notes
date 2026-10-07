import { exitApp, labEnv, recordResult } from "./lab-api";

const app = document.querySelector<HTMLDivElement>("#app")!;

async function main(): Promise<void> {
  const env = await labEnv();
  if (env.auto === "ping") {
    await recordResult("ping", { ok: true, userAgent: navigator.userAgent });
    return exitApp();
  }
  app.innerHTML = `<h1>tote lab</h1><p>측정용 실험 앱이다. 제품 코드가 아니다.</p>`;
}

main().catch((err) => {
  app.textContent = String(err);
  console.error(err);
});
