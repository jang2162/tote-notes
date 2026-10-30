import type { Backend, ExtensionRegistry, SettingsPatch, ThemeRef } from "../backend/types";
import { describeError } from "../app/errors";
import { EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN, errorCode } from "../backend/types";
import { Registry } from "../extensions/registry";
import { confirm, isSubmitEnter, modal } from "./dialogs";
import { h } from "./dom";
import { shortcutsSection } from "./shortcut-settings";
import { workspacesSection } from "./workspace-settings";

export type SettingsSection =
  | "general"
  | "workspaces"
  | "sidebar"
  | "editor"
  | "appearance"
  | "shortcuts"
  | "extensions";

const SECTIONS: [SettingsSection, string][] = [
  ["general", "일반"],
  ["workspaces", "워크스페이스"],
  ["sidebar", "사이드바"],
  ["editor", "편집기"],
  ["appearance", "모양"],
  ["shortcuts", "단축키"],
  ["extensions", "확장"],
];

export interface SettingsOptions {
  backend: Backend;
  registry: () => Registry;
  /** Subscribes to config changes; returns the unsubscribe. */
  onConfigChanged: (handler: () => void) => () => void;
  /** Subscribes to the workspace list changing (`Backend.onWorkspacesChanged`); returns the
   * unsubscribe. */
  onWorkspacesChanged: (handler: () => void) => () => void;
  /** The section shown first; 「일반」 without one. */
  section?: SettingsSection;
  /** Hears each section picked, for the next opening to start there. */
  onSection?: (section: SettingsSection) => void;
}

const themeValue = (ref: ThemeRef | null) =>
  ref ? JSON.stringify([ref.extension, ref.label]) : "";
const themeRef = (value: string): ThemeRef | null => {
  if (!value) return null;
  const [extension, label] = JSON.parse(value) as [string, string];
  return { extension, label };
};

/** The settings screen: a list of sections on the left, the picked one's settings on the right.
 * Every change is saved as it is made; the workspace root, a path, waits for 「적용」 or Enter. */
export function openSettings(options: SettingsOptions): Promise<void> {
  let disposeShortcuts = () => {};
  let disposeWorkspaces = () => {};
  /** The screen's config subscriptions: they end with it, whichever way it closes. */
  const subscriptions: (() => void)[] = [];
  const onConfigChanged = (handler: () => void) => {
    const unsubscribe = options.onConfigChanged(handler);
    subscriptions.push(unsubscribe);
    return unsubscribe;
  };
  return modal<true>((close) => {
    const { backend } = options;
    const panel = h("div", { class: "modal settings", role: "dialog" });
    const status = h("p", { class: "modal-error" });
    status.setAttribute("aria-live", "polite");
    /** What each typed field last got from the saved settings: input differing from it is an
     * edit not saved yet, which another setting's change must not wipe. */
    const synced = new Map<HTMLInputElement, string>();
    const sync = (input: HTMLInputElement, saved: string) => {
      if (input.value === (synced.get(input) ?? "") || input.value.trim() === saved)
        input.value = saved;
      synced.set(input, saved);
    };
    /** Saves a typed field on Enter as on leaving it. */
    const onEnter = (input: HTMLInputElement, commit: () => void) => {
      input.addEventListener("keydown", (event) => {
        if (!isSubmitEnter(event)) return;
        event.preventDefault();
        commit();
      });
    };
    const field = (label: string, control: HTMLInputElement | HTMLSelectElement) => {
      control.id = `settings-${control.name}`;
      return [h("label", { htmlFor: control.id, textContent: label }), control];
    };

    const fail = (error: unknown) => {
      status.textContent = describeError(error);
    };
    // Only the field changed here is sent: a switch flipped a moment ago, or another window's
    // settings screen saving its own field, stays as the backend has it.
    const save = async (patch: SettingsPatch): Promise<boolean> => {
      try {
        await backend.patchSettings(patch);
        status.textContent = "";
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    };
    /** Saves a typed field's value, taken as saved at once: Enter and the `change` that may follow
     * it send it once. A save that fails gives the field its saved value back, so the same value
     * goes out again on the next Enter. */
    const saveTyped = async (input: HTMLInputElement, sent: string, patch: SettingsPatch) => {
      const before = synced.get(input) ?? "";
      synced.set(input, sent);
      if (!(await save(patch)) && synced.get(input) === sent) synced.set(input, before);
    };

    // The placeholder is the default root, as the backend names it once the screen has asked.
    const rootInput = h("input", { name: "workspaceRoot" });
    rootInput.spellcheck = false;
    const autoCheck = h("input", { type: "checkbox", name: "updatesAutoCheck" });
    autoCheck.addEventListener("change", () => void save({ updatesAutoCheck: autoCheck.checked }));
    const generalSection = () => {
      const pick = h("button", { textContent: "폴더 선택…" });
      pick.addEventListener("click", async () => {
        try {
          // At the root in use: the default one, `~/.tote`, is hidden from a dialog left where it was.
          const folder = await backend.pickFolder((await backend.workspaceRoots()).current);
          if (folder) rootInput.value = folder;
        } catch (error) {
          fail(error);
        }
      });
      // A path is saved once it is whole, not as it is typed.
      const saveRoot = () => void save({ workspaceRoot: rootInput.value.trim() || null });
      const apply = h("button", { textContent: "적용" });
      apply.addEventListener("click", saveRoot);
      onEnter(rootInput, saveRoot);
      const [label] = field("워크스페이스 루트", rootInput);
      return h(
        "div",
        { class: "settings-form" },
        label,
        h("div", { class: "settings-row" }, rootInput, pick, apply),
        h("p", {
          class: "settings-note root-note",
          textContent: "루트는 새로 여는 창부터 적용됩니다. 열린 창은 그대로입니다.",
        }),
        ...field("실행할 때 업데이트 확인", autoCheck),
        h("p", {
          class: "settings-note update-note",
          textContent:
            "끄면 Tote Notes 는 실행할 때 github.com 에 새 버전을 묻지 않습니다. 메뉴 Tote Notes → 업데이트 확인… 으로 직접 확인할 수 있습니다.",
        }),
      );
    };

    const preview = h("input", { type: "checkbox", name: "sidebarPreview" });
    preview.addEventListener("change", () => void save({ sidebarPreview: preview.checked }));
    const sidebarSection = h(
      "div",
      { class: "settings-form" },
      ...field("메모 목록에 내용 미리보기", preview),
    );

    const lineNumbers = h("input", { type: "checkbox", name: "editorLineNumbers" });
    lineNumbers.addEventListener(
      "change",
      () => void save({ editorLineNumbers: lineNumbers.checked }),
    );
    const fontSize = h("input", {
      type: "number",
      name: "editorFontSize",
      min: String(EDITOR_FONT_SIZE_MIN),
      max: String(EDITOR_FONT_SIZE_MAX),
      step: "1",
    });
    // The backend clamps as well; clamping here first is what lets the field show the size saved.
    const commitFontSize = () => {
      const typed = fontSize.value.trim() === "" ? NaN : Number(fontSize.value);
      const saved = synced.get(fontSize) ?? "";
      if (!Number.isFinite(typed)) {
        fontSize.value = saved;
        return;
      }
      const size = Math.min(
        EDITOR_FONT_SIZE_MAX,
        Math.max(EDITOR_FONT_SIZE_MIN, Math.round(typed)),
      );
      fontSize.value = String(size);
      if (fontSize.value === saved) return;
      void saveTyped(fontSize, fontSize.value, { editorFontSize: size });
    };
    fontSize.addEventListener("change", commitFontSize);
    onEnter(fontSize, commitFontSize);
    const fontFamily = h("input", { name: "editorFontFamily", placeholder: "기본 글꼴" });
    fontFamily.spellcheck = false;
    const commitFontFamily = () => {
      const font = fontFamily.value.trim();
      if (font === (synced.get(fontFamily) ?? "")) return;
      void saveTyped(fontFamily, font, { editorFontFamily: font });
    };
    fontFamily.addEventListener("change", commitFontFamily);
    onEnter(fontFamily, commitFontFamily);
    const editorSection = h(
      "div",
      { class: "settings-form" },
      ...field("줄번호 표시", lineNumbers),
      ...field("글꼴 크기", fontSize),
      ...field("글꼴", fontFamily),
    );

    const themeSelect = (name: "light" | "dark") => {
      const select = h("select", { name });
      select.addEventListener(
        "change",
        () =>
          void save(
            name === "light"
              ? { themeLight: themeRef(select.value) }
              : { themeDark: themeRef(select.value) },
          ),
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
    // A theme whose extension is off or gone is not an option; the default theme is what shows.
    const selectTheme = (select: HTMLSelectElement, ref: ThemeRef | null) => {
      select.value = themeValue(ref);
      if (select.selectedIndex < 0) select.value = "";
    };
    const lightSelect = themeSelect("light");
    const darkSelect = themeSelect("dark");
    fillThemes(options.registry());
    const appearanceSection = h(
      "div",
      { class: "settings-form" },
      ...field("라이트 테마", lightSelect),
      ...field("다크 테마", darkSelect),
    );

    const list = h("div", { class: "extension-list" });
    const problems = h("ul", { class: "extension-problems" });
    const precedence = (value: "user" | "bundled", label: string) => {
      const radio = h("input", { type: "radio", name: "precedence", value });
      radio.addEventListener("change", () => void save({ precedence: value }));
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
    const pickAndInstall = async (pick: () => Promise<string | null>) => {
      try {
        await install(await pick());
      } catch (error) {
        fail(error);
      }
    };
    installFile.addEventListener(
      "click",
      () => void pickAndInstall(() => backend.pickExtensionPackage()),
    );
    installFolder.addEventListener("click", () => void pickAndInstall(() => backend.pickFolder()));
    const extensionSection = h(
      "div",
      {},
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
        const [current, registry, roots] = await Promise.all([
          backend.settings(),
          backend.extensionRegistry(),
          backend.workspaceRoots(),
        ]);
        fillThemes(new Registry(registry));
        sync(rootInput, current.workspaceRoot ?? "");
        rootInput.placeholder = roots.defaultShown;
        lineNumbers.checked = current.editor.lineNumbers;
        preview.checked = current.sidebar.preview;
        autoCheck.checked = current.updates.autoCheck;
        sync(fontSize, String(current.editor.fontSize));
        sync(fontFamily, current.editor.fontFamily);
        selectTheme(lightSelect, current.theme.light);
        selectTheme(darkSelect, current.theme.dark);
        panel.querySelector<HTMLInputElement>(
          `input[name=precedence][value=${current.extensions.precedence}]`,
        )!.checked = true;
        renderExtensions(registry);
      } catch (error) {
        fail(error);
      }
    };
    onConfigChanged(() => void refresh());
    const done = h("button", { textContent: "닫기", class: "primary" });
    done.addEventListener("click", () => close(true));

    const shortcuts = shortcutsSection({ backend, onConfigChanged });
    disposeShortcuts = shortcuts.dispose;
    const workspaces = workspacesSection({
      backend,
      onWorkspacesChanged: options.onWorkspacesChanged,
      fail,
      saved: () => (status.textContent = ""),
    });
    disposeWorkspaces = workspaces.dispose;
    const contents: Record<SettingsSection, HTMLElement> = {
      general: generalSection(),
      workspaces: workspaces.el,
      sidebar: sidebarSection,
      editor: editorSection,
      appearance: appearanceSection,
      shortcuts: shortcuts.el,
      extensions: extensionSection,
    };
    const tabs = SECTIONS.map(([section, label]) => {
      const tab = h("button", {
        class: "settings-tab",
        id: `settings-tab-${section}`,
        role: "tab",
        textContent: label,
      });
      tab.setAttribute("aria-controls", `settings-panel-${section}`);
      tab.addEventListener("click", () => show(section));
      const body = h(
        "div",
        { class: "settings-panel", id: `settings-panel-${section}`, role: "tabpanel" },
        contents[section],
      );
      body.setAttribute("aria-labelledby", tab.id);
      return { section, tab, body };
    });
    const show = (section: SettingsSection, focus = false) => {
      for (const each of tabs) {
        const shown = each.section === section;
        each.tab.setAttribute("aria-selected", String(shown));
        // One stop for Tab in the list; the arrows move within it.
        each.tab.tabIndex = shown ? 0 : -1;
        each.body.hidden = !shown;
        if (shown && focus) each.tab.focus();
      }
      options.onSection?.(section);
    };
    const tabList = h(
      "div",
      { class: "settings-tabs", role: "tablist" },
      ...tabs.map((each) => each.tab),
    );
    tabList.setAttribute("aria-orientation", "vertical");
    tabList.addEventListener("keydown", (event) => {
      const at = tabs.findIndex((each) => each.tab.getAttribute("aria-selected") === "true");
      const to =
        event.key === "ArrowDown"
          ? (at + 1) % tabs.length
          : event.key === "ArrowUp"
            ? (at - 1 + tabs.length) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : -1;
      if (to < 0) return;
      event.preventDefault();
      show(tabs[to].section, true);
    });
    const initial = options.section ?? "general";
    show(initial);
    tabs.find((each) => each.section === initial)!.tab.dataset.autofocus = "";

    const title = h("h1", { id: "settings-title", textContent: "설정" });
    panel.setAttribute("aria-labelledby", title.id);
    panel.append(
      title,
      h("div", { class: "settings-body" }, tabList, ...tabs.map((each) => each.body)),
      status,
      h("div", { class: "modal-buttons" }, done),
    );
    void refresh();
    return panel;
  }).then(() => {
    disposeShortcuts();
    disposeWorkspaces();
    for (const unsubscribe of subscriptions) unsubscribe();
  });
}
