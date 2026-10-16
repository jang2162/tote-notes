import { listen } from "@tauri-apps/api/event";

import {
  exitApp,
  recordResult,
  reloadBegin,
  reloadReady,
  windowGeometry,
  type Geometry,
} from "../lab-api";

const PHASE_KEY = "lab-reload-phase";
/** How long the reloaded page waits for stray second pings before it counts. */
const SETTLE_MS = 1500;

const sameGeometry = (a: Geometry, b: Geometry) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** First load asks Rust to reload this window; the reloaded page (told apart by sessionStorage,
 * which a reload keeps) listens for `lab://ping`, lets Rust send it once, and counts what arrives. */
export async function runReloadAuto(): Promise<void> {
  if (sessionStorage.getItem(PHASE_KEY) !== "reloaded") {
    sessionStorage.setItem(PHASE_KEY, "reloaded");
    await reloadBegin();
    return;
  }
  sessionStorage.removeItem(PHASE_KEY);
  let pings = 0;
  await listen("lab://ping", () => {
    pings += 1;
  });
  const ready = await reloadReady();
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const final = await windowGeometry();
  const moved = !sameGeometry(ready.before, ready.after) || !sameGeometry(ready.before, final);
  await recordResult("reload", {
    pings,
    before: ready.before,
    after: ready.after,
    final,
    moved,
    elapsedMs: ready.elapsedMs,
    ok: pings === 1 && !moved,
  });
  return exitApp();
}
