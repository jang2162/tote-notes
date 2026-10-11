import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

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

/** A solid-colour PNG of any size, made here so a test can open one taller than the window. */
function solidPng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** 0.1 s of 8 kHz mono silence: a WAV the WebView can really play. */
function silentWav(): Uint8Array {
  const samples = 800;
  const out = Buffer.alloc(44 + samples);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(8000, 24);
  out.writeUInt32LE(8000, 28);
  out.writeUInt16LE(1, 32);
  out.writeUInt16LE(8, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples, 40);
  out.fill(0x80, 44); // 8-bit PCM silence
  return new Uint8Array(out);
}

// 64×64, half a second, H.264 — small enough to keep in the repository.
const TINY_MP4 = new Uint8Array(readFileSync(new URL("./fixtures/tiny.mp4", import.meta.url)));

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

test("a video and an audio file that play get the native controls and keep them", async ({
  page,
}) => {
  await start(page, {
    files: { "/x/clip.mp4": fakeFile(TINY_MP4), "/x/voice.wav": fakeFile(silentWav()) },
    picks: ["/x/clip.mp4"],
  });
  await menu(page, "open-file");
  await expect(frame(page).locator("video.media[controls]")).toHaveCount(1);
  await expect(frame(page).locator("audio.media")).toHaveCount(0);
  await page.waitForTimeout(2000);
  await expect(frame(page).locator("video.media[controls]")).toHaveCount(1);
  await expect(frame(page).locator(".media-error")).toHaveCount(0);

  await pick(page, "/x/voice.wav");
  await menu(page, "open-file");
  await expect(frame(page).locator("audio.media[controls]")).toHaveCount(1);
  await expect(frame(page).locator("video.media")).toHaveCount(0);
  await page.waitForTimeout(2000);
  await expect(frame(page).locator("audio.media[controls]")).toHaveCount(1);
  await expect(frame(page).locator(".media-error")).toHaveCount(0);
});

test("a file that cannot play says so", async ({ page }) => {
  await start(page, {
    files: { "/x/clip.mp4": fakeFile(new Uint8Array([1, 2, 3, 4])) },
    picks: ["/x/clip.mp4"],
  });
  await menu(page, "open-file");
  // Four bytes are not an MP4: the element errors and the viewer says the format is unsupported.
  await expect(frame(page).locator(".media-error")).toHaveText("지원하지 않는 포맷");
  await expect(frame(page).locator("video.media")).toHaveCount(0);
});

test("a tall image fits the window and scrolls at its real size", async ({ page }) => {
  await start(page, {
    files: { "/x/세로.png": fakeFile(solidPng(400, 3000)) },
    picks: ["/x/세로.png"],
  });
  await menu(page, "open-file");
  const img = frame(page).locator("img.media");
  const stage = frame(page).locator("#stage");
  await expect(frame(page).locator(".media-caption")).toHaveText("세로.png · 400×3000");
  const fitted = await img.boundingBox();
  const area = await stage.boundingBox();
  expect(fitted!.height).toBeLessThanOrEqual(area!.height);
  await img.click();
  await expect(frame(page).locator("body")).toHaveClass(/actual/);
  expect((await img.boundingBox())!.height).toBe(3000);
  expect(await stage.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});

test("the viewer takes the theme's colours and follows a theme change", async ({ page }) => {
  await start(page, { files: { "/x/점.png": fakeFile(PNG) }, picks: ["/x/점.png"] });
  await menu(page, "open-file");
  const body = frame(page).locator("body");
  // Light+ is the default light theme: editor.background #ffffff.
  await expect(body).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.evaluate(async () => {
    const { backend, app } = window.__tote;
    await backend.patchSettings({ themeLight: { extension: "tote.themes", label: "Dark+" } });
    await app.theme.refresh();
  });
  // Dark+ editor.background #1e1e1e, pushed to the open viewer without a reload.
  await expect(body).toHaveCSS("background-color", "rgb(30, 30, 30)");
});

test("the first paint already carries the configured theme", async ({ page }) => {
  await start(page, { files: { "/x/점.png": fakeFile(PNG) } });
  await page.evaluate(async () => {
    const { backend, app } = window.__tote;
    await backend.patchSettings({ themeLight: { extension: "tote.themes", label: "Dark+" } });
    await app.theme.refresh();
    backend.data.picks = ["/x/점.png"];
  });
  await menu(page, "open-file");
  // Dark+ editor.background #1e1e1e, from `init` itself rather than a later theme message.
  await expect(frame(page).locator("body")).toHaveCSS("background-color", "rgb(30, 30, 30)");
});

test("opening a PNG shows the media viewer, not the fallback", async ({ page }) => {
  await start(page, { files: { "/x/사진.png": fakeFile(PNG) }, picks: ["/x/사진.png"] });
  await menu(page, "open-file");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  await expect(page.getByText("텍스트로 열기")).toHaveCount(0);
});
