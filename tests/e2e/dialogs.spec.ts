import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/pages/dialogs.html");
});

test("the unsaved-changes question answers with the button pressed; Escape cancels", async ({
  page,
}) => {
  await page.evaluate(() => void window.askUnsaved("a.sh").then((r) => (window.result = r)));
  await page.getByRole("button", { name: "저장" }).click();
  await expect.poll(() => page.evaluate(() => window.result)).toBe("save");
  await page.evaluate(() => void window.askUnsaved("a.sh").then((r) => (window.result = r)));
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => window.result)).toBe("cancel");
  await expect(page.locator(".modal")).toHaveCount(0);
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
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.result)).toBe("회의록.md");
});

test("the workspace picker shows why a name was refused", async ({ page }) => {
  await page.evaluate(
    () =>
      void window.workspacePicker([{ name: "메모", path: "/w/메모", open: true }], {
        open: () => {},
        create: async (name) => (name === "" ? "쓸 수 없는 이름입니다" : null),
      }),
  );
  await expect(page.locator(".picker-list li")).toHaveText(["메모 (열림)"]);
  await page.getByRole("button", { name: "만들기" }).click();
  await expect(page.locator(".modal-error")).toHaveText("쓸 수 없는 이름입니다");
  await page.locator(".modal input").fill("새 곳");
  await page.getByRole("button", { name: "만들기" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
});
