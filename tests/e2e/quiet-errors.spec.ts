import { expect, test, type Page } from "@playwright/test";

import { quietErrors, start } from "./helpers";

// These catch the filter and Vite's console wrapper calling each other only when an agent runs
// them: Vite turns `forwardConsole` on when it sees an agent, and without it there is no wrapper.
// A person's run passes them with the old filter too.

/** Calls `console.error` in the page with each text, and says how each call ended. */
function logErrors(page: Page, ...texts: string[]): Promise<string[]> {
  return page.evaluate(
    (texts) =>
      texts.map((text) => {
        try {
          console.error(text);
          return "ok";
        } catch (error) {
          return String(error);
        }
      }),
    texts,
  );
}

/** The page's console errors among `texts`, as the browser shows them. */
function consoleErrors(page: Page, texts: string[]): string[] {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && texts.includes(message.text())) seen.push(message.text());
  });
  return seen;
}

test("an error no filter takes reaches the console once", async ({ page }) => {
  const seen = consoleErrors(page, ["alpha", "other"]);
  await quietErrors(page, "alpha");
  await start(page);
  expect(await logErrors(page, "alpha", "other")).toEqual(["ok", "ok"]);
  await expect.poll(() => seen).toEqual(["other"]);
});

test("a second filter keeps the first one's words out too", async ({ page }) => {
  const seen = consoleErrors(page, ["alpha", "beta", "other"]);
  await quietErrors(page, "alpha");
  await quietErrors(page, "beta");
  await start(page);
  expect(await logErrors(page, "alpha", "beta", "other")).toEqual(["ok", "ok", "ok"]);
  await expect.poll(() => seen).toEqual(["other"]);
});
