import { expect, test } from "@playwright/test";

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
