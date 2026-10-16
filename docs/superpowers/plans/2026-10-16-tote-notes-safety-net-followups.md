# tote-notes 안전망 후속 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 안전망 계획이 사람에게 올린 판단 다섯 개(앱을 끈 뒤의 첫 백업, `<!DOCTYPE html>` 대소문자, 텍스트 메모만 검색, 이전 버전 시각의 구간 표시, 충돌 보관의 탭 배너)와 다음 계획으로 넘긴 결함 셋(충돌 보관 알림이 닿지 않음, 창 닫기 질문 중 종료의 대화상자 겹침, 백업 실패를 한 번만 알림)을 고치고 스펙에 반영한다.

**Architecture:** 백업은 워크스페이스를 열 때 「바뀐 것」으로 표시하고, 백업 스레드가 시작 직후 한 번 돌고 새로 연 창에는 깨움 신호로 바로 돈다. 직전 스냅샷과 똑같으면 폴더를 만들지 않는다. 백업 실패 알림은 순수 구조체(`FailureNotices`)로 빼서 창을 닫으면 잊고 하루마다 다시 알린다. 이전 버전 목록은 같은 내용이 이어진 구간의 끝 시각(`until`)을 싣는다. 충돌 보관은 상태 표시줄 문구 대신 세션에 실리는 탭 배너가 된다. 종료 겹침은 `FlushCoordinator` 가 묻는 중인 창 닫기 라운드에 종료 요청을 흡수하고, 그 라운드의 답이 종료를 잇거나 거절한다.

**Tech Stack:** Tauri 2, Rust(`cargo test`), TypeScript + Vite, CodeMirror 6, Vitest, Playwright(WebKit), Orca `computer-use`.

**Spec:** `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`. 판단과 결함의 출처는 `docs/superpowers/reports/2026-10-15-tote-notes-safety-net-smoke.md` 「사람 판단 필요」·「다음 계획으로 넘기는 결함」 절이다. 앞 계획 `docs/superpowers/plans/2026-10-12-tote-notes-safety-net.md` 가 만든 코드 위에서 돈다. 실행자는 셋을 함께 읽는다.

## 이 계획이 정한 것

보고서의 판단이 방향만 정하고 비워 둔 자리를 채운 것이다.

- **「앱을 끈 뒤의 첫 백업」은 「워크스페이스를 열 때 한 번 찍는다」로 구현한다.** 판단 1의 「다음 실행 첫 틱」을 시작 복원뿐 아니라 실행 중에 연 워크스페이스에도 적용한다. 같은 실행 안에서 창을 닫았다 다시 연 경우도 같은 틈(닫기 전 10분 안의 변경)이 있기 때문이다. 시작 때는 백업 스레드의 첫 틱이 기다리지 않고 바로 돈다. 실행 중에 연 창은 깨움 신호로 그 창만 바로 찍는다.
- **직전 스냅샷과 파일 목록·내용이 모두 같으면 스냅샷 폴더를 만들지 않는다.** 열 때마다 찍으면 똑같은 스냅샷이 쌓이기 때문이다. 정기 틱에도 같은 규칙을 적용한다(스펙 「바뀐 것이 있을 때만」에 더 가깝다).
- **깨움 신호는 정기 틱 시각을 밀지 않는다.** 백업 스레드는 다음 정기 틱의 마감 시각을 들고 있고, 깨움은 그 사이에 끼어든다.
- **백업 실패는 창이 열려 있는 동안 처음 한 번, 그 뒤로는 실패가 이어지면 24시간마다 다시 알린다.** 창을 닫으면 잊는다. 같은 워크스페이스를 다시 열고 또 실패하면 다시 알린다. 알림 자리와 문구(「백업하지 못했습니다: …」, 상태 표시줄의 오류 문구)는 그대로다.
- **이전 버전의 구간 표시.** 같은 날이면 `2026-10-12 07:50:00 – 08:30:00`, 날이 다르면 `2026-10-12 23:50:00 – 2026-10-13 00:30:00`. 구간이 아니면 지금처럼 시각 하나. 구간의 끝은 그 내용이 마지막으로 찍힌 스냅샷이다.
- **검색 대상은 `MemoInfo.kind` 가 `Text` 인 메모다.** 종류는 확장자로 정해진다(`kind_for`). NUL 검사(바이너리 건너뛰기)는 그대로 둔다 — 확장자가 텍스트인 바이너리를 막는 몫이다.
- **`firstLine` 패턴은 대소문자를 무시한다.** VS Code 와 같다. 번들 `package.json` 의 패턴은 고치지 않는다.
- **충돌 보관 배너.** 충돌을 고르지 않은 채 창을 닫거나 앱을 끄면 「내 버전」을 새 메모로 저장하는 동작은 그대로다. 그 새 메모의 탭에 정보 배너를 띄우고 세션에 싣는다. 사람이 「닫기」를 누를 때까지 다시 켜도 남는다. 문구는 Task 5 에 고정한다. 상태 표시줄 문구(`CONFLICT_KEPT_NOTICE`)는 걷는다.
- **창 닫기 질문 중의 종료 요청.** 묻는 중인 창 닫기 라운드가 있으면 종료 요청(⌘Q·메뉴·Dock·로그아웃)은 새 대화상자를 띄우지 않고 그 라운드에 「종료 대기」로 붙는다. 「그래도 닫기」면 창을 닫고 종료를 이어서 시작한다. 「취소」면 종료도 취소한다(Dock·로그아웃이면 macOS 에 「끄지 않음」으로 답한다).

## 이 계획이 다루지 않는 것

- 분할 화면, 같은 워크스페이스의 새 창, 워크스페이스 전환 띠 — 다음 계획(설계 문서를 먼저 쓴다).
- `LONG_LINE_LIMIT` 언어별 한도, 메모리 목표치, Zed·Sublime 비교 — 보고서 판단 2·8·9 에서 하지 않기로 했다.
- 세션 복원 50탭 재측정 — 사람 화면이 필요한 측정이라 계획 밖에서 한다(판단 7·10).
- 앱을 끄는 순간의 스냅샷 — 판단 1 에서 고르지 않은 쪽이다.

## Global Constraints

모든 태스크의 요구 사항에 아래가 포함된다.

- 플랫폼은 macOS 먼저다. OS 에 기대는 코드는 Rust 모듈 경계 안(`backup`, `watch`, `appdata`, `cli`, `app/lifecycle.rs` 의 `system_quit`)에 가둔다.
- **원자적 쓰기**와 **백업 하드링크 규칙**(직전 스냅샷의 사본에만 하드링크, 워크스페이스 파일 자체에는 하지 않는다)은 바꾸지 않는다.
- 보존 규칙(24시간 안 전부, 30일까지 하루 하나, 그 뒤 삭제)과 간격 **10분**(`backup::INTERVAL`), 디버그 빌드의 `TOTE_BACKUP_INTERVAL_SECS` 는 바꾸지 않는다.
- **앱 종료를 막는 경우는 저장 실패 하나뿐이다.** 이 계획의 어떤 변경도 종료를 느리게 하거나 새 질문을 더하지 않는다.
- **Dock 종료·로그아웃은 macOS 가 답을 기다린다.** `TerminateLater` 를 돌려준 요청은 어떤 경로로 끝나든 `system_quit::answer` 로 한 번 답한다. 빠지면 로그아웃이 영원히 기다린다.
- 사용자에게 보이는 문구는 한국어, 코드 주석은 영어. 주석 규칙은 `docs/guideline/base/03-comments.md`, 인용은 `docs/guideline/base/04-citation.md`(줄번호가 아니라 이름·절 제목).
- **스펙을 고치는 태스크는 같은 커밋에 `docs/superpowers/specs/2026-10-07-tote-note-core-design.md` 의 해당 절을 고친다.** 스펙은 지금 참인 동작만 적는다(연대기 금지).
- **커밋:** 경로를 명시해 stage 한다(`git add -A` 금지). 커밋 전에 `pnpm exec oxfmt <바꾼 파일>`, `pnpm exec oxlint --fix <바꾼 TS 파일>`, `cargo fmt --manifest-path src-tauri/Cargo.toml`.
- **테스트 명령:** Rust `cargo test --manifest-path src-tauri/Cargo.toml`, 단위 `pnpm test`, 타입 `pnpm typecheck`, e2e `pnpm test:e2e`(WebKit, `TOTE_E2E_PORT` 기본 1430). 결과는 **실행된 개수**와 함께 보고한다(0개면 통과가 아니다). 태스크 끝에는 셋 모두 돌린다.
- **에이전트가 앱을 띄울 때는 반드시 `TOTE_DATA_DIR=<임시 폴더>`** 를 주고, 사람 화면을 쓰지 않는 확인은 `TOTE_BACKGROUND=1` 도 준다. 끝나면 `~/Tote-dev` 와 `~/Library/Application Support/tote-dev` 가 생기지 않았는지 검사한다. 실제 메모 폴더 `~/Tote` 는 건드리지 않는다.

## Review Focus

1. **백업 스레드의 정기 틱과 열 때 찍기가 같은 워크스페이스에 동시에 돈다.** 한쪽의 `remove_leftovers` 가 다른 쪽이 만드는 `.tmp-*` 를 지우면 스냅샷이 깨진다. 깨움은 같은 스레드가 처리해 둘이 겹치지 않아야 한다. Task 1 의 `a_wake_snapshots_only_the_woken_workspace` 와 구조(별도 스레드를 띄우지 않는다)가 고정한다.
2. **편집 없이 앱을 여러 번 켜고 끈다.** 스냅샷 폴더가 켤 때마다 늘면 안 된다. Task 1 의 `a_snapshot_identical_to_the_previous_one_makes_no_folder` 가 고정한다.
3. **Dock 종료가 창 닫기 질문에 붙은 뒤 사람이 「취소」를 누른다.** macOS 가 답을 받지 못하면 로그아웃이 멈춘다. Task 6 의 `cancelling_an_asking_close_reports_the_waiting_quit` 과 스모크 항목이 고정한다.
4. **충돌 보관 배너가 있는 탭을 닫고 메모 목록에서 다시 연다.** 탭을 닫으면 배너도 끝난 것이다 — 다시 열었을 때 배너가 되살아나면 안 된다. Task 5 의 `the conflict-kept banner ends with its tab` 이 고정한다.
5. **백업 실패가 이어지는 워크스페이스 창을 닫았다 다시 연다.** 다시 열었을 때 또 실패하면 알려야 한다. Task 2 의 `a_reopened_window_is_told_again` 이 고정한다.

---

## 파일 구조

```
src-tauri/src/
  workspace/mod.rs        Workspace::open 이 changed 를 세운다
  backup/snapshot.rs      직전과 같으면 폴더 없음
  backup/notices.rs       (새) FailureNotices — 실패 알림을 언제 할지
  backup/versions.rs      Version.until
  app/mod.rs              backup_tick 의 only, request_backup, window_labels
  app/windows.rs          show 가 새 창에 request_backup
  app/flush.rs            Round.quit_waiting, begin/cancel
  app/lifecycle.rs        resolve_blocked 가 종료 대기를 잇거나 거절
  app/commands.rs         search_workspace 가 텍스트 메모만
  search/mod.rs           text_candidates
  lib.rs                  start_backups: 첫 틱 즉시, 깨움 채널, FailureNotices
src/
  core/language.ts        firstLine 대소문자 무시
  core/session.ts         TabPlace.conflictKept
  app/docs.ts             충돌 보관 배너
  app/session-sync.ts     배너 싣기·되살리기
  backend/types.ts        Version.until
  backend/fake.ts         listVersions 가 구간을 접는다
  ui/versions.ts          versionLabel(version)
docs/superpowers/reports/2026-10-16-tote-notes-safety-net-followups-smoke.md
```

---

### Task 1: 워크스페이스를 열 때 한 번 찍고, 똑같은 스냅샷은 만들지 않는다

**Files:**

- Modify: `src-tauri/src/workspace/mod.rs` (`Workspace` 생성자의 `changed`)
- Modify: `src-tauri/src/backup/snapshot.rs` (`take`)
- Modify: `src-tauri/src/app/mod.rs` (`backup_tick`, 새 `request_backup`·`set_backup_waker`)
- Modify: `src-tauri/src/app/windows.rs` (`show`)
- Modify: `src-tauri/src/lib.rs` (`start_backups`)
- Modify: `docs/superpowers/specs/2026-10-07-tote-note-core-design.md` 「백업」 절
- Test: `snapshot.rs`·`app/mod.rs`·`workspace/mod.rs` 의 `mod tests`

**Interfaces:**

- Produces:
  - `AppCore::backup_tick(&self, now: SnapshotName, only: Option<&HashSet<String>>) -> Vec<(String, io::Result<Option<PathBuf>>)>` — `only` 가 있으면 그 라벨의 창만 본다.
  - `AppCore::set_backup_waker(&self, waker: std::sync::mpsc::Sender<String>)`, `AppCore::request_backup(&self, label: &str)` — 깨움이 없으면 아무것도 하지 않는다.
  - `AppCore::window_labels(&self) -> HashSet<String>` (Task 2 가 쓴다).
  - `snapshot::take` 는 직전 스냅샷과 같으면 `Taken { folder: None, deferred: 0 }`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`snapshot.rs`:

- `a_snapshot_identical_to_the_previous_one_makes_no_folder` — 파일 둘로 찍고, 아무것도 바꾸지 않고 다음 이름으로 다시 찍으면 `folder == None`, `deferred == 0`, `dir.snapshots()` 는 하나, `.tmp-*` 가 남지 않는다.
- `a_removed_file_makes_a_new_snapshot` — 파일 하나를 지우고 찍으면 `folder` 가 `Some` 이다(목록이 달라졌다).
- `index_json_alone_changing_makes_a_new_snapshot` — 메모는 그대로 두고 `.tote/index.json` 만 바꾸면 `Some`.

`workspace/mod.rs`:

- `an_opened_workspace_starts_changed` — `Workspace::open` 직후 `take_changed()` 는 `true`, 두 번째는 `false`. 기존의 `changed` 초깃값을 단정하는 테스트는 이 규칙으로 고친다.

`app/mod.rs`:

- `a_tick_snapshots_only_changed_workspaces_and_prunes` 를 고친다 — 두 워크스페이스를 연 직후의 첫 틱은 **둘 다** 찍는다. 그 뒤 `가` 만 `mark_changed` 하고 바꾼 다음 틱은 `가` 만 찍는다.
- `a_wake_snapshots_only_the_woken_workspace` — 둘을 열고 첫 틱을 돈 뒤, 둘 다 `mark_changed` 하고 파일을 바꾼다. `backup_tick(now, Some(&{label_가}))` 는 `가` 의 결과 하나만 돌려주고, `나` 는 여전히 바뀐 것으로 남는다(다음 `only: None` 틱이 `나` 를 찍는다).
- `request_backup_without_a_waker_does_nothing` — 깨움을 걸지 않고 불러도 패닉하지 않는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml snapshot workspace app::tests`
Expected: 새 테스트가 FAIL(`folder` 가 `Some`, `take_changed` 가 `false`, `backup_tick` 인자 개수).

- [ ] **Step 3: 구현한다**

- `Workspace` 생성자에서 `changed: true`. 주석: 닫기 전 마지막 간격 안의 변경이 어느 스냅샷에도 없을 수 있어, 열 때 한 번 찍어 그 상태를 남긴다.
- `snapshot::take`: 직전 스냅샷이 있고, 새 매니페스트의 파일 목록과 각 `sha256` 이 직전과 같고, `.tote/index.json` 도 같으면 `.tmp-<이름>` 을 지우고 `Taken { folder: None, deferred: 0 }`. 판정은 이미 만든 매니페스트로 한다(파일을 다시 읽지 않는다).
- `backup_tick` 에 `only` 를 더한다. `only` 에 없는 창은 `take_changed` 도 부르지 않는다(표시를 소비하지 않는다).
- `AppCore` 에 `backup_waker: Mutex<Option<Sender<String>>>`. `request_backup` 은 보내기 실패를 무시한다.
- `windows::show` 가 새 창을 등록한 뒤 `core.request_backup(&label)` 을 부른다(이미 열린 창에 포커스만 줄 때는 부르지 않는다).
- `start_backups`: 채널을 만들어 `set_backup_waker` 로 걸고, **첫 틱은 기다리지 않고 바로** 돈다(시작 복원으로 연 창은 깨움이 걸리기 전에 열렸으므로 이 틱이 찍는다). 그 뒤로는 다음 정기 틱의 마감 시각 `deadline` 을 들고 `recv_timeout(deadline - now)` 로 기다린다. 깨움이 오면 그때까지 쌓인 깨움을 모두 모아 `only: Some(…)` 로 돌고, 마감이 되면 `only: None` 으로 돌고 `deadline += interval`. 깨움은 `deadline` 을 바꾸지 않는다. 결과 처리(실패 알림)는 두 경우 모두 같은 코드를 지난다. 백업을 다른 스레드에서 돌리지 않는다 — 한 스레드가 모든 스냅샷을 차례로 찍어야 `remove_leftovers` 가 진행 중인 `.tmp-*` 를 지우지 않는다.
- `start_backups` 의 doc 주석에서 「the first one an interval after launch」를 지금 규칙으로 바꾼다.

- [ ] **Step 4: 스펙을 고친다**

「백업」 절 첫 항목을 지금 동작으로 바꾼다: 바뀐 것이 있을 때만 10분마다 찍고, **워크스페이스를 열 때(앱 시작의 복원 포함) 한 번 찍는다**, **직전 스냅샷과 파일 목록·내용이 모두 같으면 만들지 않는다.** 열 때 찍는 이유 한 줄(닫기 전 마지막 10분 안의 변경을 남긴다)을 붙인다.

- [ ] **Step 5: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, 실행 개수를 적는다.

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/workspace/mod.rs src-tauri/src/backup/snapshot.rs src-tauri/src/app/mod.rs src-tauri/src/app/windows.rs src-tauri/src/lib.rs docs/superpowers/specs/2026-10-07-tote-note-core-design.md
git commit -m "feat(backup): snapshot a workspace when it opens and skip identical snapshots"
```

---

### Task 2: 백업 실패를 창이 닫히면 잊고, 이어지면 하루마다 다시 알린다

**Files:**

- Create: `src-tauri/src/backup/notices.rs`
- Modify: `src-tauri/src/backup/mod.rs` (`pub mod notices;`)
- Modify: `src-tauri/src/lib.rs` (`start_backups` 의 `failing`)
- Modify: 스펙 「오류 처리」 절
- Test: `notices.rs` 의 `mod tests`

**Interfaces:**

- Consumes: `AppCore::window_labels()` (Task 1).
- Produces:

  ```rust
  pub const RENOTIFY: Duration = Duration::from_secs(24 * 60 * 60);
  pub struct FailureNotices { /* label -> last notified Instant */ }
  impl FailureNotices {
      pub fn new() -> Self;
      /// true when the person should be told about this failure now.
      pub fn failed(&mut self, label: &str, now: Instant) -> bool;
      pub fn succeeded(&mut self, label: &str);
      /// Forget windows that are no longer open.
      pub fn retain_open(&mut self, open: &HashSet<String>);
  }
  ```

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`notices.rs`)

- `the_first_failure_is_told` — `failed("a", t)` 는 `true`, 곧바로 `failed("a", t + 10분)` 은 `false`.
- `a_continuing_failure_is_told_again_after_a_day` — `failed("a", t)` 뒤 `failed("a", t + RENOTIFY)` 는 `true`, 그 직후 `false`.
- `a_success_resets_it` — `failed` → `succeeded` → `failed` 는 `true`.
- `a_reopened_window_is_told_again` — `failed("a", t)` 뒤 `retain_open(&{})`, 다시 `failed("a", t + 1분)` 은 `true`.
- `other_windows_are_kept` — `a`·`b` 가 실패한 뒤 `retain_open(&{"b"})` 이면 `b` 는 `t + 1분` 에 `false`.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notices`
Expected: FAIL(모듈 없음).

- [ ] **Step 3: 구현한다**

`FailureNotices` 는 `HashMap<String, Instant>`. `start_backups` 의 `HashSet` 을 이것으로 바꾼다. 틱마다 결과를 처리하기 전에 `notices.retain_open(&core.window_labels())`. `Ok(_)` 는 `succeeded`, `AlreadyExists` 는 지금처럼 무시, 나머지는 `eprintln!` 은 매번, `failed` 가 `true` 일 때만 `push_pending` + `tote://pending`. 문구는 그대로(`백업하지 못했습니다: {err}`).

- [ ] **Step 4: 스펙을 고친다**

「오류 처리」 절에 항목 하나: **백업 실패**는 상태 표시줄에 오류로 알린다. 창마다 처음 한 번, 실패가 이어지면 하루마다 다시 알리고, 창을 닫았다 다시 열면 다시 알린다. 백업 실패는 종료를 막지 않는다.

- [ ] **Step 5: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, 실행 개수를 적는다.

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/backup/notices.rs src-tauri/src/backup/mod.rs src-tauri/src/lib.rs docs/superpowers/specs/2026-10-07-tote-note-core-design.md
git commit -m "fix(backup): forget failure notices with the window and repeat them daily"
```

---

### Task 3: 이전 버전 목록이 같은 내용의 구간을 보인다

**Files:**

- Modify: `src-tauri/src/backup/versions.rs` (`Version`, `list`)
- Modify: `src/backend/types.ts` (`Version`)
- Modify: `src/backend/fake.ts` (`listVersions`)
- Modify: `src/ui/versions.ts` (`versionLabel`, `openVersions`)
- Create: `src/ui/versions.test.ts`
- Modify: `tests/e2e/backup.spec.ts`
- Modify: 스펙 「백업」 절의 「복원」 항목
- Test: `versions.rs` 의 `mod tests`, `src/ui/versions.test.ts`, `tests/e2e/backup.spec.ts`

**Interfaces:**

- Produces:
  - Rust `Version` 에 `until: String` — 이 내용이 마지막으로 찍힌 스냅샷 이름. 구간이 아니면 `snapshot` 과 같다. serde 이름 `until`.
  - TS `interface Version { snapshot: string; until: string; file: string; size: number; sha256: string }`.
  - `export function versionLabel(version: Pick<Version, "snapshot" | "until">): string`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Rust `versions.rs`: `versions_follow_a_renamed_memo_and_skip_unchanged_neighbours` 의 기대값에 `until` 을 더한다 — 10:00·10:10 이 같은 내용이면 그 항목은 `snapshot: "20261012-100000", until: "20261012-101000"`. 테스트 도우미 `version(...)` 은 `until` 인자를 받는다. 이웃과 다른 항목은 `until == snapshot`.

`src/ui/versions.test.ts`:

```ts
expect(versionLabel({ snapshot: "20261012-153000", until: "20261012-153000" })).toBe(
  "2026-10-12 15:30:00",
);
expect(versionLabel({ snapshot: "20261012-075000", until: "20261012-083000" })).toBe(
  "2026-10-12 07:50:00 – 08:30:00",
);
expect(versionLabel({ snapshot: "20261012-235000", until: "20261013-003000" })).toBe(
  "2026-10-12 23:50:00 – 2026-10-13 00:30:00",
);
expect(versionLabel({ snapshot: "weird", until: "weird" })).toBe("weird");
```

`tests/e2e/backup.spec.ts` 의 「previous versions list, preview and restore undoably」: 백업을 `v1`(10:00), `v2`(10:10), `v2`(10:20) 셋으로 바꾸고 목록이 `["2026-10-12 10:10:00 – 10:20:00", "2026-10-12 10:00:00"]` 인지 본다. 미리보기·되돌리기 단정은 그대로.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml versions && pnpm test src/ui/versions.test.ts && pnpm test:e2e tests/e2e/backup.spec.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

- `list` 는 최신부터 훑으면서 같은 `sha256` 이 이어지는 동안 구간의 **가장 최근** 스냅샷을 기억하고, 구간의 가장 오래된 항목에 `until` 로 싣는다(남는 항목은 지금과 같다).
- 가짜 백엔드 `listVersions` 도 같은 규칙으로 접는다(지금은 접지 않는다). 내용 비교는 `text` 로 한다.
- `versionLabel` 은 위 꼴. 구분자는 `" – "`(앞뒤 공백, en dash). 두 이름 중 하나라도 꼴이 아니면 `snapshot` 을 그대로 돌려준다.
- `openVersions` 의 행이 `versionLabel(version)` 을 쓴다.

- [ ] **Step 4: 스펙을 고친다**

「복원」 항목: 인접 스냅샷과 내용이 다른 시점만 보이고, **같은 내용이 이어진 구간은 처음과 끝 시각으로 보인다**.

- [ ] **Step 5: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/backup/versions.rs src/backend/types.ts src/backend/fake.ts src/ui/versions.ts src/ui/versions.test.ts tests/e2e/backup.spec.ts docs/superpowers/specs/2026-10-07-tote-note-core-design.md
git commit -m "feat(versions): show the time range of an unchanged run"
```

---

### Task 4: 검색은 텍스트 메모만 보고, `<!DOCTYPE html>` 을 대소문자 없이 알아본다

작은 수정 둘을 한 태스크로 묶는다.

**Files:**

- Modify: `src-tauri/src/search/mod.rs` (새 `text_candidates`)
- Modify: `src-tauri/src/app/commands.rs` (`search_workspace`)
- Modify: `src/core/language.ts` (`firstLinePattern`)
- Modify: `src/core/language.test.ts`
- Modify: 스펙 「워크스페이스 검색」 절, 「편집기」 절의 「자동 인식」 항목
- Test: `search/mod.rs` 의 `mod tests`, `src/core/language.test.ts`

**Interfaces:**

- Produces: `pub fn text_candidates(memos: impl IntoIterator<Item = MemoInfo>) -> Vec<(String, String)>` — `kind == FileKind::Text` 인 것만 `(id, file)` 로.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Rust `search/mod.rs`: `only_text_memos_are_candidates` — `a.md`(Text), `b.pdf`(Document), `c.png`(Image), `d`(확장자 없음, Text) 의 `MemoInfo` 를 넣으면 `[("a", "a.md"), ("d", "d")]`. `MemoInfo` 는 `workspace::memo` 의 생성 도우미나 구조체 리터럴로 만든다.

`src/core/language.test.ts` 의 「recognises a shebang through a language's firstLine pattern」 곁에:

```ts
it("recognises a doctype whatever its case", () => {
  expect(detectLanguage("<!DOCTYPE html>\n<p>", languages)?.id).toBe("html");
  expect(detectLanguage("<!doctype html>\n<p>", languages)?.id).toBe("html");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml only_text_memos && pnpm test src/core/language.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

- `search_workspace` 의 후보 목록을 `text_candidates(workspace.list_memos()?)` 로 바꾼다.
- `firstLinePattern` 이 `new RegExp(source, "i")` 로 컴파일한다. 주석: VS Code 의 `firstLine` 처럼 대소문자를 무시한다.

- [ ] **Step 4: 스펙을 고친다**

- 「워크스페이스 검색」: 대상은 워크스페이스 루트의 **텍스트 메모**(확장자로 미디어·문서가 아닌 것). 그중 바이너리와 5MB 를 넘는 파일은 건너뛴다.
- 「자동 인식」 항목: `firstLine` 패턴은 대소문자를 무시한다.

- [ ] **Step 5: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/search/mod.rs src-tauri/src/app/commands.rs src/core/language.ts src/core/language.test.ts docs/superpowers/specs/2026-10-07-tote-note-core-design.md
git commit -m "fix: search only text memos and match firstLine case-insensitively"
```

---

### Task 5: 충돌을 고르지 않고 끄면 새 메모의 탭에 남는 배너로 알린다

**Files:**

- Modify: `src/core/session.ts` (`TabPlace`, `parseTab`)
- Modify: `src/app/docs.ts` (`MemoDoc.flush`, 새 배너, `CONFLICT_KEPT_NOTICE` 걷기)
- Modify: `src/app/session-sync.ts` (`sessionTab`, `SessionSync.restore`)
- Modify: `src/app/controller.ts` (필요하면 flush 와 세션 쓰기 순서)
- Modify: `src/core/session.test.ts`, `src/app/session-sync.test.ts`, `src/app/docs.test.ts`
- Modify: 충돌 배너 e2e 가 있는 spec 파일(`tests/e2e/watch.spec.ts` 또는 `external.spec.ts`)
- Modify: 스펙 「외부 변경」 절
- Test: 위 파일들

**Interfaces:**

- Produces:
  - `TabPlace` 에 `conflictKept?: { memoId: string }` — 메모 탭에만 쓴다. `memoId` 는 다른 앱의 버전이 남은 원래 메모.
  - `export function conflictKeptText(original: string | null): string` (`docs.ts`).
  - `MemoDoc.conflictKept: { memoId: string } | null` — 배너가 떠 있는 동안 값이 있다.

문구(그대로 쓴다):

- 원래 메모를 찾으면: `내 버전은 이 메모로 따로 저장했습니다. 다른 앱이 바꾼 버전은 원래 메모 「${name}」에 있습니다.`
- 못 찾으면: `내 버전은 이 메모로 따로 저장했습니다. 다른 앱이 바꾼 버전은 원래 메모에 있습니다.`
- 버튼: `원래 메모 열기`(원래 메모가 목록에 있을 때만), `닫기`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

- `session.test.ts`: `parseSession` 이 메모 탭의 `conflictKept: { memoId: "m1" }` 을 읽고, `memoId` 가 문자열이 아니면 그 필드만 버린다(탭은 남는다). 외부 파일 탭의 `conflictKept` 는 버린다.
- `docs.test.ts` 의 충돌 flush 테스트: `doc.notice` 단정을 걷고 `doc.banner?.kind === "info"`, `doc.banner?.text === conflictKeptText("<원래 이름>")`, `doc.conflictKept?.memoId === <원래 ID>`. 「닫기」를 실행하면 `banner === null`, `conflictKept === null`.
- `session-sync.test.ts`:
  - `writes the conflict-kept banner with its tab` — `conflictKept` 가 있는 문서의 `sessionTab` 에 그 값이 실린다. 없으면 필드가 없다.
  - `brings back the conflict-kept banner` — 세션에 `conflictKept` 가 있는 탭을 되살리면 그 문서의 배너가 원래 이름을 담은 문구로 뜬다. 원래 메모가 목록에 없으면 이름 없는 문구, 버튼은 `닫기` 하나.
- e2e: `the conflict-kept banner survives a restart` — 충돌 배너가 뜬 상태에서 flush(`onFlush` 를 일으키는 기존 도우미)를 하면 `__tote.backend.data.session` 의 활성 탭에 `conflictKept` 가 있고, 그 세션으로 다시 `start` 하면 배너가 보인다. 「원래 메모 열기」가 원래 메모를 연다.
- e2e: `the conflict-kept banner ends with its tab` — 배너가 있는 탭을 닫고 메모 목록에서 다시 열면 배너가 없다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm test src/core/session.test.ts src/app/docs.test.ts src/app/session-sync.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

- `MemoDoc.flush` 의 충돌 처리에서 `recover` 전에 원래 메모 ID 를 잡아 두고, 성공하면 `notice` 대신 `conflictKept` 와 정보 배너를 세운다. `CONFLICT_KEPT_NOTICE` 와 그 import 를 걷는다.
- 배너 `닫기` 는 `conflictKept` 를 비우고 세션 저장을 예약한다. `원래 메모 열기` 는 메모를 여는 기존 호스트 경로를 쓰고, 배너는 남긴다.
- 탭을 닫으면 그 문서와 함께 끝난다(세션에서 빠진다). 같은 메모를 다시 열면 새 문서라 배너가 없다.
- 세션은 flush 가 끝난 **뒤에** 쓰여야 배너가 실린다. `flushAll` 안의 순서를 확인하고, 아니면 바꾼다. 이 순서를 고정하는 단정은 e2e 첫 테스트다.

- [ ] **Step 4: 스펙을 고친다**

「외부 변경」 절의 충돌 항목 아래: 충돌을 고르지 않은 채 창을 닫거나 앱을 끄면 다른 앱의 버전은 원래 메모에 두고 내 버전을 새 메모로 저장한다. 새 메모의 탭에 그 사실과 원래 메모 이름을 담은 배너를 띄우고, 사람이 닫을 때까지 다시 켜도 남긴다.

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 6: 커밋**

```bash
git add src/core/session.ts src/app/docs.ts src/app/session-sync.ts src/app/controller.ts src/core/session.test.ts src/app/session-sync.test.ts src/app/docs.test.ts tests/e2e/<바꾼 spec> docs/superpowers/specs/2026-10-07-tote-note-core-design.md
git commit -m "feat(conflict): keep a banner on the memo that took my version"
```

`controller.ts` 를 바꾸지 않았으면 그 경로를 빼고 stage 한다.

---

### Task 6: 창 닫기 질문 중의 종료 요청은 그 질문에 붙는다

**Files:**

- Modify: `src-tauri/src/app/flush.rs` (`Round`, `begin`, `cancel`)
- Modify: `src-tauri/src/app/mod.rs` (`cancel_flush`)
- Modify: `src-tauri/src/app/lifecycle.rs` (`resolve_blocked`)
- Test: `flush.rs`·`lifecycle.rs` 의 `mod tests`

**Interfaces:**

- Produces:
  - `Round` 에 `quit_waiting: bool`.
  - `FlushCoordinator::cancel(&mut self, id: u64) -> bool` — 지운 라운드에 종료가 붙어 있었으면 `true`.
  - `AppCore::cancel_flush(&self, id: u64) -> bool` 도 같은 값을 돌려준다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`flush.rs`)

- `a_quit_joins_an_asking_close` — `begin(CloseWindow("a"), ["a"])` → `Started{id}`. 기존 `a_blocked_ack_ends_the_round_as_blocked_with_its_reasons` 와 같은 방법(`ONE_FAILED` 를 실은 답)으로 그 라운드를 `Blocked`·`asking` 으로 만든 뒤 `begin(Quit, ["a","b"])` 는 `AlreadyRunning`. `cancel(id)` 는 `true`.
- `cancelling_an_asking_close_reports_the_waiting_quit` — 위에서 종료가 붙지 않았으면 `cancel(id)` 는 `false`.
- `quitting_during_a_close_round_finishes_both` 는 그대로 통과해야 한다 — 묻는 중이 **아닌** 닫기 라운드에는 종료가 자기 라운드를 연다.
- `a_blocked_round_ends_with_a_cancel` 는 그대로 통과해야 한다.

`lifecycle.rs` 의 `only_a_round_left_running_makes_macos_wait` 는 그대로 통과해야 한다(`AlreadyRunning` 은 `TerminateLater`).

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml flush`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

- `begin(Quit, …)` 은 `asking` 인 `CloseWindow` 라운드가 있으면 그 라운드(여럿이면 가장 먼저 연 것)에 `quit_waiting = true` 를 세우고 `AlreadyRunning`. 그 밖의 busy 판정은 지금과 같다.
- `resolve_blocked(app, id, goal, anyway)`: `let quit_waiting = core.cancel_flush(id);` 다음에
  - `anyway` 면 `finish(app, goal)`, 그리고 `goal` 이 닫기이고 `quit_waiting` 이면 `begin(app, FlushGoal::Quit)` 으로 종료를 이어서 시작한다. Dock 종료면 `WAITING` 이 아직 서 있으므로 그 종료 라운드의 끝(`finish`·`resolve_blocked`)이 macOS 에 답한다.
  - 취소면 `goal == Quit || quit_waiting` 일 때 `system_quit::answer(app, false)`(macOS 만). ⌘Q·메뉴 종료처럼 macOS 가 기다리지 않는 경우 `answer` 는 아무것도 하지 않는다.
- `flush.rs` 의 busy 판정 곁 주석에 Dock 종료의 답 의무를 한 줄로 적는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: PASS, 실행 개수를 적는다.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/app/flush.rs src-tauri/src/app/mod.rs src-tauri/src/app/lifecycle.rs
git commit -m "fix(quit): fold a quit into an asking close instead of a second dialog"
```

---

### Task 7: 에이전트 스모크와 보고서

**Files:**

- Create: `docs/superpowers/reports/2026-10-16-tote-notes-safety-net-followups-smoke.md`

화면이 필요 없는 항목은 `TOTE_BACKGROUND=1` 로, 대화상자를 보는 항목만 화면으로 한다. 모든 실행에 `TOTE_DATA_DIR=/tmp/tote-followups-smoke` 와 `TOTE_BACKUP_INTERVAL_SECS=600`(정기 틱이 끼어들지 않게)을 준다. 화면 항목 전에는 코디네이터에게 「사람이 키보드를 쓰지 않아야 한다」고 알린다. 편집기에 글을 넣을 때 `orca computer` 의 `type-text`·`paste-text` 는 두 번 들어가거나 클립보드를 한 번 더 붙이므로 `set-value` 로 넣고 확인한다.

- [ ] **Step 1: 디버그 빌드**

Run: `pnpm tauri build --debug`
Expected: `src-tauri/target/debug/bundle/macos/tote-dev.app`.

- [ ] **Step 2: 열 때 찍기 (화면 없이)**

메모 하나를 만들고 글을 넣은 뒤 1분 안에 앱을 끈다. `backups/<워크스페이스 ID>/` 의 스냅샷 수를 적는다. 다시 켜고 10초 안에 스냅샷이 하나 늘었는지, 그 스냅샷에 끄기 직전 글이 있는지 본다. 아무것도 바꾸지 않고 한 번 더 껐다 켜면 스냅샷 수가 그대로인지 본다.

- [ ] **Step 3: 종료 대화상자 겹침 (화면)**

워크스페이스 폴더를 읽기 전용으로 만들어(`chmod a-w`) 저장 실패를 일으키고 메모에 글을 넣는다. ⇧⌘W 로 「저장하지 못한 메모가 있습니다」 시트를 띄운 채:

- ⌘Q → 대화상자가 하나만인지, 「취소」 뒤 앱이 살아 있는지.
- 다시 시트를 띄우고 `osascript -e 'tell application "tote-dev" to quit'` → 하나만인지, 「취소」 뒤 앱이 살아 있고 `osascript` 가 돌아오는지(멈추지 않는지).
- 다시 띄우고 Dock 종료 → 「그래도 닫기」 뒤 앱이 끝나는지.
  끝나면 `chmod u+w` 로 되돌린다.

- [ ] **Step 4: 충돌 보관 배너 (화면)**

메모를 열고 글을 넣은 뒤 저장되기 전에 바깥에서 같은 파일을 바꿔 충돌 배너를 띄운다. 고르지 않고 ⌘Q. 다시 켜서 탭에 배너가 문구대로 있는지, 「원래 메모 열기」가 원래 메모를 여는지, 「닫기」 뒤 다시 켜면 배너가 없는지 본다.

- [ ] **Step 5: 정리와 검사**

앱을 끄고 `/tmp/tote-followups-smoke` 를 지운다. `~/Tote-dev`·`~/Library/Application Support/tote-dev` 가 없는지 확인한다.

- [ ] **Step 6: 보고서와 커밋**

보고서에 항목별 결과(합격·불합격·확인 못 함과 이유), 도구의 한계, 실행한 명령을 적는다. 불합격은 고치지 않고 적는다.

```bash
git add docs/superpowers/reports/2026-10-16-tote-notes-safety-net-followups-smoke.md
git commit -m "docs: report the safety-net follow-up smoke"
```
