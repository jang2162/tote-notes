// The items of the memo row's, the tab's and the trashed row's context menus, each decided in one
// function: a wider selection (several memos at once) widens these (conveniences spec 「메뉴」).

import {
  MENU_SEPARATOR,
  type MemoInfo,
  type PopupMenuItem,
  type WorkspaceListItem,
} from "../backend/types";

export const RENAME = "rename";
export const PIN = "pin";
export const DUPLICATE = "duplicate";
export const REVEAL_IN_FINDER = "reveal-in-finder";
export const COPY_PATH = "copy-path";
export const TRASH = "trash";
export const RESTORE = "restore";
export const PURGE = "purge";
/** The submenu's own id is never picked; its items are `move-to:<workspace path>`. */
export const MOVE_TO = "move-to";
const MOVE_TO_PREFIX = `${MOVE_TO}:`;

/** Where a memo of the workspace at `current` can move: the workspaces the switcher shows, in its
 * order, but this one. */
export function moveTargets(list: WorkspaceListItem[], current: string): WorkspaceListItem[] {
  return list
    .filter((item) => !item.missing && !item.hidden && item.path !== current)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
}

/** The workspace a pick of the move submenu names, else `null`. */
export function movePick(picked: string | null): string | null {
  return picked?.startsWith(MOVE_TO_PREFIX) ? picked.slice(MOVE_TO_PREFIX.length) : null;
}

/** A memo row's menu. With no workspace to move to, the move item is left out. */
export function memoRowMenu(info: MemoInfo, targets: WorkspaceListItem[]): PopupMenuItem[] {
  const move: PopupMenuItem[] = targets.length
    ? [
        {
          id: MOVE_TO,
          text: "다른 워크스페이스로 옮기기",
          items: targets.map((item) => ({
            id: `${MOVE_TO_PREFIX}${item.path}`,
            text: item.name.normalize("NFC"),
          })),
        },
      ]
    : [];
  return [
    { id: RENAME, text: "이름 바꾸기…" },
    { id: PIN, text: info.pinned ? "고정 해제" : "맨 위에 고정" },
    { id: DUPLICATE, text: "복제" },
    ...move,
    MENU_SEPARATOR,
    { id: REVEAL_IN_FINDER, text: "Finder 에서 보기" },
    { id: COPY_PATH, text: "경로 복사" },
    MENU_SEPARATOR,
    { id: TRASH, text: "휴지통으로 이동" },
  ];
}

/** What a tab's menu has after its splits and its move to a new window: a memo's copy, then the
 * file's place, for every kind of tab. */
export function tabFileItems(kind: "memo" | "external" | "trashed"): PopupMenuItem[] {
  return [
    MENU_SEPARATOR,
    ...(kind === "memo" ? [{ id: DUPLICATE, text: "복제" }] : []),
    { id: REVEAL_IN_FINDER, text: "Finder 에서 보기" },
    { id: COPY_PATH, text: "경로 복사" },
  ];
}

/** A trashed row's menu. */
export function trashRowMenu(): PopupMenuItem[] {
  return [
    { id: RESTORE, text: "복구" },
    { id: REVEAL_IN_FINDER, text: "Finder 에서 보기" },
    MENU_SEPARATOR,
    { id: PURGE, text: "영구 삭제" },
  ];
}

/** `name` with 「으로」 after a final consonant other than ㄹ, else 「로」: 「회사로」, 「업무로」,
 * 「메일함으로」. A name that does not end in Hangul gets 「(으)로」, which reads right either
 * way. */
export function withRo(name: string): string {
  const last = name.normalize("NFC").at(-1) ?? "";
  const code = last.codePointAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return `${name}(으)로`;
  const final = (code - 0xac00) % 28;
  // 0: no final consonant; 8: ㄹ.
  return final === 0 || final === 8 ? `${name}로` : `${name}으로`;
}
