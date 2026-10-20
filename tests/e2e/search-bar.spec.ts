import { expect, test, type Page } from "@playwright/test";

import { contrastRatio } from "../../src/theme/contrast";

const DOC = "my notes\nmy-app\nMySQL";
/** The page loads on a clock that runs; the test then holds it and moves it by hand. */
const LOADED = new Date("2026-01-01T09:00:00");
const PAUSED = new Date("2026-01-01T10:00:00");

async function open(page: Page, doc = DOC) {
  await page.goto(`/tests/e2e/pages/editor.html?doc=${encodeURIComponent(doc)}`);
  await expect(page.locator(".cm-content")).toBeFocused();
}

async function select(page: Page, from: number, to: number) {
  await page.evaluate(
    ([f, t]) => window.view.dispatch({ selection: { anchor: f, head: t } }),
    [from, to],
  );
}

/** Selects `my` at the start and opens the bar with ⌘F, which takes the selection as the query. */
async function openBar(page: Page) {
  await open(page);
  await select(page, 0, 2);
  await page.keyboard.press("Meta+f");
  await expect(input(page)).toBeFocused();
}

const input = (page: Page) => page.locator('input.find-bar-input[name=search][main-field="true"]');
const count = (page: Page) => page.locator(".find-bar-count");
const toggle = (page: Page, name: string) => page.locator(`button.find-bar-toggle[name=${name}]`);
const main = (page: Page) =>
  page.evaluate(() => {
    const { from, to } = window.view.state.selection.main;
    return { from, to };
  });

test("⌘F opens the bar with the selected word", async ({ page }) => {
  await openBar(page);
  await expect(page.locator(".find-bar")).toBeVisible();
  await expect(input(page)).toHaveValue("my");
  await expect(count(page)).toHaveText("1 / 3");
  // The whole query is selected, so typing replaces it.
  expect(
    await input(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([0, 2]);
});

test("Enter and ⇧Enter step through the results", async ({ page }) => {
  await openBar(page);
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("2 / 3");
  expect(await main(page)).toEqual({ from: 9, to: 11 });
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("3 / 3");
  expect(await main(page)).toEqual({ from: 16, to: 18 });
  await page.keyboard.press("Shift+Enter");
  await expect(count(page)).toHaveText("2 / 3");
  expect(await main(page)).toEqual({ from: 9, to: 11 });
  await expect(input(page)).toBeFocused();
});

test("typing recounts without moving", async ({ page }) => {
  await openBar(page);
  await page.keyboard.type("notes");
  await expect(input(page)).toHaveValue("notes");
  await expect(count(page)).toHaveText("– / 1");
  expect(await main(page)).toEqual({ from: 0, to: 2 });
});

test("a change to the memo is counted once it rests", async ({ page }) => {
  await page.clock.install({ time: LOADED });
  await openBar(page);
  await expect(count(page)).toHaveText("1 / 3");
  await page.clock.pauseAt(PAUSED);
  await page.evaluate(() => window.view.dispatch({ changes: { from: 0, insert: "my " } }));
  // No scan per key typed in the memo: frames go by and the old count stays until it has rested.
  await page.clock.runFor(149);
  await expect(count(page)).toHaveText("1 / 3");
  await page.clock.runFor(1);
  // The selection moved along with its match, now the second of four.
  await expect(count(page)).toHaveText("2 / 4");
});

test("the toggles change the query", async ({ page }) => {
  await openBar(page);
  await expect(toggle(page, "case")).toHaveAttribute("aria-pressed", "false");
  await toggle(page, "case").click();
  await expect(toggle(page, "case")).toHaveAttribute("aria-pressed", "true");
  await expect(count(page)).toHaveText("1 / 2");
  expect(await page.evaluate(() => window.view.state.doc.toString())).toBe(DOC);

  await toggle(page, "re").click();
  await expect(toggle(page, "re")).toHaveAttribute("aria-pressed", "true");
  await input(page).fill("(");
  await expect(count(page)).toHaveText("잘못된 정규식");
  await expect(input(page)).toHaveAttribute("aria-invalid", "true");

  await input(page).fill("nowhere");
  await expect(count(page)).toHaveText("결과 없음");
  await expect(input(page)).not.toHaveAttribute("aria-invalid", "true");

  await input(page).fill("");
  await expect(count(page)).toHaveText("");
});

test("the labels say what each button does", async ({ page }) => {
  await openBar(page);
  const labels: [string, string, string][] = [
    ["case", "대소문자 구분", "Aa"],
    ["word", "단어 단위", "ab"],
    ["re", "정규식", ".*"],
    ["prev", "이전 결과", "↑"],
    ["next", "다음 결과", "↓"],
    ["replace-toggle", "바꾸기 펼치기", "⇄"],
    ["close", "닫기", "×"],
  ];
  for (const [name, label, text] of labels) {
    const button = page.locator(`.find-bar-find button[name="${name}"]`);
    await expect(button).toHaveAttribute("aria-label", label);
    await expect(button).toHaveAttribute("title", label);
    await expect(button).toHaveText(text);
  }
  await expect(page.locator('button[name="replace-toggle"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(input(page)).toHaveAttribute("placeholder", "찾기");
});

test("the arrow buttons step and the close button closes", async ({ page }) => {
  await openBar(page);
  await page.locator('button[name="next"]').click();
  await expect(count(page)).toHaveText("2 / 3");
  await page.locator('button[name="prev"]').click();
  await expect(count(page)).toHaveText("1 / 3");
  await page.locator('button[name="close"]').click();
  await expect(page.locator(".find-bar")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("Esc closes the bar and gives the keys back", async ({ page }) => {
  await openBar(page);
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("2 / 3");
  await page.keyboard.press("Escape");
  await expect(page.locator(".find-bar")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await main(page)).toEqual({ from: 9, to: 11 });
});

test("⌘G steps from the find field", async ({ page }) => {
  await openBar(page);
  await page.keyboard.press("Meta+g");
  await expect(count(page)).toHaveText("2 / 3");
  await page.keyboard.press("Shift+Meta+g");
  await expect(count(page)).toHaveText("1 / 3");
});

test("⌘F again with another word puts it in the open bar", async ({ page }) => {
  await openBar(page);
  await page.locator(".cm-content").focus();
  await select(page, 3, 8);
  await page.keyboard.press("Meta+f");
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("notes");
  await expect(count(page)).toHaveText("1 / 1");
});

test("⌘F in the focused find field selects the whole query", async ({ page }) => {
  await openBar(page);
  await input(page).evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 2));
  await page.keyboard.press("Meta+f");
  await expect(input(page)).toBeFocused();
  expect(
    await input(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([0, 2]);
});

test("a composing Enter in the find field does not move", async ({ page }) => {
  await page.clock.install({ time: LOADED });
  await openBar(page);
  await page.keyboard.type("my");
  await expect(count(page)).toHaveText("1 / 3");
  await page.clock.pauseAt(PAUSED);
  const prevented = await input(page).evaluate((el) =>
    // WebKit can also send the committing Enter after compositionend: not composing, key code 229.
    [true, false].map((isComposing) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing,
        bubbles: true,
        cancelable: true,
      });
      if (!isComposing) Object.defineProperty(event, "keyCode", { value: 229 });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  // The input method needs the key to commit the syllable.
  expect(prevented).toEqual([false, false]);
  // Give a move, and the recount after it, the time to happen: frames, and the memo's rest.
  await page.clock.runFor(150);
  await expect(count(page)).toHaveText("1 / 3");
  expect(await main(page)).toEqual({ from: 0, to: 2 });
});

test("⌘Z in the find field leaves the memo alone", async ({ page }) => {
  await openBar(page);
  // Something for the memo's history to take back, so a stray undo would show.
  await page.evaluate(() => window.view.dispatch({ changes: { from: 0, insert: "A " } }));
  const before = await page.evaluate(() => window.view.state.doc.toString());
  await input(page).focus();
  // macOS End does not move the caret of a field; past the selected query it goes.
  await input(page).evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 2));
  await page.keyboard.type("x");
  await expect(input(page)).toHaveValue("myx");
  await page.keyboard.press("Meta+z");
  await expect(input(page)).toHaveValue(/^myx?$/);
  expect(await page.evaluate(() => window.view.state.doc.toString())).toBe(before);
  // Past what the field has to take back: still not the memo's history.
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  await expect(input(page)).toBeFocused();
  expect(await page.evaluate(() => window.view.state.doc.toString())).toBe(before);
  await page.keyboard.press("Shift+Meta+z");
  expect(await page.evaluate(() => window.view.state.doc.toString())).toBe(before);
});

const replaceRow = (page: Page) => page.locator(".find-bar-replace");
const replaceInput = (page: Page) => page.locator("input.find-bar-input[name=replace]");
const replaceToggle = (page: Page) => page.locator('button[name="replace-toggle"]');
const doc = (page: Page) => page.evaluate(() => window.view.state.doc.toString());

test("⇄ shows the replace row and remembers it", async ({ page }) => {
  await openBar(page);
  await expect(replaceRow(page)).toBeHidden();
  await replaceToggle(page).click();
  await expect(replaceRow(page)).toBeVisible();
  await expect(replaceToggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(replaceInput(page)).toHaveAttribute("placeholder", "바꿀 내용");
  await expect(page.locator('.find-bar-replace button[name="replace"]')).toHaveText("바꾸기");
  await expect(page.locator('.find-bar-replace button[name="replace-all"]')).toHaveText(
    "모두 바꾸기",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".find-bar")).toHaveCount(0);
  await page.keyboard.press("Meta+f");
  await expect(input(page)).toBeFocused();
  await expect(replaceRow(page)).toBeVisible();
  await expect(replaceToggle(page)).toHaveAttribute("aria-pressed", "true");
  // And ⇄ folds it again; the focus it was holding goes to the find field.
  await replaceInput(page).focus();
  await replaceToggle(page).click();
  await expect(replaceRow(page)).toBeHidden();
  await expect(replaceToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(input(page)).toBeFocused();
});

test("⌥⌘F opens with the replace row", async ({ page }) => {
  await open(page);
  await expect(page.locator(".find-bar")).toHaveCount(0);
  await page.keyboard.press("Meta+Alt+f");
  await expect(page.locator(".find-bar")).toBeVisible();
  await expect(replaceRow(page)).toBeVisible();
  await expect(replaceToggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(input(page)).toBeFocused();
});

test("⌥⌘F in the open bar unfolds the replace row", async ({ page }) => {
  await openBar(page);
  await expect(replaceRow(page)).toBeHidden();
  await page.keyboard.press("Meta+Alt+f");
  await expect(replaceRow(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
});

/** "a a a" with the first `a` selected, the bar open on it and `b` to replace it with. */
async function openReplace(page: Page) {
  await open(page, "a a a");
  await select(page, 0, 1);
  await page.keyboard.press("Meta+Alt+f");
  await expect(input(page)).toHaveValue("a");
  await expect(count(page)).toHaveText("1 / 3");
  await replaceInput(page).fill("b");
}

test("바꾸기 replaces the current result and moves on", async ({ page }) => {
  await openReplace(page);
  await page.locator('button[name="replace"]').click();
  expect(await doc(page)).toBe("b a a");
  expect(await main(page)).toEqual({ from: 2, to: 3 });
  await expect(count(page)).toHaveText("1 / 2");
  // Enter in the replace field does the same.
  await expect(replaceInput(page)).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await doc(page)).toBe("b b a");
  expect(await main(page)).toEqual({ from: 4, to: 5 });
  await expect(replaceInput(page)).toBeFocused();
});

test("모두 바꾸기 is one ⌘Z away", async ({ page }) => {
  await open(page, "a a a");
  // Typing just before: one ⌘Z takes back the replace and stops short of the typing.
  await select(page, 5, 5);
  await page.keyboard.type(" x");
  await select(page, 0, 1);
  await page.keyboard.press("Meta+Alt+f");
  await expect(count(page)).toHaveText("1 / 3");
  await replaceInput(page).fill("b");
  await page.locator('button[name="replace-all"]').click();
  expect(await doc(page)).toBe("b b b x");
  await expect(count(page)).toHaveText("결과 없음");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+z");
  expect(await doc(page)).toBe("a a a x");
  // ⌘Enter in the replace field replaces them all too.
  await replaceInput(page).focus();
  await page.keyboard.press("Meta+Enter");
  expect(await doc(page)).toBe("b b b x");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+z");
  expect(await doc(page)).toBe("a a a x");
});

test("a regexp replace uses groups", async ({ page }) => {
  await openReplace(page);
  await toggle(page, "re").click();
  await input(page).fill("(a)");
  await replaceInput(page).fill("[$1]");
  await page.locator('button[name="replace-all"]').click();
  expect(await doc(page)).toBe("[a] [a] [a]");
});

test("a composing Enter in the replace field does not replace", async ({ page }) => {
  await openReplace(page);
  const prevented = await replaceInput(page).evaluate((el) =>
    [true, false].map((isComposing) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing,
        bubbles: true,
        cancelable: true,
      });
      if (!isComposing) Object.defineProperty(event, "keyCode", { value: 229 });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  expect(prevented).toEqual([false, false]);
  expect(await doc(page)).toBe("a a a");
});

/** The colour of each text in the bar and what it sits on, read as RGBA through a canvas pixel
 * (WebKit reports `color-mix()` as `color(srgb …)`, which `contrastRatio` does not read). */
function barColours(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (colour: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
    };
    const alpha = (colour: string) => Number(/([\d.]+)\)$/.exec(colour)![1]);
    /** The innermost painted background, and the opaque one it is mixed over. */
    const backdrop = (el: Element) => {
      let bg: string | null = null;
      for (let at: Element | null = el; at; at = at.parentElement) {
        const colour = rgba(getComputedStyle(at).backgroundColor);
        if (alpha(colour) === 0) continue;
        if (bg === null) bg = colour;
        if (alpha(colour) === 1) return { bg, base: colour };
      }
      return { bg: bg ?? "rgba(255, 255, 255, 1)", base: "rgba(255, 255, 255, 1)" };
    };
    const texts = [
      ...document.querySelectorAll(".find-bar-input, .find-bar-count, .find-bar button"),
    ];
    return texts.map((el) => ({
      what: `${el.className}${el.getAttribute("name") ? `[${el.getAttribute("name")}]` : ""} ${el.getAttribute("aria-pressed") ?? ""}`,
      fg: rgba(getComputedStyle(el).color),
      ...backdrop(el),
    }));
  });
}

for (const scheme of ["dark", "light"] as const) {
  test(`the bar's text meets the contrast floor (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openBar(page);
    // The app's stylesheet, without the app's grid layout around the page.
    await page.addStyleTag({ url: "/src/styles.css" });
    await page.addStyleTag({ content: "body { display: block; }" });
    await expect(page.locator(".find-bar")).toHaveCSS("padding-top", "6px");
    await replaceToggle(page).click();
    await expect(replaceRow(page)).toBeVisible();
    await toggle(page, "case").click();
    await expect(count(page)).toHaveText("1 / 2");
    const states = [await barColours(page)];
    await toggle(page, "re").click();
    await input(page).fill("(");
    await expect(count(page)).toHaveText("잘못된 정규식");
    states.push(await barColours(page));
    for (const colours of states) {
      // The find row's field, count and seven buttons; the replace row's field and two buttons.
      expect(colours.length).toBe(12);
      for (const { what, fg, bg, base } of colours) {
        const ratio = contrastRatio(fg, bg, base);
        expect(ratio, `${what}: ${fg} on ${bg} over ${base}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
}
