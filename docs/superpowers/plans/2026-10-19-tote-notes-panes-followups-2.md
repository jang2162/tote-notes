# tote-notes 칸·창 후속 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 칸·창 후속 계획이 다음 계획으로 넘긴 것 중 사람이 겪는 동작을 고친다 — 새 창이 메뉴 막대·Dock 밑에 깔리거나 원래 창을 덮는 것(M-3·M-4), 시간 초과 뒤 늦게 끝난 쓰기가 칸을 비운 채 남기는 것(M-5), 전환이 거둬진 뒤 포커스가 편집기로만 가는 것(M-6), 떠나는 중의 띠 클릭(T3 ⑤). 작은 정리와 시험 보강을 함께 한다.

**Architecture:** 창 자리는 모니터마다 전체 영역과 작업 영역(메뉴 막대·Dock 을 뺀 영역) 두 벌을 받는다. 어느 모니터인지는 전체 영역으로 고르고, 창은 작업 영역 안으로 들인다. 새 창은 원래 창에서 오른쪽·아래 24px 이되, 넘치는 축은 왼쪽·위 24px 로 간다. `flush_done` 은 「그 창이 계속 비어 있어야 하는가」 를 돌려준다 — 라운드가 이미 끝났고 창이 떠나지 않으면 `false` 이고, 페이지는 칸을 되돌린다. `leave()` 는 포커스 자리를 기억하고 `stay()` 가 그 자리로 돌린다.

**Tech Stack:** Tauri 2(2.12.1), Rust(`cargo test`), TypeScript + Vite, CodeMirror 6, Vitest, Playwright(WebKit), Orca `computer`.

**Spec:** `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`(「전체 구조」 의 「새 창」·「워크스페이스 띠」). 항목의 출처는 `docs/superpowers/reports/2026-10-18-tote-notes-panes-followups-smoke.md` 「다음 계획으로 넘기는 것」 표다. 앞 계획 `docs/superpowers/plans/2026-10-18-tote-notes-panes-followups.md` 와 그 판정 `docs/superpowers/reports/2026-10-18-tote-notes-panes-followups-rulings.md` 가 만든 코드 위에서 돈다.

## 이 계획이 정한 것

- **작업 영역은 Tauri 가 준다.** tauri 2.12.1 의 `Monitor::work_area()` 는 macOS 에서 `NSScreen.visibleFrame` 으로 만든 물리 단위 사각형이다. 지금처럼 그 모니터의 `scale_factor()` 로 나눠 논리 단위로 쓴다. 새 의존성은 없다.
- **모니터는 전체 영역으로 고르고, 창은 작업 영역에 들인다.** 기준점(`x+40, y+10`)이 Dock·메뉴 막대 위에 있어도 그 모니터로 본다. 작업 영역이 창보다 작으면 창을 줄인다(프레임의 높이가 곧 창 전체 높이다. Tauri 의 macOS 기본 제목 표시줄 스타일이 콘텐츠 뷰를 창 전체로 잡는다).
- **새 창의 계단.** 원래 창에서 오른쪽·아래 24px 로 놓되, 그렇게 놓으면 작업 영역의 오른쪽 끝을 넘는 경우 x 는 왼쪽 24px, 아래 끝을 넘는 경우 y 는 위쪽 24px 로 놓는다. 그다음 작업 영역 안으로 들인다. 원래 창이 작업 영역보다 커서 어느 쪽으로도 24px 옮길 자리가 없을 때만 겹칠 수 있다.
- **늦은 쓰기의 답.** `flush_done` 이 `bool` 을 돌려준다. `true` = 칸을 계속 비워 둔다(라운드가 열려 있거나 묻는 중이거나, 그 창이 닫히는 중·전환 중이다). `false` = 라운드는 이미 끝났고 그 창은 남는다 → 페이지가 `stay()` 한다. 함께 온 저장 실패 이유는 지금처럼 버린다(늦은 답은 질문을 다시 띄우지 않는다).
- **포커스 복귀.** `leave()` 때 `document.activeElement` 가 칸 밖(사이드바 필터·검색 입력 등)이면 그것을 기억하고, `stay()` 는 그 요소가 아직 문서에 있으면 그리로, 아니면 지금처럼 포커스 칸으로 돌린다.
- **떠나는 중의 띠.** `switchTo` 와 `newWorkspace` 첫 줄에서 떠나는 중이면 아무것도 하지 않는다. 띠 클릭과 ⌃1–⌃9 가 같은 자리에서 막힌다. 지금 ⌃ 리스너에 있는 `this.leaving` 검사는 그대로 둬도 된다(대화상자 검사가 함께 있다).
- **하지 않는 것:** 새로 고침 실패(T3 ②) — 웹뷰 `reload()` 가 실패할 자리가 실제로 없다. 로그아웃 확인(I-1, F-3·G-7) — 사람이 나중에 한다(사람 판단으로 이월). `Waiting::Terminate` 재진입 실측(T1 A), 복원 중 창의 종료 라운드(T6) — 동작 문제가 아니다. `AppHandle` 배선 시험(T3·T4) — tauri test feature 를 들이는 일은 이 계획 밖이다.

## Global Constraints

모든 태스크의 요구 사항에 아래가 포함된다.

- 플랫폼은 macOS 먼저다. OS 에 기대는 코드는 Rust 모듈 경계 안에 가둔다. 새 직접 의존을 들이지 않는다.
- **앱 종료를 막는 경우는 저장 실패 하나뿐이다.** Dock 종료·AppleScript 종료·로그아웃의 답(`system_quit::answer`)은 정확히 한 번이다 — 이 계획은 그 경로를 바꾸지 않는다.
- **쓰고 닫기(flush) 라운드의 시간 제한(3초)과 답 표(`steps_for_ack`·`steps_for_answer`)의 기존 행은 바꾸지 않는다.**
- 값: 새 창 오프셋 **24px**, 기본 창 크기 **1100×760**, 칸 최소 폭 **320px**, 띠 폭 **48px**. 단축키는 바꾸지 않는다.
- 사용자에게 보이는 문구는 한국어, 코드 주석은 영어. 주석 규칙은 `docs/guideline/base/03-comments.md`, 인용은 `docs/guideline/base/04-citation.md`(줄번호가 아니라 이름·절 제목).
- **스펙을 고치는 태스크는 같은 커밋에 코어 스펙의 해당 절을 고친다.** 스펙은 지금 참인 동작만 적는다.
- **커밋:** 경로를 명시해 stage 한다(`git add -A` 금지). 커밋 전에 `pnpm exec oxfmt <바꾼 파일>`, `pnpm exec oxlint --fix <바꾼 TS 파일>`(zsh 에서는 파일 목록을 배열로), `cargo fmt --manifest-path src-tauri/Cargo.toml`, Rust 를 바꿨으면 `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- **테스트 명령:** Rust `cargo test --manifest-path src-tauri/Cargo.toml`(필터가 둘 이상이면 `--` 뒤에), 단위 `pnpm test`, 타입 `pnpm typecheck`, e2e `pnpm test:e2e`(WebKit, `TOTE_E2E_PORT` — 워크트리마다 다른 값). 결과는 **실행된 개수**와 함께 보고한다(0개면 통과가 아니다). 태스크 끝에는 넷 모두 돌린다. 새 e2e 는 타이머 창에 기대지 않고 시험이 푸는 게이트나 실제 신호를 기다린다(`docs/guides/development.md` 의 부하 flake 절).
- **에이전트가 앱을 띄울 때는 반드시 `TOTE_DATA_DIR=<임시 폴더>`**, 화면이 필요 없으면 `TOTE_BACKGROUND=1`. 디버그 번들은 `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json`. 앱을 끄는 클릭에 `orca computer … --restore-window` 를 쓰지 않는다. 끝나면 `~/Tote-dev`·`~/Library/Application Support/tote-dev` 가 없는지 본다. 화면 클릭은 요소로만(좌표 클릭 금지). 화면을 쓰기 전에는 코디네이터에게 알린다. 로그아웃은 하지 않는다.

## Review Focus

1. **Dock 이 왼쪽·아래에 있거나 메뉴 막대가 있는 모니터에서 저장된 창을 되살린다.** 창의 신호등 버튼이 Dock 밑에 깔리거나 제목 표시줄이 메뉴 막대 밑으로 들어가면 안 되고, 기준점이 Dock 위에 있다는 이유로 기본 크기·가운데로 튀어도 안 된다. Task 1 의 `a_frame_whose_probe_is_on_the_dock_stays_on_its_monitor`·`a_restored_frame_clears_the_menu_bar_and_the_dock` 가 고정한다.
2. **화면 오른쪽 아래 끝에 붙은 창에서 ⌥⌘N.** 새 창이 원래 창을 덮어 안 열린 것처럼 보이면 안 된다. Task 1 의 `a_new_window_at_the_corner_steps_back_up_and_left` 와 Task 5 의 C-2 행이 고정한다.
3. **3초 넘게 걸린 쓰기 뒤 전환이 거둬진다**(대상이 이미 다른 창에 있거나 열지 못함). 칸이 빈 채 남으면 그 창에 아무것도 칠 수 없다. Task 2 의 `a late answer after the round ended gives the panes back` 이 고정한다.
4. **늦은 답이 왔는데 그 창은 실제로 전환·닫기 중이다.** 이때 칸을 되돌리면 새로 고침 직전에 친 글이 사라진다. Task 2 의 `a_late_answer_keeps_a_switching_window_empty` 가 고정한다.
5. **검색 입력에 커서를 둔 채 저장 실패 전환을 「취소」.** 포커스가 편집기로 뺏기면 친 글이 메모에 들어간다. Task 2 의 `a cancelled switch gives focus back to the search box` 가 고정한다.

---

## 파일 구조

```
src-tauri/src/
  app/windows.rs       MonitorRect{full, work}, monitor_rects, place, cascade (near_frame 대신)
  app/menu.rs          ⌥⌘N 이 cascade 를 쓴다
  app/commands.rs      flush_done 이 bool 을 돌려준다; 떼어 내기도 cascade
  app/lifecycle.rs     ack 가 늦은 답을 판정한다; ask_blocked·blocked_message 의 표
  app/flush.rs         Ack::Stale
  app/mod.rs           AppCore::window_is_leaving; begin_flush 주석; 종료 필터 시험
src/
  backend/types.ts     flushDone(...): Promise<boolean>
  backend/tauri.ts     위
  backend/fake.ts      flushDone 의 답, staleFlush 시험 손잡이
  app/controller.ts    onFlush 가 false 면 stay(); leave/stay 포커스; switchTo·newWorkspace 가드
tests/e2e/rail.spec.ts, tests/e2e/tear-off.spec.ts, tests/e2e/search.spec.ts, src/highlight/*.test.ts
docs/superpowers/specs/2026-10-07-tote-note-core-design.md
docs/superpowers/reports/2026-10-19-tote-notes-panes-followups-2-smoke.md   (새) Task 5
```

---

### Task 1: 창 자리를 작업 영역에 들이고, 새 창은 넘치는 쪽으로 물러선다 (M-3, M-4, T2 M4)

**Files:**

- Modify: `src-tauri/src/app/windows.rs` (`monitor_rects`, `place`, `near_frame`, `open_window`)
- Modify: `src-tauri/src/app/menu.rs`(⌥⌘N), `src-tauri/src/app/commands.rs`(떼어 내기) — `near_frame` 을 부르던 자리
- Modify: 코어 스펙 「새 창」
- Test: `windows.rs` 의 `mod tests`

**Interfaces:**

- Produces:
  - `pub struct MonitorRect { pub full: Rect, pub work: Rect }`, `type Rect = (f64, f64, f64, f64)`(논리 단위 x, y, w, h — 지금 튜플과 같은 순서).
  - `fn monitor_rects(app) -> Vec<MonitorRect>` — `work` 는 `monitor.work_area()` 를 그 모니터의 `scale_factor()` 로 나눈 것.
  - `pub fn place(frame: WindowFrame, monitors: &[MonitorRect]) -> Option<WindowFrame>` — 기준점으로 `full` 에서 모니터를 고르고 `work` 안에 들인다(줄이기·들이기 규칙은 지금과 같고 대상 사각형만 `work`).
  - `pub fn cascade(source: WindowFrame, monitors: &[MonitorRect]) -> WindowFrame` — 「이 계획이 정한 것」 의 계단 규칙으로 정한 자리. 결과는 `place` 를 거쳐 쓴다. `near_frame` 은 지운다(쓰는 곳이 `cascade` 로 바뀐다).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

모니터 `M` 은 둘이다 — 메인 `full (0,0,3840,1600)`, `work (61,33,3779,1567)`(왼쪽 Dock 61, 메뉴 막대 33); 오른쪽 `full (3840,-734,1440,2560)`, `work (3840,-701,1440,2527)`(메뉴 막대만).

- `a_new_window_at_the_corner_steps_back_up_and_left` — 원래 창 `(4180, 1038, 1100, 760)`(오른쪽 모니터의 오른쪽 아래 끝: 4180+1100=5280, 1038+760+28=1826) → `place(cascade(src, &M), &M)` 가 `Some((4156, 1014, 1100, 760))`.
- `a_new_window_in_the_open_steps_down_and_right` — `(500, 300, 1100, 760)` → `Some((524, 324, 1100, 760))`.
- `a_new_window_at_the_right_edge_only_steps_left` — `(2740, 300, 1100, 760)`(오른쪽 끝 3840) → `Some((2716, 324, 1100, 760))`.
- `a_restored_frame_clears_the_menu_bar_and_the_dock` — `place((20, 10, 900, 600), &M)` → `Some((61, 33, 900, 600))`.
- `a_frame_whose_probe_is_on_the_dock_stays_on_its_monitor` — `place((0, 100, 900, 600), &M)`(기준점 40,110 은 Dock 위) → `Some((61, 100, 900, 600))`. `None` 이 아니다.
- `a_window_taller_than_the_work_area_shrinks_to_it` — `place((100, 100, 900, 1600), &M)` → 높이 `1567 - 28 = 1539`, `y = 33`.
- `a_nan_frame_is_dropped` — `x` 가 `NaN` 이면 `None`. `a_zero_sized_frame_is_kept_in_place` — `(100, 100, 0, 0)` → `Some((100, 100, 0, 0))`(창 최소 크기 `480×320` 이 막는다는 주석 한 줄).
- 기존 `place` 시험들은 `MonitorRect` 로 옮기되(`full == work` 로 두면 값이 같다) 그대로 통과해야 한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows`
Expected: FAIL(정의 없음).

- [ ] **Step 3: 구현한다**

`monitor_rects` 가 두 벌을 만든다. `place` 의 대상 사각형을 `work` 로 바꾼다. `cascade` 를 쓰고 ⌥⌘N·떼어 내기가 `near_frame` 대신 그것을 쓴다. `available_monitors()` 실패·빈 목록의 로그 한 줄은 그대로다. 스펙 「새 창」 의 자리 문장을 「원래 창에서 오른쪽·아래 24px 로 열되, 그쪽으로 모니터의 작업 영역(메뉴 막대·Dock 을 뺀 영역)을 넘치는 축은 왼쪽·위로 24px 옮긴다. 창은 작업 영역 안에 다 들어가게 놓고, 작업 영역보다 크면 줄인다. 되살리는 창도 같다. 저장된 자리의 모니터가 없으면 기본 크기로 가운데에 연다.」 로 고친다.

- [ ] **Step 4: 통과를 확인하고 커밋**

Run: 네 가지 테스트 명령과 clippy. Expected: PASS, 개수를 적는다.

```bash
git add src-tauri/src/app/windows.rs src-tauri/src/app/menu.rs src-tauri/src/app/commands.rs docs/superpowers/specs/2026-10-07-tote-note-core-design.md
git commit -m "fix(windows): place windows in the work area and step a new window back when it would overflow"
```

---

### Task 2: 늦은 쓰기 답은 칸을 되돌리고, 포커스는 원래 자리로, 떠나는 중의 띠는 막는다 (M-5, M-6, T3 ⑤)

**Files:**

- Modify: `src-tauri/src/app/flush.rs` (`Ack`, `ack`)
- Modify: `src-tauri/src/app/lifecycle.rs` (`ack`), `src-tauri/src/app/mod.rs` (`window_is_leaving`), `src-tauri/src/app/commands.rs` (`flush_done`)
- Modify: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src/app/controller.ts` (`onFlush`, `leave`, `stay`, `switchTo`, `newWorkspace`)
- Modify: 코어 스펙 「워크스페이스 띠」
- Test: `flush.rs`·`lifecycle.rs`·`mod.rs` 의 `mod tests`, `tests/e2e/rail.spec.ts`

**Interfaces:**

- Produces:
  - `flush.rs`: `Ack::Stale` — 그 id 의 라운드가 없을 때. 라운드가 있고 묻는 중이면 지금처럼 `Pending`.
  - `AppCore::window_is_leaving(&self, label: &str) -> bool` — 그 창의 `in_switch || switching || closing`.
  - `fn keeps_leaving(ack: &Ack, window_is_leaving: bool) -> bool`(순수, `lifecycle.rs`) — `Stale` 이면 `window_is_leaving`, 그 밖은 `true`.
  - `lifecycle::ack(...) -> bool`, 명령 `flush_done` 이 그 값을 돌려준다.
  - TS: `Backend.flushDone(id: number, blocked?: string): Promise<boolean>`. `FakeBackend.staleFlush: boolean`(시험 손잡이, 켜면 `flushDone` 이 `false`).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Rust:

- `flush.rs` `an_answer_for_an_ended_round_is_stale` — 라운드를 `expire` 로 끝낸 뒤 그 id 의 `ack` 는 `Ack::Stale`. 묻는 중인 라운드의 `ack` 는 `Pending` 그대로.
- `lifecycle.rs` `a_late_answer_keeps_a_switching_window_empty` — `keeps_leaving(&Ack::Stale, true) == true`, `keeps_leaving(&Ack::Stale, false) == false`, `keeps_leaving(&Ack::Done, false) == true`.
- `mod.rs` `a_window_is_leaving_while_it_switches_or_closes` — `prepare_switch` 뒤 `true`, `finish_switch` 와 `page_started` 뒤 `false`; `closing` 뒤 `true`, `close_failed` 뒤 `false`.

e2e (`rail.spec.ts`):

- `a late answer after the round ended gives the panes back` — `backend.staleFlush = true`, `requestFlush(77, "switch")` → 칸이 비었다가 답 뒤 다시 편집 가능하고, 친 글이 같은 메모에 들어간다.
- `a cancelled switch gives focus back to the search box` — 저장 실패를 만들고 검색 입력에 포커스를 둔 채 띠를 눌러 「취소」(가짜의 기존 갈래) → 포커스가 검색 입력에 있다(`document.activeElement` 가 그 입력). 포커스가 편집기에 있던 경우는 기존 시험 「a switch the person cancels gives the editor back」 이 그대로 통과해야 한다.
- `a rail click while the window leaves does nothing` — 떠나는 중(`switchGate` 로 붙잡은 상태)에 다른 띠 항목을 누르면 `switchWorkspace` 가 다시 불리지 않는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- flush lifecycle app::` 와 `pnpm test:e2e tests/e2e/rail.spec.ts`
Expected: 새 테스트 FAIL.

- [ ] **Step 3: 구현한다**

`ack` 가 라운드를 못 찾으면 `Stale`. `lifecycle::ack` 는 `keeps_leaving(&ack, core.window_is_leaving(label))` 을 돌려주고, 단계 실행(`steps_for_ack`)은 지금과 같다. `onFlush` 는 `flushDone` 이 `false` 이고 `goal !== "quit"` 이면 `stay()`. `leave()` 가 칸 밖 포커스 요소를 기억하고 `stay()` 가 그리로 돌린다. `switchTo`·`newWorkspace` 첫 줄에 `if (this.leaving) return;`. 스펙 「워크스페이스 띠」 에 「떠나는 중에는 띠를 눌러도 아무것도 하지 않는다」 와 「칸이 돌아올 때 포커스도 떠나기 전 자리로 돌아간다」 를 더하고, 「전환이 거둬지면」 의 경우에 「쓰기가 시간 제한을 넘겨 늦게 끝난 경우」 를 더한다.

- [ ] **Step 4: 통과를 확인하고 커밋**

Run: 네 가지 테스트 명령과 clippy. 바꾼 e2e 는 `--repeat-each=5`. Expected: PASS, 개수를 적는다.

```bash
git add src-tauri/src/app/flush.rs src-tauri/src/app/lifecycle.rs src-tauri/src/app/mod.rs src-tauri/src/app/commands.rs src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src/app/controller.ts tests/e2e/rail.spec.ts docs/superpowers/specs/2026-10-07-tote-note-core-design.md
git commit -m "fix(windows): give the panes back after a late answer, restore focus, and ignore the rail while leaving"
```

---

### Task 3: Rust 정리 (T5 `anyway`, T6 주석·필터 시험)

각 항목은 `docs/superpowers/reports/2026-10-18-tote-notes-panes-followups-smoke.md` 「다음 계획으로 넘기는 것」 의 같은 이름 행이다.

**Files:**

- Modify: `src-tauri/src/app/lifecycle.rs` (`ask_blocked`, `blocked_message`, 시험 위치)
- Modify: `src-tauri/src/app/mod.rs` (`begin_flush` 주석, 종료 필터 시험, 100자 넘는 주석 줄)

**Interfaces:**

- Produces: `fn blocked_labels(goal: &FlushGoal) -> (&'static str, &'static str)` — (버튼 이름, 「그래도 …하면」 문장 머리). `ask_blocked`·`blocked_message` 가 이것 하나를 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

- `every_goal_has_one_button_and_one_sentence` — 세 목표 각각의 `blocked_labels` 가 (`그래도 닫기`, `그래도 닫으면`), (`그래도 바꾸기`, `그래도 바꾸면`), (`그래도 종료`, `그래도 종료하면`).
- 종료 필터: `a_focused_window_without_a_layout_joins_the_quit` — 레이아웃이 없지만 포커스된 창은 종료 라운드에 든다(필터의 오른쪽 갈래를 직접 단언).

- [ ] **Step 2: 실패를 확인하고 구현한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- blocked quit`
Expected: 새 테스트 FAIL(정의 없음) → 표로 모으고 `blocked_message` 시험을 도우미 아래로 옮긴 뒤 PASS. `begin_flush` 의 두 주석 블록을 한 문단으로 합치고 100자 넘는 시험 주석 줄을 접는다.

- [ ] **Step 3: 전체 확인과 커밋**

Run: `cargo test` 와 clippy, 나머지 세 명령. Expected: PASS, 개수를 적는다.

```bash
git add src-tauri/src/app/lifecycle.rs src-tauri/src/app/mod.rs
git commit -m "refactor(app): name each blocked goal's button and sentence in one place"
```

---

### Task 4: TypeScript 시험 보강과 정리 (T5 배너 문구, T7 가드·세션·주석, 옛 `tearOffDelayMs` 시험)

각 항목은 `docs/superpowers/reports/2026-10-18-tote-notes-panes-followups-smoke.md` 「다음 계획으로 넘기는 것」 의 같은 이름 행이다.

**Files:**

- Modify: `tests/e2e/tear-off.spec.ts`, `tests/e2e/search.spec.ts`, `src/highlight/*.test.ts`(가드 시험), `spikes/lab/src/drag/drag-page.ts`(주석)

- [ ] **Step 1: 시험을 더하고 고친다**

- `tear-off.spec.ts` `a tab with a save failure and a conflict banner says the banner` — 저장 실패와 충돌 배너가 함께 있는 탭을 떼어 내면 상태 표시줄이 `NOT_MOVED_WITH_BANNER`.
- 옛 `tearOffDelayMs` 시험을 `tearOffGate` 로 바꾼다(타이머 창이 없게). `tearOffDelayMs` 를 쓰는 곳이 더 없으면 가짜에서 걷는다.
- `pageLeaving` 가드: `grammars.ts` 말고 가드가 걸린 다른 자리(`client.ts` 등) 각각에 「떠나는 중의 읽기 실패는 경고하지 않고, 그 밖에는 경고한다」 단위 시험.
- `search.spec.ts` 「a found line opens in the pane the tab lands in」 의 손으로 만든 세션을 그 spec 의 도우미(없으면 `tests/e2e/helpers.ts` 의 기존 도우미)로 만든다.
- `drag-page.ts` 의 「The run's first stays…」 주석을 읽히게 고친다(동작 그대로).

- [ ] **Step 2: 확인과 커밋**

새·바꾼 시험이 그 가드·갈래를 되돌리면 실패하는지 보인다(배너 문구 시험은 문구 판정을 저장 실패 쪽으로 바꿔 보는 식). Run: 네 가지 테스트 명령, 바꾼 e2e `--repeat-each=5`. Expected: PASS, 개수를 적는다.

```bash
git add <바꾼 경로>
git commit -m "test: pin the banner wording overlap and the leaving guards, and gate the old tear-off test"
```

---

### Task 5: 에이전트 스모크와 사람 확인 목록

**Files:**

- Create: `docs/superpowers/reports/2026-10-19-tote-notes-panes-followups-2-smoke.md`

모든 실행에 `TOTE_DATA_DIR=<임시 폴더>`. 화면 항목 전에 코디네이터에게 알린다.

- [ ] **Step 1: 디버그 번들** — `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json`, 빌드한 커밋을 적는다.
- [ ] **Step 2: 새 창 자리 (화면)** — 이 기계의 모니터·Dock 위치를 먼저 적는다(`osascript` 로 Dock 방향, 각 모니터의 frame·visibleFrame). ① C-2: 창을 한 모니터의 오른쪽 아래 끝에 두고 ⌥⌘N → 새 창이 왼쪽·위 24px 에 열려 원래 창의 제목 표시줄이 보이는지. ② 창을 Dock 쪽 가장자리·메뉴 막대에 걸치게 둔 뒤 ⌘Q → 다시 켜서 신호등 버튼과 제목 표시줄이 Dock·메뉴 막대 밖에 있는지. 자리·크기를 `osascript` 로 읽어 적는다.
- [ ] **Step 3: 포커스와 띠 (화면)** — 저장 실패 상태에서 검색 입력에 커서를 두고 띠 클릭 → 「취소」 → 그대로 글자를 넣었을 때 검색 입력에 들어가는지. 저장 실패 질문이 떠 있는 동안 다른 띠 항목을 눌러도 두 번째 전환이 시작되지 않는지.
- [ ] **Step 4: 정리** — 앱을 끄고 임시 폴더를 지운다. 개발용 폴더 둘이 없는지 확인한다.
- [ ] **Step 5: 보고서와 커밋** — 항목별 합격·불합격·확인 못 함, 도구의 한계, 실행한 명령. 끝에 「사람 확인」 표: 이월된 로그아웃 확인(F-3·G-7, 절차는 `docs/superpowers/reports/2026-10-18-tote-notes-panes-followups-smoke.md` 「사람 확인」), E-10a, C-8, 늦은 쓰기(M-5)를 실제 앱에서 만들 방법이 있으면 그 절차.

```bash
git add docs/superpowers/reports/2026-10-19-tote-notes-panes-followups-2-smoke.md
git commit -m "docs: report the panes follow-up 2 smoke"
```
