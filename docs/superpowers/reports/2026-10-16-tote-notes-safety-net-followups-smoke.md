# tote-notes 안전망 후속 — 에이전트 스모크

HEAD `fbcc1a4`, 디버그 빌드 `tote-dev.app`, macOS. 화면 없이 확인할 수 있는 항목만 에이전트가 했고, 화면이 필요한 항목은 사람이 나중에 한 번에 한다.

## 결과 요약

| 항목                             | 결과                                                  |
| -------------------------------- | ----------------------------------------------------- |
| Step 1 디버그 빌드               | 합격                                                  |
| Step 2 열 때 찍기 (화면 없이)    | 합격                                                  |
| Step 3 종료 대화상자 겹침 (화면) | 확인 못 함 — 사람이 나중에 한 번에 화면 스모크로 확인 |
| Step 4 충돌 보관 배너 (화면)     | 확인 못 함 — 사람이 나중에 한 번에 화면 스모크로 확인 |
| Step 5 정리와 검사               | 합격                                                  |

## Step 1 — 빌드

- `pnpm tauri build --debug` 는 `tote.app` 을 만든다(`tote-dev.app` 이 아니다). `tote-dev.app` 은 `tauri.dev.conf.json` 의 `productName` 이라 `--config` 가 필요하다.
- 실제로 쓴 명령: `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json` → `src-tauri/target/debug/bundle/macos/tote-dev.app`. 브리프의 명령은 이 설정을 빠뜨렸다.
- 번들 안의 실행 파일 이름은 `tote` 이다(`Contents/MacOS/tote`).

## Step 2 — 열 때 찍기 (`TOTE_BACKGROUND=1`)

모든 실행에 `TOTE_DATA_DIR=/tmp/tote-followups-smoke`, `TOTE_BACKUP_INTERVAL_SECS=600`, `TOTE_BACKGROUND=1`.

| 순서 | 동작                                                                                 | 스냅샷 수              | 내용                                     |
| ---- | ------------------------------------------------------------------------------------ | ---------------------- | ---------------------------------------- |
| 1    | 첫 실행, `--tote-request={"stdinFile":…}` 로 글이 든 메모 생성 → `osascript` 로 종료 | 1 (`…002311`)          | 끄기 직전 글(`smoke-before-quit-…`) 있음 |
| 2    | 앱이 꺼진 사이 워크스페이스에 파일을 바꿔 둔 뒤 다시 켬                              | 2초 안에 2 (`…002359`) | 바꾼 글(`edited-while-off`) 있음         |
| 3    | 아무것도 바꾸지 않고 종료 → 켬                                                       | 2 그대로               | —                                        |
| 4    | 한 번 더 종료 → 켬                                                                   | 2 그대로               | —                                        |

- 다시 켜고 스냅샷이 늘기까지 **약 2초**(60초 한도 안, 실제 부하 속에서도).
- 합격: 바뀐 채로 열면 한 개 늘고 그 안에 바뀐 글이 있다. 안 바뀐 채로 열면 폴더가 늘지 않는다.

한계와 다른 점:

- 2번의 「바뀜」은 앱이 꺼진 사이 내가 파일에 한 줄을 붙인 것이다. 앱은 끌 때 메모 파일 이름을 첫 줄로 바꾸므로(`untitled.md` → `smoke-before-quit-….md`) 내가 붙인 `untitled.md` 는 새 파일이 되었다. 「열 때 워크스페이스가 직전 스냅샷과 달라졌다」는 점은 같지만 「같은 메모를 고쳤다」는 아니다.
- 편집기에 글을 넣는 경로(화면)는 쓰지 않았다. 메모 생성은 CLI 요청(`stdinFile`)으로 했다.
- 첫 스냅샷(1)은 메모를 만든 뒤에 찍혀서, 첫 실행에서 「열 때 찍기」와 「종료 때 찍기」를 구별해 보지 못했다.

## Step 3 — 종료 대화상자 겹침 (화면) — 확인 못 함

코디네이터 판정: 사람이 나중에 한 번에 화면 스모크로 한다. 절차(브리프 그대로):

1. 시험 폴더(`TOTE_DATA_DIR` 로 줄 임시 폴더)의 워크스페이스 폴더를 `chmod a-w` 로 읽기 전용으로 만들어 저장 실패를 일으키고, 메모에 글을 넣는다. 실행은 `open --env TOTE_DATA_DIR=<폴더> --env TOTE_BACKUP_INTERVAL_SECS=600 src-tauri/target/debug/bundle/macos/tote-dev.app` (`TOTE_BACKGROUND` 는 주지 않는다).
2. ⇧⌘W 로 「저장하지 못한 메모가 있습니다」 시트를 띄운 채 **⌘Q** → 기대: 대화상자가 **하나만**, 「취소」 뒤 앱이 살아 있다.
3. 시트를 다시 띄우고 `osascript -e 'tell application "tote-dev" to quit'` → 기대: 대화상자 **하나만**, 「취소」 뒤 앱이 살아 있고 `osascript` 가 **돌아온다**(멈추지 않는다).
4. 시트를 다시 띄우고 **Dock 종료** → 기대: 「그래도 닫기」 뒤 앱이 끝난다.
5. 끝나면 `chmod u+w` 로 되돌린다. `chmod` 는 시험 폴더에만.

이 절차에 아래 「사람 스모크에 보탤 것」의 Step 3 항목 1–4 를 함께 한다.

## Step 4 — 충돌 보관 배너 (화면) — 확인 못 함

코디네이터 판정: 사람이 나중에 한 번에 화면 스모크로 한다. 절차(브리프 그대로):

1. 메모를 열고 글을 넣은 뒤, 저장되기 전에 바깥에서 같은 파일을 바꿔 충돌 배너를 띄운다.
2. 고르지 않고 **⌘Q**.
3. 다시 켜서 기대: 탭에 배너가 문구대로 있다 — `내 버전은 이 메모로 따로 저장했습니다. 다른 앱이 바꾼 버전은 원래 메모 「<이름>」에 있습니다.`(이름을 모르면 `…원래 메모에 있습니다.`, `src/app/docs.ts` 의 `conflictKeptText`).
4. 「원래 메모 열기」 → 기대: 원래 메모가 열린다.
5. 「닫기」 후 앱을 껐다 켜기 → 기대: 배너가 없다.

이 절차에 아래 「사람 스모크에 보탤 것」의 Step 4 항목 1–3 을 함께 한다.

편집기에 글을 넣을 때 `orca computer` 의 `type-text`·`paste-text` 는 두 번 들어가거나 클립보드를 한 번 더 붙이므로 `set-value` 로 넣고 확인한다.

## 사람 스모크에 보탤 것

최종 리뷰가 Step 3·4 절차에 더해 보라고 한 것이다.

### Step 3 (종료 대화상자 겹침)에 보탤 것

1. **「그래도 닫기」 뒤에 두 번째 대화상자가 뜨지 않는지 본다**(N4 ①). 창이 둘일 때 잘 드러난다: 워크스페이스 A(읽기 전용, 저장 실패)와 B(정상)를 연다. A 에서 ⇧⌘W → 시트 → Dock 종료 → 「그래도 닫기」. 기대: A 가 닫히고, 대화상자 없이 앱이 끝난다.
2. 1번 뒤 앱을 다시 켜서 **A 가 다시 열리지 않는지** 본다(N4 ②). 사람이 A 를 먼저 닫았으므로 B 만 열리는 것이 맞다. A 가 열리면 N4 가 실제로 난 것이다.
3. **Dock 종료 → 「취소」** 도 한 번 한다(Step 3 의 3번은 `osascript` 로 같은 경로를 본다). 기대: 앱이 살아 있고, 그 뒤 Dock 종료를 다시 하면 평소대로 묻거나 끝난다(macOS 가 「대기 중」에 걸려 있지 않다).
4. 가능하면 로그아웃 한 번: 시트를 띄운 채 로그아웃 → 「취소」 → macOS 가 「tote-dev 때문에 로그아웃을 취소했습니다」류로 돌아오는지(멈추지 않는지).

### Step 4 (충돌 보관 배너)에 보탤 것

1. Step 4 의 5번(「닫기」 후 껐다 켜기) 외에 **탭을 닫고 메모 목록에서 그 메모(`<이름> 2`)를 다시 열면 배너가 없는지** 본다. e2e 는 fake 백엔드로만 고정한다.
2. **⌘Q 대신 창 닫기(⇧⌘W)** 로도 한 번 한다. 그 워크스페이스를 다시 열었을 때 배너가 있어야 한다(세션은 창을 닫을 때도 쓰인다).
3. 배너가 있는 메모에 글을 더 쳐서 **저장되는지**(info 배너가 저장을 막지 않는지) 본다.

## 다음 계획으로 넘기는 것

최종 리뷰(HEAD `914c461`, Critical·Important 0)가 병합은 가능하되 다음 계획에서 다루라고 한 Minor 다. 심볼은 이름으로 가리킨다.

**묶음 제안:** N1 과 T2-1 은 같은 자리(`start_backups`·`notices.rs` 의 시계)라 한 태스크로 묶는다. T6-3 을 첫 정리 태스크로 하고, 로그아웃이 멈추지 않는다는 보증을 단위 테스트로 옮긴다(지금은 코드 읽기와 사람 스모크뿐이다).

| 항목              | 어디                                                                                      | 무엇이 문제인가                                                                                                                                                                                                                                                                                                                     | 고치는 법                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1                | `src-tauri/src/backup/notices.rs` `FailureNotices::failed`, `lib.rs` `start_backups`      | 「하루마다 다시 알린다」(`RENOTIFY`)를 `Instant` 로 잰다. macOS 에서 `Instant` 는 잠자기 동안 멈추는 시계(`CLOCK_UPTIME_RAW`)라고 알고 있다(rust-src 가 없어 소스로 확인하지 못했다). 밤마다 덮는 노트북이면 다시 알림이 약 3일마다 온다.                                                                                           | `told` 를 `SystemTime` 으로 잰다(시계가 뒤로 가면 `duration_since` 오류 → 알리는 쪽). 또는 스펙 「오류 처리」 문장을 「깨어 있는 시간으로 하루」로 고친다. |
| T2-1              | `lib.rs` `start_backups`                                                                  | `max(deadline + interval, now)` 가 따라잡기 뒤 라운드를 한 번 더 바로 돌린다(바뀐 게 없으면 `take_changed` 에서 끝나 해는 작다). 주석 「a machine that slept leaves the mark in the past」은 macOS 에서 일어나지 않는다(N1).                                                                                                        | `Instant::now() + interval` 로 바꾸고 주석을 N1 과 함께 고친다.                                                                                            |
| T3-1              | `src-tauri/src/backup/versions.rs`                                                        | 길이 3 이상 구간과 A,B,A(되돌림) 테스트가 없다.                                                                                                                                                                                                                                                                                     | `versions.rs` 를 다시 만질 때 테스트 하나를 더한다.                                                                                                        |
| T5-1              | 충돌 보관 배너(`src/app/` 의 `conflictKept` 처리, `controller.ts`)                        | 같은 탭에 다른 배너(새 충돌·삭제)가 오르면 `conflictKept` 가 영구히 사라진다. 스펙 「사람이 닫을 때까지」와 어긋난다. 새 메모가 또 바깥에서 바뀌거나 지워져야 난다.                                                                                                                                                                 | 고치거나, 스펙에 「그 탭에 다른 배너가 오르면 끝난다」를 더한다.                                                                                           |
| T6-1              | `src-tauri/src/app/flush.rs` 테스트 `cancelling_an_asking_close_reports_the_waiting_quit` | 이름과 단언이 어긋난다. 「참」 쪽은 `a_quit_joins_an_asking_close` 가 단언한다. 계획 Review Focus 3 이 이 이름을 들고 있다.                                                                                                                                                                                                         | T6-3 과 함께 이름을 바꾸거나 단언을 옮긴다.                                                                                                                |
| T6-2              | `flush.rs` 테스트                                                                         | 「먼저 연 닫기가 종료를 흡수한다」 테스트가 없다.                                                                                                                                                                                                                                                                                   | 테스트 하나를 더한다.                                                                                                                                      |
| T6-3              | `src-tauri/src/app/lifecycle.rs` `resolve_blocked`                                        | 결정이 `AppHandle` 부작용과 섞여 단위 테스트가 lifecycle 쪽(「취소 → `answer(false)`」 등)을 고정하지 못한다. Review Focus 3 이 사람 스모크에 기대고 있다.                                                                                                                                                                          | 결정을 순수 함수로 뺀다. 최종 리뷰의 「Dock 종료·로그아웃 답 추적」 표(시작 → 끝나는 경로 → 답)가 그대로 테스트 표가 된다.                                 |
| N3                | `flush.rs` `FlushCoordinator::begin`                                                      | 흡수 조건이 `round.asking` 이라, 닫기가 아직 묻기 전(쓰는 중, 최대 `FLUSH_TIMEOUT` 3초)에 온 ⌘Q·Dock 종료는 Quit 라운드를 따로 시작한다. 같은 창의 저장이 실패하면 닫기 시트와 종료 대화상자가 둘 다 뜬다. 두 답은 모순되지 않고 macOS 는 Quit 라운드가 답한다.                                                                     | 같은 흡수를 「쓰는 중인 닫기」에도 넓힐지 판단한다.                                                                                                        |
| N4                | `lifecycle.rs` `resolve_blocked`                                                          | 「그래도 닫기」 직후 시작한 Quit 라운드가, 아직 `AppCore` 에서 빠지지 않은 닫히는 창을 포함할 수 있다. 그 창이 flush 를 받으면 ① 「그래도 종료」 대화상자가 한 번 더 뜨고 ② Quit 이 그 창의 `Destroyed` 보다 먼저 끝나면 다음 실행에 다시 열 창으로 적힌다. macOS 는 어느 쪽이든 답을 받는다. 이벤트 순서를 코드로 확정하지 못했다. | **사람 스모크로 확인한다**(위 Step 3 항목 1·2). 관찰되면 다음 계획에서 고친다.                                                                             |
| N5                | `tests/e2e/watch.spec.ts` 「a deleted memo keeps its text and 다시 저장 brings it back」  | 부하가 높으면 `.memo-row` 가 5초 안에 사라지지 않는다(`toHaveCount(0)` 가 `Received: 1`). `--repeat-each=20` 으로 BASE `1a460ae` 에서 2/20, HEAD 에서 4/20 실패해 이 브랜치와 무관하다.                                                                                                                                             | 원인을 조사하거나, 부하 때문에 흔들리는 테스트 목록(perf-fixtures 시간 초과, `memo.spec.ts` guard)에 더한다.                                               |
| 부하 flake (기존) | perf-fixtures 시간 초과, `tests/e2e/memo.spec.ts` guard                                   | 부하 때문에 흔들리는 기존 flake 두 개. BASE 에서도 재현된다. 최종 리뷰 실행에서는 둘 다 나지 않았다.                                                                                                                                                                                                                                | 다음 계획에서 원인을 조사하거나 목록으로 관리한다.                                                                                                         |

## Step 5 — 정리와 검사

- 앱 프로세스 없음(`pgrep -f tote-dev.app` → 없음). `/tmp/tote-followups-smoke` 삭제함.
- `~/Tote-dev`, `~/Library/Application Support/tote-dev` 없음.
- `chmod` 를 쓰지 않았으므로 되돌릴 것 없음.

## 도구의 한계

- 이 스모크는 `TOTE_BACKGROUND=1` 이라 화면에 올라오지 않는 창만 다뤘다. 대화상자·배너는 볼 수 없다.
- 「10초 안에」는 60초까지 기다리기로 했으나 실제로 2초였다. 컴퓨터 부하는 매우 높았다(load 80–120).

## 실행한 명령

```bash
pnpm tauri build --debug                                               # tote.app (tote-dev 아님)
pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json        # tote-dev.app
# 래퍼: TOTE_DATA_DIR=/tmp/tote-followups-smoke TOTE_BACKGROUND=1 TOTE_BACKUP_INTERVAL_SECS=600 exec <번들>/Contents/MacOS/tote "$@"
run.sh '--tote-request={"stdinFile":"/tmp/tote-followups-smoke/inbox/in1.txt"}'
osascript -e 'tell application "tote-dev" to quit'
```

## 브리프와 다르게 한 것

- Step 1: `--config src-tauri/tauri.dev.conf.json` 추가(위).
- Step 2: 메모 생성·편집을 화면 대신 CLI 요청과 파일 편집으로 했다.
- Step 3·4: 코디네이터 판정으로 생략.

브리프 Step 1 의 명령은 사람이 따라 할 때도 `--config src-tauri/tauri.dev.conf.json` 이 없으면 `tote.app` 이 나온다. 계획 문서의 Task 7 Step 1 에 그 옵션을 넣어야 한다.
