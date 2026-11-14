import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/pages/dialogs.html");
});

test("the unsaved-changes question answers with the button pressed; Escape cancels", async ({
  page,
}) => {
  await page.evaluate(() => void window.askUnsaved("a.sh").then((r) => (window.result = r)));
  // Exact: 「저장하지 않음」 holds 「저장」 too.
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.result)).toBe("save");
  await page.evaluate(() => void window.askUnsaved("a.sh").then((r) => (window.result = r)));
  await page.getByRole("button", { name: "저장하지 않음" }).click();
  await expect.poll(() => page.evaluate(() => window.result)).toBe("discard");
  await page.evaluate(() => void window.askUnsaved("a.sh").then((r) => (window.result = r)));
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => window.result)).toBe("cancel");
  await expect(page.locator(".modal")).toHaveCount(0);
});

test("a dialog whose first paragraph is empty is named by the first one with text", async ({
  page,
}) => {
  await page.evaluate(() => {
    void window.modal((close) => {
      const dialog = document.createElement("div");
      dialog.className = "modal";
      dialog.setAttribute("role", "dialog");
      // An error line that has nothing to say yet, ahead of the question.
      const status = document.createElement("p");
      status.className = "modal-error";
      const question = document.createElement("p");
      question.textContent = "이름 붙는 글";
      const ok = document.createElement("button");
      ok.textContent = "확인";
      ok.addEventListener("click", () => close(true));
      dialog.append(status, question, ok);
      return dialog;
    });
  });
  await expect(page.getByRole("dialog", { name: "이름 붙는 글" })).toBeVisible();
});

test("Enter that finishes a composition does not submit", async ({ page }) => {
  await page.evaluate(
    () => void window.promptText("새 파일 이름", "메모.md").then((r) => (window.result = r)),
  );
  const input = page.locator(".modal input");
  await expect(input).toBeFocused();
  await input.fill("회의록.md");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229 });
  await expect(page.locator(".modal")).toHaveCount(1);
  // WebKit's real case: the composition already ended, only the key code says so.
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: false, keyCode: 229 });
  await expect(page.locator(".modal")).toHaveCount(1);
  // The other half: no key code, but still composing.
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(page.locator(".modal")).toHaveCount(1);
  await input.dispatchEvent("keydown", { key: "Escape", isComposing: false, keyCode: 229 });
  await expect(page.locator(".modal")).toHaveCount(1);
  await input.dispatchEvent("keydown", { key: "Escape", isComposing: true });
  await expect(page.locator(".modal")).toHaveCount(1);
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.result)).toBe("회의록.md");
});

// A dialog may close itself when what it started finishes, after Escape has closed it already.
test("a modal closed twice leaves the one under it able to take Escape", async ({ page }) => {
  await page.evaluate(() => {
    void window.promptText("under", "x");
    void window.modal((close) => {
      (window as unknown as { finish: () => void }).finish = () => close(null);
      const dialog = document.createElement("div");
      dialog.className = "modal top";
      dialog.append(document.createElement("input"));
      return dialog;
    });
  });
  await expect(page.locator(".modal.top input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
});

/** What a window has behind its dialogs: a field with the keys, and a button. */
async function pageBehind(page: Page): Promise<void> {
  await page.evaluate(() => {
    const main = document.createElement("main");
    const field = document.createElement("input");
    field.className = "behind";
    const press = document.createElement("button");
    press.textContent = "뒤";
    main.append(field, press);
    document.body.append(main);
    field.focus();
  });
}

const keysInDialog = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest(".modal") != null);

test("Tab and ⇧Tab keep the keys in the dialog, and what is typed off the page behind", async ({
  page,
}) => {
  await pageBehind(page);
  await page.evaluate(() => void window.promptText("새 파일 이름", "메모.md"));
  await expect(page.locator(".modal input")).toBeFocused();
  // Past either end, whichever controls this WebKit stops at: more presses than the dialog has stops.
  for (const key of [
    "Tab",
    "Tab",
    "Tab",
    "Tab",
    "Shift+Tab",
    "Shift+Tab",
    "Shift+Tab",
    "Alt+Tab",
  ]) {
    await page.keyboard.press(key);
    await expect.poll(() => keysInDialog(page), { message: `after ${key}` }).toBe(true);
    await page.keyboard.type("x");
  }
  await expect(page.locator(".behind")).toHaveValue("");
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(page.locator("main")).not.toHaveAttribute("inert");
});

test("a dialog with nothing to focus takes the keys itself", async ({ page }) => {
  await pageBehind(page);
  await page.evaluate(() => {
    void window.modal(() => {
      const dialog = document.createElement("div");
      dialog.className = "modal";
      dialog.setAttribute("role", "dialog");
      // The versions dialog as it opens: its only primary button is off until a version is read.
      const off = document.createElement("button");
      off.className = "primary";
      off.disabled = true;
      dialog.append(off);
      return dialog;
    });
  });
  await expect(page.locator(".modal")).toBeFocused();
  await page.keyboard.type("x");
  await expect(page.locator(".behind")).toHaveValue("");
});

test("a closed dialog gives the keys back to where they were", async ({ page }) => {
  await pageBehind(page);
  await page.evaluate(() => void window.promptText("under", "x"));
  await expect(page.locator(".modal input")).toBeFocused();
  await page.evaluate(() => void window.askUnsaved("a.sh"));
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".behind")).toBeFocused();
});

test("a dialog under another is out of reach too, and what was inert before stays so", async ({
  page,
}) => {
  await pageBehind(page);
  await page.evaluate(() => {
    // A part of the window that is out of reach for its own reason: a collapsed sidebar.
    const aside = document.createElement("aside");
    aside.inert = true;
    document.body.append(aside);
    void window.promptText("under", "x");
    void window.modal((close) => {
      (window as unknown as { finish: () => void }).finish = () => close(null);
      const dialog = document.createElement("div");
      dialog.className = "modal top";
      dialog.append(document.createElement("input"));
      return dialog;
    });
  });
  const backdrops = page.locator(".modal-backdrop");
  await expect(backdrops.first()).toHaveAttribute("inert", "");
  await expect(backdrops.last()).not.toHaveAttribute("inert");
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
  await expect(backdrops).toHaveCount(1);
  await expect(backdrops).not.toHaveAttribute("inert");
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(page.locator("main")).not.toHaveAttribute("inert");
  await expect(page.locator("aside")).toHaveAttribute("inert", "");
});

// The update dialog closes itself as its work ends, whatever is over it by then.
test("a dialog closed from under another leaves the page behind out of reach", async ({ page }) => {
  await pageBehind(page);
  await page.evaluate(() => {
    void window.modal((close) => {
      (window as unknown as { finish: () => void }).finish = () => close(null);
      const dialog = document.createElement("div");
      dialog.className = "modal under";
      dialog.append(document.createElement("input"));
      return dialog;
    });
    void window.promptText("over", "x");
  });
  await expect(page.locator(".modal").last().locator("input")).toBeFocused();
  await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
  await expect(page.locator(".modal")).toHaveCount(1);
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(page.locator(".modal input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("main")).not.toHaveAttribute("inert");
  await expect(page.locator(".behind")).toBeFocused();
});

// Past the last control WebKit stops at (which controls those are is the system's keyboard
// navigation setting), a Tab takes the keys off the page, with the setting on or off. The key alone,
// without the browser's move, makes that the only thing that happens here, whichever controls this
// WebKit stops at.
test("a Tab that leaves the keys on nothing brings them back into the dialog", async ({ page }) => {
  await pageBehind(page);
  await page.evaluate(() => void window.promptText("새 파일 이름", "메모.md"));
  const tabOffThePage = (shiftKey: boolean) =>
    page.evaluate((shiftKey) => {
      (document.activeElement as HTMLElement).blur();
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }),
      );
    }, shiftKey);
  await expect(page.locator(".modal input")).toBeFocused();
  await tabOffThePage(true);
  await expect(page.getByRole("button", { name: "확인" })).toBeFocused();
  await tabOffThePage(false);
  await expect(page.locator(".modal input")).toBeFocused();
});
