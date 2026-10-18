# tote-notes 칸·창 후속 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 칸·창 계획의 화면 확인에서 나온 불합격 둘(G-3·G-4 Dock 종료가 창 닫기 시트에 묻힘, C-2 새 창이 화면 밖), 최종 리뷰가 넘긴 결함(전환 순간의 입력 틈 Important 1 ⓑ, 전환 중 CLI 요청), 합격이지만 고칠 문구(E-9·E-11·D-9), 남은 Minor 와 부하 flake 셋을 고친다.

**Architecture:** Dock·AppleScript·로그아웃 종료는 quit Apple Event 를 직접 받아, 창 닫기 질문이 떠 있으면 그 이벤트를 보류하고 질문의 답으로 재개한다. 새 창과 되살린 창의 자리는 순수 함수 `place` 가 창 전체를 한 모니터 안에 넣는다. 닫기·전환·떼어 내기는 프론트엔드의 공통 「떠나는 중」 장치 하나를 쓴다 — 쓰기를 마치고 답한 페이지는 칸을 비워 입력을 받지 않고, 백엔드가 라운드를 거두면 `tote://stay` 로 되돌린다. 전환 중인 창으로 온 CLI 요청은 전환이 끝날 때까지 미뤘다가 다시 처리한다.

**Tech Stack:** Tauri 2, Rust(`cargo test`, objc2), TypeScript + Vite, CodeMirror 6, Vitest, Playwright(WebKit), Orca `computer`.

**Spec:** `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`(「전체 구조」 의 「새 창」·「워크스페이스 띠」, 「오류 처리」). 칸·창 설계 `docs/superpowers/specs/2026-10-16-tote-notes-panes-and-windows-design.md` 와 앞 계획 `docs/superpowers/plans/2026-10-17-tote-notes-panes-and-windows.md` 가 만든 코드 위에서 돈다. 항목의 출처는 `docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-human-smoke.md` 「다음 계획으로 넘기는 것」 절이다. 실행자는 넷을 함께 읽는다.

## 이 계획이 정한 것

출처 문서가 방향만 적었거나 판정을 미룬 자리를 채운 것이다.

- **G-3·G-4 는 결함이다.** 안전망 후속 계획 「이 계획이 정한 것」 이 이미 「Dock 종료가 창 닫기 질문에 붙으면 「그래도 닫기」 뒤 종료를 잇는다」 로 정했다. Rust 상태(`FlushCoordinator` 의 `quit_waiting`, `steps_for_answer`)는 맞다. 원인은 진입점이다 — 문서 모달 시트가 떠 있으면 AppKit 이 `applicationShouldTerminate:` 를 부르기 전에 종료를 거절해(조사 추정, Task 1 Step 1 이 확인) `begin_flush(Quit)` 가 불리지 않는다. 그래서 quit Apple Event(`kCoreEventClass`/`kAEQuitApplication`) 처리기를 직접 단다.
- **새 창은 창 전체가 한 모니터 안에 들어가게 둔다.** 기준점(`x+40, y+10`, 지금 `frame_visible` 의 점)이 있는 모니터 안으로 크기를 지킨 채 옮기고, 모니터보다 크면 모니터에 맞게 줄인다. 기준점이 어느 모니터에도 없으면 지금처럼 기본 크기(1100×760)로 가운데. 되살리는 창에도 같은 규칙을 쓴다. 제목 표시줄 높이는 상수 **28px** 로 바깥 높이에 더해 따진다(자리는 바깥 위치, 크기는 안쪽 크기로 저장되기 때문).
- **「떠나는 중」 은 페이지 단위와 탭 단위 두 층이다.** 닫기·전환은 페이지 전체(`AppController.leaving`), 떼어 내기는 탭 하나(`Doc.leaving`). 떠나는 동안 새로 생긴 탭(⌘N, 사이드바, 받은 CLI 요청)도 보이지 않아야 해서 페이지 단위가 필요하다. 종료는 페이지를 떠나게 하지 않는다(질문의 「취소」 뒤 그대로 써야 하므로).
- **`tote://flush` 는 `{ id, goal }` 를 싣는다.** `goal` 은 `"close" | "switch" | "quit"`. 페이지는 `goal` 이 `close`·`switch` 이면 쓰기를 마친 뒤 `flushDone` 을 보내기 **전에** 떠난다. 라운드가 창을 남기고 끝나면(질문에 「취소」, 전환 대상이 다른 창에 이미 열림, 대상을 열지 못함, 창 닫기 실패) 백엔드가 그 창에 `tote://stay` 를 보낸다.
- **전환 중인 창으로 온 CLI 요청은 미뤘다가 전환이 끝나면 다시 처리한다**(최종 리뷰의 두 안 중 ①). 전환 중에는 `take_pending_opens` 가 빈 목록을 준다(옛 페이지가 큐를 비우고 새로 고침으로 잃지 않게).
- **문구.**
  - 저장 실패 질문의 본문은 이유 줄 아래에 한 줄을 더한다: 닫기 `그래도 닫으면 저장하지 못한 글은 사라집니다.`, 전환 `그래도 바꾸면 저장하지 못한 글은 사라집니다.`, 종료 `그래도 종료하면 저장하지 못한 글은 사라집니다.`
  - 충돌·삭제 배너가 떠 있어 떼어 내지 않을 때 상태 표시줄: `충돌·삭제 알림이 떠 있어 새 창으로 옮기지 않았습니다`. 저장 실패 때는 지금 문구(`저장하지 못해 새 창으로 옮기지 않았습니다`) 그대로.
  - E-11 의 `파일을 찾을 수 없습니다` 는 그대로 둔다 — 확인 목록의 기대(「시작 전에 지웠으면 `not-found` 류 오류 문구」)와 맞다. 고칠 것은 띠다: 전환이 실패하면 띠를 다시 읽어 찾을 수 없는 워크스페이스를 뺀다(스펙 「찾을 수 없는 워크스페이스는 띠에 보이지 않는다」).
- **T9-4(iframe 클릭 뒤 첫 사이드바 클릭)는 앱을 고치지 않는다.** 실제 앱(A-12a)에서 합격했다. 그 증상을 단언하는 시험이 있으면 Playwright WebKit 한정임을 적고, 없으면 손대지 않는다.

## 이 계획이 다루지 않는 것

- 측정 O-1(창 밖 끌기)·O-2(세션 복원 50탭)·O-3(전환 시간) — 사람 화면과 낮은 부하가 필요하다. 계획 밖에서 load 3 미만일 때 잰다. 스파이크 도구 항목 T4-1·T4-2 는 O-1 결과에 달려 있어 함께 미룬다.
- 사람이 넘긴 확인 E-10a·F-3·G-7·C-8 — Task 9 의 사람 확인 목록에 다시 싣는다.
- 끌어서 떼어 내기 — 코어 스펙 「끌기로는 떼어 내지 않는다」 유지.

## Global Constraints

모든 태스크의 요구 사항에 아래가 포함된다.

- 플랫폼은 macOS 먼저다. OS 에 기대는 코드는 Rust 모듈 경계 안(`backup`, `watch`, `appdata`, `cli`, `app/lifecycle.rs` 의 `system_quit`)에 가둔다. objc2 계열 외의 새 직접 의존을 들이지 않는다(lockfile 에 이미 있는 것만).
- **앱 종료를 막는 경우는 저장 실패 하나뿐이다.** **Dock 종료·AppleScript 종료·로그아웃은 macOS 가 답을 기다린다** — `TerminateLater` 로 답했거나 보류한 quit Apple Event 는 어떤 경로로 끝나든 `system_quit::answer` 로 **정확히 한 번** 답한다. 빠지면 로그아웃이 영원히 기다리고 `osascript` 가 돌아오지 않는다.
- **쓰고 닫기(flush)는 창마다 돈다.** 전환과 떼어 내기도 이 경로(즉시 저장, 수정분 보관)를 지난다. 라운드 시간 제한(3초)과 답 표(`steps_for_ack`·`steps_for_answer`)의 기존 행은 바꾸지 않는다.
- **한 메모는 한 자리에**, 칸 최소 폭 **320px**, 띠 폭 **48px**, 새 창 오프셋 **24px**, 기본 창 크기 **1100×760**, 단축키(⌘\, ⌥⌘←/→, ⌥⌘N, ⌃1–⌃9)는 바꾸지 않는다.
- **문구(그대로 쓴다):** `저장하지 못한 메모가 있습니다`, `그래도 닫기`, `그래도 바꾸기`, `그래도 종료`, `취소`, 위 「이 계획이 정한 것」 의 새 문구 넷. 사용자에게 보이는 문구는 한국어, 코드 주석은 영어.
- **한글 조합:** 떠나기 전에 조합을 확정한다(지금 `onFlush` 의 `settleComposition` 순서 유지).
- 주석 규칙은 `docs/guideline/base/03-comments.md`, 인용은 `docs/guideline/base/04-citation.md`(줄번호가 아니라 이름·절 제목).
- **스펙을 고치는 태스크는 같은 커밋에 코어 스펙의 해당 절을 고친다.** 스펙은 지금 참인 동작만 적는다(연대기 금지).
- **커밋:** 경로를 명시해 stage 한다(`git add -A` 금지). 커밋 전에 `pnpm exec oxfmt <바꾼 파일>`, `pnpm exec oxlint --fix <바꾼 TS 파일>`, `cargo fmt --manifest-path src-tauri/Cargo.toml`. Rust 를 바꾼 태스크는 `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 도 돈다.
- **테스트 명령:** Rust `cargo test --manifest-path src-tauri/Cargo.toml`, 단위 `pnpm test`, 타입 `pnpm typecheck`, e2e `pnpm test:e2e`(WebKit, `TOTE_E2E_PORT` 기본 1430 — 워크트리마다 다른 값). 결과는 **실행된 개수**와 함께 보고한다(0개면 통과가 아니다). 태스크 끝에는 넷 모두 돌린다.
- **부하에서 흔들리는 것으로 알려진 테스트**(Task 8 이 다루기 전까지): `scripts/perf-fixtures.test.ts`(시간 초과), `tests/e2e/memo.spec.ts` 「guard: keys typed while a memo picked in the list loads do not reach the tab left」, `tests/e2e/watch.spec.ts` 「a deleted memo keeps its text and 다시 저장 brings it back」. 이 셋만 실패하면 `uptime` 의 load 를 적고 그 테스트만 `--repeat-each=5` 로 다시 돌려 보고에 적는다. 새로 흔들리는 테스트는 원인을 찾는다.
- **에이전트가 앱을 띄울 때는 반드시 `TOTE_DATA_DIR=<임시 폴더>`** 를 주고, 사람 화면을 쓰지 않는 확인은 `TOTE_BACKGROUND=1` 도 준다. 디버그 번들은 `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json` → `src-tauri/target/debug/bundle/macos/tote-dev.app`. 끝나면 `~/Tote-dev` 와 `~/Library/Application Support/tote-dev` 가 생기지 않았는지 본다. 실제 메모 폴더 `~/Tote` 는 건드리지 않는다. 화면을 쓰기 전에는 코디네이터에게 알린다(사람이 키보드·마우스를 쓰지 않아야 한다). 편집기에 글을 넣을 때는 `orca computer set-value` 를 쓴다(`type-text` 는 두 번, `paste-text` 는 클립보드를 한 번 더 넣는다). 로그아웃은 에이전트가 하지 않는다.

## Review Focus

1. **시트가 떠 있을 때 Dock 종료 후 「취소」.** 보류한 Apple Event 가 「취소」(-128)로 재개되지 않으면 `osascript` 와 로그아웃이 멈춘다. 「그래도 닫기」 면 앱이 끝나야 한다. Task 1 의 `every_answer_resumes_a_suspended_quit_event` 와 Task 9 의 G-2·G-3·G-4 행이 고정한다.
2. **전환이 창을 남기고 끝나는 모든 길**(질문에 「취소」, 대상이 다른 창에 이미 열림, 대상을 열지 못함). 어느 하나라도 `tote://stay` 를 빠뜨리면 그 창은 빈 칸으로 굳어 아무것도 칠 수 없다. Task 3 의 e2e 셋과 `every_exit_that_keeps_the_window_says_stay` 가 고정한다.
3. **떠나는 중에 새 탭이 생긴다**(⌘N, 사이드바 클릭, 받은 CLI 요청). 그 탭에 편집기가 붙으면 그 글은 새로 고침에 사라진다. Task 3 의 `a memo opened while the window leaves shows nothing` 이 고정한다.
4. **모니터마다 배율이 다르거나 창이 모니터보다 크다.** 새 창이 여전히 밖으로 나가거나 크기가 음수가 되면 안 된다. Task 2 의 `a_window_larger_than_its_monitor_shrinks_to_fit` 가 고정하고, 배율이 섞인 경우는 Task 9 의 C-2 행이 실제 모니터로 본다.
5. **전환 중에 온 `tote -w <대상> -i 파일`.** 떠나는 워크스페이스로 가져와지거나 사라지면 안 되고, 전환이 실패하면 상태 표시줄에 알려야 한다. Task 4 의 `a_request_during_a_switch_waits_for_its_end` 와 `a_request_held_by_a_failed_switch_is_told` 가 고정한다.

---

## 파일 구조

```
src-tauri/src/
  app/lifecycle.rs     system_quit: quit Apple Event 처리기, Waiting; run 이 {id, goal}; stay; ask_blocked 문구
  app/flush.rs         FlushGoal::kind(), 묻는 중인 닫기 라운드 조회
  app/windows.rs       place, TITLE_BAR_HEIGHT, monitor_rects 로그
  app/mod.rs           held 요청, switching 동안 take_pending 빈 목록, T1-1·T5-1·T5-3·T11-3·T12-1·T12-3
  app/requests.rs      handle 이 전환 중인 창의 요청을 미룸
  app/commands.rs      watch_external·issue_file_token 이 check_writable
  app/menu.rs          TAB_MENU 자리(T11-4)
src/
  app/controller.ts    leave/stay, onFlush(id, goal), tearOff 가 Doc.leaving, ⌃숫자 가드, 띠 새로 고침, 문구
  app/pane.ts          show() 가 떠나는 중이면 비운다, PaneHost.leaving
  app/docs.ts          Doc.leaving, conflictKept 주석(T3-2)
  backend/types.ts     onFlush(handler(id, goal)), onStay
  backend/tauri.ts     위 둘
  backend/fake.ts      requestFlush(id, goal), onStay, switchDelayMs, whileWritingLayout 시점
  backend/fake-hub.ts  flush 이벤트에 goal(T11-5)
docs/superpowers/specs/2026-10-07-tote-note-core-design.md   「새 창」·「워크스페이스 띠」·「전체 구조」 머리 단계
docs/guides/development.md                                     부하 flake 결론(Task 8)
docs/superpowers/reports/2026-10-18-tote-notes-panes-followups-smoke.md   (새) Task 9
```

---

### Task 1: Dock·AppleScript 종료가 창 닫기 시트에 묻히지 않는다 (G-3·G-4)

**Files:**

- Modify: `src-tauri/src/app/lifecycle.rs` (`system_quit` 모듈: `install`, `should_terminate`, `answer`, `WAITING`)
- Modify: `src-tauri/src/app/flush.rs` (묻는 중인 닫기 라운드가 있는지 묻는 메서드)
- Test: `lifecycle.rs` 의 `system_quit::tests`

**Interfaces:**

- Produces:
  - `enum Waiting { None, Terminate, QuitEvent(SuspendedEvent) }` — `WAITING: AtomicBool` 을 대신한다. `SuspendedEvent` 는 보류한 Apple Event 를 다시 재개하는 데 필요한 것(보류 ID 와 답 이벤트)을 쥔다.
  - `fn quit_event_action(asking_close: bool) -> QuitEventAction` — `QuitEventAction::{Suspend, Terminate}`. 묻는 중인 창 닫기 라운드가 있으면 `Suspend`, 아니면 `Terminate`(지금처럼 `NSApp.terminate(nil)` → `applicationShouldTerminate:`).
  - `fn resume_error_for(quit: bool) -> Option<i16>` — `false` 면 `Some(-128)`(userCanceledErr), `true` 면 `None`.
  - `system_quit::answer(app, quit) -> bool` 은 시그니처 그대로. `Waiting::QuitEvent` 이면 Apple Event 를 재개한다(`quit` 이 `false` 면 답 이벤트에 -128 을 싣는다). `quit` 이 `true` 이고 보류한 것이 Apple Event 였으면 `false` 를 돌려줘 `finish` 가 `app.exit(0)` 으로 끝내게 한다.
  - `FlushCoordinator::asking_close(&self) -> bool`.

- [ ] **Step 1: 원인을 확인한다 (실제 앱, 화면)**

`should_terminate` 첫 줄에 임시 `eprintln!("tote: should_terminate")` 를 넣고 디버그 번들을 만든다. 코디네이터에게 화면을 쓴다고 알린 뒤 `TOTE_DATA_DIR` 임시 폴더로 터미널에서 띄운다(stderr 가 보이게). 워크스페이스를 `chmod a-w` 로 만들고 글을 넣어 저장 실패를 만든 뒤 ⇧⌘W 로 시트를 띄운다. 그 상태에서 `osascript -e 'tell application "tote-dev" to quit'` 를 돌린다.
Expected: 로그가 **찍히지 않고** `osascript` 가 즉시 -128. 찍히면 원인이 다르다 — 고치지 말고 `BLOCKED` 로 로그와 함께 보고한다. 끝나면 `chmod u+w`, 임시 줄은 지운다.

- [ ] **Step 2: 실패하는 테스트를 쓴다** (`system_quit::tests`)

- `a_quit_event_during_an_asking_close_waits_for_its_answer` — `quit_event_action(true) == Suspend`, `quit_event_action(false) == Terminate`.
- `every_answer_resumes_a_suspended_quit_event` — `resume_error_for(false) == Some(-128)`, `resume_error_for(true) == None`.
- `flush.rs`: `asking_close_is_true_only_while_a_close_asks` — 닫기 라운드를 `Blocked` 로 만든 뒤(`a_quit_joins_an_asking_close` 와 같은 방법) `asking_close()` 가 `true`, `cancel(id)` 뒤 `false`, 묻는 중이 아닌 닫기 라운드에서는 `false`.

기존 `a_quit_joins_an_asking_close`, `every_answer_settles_a_waiting_system_quit`, `only_a_round_left_running_makes_macos_wait` 는 그대로 통과해야 한다.

- [ ] **Step 3: 테스트가 실패하는지 본다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml system_quit asking_close`
Expected: FAIL(정의 없음).

- [ ] **Step 4: 구현한다**

- `install` 에서 `NSAppleEventManager::sharedAppleEventManager` 에 `kCoreEventClass`(`'aevt'`)·`kAEQuitApplication`(`'quit'`) 처리기를 단다. 처리기는 `quit_event_action(core.asking_close())` 가 `Suspend` 면 `begin_flush(Quit)`(→ `quit_waiting`), `suspendCurrentAppleEvent` 로 보류하고 `Waiting::QuitEvent` 로 둔다. `Terminate` 면 `NSApp.terminate(nil)`.
- `answer` 가 `Waiting` 에 따라 `replyToApplicationShouldTerminate:` 또는 `resumeWithSuspensionID:` 로 한 번 답하고 `Waiting::None` 으로 되돌린다.
- `steps_for_answer` 의 `RefuseSystemQuit` 와 `finish` 의 `Quit` 은 지금처럼 `answer` 를 부른다 — 표는 바꾸지 않는다. `RefuseSystemQuit` 곁 주석에 「보류한 Apple Event 도 이 답으로 풀린다」 한 줄.
- 처리기 안 unsafe 블록마다 왜 안전한지 주석을 단다.

- [ ] **Step 5: 실제 앱에서 확인한다 (화면)**

Step 1 과 같은 준비로 세 번:
① 시트 + `osascript … quit` → `osascript` 가 기다린다 → 「취소」 → `osascript` 가 -128 로 돌아오고 앱은 산다.
② 시트 + `osascript … quit` → 「그래도 닫기」 → 앱이 끝나고 `osascript` 가 0 으로 돌아온다.
③ 시트가 없을 때 `osascript … quit` → 지금처럼 끝난다(저장 실패가 없는 창만 있으면 질문 없이).
Expected: 셋 다 그대로. 결과를 보고에 적는다.

- [ ] **Step 6: 전체 테스트와 커밋**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: PASS, 실행 개수를 적는다.

```bash
git add src-tauri/src/app/lifecycle.rs src-tauri/src/app/flush.rs
git commit -m "fix(quit): hold a Dock quit that arrives while a close asks and answer it with the close"
```

---

### Task 2: 새 창과 되살린 창은 모니터 안에 다 들어간다 (C-2, 새 Minor 3)

**Files:**

- Modify: `src-tauri/src/app/windows.rs` (`frame_visible`, `open_window`, `monitor_rects`)
- Modify: `docs/superpowers/specs/2026-10-07-tote-note-core-design.md` 「새 창」
- Test: `windows.rs` 의 `mod tests`

**Interfaces:**

- Produces:
  - `const TITLE_BAR_HEIGHT: f64 = 28.0;`
  - `pub fn place(frame: WindowFrame, monitors: &[(f64, f64, f64, f64)]) -> Option<WindowFrame>` — 기준점이 있는 모니터를 고르고, 바깥 높이(`height + TITLE_BAR_HEIGHT`)와 너비가 모니터보다 크면 줄인 뒤, 창 전체가 그 모니터 안에 들도록 왼쪽·위로 옮긴다. 다 들어가면 그대로. 기준점이 어느 모니터에도 없거나 목록이 비면 `None`.
  - `open_window` 의 `frame.filter(|f| frame_visible(f, …))` 는 `frame.and_then(|f| place(f, &monitors))` 가 된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

모니터 `M = [(0.,0.,3840.,1600.), (3840.,-734.,1440.,2560.), (0.,1600.,2560.,1440.)]`.

- `a_new_window_at_a_monitor_corner_stays_on_it` — `place(near_frame(4180,1060,1100,760), &M)` 가 `Some(4180,1038,1100,760)`(C-2).
- `a_saved_frame_half_off_its_monitor_moves_in` — `(5000,100,900,700)` → `Some(4380,100,900,700)`.
- `a_window_larger_than_its_monitor_shrinks_to_fit` — `(3840,-734,2000,3000)` → `Some(3840,-734,1440,2532)`.
- `a_frame_on_no_monitor_is_dropped` — `(6000,100,900,700)` → `None`; `place(f, &[])` → `None`.
- `a_frame_inside_a_monitor_is_kept` — `(100,100,900,600)` → 그대로.

기존 `a_saved_frame_is_reused_only_on_a_present_monitor`, `a_new_window_sits_near_its_source` 는 그대로 통과해야 한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`place` 를 쓰고 `open_window` 의 두 길(Restore, Fresh)에 건다. `monitor_rects` 는 `available_monitors()` 가 `Err` 이거나 빈 목록이면 `eprintln!("tote: no monitors: …")` 한 줄을 남긴다. 스펙 「새 창」 의 「오른쪽·아래 24px, 같은 크기로 연다」 뒤에 「창이 모니터 밖으로 나가면 그 모니터 안으로 옮기고, 모니터보다 크면 줄인다. 되살리는 창도 같다. 저장된 자리의 모니터가 없으면 기본 크기로 가운데에 연다.」 를 넣는다.

- [ ] **Step 4: 통과를 확인하고 커밋**

Run: 네 가지 테스트 명령과 clippy. Expected: PASS, 개수를 적는다.

```bash
git add src-tauri/src/app/windows.rs docs/superpowers/specs/2026-10-07-tote-note-core-design.md
git commit -m "fix(windows): keep a new or restored window wholly on one monitor"
```

---

### Task 3: 닫기·전환·떼어 내기가 함께 쓰는 「떠나는 중」 (Important 1 ⓑ, T11-R, T12-4, 새 Minor 2)

**Files:**

- Modify: `src-tauri/src/app/lifecycle.rs` (`run`, `begin`, `resolve_blocked`, `switch_window`, 새 `stay`)
- Modify: `src-tauri/src/app/flush.rs` (`FlushGoal::kind`)
- Modify: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src/backend/fake-hub.ts`
- Modify: `src/app/controller.ts` (`onFlush`, `tearOff`, `start` 의 ⌃1–⌃9 리스너, 새 `leave`·`stay`)
- Modify: `src/app/pane.ts` (`show`, `PaneHost`), `src/app/docs.ts` (`Doc`)
- Modify: 코어 스펙 「워크스페이스 띠」 의 「전환이 시작된 때부터 … 거절된다」 문장
- Test: `tests/e2e/rail.spec.ts`, `tests/e2e/tear-off.spec.ts`, `lifecycle.rs` 의 `mod tests`

**Interfaces:**

- Consumes: Task 1 의 `system_quit` 는 그대로 쓴다(종료 라운드는 `goal: "quit"`).
- Produces:
  - Rust: `FlushGoal::kind(&self) -> &'static str` — `"close" | "switch" | "quit"`. `tote://flush` 페이로드 `#[derive(Serialize)] struct FlushRequest { id: u64, goal: &'static str }`. `pub fn stay(app: &AppHandle, label: &str)` — `tote://stay` 를 그 창에 보낸다.
  - TS: `Backend.onFlush(handler: (id: number, goal: FlushGoal) => void)`, `type FlushGoal = "close" | "switch" | "quit"`, `Backend.onStay(handler: () => void)`.
  - `FakeBackend.requestFlush(id: number, goal: FlushGoal = "quit")`, `FakeBackend.switchDelayMs`(쓰기 답 뒤 `location.reload()` 까지 기다리는 ms, 기본 0), `FakeBackend.stay()`(시험이 백엔드의 `tote://stay` 를 흉내).
  - `Doc.leaving: boolean`, `PaneHost.leaving: boolean`(읽기 전용), `AppController.leave(): void`, `AppController.stay(): void`.
  - `Pane.show(doc)` 는 `doc.leaving || host.leaving` 이면 `surface.showNothing()` 만 하고 돌아간다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/e2e/rail.spec.ts`:

- `keys typed after the switch round answers do not reach the memo left` — `switchDelayMs = 300`, 띠 클릭, 답이 간 뒤(`backend.data.flushed` 에 기록) 글을 친다 → 떠난 메모 파일에 그 글이 없고, 칸의 `.cm-content` 가 없거나 편집 불가.
- `a switch the person cancels gives the editor back` — 저장 실패를 만든 뒤 띠 클릭(가짜는 「취소」로 친다) → 같은 메모의 편집기가 다시 편집 가능하고 친 글이 들어간다.
- `a memo opened while the window leaves shows nothing` — 떠나는 중(`switchDelayMs`)에 ⌘N → 새 탭은 생겨도 편집기가 붙지 않는다.
- `⌃2 does nothing while a dialog is open` — 이름 바꾸기 대화상자를 연 채 ⌃2 → 전환하지 않고(`switchWorkspace` 호출 없음) 대화상자가 남는다.
- 기존 `a composition in progress lands in its memo before a switch writes the tabs` 는 `requestFlush(77, "switch")` 로 바꾸고 이름을 `onFlush writes a composition in progress before it answers` 로 고친다(T12-5).

`tests/e2e/tear-off.spec.ts`:

- `a tab being torn off does not take its editor back when shown again` — `tearOffDelayMs = 300` 동안 다른 탭을 눌렀다 이 탭으로 돌아온다 → 편집기가 붙지 않는다. 떼어 내기가 실패로 끝나면(`a tab the backend does not take stays editable and says why` 와 같은 준비) 다시 편집 가능.

`lifecycle.rs`:

- `every_exit_that_keeps_the_window_says_stay` — 창을 남기는 출구를 순수 함수로 뺀 판정(`fn keeps_window(goal, outcome) -> bool` 꼴, 이름은 구현자가 정한다)이 「취소」·`Shown`·`Open` 실패·창 닫기 실패에서 `true`, 성공한 닫기·전환에서 `false`, 종료에서는 언제나 `false`.

기존 `keys typed while a switch writes the tabs go into the memo left behind`, `keys typed while the tab is being torn off do not reach it` 는 그대로 통과해야 한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm test:e2e tests/e2e/rail.spec.ts tests/e2e/tear-off.spec.ts && cargo test --manifest-path src-tauri/Cargo.toml lifecycle`
Expected: 새 테스트 FAIL.

- [ ] **Step 3: 구현한다**

- `run` 이 `FlushRequest { id, goal: goal.kind() }` 를 보낸다(`begin` 이 goal 을 넘긴다).
- `onFlush(id, goal)`: 조합 확정 → `flushAll(true)` → 남은 글이 있으면 한 번 더 → `goal !== "quit"` 이면 `leave()` → `finally` 에서 `flushDone`. `leave()` 는 `leaving = true`, 칸마다 `capture(active)` 후 `surface.showNothing()`. `stay()` 는 `leaving = false`, 칸마다 활성 탭을 `show`, 포커스 칸은 `takeKeys`.
- `tearOff` 의 지역 `onShow`·`stay` 클로저를 `doc.leaving` 으로 바꾼다. 실패하면 `doc.leaving = false` 후 그 칸의 활성 탭이면 `show`.
- `stay` 를 부르는 곳: `resolve_blocked` 에서 `anyway == false` 이고 `goal.window()` 가 있을 때, `switch_window` 의 `Shown`·`Open`·`Err` 출구, `finish` 의 창 닫기에서 `destroy` 가 실패했을 때(Task 6 의 T1-1 과 같은 자리 — 여기서 `stay` 만 건다).
- ⌃1–⌃9 리스너는 `this.leaving` 이거나 `.modal` 이 있으면 무시한다.
- 가짜: `flushThisWindow` 가 `"switch"`, 「취소」로 치는 길은 `handlers.stay` 를 부른 뒤 돌아간다. `switchDelayMs` 동안 기다린 뒤 `location.reload()`. `fake-hub.ts` 의 `flush` 이벤트에 goal 을 싣는다.
- 스펙 「워크스페이스 띠」 의 「전환이 시작된 때부터 새 페이지가 뜰 때까지 그 창의 쓰기는 거절된다」 를 「창이 탭을 다 쓰고 답한 때부터 칸이 비워져 입력을 받지 않고, 대상 워크스페이스로 넘어간 때부터 새 페이지가 뜰 때까지 그 창의 쓰기는 거절된다. 전환이 거둬지면(취소, 대상을 열지 못함, 다른 창이 이미 보임) 칸이 돌아온다.」 로 고친다. 「새 창」 의 떼어 내기 문단에 「떼어 내는 동안 그 탭은 보이지 않는다」 를 더한다.

- [ ] **Step 4: 통과를 확인하고 커밋**

Run: 네 가지 테스트 명령과 clippy. Expected: PASS, 개수를 적는다.

```bash
git add src-tauri/src/app/lifecycle.rs src-tauri/src/app/flush.rs src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src/backend/fake-hub.ts src/app/controller.ts src/app/pane.ts src/app/docs.ts tests/e2e/rail.spec.ts tests/e2e/tear-off.spec.ts docs/superpowers/specs/2026-10-07-tote-note-core-design.md
git commit -m "fix(windows): empty a leaving window's panes after it writes and bring them back when it stays"
```

---

### Task 4: 전환 중에 온 CLI 요청은 전환이 끝난 뒤 처리한다 (새 Minor 1, T12-1, T12-3)

**Files:**

- Modify: `src-tauri/src/app/requests.rs` (`handle`)
- Modify: `src-tauri/src/app/mod.rs` (`prepare_switch`, `switch_window`, `take_pending`, 새 `hold_request`·`take_held`)
- Modify: `src-tauri/src/app/lifecycle.rs` (`switch_window` 의 모든 출구)
- Modify: `src-tauri/src/app/commands.rs` (`watch_external`, `issue_file_token`)
- Test: `mod.rs`·`requests.rs` 의 `mod tests`

**Interfaces:**

- Consumes: Task 3 의 `stay` 와 출구 목록(같은 출구에서 다시 처리한다).
- Produces:
  - `AppCore::is_switching(&self, label: &str) -> bool`.
  - `AppCore::hold_request(&self, label: &str, request: CliRequest)`, `AppCore::take_held(&self, label: &str) -> Vec<CliRequest>`.
  - `take_pending(label)` 은 그 창이 전환 중이면 빈 목록을 준다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

- `a_request_during_a_switch_waits_for_its_end` — 창 `a` 가 `w1` 에서 `w2` 로 `prepare_switch` 한 상태에서 `w2` 대상 요청을 `handle` 에 준다 → `w1` 에 가져와지지 않고 `take_held("a")` 에 하나. `switch_window` 뒤 다시 처리하면 `w2` 에 가져와지고 `take_pending("a")` 에 그 메모가 있다.
- `a_request_held_by_a_failed_switch_is_told` — 같은 준비에서 전환이 `Open` 실패로 끝나면 요청은 원래 대상 규칙대로 처리되고(대상 창이 없으니 새 창 또는 알림 — 지금 `handle` 의 대상 없음 처리와 같게) 잃지 않는다.
- `pending_opens_wait_while_the_window_switches` — 전환 중 `take_pending` 은 빈 목록, 끝난 뒤 그대로 나온다.
- `a_switch_to_a_window_gone_frees_its_reservation`(T12-1) — `switch_window` 가 `NotFound` 로 끝나도 대상 워크스페이스를 다시 `reserve` 할 수 있다.
- `watching_and_tokens_are_refused_while_switching`(T12-3) — 전환 중 `check_writable` 를 거치는 두 길이 거절된다(명령 함수가 직접 시험하기 어려우면 `AppCore` 쪽에 둔 공개 메서드로 시험한다).

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml app::`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`handle` 은 `windows::show` 가 준 라벨이 `is_switching` 이면 `hold_request` 하고 돌아간다. `lifecycle::switch_window` 의 모든 출구 끝에서 `take_held(label)` 를 하나씩 다시 `handle` 한다. `switch_window`(mod.rs)의 예약 해제를 창 조회보다 앞으로 옮긴다. `watch_external`·`issue_file_token` 은 쓰기 명령과 같은 `check_writable` 을 거친다.

- [ ] **Step 4: 통과를 확인하고 커밋**

Run: 네 가지 테스트 명령과 clippy. Expected: PASS, 개수를 적는다.

```bash
git add src-tauri/src/app/requests.rs src-tauri/src/app/mod.rs src-tauri/src/app/lifecycle.rs src-tauri/src/app/commands.rs
git commit -m "fix(rail): hold a CLI request for a switching window until the switch ends"
```

---

### Task 5: 질문·알림 문구와 띠 (E-9, D-9, E-11)

**Files:**

- Modify: `src-tauri/src/app/lifecycle.rs` (`ask_blocked`, 새 `blocked_message`)
- Modify: `src/app/controller.ts` (`NOT_MOVED_TO_NEW_WINDOW` 곁 새 상수, `tearOff` 의 거절 이유, `switchTo`)
- Test: `lifecycle.rs` 의 `mod tests`, `tests/e2e/tear-off.spec.ts`, `tests/e2e/rail.spec.ts`

**Interfaces:**

- Produces:
  - `fn blocked_message(goal: &FlushGoal, reasons: &[String]) -> String` — 이유 줄들 + 빈 줄 없이 다음 줄에 문구 하나.
  - `export const NOT_MOVED_WITH_BANNER = "충돌·삭제 알림이 떠 있어 새 창으로 옮기지 않았습니다";`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

- `the blocked question says the text is lost` — `blocked_message(&CloseWindow("a"), &["저장하지 못한 메모 1개"])` 가 `"저장하지 못한 메모 1개\n그래도 닫으면 저장하지 못한 글은 사라집니다."`. 전환은 `그래도 바꾸면 …`, 종료는 `그래도 종료하면 …`.
- e2e `a tab with a conflict banner stays and says why` — 충돌 배너가 뜬 탭을 떼어 낸다 → 상태 표시줄이 `NOT_MOVED_WITH_BANNER`. 저장 실패 탭의 기존 시험은 `NOT_MOVED_TO_NEW_WINDOW` 그대로.
- e2e `a workspace that cannot be found leaves the rail after a failed switch` — 가짜의 `workspaces` 에서 한 항목을 `missing: true` 로 바꾸고(목록은 아직 옛것을 보인 채) 그 항목을 누른다 → `switchWorkspace` 가 거부되고, 띠에서 그 항목이 사라진다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml blocked && pnpm test:e2e tests/e2e/tear-off.spec.ts tests/e2e/rail.spec.ts`
Expected: 새 테스트 FAIL.

- [ ] **Step 3: 구현한다**

`ask_blocked` 가 `.message(blocked_message(&goal, reasons))`. `tearOff` 의 거절 이유를 둘로 나눠 배너면 새 상수. `switchTo` 의 `catch` 에서 `report` 뒤 `refreshRail()`.

- [ ] **Step 4: 통과를 확인하고 커밋**

Run: 네 가지 테스트 명령과 clippy. Expected: PASS, 개수를 적는다.

```bash
git add src-tauri/src/app/lifecycle.rs src/app/controller.ts tests/e2e/tear-off.spec.ts tests/e2e/rail.spec.ts
git commit -m "fix(ui): say what 그래도 loses, why a bannered tab stays, and drop a lost workspace from the rail"
```

---

### Task 6: Rust Minor 묶음 (T1-1, T1-3, T5-1, T5-3, T7-3, T11-3, T11-4)

각 항목의 문제와 고치는 법은 출처 문서 「최종 리뷰에서 넘긴 것」 표의 같은 행이다. 행을 그대로 따른다.

**Files:**

- Modify: `src-tauri/src/app/lifecycle.rs`(`finish` — T1-1), `src-tauri/src/app/flush.rs`(테스트 — T1-3), `src-tauri/src/app/mod.rs`(`register_window` — T5-1, `on_batch` — T5-3, `start_quit` — T11-3, 테스트 — T7-3), `src-tauri/src/app/windows.rs`(`open_window` — T5-1), `src-tauri/src/app/menu.rs`(T11-4)

**Interfaces:**

- Consumes: Task 3 이 `finish` 의 `destroy` 실패에 건 `stay`. T1-1 은 같은 자리에서 `closing` 을 되돌리고 `eprintln!` 한다.
- Produces: `AppCore::register_window(...) -> bool`(T5-1). `OpenWorkspace` 에 감시 키(T5-3).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

- T1-1 `a_window_that_fails_to_close_stays_in_the_quit` — `closing(label)` 뒤 닫기 실패를 알리는 메서드(구현자가 이름을 정한다)를 부르면 다음 종료 라운드의 창 목록과 「다시 열 창」 에 그 창이 있다.
- T1-3 — `a_quit_during_a_close_round_waits_for_it` 끝에 `begin(Quit, ["b"])` 가 `Started` 인 단언 한 줄.
- T5-1 `registering_a_window_without_its_workspace_says_so` — 붙을 워크스페이스가 없으면 `false`.
- T7-3 — `closing_a_window_frees_its_places` 끝에 닫힌 창의 `claim_tabs` 전부 `Ok`, 이어 다른 창도 `Ok` 두 줄.
- T11-3 `a_window_still_loading_is_left_out_of_the_quit` — 레이아웃이 아직 없는 창은 종료 라운드의 창 목록과 `openWindows` 에 들지 않는다.

- [ ] **Step 2: 실패를 확인하고 구현한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 새 테스트 FAIL → 행대로 고친 뒤 PASS. T5-3 은 동작이 같으므로 기존 감시 테스트가 그대로 통과하는 것으로 확인한다. T11-4 는 자리만 옮긴다.

- [ ] **Step 3: 전체 확인과 커밋**

Run: 네 가지 테스트 명령과 clippy. Expected: PASS, 개수를 적는다.

```bash
git add src-tauri/src/app/lifecycle.rs src-tauri/src/app/flush.rs src-tauri/src/app/mod.rs src-tauri/src/app/windows.rs src-tauri/src/app/menu.rs
git commit -m "fix(app): settle the window round minors left by the panes review"
```

---

### Task 7: TypeScript Minor 묶음 (T3-2, T6-3, T7-1, T8-1, T8-2, T9-1, T9-2, T9-4, T10-1, T10-2, T10-4, T10-6, T11-2, T11-5, T12-6, 재리뷰 Minor, T13-1, T4-3)

각 항목의 문제와 고치는 법은 출처 문서 「최종 리뷰에서 넘긴 것」 표의 같은 행이다. T11-5 의 `flush` 이벤트와 T12-5 는 Task 3 이 이미 다뤘다 — `outside` 이벤트만 남았으면 그것만 정리한다. T11-2 의 `takeOut` 은 Task 3 이 바꾼 `tearOff` 위에서 묶는다.

**Files:**

- Modify: `src/app/docs.ts`(T3-2), `src/core/session.ts`(T6-3), `src/backend/fake.ts`(T7-1, 재리뷰 Minor), `src/app/controller.ts`(T8-1·T8-2·T9-1·T9-2·T10-1·T11-2), `src/app/session-sync.ts`(T8-2), `src/ui/tab-bar.ts`(T10-2), `src/styles.css`(T10-4), `src/app/tabs.ts`·`src/app/tabs.test.ts`(T10-6), `src/backend/fake-hub.ts`(T11-5), `tests/e2e/rail.spec.ts`(T12-6, 재리뷰 Minor), `tests/e2e/memo.spec.ts` 또는 `claim` 시험 자리(T8-1), `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`(T13-1), `spikes/lab/src/drag/drag-page.ts`(T4-3)

**Interfaces:**

- Produces: `private async takeOut(pane: Pane, doc: Doc)`(T11-2), `claimTabs` 를 감싸는 함수 하나(T8-2, 이름은 구현자가 정하고 controller·session-sync 가 함께 쓴다), `DROP_EDGE_PX` 가 CSS 변수 `--pane-drop-edge` 로도 나간다(T10-4).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

- T6-3 `session.test.ts`: `parsePane` 에 `width: "x"` → 결과의 `width` 는 `typeof === "number"` 이고 `Number.isNaN(width)` 이 참(문자열이 숫자 타입에 들어가지 않는다).
- T8-1 e2e `a memo still opens when claiming its place fails` — `backend.claimTabs` 를 거부시킨 뒤 메모를 열면 탭이 생긴다.
- T9-1 e2e `a found line opens in the pane the tab lands in` — `openMatch` 가 기다리는 사이 다른 칸을 누르면 그 줄로 열린 대용량 뷰어가 새 칸에 있고 옛 칸에 `pendingLine` 이 남지 않는다(관찰 가능한 것: 옛 칸에서 다음에 연 메모가 그 줄로 가지 않는다).
- T9-2 단위 또는 e2e — 탭이 있는 칸에 `closePane` 을 불러도 칸이 남는다.
- T10-1 e2e — `to.activate` 가 거부돼도 빈 칸이 닫히고 세션이 갱신된다.
- T10-6 `tabs.test.ts`: `place` 의 인덱스 보정 두세 줄(`at < index` 와 `at > index`).
- 재리뷰 Minor — `whileWritingLayout` 훅이 라운드가 열린 뒤에만 돈다. E-10a 시험에서 두 번째 `flushAll` 을 빼면 실패하는지 구현자가 한 번 확인해 보고에 적는다(구분력 실증).

- [ ] **Step 2: 실패를 확인하고 구현한다**

Run: `pnpm test && pnpm test:e2e`
Expected: 새 테스트 FAIL → 행대로 고친 뒤 PASS. T9-4 는 「이 계획이 정한 것」 대로 앱 코드를 고치지 않는다. T12-6 은 페이지 언로드로 끊긴 문법 읽기를 경고하지 않는 쪽으로 고친다. 나머지(T3-2·T7-1·T10-2·T13-1·T4-3)는 동작이 바뀌지 않는 정리다.

- [ ] **Step 3: 전체 확인과 커밋**

Run: 네 가지 테스트 명령. Expected: PASS, 개수를 적는다.

```bash
git add <위 Files 의 바꾼 경로>
git commit -m "fix(app): settle the front-end minors left by the panes review"
```

---

### Task 8: 부하에서 흔들리는 테스트 셋의 원인 (N5, perf-fixtures, memo guard)

**Files:**

- Modify: 원인이 있는 테스트나 코드(`tests/e2e/watch.spec.ts`, `scripts/perf-fixtures.test.ts`, `tests/e2e/memo.spec.ts` 또는 그 아래 코드)
- Modify: `docs/guides/development.md`(부하 flake 를 다루는 절)

- [ ] **Step 1: 재현한다**

`uptime` 을 적고, 셋을 각각 `--repeat-each=20`(vitest 는 같은 테스트를 20번 도는 방법)으로 돌린다. 부하를 일부러 올려야 재현되면 `yes > /dev/null` 을 코어 수만큼 띄운 상태에서 돌리고 끝나면 반드시 끈다.
Expected: 실패 횟수와 실패 메시지.

- [ ] **Step 2: 원인을 찾는다**

각 실패마다 「기다리는 조건이 실제 완료 신호가 아니라 시간에 기대는가」 를 본다(N5: `.memo-row` 가 사라지는 신호가 감시 배치·목록 새로 고침 중 무엇에 매여 있는지. perf-fixtures: 시간 제한이 무엇을 재는지. memo guard: 「불러오는 중」 상태를 시험이 어떻게 만드는지).

- [ ] **Step 3: 고치거나 남긴다**

원인이 시험의 기다림이면 완료 신호를 기다리게 고친다. 앱 결함이면 실패하는 테스트를 먼저 두고 고친다. 원인을 못 찾으면 고치지 않고 개발 가이드에 「무엇을 봤고 무엇을 배제했는지」 를 적는다. 어느 경우든 Step 1 과 같은 조건으로 20번 다시 돌려 0 실패(또는 남긴 것의 실패율)를 적는다.

- [ ] **Step 4: 커밋**

Run: 네 가지 테스트 명령. Expected: PASS, 개수를 적는다.

```bash
git add <바꾼 경로> docs/guides/development.md
git commit -m "test: wait for real signals in the three tests that shook under load"
```

---

### Task 9: 에이전트 스모크와 사람 확인 목록

**Files:**

- Create: `docs/superpowers/reports/2026-10-18-tote-notes-panes-followups-smoke.md`

모든 실행에 `TOTE_DATA_DIR=<임시 폴더>` 를 준다. 화면 항목 전에는 코디네이터에게 알린다. 항목 번호는 칸·창 확인 문서의 번호를 그대로 쓴다.

- [ ] **Step 1: 디버그 번들**

Run: `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json`
Expected: `src-tauri/target/debug/bundle/macos/tote-dev.app`.

- [ ] **Step 2: 종료 (화면)** — G-2, G-3, G-4 를 칸·창 확인 문서의 절차대로. 더해서 시트 + `osascript … quit` 의 「취소」·「그래도 닫기」 각각에서 `osascript` 의 반환값을 적는다.

- [ ] **Step 3: 새 창 자리 (화면)** — C-2 를 같은 절차로(이 기계의 모니터 셋). 새 창의 자리·크기를 `osascript` 로 읽어 모니터 안인지 적는다. 모니터마다 배율이 다르면 그 값도 적는다.

- [ ] **Step 4: 떠나는 중 (화면)** — E-10, F-5 를 다시. 띠 클릭 직후 0.5초 동안 계속 `set-value` 로 글을 넣어 떠난 메모에 무엇이 남고 대상에 무엇이 생기는지 적는다. 저장 실패로 전환을 「취소」 한 뒤 같은 편집기에 글이 들어가는지 본다.

- [ ] **Step 5: 문구 (화면)** — E-9 시트 본문, D-9 상태 표시줄, E-11 띠에서 사라짐.

- [ ] **Step 6: 사람 확인 목록** — 에이전트가 할 수 없는 행을 보고서 끝 「사람 확인」 표에 둔다: E-10a(⌃숫자로 전환하며 계속 치기), F-3·G-7(로그아웃 — 시트 위의 로그아웃이 「그래도 닫기」 뒤 이어지는지, 「취소」 뒤 로그아웃이 취소되는지), C-8(모니터를 뺀 뒤 되살리기), 각 행에 절차와 기대를 적는다.

- [ ] **Step 7: 정리와 커밋**

앱을 끄고 임시 폴더를 지운다. `~/Tote-dev`·`~/Library/Application Support/tote-dev` 가 없는지 확인한다. 보고서에 항목별 결과(합격·불합격·확인 못 함과 이유), 도구의 한계, 실행한 명령을 적는다. 불합격은 고치지 않고 적는다.

```bash
git add docs/superpowers/reports/2026-10-18-tote-notes-panes-followups-smoke.md
git commit -m "docs: report the panes follow-up smoke"
```
