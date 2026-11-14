// Finder, the clipboard, a memo copied or moved to another workspace
// (docs/superpowers/specs/2026-11-14-tote-notes-conveniences-design.md).

import { errorCode, type Backend, type FileTarget, type MemoInfo } from "../backend/types";
import { withRo } from "./context-menus";
import type { MoveOutcome } from "./list-actions";
import { asksAboutFile, type MemoDoc } from "./docs";

export const NOT_IN_FINDER = "파일이 없어 Finder 에서 보지 못했습니다";
export const PATH_COPIED = "경로를 복사했습니다";
/** A memo another workspace could not take: its tab could not be saved. */
export const NOT_MOVED_UNSAVED = "저장하지 못해 다른 워크스페이스로 옮기지 않았습니다";
/** The tab asks about its file (another app changed or removed it): that is answered first. */
export const NOT_MOVED_BANNER = "충돌·삭제 알림이 떠 있어 다른 워크스페이스로 옮기지 않았습니다";

export const duplicatedText = (file: string) => `복제했습니다: ${file.normalize("NFC")}`;
export const movedText = (workspace: string) => `${withRo(workspace.normalize("NFC"))} 옮겼습니다`;

/** What the window lends these actions. */
export interface ConvenienceHost {
  readonly backend: Backend;
  /** The memo's tab in this window, if it has one. */
  memoTab(id: string): MemoDoc | undefined;
  /** Saves and closes the memo's tab once any composition has ended: `false` when it stays (its
   * text could not be written), `null` when it closed meanwhile some other way. */
  closeMemoTab(doc: MemoDoc): Promise<boolean | null>;
  /** The memo list of this window. */
  removeListed(id: string): void;
  upsertListed(info: MemoInfo): void;
  /** The status bar. */
  say(text: string, tone?: "normal" | "error"): void;
}

/** 「Finder 에서 보기」: a file that is not there says so instead. */
export async function revealFile(host: ConvenienceHost, target: FileTarget): Promise<void> {
  try {
    await host.backend.revealInFinder(target);
  } catch (error) {
    if (errorCode(error) !== "not-found") throw error;
    host.say(NOT_IN_FINDER, "error");
  }
}

/** 「경로 복사」: the native side writes the clipboard (spec 「경로 복사」). */
export async function copyPath(host: ConvenienceHost, target: FileTarget): Promise<void> {
  await host.backend.copyFilePath(target);
  host.say(PATH_COPIED);
}

/** 「복제」: the copy holds the text of the memo's tab here, unsaved edits and all, else the file. It
 * is not opened; the list shows it and the status bar names it. */
export async function duplicateMemo(host: ConvenienceHost, id: string): Promise<void> {
  const bytes = host.memoTab(id)?.currentBytes() ?? undefined;
  const copy = await host.backend.duplicateMemo(id, bytes);
  host.upsertListed(copy);
  host.say(duplicatedText(copy.file));
}

/** 「다른 워크스페이스로 옮기기」 (spec 「다른 워크스페이스로 옮기기」). A tab of this window showing the
 * memo is saved and closed first; when that fails, or a banner asks about its file, nothing moves
 * and the status bar says so. A memo another window has open is left to that window, which hears
 * `onMoveRequest` and comes back here. */
export async function moveMemo(
  host: ConvenienceHost,
  id: string,
  workspace: string,
): Promise<MoveOutcome> {
  let target = id;
  const doc = host.memoTab(id);
  if (doc) {
    if (asksAboutFile(doc.banner)) {
      host.say(NOT_MOVED_BANNER, "error");
      return "kept";
    }
    const closed = await host.closeMemoTab(doc);
    if (closed === null) return "other";
    if (!closed) {
      host.say(NOT_MOVED_UNSAVED, "error");
      return "kept";
    }
    // A save that recovered a vanished memo wrote the text under a new ID.
    target = doc.info.id;
  }
  let outcome;
  try {
    outcome = await host.backend.moveMemoTo(target, workspace);
  } catch (error) {
    // Gone already: an empty new memo its close deleted, or a file another app removed.
    if (errorCode(error) !== "unknown-memo") throw error;
    host.removeListed(target);
    return "other";
  }
  if (outcome.kind !== "moved") return "other";
  host.removeListed(target);
  host.say(movedText(outcome.workspace));
  return "moved";
}
