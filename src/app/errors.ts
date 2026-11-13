import { errorCode, type BackendErrorCode } from "../backend/types";

/** Codes with a sentence for the status bar; the rest show their message. */
export const ERROR_TEXT: Partial<Record<BackendErrorCode, string>> = {
  "already-exists": "같은 이름이 이미 있습니다",
  "invalid-name": "쓸 수 없는 이름입니다",
  "not-found": "파일을 찾을 수 없습니다",
  "unknown-memo": "메모를 찾을 수 없습니다",
  "not-text": "텍스트로 열 수 없는 파일입니다",
  "too-large": "100MB 가 넘어 편집기로 열 수 없습니다",
  "already-installed": "같은 확장이 이미 설치돼 있습니다",
  "not-a-workspace": "워크스페이스가 아닌 폴더입니다",
  "invalid-extension": "확장 패키지를 읽을 수 없습니다",
  "window-busy": "창을 닫거나 바꾸는 중이라 탭을 옮기지 못했습니다",
  "workspace-open": "열린 창을 닫거나 다른 워크스페이스로 바꾼 뒤 바꿀 수 있습니다",
};

/** Codes whose message is the only word on the cause (a full disk, a refused permission): the
 * sentence leads and the message follows it, as the system worded it. `io` is the native side's
 * code for everything it has no other for (`io_code` in src-tauri/src/app/commands.rs) — a tab
 * another window would not take as much as a write that failed — so its sentence names no file. */
export const ERROR_LEAD: Partial<Record<BackendErrorCode, string>> = {
  io: "작업을 마치지 못했습니다",
};

export function describeError(err: unknown): string {
  const code = errorCode(err);
  const text = code ? ERROR_TEXT[code] : undefined;
  if (text) return text;
  const message = err instanceof Error ? err.message : String(err);
  const lead = code ? ERROR_LEAD[code] : undefined;
  return `${lead ?? "오류"}: ${message}`;
}
