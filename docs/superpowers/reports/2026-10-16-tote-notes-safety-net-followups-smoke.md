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

## Step 4 — 충돌 보관 배너 (화면) — 확인 못 함

코디네이터 판정: 사람이 나중에 한 번에 화면 스모크로 한다. 절차(브리프 그대로):

1. 메모를 열고 글을 넣은 뒤, 저장되기 전에 바깥에서 같은 파일을 바꿔 충돌 배너를 띄운다.
2. 고르지 않고 **⌘Q**.
3. 다시 켜서 기대: 탭에 배너가 문구대로 있다 — `내 버전은 이 메모로 따로 저장했습니다. 다른 앱이 바꾼 버전은 원래 메모 「<이름>」에 있습니다.`(이름을 모르면 `…원래 메모에 있습니다.`, `src/app/docs.ts` 의 `conflictKeptText`).
4. 「원래 메모 열기」 → 기대: 원래 메모가 열린다.
5. 「닫기」 후 앱을 껐다 켜기 → 기대: 배너가 없다.

편집기에 글을 넣을 때 `orca computer` 의 `type-text`·`paste-text` 는 두 번 들어가거나 클립보드를 한 번 더 붙이므로 `set-value` 로 넣고 확인한다.

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
