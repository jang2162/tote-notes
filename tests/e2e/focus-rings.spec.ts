import { expect, test, type Locator, type Page } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { menu, start } from "./helpers";

/** The controls under `root` whose focus ring a scrolling or clipping box cuts: each is focused as
 * Tab would focus it — scrolled into view — and its ring (the outline outside the border) must lie
 * inside the visible box of every ancestor that clips. */
async function clippedRings(root: Locator): Promise<string[]> {
  return root.evaluate((root) => {
    const controls = root.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    const cut: string[] = [];
    for (const control of controls) {
      if (control.getClientRects().length === 0 || control.matches(":disabled")) continue;
      // As Tab brings a control into view: to the nearest edge, where a ring is most often cut.
      control.focus({ preventScroll: true });
      control.scrollIntoView({ block: "nearest", inline: "nearest" });
      const style = getComputedStyle(control);
      const ring =
        style.outlineStyle === "none"
          ? 0
          : parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      const own = control.getBoundingClientRect();
      for (let box = control.parentElement; box; box = box.parentElement) {
        const clip = getComputedStyle(box);
        if (clip.overflowX === "visible" && clip.overflowY === "visible") continue;
        const edge = box.getBoundingClientRect();
        const left = edge.left + parseFloat(clip.borderLeftWidth);
        const top = edge.top + parseFloat(clip.borderTopWidth);
        const sides = {
          left: own.left - ring - left,
          top: own.top - ring - top,
          right: left + box.clientWidth - (own.right + ring),
          bottom: top + box.clientHeight - (own.bottom + ring),
        };
        const short = Object.entries(sides).filter(([, room]) => room < -0.5);
        if (short.length > 0) {
          const name =
            control.getAttribute("name") ??
            control.getAttribute("aria-label") ??
            (control.textContent?.trim() || control.className);
          cut.push(
            `${control.tagName.toLowerCase()} 「${name}」 in .${box.className}: ${short
              .map(([side, room]) => `${side} ${room.toFixed(1)}`)
              .join(", ")}`,
          );
        }
      }
    }
    return cut;
  });
}

async function eachSection(page: Page): Promise<Locator> {
  await menu(page, "settings");
  return page.locator(".modal.settings");
}

for (const scheme of ["light", "dark"] as const) {
  test(`no focus ring is cut in any section of the settings screen (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await start(page);
    const panel = await eachSection(page);
    const tabs = panel.getByRole("tab");
    const names = await tabs.allTextContents();
    expect(names.length).toBeGreaterThan(3);
    for (const name of names) {
      await panel.getByRole("tab", { name, exact: true }).click();
      expect.soft(await clippedRings(panel), name).toEqual([]);
    }
  });
}

// Measured clean when the settings panel was fixed (2026-10-26); kept so a new clipping box shows.
test("no focus ring is cut in the dialogs, the find bar or the window around them", async ({
  page,
}) => {
  await start(page, {
    memos: { a: fakeMemo("회의.md", "v3 회의") },
    backups: { a: [{ snapshot: "20261012-100000", file: "회의.md", text: "v1" }] },
  });
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await expect(page.locator(".cm-content")).toHaveText("v3 회의");
  const report: Record<string, string[]> = {};
  for (const [command, selector] of [
    ["rename", ".modal"],
    ["open-workspace", ".modal"],
    ["new-workspace", ".modal"],
    ["versions", ".modal"],
  ] as const) {
    await menu(page, command);
    await expect(page.locator(selector)).toBeVisible();
    report[command] = await clippedRings(page.locator(selector));
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal")).toHaveCount(0);
  }
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+f");
  await expect(page.locator(".find-bar")).toBeVisible();
  report.find = await clippedRings(page.locator(".find-bar"));
  await menu(page, "search-workspace");
  report.search = await clippedRings(page.locator("body"));
  await page.evaluate(() =>
    window.__tote.backend.offerUpdate({ version: "0.2.0", current: "0.1.0", notes: "x" }),
  );
  await expect(page.locator(".modal.update")).toBeVisible();
  report.update = await clippedRings(page.locator(".modal.update"));
  expect(report).toEqual({
    rename: [],
    "open-workspace": [],
    "new-workspace": [],
    versions: [],
    find: [],
    search: [],
    update: [],
  });
});
