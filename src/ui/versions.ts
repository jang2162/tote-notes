import type { Version } from "../backend/types";
import { isCompositionKey, modal } from "./dialogs";
import { h } from "./dom";

/** Numbers the dialogs: the rows' element IDs are the page's alone. */
let opened = 0;

const SNAPSHOT_NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

/** `20261012-153000` → `2026-10-12 15:30:00`: the snapshot's folder name is its local time. A run
 * shows both ends, the date only once when both fall on one day. */
export function versionLabel(version: Pick<Version, "snapshot" | "until">): string {
  const from = SNAPSHOT_NAME.exec(version.snapshot);
  const to = SNAPSHOT_NAME.exec(version.until);
  if (!from || !to) return version.snapshot;
  const date = (m: RegExpExecArray) => `${m[1]}-${m[2]}-${m[3]}`;
  const time = (m: RegExpExecArray) => `${m[4]}:${m[5]}:${m[6]}`;
  const start = `${date(from)} ${time(from)}`;
  if (version.until === version.snapshot) return start;
  return date(from) === date(to) ? `${start} – ${time(to)}` : `${start} – ${date(to)} ${time(to)}`;
}

/** 「이전 버전」: the versions on the left, newest first and the newest shown, the picked one's text
 * on the right, read-only. The list has the keys: ↑↓ Home End pick, Enter restores the one shown
 * (list keyboard spec 「이전 버전 목록」). Resolves with the version to restore, or `null` on
 * Escape or 「취소」.
 * `read` turns a version into its text; what it throws is shown in place of the text. */
export function openVersions(
  versions: Version[],
  read: (version: Version) => Promise<string>,
): Promise<{ snapshot: string; text: string } | null> {
  return modal<{ snapshot: string; text: string }>((close) => {
    const preview = h("pre", { class: "version-preview" });
    const restore = h("button", { textContent: "이 버전으로 되돌리기", class: "primary" });
    let shown: { snapshot: string; text: string } | null = null;
    // A slow read of an earlier click must not overwrite a later one's text.
    let request = 0;
    const prefix = `version-option-${++opened}`;
    let at = 0;
    const pick = async (version: Version, row: HTMLLIElement) => {
      const mine = ++request;
      at = rows.indexOf(row);
      for (const other of rows) {
        other.classList.toggle("current", other === row);
        other.setAttribute("aria-selected", String(other === row));
      }
      list.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView?.({ block: "nearest" });
      shown = null;
      restore.disabled = true;
      preview.classList.remove("error");
      preview.textContent = "";
      try {
        const text = await read(version);
        if (mine !== request) return;
        shown = { snapshot: version.snapshot, text };
        preview.textContent = text;
        restore.disabled = false;
      } catch (error) {
        if (mine !== request) return;
        preview.classList.add("error");
        preview.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    const rows = versions.map((version, index) => {
      const row = h("li", {
        textContent: versionLabel(version),
        title: version.file,
        id: `${prefix}-${index}`,
      });
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.addEventListener("click", () => void pick(version, row));
      return row;
    });
    const list = h(
      "ul",
      { class: "picker-list version-list", tabIndex: 0, data: { autofocus: "" } },
      ...rows,
    );
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "버전");
    list.addEventListener("keydown", (event) => {
      if (isCompositionKey(event) || event.metaKey || event.altKey || event.ctrlKey) return;
      const to = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: rows.length - 1 }[event.key];
      if (to !== undefined) {
        event.preventDefault();
        const next = Math.max(0, Math.min(to, rows.length - 1));
        if (next !== at && versions[next]) void pick(versions[next], rows[next]);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (shown) close(shown);
      }
    });
    const cancel = h("button", { textContent: "취소" });
    cancel.addEventListener("click", () => close(null));
    restore.addEventListener("click", () => {
      if (shown) close(shown);
    });
    if (versions[0]) void pick(versions[0], rows[0]);
    return h(
      "div",
      { class: "modal versions", role: "dialog" },
      h("p", { textContent: "이전 버전" }),
      h("div", { class: "versions-body" }, list, preview),
      h("div", { class: "modal-buttons" }, cancel, restore),
    );
  });
}
