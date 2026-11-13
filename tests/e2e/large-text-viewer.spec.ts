import { expect, test, type Page } from "@playwright/test";

// The large text viewer alone (tests/e2e/pages/large-text.html): a generated file of millions of
// lines, too many for the fake backend's storage, and searches the test answers by hand.

const SCREEN_LINES = 400 / 20; // the page's 400px host, LINE_HEIGHT 20

/** The first line whose row is in the viewport, and its text. */
function firstLine(page: Page): Promise<{ line: number; text: string } | null> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".large-text-scroller")!;
    const rows = [...document.querySelectorAll<HTMLElement>(".large-text-line")]
      .map((row) => ({ row, y: row.offsetTop - scroller.scrollTop }))
      .filter(({ y }) => y > -20)
      .sort((a, b) => a.y - b.y);
    const top = rows[0]?.row;
    return top ? { line: Number(top.dataset.line), text: top.textContent ?? "" } : null;
  });
}

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/tests/e2e/pages/large-text.html${query}`);
  await expect(page.locator(".large-text-line").first()).toHaveText("L000000000");
}

test("on six million lines the keys and the wheel move as far as they say, not twelve times as far", async ({
  page,
}) => {
  await open(page);
  await page.locator(".large-text-scroller").click();
  await page.keyboard.press("PageDown");
  await expect.poll(async () => (await firstLine(page))?.line).toBeGreaterThan(0);
  const one = (await firstLine(page))!;
  expect(one.line).toBeLessThanOrEqual(SCREEN_LINES);
  expect(one.text).toBe(await page.evaluate((n) => window.lineText(n), one.line));
  await page.keyboard.press("PageDown");
  await expect.poll(async () => (await firstLine(page))?.line).toBeGreaterThan(one.line);
  expect((await firstLine(page))!.line - one.line).toBeLessThanOrEqual(SCREEN_LINES);
  const before = (await firstLine(page))!.line;
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await firstLine(page))?.line).toBeGreaterThan(before);
  expect((await firstLine(page))!.line - before).toBeLessThanOrEqual(2);
  const beforeWheel = (await firstLine(page))!.line;
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await firstLine(page))?.line).toBeGreaterThan(beforeWheel);
  expect((await firstLine(page))!.line - beforeWheel).toBeLessThanOrEqual(SCREEN_LINES);
  await page.keyboard.press("End");
  await expect(page.locator(".large-text-line", { hasText: "L005999999" })).toBeVisible();
  await page.keyboard.press("Home");
  await expect.poll(async () => (await firstLine(page))?.line).toBe(0);
});

test("dragging the scroll bar still reaches the whole file in proportion", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".large-text-scroller")!;
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
  });
  await expect.poll(async () => (await firstLine(page))?.line).toBeGreaterThan(3_000_000 - 30_000);
  expect((await firstLine(page))!.line).toBeLessThan(3_000_000 + 30_000);
});

test("goToLine past the clipped height draws the current line inside the viewport", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.largeTextViewer.goToLine(4_321_000));
  const current = page.locator(".large-text-line.current");
  await expect(current).toHaveText("L004321000");
  const y = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".large-text-scroller")!;
    const row = document.querySelector<HTMLElement>(".large-text-line.current")!;
    return { top: row.offsetTop - scroller.scrollTop, height: scroller.clientHeight };
  });
  expect(y.top).toBeGreaterThanOrEqual(0);
  expect(y.top).toBeLessThan(y.height);
});

test("a search started over another drops the first one's late answer", async ({ page }) => {
  await open(page);
  const input = page.locator('.large-text-search input[type="search"]');
  await input.fill("foo");
  await input.press("Enter");
  await input.fill("bar");
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.searchCalls.length)).toBe(2);
  // The backend stops the first search when the second begins and answers it as cancelled.
  await page.evaluate(() =>
    window.searchCalls[0].resolve({
      matches: [{ line: 5, column: 0 }],
      done: false,
      cancelled: true,
    }),
  );
  await page.evaluate(() =>
    window.searchCalls[1].resolve({
      matches: [{ line: 100, column: 0 }],
      done: true,
      cancelled: false,
    }),
  );
  await expect(page.locator(".large-text-count")).toHaveText("1 / 1");
  await expect(page.locator(".large-text-line.current")).toHaveText("L000000100");
  expect(await page.evaluate(() => window.searchCalls.map((c) => c.query.query))).toEqual([
    "foo",
    "bar",
  ]);
});

test("the next page of matches is asked once, for the query the search started with", async ({
  page,
}) => {
  await open(page);
  const input = page.locator('.large-text-search input[type="search"]');
  const next = page.locator("button", { hasText: "다음" });
  await input.fill("bar");
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.searchCalls.length)).toBe(1);
  await page.evaluate(() =>
    window.searchCalls[0].resolve({
      matches: [
        { line: 10, column: 0 },
        { line: 20, column: 0 },
      ],
      done: false,
      cancelled: false,
    }),
  );
  await expect(page.locator(".large-text-count")).toHaveText("1 / 2+");
  await next.click();
  await expect(page.locator(".large-text-count")).toHaveText("2 / 2+");
  // Typed but not entered: the search going on is still "bar".
  await input.fill("baz");
  await next.click();
  await next.click();
  await expect.poll(() => page.evaluate(() => window.searchCalls.length)).toBe(2);
  expect(
    await page.evaluate(() => ({
      query: window.searchCalls[1].query.query,
      fromLine: window.searchCalls[1].fromLine,
    })),
  ).toEqual({ query: "bar", fromLine: 21 });
  await page.evaluate(() =>
    window.searchCalls[1].resolve({
      matches: [{ line: 900, column: 0 }],
      done: true,
      cancelled: false,
    }),
  );
  await expect(page.locator(".large-text-count")).toHaveText("3 / 3");
  await expect(page.locator(".large-text-line.current")).toHaveText("L000000900");
  expect(await page.evaluate(() => window.searchCalls.length)).toBe(2);
});

test("a broken pattern says so in Korean; other failures say what failed", async ({ page }) => {
  await open(page);
  const input = page.locator('.large-text-search input[type="search"]');
  await input.fill("(");
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.searchCalls.length)).toBe(1);
  await page.evaluate(() =>
    window.searchCalls[0].reject(
      new window.BackendError("bad-request", "not a valid pattern: regex parse error"),
    ),
  );
  await expect(page.locator(".large-text-count")).toHaveText("잘못된 정규식");
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.searchCalls.length)).toBe(2);
  await page.evaluate(() => window.searchCalls[1].reject(new Error("disk gone")));
  await expect(page.locator(".large-text-count")).toHaveText("오류: disk gone");
});

test("the empty page after a final newline is not fetched", async ({ page }) => {
  // 2,000 lines and a final newline: the last checkpoint is the file's end.
  await open(page, "?lines=2000&trailing=1");
  await page.evaluate(() => window.largeTextViewer.goToLine(2000));
  await expect(page.locator(".large-text-line.current")).toHaveText("");
  await expect(page.locator(".large-text-line", { hasText: "L000001999" })).toBeVisible();
  await page.evaluate(() => window.largeTextViewer.goToLine(1990));
  await page.evaluate(() => window.largeTextViewer.goToLine(2000));
  await expect(page.locator(".large-text-line.current")).toHaveText("");
  expect(
    await page.evaluate(() => window.fetchLog.filter(([start]) => start >= 2000 * 11)),
  ).toEqual([]);
});

test("a page longer than one range answer is fetched in pieces", async ({ page }) => {
  // A page of 1,000 lines is 11,000 bytes; answers of 6,000 cut line 545 in two.
  await open(page, "?lines=2000&maxRange=6000");
  await page.evaluate(() => window.largeTextViewer.goToLine(545));
  await expect(page.locator(".large-text-line.current")).toHaveText("L000000545");
  const wrong = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".large-text-line")]
      .map((row) => ({ line: Number(row.dataset.line), text: row.textContent }))
      .filter(({ line, text }) => text !== window.lineText(line)),
  );
  expect(wrong).toEqual([]);
  expect(await page.evaluate(() => window.fetchLog)).toEqual([
    [0, 10_999],
    [6000, 10_999],
  ]);
});

// Six million lines are 6,000 pages: read to the end, they must not all stay in memory.
test("pages read long ago are let go of and read again when scrolled back to", async ({ page }) => {
  await open(page);
  const PAGES = 100;
  const kept = await page.evaluate(async (pages) => {
    const viewer = window.largeTextViewer;
    for (let index = 0; index < pages; index++) {
      const line = index * 1000 + 500;
      viewer.goToLine(line);
      // Drawn: the page is read and its render is the latest.
      while (!document.querySelector(`.large-text-line[data-line="${line}"]`))
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return (viewer as unknown as { pages: Map<number, unknown> }).pages.size;
  }, PAGES);
  expect(await page.evaluate(() => window.fetchLog.length)).toBeGreaterThanOrEqual(PAGES);
  expect(kept).toBeLessThanOrEqual(64);
  // The latest pages are still there: going back a little reads nothing.
  const before = await page.evaluate(() => window.fetchLog.length);
  await page.evaluate(() => window.largeTextViewer.goToLine(98_500));
  await expect(page.locator(".large-text-line.current")).toHaveText("L000098500");
  expect(await page.evaluate(() => window.fetchLog.length)).toBe(before);
  // The first page went long ago: it is read again, and shows what it did.
  await page.evaluate(() => window.largeTextViewer.goToLine(500));
  await expect(page.locator(".large-text-line.current")).toHaveText("L000000500");
  expect(await page.evaluate(() => window.fetchLog.filter(([start]) => start === 0).length)).toBe(
    2,
  );
});

/** Shows the middle of each of `pages` in turn, waiting for it to be drawn: each visit uses that
 * page alone (a screen and its margin are well inside 1,000 lines). */
function visitPages(page: Page, pages: number[]): Promise<void> {
  return page.evaluate(async (pages) => {
    for (const index of pages) {
      const line = index * 1000 + 500;
      window.largeTextViewer.goToLine(line);
      while (!document.querySelector(`.large-text-line.current[data-line="${line}"]`))
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }, pages);
}

const readsOf = (page: Page, index: number) =>
  page.evaluate(
    (start) => window.fetchLog.filter(([first]) => first === start).length,
    index * 1000 * 11,
  );

// The page let go of is the one used longest ago, not the one read first: a page come back to is
// kept over pages read since and not looked at again.
test("a page looked at again outlasts pages read after it", async ({ page }) => {
  await open(page);
  // As many pages as are kept, then the first one again.
  await visitPages(page, [...Array.from({ length: 64 }, (_, index) => index), 0]);
  expect(await readsOf(page, 0)).toBe(1);
  // One more page than is kept: one goes — page 1, read after page 0 but not used since.
  await visitPages(page, [64, 0]);
  expect(await readsOf(page, 0)).toBe(1);
  await visitPages(page, [1]);
  expect(await readsOf(page, 1)).toBe(2);
});
