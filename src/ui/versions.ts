import type { Version } from "../backend/types";
import { modal } from "./dialogs";
import { h } from "./dom";

/** `20261012-153000` → `2026-10-12 15:30:00`: the snapshot's folder name is its local time. */
export function versionLabel(snapshot: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(snapshot);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : snapshot;
}

/** 「이전 버전」: the versions on the left, newest first and the newest shown, the picked one's text
 * on the right, read-only. Resolves with the version to restore, or `null` on Escape or 「취소」.
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
    const pick = async (version: Version, row: HTMLElement) => {
      const mine = ++request;
      for (const other of rows) other.classList.toggle("current", other === row);
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
    const rows = versions.map((version) => {
      const row = h("li", { textContent: versionLabel(version.snapshot), title: version.file });
      row.addEventListener("click", () => void pick(version, row));
      return row;
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
      h(
        "div",
        { class: "versions-body" },
        h("ul", { class: "picker-list version-list" }, ...rows),
        preview,
      ),
      h("div", { class: "modal-buttons" }, cancel, restore),
    );
  });
}
