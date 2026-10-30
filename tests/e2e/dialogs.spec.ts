import { expect, test } from "@playwright/test";

import { menu, start } from "./helpers";

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

test("the workspace picker shows why a name was refused", async ({ page }) => {
  await page.evaluate(
    () =>
      void window.workspacePicker(
        [
          {
            name: "메모",
            path: "/w/메모",
            open: true,
            windows: 1,
            missing: false,
            order: 0,
            hidden: false,
            orderable: true,
          },
        ],
        {
          open: () => {},
          relocate: async () => null,
          create: async (name) => (name === "" ? "쓸 수 없는 이름입니다" : null),
        },
      ),
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
      relocate: async () => null,
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
        relocate: async () => null,
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
      relocate: async () => null,
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

test("a missing workspace offers to relocate", async ({ page }) => {
  await start(page, {
    workspaces: [
      { name: "메모", path: "/fake/메모", open: true, windows: 1, missing: false },
      { name: "옛", path: "/gone/옛", open: false, windows: 0, missing: true },
    ],
    picks: ["/new/옛"],
  });
  await menu(page, "open-workspace");
  const row = page.locator(".picker-list li", { hasText: "옛" });
  await expect(row).toHaveText("옛 (찾을 수 없음)");
  await row.click();
  await expect(page.locator(".modal")).toHaveCount(0);
  const relocations = () => page.evaluate(() => window.__tote.backend.data.relocations);
  expect(await relocations()).toEqual([{ from: "/gone/옛", to: "/new/옛" }]);
});

test("the picker still lists a hidden workspace", async ({ page }) => {
  // Recently used first, as the backend lists them; hiding is for the switcher only.
  await start(page, {
    workspaces: [
      { name: "메모", path: "/fake/메모", open: true, windows: 1, missing: false },
      { name: "숨김", path: "/fake/숨김", open: false, windows: 0, missing: false, hidden: true },
    ],
  });
  await menu(page, "open-workspace");
  await expect(page.locator(".picker-list li")).toHaveText(["메모 (열림)", "숨김"]);
});

test("cancelling the folder dialog keeps the picker open with nothing relocated", async ({
  page,
}) => {
  await page.goto("/tests/e2e/pages/dialogs.html");
  await page.evaluate(
    () =>
      void window.workspacePicker(
        [
          {
            name: "옛",
            path: "/gone/옛",
            open: false,
            windows: 0,
            missing: true,
            order: null,
            hidden: false,
            orderable: false,
          },
        ],
        {
          open: () => {},
          create: async () => null,
          relocate: async () => "",
        },
      ),
  );
  await page.locator(".picker-list li").click();
  await expect(page.locator(".modal")).toHaveCount(1);
  await expect(page.locator(".modal-error")).toHaveText("");
});

test("pointing a missing workspace at a plain folder says so in Korean", async ({ page }) => {
  await start(page, {
    workspaces: [{ name: "옛", path: "/gone/옛", open: false, windows: 0, missing: true }],
    picks: ["/plain"],
    notWorkspaces: ["/plain"],
  });
  await menu(page, "open-workspace");
  await page.locator(".picker-list li").click();
  await expect(page.locator(".modal-error")).toHaveText("워크스페이스가 아닌 폴더입니다");
  await expect(page.locator(".modal")).toHaveCount(1);
});
