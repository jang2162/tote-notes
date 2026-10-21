import { recordableAccelerator, sameAccelerator } from "../shortcuts/keys";
import type { FixedShortcut, ShortcutCommand } from "./types";

/** The fake backend's copy of `COMMANDS` in src-tauri/src/shortcuts.rs, in menu order.
 * fake-shortcuts.test.ts holds it against the table Rust writes out. */
export const FAKE_SHORTCUT_COMMANDS: Omit<ShortcutCommand, "current">[] = [
  { id: "install-cli", label: "셸 명령 설치…", menu: "tote", default: null },
  { id: "new-memo", label: "새 메모", menu: "파일", default: "CmdOrCtrl+N" },
  { id: "new-window", label: "새 창", menu: "파일", default: "Alt+CmdOrCtrl+N" },
  { id: "open-file", label: "파일 열기…", menu: "파일", default: "CmdOrCtrl+O" },
  { id: "save", label: "저장", menu: "파일", default: "CmdOrCtrl+S" },
  { id: "import", label: "워크스페이스로 가져오기", menu: "파일", default: null },
  { id: "rename", label: "이름 바꾸기…", menu: "파일", default: null },
  { id: "versions", label: "이전 버전…", menu: "파일", default: null },
  { id: "reveal-backups", label: "백업 폴더 열기", menu: "파일", default: null },
  { id: "close-tab", label: "탭 닫기", menu: "파일", default: "CmdOrCtrl+W" },
  { id: "close-window", label: "창 닫기", menu: "파일", default: "CmdOrCtrl+Shift+W" },
  { id: "open-workspace", label: "워크스페이스 열기…", menu: "파일", default: "CmdOrCtrl+Shift+O" },
  { id: "new-workspace", label: "새 워크스페이스…", menu: "파일", default: "CmdOrCtrl+Shift+N" },
  {
    id: "search-workspace",
    label: "워크스페이스 검색",
    menu: "보기",
    default: "CmdOrCtrl+Shift+F",
  },
  { id: "split-pane", label: "오른쪽으로 나누기", menu: "보기", default: "CmdOrCtrl+\\" },
  { id: "split-pane-down", label: "아래로 나누기", menu: "보기", default: "CmdOrCtrl+Shift+\\" },
  { id: "focus-pane-left", label: "왼쪽 칸으로", menu: "보기", default: "Alt+CmdOrCtrl+Left" },
  { id: "focus-pane-right", label: "오른쪽 칸으로", menu: "보기", default: "Alt+CmdOrCtrl+Right" },
  { id: "focus-pane-up", label: "위쪽 칸으로", menu: "보기", default: "Alt+CmdOrCtrl+Up" },
  { id: "focus-pane-down", label: "아래쪽 칸으로", menu: "보기", default: "Alt+CmdOrCtrl+Down" },
  { id: "next-tab", label: "다음 탭", menu: "보기", default: "CmdOrCtrl+Shift+]" },
  { id: "prev-tab", label: "이전 탭", menu: "보기", default: "CmdOrCtrl+Shift+[" },
  { id: "toggle-preview", label: "미리보기 전환", menu: "보기", default: "CmdOrCtrl+Shift+V" },
  { id: "move-tab-to-new-window", label: "탭을 새 창으로 옮기기", menu: "윈도우", default: null },
];

/** `FIXED` in src-tauri/src/shortcuts.rs. */
export const FAKE_FIXED_SHORTCUTS: FixedShortcut[] = [
  { name: "설정…", accelerator: "CmdOrCtrl+," },
  { name: "tote 종료", accelerator: "CmdOrCtrl+Q" },
  { name: "워크스페이스 1", accelerator: "Ctrl+1" },
  { name: "워크스페이스 2", accelerator: "Ctrl+2" },
  { name: "워크스페이스 3", accelerator: "Ctrl+3" },
  { name: "워크스페이스 4", accelerator: "Ctrl+4" },
  { name: "워크스페이스 5", accelerator: "Ctrl+5" },
  { name: "워크스페이스 6", accelerator: "Ctrl+6" },
  { name: "워크스페이스 7", accelerator: "Ctrl+7" },
  { name: "워크스페이스 8", accelerator: "Ctrl+8" },
  { name: "워크스페이스 9", accelerator: "Ctrl+9" },
  { name: "실행 취소", accelerator: "CmdOrCtrl+Z" },
  { name: "실행 복귀", accelerator: "CmdOrCtrl+Shift+Z" },
  { name: "오려두기", accelerator: "CmdOrCtrl+X" },
  { name: "복사하기", accelerator: "CmdOrCtrl+C" },
  { name: "붙여넣기", accelerator: "CmdOrCtrl+V" },
  { name: "모두 선택", accelerator: "CmdOrCtrl+A" },
  { name: "숨기기", accelerator: "CmdOrCtrl+H" },
  { name: "기타 숨기기", accelerator: "Alt+CmdOrCtrl+H" },
  { name: "최소화", accelerator: "CmdOrCtrl+M" },
  { name: "전체 화면", accelerator: "Ctrl+CmdOrCtrl+F" },
];

type Overrides = Record<string, string | null>;

/** `shortcuts::sanitize`: the overrides of `saved` that can stand, each judged on its own. An
 * unknown command, a string that does not parse, one the settings screen could not have recorded,
 * a fixed shortcut, or one another command ends up with is dropped and the rest kept. Between a
 * default and an override the override goes; between two overrides, the one later in the table. */
export function sanitizeShortcuts(saved: Overrides): Overrides {
  const kept: Overrides = {};
  for (const [id, keys] of Object.entries(saved)) {
    if (!FAKE_SHORTCUT_COMMANDS.some((command) => command.id === id)) continue;
    if (
      keys !== null &&
      (!recordableAccelerator(keys) ||
        FAKE_FIXED_SHORTCUTS.some((f) => sameAccelerator(keys, f.accelerator)))
    )
      continue;
    kept[id] = keys;
  }
  // A dropped override gives its command the default back, which may clash with an override kept
  // so far: drop one at a time until nothing clashes.
  for (let id = clashing(kept); id !== null; id = clashing(kept)) delete kept[id];
  return kept;
}

/** Every command with the shortcut it has under `kept`. */
export function resolveShortcuts(kept: Overrides): (string | null)[] {
  return FAKE_SHORTCUT_COMMANDS.map((command) =>
    Object.hasOwn(kept, command.id) ? kept[command.id] : command.default,
  );
}

/** The first override in `kept` (in table order) that another command's shortcut takes
 * precedence over: a default, or an override earlier in the table. */
function clashing(kept: Overrides): string | null {
  const shortcuts = resolveShortcuts(kept);
  for (const [at, command] of FAKE_SHORTCUT_COMMANDS.entries()) {
    const keys = kept[command.id];
    if (!Object.hasOwn(kept, command.id) || keys === null) continue;
    const beaten = FAKE_SHORTCUT_COMMANDS.some((other, otherAt) => {
      const otherKeys = shortcuts[otherAt];
      return (
        otherAt !== at &&
        otherKeys !== null &&
        sameAccelerator(otherKeys, keys) &&
        (otherAt < at || !Object.hasOwn(kept, other.id))
      );
    });
    if (beaten) return command.id;
  }
  return null;
}

/** `shortcuts::validate`: the id Rust refuses a patch's map for — the first, in sorted order, that
 * `sanitizeShortcuts` drops — or null when every entry stands. */
export function refusedShortcut(map: Overrides): string | null {
  const kept = sanitizeShortcuts(map);
  return (
    Object.keys(map)
      .sort()
      .find((id) => !Object.hasOwn(kept, id)) ?? null
  );
}

/** Whether two maps hold the same entries, `null` ones included, in any order. */
export function sameShortcutMaps(a: Overrides, b: Overrides): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
  );
}
