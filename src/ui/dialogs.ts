import type { LanguageInfo, WorkspaceListItem } from "../backend/types";
import { h } from "./dom";

/** A modal over the window. Resolves with what `build` passes to `close`, or `null` on Escape. */
function modal<T>(build: (close: (value: T | null) => void) => HTMLElement): Promise<T | null> {
  return new Promise((resolve) => {
    const backdrop = h("div", { class: "modal-backdrop" });
    const close = (value: T | null) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isCompositionKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      close(null);
    };
    backdrop.append(build(close));
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    backdrop.querySelector<HTMLElement>("input, button.primary")?.focus();
  });
}

/** A key that belongs to an IME composition. WebKit sends the Enter that finishes a Korean syllable
 * (and the Escape that cancels one) after `compositionend`, with `isComposing` already false but
 * `keyCode` 229. Taking it as a submit would submit the name without its last syllable. */
function isCompositionKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

function isSubmitEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !isCompositionKey(event);
}

function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = h("button", { textContent: label, class: className });
  b.addEventListener("click", onClick);
  return b;
}

export type UnsavedChoice = "save" | "discard" | "cancel";

export async function askUnsaved(name: string): Promise<UnsavedChoice> {
  const choice = await modal<UnsavedChoice>((close) =>
    h(
      "div",
      { class: "modal", role: "dialog" },
      h("p", { textContent: `「${name}」의 바뀐 내용을 저장할까요?` }),
      h("p", { class: "modal-note", textContent: "저장하지 않으면 바뀐 내용이 사라집니다." }),
      h(
        "div",
        { class: "modal-buttons" },
        button("버리기", () => close("discard"), "danger"),
        button("취소", () => close("cancel")),
        button("저장", () => close("save"), "primary"),
      ),
    ),
  );
  return choice ?? "cancel";
}

export function promptText(message: string, initial: string): Promise<string | null> {
  return modal<string>((close) => {
    const input = h("input", { value: initial });
    input.spellcheck = false;
    input.addEventListener("keydown", (event) => {
      if (!isSubmitEnter(event)) return;
      event.preventDefault();
      close(input.value);
    });
    // Select the name without its extension, the part people usually change.
    queueMicrotask(() => {
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    });
    return h(
      "div",
      { class: "modal", role: "dialog" },
      h("p", { textContent: message }),
      input,
      h(
        "div",
        { class: "modal-buttons" },
        button("취소", () => close(null)),
        button("확인", () => close(input.value), "primary"),
      ),
    );
  });
}

export interface PickerActions {
  open(path: string): void;
  /** Resolves with the reason a name was refused, or `null` when the workspace was made. */
  create(name: string): Promise<string | null>;
}

export async function workspacePicker(
  items: WorkspaceListItem[],
  actions: PickerActions,
): Promise<void> {
  await modal<true>((close) => {
    const list = h(
      "ul",
      { class: "picker-list" },
      ...items.map((item) => {
        const li = h("li", {
          textContent: item.open ? `${item.name} (열림)` : item.name,
          title: item.path,
        });
        li.addEventListener("click", () => {
          actions.open(item.path);
          close(true);
        });
        return li;
      }),
    );
    const input = h("input", { placeholder: "새 워크스페이스 이름" });
    input.spellcheck = false;
    const error = h("p", { class: "modal-error" });
    let creating = false;
    const create = async () => {
      if (creating) return;
      creating = true;
      try {
        const problem = await actions.create(input.value.trim());
        if (problem) error.textContent = problem;
        else close(true);
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
      } finally {
        creating = false;
      }
    };
    input.addEventListener("keydown", (event) => {
      if (!isSubmitEnter(event)) return;
      event.preventDefault();
      void create();
    });
    return h(
      "div",
      { class: "modal picker", role: "dialog" },
      h("p", { textContent: "워크스페이스" }),
      list,
      h(
        "div",
        { class: "picker-create" },
        input,
        button("만들기", () => void create(), "primary"),
      ),
      error,
    );
  });
}

/** The status bar's language picker: a filter over ids and display names, the current language
 * in bold. Enter takes the first language shown. */
export function pickLanguage(
  languages: LanguageInfo[],
  currentId: string | null,
): Promise<LanguageInfo | null> {
  return modal<LanguageInfo>((close) => {
    const input = h("input", { placeholder: "언어 이름" });
    input.spellcheck = false;
    const list = h("ul", { class: "picker-list" });
    let shown = languages;
    const render = () => {
      const query = input.value.trim().toLocaleLowerCase();
      shown = languages.filter(
        (l) => !query || [l.id, ...l.aliases].some((n) => n.toLocaleLowerCase().includes(query)),
      );
      list.replaceChildren(
        ...shown.map((lang) => {
          const li = h("li", {
            textContent: lang.aliases[0] ?? lang.id,
            class: lang.id === currentId ? "current" : "",
          });
          li.addEventListener("click", () => close(lang));
          return li;
        }),
      );
    };
    input.addEventListener("input", render);
    input.addEventListener("keydown", (event) => {
      if (!isSubmitEnter(event)) return;
      event.preventDefault();
      if (shown[0]) close(shown[0]);
    });
    render();
    return h(
      "div",
      { class: "modal picker", role: "dialog" },
      h("p", { textContent: "언어" }),
      input,
      list,
    );
  });
}
