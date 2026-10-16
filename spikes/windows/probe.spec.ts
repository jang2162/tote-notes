import { expect, test, type Page } from "@playwright/test";

// Measurement, not product tests: each test is the evidence for one verdict in the spike report.

test("① BroadcastChannel reaches the other page of the same context", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto("/");
  await b.goto("/");
  await a.evaluate(() => window.probe.post({ from: "a", n: 1 }));
  await expect.poll(() => b.evaluate(() => window.probe.inbox)).toEqual([{ from: "a", n: 1 }]);
  // A channel never delivers to the page that posted.
  expect(await a.evaluate(() => window.probe.inbox)).toEqual([]);
});

test("② localStorage is shared by the pages of one context", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto("/");
  await b.goto("/");
  await a.evaluate(() => localStorage.setItem("k", "from-a"));
  expect(await b.evaluate(() => localStorage.getItem("k"))).toBe("from-a");
});

test("③ window.open('/?window=ws-2') is caught as a popup of the same context", async ({
  context,
}) => {
  const a = await context.newPage();
  await a.goto("/");
  const [popup] = await Promise.all([
    a.waitForEvent("popup"),
    a.evaluate(() => window.open("/?window=ws-2")),
  ]);
  await popup.waitForLoadState();
  expect(new URL(popup.url()).search).toBe("?window=ws-2");
  expect(popup.context()).toBe(context);
  // The popup shares the hub too.
  await a.evaluate(() => window.probe.post("hello"));
  await expect.poll(() => popup.evaluate(() => window.probe.inbox)).toEqual(["hello"]);
});

test("④ alternating read-modify-write on one localStorage JSON loses no write (100 each)", async ({
  context,
}) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto("/");
  await b.goto("/");
  const turns: Page[] = [];
  for (let i = 0; i < 100; i++) turns.push(a, b);
  let n = 0;
  for (const page of turns) {
    n += 1;
    const length = await page.evaluate((i) => window.probe.appendStored("shared", i), n);
    // Each turn must see every earlier write, from either page.
    expect(length).toBe(n);
  }
  const stored = await a.evaluate(() => JSON.parse(localStorage.getItem("shared")!) as number[]);
  expect(stored).toHaveLength(200);
  expect(new Set(stored).size).toBe(200);
});

test("⑤a locator.dragTo raises the HTML5 drag events", async ({ page }) => {
  await page.goto("/");
  await page.locator("#item-a").dragTo(page.locator("#target"));
  const events = await page.evaluate(() => window.probe.dragEvents);
  expect(events).toContain("dragstart:item-a");
  expect(events).toContain("drop:target");
  expect(events).toContain("dragend:item-a");
});

test("⑤b dispatchEvent with a DataTransfer handle raises the HTML5 drag events", async ({
  page,
}) => {
  await page.goto("/");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page.locator("#item-a").dispatchEvent("dragstart", { dataTransfer });
  await page.locator("#target").dispatchEvent("dragenter", { dataTransfer });
  await page.locator("#target").dispatchEvent("dragover", { dataTransfer });
  await page.locator("#target").dispatchEvent("drop", { dataTransfer });
  await page.locator("#item-a").dispatchEvent("dragend", { dataTransfer });
  const events = await page.evaluate(() => window.probe.dragEvents);
  expect(events).toEqual(["dragstart:item-a", "dragenter:target", "drop:target", "dragend:item-a"]);
  expect(await dataTransfer.evaluate((dt) => dt.getData("text/plain"))).toBe("item-a");
});
