let leaving = false;
if (typeof addEventListener === "function") {
  addEventListener("pagehide", () => (leaving = true));
  addEventListener("beforeunload", () => (leaving = true));
}

/** The page is going away (a reload, a workspace switch): reads in flight are cut with
 * `TypeError: Load failed`, which says nothing about the file, so a warning for one is noise. */
export const pageLeaving = (): boolean => leaving;
