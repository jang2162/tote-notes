import { expect, test, type Page } from "@playwright/test";

import { fakeFile } from "../../src/backend/fake";
import { menu, start } from "./helpers";

// A 1×1 PNG; the data: URL the fake issues carries exactly these bytes.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const frame = (page: Page) => page.frameLocator("iframe.viewer-frame");

// The fake's file dialog returns every pick at once, so each 「열기」 gets its own.
const pick = (page: Page, path: string) =>
  page.evaluate((p) => {
    window.__tote.backend.data.picks = [p];
  }, path);

test("an image opens fitted and a click shows it at its real size", async ({ page }) => {
  await start(page, { files: { "/x/점.png": fakeFile(PNG) }, picks: ["/x/점.png"] });
  await menu(page, "open-file");
  const img = frame(page).locator("img.media");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(frame(page).locator("body")).toHaveClass(/fit/);
  await img.click();
  await expect(frame(page).locator("body")).toHaveClass(/actual/);
  await expect(frame(page).locator(".media-caption")).toHaveText("점.png · 1×1");
});

test("a video and an audio file get the native player; a file that cannot play says so", async ({
  page,
}) => {
  await start(page, {
    files: {
      "/x/clip.mp4": fakeFile(new Uint8Array([1, 2, 3, 4])),
      "/x/voice.m4a": fakeFile(new Uint8Array([1, 2, 3, 4])),
    },
    picks: ["/x/clip.mp4"],
  });
  await menu(page, "open-file");
  // Four bytes are not an MP4: the element errors and the viewer says the format is unsupported.
  await expect(frame(page).locator(".media-error")).toHaveText("지원하지 않는 포맷");
  await pick(page, "/x/voice.m4a");
  await menu(page, "open-file");
  await expect(frame(page).locator("audio.media[controls]")).toHaveCount(1);
});

test("the viewer takes the theme's colours and follows a theme change", async ({ page }) => {
  await start(page, { files: { "/x/점.png": fakeFile(PNG) }, picks: ["/x/점.png"] });
  await menu(page, "open-file");
  const body = frame(page).locator("body");
  // Light+ is the default light theme: editor.background #ffffff.
  await expect(body).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.evaluate(async () => {
    const { backend, app } = window.__tote;
    const settings = await backend.settings();
    await backend.updateSettings({
      ...settings,
      theme: { ...settings.theme, light: { extension: "tote.themes", label: "Dark+" } },
    });
    await app.theme.refresh();
  });
  // Dark+ editor.background #1e1e1e, pushed to the open viewer without a reload.
  await expect(body).toHaveCSS("background-color", "rgb(30, 30, 30)");
});

test("opening a PNG shows the media viewer, not the fallback", async ({ page }) => {
  await start(page, { files: { "/x/사진.png": fakeFile(PNG) }, picks: ["/x/사진.png"] });
  await menu(page, "open-file");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  await expect(page.getByText("텍스트로 열기")).toHaveCount(0);
});
