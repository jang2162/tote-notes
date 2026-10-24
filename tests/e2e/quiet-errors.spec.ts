import { expect, test, type Page } from "@playwright/test";

import { quietErrors, start } from "./helpers";

// These catch the filter and Vite's console wrapper calling each other only when an agent runs
// them: Vite turns `forwardConsole` on when it sees an agent, and without it there is no wrapper.
// A person's run passes them with the old filter too, and leaves out what goes to Vite (an
// annotation says so).
//
// What goes to Vite is read from the frames the page sends it (`vite:forward-console` over the HMR
// socket), not from the dev server's output, which Playwright prints as `[WebServer] …` and a test
// cannot read. A frame sent is a line in that log: the server only formats it.

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

/** The console errors among `texts` the page sends Vite for its log. Set before the page loads:
 * the socket opens with it. */
function forwardedErrors(page: Page, texts: string[]): string[] {
  const sent: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      let frame;
      try {
        frame = JSON.parse(String(payload));
      } catch {
        return;
      }
      const log = frame?.event === "vite:forward-console" ? frame.data?.data : undefined;
      if (log?.level === "error" && texts.includes(log.message)) sent.push(log.message);
    }),
  );
  return sent;
}

/** Whether Vite forwards the page's console errors, as the client it serves is set. */
async function forwarding(page: Page): Promise<boolean> {
  const client = await (await page.request.get("/@vite/client")).text();
  const options = /const forwardConsole = (\{.*\});/.exec(client);
  const on = options !== null && JSON.parse(options[1]).logLevels?.includes("error") === true;
  if (!on)
    test.info().annotations.push({
      type: "not checked",
      description: "Vite does not forward the console here, so what goes to its log is not seen",
    });
  return on;
}

test("an error no filter takes reaches the console once", async ({ page }) => {
  const seen = consoleErrors(page, ["alpha", "other"]);
  const sent = forwardedErrors(page, ["alpha", "other"]);
  await quietErrors(page, "alpha");
  await start(page);
  expect(await logErrors(page, "alpha", "other")).toEqual(["ok", "ok"]);
  await expect.poll(() => seen).toEqual(["other"]);
  if (await forwarding(page)) await expect.poll(() => sent).toEqual(["other"]);
});

test("a second filter keeps the first one's words out too", async ({ page }) => {
  const seen = consoleErrors(page, ["alpha", "beta", "other"]);
  const sent = forwardedErrors(page, ["alpha", "beta", "other"]);
  await quietErrors(page, "alpha");
  await quietErrors(page, "beta");
  await start(page);
  expect(await logErrors(page, "alpha", "beta", "other")).toEqual(["ok", "ok", "ok"]);
  await expect.poll(() => seen).toEqual(["other"]);
  // Vite's log too: a filter of its own for each call put the first one's words through to it.
  if (await forwarding(page)) await expect.poll(() => sent).toEqual(["other"]);
});

test("every error after the first still goes to Vite, not to the console alone", async ({
  page,
}) => {
  const texts = ["one", "two", "three"];
  const seen = consoleErrors(page, texts);
  const sent = forwardedErrors(page, texts);
  await quietErrors(page, "alpha");
  await start(page);
  expect(await logErrors(page, "one", "alpha", "two", "three")).toEqual(["ok", "ok", "ok", "ok"]);
  await expect.poll(() => seen).toEqual(texts);
  // A call coming back into the filter is marked so that it goes to the browser's own; left
  // marked, every later call would too and skip Vite's wrapper.
  if (await forwarding(page)) await expect.poll(() => sent).toEqual(texts);
});
