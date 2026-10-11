import { errorCode, type BackendErrorCode } from "../backend/types";

/** Codes with a sentence for the status bar; the rest show their message. */
export const ERROR_TEXT: Partial<Record<BackendErrorCode, string>> = {
  "already-exists": "같은 이름이 이미 있습니다",
  "invalid-name": "쓸 수 없는 이름입니다",
  "not-found": "파일을 찾을 수 없습니다",
  "already-installed": "같은 확장이 이미 설치돼 있습니다",
  "not-a-workspace": "워크스페이스가 아닌 폴더입니다",
  "invalid-extension": "확장 패키지를 읽을 수 없습니다",
};

export function describeError(err: unknown): string {
  const code = errorCode(err);
  const text = code ? ERROR_TEXT[code] : undefined;
  if (text) return text;
  return `오류: ${err instanceof Error ? err.message : String(err)}`;
}
