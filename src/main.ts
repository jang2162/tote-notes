import { AppController } from "./app/controller";
import type { Backend } from "./backend/types";

async function chooseBackend(): Promise<{ backend: Backend; fake: boolean }> {
  if ("__TAURI_INTERNALS__" in window) {
    const { TauriBackend } = await import("./backend/tauri");
    return { backend: new TauriBackend(), fake: false };
  }
  // Outside the app — a browser on the Vite dev server, the UI tests — an in-memory stand-in. A page
  // opened as `?window=ws-<n>` is one of several windows sharing it (`FakeHub`).
  const { FakeBackend } = await import("./backend/fake");
  const label = new URLSearchParams(location.search).get("window");
  return {
    backend: label ? FakeBackend.fromHub(label) : FakeBackend.fromSessionStorage(),
    fake: true,
  };
}

void (async () => {
  const { backend, fake } = await chooseBackend();
  const app = new AppController(document.body, backend);
  const handle = { app, backend, ready: false };
  // The UI tests drive the fake backend and inspect the editor through this handle.
  if (fake) Object.assign(window, { __tote: handle });
  try {
    await app.start();
    handle.ready = true;
  } catch (error) {
    document.body.textContent = `tote 를 시작하지 못했습니다: ${String(error)}`;
  }
})();
