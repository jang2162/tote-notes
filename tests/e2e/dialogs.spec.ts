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

  // A create still running is not started again; one that rejects keeps the dialog open.
  await page.evaluate(() => {
    window.result = 0;
    void window.workspacePicker([], {
      open: () => {},
      create: () => {
        window.result = (window.result as number) + 1;
        return new Promise(() => {});
      },
    });
  });
  await page.locator(".modal input").fill("느린 곳");
  await page.getByRole("button", { name: "만들기" }).dblclick();
  await page.locator(".modal input").press("Enter");
  await expect.poll(() => page.evaluate(() => window.result)).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);

  await page.evaluate(
    () =>
      void window.workspacePicker([], {
        open: () => {},
        create: () => Promise.reject(new Error("<b>디스크가 가득 찼습니다</b>")),
      }),
  );
  await page.locator(".modal input").fill("실패할 곳");
  await page.getByRole("button", { name: "만들기" }).click();
  await expect(page.locator(".modal-error")).toHaveText("<b>디스크가 가득 찼습니다</b>");
  await expect(page.locator(".modal-error b")).toHaveCount(0);
  await expect(page.locator(".modal")).toHaveCount(1);
});

// The picker closes itself when its create finishes, and Escape may have closed it before.
test("a modal closed twice leaves the one under it able to take Escape", async ({ page }) => {
  await page.evaluate(() => {
    void window.promptText("under", "x");
    (window as unknown as { finish: () => void }).finish = () => {};
    void window.workspacePicker([], {
      open: () => {},
      create: () =>
        new Promise((resolve) => {
          (window as unknown as { finish: () => void }).finish = () => resolve(null);
        }),
    });
  });
  await page.locator(".modal.picker input").fill("새것");
  await page.locator(".modal.picker button", { hasText: "만들기" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
});
