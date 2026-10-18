let leaving = false;
if (typeof addEventListener === "function") {
  addEventListener("pagehide", () => (leaving = true));
  addEventListener("beforeunload", () => (leaving = true));
  // A cancelled unload, or a page restored from the back/forward cache, is staying after all.
  addEventListener("pageshow", () => (leaving = false));
}

/** The page is going away (a reload, a workspace switch): reads in flight are cut with
 * `TypeError: Load failed`, which says nothing about the file, so a warning for one is noise. */
export const pageLeaving = (): boolean => leaving;
