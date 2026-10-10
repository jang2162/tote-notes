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
