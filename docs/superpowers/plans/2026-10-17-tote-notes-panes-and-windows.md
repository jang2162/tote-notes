# tote-notes 칸 분할·새 창·워크스페이스 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 창의 편집 영역을 좌우 칸으로 나누고, 같은 워크스페이스로 창을 여럿 열고 탭을 새 창으로 떼어 내며, 사이드바 왼쪽의 워크스페이스 띠로 지금 창의 워크스페이스를 바꾼다. 셋 다 「언제 꺼도 다시 켜면 그대로다」를 지킨다. 앞 계획이 넘긴 정리 항목(종료 결정의 순수 함수, 백업 알림 시계, 충돌 보관 배너 등)을 먼저 끝낸다.

**Architecture:** Rust 의 `AppCore` 는 워크스페이스를 경로마다 한 번 열고, 창(라벨 `ws-<n>`)은 그 워크스페이스를 가리킨다. 감시·백업은 워크스페이스마다 돌고 결과를 그 워크스페이스의 창 전부에 보낸다. 세션 파일은 워크스페이스·기기마다 하나로 남되 버전 2 가 되어 창 여럿의 배치를 담고, 백엔드가 창들의 배치를 모아 한 번에 쓴다. 「한 메모는 한 자리에」는 백엔드의 자리 등록부(`Places`)가 지키고, 프론트엔드는 탭을 열기 전에 자리를 받는다. 프론트엔드의 `AppController` 는 창 하나를 맡고, 칸마다 `Pane`(편집기·탭 목록·편집 영역·탭 바)을 둔다. 워크스페이스 전환은 창 닫기와 같은 쓰고 닫기 라운드를 지난 뒤 웹뷰를 새로 고친다.

**Tech Stack:** Tauri 2(`WebviewWindowBuilder`, `tauri::menu`, `@tauri-apps/api/menu`), Rust(`cargo test`), TypeScript + Vite, CodeMirror 6, Vitest, Playwright(WebKit), Orca `computer-use`.

**Spec:** `docs/superpowers/specs/2026-10-16-tote-notes-panes-and-windows-design.md` (이 계획이 구현하는 설계. 코어 스펙의 「전체 구조」·「세션」·「범위」 절을 바꾼다). 코어 스펙은 `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`. 앞 계획에서 넘어온 항목의 출처는 `docs/superpowers/reports/2026-10-16-tote-notes-safety-net-followups-smoke.md` 「사람 스모크에 보탤 것」·「다음 계획으로 넘기는 것」 절과 `docs/superpowers/reports/2026-10-17-tote-notes-safety-net-followups-rulings.md`. 실행자는 이 문서들을 함께 읽는다. 설계 문서의 **(설계자 판단)** 은 모두 확정된 것이다 — 다시 열지 않는다.

## 이 계획이 정한 것

설계 문서가 「만드는 사람에게 맡기는 것」으로 남긴 자리와, 앞 계획이 넘긴 판단을 채운 것이다.

- **워크스페이스 전환은 웹뷰 새로 고침으로 한다.** 컨트롤러는 워크스페이스에 매인 상태(메모 목록, 탭, 하이라이트 워커의 문서, 검색 번호, 뷰어 토큰)를 스무 곳 넘게 들고 있고, 백엔드 이벤트 구독(`onMenu`·`onFlush`·`onPending`·`onFileDrop`·`onOutsideChange`·`onConfigChanged`)에는 해지가 없다. 다시 세우다 하나라도 놓치면 옛 워크스페이스의 이벤트가 새 워크스페이스의 탭에 닿는다 — 실패가 조용하고 메모를 잘못 쓸 수 있다. 새로 고침은 앱 시작과 같은 시작·복원 경로를 지나므로 따로 검증할 경로가 생기지 않고, 그 경로는 세션 복원 측정(탭 50개 → ready 1,000ms)이 이미 잰다. 대가는 JS·레지스트리·문법을 다시 읽는 시간이고, 사람 스모크에서 잰다(목표 1,000ms, 관문 아님). 새로 고침 뒤 Tauri 이벤트가 두 번 오거나 창 위치가 바뀌면(스파이크 (c)) 같은 자리·크기로 창을 새로 만드는 쪽으로 간다(Task 12).
- **창 라벨은 `ws-<n>`** 이다. `n` 은 실행마다 1부터 센다. 라벨은 창의 신원이고 워크스페이스를 담지 않는다 — 전환해도 라벨은 그대로다. 권한 설정의 `ws-*` 는 그대로다. 워크스페이스 감시의 대상 이름은 `wk-<경로 해시 16자>` 로 따로 둔다.
- **같은 워크스페이스는 한 번만 연다.** `AppCore` 가 경로마다 `Workspace` 하나를 들고 창들이 그것을 함께 쓴다. 마지막 창이 떠나면(닫기·전환) 닫는다. 한 창의 명령이 메모 목록을 바꾸면(만들기·쓰기·제목·이름·언어·삭제·가져오기) 같은 워크스페이스의 다른 창에 `tote://memos` 를 보내고, 받은 창은 **300ms** 모아 한 번 다시 읽는다.
- **세션 파일 버전 2.** `{ "version": 2, "windows": [WindowSession…] }`, `WindowSession = { frame?, panes: [{ tabs, activeTab, width }], focusedPane }`. `width` 는 편집 영역 너비에서 차지하는 비율(합 1). 탭 항목은 지금 형식 그대로다. 버전 1(`{version:1, window?, activeTab, tabs}`)은 `frame = window`, 칸 하나(`width: 1`)짜리 창 하나로 읽는다 — Rust(창 위치가 필요하다)와 TS(가짜 백엔드·파싱)가 각자 같은 규칙으로 읽는다.
- **백엔드가 창들의 배치를 모은다.** 창마다 마지막으로 받은 배치(처음에는 되살린 배치)를 들고, 어느 창이 쓰든 파일에는 「그 워크스페이스의 열린 창들의 배치, 연 순서」를 쓴다. 닫는 창이 마지막이면 그 배치만 남고, 아니면 빠진다(설계 「세션과 앱 상태」).
- **`state.json` 의 `openWindows` 는 창마다 한 줄**이라 같은 경로가 여러 번 나온다. 다시 켤 때 경로 P 의 k 번째 줄은 P 세션의 k 번째 배치를 받는다. 종료 때 `start_quit` 가 `openWindows` 와 각 세션 파일을 **같은 순서**(오래 전에 포커스된 창부터, 마지막이 앞에 온다)로 다시 써서 둘이 어긋나지 않는다. 어긋나도 배치가 같은 워크스페이스의 창끼리 바뀔 뿐 잃지 않는다.
- **「한 메모는 한 자리에」는 백엔드의 자리 등록부가 지킨다.** 열쇠는 메모면 (워크스페이스 경로, 메모 ID), 외부 파일이면 경로(워크스페이스와 무관). 프론트엔드는 탭을 만들기 전에 자리를 받고(`claimTabs`), 다른 창이 갖고 있으면 백엔드가 그 창을 앞으로 가져오고 `tote://reveal` 로 그 탭을 활성화시킨다. 창이 닫히거나 워크스페이스를 바꾸면 그 창의 자리는 모두 풀린다. 같은 창 안의 칸끼리는 프론트엔드가 먼저 찾는다.
- **프론트엔드 구조.** `AppController` 는 창(사이드바, 띠, 상태 표시줄, 메뉴, 세션, 자리)을, `Pane`(새 `src/app/pane.ts`)은 칸(편집기 `EditorView`, `Tabs`, `Surface`·배너, `TabBar`, 뷰어 패널)을 맡는다. 칸 너비 계산은 순수 함수(`src/app/layout.ts`)다. `Doc` 은 지금처럼 자기 `EditorState` 를 갖고, 칸을 옮겨도 같은 객체다(같은 창 안에서는 실행 취소 기록도 따라간다).
- **칸 너비.** 최소 폭 320px 은 나누기(⌘\)와 경계 끌기에만 적용한다. 창을 줄이면 칸은 비율대로 줄고 320px 아래로도 내려간다. 칸이 닫히면 그 너비는 왼쪽 이웃이(맨 왼쪽이면 오른쪽 이웃이) 갖고 포커스도 그 이웃으로 간다.
- **빈 칸 안내 문구:** `빈 칸입니다. 메모 목록에서 메모를 열거나 ⌘N 을 누르세요`.
- **새 창의 자리.** ⌥⌘N 과 떼어 내기의 새 창은 원래 창에서 오른쪽·아래로 24px 비켜 같은 크기로 연다. 그 자리가 화면 밖이면 기본 크기로 가운데에 연다.
- **떼어 내기.** 메모는 즉시 저장하고, 외부 파일은 저장 전 수정분을 즉시 보관한 뒤 옮긴다. 실패하면 옮기지 않고 상태 표시줄에 `저장하지 못해 새 창으로 옮기지 않았습니다` 를 띄운다(탭의 「저장 실패」는 그대로다). 새 창의 처음 배치(옮긴 탭 하나)는 새 창이 뜨기 전에 백엔드가 들고 있어, 그 사이에 앱이 꺼져도 탭은 세션에 남는다.
- **메뉴 자리.** 설계의 「메뉴 창 › 탭을 새 창으로 옮기기」는 지금의 「윈도우」 메뉴에 둔다. 「새 창」(⌥⌘N)은 「파일」 메뉴, 「칸 나누기」(⌘\)·「왼쪽 칸으로」(⌥⌘←)·「오른쪽 칸으로」(⌥⌘→)는 「보기」 메뉴다. 탭의 오른쪽 클릭 메뉴는 네이티브 팝업(`@tauri-apps/api/menu`)이다.
- **메뉴와 단축키는 포커스된 창에 간다.** `is_focused()` 인 창, 없으면 마지막으로 포커스된 창.
- **창 제목.** 같은 워크스페이스의 창을 연 순서로 세어 두 번째부터 ` — 2`, ` — 3` 을 붙이고, 창이 닫히거나 떠나면 다시 센다. 백엔드가 제목을 정하고(`set_title`), 프론트엔드는 `workspaceInfo().title` 로 `document.title` 을 맞춘다.
- **띠.** 이름 순은 NFC 로 맞춘 이름의 코드 포인트 순이다. 둥근 칸의 두 글자는 그래핌 둘이다(`Intl.Segmenter`). 점은 「이 창 말고 그 워크스페이스를 보이는 창이 있다」이다 — 지금 창의 워크스페이스도 다른 창에 열려 있으면 점이 찍힌다. ⌃1–⌃9 는 프론트엔드가 `keydown`(capture)에서 받는다.
- **새 워크스페이스는 어디서 만들든 지금 창에서 연다.** 띠의 `+`, 메뉴 「새 워크스페이스…」, 「워크스페이스 열기…」 대화상자의 만들기 셋 다. 「워크스페이스 열기…」에서 **고른** 것은 지금처럼 새 창으로 연다.
- **전환도 쓰고 닫기 라운드다.** `FlushGoal::SwitchWorkspace` 가 창 닫기처럼 그 창 하나를 flush 하고, 저장 실패가 남으면 `그래도 바꾸기` / `취소` 를 묻는다. 한 창에는 창 라운드(닫기·전환)가 하나만 돈다.
- **조합 확정.** 칸 포커스 이동, 탭 옮기기, 떼어 내기, 워크스페이스 전환·창 닫기·종료의 flush 앞에서 `settleComposition` 이 조합 중인 편집기의 포커스를 빼고 `compositionend` 를 **150ms** 까지 기다린다(macOS 입력기는 포커스 이동을 확정으로 처리한다 — 코어 스펙 「편집기」).
- **N3: 종료는 쓰는 중인 창 라운드에도 붙는다.** 묻는 중뿐 아니라 아직 쓰는 중인 창 닫기·전환 라운드에도 붙는다. 이 계획이 창 라운드를 자주 만든다(전환마다) — 쓰는 사이의 ⌘Q 가 대화상자를 둘 띄우지 않게 한다. 그 라운드가 문제없이 끝나면 목표를 이룬 뒤 종료를 시작하고, 막히면 질문 하나에 둘 다 답한다. 종료가 늦어지는 것은 페이지가 멈춘 경우뿐이다(창 라운드 3초 + 종료 라운드 3초).
- **N4 도 고친다.** 「그래도 닫기」로 닫히는 창은 `AppCore` 에서 빠지기 전이라도 종료 라운드와 「다시 열 창」에서 뺀다. 사람 스모크의 확인 항목은 그대로 둔다.
- **T5-1 은 고친다.** 충돌 보관 배너가 있는 탭에 다른 배너(새 충돌·삭제)가 오르면 그 배너가 끝난 뒤 보관 배너가 돌아온다. 보관 배너를 끝내는 것은 사람의 「닫기」와 탭 닫기뿐이다.
- **백업 실패 알림은 창마다다.** 백업은 워크스페이스마다 한 번 찍고, 실패는 그 워크스페이스의 창마다 처음 한 번, 이어지면 벽시계로 하루마다 알린다(N1).

## 이 계획이 다루지 않는 것

- 위아래 분할, 같은 메모를 두 칸·두 창에 여는 것, 이미 열린 다른 창으로 탭 옮기기(설계 「하지 않는 것」).
- 마켓플레이스·동기화, 코어 스펙 「1차에 넣지 않는 것」의 나머지(⌘P, 명령 팔레트, 나란히 미리보기 등).
- 부하 때문에 흔들리는 테스트의 원인 조사 — 아래 Global Constraints 의 목록으로 관리한다.

## Global Constraints

모든 태스크의 요구 사항에 아래가 포함된다. 값은 설계 문서와 코어 스펙에서 그대로 옮겼다.

- 플랫폼은 macOS 먼저다. OS 에 기대는 코드는 Rust 모듈 경계 안(`backup`, `watch`, `appdata`, `cli`, `app/lifecycle.rs` 의 `system_quit`)에 가둔다.
- 코어 스펙의 저장·외부 변경·백업·오류 처리 규칙은 바뀌지 않는다. **원자적 쓰기**와 **백업 하드링크 규칙**은 그대로다. 백업은 창 수와 관계없이 **워크스페이스마다 한 번** 찍는다.
- **앱 종료를 막는 경우는 저장 실패 하나뿐이다.** **Dock 종료·로그아웃은 macOS 가 답을 기다린다** — `TerminateLater` 를 돌려준 요청은 어떤 경로로 끝나든 `system_quit::answer` 로 한 번 답한다. 창이 여럿이어도 마찬가지다.
- **쓰고 닫기(flush)는 창마다 돈다.** 워크스페이스 전환과 탭 떼어 내기도 이 경로(즉시 저장, 수정분 보관)를 지난다.
- **한 메모는 한 자리에:** 메모와 외부 파일은 모든 창을 통틀어 한 창의 한 칸에만 탭으로 열린다. 외부 파일은 워크스페이스가 달라도 한 자리다. 이미 열린 것을 다른 자리에서 열면 열린 자리로 포커스를 옮긴다. `tote -w B a.sh` 는 이미 열린 `a.sh` 를 옮기지 않는다. 세션을 되살리다 이미 다른 자리에 열린 탭을 만나면 되살리는 쪽에서 뺀다.
- **값:** 칸 최소 폭 **320px**, 띠 폭 **48px**, 칸 나누기 ⌘\, 칸 포커스 ⌥⌘← / ⌥⌘→, 새 창 ⌥⌘N, 워크스페이스 전환 ⌃1 – ⌃9, 탭 순환 ⇧⌘] / ⇧⌘[ 는 포커스 칸 안에서만. 세션은 변화가 멈추고 **1초** 뒤, 창을 닫거나 앱을 끌 때 즉시 쓴다.
- **문구(그대로 쓴다):** `창이 좁아 나눌 수 없습니다`, `새 창`, `칸 나누기`, `왼쪽 칸으로`, `오른쪽 칸으로`, `탭을 새 창으로 옮기기`, `저장하지 못한 메모가 있습니다`, `그래도 바꾸기`, `취소`, 창 제목 꼬리 ` — 2`(앞에 공백, em dash, 공백). 사용자에게 보이는 문구는 한국어, 코드 주석은 영어.
- **한글 조합:** 칸 포커스 이동·탭 옮기기·창 전환·워크스페이스 전환 전에 조합을 확정한다(코어 스펙 「편집기」).
- **성능:** 코어 스펙 「목표와 측정」을 따른다. 칸이 여럿이어도 **보이는 칸의 문서만** 하이라이트한다. 전환 속도 목표(누른 뒤 대상의 활성 탭이 보이기까지 **1,000ms**)는 관문이 아니다 — Task 15 에서 잰다.
- **Tauri 권한 설정은 창 라벨 `ws-*` 만 허용한다.** 새 창 라벨도 이 꼴이다.
- 주석 규칙은 `docs/guideline/base/03-comments.md`, 인용은 `docs/guideline/base/04-citation.md`(줄번호가 아니라 이름·절 제목).
- **커밋:** 경로를 명시해 stage 한다(`git add -A` 금지). 커밋 전에 `pnpm exec oxfmt <바꾼 파일>`, `pnpm exec oxlint --fix <바꾼 TS 파일>`, `cargo fmt --manifest-path src-tauri/Cargo.toml`. Rust 를 바꾼 태스크는 `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 도 돈다.
- **테스트 명령:** Rust `cargo test --manifest-path src-tauri/Cargo.toml`, 단위 `pnpm test`, 타입 `pnpm typecheck`, e2e `pnpm test:e2e`(WebKit, Vite 포트 `TOTE_E2E_PORT` 기본 1430 — 워크트리를 여럿 돌리면 워크트리마다 다른 값). 결과는 **실행된 개수**와 함께 보고한다(0개면 통과가 아니다). 태스크 끝에는 넷 모두 돌린다.
- **부하에서 흔들리는 것으로 알려진 테스트:** `scripts/perf-fixtures.test.ts`(시간 초과), `tests/e2e/memo.spec.ts` 「guard: keys typed while a memo picked in the list loads do not reach the tab left」, `tests/e2e/watch.spec.ts` 「a deleted memo keeps its text and 다시 저장 brings it back」(`.memo-row` 가 5초 안에 사라지지 않는다). 이 셋만 실패하면 `uptime` 의 load 를 적고 그 테스트만 `--repeat-each=5` 로 다시 돌려 결과를 보고에 적는다. 새로 흔들리는 테스트는 이 목록에 넣지 않고 원인을 찾는다.
- **에이전트가 앱을 띄울 때는 반드시 `TOTE_DATA_DIR=<임시 폴더>`** 를 주고, 사람의 화면을 쓰지 않는 확인은 `TOTE_BACKGROUND=1` 도 준다(`docs/guides/development.md` 「디버그 앱은 언제나 `TOTE_DATA_DIR` 을 주고 띄운다」). 디버그 번들은 `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json` → `src-tauri/target/debug/bundle/macos/tote-dev.app`. 끝나면 `~/Tote-dev` 와 `~/Library/Application Support/tote-dev` 가 생기지 않았는지 본다. 실제 메모 폴더 `~/Tote` 는 건드리지 않는다.
- 생성물(번들 확장 산출물, `src/backend/fake-registry.json`)은 `pnpm sync:bundled` 로, `AGENTS.md` 는 `.ruler/` 를 고친 뒤 `pnpm exec ruler apply` 로 만든다.
- **스파이크 결과가 뒤 태스크를 가른다.** Task 4 보고서의 판정 (a1)·(a2)·(b)·(c) 를 해당 태스크가 「갈래」 줄에서 따른다. 판정이 「확인 못 함」이면 각 갈래의 안전한 쪽(아래 각 태스크에 적었다)으로 간다.

## Review Focus

설계가 암시하지만 기본 테스트가 놓치기 쉬운 입력이다. 사람이 가장 먼저 부딪힐 것부터 적었고, 줄마다 고정하는 테스트를 소유 태스크에 넣었다.

1. **한글을 조합하는 중에 ⌥⌘→ 로 칸을 옮기거나 띠를 누른다.** 조합 중인 글자는 원래 탭에 확정되고 다른 칸·다른 워크스페이스의 메모에 들어가면 안 된다. Task 9 의 `a composition in progress lands in its own pane before the focus moves` 와 `settleComposition` 단위 테스트가 고정한다.
2. **탭을 떼어 낸 직후, 새 창이 아직 뜨는 중에 앱이 꺼진다(⌘Q·강제 종료).** 탭이 원래 창에서도 새 창에서도 사라지면 안 된다. Task 11 의 `a_torn_off_tab_is_in_the_session_before_its_window_loads` 가 고정한다.
3. **손으로 고쳤거나 옛 실행이 남긴 세션이 같은 메모를 두 칸(또는 두 창)에 담고 있다.** 한 자리에만 되살아나야 한다. Task 9 의 `a session listing one memo in two panes restores it once` 와 Task 7 의 `a restored tab open elsewhere is left out` 이 고정한다.
4. **띠로 바꾸려는 워크스페이스 폴더가 그사이 지워졌거나 옮겨졌다.** 지금 창은 원래 워크스페이스에 그대로 있고(탭도 그대로), 상태 표시줄이 이유를 말해야 한다. Task 12 의 `switching_to_a_vanished_workspace_leaves_the_window_where_it_was` 가 고정한다.
5. **칸을 셋 나눈 뒤 창을 아주 좁게 줄였다가 다시 켠다.** 칸 비율은 그대로 돌아오고, 그 상태에서 ⌘\ 는 거절돼야 한다. Task 9 의 `widths keep their ratios in a window too narrow for them` 과 `⌘\ in a narrow window says so and does nothing` 이 고정한다.

---

## 파일 구조

```
src-tauri/src/
  app/mod.rs           OpenWorkspace(경로마다)·OpenWindow(라벨마다), 배치 모으기, 자리, 전환
  app/places.rs        (새) Places — 한 메모는 한 자리에
  app/flush.rs         창 라운드, 종료 흡수(N3), SwitchWorkspace
  app/lifecycle.rs     Step·steps_for_ack·steps_for_answer(순수), 전환·닫기·종료 실행
  app/windows.rs       open_window·show·switch, WindowPlan, near_frame, 제목
  app/commands.rs      read/write_window_layout, claim_tabs, release_tab, tear_off_tab, switch_workspace
  app/menu.rs          새 창, 칸 메뉴, 탭 옮기기, 포커스된 창으로
  app/requests.rs      show 의 새 뜻에 맞춤
  session/mod.rs       버전 2 읽기·쓰기, 버전 1 읽기, layout_frame
  appdata.rs           LaunchState.openWindows 중복 허용, switch_open
  backup/notices.rs    SystemTime
  lib.rs               감시·백업 결과를 창들에 퍼뜨림, 명령 등록
src/
  app/controller.ts    창: 칸들, 띠, 자리, 전환, 떼어 내기
  app/pane.ts          (새) Pane — 칸 하나
  app/layout.ts        (새) 칸 너비 순수 함수
  app/session-sync.ts  WindowSession 쓰기·되살리기
  app/docs.ts          DocHost.viewOf, Doc.tabRef, 충돌 보관 배너
  core/session.ts      SessionFile v2, parseSessionFile, parseWindowSession
  editor/compose.ts    (새) settleComposition
  ui/rail.ts           (새) 워크스페이스 띠
  ui/tab-bar.ts        끌기, dropIndex
  backend/types.ts, tauri.ts, fake.ts
spikes/windows/        (새) 여러 창 시험 스파이크
spikes/lab/            끌어 놓기·새로 고침 스파이크 모드
docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-spike.md
docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-smoke.md
docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-human-smoke.md
```

---

### Task 1: 종료 결정을 순수 함수로 빼고, 종료가 쓰는 중인 창 라운드에도 붙는다

앞 계획이 넘긴 T6-1·T6-2·T6-3·N3·N4 를 한 자리(`flush.rs`·`lifecycle.rs`)에서 끝낸다. 로그아웃이 멈추지 않는다는 보증을 사람 스모크에서 단위 테스트로 옮긴다.

**Files:**

- Modify: `src-tauri/src/app/flush.rs` (`Ack`, `FlushCoordinator::begin`·`end`, 테스트)
- Modify: `src-tauri/src/app/lifecycle.rs` (새 `Step`·`steps_for_ack`·`steps_for_answer`, `settle`·`resolve_blocked`·`finish`)
- Modify: `src-tauri/src/app/mod.rs` (`closing`, `begin_flush`, `start_quit`)
- Test: 세 파일의 `mod tests`

**Interfaces:**

- Produces:
  - `Ack::DoneThenQuit(FlushGoal)` — 종료가 붙어 있던 창 라운드가 문제없이 끝났다: 목표를 이룬 뒤 종료를 시작한다.
  - `lifecycle.rs`(macOS 조건 밖, 테스트가 돈다):

    ```rust
    #[derive(Debug, PartialEq, Eq)]
    pub enum Step {
        Finish(FlushGoal),
        BeginQuit,
        /// Tell a waiting macOS 「no」 (Dock quit, logout). Does nothing when macOS is not waiting.
        RefuseSystemQuit,
        Ask { goal: FlushGoal, reasons: Vec<String> },
    }
    pub fn steps_for_ack(ack: Ack) -> Vec<Step>;
    pub fn steps_for_answer(goal: FlushGoal, anyway: bool, quit_waiting: bool) -> Vec<Step>;
    ```

  - `AppCore::closing(&self, label: &str)` — 그 창은 닫히는 중이다. 종료 라운드의 대상과 `start_quit` 의 다시 열 창에서 빠진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`flush.rs`:

- T6-1: `cancelling_an_asking_close_reports_the_waiting_quit` 의 이름을 `cancelling_an_asking_close_without_a_quit_reports_none` 으로 바꾼다(단언 `!f.cancel(id)` 은 그대로).
- T6-2 `the_first_asking_close_takes_the_quit` — `a`·`b` 의 닫기 라운드를 둘 다 묻는 중으로 만든 뒤 `begin(Quit, ["a","b"])` 는 `AlreadyRunning`, `cancel(a의 id)` 는 `true`, `cancel(b의 id)` 는 `false`.
- N3 `a_quit_joins_a_close_still_writing` — `begin(CloseWindow("a"), ["a"])` → `Started{id}`, `begin(Quit, ["a","b"])` 는 `AlreadyRunning`, `ack(id, "a", None)` 은 `Ack::DoneThenQuit(CloseWindow("a"))`.
- `a_writing_close_that_fails_asks_once_for_both` — 위에서 `ack(id, "a", Some(ONE_FAILED))` 는 `Blocked{..}`, 이어 `cancel(id)` 는 `true`.
- `a_writing_close_that_times_out_still_quits` — `expire(id)` 는 `DoneThenQuit(CloseWindow("a"))`.
- `a_closed_window_ends_its_round_and_starts_the_quit` — `window_gone("a")` 는 `[(id, DoneThenQuit(CloseWindow("a")))]`.
- 바뀐 규칙에 맞춰 고친다: `quitting_during_a_close_round_finishes_both` → `a_quit_during_a_close_round_waits_for_it`(종료가 따로 라운드를 열지 않는다). `a_second_quit_during_a_running_quit_does_not_join_an_asking_close` → `a_close_during_a_running_quit_is_absorbed`(종료 라운드가 돌고 있으면 닫기는 `AlreadyRunning`, 그 종료 라운드가 끝나면 `Done(Quit)`). 묻는 닫기 + 도는 종료는 이제 생기지 않는다(닫기가 먼저면 종료가 붙고, 종료가 먼저면 닫기가 흡수된다).

`lifecycle.rs` — 최종 리뷰가 말한 「Dock 종료·로그아웃 답 추적」 표(저장소에 남지 않았다)를 이 계획이 아래처럼 다시 세웠고, 그것을 테스트 표로 쓴다. `every_answer_settles_a_waiting_system_quit`:

| 시작한 라운드 | 답          | 종료가 붙음 | `steps_for_answer`                 |
| ------------- | ----------- | ----------- | ---------------------------------- |
| `Quit`        | 그래도 종료 | —           | `[Finish(Quit)]`                   |
| `Quit`        | 취소        | —           | `[RefuseSystemQuit]`               |
| `CloseWindow` | 그래도 닫기 | 아니오      | `[Finish(CloseWindow)]`            |
| `CloseWindow` | 취소        | 아니오      | `[]`                               |
| `CloseWindow` | 그래도 닫기 | 예          | `[Finish(CloseWindow), BeginQuit]` |
| `CloseWindow` | 취소        | 예          | `[RefuseSystemQuit]`               |

그리고 `every_ack_carries_its_goal_out_or_asks`: `Pending` → `[]`, `Done(g)` → `[Finish(g)]`, `DoneThenQuit(g)` → `[Finish(g), BeginQuit]`, `Blocked{goal, reasons}` → `[Ask{goal, reasons}]`. 표의 각 행 옆에 주석 한 줄로 macOS 가 답을 받는 자리를 적는다(`Finish(Quit)` 은 `finish` 가 `answer(true)`, `BeginQuit` 은 새 종료 라운드의 끝이 답한다).

`app/mod.rs` `a_window_being_closed_is_left_out_of_a_quit` — 워크스페이스 `가`·`나` 를 열고 `core.closing(가의 라벨)` 뒤 `begin_flush(Quit)` 는 `Started { windows: [나의 라벨] }`, `start_quit()` 뒤 저장된 `LaunchState.open_windows` 는 `[나의 경로]`.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml flush lifecycle app::tests`
Expected: 새 테스트 FAIL(`DoneThenQuit`·`Step`·`closing` 없음, `Started` 를 기대한 곳이 `AlreadyRunning`).

- [ ] **Step 3: 구현한다**

- `begin(Quit, …)`: 종료 라운드가 없고 창 라운드(`CloseWindow`)가 있으면 — 묻는 중이든 쓰는 중이든 — 가장 먼저 연 것에 `quit_waiting = true` 를 세우고 `AlreadyRunning`. `end` 는 이유가 없고 `quit_waiting` 이면 `DoneThenQuit(goal)`.
- `settle` 은 `steps_for_ack(ack)` 를, `resolve_blocked` 는 `steps_for_answer(goal, anyway, core.cancel_flush(id))` 를 차례로 실행하는 함수 `run_steps(app, id, steps)` 를 지난다. `RefuseSystemQuit` 만 macOS 조건 안에서 `system_quit::answer(app, false)`.
- `finish(CloseWindow(label))` 는 `destroy` 전에 `core.closing(label)`. `begin_flush(Quit)`·`start_quit` 는 `closing` 인 창을 뺀다. `closed(label)` 이 표시를 지운다.
- `flush.rs` 의 `Begin::AlreadyRunning` doc 주석과 모듈 머리 주석을 새 흡수 규칙으로 고친다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: PASS, 실행 개수를 적는다. `only_a_round_left_running_makes_macos_wait` 는 그대로 통과한다.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/app/flush.rs src-tauri/src/app/lifecycle.rs src-tauri/src/app/mod.rs
git commit -m "fix(quit): settle every quit answer through one tested table and fold a quit into a writing close"
```

---

### Task 2: 백업 알림을 벽시계로 재고, 이전 버전 구간 테스트를 더한다

N1·T2-1(같은 자리)과 T3-1.

**Files:**

- Modify: `src-tauri/src/backup/notices.rs` (`FailureNotices`)
- Modify: `src-tauri/src/lib.rs` (`start_backups`)
- Modify: `src-tauri/src/backup/versions.rs` (테스트만)
- Test: `notices.rs`·`versions.rs` 의 `mod tests`

**Interfaces:**

- Produces: `FailureNotices::failed(&mut self, label: &str, now: SystemTime) -> bool` — `told: HashMap<String, SystemTime>`. 나머지 메서드는 그대로다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

- `notices.rs` 의 기존 테스트를 `SystemTime` 기준으로 바꾸고 하나를 더한다: `a_clock_set_back_tells_again` — `failed("a", t)` 뒤 `failed("a", t - 1시간)` 은 `true`(`duration_since` 가 오류면 알리는 쪽).
- `versions.rs` `a_run_of_three_and_a_return_are_listed_apart` — 스냅샷 10:00 `A`, 10:10·10:20·10:30 `B`, 10:40 `A`. 목록(최신부터)은 `[{snapshot: 10:40, until: 10:40}, {snapshot: 10:10, until: 10:30}, {snapshot: 10:00, until: 10:00}]` — 되돌아온 `A` 는 첫 `A` 와 합쳐지지 않는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notices versions`
Expected: `notices` 는 컴파일 오류(`Instant` 를 넘긴다), `versions` 의 새 테스트는 지금 코드로 통과할 수 있다 — 통과하면 그대로 둔다(빠진 테스트를 채우는 것이다).

- [ ] **Step 3: 구현한다**

- `FailureNotices` 가 `SystemTime` 으로 잰다. 모듈 머리 주석: `Instant` 는 macOS 에서 잠자기 동안 멈추므로, 사람의 「하루」는 벽시계로 잰다.
- `start_backups`: `notices.failed(&label, SystemTime::now())`. 정기 라운드 뒤 `deadline = Instant::now() + interval`(따라잡기 뒤 한 번 더 바로 도는 것을 없앤다). 그 자리의 주석을 「긴 라운드 뒤에는 지금부터 한 간격을 센다」로 고치고, 잠자기 이야기는 뺀다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: PASS, 실행 개수를 적는다.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/backup/notices.rs src-tauri/src/lib.rs src-tauri/src/backup/versions.rs
git commit -m "fix(backup): time the daily failure notice by the wall clock"
```

---

### Task 3: 충돌 보관 배너는 다른 배너가 끝나면 돌아온다

T5-1.

**Files:**

- Modify: `src/app/docs.ts` (`MemoDoc.setBanner`·`keepConflict`·「닫기」)
- Modify: `src/app/docs.test.ts`, `src/app/session-sync.test.ts`
- Modify: `docs/superpowers/specs/2026-10-07-tote-note-core-design.md` 「외부 변경」 절
- Test: 위 두 테스트 파일

**Interfaces:**

- Consumes: `MemoDoc.conflictKept`, `conflictKeptText`, `sessionTab` (지금 그대로).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

- `docs.test.ts` `the conflict-kept banner comes back once a later banner is settled` — `keepConflict("m1")` 뒤 그 메모에 바깥 변경 충돌을 일으키면 `banner.kind === "conflict"` 이고 `conflictKept` 는 그대로 `{ memoId: "m1" }`. 「디스크 버전」을 고르면 `banner.kind === "info"`, `banner.text === conflictKeptText(<원래 이름>)`. 삭제 배너(「다시 저장」)로도 같은 단언을 한 번 더 한다.
- `docs.test.ts` `only 닫기 ends the conflict-kept banner` — 「닫기」 뒤 `conflictKept === null`, 이어지는 `setBanner(null)` 경로(조용한 다시 읽기)에서도 배너가 돌아오지 않는다.
- `session-sync.test.ts` `keeps conflictKept in the session while another banner is up` — 충돌 배너가 떠 있는 동안 `sessionTab(doc).conflictKept` 가 그대로 있다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm test src/app/docs.test.ts src/app/session-sync.test.ts`
Expected: FAIL(`conflictKept` 가 `null` 이 된다).

- [ ] **Step 3: 구현한다**

`MemoDoc.setBanner`: 정보 배너가 아닌 배너가 와도 `conflictKept` 를 지우지 않는다. `null` 이 오고 `conflictKept` 가 있으면 보관 배너를 다시 세운다. 「닫기」는 `conflictKept` 를 먼저 비운다.

- [ ] **Step 4: 스펙을 고친다**

「외부 변경」 절 충돌 보관 항목 끝에: 그 탭에 다른 배너가 오르면, 그 배너가 끝난 뒤 다시 보인다.

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 6: 커밋**

```bash
git add src/app/docs.ts src/app/docs.test.ts src/app/session-sync.test.ts docs/superpowers/specs/2026-10-07-tote-note-core-design.md
git commit -m "fix(conflict): bring the kept-version banner back after a later banner ends"
```

---

### Task 4: 스파이크 — 창 밖 놓기, 여러 창 시험, 새로 고침 전환

뒤 태스크가 기대는 모르는 것 셋을 잰다. 제품 코드는 바꾸지 않는다. Task 1–3 과 파일이 겹치지 않아 함께 돌려도 된다.

**Files:**

- Modify: `spikes/lab/` (새 모드 `drag`·`reload` — `src-tauri/src/lib.rs`, 프론트엔드 페이지, `README.md` 의 모드 표)
- Create: `spikes/windows/playwright.config.ts`, `spikes/windows/index.html`, `spikes/windows/probe.ts`, `spikes/windows/probe.spec.ts`
- Create: `docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-spike.md`

**재는 것과 판정:**

- **(a1) 탭 바 사이 HTML5 끌어 놓기.** lab 창의 `dragDropEnabled` 를 제품과 같게(켜 둠, 파일 놓기를 받는다) 두고, 같은 웹뷰 안에서 `draggable` 요소를 다른 요소로 끌어 놓을 때 `dragstart`·`dragover`·`drop`·`dragend` 가 오는지. 판정 「됨」/「안 됨」.
- **(a2) 창 밖 놓기.** 같은 요소를 창 밖(바탕 화면)에 놓았을 때 `dragend` 가 오는지, 그때 `dataTransfer.dropEffect === "none"` 인지, `screenX/Y`(또는 `clientX/Y`)가 창 영역 밖 값인지, 창 안에서 Esc 로 취소한 경우와 구별되는지. 같은 것을 포인터 이벤트(`setPointerCapture` 후 창 밖 `pointerup`)로도 본다. 판정 「창 밖 놓기를 구별함」(어느 방법으로) / 「구별 못 함」.
- **(b) 여러 창 시험.** Playwright WebKit 에서 한 `BrowserContext` 의 두 페이지가 ① `BroadcastChannel` 로 메시지를 주고받는지 ② `localStorage` 를 함께 보는지 ③ `window.open("/?window=ws-2")` 가 같은 컨텍스트의 `popup` 으로 잡히는지 ④ 두 페이지가 번갈아 `localStorage` 의 같은 JSON 을 읽고 고쳐 쓸 때(테스트처럼 차례로 움직일 때) 잃는 쓰기가 없는지(각 100번) ⑤ 같은 페이지 안 HTML5 끌어 놓기를 `locator.dragTo` 로 일으킬 수 있는지, 안 되면 `DataTransfer` 핸들을 넣은 `dispatchEvent` 로 되는지. 판정 「허브 됨」/「허브 안 됨」, 그리고 e2e 끌기 방법.
- **(c) 새로 고침 전환.** lab 모드 `reload`: 페이지가 이벤트 `lab://ping` 을 듣고, Rust 가 `WebviewWindow::reload()` 를 부른 뒤 새 페이지가 준비되면 `lab://ping` 을 한 번 보낸다. 받은 횟수(1이어야 한다), 새로 고침 전후 창의 위치·크기, 새로 고침에 걸린 시간을 `results/reload.json` 에. 판정 「새로 고침 됨」/「안 됨」(이벤트가 두 번 오거나 창이 움직이면 안 됨).

- [ ] **Step 1: lab 모드를 만든다**

`drag` 는 사람(또는 computer-use)이 움직이는 수동 모드다: 창에 「탭」 셋과 「탭 바」 둘을 그리고, 모든 끌기·포인터 이벤트를 시각·좌표·`dropEffect`·창 영역과 함께 `results/drag.json` 에 남긴다. 창을 닫으면 끝난다. `reload` 는 자동 모드다(README 「자동 측정」의 규칙을 따른다).

- [ ] **Step 2: (c) 를 잰다**

Run: `cd spikes/lab && pnpm tauri build --debug --no-bundle && mkdir -p results && TOTE_LAB_AUTO=reload perl -e 'alarm shift; exec @ARGV' 60 ./src-tauri/target/debug/lab; cat results/reload.json`
Expected: 결과 파일이 있고 `error-reload.json` 이 없다.

- [ ] **Step 3: (b) 를 잰다**

Run: `TOTE_E2E_PORT=${TOTE_E2E_PORT:-1430} pnpm exec playwright test --config spikes/windows/playwright.config.ts`
Expected: ①–⑤ 각 테스트의 통과·실패가 판정의 근거다(실패도 결과다).

- [ ] **Step 4: (a1)·(a2) 를 잰다 (화면)**

코디네이터에게 「사람이 키보드·마우스를 쓰지 않아야 한다」고 알린 뒤 `TOTE_LAB_MANUAL=drag ./src-tauri/target/debug/lab` 를 띄우고 `orca computer` 로 ① 탭을 다른 탭 바에 놓기 ② 탭을 창 밖에 놓기 ③ 끌다가 Esc 를 각 세 번 한다. computer-use 로 끌기를 할 수 없으면 사람에게 같은 절차를 부탁하고, 그것도 안 되면 「확인 못 함」으로 적는다.

- [ ] **Step 5: 보고서를 쓴다**

판정 넷(각 「됨」/「안 됨」/「확인 못 함」), 근거 수치, 다시 재는 명령, 도구의 한계를 적는다. 「뒤 태스크에 주는 것」 절에 갈래를 그대로 적는다:

- (a1) 됨 → Task 10 은 HTML5 끌어 놓기. 안 됨·확인 못 함 → 포인터 이벤트 끌기(4px 넘게 움직이면 시작).
- (a2) 구별함 → Task 11 이 끌어서 떼어 내기를 더한다. 구별 못 함·확인 못 함 → 메뉴만 두고 Task 13 이 코어 스펙에 「끌기로는 떼어 내지 않는다」를 적는다.
- (b) 허브 됨 → Task 11 이 `FakeHub` 를 만들고 Task 11·12 가 여러 창 e2e 를 쓴다. 안 됨·확인 못 함 → 여러 창 동작은 Rust 단위 테스트와 Task 14·15 스모크로 고정한다.
- (c) 됨 → Task 12 는 `WebviewWindow::reload()`. 안 됨·확인 못 함 → 같은 자리·크기로 새 라벨의 창을 만들고 옛 창을 닫는다.

- [ ] **Step 6: 커밋**

```bash
git add spikes/lab spikes/windows docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-spike.md
git commit -m "docs: spike drag-out, multi-window tests and reload switching"
```

`spikes/lab/results/` 는 커밋하지 않는다(그 디렉터리의 `.gitignore`).

---

### Task 5: 창들이 워크스페이스 하나를 함께 쓴다 (Rust)

소유 구조만 바꾼다. 이 태스크가 끝나도 워크스페이스마다 창은 하나다 — 두 번째 창을 여는 입구(Task 11)가 아직 없다.

**Files:**

- Modify: `src-tauri/src/app/mod.rs` (`Inner`, `OpenWorkspace`, `OpenWindow`, 라벨, `on_batch`, `backup_tick`, `closed`, `siblings`, 제목)
- Modify: `src-tauri/src/app/windows.rs` (`show`, 새 `open_window`, `restore`, 제목 갱신)
- Modify: `src-tauri/src/app/commands.rs` (`workspace_info` 의 `title`, `workspace_items` 의 `windows`, 메모를 바꾸는 명령 뒤 `tote://memos`)
- Modify: `src-tauri/src/app/menu.rs` (포커스된 창), `src-tauri/src/app/requests.rs`
- Modify: `src-tauri/src/appdata.rs` (`LaunchState`)
- Modify: `src-tauri/src/lib.rs` (`start_watching`·`start_backups` 가 라벨 여럿에 보낸다)
- Modify: `src/backend/types.ts`·`tauri.ts`·`fake.ts` (`WorkspaceInfo.title`, `WorkspaceListItem.windows`, `onMemosChanged`), `src/app/controller.ts` (제목, 300ms 모아 다시 읽기)
- Modify: `tests/e2e/memo.spec.ts` 또는 새 `tests/e2e/shared.spec.ts`
- Test: 위 Rust 파일의 `mod tests`, e2e

**Interfaces:**

- Produces (Rust):
  - `AppCore::next_label(&self) -> String` — `"ws-1"`, `"ws-2"`, …
  - `AppCore::workspace_key(path: &Path) -> String` — `"wk-"` + 경로 해시 16자. 감시 대상 이름. (`label_for` 는 걷는다.)
  - `AppCore::register_window(&self, label: &str, path: &Path, opened: Option<Workspace>)` — `opened` 는 그 경로의 첫 창일 때 막 연 워크스페이스.
  - `AppCore::windows_of(&self, path: &Path) -> Vec<String>` (연 순서), `AppCore::front_window_of(&self, path: &Path) -> Option<String>` (최근 포커스), `AppCore::siblings(&self, label: &str) -> Vec<String>`.
  - `AppCore::on_batch(&self, target, batch) -> Vec<(String, OutsideChange)>` — 워크스페이스 변화는 그 창들 전부에.
  - `AppCore::backup_tick(&self, now, only: Option<&HashSet<String>>) -> Vec<(Vec<String>, io::Result<Option<PathBuf>>)>` — 워크스페이스마다 한 번, 그 창 라벨들과 함께. `only` 는 라벨이고, 그 라벨의 워크스페이스를 고른다.
  - `pub fn window_title(name: &str, nth: usize) -> String` — `nth` 는 0부터. `window_title("업무", 0) == "업무"`, `window_title("업무", 1) == "업무 — 2"`.
  - `AppCore::titles_of(&self, path: &Path) -> Vec<(String, String)>` — (라벨, 제목).
  - `windows::open_window(app, path, plan: WindowPlan) -> Result<String, CommandError>` — 언제나 새 창. `pub enum WindowPlan { Restore(usize), Fresh { near: Option<WindowFrame> } }` (Task 6 이 `Restore` 의 배치를, Task 11 이 `Tab` 을 더한다). 이 태스크에서 `Restore(_)` 는 지금처럼 `read_window_frame` 으로 위치만 정한다.
  - `windows::retitle(app: &AppHandle, path: &Path)` — `titles_of(path)` 대로 그 창들의 제목을 붙인다.
  - `windows::show(app, path)` — 그 워크스페이스의 창이 있으면 `front_window_of` 를 앞으로, 없으면 `open_window(…, Restore(0))`. CLI `-w`, 「워크스페이스 열기…」의 고르기, Reopen 이 쓴다.
  - `LaunchState::add_open` 은 중복을 허락하고, `remove_open` 은 한 줄만 지운다. `LaunchState::switch_open(&mut self, from: &Path, to: &Path)` — `from` 의 첫 줄 하나를 제자리에서 `to` 로. `relocate` 는 `openWindows` 의 중복을 지우지 않는다.
  - 이벤트 `tote://memos`(값 없음) — 같은 워크스페이스의 다른 창에.
- Produces (TS): `WorkspaceInfo.title: string`, `WorkspaceListItem.windows: number`(그 워크스페이스를 보이는 창 수), `Backend.onMemosChanged(handler: () => void): void`. 가짜 백엔드는 `memosChanged()`(테스트가 부른다)를 둔다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`app/mod.rs` (테스트 도우미 `open` 은 `next_label` + `register_window` 로 바꾸고, 같은 경로에 두 번째 창을 붙이는 `attach(core, path)` 를 더한다):

- `labels_are_new_for_every_window` — `next_label()` 셋이 `ws-1`·`ws-2`·`ws-3`, 모두 `ws-` 로 시작한다.
- `two_windows_share_one_workspace` — `w1`(워크스페이스와 함께)·`w2`(같은 경로)에서 `Arc::ptr_eq(&core.workspace(w1), &core.workspace(w2))`.
- `the_workspace_closes_with_its_last_window` — `closed(w1)` 뒤 `is_open_path(path)` 는 `true`, `closed(w2)` 뒤 `false`이고 `workspace(w2)` 는 `None`.
- `a_backup_round_takes_a_shared_workspace_once` — `가` 에 창 둘, `나` 에 창 하나. 첫 틱의 결과는 2개, `가` 의 항목은 라벨 둘을 담는다. 스냅샷 폴더는 워크스페이스마다 하나.
- `a_wake_takes_the_workspace_of_the_woken_window` — `only = {w2}` 면 `가` 만 찍는다.
- `a_watch_batch_reaches_every_window_of_its_workspace` — `가` 의 루트에 파일을 만들고 `on_batch(WatchTarget::Workspace(workspace_key(가)), batch)` 는 `w1`·`w2` 두 항목.
- `siblings_are_the_other_windows_of_the_workspace` — `siblings(w1) == [w2]`, 다른 워크스페이스 창은 없다.
- `a_quit_waits_for_every_window_of_a_shared_workspace` — `begin_flush(Quit)` 의 `windows` 는 셋.
- `window_titles_number_the_second_window_on` — `window_title` 두 단언, 그리고 `titles_of(가)` 는 `[(w1, "가"), (w2, "가 — 2")]`, `closed(w1)` 뒤 `[(w2, "가")]`.

`appdata.rs`:

- `open_windows_keep_a_workspace_once_per_window` — `add_open(P)` 두 번이면 `[P, P]`, `remove_open(P)` 한 번이면 `[P]`.
- `relocate_keeps_every_window_of_a_workspace` — `open_windows = [옛, 다른, 옛]` 에서 `relocate(옛, 새)` 는 `[새, 다른, 새]`. `recent` 의 중복 정리는 그대로.
- `switch_open_replaces_one_entry_in_place` — `[A, B, A]` 에서 `switch_open(A, C)` 는 `[C, B, A]`.
- `launch_state_round_trips` 의 단언을 새 규칙으로 고친다.

`commands.rs`: `the_list_counts_each_workspaces_windows` — `workspace_items` 가 `windows` 를 셈 함수로 받아 `가` 는 2, `나` 는 0, 사라진 항목은 0.

e2e `another window's change to the memo list shows here` — 가짜의 `data.memos` 에 메모를 넣고 `memosChanged()` 를 세 번 부르면 `.memo-row` 에 그 메모가 보이고, `listMemos` 는 300ms 안에 한 번만 불린다(가짜의 호출 수로 센다).

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml app appdata commands`
Expected: FAIL(새 함수 없음, `on_batch`·`backup_tick` 의 반환 꼴).

- [ ] **Step 3: 구현한다**

- `Inner` 를 `workspaces: HashMap<PathBuf, OpenWorkspace { workspace: Arc<Mutex<Workspace>> }>` 와 `windows: HashMap<String, OpenWindow { path, pending, serial }>` 로 나눈다(`serial` 은 연 순서). `reserved` 는 경로 → 여는 중인 창의 라벨이라, 같은 폴더를 두 요청이 동시에 열면 둘째 요청은 그 라벨을 받는다.
- 감시는 워크스페이스마다(`workspace_key`) 하나, 그 워크스페이스가 처음 열릴 때 걸고 마지막 창이 떠날 때 푼다. 외부 파일 감시는 지금처럼 창 라벨마다다.
- `start_watching`·`start_backups` 는 받은 라벨들에 각각 보낸다. 백업 실패 알림은 라벨마다 `FailureNotices` 를 지난다.
- 메모 목록을 바꾸는 명령(`create_memo`·`write_memo`·`retitle_memo`·`rename_memo`·`set_memo_language`·`delete_memo`·`import_memo`·`import_file`)이 성공하면 `siblings` 에 `tote://memos`.
- `open_window` 는 창을 만든 뒤 `windows::retitle(app, path)` 로 그 워크스페이스의 창 제목을 모두 다시 붙인다. `closed` 뒤(`on_event` 의 `Destroyed`)에도 부른다.
- `request_backup` 은 워크스페이스를 새로 열었을 때만 부른다(같은 워크스페이스의 둘째 창은 바뀐 것이 없다).
- `menu::on_event` 는 `is_focused()` 인 창을 먼저 고른다.
- 프론트엔드: `document.title = info.title`, `onMemosChanged` 를 300ms 모아 `refreshMemos()`.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/app/mod.rs src-tauri/src/app/windows.rs src-tauri/src/app/commands.rs src-tauri/src/app/menu.rs src-tauri/src/app/requests.rs src-tauri/src/appdata.rs src-tauri/src/lib.rs src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src/app/controller.ts tests/e2e/<바꾼 spec>
git commit -m "refactor(app): let windows share one open workspace"
```

---

### Task 6: 세션 버전 2 — 백엔드가 창들의 배치를 모은다

창 하나·칸 하나로 쓰고 읽는다. 칸 여럿은 Task 9 가 싣는다.

**Files:**

- Modify: `src-tauri/src/session/mod.rs` (`read_layouts`·`write_layouts`·`layout_frame`; `read_session`·`write_session`·`read_window_frame` 은 걷는다)
- Modify: `src-tauri/src/app/mod.rs` (`OpenWorkspace.saved`, `OpenWindow.layout`, `set_layout`, `closed`·`start_quit` 의 세션 규칙)
- Modify: `src-tauri/src/app/windows.rs` (`WindowPlan::Restore(k)` 의 창 위치), `src-tauri/src/app/commands.rs` (`read_window_layout`·`write_window_layout`), `src-tauri/src/lib.rs` (명령 등록)
- Modify: `src/core/session.ts`, `src/app/session-sync.ts`, `src/backend/types.ts`·`tauri.ts`·`fake.ts`
- Modify: `tests/e2e/helpers.ts` (`sessionPane`), `data.session` 을 읽는 e2e(`startup.spec.ts`, `memo.spec.ts`, `watch.spec.ts` 등)
- Test: `session/mod.rs`·`app/mod.rs` 의 `mod tests`, `src/core/session.test.ts`, `src/app/session-sync.test.ts`, e2e

**Interfaces:**

- Produces (Rust, `session` 모듈):

  ```rust
  pub const SESSION_VERSION: u64 = 2;
  /// The window layouts of the file, oldest-opened first; a version 1 file is one window.
  pub fn read_layouts(root: &Path, device_id: &str) -> io::Result<Vec<Value>>;
  pub fn write_layouts(root: &Path, device_id: &str, layouts: &[Value]) -> io::Result<()>;
  pub fn layout_frame(layout: &Value) -> Option<WindowFrame>;
  ```

- Produces (Rust, `AppCore`): `saved_layout(&self, path: &Path, k: usize) -> Option<Value>`(워크스페이스를 처음 열 때 읽어 둔 것), `set_layout(&self, label: &str, layout: Value) -> io::Result<()>`(그 창의 배치를 바꾸고 파일을 다시 쓴다), `layout_of(&self, label: &str) -> Option<Value>`.
- Produces (명령): `read_window_layout(window) -> Option<String>`, `write_window_layout(window, json: String)` — JSON 객체가 아니면 `bad-request`.
- Produces (TS, `src/core/session.ts`):

  ```ts
  export interface PaneSession {
    tabs: SessionTab[];
    activeTab: number;
    width: number;
  }
  export interface WindowSession {
    frame?: WindowFrame;
    panes: PaneSession[];
    focusedPane: number;
  }
  export interface SessionFile {
    version: 2;
    windows: WindowSession[];
  }
  export function parseSessionFile(text: string | null): SessionFile;
  /** Lenient: a tab that does not parse is dropped; at least one pane; widths sum to 1. */
  export function parseWindowSession(value: unknown): WindowSession;
  ```

- Produces (TS, `Backend`): `readWindowLayout(): Promise<string | null>`, `writeWindowLayout(json: string): Promise<void>` (`readSession`·`writeSession` 을 대신한다). 가짜는 `data.session` 에 파일 전체(버전 1 이든 2 든)를 두고 0번 창을 읽고 쓴다.
- Produces (e2e): `sessionPane(page, window = 0, pane = 0): Promise<PaneSession>`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Rust `session/mod.rs`:

- `a_version_1_file_reads_as_one_window` — `{"version":1,"window":{"x":10,"y":20,"width":900,"height":700},"activeTab":1,"tabs":[A,B]}` 는 `[{"frame":{…},"panes":[{"tabs":[A,B],"activeTab":1,"width":1.0}],"focusedPane":0}]`.
- `layouts_round_trip_as_version_2` — `write_layouts([l1, l2])` 뒤 파일의 `version == 2`, `read_layouts == [l1, l2]`.
- `a_file_with_neither_shape_reads_as_no_windows` — `{"version":2}`·`{"tabs":"x"}` 는 `[]`.
- `the_window_frame_is_read_when_usable` 를 `layout_frame` 으로 옮긴다(같은 경계: 너비 200 미만·높이 150 미만·무한대는 `None`).
- `an_unreadable_session_starts_empty_and_is_set_aside` 는 `read_layouts` 로 그대로.

Rust `app/mod.rs`:

- `each_window_writes_into_the_shared_file` — `w1`·`w2`(같은 경로)에서 `set_layout(w1, A)`, `set_layout(w2, B)` 뒤 파일은 `[A, B]`.
- `closing_one_of_two_windows_drops_its_layout` — 이어서 `closed(w1)` 뒤 파일은 `[B]`.
- `closing_the_last_window_keeps_its_layout` — 이어서 `closed(w2)` 뒤 파일은 `[B]`.
- `a_window_that_never_wrote_keeps_its_restored_layout` — 파일 `[A, B]` 로 워크스페이스를 열고 `w1` 은 `Restore(0)`, `w2` 는 `Restore(1)`. `set_layout(w1, A2)` 뒤 파일은 `[A2, B]`.
- `a_quit_keeps_every_layout_in_the_order_it_reopens` — `w1`, `w2` 를 열고 `w1` 에 포커스. `start_quit()` 뒤 `openWindows == [P, P]` 이고 파일은 `[w2 의 배치, w1 의 배치]`(오래 전에 포커스된 것부터). 그 뒤 `closed(w1)`·`closed(w2)` 는 파일을 바꾸지 않는다.

TS `session.test.ts`:

- `parseSessionFile reads a version 1 file as one window with one pane` — 위 Rust 테스트와 같은 입력·기대.
- `parseWindowSession keeps at least one pane` — `{panes: []}` → 빈 칸 하나(`tabs: []`, `activeTab: -1`, `width: 1`).
- `widths are made to sum to 1, equal shares when unusable` — `[2, 2]` → `[0.5, 0.5]`, `[0, -1]` → `[0.5, 0.5]`.
- `focusedPane out of range is 0` 와 칸마다의 `activeTab` 규칙(지금 `parseSession` 과 같다)을 옮긴다. 기존 `parseSession` 테스트는 칸 하나의 경우로 옮긴다.

`session-sync.test.ts`: `build` 가 `WindowSession`(칸 하나, `width: 1`, `focusedPane: 0`, `frame`)을 내고, `restore` 가 칸 0 의 탭을 되살린다.

e2e: `startup.spec.ts`·`memo.spec.ts` 의 버전 1 씨앗은 **그대로 둔다**(옛 형식 읽기를 덮는다). `data.session` 을 읽는 단언은 `sessionPane(page)` 로 바꾼다. 새로 `a restart writes the session as version 2` — 버전 1 씨앗으로 시작해 탭을 하나 더 열고 다시 켜면 `JSON.parse(data.session).version === 2` 이고 탭이 모두 있다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session app && pnpm test src/core/session.test.ts src/app/session-sync.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

- 워크스페이스를 처음 열 때 `read_layouts` 를 한 번 읽어 `OpenWorkspace.saved` 에 둔다. `register_window` 가 `Restore(k)` 면 `saved[k]` 를 그 창의 `layout` 으로 둔다(없으면 `None`). 파일은 언제나 「열린 창들 가운데 `layout` 이 있는 것, `serial` 순」이다.
- 시작 복원은 `restore()` 가 모든 창을 만든 뒤에야 프론트엔드가 돌기 시작하므로(`setup` 은 이벤트 루프 전에 돈다), 첫 쓰기가 아직 열지 않은 창의 배치를 지우지 않는다. 이 사실을 `restore` 의 doc 주석에 적는다.
- `restore()` 는 `openWindows` 를 차례로 돌며 경로마다 몇 번째인지 세어 `open_window(…, Restore(k))`. 창 위치는 `layout_frame(saved[k])` 가 `frame_visible` 일 때만 쓴다.
- `closed(label)`: 종료 중이 아니고 같은 워크스페이스에 창이 남으면 파일을 다시 쓴다(그 창이 빠진다). 마지막 창이면 쓰지 않는다(그 배치가 이미 파일의 전부다).
- `start_quit`: 위 순서로 `openWindows` 와 워크스페이스마다의 파일을 쓴다.
- TS: `SessionSync.build` 는 `WindowSession` 을, `restore` 는 `readWindowLayout()` 을 `parseWindowSession` 으로 읽는다. 가짜의 `readWindowLayout` 은 `parseSessionFile(data.session).windows[0]` 을, `writeWindowLayout` 은 `{version: 2, windows: [layout]}` 을 쓴다.
- `scripts/perf-fixtures.ts` 의 세션은 버전 1 로 둔다 — 측정 경로도 옛 형식 읽기를 거친다. 그 자리에 주석 한 줄.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/session/mod.rs src-tauri/src/app/mod.rs src-tauri/src/app/windows.rs src-tauri/src/app/commands.rs src-tauri/src/lib.rs src/core/session.ts src/core/session.test.ts src/app/session-sync.ts src/app/session-sync.test.ts src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts scripts/perf-fixtures.ts tests/e2e/helpers.ts tests/e2e/<바꾼 spec>
git commit -m "feat(session): keep every window's layout in one version 2 session file"
```

---

### Task 7: 한 메모는 한 자리에 — 자리 등록부

**Files:**

- Create: `src-tauri/src/app/places.rs`
- Modify: `src-tauri/src/app/mod.rs` (`places`, `claim_tabs`, `closed` 이 그 창의 자리를 푼다), `src-tauri/src/app/commands.rs` (`claim_tabs`·`release_tab`), `src-tauri/src/lib.rs`
- Modify: `src/backend/types.ts`·`tauri.ts`·`fake.ts` (`TabRef`, `claimTabs`, `releaseTab`, `onReveal`)
- Modify: `src/app/docs.ts` (`Doc.tabRef`), `src/app/controller.ts` (열기·되살리기·가져오기·ID 바뀜·닫기), `src/app/session-sync.ts` (한 번에 자리 받기)
- Create: `tests/e2e/places.spec.ts`
- Test: `places.rs`·`app/mod.rs` 의 `mod tests`, e2e

**Interfaces:**

- Produces (Rust):

  ```rust
  #[derive(Clone, Debug, PartialEq, Eq, Hash)]
  pub enum TabKey { Memo { workspace: PathBuf, id: String }, External { path: PathBuf } }
  #[derive(Default)]
  pub struct Places { /* key -> owner label */ }
  impl Places {
      /// Err(owner) when another window has it; claiming one's own again is Ok.
      pub fn claim(&mut self, label: &str, key: TabKey) -> Result<(), String>;
      /// Frees `key` only when `label` owns it.
      pub fn release(&mut self, label: &str, key: &TabKey);
      pub fn release_window(&mut self, label: &str);
      pub fn transfer(&mut self, key: &TabKey, from: &str, to: &str) -> bool;
  }
  ```

  ```rust
  /// What the frontend names a tab by; the window's workspace completes a memo's key.
  #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(tag = "kind", rename_all = "camelCase")]
  pub enum TabRef { Memo { id: String }, External { path: PathBuf } }
  ```

  `AppCore::key_for(&self, label: &str, tab: &TabRef) -> Option<TabKey>`, `AppCore::claim_tabs(&self, label: &str, tabs: &[TabRef]) -> Vec<Result<(), String>>`.

  명령: `claim_tabs(window, tabs: Vec<TabRef>, reveal: bool) -> Vec<bool>` — 메모의 `workspace` 는 그 창의 워크스페이스로 채운다. `reveal` 이고 남의 것이면 그 창을 `windows::focus` 하고 `tote://reveal`(값 `TabRef`)을 보낸다. `release_tab(window, tab: TabRef)`.

- Produces (TS): `type TabRef = { kind: "memo"; id: string } | { kind: "external"; path: string }`, `Backend.claimTabs(tabs: TabRef[], reveal: boolean): Promise<boolean[]>`, `Backend.releaseTab(tab: TabRef): Promise<void>`, `Backend.onReveal(handler: (tab: TabRef) => void): void`, `Doc.tabRef: TabRef`(getter). 가짜: `data.places?: Record<string, string>`(열쇠 `memo:<id>`·`external:<path>` → 라벨, 이 페이지의 라벨은 `"ws-1"`), `data.reveals?: { label: string; tab: TabRef }[]`, 테스트용 `reveal(tab: TabRef)`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`places.rs`:

- `the_first_claim_wins` — `claim(w1,k)` Ok, `claim(w2,k)` 는 `Err("w1")`, `claim(w1,k)` 다시 Ok.
- `an_external_file_is_one_place_across_workspaces` — 서로 다른 워크스페이스의 창 둘이 같은 `External` 을 받으면 둘째는 Err.
- `memos_of_two_workspaces_with_the_same_id_do_not_collide`.
- `release_only_frees_the_owners_claim` — `release(w2,k)` 뒤에도 `claim(w2,k)` 는 Err.
- `a_closed_window_frees_its_claims` — `release_window(w1)` 뒤 `claim(w2,k)` Ok.
- `transfer_moves_a_claim_to_the_new_window` — `transfer(k, w1, w2)` 는 `true`, 그 뒤 `claim(w1,k)` 는 `Err("w2")`. 주인이 아닌 `from` 이면 `false`.

`app/mod.rs` `closing_a_window_frees_its_places` — `w1` 이 자리를 받고 `closed(w1)` 뒤 `w2` 가 같은 열쇠를 받는다.

e2e `places.spec.ts`:

- `a file open in another window is revealed there, not opened here` — `places: {"external:/tmp/a.sh": "ws-9"}` 로 시작해 가짜 대기열에 `/tmp/a.sh` 열기를 넣고 `poke()`. 탭은 늘지 않고 `data.reveals` 는 `[{label: "ws-9", tab: {kind: "external", path: "/tmp/a.sh"}}]`.
- `a restored tab open elsewhere is left out` — 세션 탭 둘 중 하나가 `ws-9` 의 것이면 탭은 하나만, `readMemo` 호출 수도 그 하나뿐.
- `a reveal activates the tab` — 탭 둘에서 `reveal({kind:"memo", id: 첫째})` 뒤 첫째가 활성이다.
- `closing a tab gives up its place` — 닫은 뒤 `data.places` 에 그 열쇠가 없다.
- `importing an external file moves its place to the memo` — 가져온 뒤 `external:` 열쇠는 없고 `memo:<새 ID>` 가 있다.
- `a memo saved under a new ID keeps its place` — 저장이 원래 파일을 못 찾아 새 메모가 된 경우(기존 복구 테스트의 씨앗), 새 ID 의 열쇠가 있고 옛 것은 없다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml places app && pnpm test:e2e tests/e2e/places.spec.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

- 탭을 새로 만드는 모든 자리(`openMemo`, `openExternal`, `newMemo`, 세션 되살리기, 대기열 열기, 끌어 놓은 파일)가 먼저 같은 창의 탭을 찾고, 없으면 `claimTabs([ref], true)` 를 받은 뒤 만든다. `false` 면 아무것도 만들지 않는다(백엔드가 이미 그 창을 앞으로 가져왔다).
- 세션 되살리기는 탭 전부를 `claimTabs(refs, false)` 한 번으로 받는다(탭 50개 복원이 IPC 50번이 되지 않게).
- 탭 닫기는 `releaseTab`. 가져오기와 ID 바뀜(`changed(doc, "info")` 에서 이전 ID 와 다를 때)은 옛 것을 풀고 새 것을 받는다.
- `onReveal` 은 그 탭을 활성화한다(Task 9 이후에는 그 칸에 포커스를 준다).

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/app/places.rs src-tauri/src/app/mod.rs src-tauri/src/app/commands.rs src-tauri/src/lib.rs src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src/app/docs.ts src/app/controller.ts src/app/session-sync.ts tests/e2e/places.spec.ts
git commit -m "feat(places): open a memo or file in one place across every window"
```

---

### Task 8: 컨트롤러를 창과 칸으로 나눈다 (칸은 아직 하나)

동작은 바꾸지 않는 재배치다. 모든 기존 테스트가 그대로 통과해야 한다.

**Files:**

- Create: `src/app/pane.ts`
- Modify: `src/app/controller.ts`, `src/app/docs.ts` (`DocHost.view` → `viewOf`), `src/app/session-sync.ts`, `src/styles.css`
- Modify: `src/app/docs.test.ts` (가짜 호스트)
- Modify: `tests/e2e/startup.spec.ts` (구조 단언 하나)
- Test: 기존 전부

**Interfaces:**

- Produces:
  - `class Pane` — 칸 하나. 필드 `id: string`, `view: EditorView`, `tabs: Tabs`, `surface: Surface`, `tabBar: TabBar`, `el: HTMLElement`(`.pane` = 탭 바 + 편집 영역). 지금 컨트롤러의 `activate`·`show`·`showEmpty`·`capture`·`renderTabs`·`openViewer`·`openLargeText`·`closePanel`·`showReloaded`·`largeText` 가 칸으로 옮긴다. 칸이 창에 바라는 것은 `PaneHost` 인터페이스(레지스트리·백엔드·테마·하이라이트·상태 표시줄 갱신·세션 예약·`mark`) 하나로 받는다.
  - `AppController.panes: Pane[]`, `AppController.focused: Pane`, 호환용 `get view(): EditorView`(포커스 칸의 것), `get largeText()`(포커스 칸의 것). e2e 가 쓰는 `__tote.app.view`·`largeText`·`flushAll` 은 그대로 돈다.
  - `DocHost.viewOf(doc: Doc): Pick<EditorView, "state" | "dispatch">` — 그 문서를 보이는 칸의 편집기.
  - DOM: `main.main > .panes > .pane > (.tabbar, .surface)` 와 `.statusbar`. 기존 셀렉터(`.tabbar`, `.tab`, `.surface`, `.cm-editor`)는 그대로 찾힌다.

- [ ] **Step 1: 구조 단언을 쓴다**

`startup.spec.ts` `the window has one pane holding the tab bar and the editor` — `.panes > .pane` 가 1개이고 그 안에 `.tabbar` 와 `.cm-editor` 가 있다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm test:e2e tests/e2e/startup.spec.ts`
Expected: FAIL(`.pane` 없음).

- [ ] **Step 3: 옮긴다**

창에 남는 것: 사이드바·메모 목록·검색 패널, 상태 표시줄, 메뉴, 세션(`SessionSync`), 자리, 레지스트리·테마·하이라이트 클라이언트, 백엔드 구독. `writes`(`WriteScheduler`)는 창에 하나다. 칸이 하나뿐이므로 `focused === panes[0]`. 하이라이트의 `setVisible` 은 칸들의 활성 문서를 모아 넘긴다(지금은 하나).

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수가 이 태스크 전과 같거나 하나 많다(구조 단언).

- [ ] **Step 5: 커밋**

```bash
git add src/app/pane.ts src/app/controller.ts src/app/docs.ts src/app/docs.test.ts src/app/session-sync.ts src/styles.css tests/e2e/startup.spec.ts
git commit -m "refactor(app): split the window controller from its editor pane"
```

---

### Task 9: 칸 나누기 — ⌘\, 칸 닫기, 너비, 포커스, 조합 확정

**Files:**

- Create: `src/app/layout.ts`, `src/app/layout.test.ts`, `src/editor/compose.ts`, `src/editor/compose.test.ts`
- Modify: `src/app/controller.ts`, `src/app/pane.ts`, `src/app/session-sync.ts`, `src/styles.css` (칸 너비, 경계, 포커스 칸 표시, 빈 칸)
- Modify: `src-tauri/src/app/menu.rs` (「보기」 메뉴: `split-pane` `칸 나누기` `CmdOrCtrl+\`, `focus-pane-left` `왼쪽 칸으로` `Alt+CmdOrCtrl+Left`, `focus-pane-right` `오른쪽 칸으로` `Alt+CmdOrCtrl+Right`)
- Create: `tests/e2e/panes.spec.ts`
- Test: 위 테스트 파일들

**Interfaces:**

- Produces (`src/app/layout.ts`, 너비는 합 1 인 비율 배열):

  ```ts
  export const MIN_PANE_PX = 320;
  export function canSplit(widths: number[], at: number, areaPx: number): boolean;
  /** Pane `at` gives the right half of its width to a new pane inserted at `at + 1`. */
  export function split(widths: number[], at: number): number[];
  /** Pane `at`'s width goes to its left neighbour, the right one when it is leftmost. */
  export function remove(widths: number[], at: number): number[];
  /** Moves the boundary after pane `boundary` by `dxPx`; both sides stay at MIN_PANE_PX or more. */
  export function resize(
    widths: number[],
    boundary: number,
    dxPx: number,
    areaPx: number,
  ): number[];
  export function normalize(widths: number[]): number[];
  ```

- Produces (`src/editor/compose.ts`): `export function settleComposition(view: Pick<EditorView, "composing" | "contentDOM">, timeoutMs = 150): Promise<void>` — 조합 중이 아니면 바로 끝난다. 조합 중이면 `contentDOM.blur()` 뒤 `compositionend` 나 시간 초과를 기다린다.
- Produces (컨트롤러): `splitPane(): Promise<void>`, `focusPane(step: -1 | 1): Promise<void>`, `closePane(pane: Pane): void`. `SessionSync` 가 칸 여럿을 쓰고 되살린다.

- [ ] **Step 1: 실패하는 단위 테스트를 쓴다**

`layout.test.ts`:

- `split halves the pane and puts the new one right of it` — `split([1], 0)` → `[0.5, 0.5]`, `split([0.5, 0.5], 0)` → `[0.25, 0.25, 0.5]`.
- `canSplit needs MIN_PANE_PX on both halves` — `canSplit([1], 0, 639)` false, `canSplit([1], 0, 640)` true, `canSplit([0.25, 0.75], 0, 2000)` false(500/2 < 320).
- `remove gives the width to the left neighbour, the right one when leftmost` — `remove([0.25, 0.25, 0.5], 1)` → `[0.5, 0.5]`, `remove([0.25, 0.25, 0.5], 0)` → `[0.5, 0.5]`, `remove([1], 0)` → `[1]`.
- `resize clamps both sides to MIN_PANE_PX` — `resize([0.5, 0.5], 0, 1000, 1000)` → `[0.68, 0.32]`, `resize([0.5, 0.5], 0, -1000, 1000)` → `[0.32, 0.68]`.
- `widths keep their ratios in a window too narrow for them` — `normalize([0.2, 0.3, 0.5])` 은 그대로, `normalize([2, 2])` → `[0.5, 0.5]`, `normalize([0, NaN])` → `[0.5, 0.5]`. (Review Focus 5)

`compose.test.ts` (node 의 `EventTarget` 으로 가짜 `contentDOM` 을 만든다):

- `returns at once when nothing is composing` — `blur` 를 부르지 않는다.
- `blurs and waits for compositionend` — `composing: true` 면 `blur` 한 번, `compositionend` 를 보내기 전에는 끝나지 않고 보낸 뒤 끝난다.
- `gives up after the timeout` — 가짜 타이머로 150ms 뒤 끝난다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm test src/app/layout.test.ts src/editor/compose.test.ts`
Expected: FAIL(모듈 없음).

- [ ] **Step 3: 순수 함수를 구현한다**

시그니처와 위 단언대로. 소수 오차는 `toBeCloseTo` 로 본다.

- [ ] **Step 4: 실패하는 e2e 를 쓴다** (`panes.spec.ts`, 메뉴는 `menu(page, id)`)

- `⌘\ moves the active tab into a new pane on the right` — 탭 둘에서 `split-pane` 뒤 `.pane` 둘, 둘째 칸에 활성 탭이 있고 포커스 칸이다(`.pane.focused`), 첫째 칸에 나머지 탭.
- `⌘\ with one tab opens an empty pane and focuses it` — 둘째 칸에 `빈 칸입니다. 메모 목록에서 메모를 열거나 ⌘N 을 누르세요`.
- `⌘\ in a narrow window says so and does nothing` — 뷰포트를 편집 영역이 640px 미만이 되게 줄이고 `split-pane` 뒤 칸 하나, 상태 표시줄 `창이 좁아 나눌 수 없습니다`. (Review Focus 5)
- `closing the last tab of a pane closes the pane` — 그 칸의 너비는 왼쪽 이웃에게, 포커스도.
- `⌘W on an empty pane closes it; the only pane stays` — 칸이 하나뿐이고 탭이 없으면 `close-tab` 은 지금처럼 창 닫기(가짜의 `windowClosed`).
- `the sidebar opens a memo in the focused pane`.
- `⌥⌘→ and ⌥⌘← move the focus and the status bar follows` — 상태 표시줄의 언어·줄 위치가 포커스 칸의 활성 탭 것이다.
- `tab cycling stays inside the focused pane`.
- `a memo already open in another pane is focused there, not opened twice`.
- `leaving a pane retitles its memo` — 제목 자동 생성 대상 메모의 첫 줄을 친 뒤 `focus-pane-left` 하면 파일 이름이 바뀐다(`memoTextByFile`).
- `each pane keeps its own banner and preview mode`.
- `dragging the divider resizes and stops at 320px`.
- `the panes, their widths and the focused pane come back after a restart` — 다시 읽기(`page.reload()`) 뒤 같다. `sessionPane(page, 0, 1)` 이 둘째 칸이다.
- `a session listing one memo in two panes restores it once` — 씨앗 세션(버전 2)이 같은 메모를 두 칸에 두면 앞 칸에만 있다. (Review Focus 3)
- `a composition in progress lands in its own pane before the focus moves` — 첫 칸 편집기에 `compositionstart`·`compositionupdate`(`가`)를 보내고 `focus-pane-right` 메뉴를 보낸 뒤 100ms 안에 `compositionend`·`input` 을 보낸다. 첫 칸 문서에 `가` 가 있고, 둘째 칸 문서는 그대로이고, 포커스는 둘째 칸이다. 기존 조합 e2e(`tests/e2e/editor.spec.ts` 「composition-path Hangul at three cursors lands at every cursor」)의 이벤트 보내기 방식을 쓴다. (Review Focus 1)

- [ ] **Step 5: 실패를 확인한다**

Run: `pnpm test:e2e tests/e2e/panes.spec.ts`
Expected: FAIL.

- [ ] **Step 6: 구현한다**

- 칸의 `mousedown`(capture)이 그 칸에 포커스를 준다. 포커스가 다른 칸으로 가면 `settleComposition(이전 칸.view)` 뒤 이전 칸의 활성 문서 `leave()`(제목 자동 생성의 「탭이 포커스를 잃을 때」).
- ⌘\ 는 `settleComposition` 뒤 `canSplit` 을 보고, 탭이 둘 이상이면 활성 탭을 새 칸으로 옮긴다(옮기는 쪽 `capture` → `tabs.remove` → 새 칸 `insertAfterActive` → `activate`). 하나뿐이면 빈 칸을 만든다.
- 칸 경계는 `pointerdown` + `setPointerCapture` 로 끌고 `resize` 로 계산한다. 너비는 CSS `flex-basis` 비율이다.
- 하이라이트 `setVisible` 은 모든 칸의 활성 문서. 세션 예약(1초)은 칸 추가·닫기·너비·포커스 변경에도 건다.
- `onReveal` 은 그 탭이 있는 칸에 포커스를 주고 활성화한다.

- [ ] **Step 7: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 8: 커밋**

```bash
git add src/app/layout.ts src/app/layout.test.ts src/editor/compose.ts src/editor/compose.test.ts src/app/controller.ts src/app/pane.ts src/app/session-sync.ts src/styles.css src-tauri/src/app/menu.rs tests/e2e/panes.spec.ts
git commit -m "feat(panes): split the editor area into side-by-side panes"
```

---

### Task 10: 탭을 끌어 칸 사이로 옮긴다

**갈래:** 스파이크 (a1) 이 「됨」이면 HTML5 끌어 놓기(`draggable`, `dragover`, `drop`), 아니면 포인터 이벤트 끌기(4px 넘게 움직이면 시작, 놓는 자리는 `document.elementsFromPoint`). e2e 의 끌기 방법은 스파이크 (b) ⑤ 의 판정을 따른다.

**Files:**

- Modify: `src/ui/tab-bar.ts` (끌기, `dropIndex`), `src/app/pane.ts`, `src/app/controller.ts` (`moveTab`), `src/styles.css` (놓을 자리 표시, 오른쪽 가장자리 영역)
- Create: `src/ui/tab-bar.test.ts`, `tests/e2e/pane-drag.spec.ts`
- Test: 위 둘

**Interfaces:**

- Consumes: `canSplit`, `split`, `remove` (Task 9), `settleComposition` (Task 9).
- Produces:
  - `export function dropIndex(tabs: { left: number; width: number }[], x: number): number` — 탭 중앙보다 왼쪽이면 그 앞.
  - `AppController.moveTab(doc: Doc, to: Pane, index: number): Promise<void>`, `AppController.moveTabToNewPane(doc: Doc): Promise<void>` — 오른쪽 가장자리(편집 영역 오른쪽 **48px**)에 놓으면 맨 오른쪽 칸 오른쪽에 새 칸.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tab-bar.test.ts` `dropIndex`: 탭 셋(`left` 0·100·200, `width` 100)에서 `x = 10` → 0, `x = 60` → 1, `x = 260` → 3, 빈 목록 → 0.

`pane-drag.spec.ts`:

- `dragging a tab onto another pane's tab bar moves it there` — 놓은 자리 순서대로 들어가고 활성이 된다.
- `dropping on the right edge makes a new pane`.
- `dragging the last tab out closes its pane`.
- `a moved memo keeps its unsaved text and its undo` — 글을 친 직후(저장 전) 옮기고 새 칸에서 ⌘Z 가 그 글을 되돌린다.
- `a drop that would split a narrow window does nothing and says so` — `창이 좁아 나눌 수 없습니다`.
- `a file dropped from Finder still opens as a tab` — 가짜의 `dropFiles` 는 지금처럼 탭을 연다(탭 끌기가 파일 놓기를 가로채지 않는다).

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm test src/ui/tab-bar.test.ts && pnpm test:e2e tests/e2e/pane-drag.spec.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

옮기기 전에 `settleComposition`. 같은 창 안이라 저장하지 않는다(`Doc` 이 그대로 옮겨 간다). 옮긴 뒤 빈 칸이 되면 `closePane`(칸이 하나뿐이면 남긴다). 세션 예약.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 5: 커밋**

```bash
git add src/ui/tab-bar.ts src/ui/tab-bar.test.ts src/app/pane.ts src/app/controller.ts src/styles.css tests/e2e/pane-drag.spec.ts
git commit -m "feat(panes): drag a tab to another pane or to a new one"
```

---

### Task 11: 새 창과 탭 떼어 내기

**갈래:** 스파이크 (b) 가 「허브 됨」이면 Step 1 의 `FakeHub` 와 여러 창 e2e 를 한다. 아니면 그 둘을 빼고 같은 동작을 Rust 테스트와 Task 14·15 스모크 항목으로 고정한다. 스파이크 (a2) 가 「구별함」이면 Step 5 의 끌어서 떼어 내기를 한다. 아니면 뺀다.

**Files:**

- Modify: `src-tauri/src/app/windows.rs` (`WindowPlan::Tab`, `near_frame`), `src-tauri/src/app/mod.rs` (`adopt_tab`), `src-tauri/src/app/commands.rs` (`tear_off_tab`), `src-tauri/src/app/menu.rs` (「파일」 `new-window` `새 창` `Alt+CmdOrCtrl+N`, 「윈도우」 `move-tab-to-new-window` `탭을 새 창으로 옮기기`), `src-tauri/src/lib.rs`
- Modify: `src/backend/types.ts`·`tauri.ts`·`fake.ts` (`tearOffTab`, `showTabMenu`), `src/app/controller.ts` (`tearOff`), `src/ui/tab-bar.ts` (`contextmenu`)
- (허브 됨) Create: `src/backend/fake-hub.ts`, `tests/e2e/windows.spec.ts`; Modify: `src/main.ts`, `tests/e2e/helpers.ts` (`startWindows`)
- Create: `tests/e2e/tear-off.spec.ts`
- Modify: `src-tauri/capabilities/default.json` — 네이티브 팝업 메뉴에 `core:default` 밖의 권한이 필요할 때만(창은 `ws-*` 그대로)
- Test: Rust `mod tests`, e2e

**Interfaces:**

- Consumes: `Places::transfer` (Task 7), `set_layout`·`layout_of` (Task 6), `sessionTab` (지금 것), `settleComposition` (Task 9).
- Produces (Rust):
  - `WindowPlan::Tab { tab: Value, near: Option<WindowFrame> }` — 처음 배치는 `{ "panes": [{ "tabs": [tab], "activeTab": 0, "width": 1 }], "focusedPane": 0 }`.
  - `pub fn near_frame(source: WindowFrame) -> WindowFrame` — `x + 24`, `y + 24`, 크기 그대로. 쓰기 전에 `frame_visible` 을 본다.
  - `AppCore::adopt_tab(&self, new_label: &str, from: &str, tab: Value, key: TabKey) -> io::Result<()>` — 새 창의 `layout` 을 세우고 파일을 다시 쓰고 자리를 옮긴다. 창을 만들기 **전에** 부른다.
  - 명령 `tear_off_tab(window, tab: String, tab_ref: TabRef)` — JSON 객체가 아니면 `bad-request`.
  - 「새 창」은 Rust 가 메뉴에서 바로 처리한다: 포커스된 창의 워크스페이스로 `open_window(…, Fresh { near })`.
- Produces (TS): `Backend.tearOffTab(tab: string, ref: TabRef): Promise<void>`, `Backend.showTabMenu(items: { id: string; text: string }[]): Promise<string | null>`, `AppController.tearOff(doc: Doc): Promise<boolean>`. 가짜: `data.tornOff?: { tab: SessionTab }[]`, `data.tabMenuPick?: string | null`.
- (허브 됨) Produces: `class FakeHub` — 같은 브라우저 컨텍스트의 페이지들이 `localStorage` 의 데이터와 `BroadcastChannel("tote-fake")` 의 이벤트(`flush`, `memos`, `reveal`, `outside`, `workspaces`)를 나눈다. 페이지 라벨은 URL `?window=ws-<n>`, 새 창은 `window.open("/?window=ws-<n>")`. `FakeBackend.fromHub(label)`. 시험 도우미 `startWindows(context, patch)` → 첫 페이지, `nextWindow(page)` → `popup` 페이지.

- [ ] **Step 1: (허브 됨) `FakeHub` 를 만든다**

가짜의 데이터는 그대로이고, 저장소와 이벤트만 허브를 지난다. 기존 테스트는 `?window=` 가 없으면 지금처럼 `sessionStorage` 를 쓴다(바뀌지 않는다). 허브의 자리 등록부·세션 모으기는 Rust 와 같은 규칙(Task 6·7)을 따른다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

Rust:

- `windows.rs` `a_new_window_sits_near_its_source` — `near_frame({x: 100, y: 50, width: 900, height: 700})` 은 `{124, 74, 900, 700}`.
- `app/mod.rs` `a_torn_off_tab_is_in_the_session_before_its_window_loads` — `w1` 이 탭 자리를 갖고 `adopt_tab(w2, w1, tab, key)` 뒤(새 창은 아직 아무것도 쓰지 않았다) 세션 파일의 창 배치 가운데 하나가 그 탭 하나를 담고, `Places` 의 주인은 `w2`. 이어 `start_quit()` 해도 그 배치가 남는다. (Review Focus 2)
- `app/mod.rs` `a_tear_off_of_a_tab_the_window_does_not_own_is_refused` — 주인이 아닌 창의 `adopt_tab` 은 `Err`, 파일·자리는 그대로.

e2e `tear-off.spec.ts` (한 페이지, 가짜):

- `탭을 새 창으로 옮기기 saves the memo first and hands the tab over` — 글을 친 직후 메뉴 `move-tab-to-new-window`. `memoText` 가 친 글, `data.tornOff[0].tab.memoId` 가 그 메모, 이 창에서 탭이 사라진다.
- `a tab whose save fails stays with 저장 실패` — `failWrites: 1` 이면 탭이 남고 `.tab.failed`, 상태 표시줄 `저장하지 못해 새 창으로 옮기지 않았습니다`, `data.tornOff` 없음.
- `an external file's unsaved edits go with it as a draft` — `data.drafts[path].data` 가 친 글.
- `a tab never shown moves without being read` — 세션으로 되살린 비활성 탭을 옮기면 `reads[id]` 가 없다.
- `the tab's context menu offers 탭을 새 창으로 옮기기` — `data.tabMenuPick = "move-tab-to-new-window"` 로 두고 탭에 오른쪽 클릭하면 옮겨진다.
- `a viewer tab gives back its file token before it goes` — 미디어 탭을 옮기면 그 소유자의 토큰이 회수된다(`data.tokens`).

(허브 됨) e2e `windows.spec.ts`:

- `a torn-off tab opens in the new window with its text`.
- `⌥⌘N opens an empty window of the same workspace` — 가짜가 Rust 몫(새 창 열기)을 흉내 낸다.
- `a memo made in one window appears in the other's list`.
- `opening a memo shown in the other window brings that window forward` — 그 창에서 탭이 활성이 되고, 허브의 `focused` 기록이 그 창이다.
- `two windows of one workspace come back after a restart` — 두 페이지를 닫고 다시 열면 각자의 배치.
- `closing one of two windows drops its layout; closing the last keeps it`.

- [ ] **Step 3: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows app && pnpm test:e2e tests/e2e/tear-off.spec.ts` (허브 됨이면 `tests/e2e/windows.spec.ts` 도)
Expected: FAIL.

- [ ] **Step 4: 구현한다**

`tearOff(doc)`: `settleComposition` → 메모면 `saveNow()`, 외부 파일이면 수정분 즉시 보관 → `saveFailed` 거나 보관이 실패했으면 문구를 띄우고 `false` → `capture(doc)` 후 `tearOffTab(JSON.stringify(sessionTab(doc, deviceId)), doc.tabRef)` → 성공하면 그 탭을 닫기 절차 없이 칸에서 뗀다(패널을 닫아 토큰을 회수하고, 외부 파일 감시를 풀고, 하이라이트를 버리고, 빈 새 메모라도 지우지 않는다). 칸이 비면 `closePane`. Rust `tear_off_tab` 은 `near_frame(그 창의 frame)` 으로 `open_window(…, Tab { … })` — 그 안에서 창을 만들기 전에 `adopt_tab`.

- [ ] **Step 5: (구별함) 끌어서 떼어 내기**

스파이크 (a2) 가 고른 방법으로 창 밖 놓기를 알아보면 `tearOff` 를 부르고, 새 창은 놓은 자리(화면 좌표)에 왼쪽 위를 둔다. e2e: 판정에 쓴 이벤트(예: 창 밖 좌표의 `dragend`, `dropEffect: "none"`)를 보내면 `data.tornOff` 가 생기고, 창 안 Esc 취소에 해당하는 이벤트로는 생기지 않는다.

- [ ] **Step 6: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 7: 커밋**

```bash
git add src-tauri/src/app/windows.rs src-tauri/src/app/mod.rs src-tauri/src/app/commands.rs src-tauri/src/app/menu.rs src-tauri/src/lib.rs src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src/app/controller.ts src/ui/tab-bar.ts tests/e2e/tear-off.spec.ts
# 허브 됨: src/backend/fake-hub.ts src/main.ts tests/e2e/helpers.ts tests/e2e/windows.spec.ts 도
# 권한을 바꿨으면: src-tauri/capabilities/default.json 도
git commit -m "feat(windows): open a new window of the workspace and move a tab into one"
```

---

### Task 12: 워크스페이스 띠와 전환

**갈래:** 스파이크 (c) 가 「새로 고침 됨」이면 전환의 마지막은 `WebviewWindow::reload()`. 아니면 같은 자리·크기로 새 라벨의 창을 `Restore(0)` 으로 열고 옛 창을 `destroy` 한다(라벨이 바뀌므로 `switch_window` 대신 「닫고 열기」로 장부를 맞춘다 — 테스트 이름은 그대로 두고 단언의 라벨만 새 것을 본다). 스파이크 (b) 가 「허브 됨」이면 Step 1 의 허브 e2e 를 한다.

**Files:**

- Create: `src/ui/rail.ts`, `src/ui/rail.test.ts`, `tests/e2e/rail.spec.ts`
- Modify: `src/app/controller.ts` (띠, ⌃1–⌃9, `+`, 전환, 새 워크스페이스, `onFlush` 의 조합 확정, `switch-click` 표시), `src/styles.css` (띠 48px, 강조, 점)
- Modify: `src-tauri/src/app/flush.rs` (`FlushGoal::SwitchWorkspace`, 창 라운드 하나), `src-tauri/src/app/lifecycle.rs` (전환의 `finish`, 질문 문구, 표의 행), `src-tauri/src/app/windows.rs` (`switch`), `src-tauri/src/app/mod.rs` (`switch_window`), `src-tauri/src/app/commands.rs` (`switch_workspace`, `create_workspace` 가 경로를 돌려준다), `src-tauri/src/lib.rs`
- Modify: `src/backend/types.ts`·`tauri.ts`·`fake.ts` (`switchWorkspace`, `createWorkspace` 반환, `onWorkspacesChanged`, 가짜의 `otherWorkspaces`)
- Test: Rust `mod tests`, `rail.test.ts`, e2e

**Interfaces:**

- Consumes: `LaunchState::switch_open` (Task 5), `saved_layout`·`set_layout` (Task 6), `Places::release_window` (Task 7), `steps_for_answer` (Task 1), `settleComposition` (Task 9).
- Produces (Rust):
  - `FlushGoal::SwitchWorkspace { label: String, to: PathBuf }`, `FlushGoal::window(&self) -> Option<&str>` — 닫기·전환이 창 라운드다. 한 창에 창 라운드는 하나만(둘째는 `AlreadyRunning`). 종료는 닫기와 똑같이 창 라운드에 붙는다.
  - `AppCore::switch_window(&self, label: &str, to: &Path, opened: Workspace) -> io::Result<()>` — 떠나는 워크스페이스에서는 창 닫기와 같은 세션 규칙(마지막이면 그 배치가 남고 아니면 빠진다), 그 창의 자리·뷰어 토큰·검색·외부 파일 감시를 푼다. 들어가는 워크스페이스에는 `saved[0]` 을 그 창의 배치로. `LaunchState::switch_open`. 마지막 창이 떠난 워크스페이스는 닫는다.
  - `AppCore::prepare_switch(&self, label: &str, to: &Path) -> Result<Workspace, WorkspaceError>` — 대상을 연다. 실패하면 아무것도 바꾸지 않는다. `finish` 가 이것을 부른 뒤 `switch_window` 를 부른다.
  - `windows::switch(app, label, to) -> Result<Switched, CommandError>`, `pub enum Switched { Focused, Switching }` — 대상에 창이 있으면 `front_window_of` 를 앞으로(`Focused`, 이 창은 그대로). 아니면 `Workspace::is_workspace(to)` 를 확인하고 전환 라운드를 연다(`Switching`).
  - `finish(SwitchWorkspace)`: `Workspace::open(to)` → 실패하면 그 창의 대기열에 `워크스페이스를 열지 못했습니다: <이유>` 알림, 창은 그대로 → 성공하면 `switch_window`, 두 워크스페이스의 창 제목 다시 붙이기, 모든 창에 `tote://workspaces`, 새로 연 워크스페이스의 백업 깨우기, 그리고 갈래의 마지막(새로 고침 또는 새 창).
  - 질문의 「그래도」 단추는 `그래도 바꾸기`.
  - 명령 `switch_workspace(window, path: String) -> "focused" | "switching"`, `create_workspace(name) -> PathBuf`(창을 열지 않는다).
- Produces (TS):
  - `src/ui/rail.ts`: `interface RailItem { name: string; path: string; label: string; current: boolean; dot: boolean }`, `export function railItems(list: WorkspaceListItem[], currentPath: string): RailItem[]`, `export function railShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">): number | null` — ⌃1 → 0 … ⌃9 → 8, 그 밖은 `null`. `class WorkspaceRail { el; render(items: RailItem[]): void }`(항목 `title` 은 이름 전체, 맨 아래 `+`).
  - `Backend.switchWorkspace(path: string): Promise<"focused" | "switching">`, `Backend.createWorkspace(name: string): Promise<string>`, `Backend.onWorkspacesChanged(handler: () => void): void`.
  - 가짜: `data.otherWorkspaces?: Record<string, { workspace: WorkspaceInfo; memos: Record<string, FakeMemo>; session: string | null }>`, `data.focusedWorkspace?: string`(「앞으로」 기록). 가짜의 `switchWorkspace` 는 대상의 `windows > 0` 이면 `"focused"`, 아니면 flush 를 요청해 `flushDone` 을 받은 뒤 지금 워크스페이스와 대상을 맞바꿔 저장하고 `location.reload()`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Rust:

- `flush.rs` `one_window_runs_one_window_round_at_a_time` — `w1` 의 전환 라운드가 도는 동안 `begin(CloseWindow("w1"))` 는 `AlreadyRunning`, `begin(CloseWindow("w2"))` 는 `Started`.
- `flush.rs` `a_quit_joins_a_switch_like_a_close` — Task 1 의 N3 테스트 둘(쓰는 중·묻는 중)을 전환으로.
- `lifecycle.rs` 표에 전환 네 행을 더한다(닫기 행과 같은 꼴, `Finish(SwitchWorkspace{…})`).
- `app/mod.rs` `switching_the_last_window_keeps_the_left_layout` — `w1` 만 `가` 를 보이고 `set_layout(w1, A1)`. `나` 의 파일은 `[B0]`. `switch_window(w1, 나, …)` 뒤 `가` 의 파일은 `[A1]`, `workspace(w1)` 은 `나`, `layout_of(w1) == B0`, `is_open_path(가) == false`, `openWindows` 에서 `가` 가 `나` 로 제자리 바뀜, `w1` 의 자리는 모두 풀림.
- `app/mod.rs` `switching_away_from_a_shared_workspace_drops_the_left_layout` — `가` 에 `w1`·`w2`. `w1` 이 떠나면 `가` 의 파일은 `[w2 의 배치]`.
- `app/mod.rs` `switching_to_a_vanished_workspace_leaves_the_window_where_it_was` — `windows` 의 열기 단계를 흉내 내는 `AppCore::prepare_switch(label, to) -> Result<Workspace, WorkspaceError>` 가 지운 폴더에 `Err`, 이후 `workspace(w1)` 은 여전히 `가`, 파일·자리·`openWindows` 그대로. (Review Focus 4)

`rail.test.ts`:

- `items are sorted by name, NFD names included, missing ones left out` — `["업무", "개인".normalize("NFD"), "가계부"]` + 사라진 `"옛"` → 이름 `["가계부", "개인", "업무"]`.
- `the label is the first two characters` — `"업무 메모"` → `"업무"`, `"a"` → `"a"`, `"👩‍💻노트"` → `"👩‍💻노"`.
- `the current workspace is marked and other windows get a dot` — 지금 창의 것 `windows: 1` → `current: true, dot: false`; `windows: 2` → `dot: true`; 다른 것 `windows: 1` → `current: false, dot: true`; `windows: 0` → 점 없음.
- `railShortcut` — `{ctrlKey: true, code: "Digit3"}` → 2, ⌘ 이나 ⌥ 이나 ⇧ 이 함께면 `null`, `Digit0` → `null`.

e2e `rail.spec.ts` (`otherWorkspaces` 로 워크스페이스 둘 이상):

- `the rail lists the workspaces by name with the current one marked` — `.rail` 폭 48px, 항목의 `title` 이 이름 전체.
- `clicking a workspace switches this window to it and restores its session` — 새로 고침 뒤 `document.title` 이 대상 이름, 대상 세션의 탭이 열려 있다.
- `the tabs left behind are written before the switch` — 글을 친 직후 전환하면 떠난 워크스페이스의 `memos` 에 그 글, `otherWorkspaces[떠난 경로].session` 에 그 탭.
- `⌃2 switches to the second workspace`.
- `a workspace open in another window is brought forward and this window stays` — 대상의 `windows: 1` 이면 페이지가 새로 고쳐지지 않고 `data.focusedWorkspace` 가 그 경로.
- `+ creates a workspace and switches this window to it` — 이름을 넣으면 새 워크스페이스로 바뀌고 빈 칸 하나.
- `새 워크스페이스… in the menu switches this window too`.
- `a switch is marked for the timing` — `TOTE_PERF` 를 켠 가짜 설정이면 `perfMark("switch-click")` 이 불린다.
- (허브 됨) `the dot follows a workspace opened in another window` — 둘째 창이 `나` 로 바뀌면 첫째 창 띠의 `나` 에 점.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml flush lifecycle app && pnpm test src/ui/rail.test.ts && pnpm test:e2e tests/e2e/rail.spec.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

- 띠는 사이드바보다 왼쪽(`root` 의 첫 자식). `listWorkspaces` 를 시작할 때·창 포커스·`onWorkspacesChanged` 때 다시 그린다. 띠 클릭과 ⌃n 은 `mark("switch-click")` 뒤 `switchWorkspace(path)`.
- `onFlush` 는 맨 앞에서 모든 칸의 `settleComposition`.
- `+`·메뉴 「새 워크스페이스…」·대화상자의 만들기: 이름을 받아 `createWorkspace` → 받은 경로로 `switchWorkspace`. 메뉴 「새 워크스페이스…」는 대화상자 대신 이름 입력(`promptText("새 워크스페이스 이름", "")`)을 띄운다.
- 「워크스페이스 열기…」의 고르기는 지금처럼 `openWorkspace`(새 창, 열려 있으면 그 창을 앞으로).

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && pnpm test && pnpm typecheck && pnpm test:e2e`
Expected: 모두 PASS, 실행 개수를 적는다.

- [ ] **Step 5: 커밋**

```bash
git add src/ui/rail.ts src/ui/rail.test.ts src/app/controller.ts src/styles.css src-tauri/src/app/flush.rs src-tauri/src/app/lifecycle.rs src-tauri/src/app/windows.rs src-tauri/src/app/mod.rs src-tauri/src/app/commands.rs src-tauri/src/lib.rs src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts tests/e2e/rail.spec.ts
git commit -m "feat(rail): switch this window's workspace from the rail"
```

---

### Task 13: 코어 스펙을 지금 규칙으로 고치고 참조 표를 잇는다

**Files:**

- Modify: `docs/superpowers/specs/2026-10-07-tote-note-core-design.md` (「범위」, 「전체 구조」, 「워크스페이스와 데이터 모델」의 트리 주석 두 줄, 「세션」, 「`tote` CLI」 한 줄)
- Modify: `.ruler/90-reference.md` (참조 표 두 줄)

- [ ] **Step 1: 스펙을 고친다**

스펙은 지금 참인 규칙만 적는다(연대기 금지, **(설계자 판단)** 표시는 옮기지 않는다).

- 「범위」 「1차에 넣지 않는 것」: 「분할 화면(나란히 미리보기 포함)」을 「위아래 분할, 나란히 미리보기, 같은 메모를 두 칸·두 창에 여는 것, 이미 열린 다른 창으로 탭 옮기기」로 바꾼다.
- 「전체 구조」: 「창 하나 = 워크스페이스 하나」를 바꾼다 — 창은 워크스페이스 하나를 보이고, 같은 워크스페이스로 창을 여럿 열 수 있으며 그 창들은 메모 목록·색인·감시·백업을 함께 쓴다. 창 배치: 워크스페이스 띠(48px) · 사이드바 · 칸들(칸마다 탭 바와 편집 영역) · 상태 표시줄(창에 하나, 포커스 칸의 활성 탭). 칸의 규칙(⌘\, 끌어 옮기기, 칸 닫기, 320px, 포커스·⌥⌘←/→, 칸마다 따로인 것, 탭 순환), 「한 메모는 한 자리에」(외부 파일·`-w`·되살리기 포함)와 그 이유, 새 창(⌥⌘N)·떼어 내기(스파이크 (a2) 가 「구별 못 함」이면 「끌기로는 떼어 내지 않는다」)·옮길 때 글을 잃지 않는 규칙·창 제목, 워크스페이스 띠(항목·순서·점·`+`·⌃1–⌃9·누르면 일어나는 일·「워크스페이스 열기…」와의 차이), 메뉴와 단축키는 포커스된 창. `backend` 모듈 표의 `session` 행은 「창·칸·탭·커서·스크롤」.
- 「워크스페이스와 데이터 모델」 트리: `sessions/<기기 ID>.json` 의 주석을 「그 기기의 창들·칸·탭·커서·스크롤」로, `state.json` 의 주석을 「마지막에 열려 있던 창 목록」으로.
- 「세션」: 세션 파일은 워크스페이스·기기마다 하나이고 창 여럿(창마다 위치·크기, 칸 목록과 너비 비율, 포커스 칸)을 담는다. 창을 닫거나 띠로 떠날 때의 규칙(남은 창이 있으면 버리고 마지막이면 남긴다), 워크스페이스를 열 때 첫 배치를 되살린다, 앱을 끌 때 열린 창 전부를 다시 연다(같은 워크스페이스가 여러 번 나올 수 있다), 백엔드가 창들의 배치를 모아 한 파일로 쓴다. 옛 형식(창 하나·탭 목록 하나)은 칸 하나짜리 창 하나로 읽는다.
- 「`tote` CLI」: `-w` 는 새로 열 자리를 고르는 것이고 이미 열린 파일은 옮기지 않는다(그 자리로 간다).

- [ ] **Step 2: 참조 표를 잇는다**

`.ruler/90-reference.md` 의 표에 두 줄:

| 언제                                                                    | 읽을 파일                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| tote-notes 칸 분할·새 창·워크스페이스 전환을 고치거나 그 설계를 바꿀 때 | `docs/superpowers/specs/2026-10-16-tote-notes-panes-and-windows-design.md` |
| tote-notes 칸·창 계획을 실행하거나, 그 다음 계획을 쓸 때                | `docs/superpowers/plans/2026-10-17-tote-notes-panes-and-windows.md`        |

Run: `pnpm exec ruler apply && git status`
Expected: 추적 파일 변경은 `.ruler/90-reference.md` 와 스펙뿐(생성물은 ignore 된다).

- [ ] **Step 3: 포맷하고 커밋**

```bash
pnpm exec oxfmt docs/superpowers/specs/2026-10-07-tote-note-core-design.md .ruler/90-reference.md
git add docs/superpowers/specs/2026-10-07-tote-note-core-design.md .ruler/90-reference.md
git commit -m "docs(spec): make panes, more windows and the workspace rail the core rules"
```

---

### Task 14: 에이전트 스모크

화면 없이 볼 수 있는 것만 한다. 화면이 필요한 것은 Task 15 로 간다.

**Files:**

- Create: `docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-smoke.md`

모든 실행에 `TOTE_DATA_DIR=/tmp/tote-panes-smoke`, `TOTE_BACKGROUND=1`, `TOTE_BACKUP_INTERVAL_SECS=600`. 실행 중인 앱에 요청을 보낼 때는 번들 실행 파일에 같은 `TOTE_DATA_DIR` 을 주고 `--tote-request=<json>` 을 넘긴다(`docs/guides/development.md`). 끄기는 `osascript -e 'tell application "tote-dev" to quit'`.

- [ ] **Step 1: 디버그 빌드**

Run: `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json`
Expected: `src-tauri/target/debug/bundle/macos/tote-dev.app`.

- [ ] **Step 2: 옛 세션이 버전 2 가 된다**

워크스페이스 하나에 버전 1 세션(메모 탭 둘·외부 파일 탭 하나·활성 1)을 손으로 두고 켰다가 끈다. 세션 파일이 `version: 2`, 창 하나·칸 하나에 같은 탭·같은 활성 탭인지 본다.

- [ ] **Step 3: 같은 워크스페이스의 창 둘이 돌아온다**

`state.json` 의 `openWindows` 에 같은 경로 둘, 세션 파일에 서로 다른 탭을 담은 창 배치 둘을 두고 켰다가 끈다. 끈 뒤 `openWindows` 가 여전히 둘이고 세션의 창 배치 둘이 그대로인지(어느 쪽도 사라지지 않았는지) 본다. 그 사이 스냅샷 폴더가 하나만 늘었는지 본다(워크스페이스마다 한 번).

- [ ] **Step 4: 다른 워크스페이스에 열린 파일은 옮기지 않는다**

워크스페이스 A(세션에 외부 파일 `a.sh` 탭)와 B 를 연 상태에서 `--tote-request={"workspace":"B","files":["<a.sh 절대 경로>"]}` 를 보낸 뒤 끈다. A 의 세션에만 `a.sh` 가 있고 B 의 세션에는 없는지 본다.

- [ ] **Step 5: 정리와 검사**

앱을 끄고 `/tmp/tote-panes-smoke` 를 지운다. `pgrep -f tote-dev.app` 가 없고 `~/Tote-dev`·`~/Library/Application Support/tote-dev` 가 없는지 본다.

- [ ] **Step 6: 보고서와 커밋**

항목별 결과(합격·불합격·확인 못 함과 이유), 도구의 한계, 실행한 명령을 적는다. 불합격은 고치지 않고 적고 코디네이터에게 알린다.

```bash
git add docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-smoke.md
git commit -m "docs: report the panes and windows agent smoke"
```

---

### Task 15: 사람 스모크 체크리스트 (화면·측정)

사람이 한 번에 하는 화면 확인과 측정이다. 에이전트는 체크리스트 문서를 쓰고 사람에게 넘긴다. 사람이 결과를 채우면 코디네이터가 커밋한다.

**Files:**

- Create: `docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-human-smoke.md`

문서의 꼴: 항목마다 「절차」·「기대」·「결과」(빈 칸) 세 열. 맨 위에 공통 준비 — 디버그 번들 빌드 명령, `open --env TOTE_DATA_DIR=<임시 폴더> --env TOTE_BACKUP_INTERVAL_SECS=600 src-tauri/target/debug/bundle/macos/tote-dev.app`(`TOTE_BACKGROUND` 는 주지 않는다), 끝나면 `~/Tote-dev`·`~/Library/Application Support/tote-dev` 확인, `chmod` 는 시험 폴더에만.

- [ ] **Step 1: 새 기능 항목을 쓴다**

- 칸: ⌘\(탭 둘·하나·좁은 창), 경계 끌기(320px 에서 멈춤), ⌥⌘←/→, 칸 닫기, 탭을 다른 칸·오른쪽 가장자리로 끌기, 다시 켜면 칸·너비·포커스 칸이 돌아오는지.
- 한글: 칸 하나에서 「한글」을 조합하는 도중 ⌥⌘→, 띠 클릭, 「탭을 새 창으로 옮기기」 — 각각 자모가 깨지지 않고 원래 메모에 들어가는지.
- 새 창: ⌥⌘N, 창 제목 ` — 2`, 한 창에서 만든 메모가 다른 창 목록에 바로 보이는지, 다른 창에 열린 메모를 이 창에서 열면 그 창이 앞으로 오는지.
- 떼어 내기: 메뉴·오른쪽 클릭(그리고 스파이크 (a2) 가 「구별함」이면 끌기)으로 메모·외부 파일(저장 전 수정분 포함) 탭을 새 창으로. 읽기 전용 폴더(`chmod a-w`)에서 저장이 실패하면 옮기지 않고 「저장 실패」가 남는지.
- 띠: 이름 순, 두 글자, 마우스를 올리면 이름 전체, 현재 강조, 다른 창의 점, ⌃1–⌃9, `+`, 다른 창에 열린 워크스페이스를 누르면 그 창이 앞으로 오고 지금 창은 그대로인지, 저장 실패가 남은 채 누르면 `그래도 바꾸기` / `취소` 질문.
- 종료: 창 셋(같은 워크스페이스 둘 + 다른 하나)으로 ⌘Q·Dock 종료·로그아웃 한 번씩 — 멈추지 않고, 다시 켜면 셋 다 제자리.

- [ ] **Step 2: 이월된 화면 항목을 옮긴다**

`docs/superpowers/reports/2026-10-16-tote-notes-safety-net-followups-smoke.md` 의 두 절차를 그대로 옮긴다:

- 「Step 3 — 종료 대화상자 겹침」 1–5 와 「Step 3 (종료 대화상자 겹침)에 보탤 것」 1–4(N4 ①②, Dock 종료 → 취소, 로그아웃). 이 계획이 N3·N4 를 고쳤으므로 하나를 더한다: 시트가 뜨기 **전**(⇧⌘W 직후, 쓰는 중)에 ⌘Q → 대화상자가 하나만.
- 「Step 4 — 충돌 보관 배너」 1–5 와 「Step 4 (충돌 보관 배너)에 보탤 것」 1–3. 이 계획의 T5-1 수정에 맞춰 하나를 더한다: 배너가 있는 메모를 바깥에서 한 번 더 바꿔 충돌 배너를 띄우고 「디스크 버전」을 고르면 보관 배너가 돌아오는지.
- 편집기에 글을 넣을 때 `orca computer` 의 `type-text`·`paste-text` 대신 `set-value` 를 쓴다는 주의도 옮긴다.

- [ ] **Step 3: 측정 항목을 쓴다**

- **세션 복원 50탭 재측정** — load 가 3 아래일 때(`uptime`; 스크립트가 기다린다):

  ```bash
  pnpm perf:fixtures /tmp/tote-perf-fixtures
  TOTE_DATA_DIR=$(mktemp -d) PERF_FOREGROUND=1 PERF_ONLY=restore-50 pnpm perf:measure /tmp/tote-perf-fixtures
  ```

  기대: 5회 중앙값 `restore-done` ≤ **1,000ms**(코어 스펙 목표). 표와 load 를 적는다.

- **워크스페이스 전환 시간**(목표 1,000ms, 관문 아님): 위 명령이 만든 perf 번들(`src-tauri/target/perf/bundle/macos/tote-dev.app`)로, 빈 임시 폴더 `S` 에 `mkdir -p S/workspaces && cp /tmp/tote-perf-fixtures/machine.json S/ && cp -cR /tmp/tote-perf-fixtures/restore-50 S/workspaces/restore-50 && cp -cR /tmp/tote-perf-fixtures/restore-50 S/workspaces/restore-50-b` 를 만들고 `open --env TOTE_DATA_DIR=S --env TOTE_PERF=1 <perf 번들>`. 띠로 두 워크스페이스를 다섯 번씩 오간 뒤 끄고:

  ```bash
  node -e 'let t=null;for(const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")){const m=JSON.parse(l);if(m.name==="switch-click")t=m.t;else if(t!==null&&m.name==="restore-done"){console.log((m.t-t).toFixed(0));t=null}}' S/perf.jsonl
  ```

  열 개 값과 중앙값, load 를 적는다. 1,000ms 를 넘으면 다음 계획에서 컨트롤러 다시 세우기를 검토할 근거로 남긴다.

- [ ] **Step 4: 넘기고, 받은 결과를 커밋한다**

문서를 커밋하고 코디네이터에게 「사람 스모크 준비됨」을 알린다. 사람이 결과 열을 채우면 불합격 항목을 다음 계획 후보로 문서 끝 「다음 계획으로 넘기는 것」에 적고 다시 커밋한다.

```bash
pnpm exec oxfmt docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-human-smoke.md
git add docs/superpowers/reports/2026-10-17-tote-notes-panes-and-windows-human-smoke.md
git commit -m "docs: hand over the panes and windows human smoke checklist"
```
