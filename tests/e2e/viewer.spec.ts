import { expect, test, type FrameLocator, type Page } from "@playwright/test";

const frame = (page: Page): FrameLocator => page.frameLocator("iframe.viewer-frame");

test("the host sends init after ready, answers resolveRelative and passes the theme", async ({
  page,
}) => {
  await page.goto("/tests/e2e/pages/viewer.html");
  const body = frame(page).locator("body");
  await expect(body).toHaveAttribute("data-file", "사진.png");
  const echo = JSON.parse((await body.getAttribute("data-echo"))!);
  expect(echo.init).toMatchObject({
    type: "init",
    extension: "png",
    size: 3,
    url: "data:image/png;base64,AAAA",
  });
  expect(echo.probes.origin).toBe("null");
  expect(echo.probes.tauri).toBe("undefined");
  expect(echo.probes.parent).toMatch(/^blocked: SecurityError/);
  await expect(body).toHaveAttribute(
    "data-resolved",
    JSON.stringify({ type: "resolved", id: 1, url: "data:image/png;base64,AAAA" }),
  );
  await expect(body).toHaveCSS("background-color", "rgb(1, 2, 3)");
  await page.evaluate(() => window.viewerHost.setTheme({ "--bg": "rgb(4, 5, 6)" }));
  await expect(body).toHaveCSS("background-color", "rgb(4, 5, 6)");
  // The viewer's own CSP stopped its fetch before it left the page.
  await expect(page.locator("#log")).toHaveText("error: csp:https://example.com/");
});

test("the iframe is sandboxed without same-origin, popups, forms or navigation", async ({
  page,
}) => {
  await page.goto("/tests/e2e/pages/viewer.html");
  expect(await page.locator("iframe.viewer-frame").getAttribute("sandbox")).toBe("allow-scripts");
});

test("a viewer that never answers shows the fallback", async ({ page }) => {
  await page.goto(
    "/tests/e2e/pages/viewer.html?viewer=/tests/e2e/pages/viewers/silent.html&timeout=300",
  );
  await expect(page.locator("#log")).toHaveText("error: 뷰어가 응답하지 않습니다");
});

test("a viewer that reports an error shows the fallback with its message", async ({ page }) => {
  await page.goto("/tests/e2e/pages/viewer.html?viewer=/tests/e2e/pages/viewers/failing.html");
  await expect(page.locator("#log")).toHaveText("error: boom");
});

test("the host passes a null resolveRelative answer through", async ({ page }) => {
  await page.goto(
    "/tests/e2e/pages/viewer.html?viewer=/tests/e2e/pages/viewers/echo.html%3Frel%3D..%2Fsecret.png",
  );
  const body = frame(page).locator("body");
  await expect(body).toHaveAttribute(
    "data-resolved",
    JSON.stringify({ type: "resolved", id: 1, url: null }),
  );
});

test("messages from any other window are ignored", async ({ page }) => {
  await page.goto(
    "/tests/e2e/pages/viewer.html?viewer=/tests/e2e/pages/viewers/ok.html&intruder=1",
  );
  await expect(frame(page).locator("body")).toHaveAttribute("data-file", "사진.png");
  await expect(page.locator("body")).toHaveAttribute("data-intruder", "seen");
  await expect(page.locator("#log")).toHaveText("");
});

// Spec 2026-11-14 md-preview 「뷰어 API 추가」: what a preview asks is checked by the host first.

const previewCalls = (page: Page) => page.evaluate(() => window.previewCalls);

test("a preview's requests reach its tab only in the shape and for the text on show", async ({
  page,
}) => {
  await page.goto(
    "/tests/e2e/pages/viewer.html?preview=1&viewer=/tests/e2e/pages/viewers/requests.html",
  );
  const body = frame(page).locator("body");
  await expect(body).toHaveAttribute("data-init", /"version":1/);
  expect(JSON.parse((await body.getAttribute("data-init"))!)).toMatchObject({
    type: "init",
    text: "- [ ] a",
    version: 1,
    readOnly: false,
  });
  await expect(body).toHaveAttribute("data-resolved", "9");
  expect(await previewCalls(page)).toEqual([
    ["highlight", [{ index: 0, lang: "ts", code: "a" }]],
    ["toggleTask", 0, "- [ ] a"],
    ["openLink", "https://example.com/ok"],
  ]);
  await expect(body).toHaveAttribute("data-highlighted", /"req":4/);
  expect(JSON.parse((await body.getAttribute("data-highlighted"))!)).toEqual({
    type: "highlighted",
    version: 1,
    req: 4,
    blocks: [{ index: 0, lines: [[{ text: "a", color: "#ff0000", fontStyle: 0 }]] }],
  });
});

test("an update numbers the text anew, and a request for the old one is dropped", async ({
  page,
}) => {
  await page.goto(
    "/tests/e2e/pages/viewer.html?preview=1&viewer=/tests/e2e/pages/viewers/requests.html",
  );
  await expect.poll(() => previewCalls(page)).toHaveLength(3);
  await page.evaluate(() => window.viewerHost.update("- [x] a"));
  // The viewer asks again only on init; a stale request now carries version 1.
  await frame(page)
    .locator("body")
    .evaluate(() => parent.postMessage({ type: "toggleTask", version: 1, index: 0 }, "*"));
  await frame(page)
    .locator("body")
    .evaluate(() => parent.postMessage({ type: "toggleTask", version: 2, index: 0 }, "*"));
  await expect.poll(() => previewCalls(page)).toHaveLength(4);
  expect((await previewCalls(page))[3]).toEqual(["toggleTask", 0, "- [x] a"]);
});

test("a preview's requests from any other window are ignored", async ({ page }) => {
  await page.goto(
    "/tests/e2e/pages/viewer.html?preview=1&viewer=/tests/e2e/pages/viewers/ok.html&intruder=1",
  );
  await expect(frame(page).locator("body")).toHaveAttribute("data-file", "할일.md");
  // The intruder's last message is its error: by the time it is seen, so are the others.
  await expect(page.locator("body")).toHaveAttribute("data-intruder", "seen");
  expect(await previewCalls(page)).toEqual([]);
  await expect(page.locator("#log")).toHaveText("");
});

test("a viewer given no preview requests has them dropped", async ({ page }) => {
  await page.goto("/tests/e2e/pages/viewer.html?viewer=/tests/e2e/pages/viewers/requests.html");
  await expect(frame(page).locator("body")).toHaveAttribute("data-resolved", "9");
  await expect(page.locator("#log")).toHaveText("");
  expect(await previewCalls(page)).toEqual([]);
});

const MARKDOWN_VIEWER = "/extensions/tote.markdown-preview/viewer.html";

test("the Markdown viewer asks for a task's box by its number, and not at all for a read-only tab", async ({
  page,
}) => {
  const text = encodeURIComponent("- [ ] 하나\n- [x] 둘");
  await page.goto(`/tests/e2e/pages/viewer.html?preview=1&viewer=${MARKDOWN_VIEWER}&text=${text}`);
  const boxes = frame(page).locator("input[type=checkbox]");
  await expect(boxes).toHaveCount(2);
  await boxes.nth(1).click();
  await expect.poll(() => previewCalls(page)).toEqual([["toggleTask", 1, "- [ ] 하나\n- [x] 둘"]]);
  // Unchanged until the host draws the text again.
  await expect(boxes.nth(1)).toBeChecked();

  await page.goto(
    `/tests/e2e/pages/viewer.html?preview=1&viewer=${MARKDOWN_VIEWER}&text=${text}&readonly`,
  );
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toBeDisabled();
  await boxes.nth(0).click({ force: true });
  await boxes.nth(0).dispatchEvent("click");
  // A link press after it is the sign the box's would have arrived by now.
  await page.evaluate(() => window.viewerHost.update("- [ ] 하나\n\n[웹](https://example.com/)"));
  await frame(page).locator("a").click();
  await expect.poll(() => previewCalls(page)).toEqual([["openLink", "https://example.com/"]]);
  await expect(boxes.nth(0)).not.toBeChecked();
});

test("the Markdown viewer takes messages from its host alone", async ({ page }) => {
  await page.goto(`/tests/e2e/pages/viewer.html?preview=1&viewer=${MARKDOWN_VIEWER}`);
  await expect(frame(page).locator("li")).toHaveText("a");
  await page.evaluate(() => window.forge());
  await expect(page.locator("body")).toHaveAttribute("data-forged", "sent");
  // The host's own message after it: drawn means the forged one, sent before, was seen first.
  await page.evaluate(() => window.viewerHost.update("# 진짜"));
  await expect(frame(page).locator("h1")).toHaveText("진짜");
  await expect(frame(page).locator("body")).not.toHaveCSS("background-color", "rgb(9, 9, 9)");
});
