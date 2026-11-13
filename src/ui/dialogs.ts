import type { LanguageInfo } from "../backend/types";
import { h } from "./dom";

/** The modals open now, the last one on top — the keys are its alone — each with what had the
 * focus as it opened. */
const openModals: { backdrop: HTMLElement; opener: Element | null }[] = [];
/** What a modal put out of reach, to give back; what was inert already (a collapsed sidebar)
 * is not in it and stays inert. */
const heldOff = new Set<HTMLElement>();
let titles = 0;
/** Where the keys go when a closed dialog has nowhere to give them back to — set by the app. */
let keysHome: (() => void) | null = null;

/** `home` takes the keys when a dialog closes with nothing to give them back to: nothing had them
 * as it opened (a press on a button takes them off whatever had them, in WebKit), or what had them
 * has left the page or gone inert since. A dialog still open under it takes them first. */
export function giveKeysHomeWith(home: () => void): void {
  keysHome = home;
}

/** Whether a dialog has the window: until it is answered, nothing behind it takes a key, a click
 * or a menu command. */
export function modalOpen(): boolean {
  return openModals.length > 0;
}

/** Everything in the window but the top modal is inert — the page, and a modal under another. */
function holdOffTheRest(): void {
  const top = openModals[openModals.length - 1]?.backdrop;
  for (const each of document.body.children) {
    if (!(each instanceof HTMLElement)) continue;
    const off = top !== undefined && each !== top;
    if (off && !each.inert) {
      each.inert = true;
      heldOff.add(each);
    } else if (!off && heldOff.delete(each)) each.inert = false;
  }
}

/** Gives the keys back to `opener` when it can still take them; else to the dialog left on top,
 * else to `keysHome`. */
function giveKeysBack(opener: Element | null): void {
  if (opener instanceof HTMLElement && opener !== document.body) {
    opener.focus({ preventScroll: true });
    // Not taken when it has left the page or is inert now.
    if (document.activeElement === opener) return;
  }
  const under = openModals[openModals.length - 1]?.backdrop;
  if (!under) return keysHome?.();
  const dialog = under.firstElementChild;
  if (!(dialog instanceof HTMLElement)) return;
  const first = stops(dialog)[0];
  if (first) return first.focus();
  dialog.tabIndex = -1;
  dialog.focus();
}

/** The controls of `dialog` the keys can go to, in order. */
function stops(dialog: HTMLElement): HTMLElement[] {
  const all = dialog.querySelectorAll<HTMLElement>(
    "input, select, textarea, button, summary, a[href], [tabindex]",
  );
  return [...all].filter(
    (each) => each.tabIndex >= 0 && !each.matches(":disabled") && each.getClientRects().length > 0,
  );
}

/** A modal over the window. Resolves with what `build` passes to `close`, or `null` on Escape.
 * The dialog is named by its own `aria-labelledby`, else by its first heading or paragraph. The
 * element marked `data-autofocus` takes the focus, else the first input or primary button, else
 * the dialog itself. While it is open the rest of the window is inert, and Tab past its last
 * control comes round to its first; closed, the focus is back where it was (`giveKeysHomeWith`
 * says where it goes when that is gone).
 * While `holdEscape` says so, Escape on top does nothing: the dialog is in the middle of
 * something that cannot be called off. */
export function modal<T>(
  build: (close: (value: T | null) => void) => HTMLElement,
  options: { holdEscape?: () => boolean } = {},
): Promise<T | null> {
  return new Promise((resolve) => {
    const backdrop = h("div", { class: "modal-backdrop" });
    const self = { backdrop, opener: document.activeElement };
    const onTop = () => openModals[openModals.length - 1] === self;
    const close = (value: T | null) => {
      document.removeEventListener("keydown", onKey, true);
      const at = openModals.indexOf(self);
      if (at >= 0) {
        openModals.splice(at, 1);
        const over = openModals[at];
        backdrop.remove();
        heldOff.delete(backdrop);
        holdOffTheRest();
        // Closed from under another modal, the keys are that one's to keep; opened from this
        // one, it gives them back to where this one would have.
        if (over) {
          if (backdrop.contains(over.opener)) over.opener = self.opener;
        } else giveKeysBack(self.opener);
      }
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (!onTop()) return;
      if (event.key === "Tab") {
        // WebKit decides which controls Tab stops at (the system's keyboard navigation setting);
        // only a Tab that left the dialog is brought back, after it has moved the focus.
        const back = event.shiftKey;
        setTimeout(() => {
          if (!onTop() || backdrop.contains(document.activeElement)) return;
          const inside = stops(dialog);
          (back ? inside[inside.length - 1] : inside[0])?.focus();
        });
        return;
      }
      if (event.key !== "Escape" || isCompositionKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!options.holdEscape?.()) close(null);
    };
    const dialog = build(close);
    dialog.setAttribute("aria-modal", "true");
    const title = dialog.hasAttribute("aria-labelledby") ? null : namingText(dialog);
    if (title) {
      title.id ||= `modal-title-${++titles}`;
      dialog.setAttribute("aria-labelledby", title.id);
    }
    backdrop.append(dialog);
    openModals.push(self);
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    holdOffTheRest();
    (
      backdrop.querySelector<HTMLElement>("[data-autofocus]") ??
      backdrop.querySelector<HTMLElement>("input, button.primary")
    )?.focus();
    // Nothing took it (the one primary button is off): the keys still leave the page behind.
    if (!backdrop.contains(document.activeElement)) {
      dialog.tabIndex = -1;
      dialog.focus();
    }
  });
}

/** The first heading or paragraph with text in it: an empty one would leave the dialog unnamed. */
export function namingText<T extends { textContent: string | null }>(dialog: {
  querySelectorAll(selector: string): Iterable<T>;
}): T | undefined {
  return [...dialog.querySelectorAll("h1, p")].find((each) => each.textContent?.trim());
}

/** A key that belongs to an IME composition. WebKit sends the Enter that finishes a Korean syllable
 * (and the Escape that cancels one) after `compositionend`, with `isComposing` already false but
 * `keyCode` 229. Taking it as a submit would submit the name without its last syllable. */
function isCompositionKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function isSubmitEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !isCompositionKey(event);
}

function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = h("button", { textContent: label, class: className });
  b.addEventListener("click", onClick);
  return b;
}

/** A yes/no question; Escape and 「취소」 answer false. With `tone` "danger" the yes is for
 * something that cannot be undone: it is styled as 「저장하지 않음」 is, and 「취소」 takes the focus,
 * so a stray Enter keeps what is there. */
export async function confirm(message: string, okLabel: string, tone?: "danger"): Promise<boolean> {
  const answer = await modal<boolean>((close) => {
    const cancel = button("취소", () => close(false));
    if (tone === "danger") cancel.dataset.autofocus = "";
    return h(
      "div",
      { class: "modal confirm", role: "dialog" },
      h("p", { textContent: message }),
      h(
        "div",
        { class: "modal-buttons" },
        cancel,
        button(okLabel, () => close(true), tone ?? "primary"),
      ),
    );
  });
  return answer ?? false;
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
        button("저장하지 않음", () => close("discard"), "danger"),
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

/** The status bar's language picker: a filter over ids and display names, the current language
 * in bold. Enter takes the first language shown; with no filter it takes the current language,
 * or nothing (the first of the full list is not a choice the user made). */
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
      if (!input.value.trim()) {
        const current = languages.find((l) => l.id === currentId);
        if (current) close(current);
      } else if (shown[0]) close(shown[0]);
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
