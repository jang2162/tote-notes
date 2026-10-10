import type { Backend, ExtensionRegistry, Settings, ThemeRef } from "../backend/types";
import { describeError } from "../app/errors";
import { errorCode } from "../backend/types";
import { Registry } from "../extensions/registry";
import { confirm, modal } from "./dialogs";
import { h } from "./dom";

export interface SettingsOptions {
  backend: Backend;
  registry: () => Registry;
  /** Subscribes to config changes; returns the unsubscribe. */
  onConfigChanged: (handler: () => void) => () => void;
}

const themeValue = (ref: ThemeRef | null) =>
  ref ? JSON.stringify([ref.extension, ref.label]) : "";
const themeRef = (value: string): ThemeRef | null => {
  if (!value) return null;
  const [extension, label] = JSON.parse(value) as [string, string];
  return { extension, label };
};

/** The minimal settings screen (spec 「프론트엔드」): workspace root, light and dark theme, the
 * extension list with install, enable and remove. Every change is saved as it is made. */
export function openSettings(options: SettingsOptions): Promise<void> {
  return modal<true>((close) => {
    const { backend } = options;
    const panel = h("div", { class: "modal settings", role: "dialog" });
    const status = h("p", { class: "modal-error" });
    let settings: Settings | null = null;

    const fail = (error: unknown) => {
      status.textContent = describeError(error);
    };
    const save = async (patch: (s: Settings) => void) => {
      if (!settings) return;
      const next = structuredClone(settings);
      patch(next);
      try {
        await backend.updateSettings(next);
        settings = next;
        status.textContent = "";
      } catch (error) {
        fail(error);
      }
    };

    const rootInput = h("input", { name: "workspaceRoot", placeholder: "~/Tote" });
    const rootSection = () => {
      const pick = h("button", { textContent: "폴더 선택…" });
      pick.addEventListener("click", async () => {
        const folder = await backend.pickFolder();
        if (folder) rootInput.value = folder;
      });
      const saveRoot = h("button", { textContent: "루트 저장", class: "primary" });
      saveRoot.addEventListener(
        "click",
        () => void save((s) => (s.workspaceRoot = rootInput.value.trim() || null)),
      );
      return h(
        "section",
        {},
        h("h2", { textContent: "워크스페이스" }),
        h("div", { class: "settings-row" }, rootInput, pick, saveRoot),
        h("p", {
          class: "settings-note root-note",
          textContent: "루트는 새로 여는 창부터 적용됩니다. 열린 창은 그대로입니다.",
        }),
      );
    };

    const themeSelect = (name: "light" | "dark") => {
      const select = h("select", { name });
      select.addEventListener(
        "change",
        () => void save((s) => (s.theme[name] = themeRef(select.value))),
      );
      return select;
    };
    // Rebuilt on every refresh: installing or switching off a theme extension changes the list.
    const fillThemes = (registry: Registry) => {
      for (const select of [lightSelect, darkSelect]) {
        select.replaceChildren(
          h("option", { value: "", textContent: "기본" }),
          ...registry.themes.map((theme) =>
            h("option", {
              value: themeValue(theme),
              textContent: `${theme.label} (${theme.extension})`,
            }),
          ),
        );
      }
    };
    const lightSelect = themeSelect("light");
    const darkSelect = themeSelect("dark");
    fillThemes(options.registry());
    const themeSection = h(
      "section",
      {},
      h("h2", { textContent: "테마" }),
      h(
        "div",
        { class: "settings-row" },
        h("label", {}, "라이트 ", lightSelect),
        h("label", {}, "다크 ", darkSelect),
      ),
    );

    const list = h("div", { class: "extension-list" });
    const problems = h("ul", { class: "extension-problems" });
    const precedence = (value: "user" | "bundled", label: string) => {
      const radio = h("input", { type: "radio", name: "precedence", value });
      radio.addEventListener("change", () => void save((s) => (s.extensions.precedence = value)));
      return h("label", {}, radio, label);
    };
    const installFile = h("button", { textContent: "파일에서 설치…" });
    const installFolder = h("button", { textContent: "폴더에서 설치…" });
    const install = async (path: string | null) => {
      if (!path) return;
      try {
        await backend.installExtension(path, false);
      } catch (error) {
        if (errorCode(error) !== "already-installed") return fail(error);
        const message = error instanceof Error ? error.message : String(error);
        const [id, version] = message.split(" ");
        if (!(await confirm(`${id} ${version} 이(가) 이미 설치돼 있습니다. 교체할까요?`, "교체")))
          return;
        try {
          await backend.installExtension(path, true);
        } catch (again) {
          fail(again);
        }
      }
    };
    installFile.addEventListener("click", async () =>
      install(await backend.pickExtensionPackage()),
    );
    installFolder.addEventListener("click", async () => install(await backend.pickFolder()));
    const extensionSection = h(
      "section",
      {},
      h("h2", { textContent: "확장" }),
      h(
        "div",
        { class: "settings-row" },
        installFile,
        installFolder,
        h("span", {
          class: "settings-note viewer-note",
          textContent: "사용자 설치 확장의 뷰어는 아직 실리지 않습니다.",
        }),
      ),
      list,
      problems,
      h(
        "div",
        { class: "settings-row" },
        "같은 확장자를 두 확장이 주장하면: ",
        precedence("user", "사용자 설치 우선"),
        precedence("bundled", "번들 우선"),
      ),
    );

    const renderExtensions = (registry: ExtensionRegistry) => {
      list.replaceChildren(
        ...registry.extensions.map((ext) => {
          const row = h("div", { class: `extension-row ${ext.source}` });
          row.append(
            h("span", { class: "extension-name", textContent: ext.displayName }),
            h("span", { class: "extension-id", textContent: `${ext.id}@${ext.version}` }),
            h("span", {
              class: "extension-source",
              textContent: ext.source === "bundled" ? "번들" : "사용자",
            }),
          );
          if (ext.source === "user") {
            const enabled = h("input", { type: "checkbox", checked: ext.enabled, title: "활성" });
            enabled.addEventListener(
              "change",
              () => void backend.setExtensionEnabled(ext.id, enabled.checked).catch(fail),
            );
            const remove = h("button", { textContent: "제거" });
            remove.addEventListener("click", async () => {
              if (await confirm(`${ext.displayName} 을(를) 제거할까요?`, "제거"))
                await backend.removeExtension(ext.id).catch(fail);
            });
            row.append(enabled, remove);
          }
          return row;
        }),
      );
      problems.replaceChildren(
        ...registry.problems.map((p) => h("li", { textContent: `${p.path}: ${p.message}` })),
      );
      problems.hidden = registry.problems.length === 0;
    };

    const refresh = async () => {
      try {
        const [current, registry] = await Promise.all([
          backend.settings(),
          backend.extensionRegistry(),
        ]);
        settings = current;
        fillThemes(new Registry(registry));
        rootInput.value = current.workspaceRoot ?? "";
        lightSelect.value = themeValue(current.theme.light);
        darkSelect.value = themeValue(current.theme.dark);
        panel.querySelector<HTMLInputElement>(
          `input[name=precedence][value=${current.extensions.precedence}]`,
        )!.checked = true;
        renderExtensions(registry);
      } catch (error) {
        fail(error);
      }
    };
    const unsubscribe = options.onConfigChanged(() => void refresh());
    const done = h("button", { textContent: "닫기", class: "primary" });
    done.addEventListener("click", () => {
      unsubscribe();
      close(true);
    });
    panel.append(
      h("h1", { textContent: "설정" }),
      rootSection(),
      themeSection,
      extensionSection,
      status,
      h("div", { class: "modal-buttons" }, done),
    );
    void refresh();
    return panel;
  }).then(() => undefined);
}
