# 개발 메모 — 테스트, 훅, 툴체인

## E2E 전에 WebKit 을 설치한다

`pnpm test:e2e` 전에 `pnpm exec playwright install webkit` 을 한 번 돌린다(약 300MB, `~/Library/Caches/ms-playwright`).

- **Why:** 설치가 없으면 브라우저를 찾지 못해 테스트가 시작도 못 한다. 캐시는 사용자 단위라 워크트리마다 다시 받지 않는다.
- E2E 의 Vite 서버 포트는 `TOTE_E2E_PORT` 다(기본 1430, `strictPort`). 포트가 잡혀 있으면 다른 서버에 붙지 않고 실패한다. 워크트리를 여럿 동시에 돌리면 워크트리마다 다른 값을 준다.
- 전체 `pnpm test:e2e` 를 여러 worker 로 돌리면 `[WebServer] … [Unhandled error] Error: Script error.` 줄이 섞일 수 있다. base 에서도 나오는, 시험 결과와 무관한 알려진 잡음이다(단독 파일 실행에서는 나오지 않는다). 시험이 통과했는데 이 줄만 있으면 실패로 보지 않는다. `Cross-origin script load denied …` 줄은 base 에서 재현되지 않았다. 이 줄이 새로 보이면 변경을 의심한다.

## 디버그 앱은 언제나 `TOTE_DATA_DIR` 을 주고 띄운다

에이전트든 사람이든 디버그 번들(`tote-dev.app`)을 띄울 때는 `open --env TOTE_DATA_DIR=<임시 폴더> <번들 경로>` 로 연다. 띄우기 전에 번들 경로가 맞는지 확인하고, 끝나면 `~/Tote-dev` 와 `~/Library/Application Support/tote-dev` 가 새로 생기지 않았는지 본다. 띄우기 전에 두 폴더가 이미 있으면(사람이 `pnpm app:dev` 로 띄운 개발 앱의 것일 수 있다) 지우지 말고, 띄우기 직전에 기준 파일(`touch "$S/start-marker"`)을 만들어 끝난 뒤 `find ~/Tote-dev "$HOME/Library/Application Support/tote-dev" -newer "$S/start-marker"` 가 비어 있는지로 판정한다.

디버그 번들은 `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json` 으로 만든다. 결과는 `src-tauri/target/debug/bundle/macos/tote-dev.app` 이고 번들 안 실행 파일은 `Contents/MacOS/tote` 다. `--config` 를 빼면 배포 앱과 identifier 가 같은 `tote.app` 이 나와 `tell application "tote-dev"` 같은 절차가 맞지 않는다.

- **Why:** 이 변수가 없으면 디버그 앱은 개발용 기본 폴더 두 곳에 쓴다. Dock·Finder 로 열거나 실행 파일 이름을 잘못 적어도 똑같이 빠진다. 두 계획 연속으로 이렇게 폴더가 생겼고, 규칙이 각 계획에만 있어서 다음 계획의 워커가 보지 못했다.
- 생겼으면 안을 확인해 사람에게 알리고, 동의를 받아 지운다.
- `TOTE_BACKGROUND=1` 로 띄운 창은 포커스만 안 가져가는 것이 아니라 **화면에 올라오지 않는다.** 접근성 트리·computer-use·스크린샷으로 보는 확인에는 쓸 수 없으니, 그런 확인은 사람에게 알린 뒤 이 변수 없이 띄운다.
- 번들 안의 `tote` CLI(`TOTE_CLI=1`)는 `open -n` 으로 요청을 넘겨서, 셸의 환경 변수가 새 프로세스에 **가지 않는다.** 실행 중인 디버그 앱에 요청을 보내려면 CLI 대신 번들 실행 파일에 같은 `TOTE_DATA_DIR` 을 주고 `--tote-request=<json>` 을 직접 넘긴다(`stdinFile` 은 `$TOTE_DATA_DIR/inbox/` 안의 파일이어야 한다).
- `orca computer` 의 `--restore-window` 는 앱이 끝나 있으면 LaunchServices 로 다시 띄워 이 변수가 빠진다. 앱을 끝낼 수 있는 동작(「그래도 닫기」·「그래도 바꾸기」·종료 질문의 버튼)에는 `--restore-window` 를 주지 않는다.
- 종료 질문 `저장하지 못한 메모가 있습니다`(Dock·⌘Q·AppleScript 종료)는 tote 가 아니라 `UserNotificationCenter` 프로세스의 창이다. 접근성 트리·`orca computer` 창 목록에 없으니 `tell application "System Events" to tell process "UserNotificationCenter" to click button "취소" of window 1` 로 누른다.
- CLI 로 파일을 메모로 가져오는 옵션은 `--import` 다(`-i` 는 없다).
- 화면 확인 중 대화상자가 아무도 누르지 않았는데 답해지면 먼저 사람·다른 도구의 클릭을 의심한다. NSAlert 시트 버튼은 tote 가 맨 앞이 아니어도 첫 클릭에 눌린다. 누가 눌렀는지는 `DYLD_INSERT_LIBRARIES` 로 `-[NSApplication sendEvent:]` 를 감싸 이벤트의 `kCGEventSourceUnixProcessID` 를 보면 갈린다(0 이면 실제 HID 입력, 합성 이벤트는 보낸 프로세스 pid). 이때 번들 실행 파일을 `nohup` 으로 띄우지 않는다 — SIP 보호 바이너리를 거치면 `DYLD_*` 가 지워진다.
- `orca computer set-value` 로 편집기에 글을 넣기 전에 편집기를 `click --element-index` 로 포커스한다. 포커스가 검색 입력 같은 다른 입력에 있으면 `ok` 를 돌려주면서 값이 그 입력으로 가거나 아무 데도 들어가지 않는다. 넣은 뒤 트리에서 편집기 값을 읽어 확인한다.
- 접근성(System Events·`orca computer`)으로는 창을 메뉴 막대 밑(y < 메뉴 막대 높이)에 둘 수 없다. 그런 저장 자리가 필요하면 앱을 끈 뒤 워크스페이스 `.tote/sessions/<id>.json` 의 `windows[].frame` 을 고치고 다시 켠다.
- 화면 확인을 시작하기 전에 `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` 로 화면이 잠겨 있지 않은지 본다. 잠겨 있으면 앱은 떠도 접근성 창 목록이 비고 `orca computer` 가 `permission_denied` 를 낸다. 잠금은 에이전트가 풀지 않는다 — 그 확인을 사람 확인 표로 넘긴다.

## zsh 에서 파일 목록은 배열로 넘긴다

`oxfmt`·`oxlint` 에 파일 여러 개를 넘길 때는 `FILES=(a b c)` 로 담아 `"${FILES[@]}"` 로 넘긴다.

- **Why:** zsh 는 따옴표 없는 `$VAR` 를 공백으로 쪼개지 않는다. 문자열 하나로 담으면 엉뚱한 경로 하나가 넘어가고, oxfmt 는 「1 files」, oxlint 는 「No files found」 라고 하면서 둘 다 exit 0 으로 끝난다. 실패가 없어서 포맷·린트가 돈 것으로 읽힌다.
- **How to apply:** 출력의 파일 개수가 넘긴 개수와 같은지 본다.

## NFD 를 뜻하는 한글 리터럴은 `.normalize("NFD")` 로 쓴다

Finder 이름처럼 분해형(NFD)이어야 하는 테스트 입력은 `"한글 메모.md".normalize("NFD")` 로 쓴다.

- **Why:** NFD 한글을 소스에 그대로 적으면 복사·붙여넣기·편집기를 거치며 조용히 NFC 로 바뀌고, 테스트는 오류 없이 NFC 를 검사해 구분력을 잃는다.

## 일부만 stage 한 채 커밋하면 pre-commit 훅이 실패할 수 있다

stage 하지 않은 변경이 작업 트리에 남아 있으면 lefthook 의 pre-commit 이 그 변경을 따로 저장하려고 `git diff … --output <파일> --` 를 부른다. Apple Git 2.54 는 이 꼴(`--output` 뒤 띄어 쓴 경로와 `--`)을 `--no-index` 비교로 읽어 `Not a git repository` 로 끝나고, 훅이 `failed to create a diff for all files` 로 커밋을 막는다.

- **How to apply:** 커밋할 때 작업 트리를 index 와 같게 만든다. 남길 변경은 임시 폴더에 복사해 두고 `git restore --worktree -- <파일>` 로 되돌린 뒤 커밋하고, 복사본을 다시 놓는다. 커밋한 트리가 복사본과 같은지 `git show HEAD:<파일> | cmp - <복사본>` 으로 확인한다. 훅을 건너뛰지 않는다.
- 이 git 인지는 `git diff --output /tmp/x.patch --; echo $?` 가 129 인지로 본다.

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
  - e2e 가 실패하면 다시 돌리기 전에 그 실행의 `test-results/` 를 다른 이름으로 옮기거나, 다시 돌릴 때 `--output <다른 폴더>` 를 준다. 다음 실행이 `test-results/` 를 지우고 새로 쓰므로 처음 실패한 메시지와 trace 가 남지 않는다. 보고에는 실패 메시지 첫 줄을 함께 적는다.
  - 원인을 찾을 때는 바뀌는 상태에 계측을 건다. 메모 목록이면 `window.__tote.app.memoList` 의 `upsert`·`setMemos`·`remove` 를 감싸 시각과 스택을 남기면 누가 늦게 무엇을 넣는지 보인다. 이 계측은 그 창의 메모 목록 하나만 본다. 다른 창이나 다른 상태(탭·배너)가 늦게 바뀌는 것은 그 객체를 따로 감싸야 보인다.
  - 편집기 상태가 늦게 되돌아가면 `EditorView` 의 갱신을 감싸 본다. 편집기의 레이아웃을 읽는 호출(`lineBlockAtHeight`·`coordsAtPos` 등)은 밀린 measure 를 그 자리에서 돌리고, 그 measure 의 갱신은 update listener 로 탭(`Doc.update`)에 간다. 그래서 탭이 state 를 바꾼 뒤(다시 읽기) 레이아웃을 읽으면 옛 state 의 갱신이 새 state 를 덮을 수 있다. `AppController.onUpdate` 는 탭이 지금 들고 있는 state 에서 시작하지 않은 갱신을 버린다.
  - 시간 자체를 다루는 시험(타이머로 미룬 갱신, 이어 세기)은 `waitForTimeout` 대신 `page.clock` 을 쓴다. `page.clock.install({ time })` 을 로드 전에 부르고, `pauseAt` 으로 시계를 세운 뒤 `runFor(n)` 으로 옮긴다. 150ms 로 미룬 갱신이면 `runFor(149)` 에서 옛 값, `runFor(1)` 에서 새 값을 단언한다. 시계를 세워 두면 저장 타이머(`SESSION_DELAY_MS` 등)도 돌지 않으므로 「즉시 쓰기」 와 「타이머 쓰기」 를 가를 수 있다. `performance.now` 를 읽는 예산(검색 개수의 30ms)은 페이지 안에서 `performance.now` 를 감싸 「볼 때마다 n ms」 로 만든다(`search-bar.spec.ts` 의 `slowLooks`).
  - 「일어나지 않음」 은 지연으로 증명하지 않는다. 가짜 백엔드의 쓰기 기록(`FakeData.memoWrites`·`layoutWrites`: 메모 id·창 라벨별로 성공한 쓰기 횟수)과 창의 `WriteScheduler.pending()`(대기·실행 중인 쓰기 키 수)을 쓴다. 대기 쓰기가 0 이 될 때까지 poll(`writesSettled`, `tests/e2e/helpers.ts`)한 뒤 `memoWrites` 가 늘지 않았음을 단언한다. 대기 중인 쓰기가 아직 예약 전이면 첫 poll 이 0 을 볼 수 있으므로 쓰기를 일으킨 쪽의 횟수(`layoutWrites` 등)가 늘 때까지 먼저 기다린다. `pending()` 은 세션 쓰기도 세어 판정이 늦어질 뿐 틀리지는 않는다.
  - 다른 앱의 변경을 흉내 내는 시험(충돌 배너 등)은 입력·다른 앱의 쓰기·변경 알림을 한 `page.evaluate` 안에서 동기로 한다(`typeWhileChangedElsewhere`, `tests/e2e/helpers.ts`). 단계 사이에 저장 타이머(500ms)가 끝나면 저장이 다른 앱의 내용을 덮어써 충돌이 사라지거나 엉뚱한 쪽이 「디스크 버전」 이 된다.
  - 가짜 백엔드의 「불러오는 중」 은 타이머(`setTimeout`) 대신 테스트가 풀어 줄 때까지 붙잡아 만든다(`tests/e2e/memo.spec.ts` 의 `holdReads`). 타이머는 혼자 끝나서, 느린 실행에서는 그 상태가 이미 지나간 뒤에 키가 들어간다. `holdReads` 는 `readMemo`·`openExternal` 만 붙잡는다. 다른 읽기로 불러오는 중을 만들려면 그 호출을 더한다.
  - 조합 이벤트를 직접 보내는 시험은 `toBeFocused` 뒤에 본문 텍스트(`toHaveText`)를 먼저 기다린다. 포커스는 본문이 그려지기 전에 올 수 있고, 그때 `view.domAtPos` 가 `No tile at position N` 을 던진다.
  - 목록·메뉴처럼 포커스를 가져가는 오버레이가 있는 화면에서는 포커스 이동의 부수 효과(조합 확정 등)가 구분력 시험을 조용히 약하게 만들 수 있다. 시험이 정말 보호 대상 코드 때문에 통과하는지 그 코드를 지워 실패하는지 본다.
  - 개발 서버에서 받는 것(`readExtensionFile` 이 받는 언어 설정 등)은 부하에서 늦게 도착한다. 늦은 응답의 효과를 시험하려면 `page.route` 로 그 요청을 붙잡았다가 풀어 준다. 실제 앱에서는 같은 데이터가 IPC 로 와서 이 방법이 닿지 않는다.
  - 기다리는 것이 없는 동기 테스트의 시간 초과는 디스크·CPU 처리량을 잰다. 검사하는 것이 속도가 아니면 그 테스트에만 시간 제한을 준다(`scripts/perf-fixtures.test.ts` 의 1만 메모 테스트). 올린 제한 안의 속도 회귀는 이제 잡히지 않는다. 속도는 perf 스크립트(`pnpm perf:measure`)가 잰다.
    - 1만 메모 테스트의 5초 초과는 재현되지 않았다. 단독 20번(부하 9~28)과 `pnpm exec vitest run` 전체 3번(부하 13)에서 최대 2.4초였다. 그래서 「시간 초과는 처리량」 은 테스트가 동기라는 코드에서 나온 판단이지 관찰이 아니다. 30초 제한을 넘기거나 다른 메시지로 실패하면 원인을 다시 찾는다.

## `@codemirror/view` 는 패치해서 쓴다 — 포커스 직후 커서가 줄 머리로 가지 않게

`patches/` 의 `@codemirror/view` 패치(`pnpm-workspace.yaml` 의 `patchedDependencies`)는 `DOMObserver.readSelectionRange` 의 「포커스 뒤 200ms 안에 브라우저가 선택을 편집기 맨 앞으로 옮겼다」 보정 분기에 한 줄을 더한다. 그 분기는 캐시된 선택을 지금 DOM 선택으로 바꾸지 않고 `updateSelection()` 을 불러서, 옮기기 전의 캐시와 비교해 「이미 제자리」 로 보고 아무것도 쓰지 않는다. 그러면서 보정 표시(`lastFocusTime`)만 지운다. 패치는 비교 전에 캐시를 지금 DOM 선택으로 맞춘다.

- **Why:** 칸이 다시 보이며 편집기가 포커스를 받은 직후 첫 색(하이라이트 decoration)이 오면, 커서가 있던 텍스트 노드가 span 으로 옮겨지고 WebKit 이 DOM 선택을 `(줄, 0)` 으로 접는다. 패치가 없으면 다음 measure 가 그 선택을 사람의 선택으로 받아 커서가 줄 머리로 가고, 다음 글자가 줄 머리에 들어간다. 상위 최신판에도 같은 코드가 있다.
- **How to apply:**
  - 이 패치를 지키는 시험은 `tests/e2e/highlight.spec.ts` 「colours that land just after the editor takes the focus leave the cursor in place」 다. 패치를 빼면 결정적으로 실패한다.
  - `node_modules` 의 파일을 직접 고치지 않는다. pnpm 저장소의 하드 링크라 다른 워크트리까지 바뀐다. 고칠 것은 `pnpm patch @codemirror/view@<판> --edit-dir <임시 폴더>` 로 풀고 고친 뒤 `pnpm patch-commit <임시 폴더>` 로 만든다.
  - `@codemirror/view` 를 올리면 패치의 판 이름이 맞지 않아 `pnpm install` 이 실패한다. 새 판의 `readSelectionRange` 를 보고, 그 분기가 `updateSelection` 전에 `selectionRange.setRange(range)` 를 하면(상위가 고쳤으면) `patchedDependencies` 항목과 패치 파일을 지운다. 아니면 새 판에 같은 한 줄로 패치를 다시 만들고 옛 패치를 지운다. 어느 쪽이든 위 시험을 돌린다.
  - 패치는 `pnpm install` 때 적용된다. post-checkout 훅은 설치를 돌리지만 merge·pull 로 받은 체크아웃은 훅이 돌지 않으므로, 패치를 들이거나 바꾼 커밋을 merge·pull 로 받은 뒤에는 `pnpm install` 을 다시 돌린다.

## 편집기 명령의 이름은 `Function.name` 이 아니라 import 이름에서 얻는다

설정 화면이 편집기 키를 부르는 이름(`src/shortcuts/keys.ts` 의 `editorBindings`)은 `src/shortcuts/command-names.ts` 의 `commandName` 이 준다. 편집기 키맵(`editorKeymap`)에 걸린 명령만 이름으로 import 해 `Map<함수, 이름>` 을 만든다.

- **Why:** 배포 빌드(vite 8/rolldown 압축)가 함수 이름을 `Qp` 같은 것으로 바꾼다. `Function.name` 에 기대면 `keepNames` 로 번들이 커지고 빌드 검사도 따로 있어야 했다. import 이름은 압축되지 않는다. `import * as` 로 패키지 전체를 모으면 tree-shaking 이 깨져 gzip 이 약 7kB 커지므로(측정함) 키맵이 쓰는 명령만 이름으로 import 한다. vitest·e2e 는 압축 전 코드를 돌려 이 문제를 잡지 못하므로 `Function.name` 을 읽는 코드를 되살리지 않는다.
- **How to apply:** 키맵에 명령을 더하면 `command-names.ts` 의 표에도 더한다. `src/shortcuts/command-names.test.ts` 의 「names every command the editor keymap binds」 가 빠진 명령을 잡는다.

## e2e 는 메뉴 단축키를 누르지 못한다

가짜 백엔드가 메뉴 항목의 id 를 페이지로 직접 보낸다. 그래서 e2e 는 「단축키가 메뉴 항목에 실제로 걸리는가」 「눌렀을 때 그 항목이 실행되는가」 를 보지 못한다.

- **Why:** accelerator 는 네이티브 메뉴(muda)가 받는다. Playwright 의 키 입력은 웹뷰 안으로만 들어가므로 메뉴를 지나지 않는다.
- **How to apply:** 단축키 연결은 Rust 시험(`menu.rs`·`shortcuts.rs`)과 화면 확인(`docs/superpowers/reports/2026-10-20-tote-notes-settings-and-shortcuts-smoke.md`)으로 본다. e2e 가 통과했다는 것을 메뉴 단축키가 동작한다는 증거로 쓰지 않는다.
