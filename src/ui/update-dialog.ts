import { errorCode, type Backend, type UpdateOffer } from "../backend/types";
import { modal } from "./dialogs";
import { h } from "./dom";

/** Where the update stands, as the dialog shows it. `failed` keeps the step that failed: 「다시
 * 시도」 runs it again — a failed restart does not download the update twice. */
type Stage =
  | { kind: "ask" }
  | { kind: "downloading"; done: number; total: number | null }
  | { kind: "installing" }
  | { kind: "restarting" }
  | { kind: "failed"; message: string; step: "install" | "restart" }
  | { kind: "busy" }
  | { kind: "elsewhere" }
  | { kind: "installed" };

/** Downloading, installing and restarting are not called off halfway: the buttons are off and
 * Escape does nothing. */
const working = (stage: Stage) =>
  stage.kind === "downloading" || stage.kind === "installing" || stage.kind === "restarting";

/** One dialog per window: an offer that comes while one is open (the menu's check) is not stacked
 * on it. */
let open = false;

/** Asks about `offer`; on 「업데이트하고 다시 시작」 installs it, then restarts tote through the
 * write-then-quit round (`restartForUpdate`). Nothing is downloaded until the person says so. */
export async function openUpdateDialog(backend: Backend, offer: UpdateOffer): Promise<void> {
  if (open) return;
  open = true;
  let stage = first(offer);
  let stopListening = () => {};
  try {
    await modal<true>(
      (close) => {
        const dialog = h("div", { class: "modal update", role: "dialog" });
        const go = (next: Stage) => {
          stage = next;
          dialog.replaceChildren(...contents(offer, stage, close, steps));
          dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
        };
        const restart = async () => {
          go({ kind: "restarting" });
          try {
            await backend.restartForUpdate();
          } catch (error) {
            go(
              errorCode(error) === "busy"
                ? { kind: "busy" }
                : { kind: "failed", message: messageOf(error), step: "restart" },
            );
          }
        };
        const install = async () => {
          go({ kind: "downloading", done: 0, total: null });
          try {
            await backend.installUpdate((progress) =>
              go(
                progress.kind === "installing"
                  ? { kind: "installing" }
                  : { kind: "downloading", done: progress.done, total: progress.total },
              ),
            );
          } catch (error) {
            go(
              errorCode(error) === "installing"
                ? { kind: "elsewhere" }
                : { kind: "failed", message: messageOf(error), step: "install" },
            );
            return;
          }
          await restart();
        };
        const steps: Steps = { install, restart };
        // 「취소」 to the question about unsaved memos: the update is installed and waits for the
        // next launch, or another press.
        stopListening = backend.onRestartOff(() => {
          if (stage.kind === "restarting") go({ kind: "installed" });
        });
        dialog.replaceChildren(...contents(offer, stage, close, steps));
        return dialog;
      },
      { holdEscape: () => working(stage) },
    );
  } finally {
    stopListening();
    open = false;
  }
}

/** Where an offer starts: a window offered an update another is downloading, or one this run
 * installed already (its restart called off), does not download it again. */
function first(offer: UpdateOffer): Stage {
  switch (offer.status) {
    case "available":
      return { kind: "ask" };
    case "installing":
      return { kind: "elsewhere" };
    case "installed":
      return { kind: "installed" };
  }
}

interface Steps {
  install: () => Promise<void>;
  restart: () => Promise<void>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const MB = 1024 * 1024;

function progressText(done: number, total: number | null): string {
  if (total) return `받는 중… ${Math.floor((done / total) * 100)}%`;
  return `받는 중… ${(done / MB).toFixed(1)} MB`;
}

function contents(
  offer: UpdateOffer,
  stage: Stage,
  close: (value: true | null) => void,
  steps: Steps,
): Node[] {
  const button = (label: string, onClick: () => void, primary = false) => {
    const b = h("button", { textContent: label, class: primary ? "primary" : "" });
    if (primary) b.dataset.autofocus = "";
    b.disabled = working(stage);
    b.addEventListener("click", onClick);
    return b;
  };
  const buttons = (...list: HTMLButtonElement[]) => h("div", { class: "modal-buttons" }, ...list);
  const text = (line: string) => h("p", { textContent: line });
  const question = () => {
    const parts: Node[] = [
      text(`새 버전 Tote Notes ${offer.version} 이 있습니다. 지금 버전은 ${offer.current} 입니다.`),
    ];
    if (offer.notes) {
      parts.push(
        h(
          "details",
          { class: "update-notes" },
          h("summary", { textContent: "바뀐 점" }),
          h("pre", { textContent: offer.notes }),
        ),
      );
    }
    return parts;
  };
  const later = () => button("나중에", () => close(null));
  const accept = () => button("업데이트하고 다시 시작", () => void steps.install(), true);
  const status = (line: string) => [
    ...question(),
    h("p", { role: "status", textContent: line }),
    buttons(later(), accept()),
  ];
  switch (stage.kind) {
    case "ask":
      return [...question(), buttons(later(), accept())];
    case "downloading":
      return status(progressText(stage.done, stage.total));
    case "installing":
      return status("설치하는 중…");
    case "restarting":
      return status("저장하고 다시 시작하는 중…");
    case "failed":
      return [
        text(`업데이트하지 못했습니다: ${stage.message}`),
        buttons(
          button("닫기", () => close(null)),
          button("다시 시도", () => void steps[stage.step](), true),
        ),
      ];
    case "busy":
      return [
        text("다른 창이 저장하는 중입니다. 잠시 뒤 다시 눌러 주세요."),
        buttons(
          button("닫기", () => close(null)),
          button("다시 시작", () => void steps.restart(), true),
        ),
      ];
    case "elsewhere":
      return [
        text(`새 버전 Tote Notes ${offer.version} 을 다른 창에서 받는 중입니다.`),
        buttons(button("닫기", () => close(null), true)),
      ];
    case "installed":
      return [
        text("업데이트는 설치됐습니다. 다음에 Tote Notes 를 열면 새 버전으로 시작합니다."),
        buttons(
          button("닫기", () => close(null)),
          button("다시 시작", () => void steps.restart(), true),
        ),
      ];
  }
}
