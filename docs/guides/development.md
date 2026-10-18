# 개발 메모 — 테스트, 훅, 툴체인

## E2E 전에 WebKit 을 설치한다

`pnpm test:e2e` 전에 `pnpm exec playwright install webkit` 을 한 번 돌린다(약 300MB, `~/Library/Caches/ms-playwright`).

- **Why:** 설치가 없으면 브라우저를 찾지 못해 테스트가 시작도 못 한다. 캐시는 사용자 단위라 워크트리마다 다시 받지 않는다.
- E2E 의 Vite 서버 포트는 `TOTE_E2E_PORT` 다(기본 1430, `strictPort`). 포트가 잡혀 있으면 다른 서버에 붙지 않고 실패한다. 워크트리를 여럿 동시에 돌리면 워크트리마다 다른 값을 준다.

## 디버그 앱은 언제나 `TOTE_DATA_DIR` 을 주고 띄운다

에이전트든 사람이든 디버그 번들(`tote-dev.app`)을 띄울 때는 `open --env TOTE_DATA_DIR=<임시 폴더> <번들 경로>` 로 연다. 띄우기 전에 번들 경로가 맞는지 확인하고, 끝나면 `~/Tote-dev` 와 `~/Library/Application Support/tote-dev` 가 새로 생기지 않았는지 본다.

디버그 번들은 `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json` 으로 만든다. 결과는 `src-tauri/target/debug/bundle/macos/tote-dev.app` 이고 번들 안 실행 파일은 `Contents/MacOS/tote` 다. `--config` 를 빼면 배포 앱과 identifier 가 같은 `tote.app` 이 나와 `tell application "tote-dev"` 같은 절차가 맞지 않는다.

- **Why:** 이 변수가 없으면 디버그 앱은 개발용 기본 폴더 두 곳에 쓴다. Dock·Finder 로 열거나 실행 파일 이름을 잘못 적어도 똑같이 빠진다. 두 계획 연속으로 이렇게 폴더가 생겼고, 규칙이 각 계획에만 있어서 다음 계획의 워커가 보지 못했다.
- 생겼으면 안을 확인해 사람에게 알리고, 동의를 받아 지운다.
- `TOTE_BACKGROUND=1` 로 띄운 창은 포커스만 안 가져가는 것이 아니라 **화면에 올라오지 않는다.** 접근성 트리·computer-use·스크린샷으로 보는 확인에는 쓸 수 없으니, 그런 확인은 사람에게 알린 뒤 이 변수 없이 띄운다.
- 번들 안의 `tote` CLI(`TOTE_CLI=1`)는 `open -n` 으로 요청을 넘겨서, 셸의 환경 변수가 새 프로세스에 **가지 않는다.** 실행 중인 디버그 앱에 요청을 보내려면 CLI 대신 번들 실행 파일에 같은 `TOTE_DATA_DIR` 을 주고 `--tote-request=<json>` 을 직접 넘긴다(`stdinFile` 은 `$TOTE_DATA_DIR/inbox/` 안의 파일이어야 한다).

## NFD 를 뜻하는 한글 리터럴은 `.normalize("NFD")` 로 쓴다

Finder 이름처럼 분해형(NFD)이어야 하는 테스트 입력은 `"한글 메모.md".normalize("NFD")` 로 쓴다.

- **Why:** NFD 한글을 소스에 그대로 적으면 복사·붙여넣기·편집기를 거치며 조용히 NFC 로 바뀌고, 테스트는 오류 없이 NFC 를 검사해 구분력을 잃는다.

## pre-push 는 느리다

pre-push 는 rustfmt, `cargo clippy --all-targets`, `tsc` 를 돈다. 문서만 고친 브랜치도 마찬가지다.

- **Why:** 워크트리마다 `src-tauri/target` 이 따로라서, 워크트리의 첫 push 는 처음부터 빌드해 몇 분 걸린다. 멈춘 것이 아니다.

## `mise.toml` 의 rust `components` 를 바꾸면 따로 설치한다

바꾼 뒤에는 이미 설치된 툴체인에 `rustup component add <컴포넌트> --toolchain <버전>` 을 따로 돌린다.

- **Why:** `mise install` 은 이미 설치된 버전을 건너뛰어 새 컴포넌트를 더하지 않는다. 그러면 pre-push 가 clippy 를 찾지 못해 실패한다.

## 부하에서만 실패하는 테스트는 시간 대신 완료 신호를 기다리게 고친다

부하가 높을 때만 실패하는 테스트는 먼저 「무엇이 끝났다는 신호를 기다리는가」 를 본다. 고정된 지연·타이머·기본 시간 제한에 기대고 있으면 그 지연이 무엇을 대신하는지 찾아 그 신호를 기다리게 바꾼다. 앱 쪽의 늦은 응답이 상태를 덮어쓰는 결함일 수도 있으니 테스트만 고치고 끝내지 않는다.

- **Why:** 부하는 IPC·개발 서버 응답·디스크를 모두 느리게 하므로 「보통은 먼저 끝난다」 는 가정이 깨진다. 지연을 늘리면 실패율만 줄고, 늦은 응답이 상태를 덮어쓰는 앱 결함은 가려진다.
- **How to apply:**
  - 재현: `uptime` 을 적고 `TOTE_E2E_PORT=<워크트리 전용 포트> pnpm exec playwright test <파일> -g "<제목>" --repeat-each=20` 을 돈다. vitest 는 `--repeat-each` 가 없으니 `pnpm exec vitest run <파일>` 을 20번 돌린다. 부하는 결과마다 함께 적는다. 부하 15~28 에서 20번에 1~2번 나던 실패가 부하 10 에서는 0번일 수 있다.
  - 원인을 찾을 때는 바뀌는 상태에 계측을 건다. 메모 목록이면 `window.__tote.app.memoList` 의 `upsert`·`setMemos`·`remove` 를 감싸 시각과 스택을 남기면 누가 늦게 무엇을 넣는지 보인다.
  - 가짜 백엔드의 「불러오는 중」 은 타이머(`setTimeout`) 대신 테스트가 풀어 줄 때까지 붙잡아 만든다(`tests/e2e/memo.spec.ts` 의 `holdReads`). 타이머는 혼자 끝나서, 느린 실행에서는 그 상태가 이미 지나간 뒤에 키가 들어간다.
  - 개발 서버에서 받는 것(`readExtensionFile` 이 받는 언어 설정 등)은 부하에서 늦게 도착한다. 늦은 응답의 효과를 시험하려면 `page.route` 로 그 요청을 붙잡았다가 풀어 준다.
  - 기다리는 것이 없는 동기 테스트의 시간 초과는 디스크·CPU 처리량을 잰다. 검사하는 것이 속도가 아니면 그 테스트에만 시간 제한을 준다(`scripts/perf-fixtures.test.ts` 의 1만 메모 테스트).
