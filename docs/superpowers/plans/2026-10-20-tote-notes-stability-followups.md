# tote-notes 안정화 후속 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 부하에서 흔들리는 e2e 시험을 완료 신호로 고치고, 탭 소유의 좁은 틈 셋을 막고, 검색 개수 「n+」 를 정확한 수까지 이어 세고, 단축키 경고의 편집기 명령 이름을 `keepNames` 없이 얻고, 쌓인 작은 시험 공백을 메운다.

**Architecture:** 새 기능은 없다. 이전 계획들의 「다음 계획으로 넘기는 것」 에서 화면 확인·정책 결정이 필요 없는 것만 골랐다. 흔들림은 시험만 고치지 않고, 앱이 늦은 응답으로 상태를 덮는 결함인지 먼저 본다(`docs/guides/development.md` 「부하에서만 실패하는 테스트는…」).

**Tech Stack:** TypeScript, CodeMirror 6, Tauri 2.12(Rust), vitest, Playwright(WebKit, 가짜 백엔드).

**Spec:** 새 설계는 없다. 각 항목의 근거는 이월 목록이다 — `docs/superpowers/reports/2026-10-19-tote-notes-panes-followups-2-smoke.md`, `…-2026-10-19-tote-notes-free-splits-smoke.md`, `…-2026-10-20-tote-notes-settings-and-shortcuts-smoke.md`, `…-2026-10-20-tote-notes-editor-search-bar-smoke.md` 의 「다음 계획으로 넘기는 것」. 동작 기준은 `docs/superpowers/specs/2026-10-19-tote-notes-free-splits-and-tab-drag-design.md`(탭 소유), `docs/superpowers/specs/2026-10-20-tote-notes-editor-search-bar-design.md`(개수 세기), `docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md`(편집기 키 경고).

## Global Constraints

- 화면(실제 키보드·마우스, 실제 앱 창)을 쓰지 않는다. 디버그 앱이 필요하면 `TOTE_DATA_DIR=<임시 폴더>`. `~/Tote` 금지. `~/Tote-dev`·`~/Library/Application Support/tote-dev` 는 사용자가 쓰는 중이니 지우거나 고치지 않는다.
- 흔들림 판정은 `docs/guides/development.md` 의 재현 절차 그대로: 고치기 **전과 후** 각각 `--repeat-each=20` 을 돌리고 결과마다 `uptime` 부하를 적는다. 실패 메시지 첫 줄을 보존한다(`--output <다른 폴더>`).
- 고친 시험은 **구분력을 잃지 않아야 한다**: 그 시험이 지키는 앱 코드를 지우거나 되돌리면 여전히 실패하는 것을 보인다.
- 고정 지연(`waitForTimeout`, `setTimeout(…, n)`, 「한 프레임」)을 새로 들이지 않는다. 시간을 다뤄야 하면 `page.clock` 을 쓴다.
- 문구 그대로: 개수 표시 꼴(「3 / 12」, 「– / 12」, 「1000+」, 「결과 없음」, 「잘못된 정규식」)과 편집기 경고 「편집기의 〈이름〉 을 가립니다」 는 바꾸지 않는다.
- 테스트 보고는 실행 개수와 함께. 커밋 전에 `pnpm fmt`, `pnpm lint`, `pnpm typecheck`, Rust 를 고쳤으면 `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`.
- 이번에 하지 않는 것: 로그아웃 확인, 화면 확인 목록 전부, 숫자패드·§·Insert 녹음(화면 결과 대기), keyup 이 새는 문제(B-4 대기), ⌘Q 단축키를 지울 수 있게 둘지, 최소 macOS 버전, 4열 gap 모양(D-9 대기).

## Review Focus

1. 복원 중인 창이 받은 탭이 복원이 끝난 뒤 보이고 그 창 세션에 쓰인다 — Task 3 시험 `a tab adopted while restoring is shown and saved after the restore`.
2. 개수를 이어 세는 중에 문서가 바뀌면 옛 위치로 이어 세지 않는다 — Task 4 시험 `an edit during a continued count starts the count over`.
3. `keepNames` 를 걷어도 배포 빌드의 편집기 경고가 압축된 이름이 아니라 export 이름을 보인다 — Task 5 시험 `editor bindings are named from the exports, not Function.name`.
4. 흔들림을 고친 시험이 지키는 코드를 되돌리면 여전히 실패한다 — Task 1·2 각 시험의 변이 확인(보고에 적음).
5. 워크스페이스 전환으로 페이지를 다시 연 창도 다시 준비되면 옮길 후보로 돌아온다 — Task 3 Rust 시험 `a window back from a switch is a drop candidate again`.

---

### Task 1: 흔들리는 시험 A — 저장 대기·재시작

**Files:**

- Modify: `tests/e2e/watch.spec.ts`(83~95행 「디스크 버전 replaces…」, 72행 충돌 배너 시험의 1000ms), `tests/e2e/tear-off.spec.ts`(92~137행, 114행 600ms), `tests/e2e/windows.spec.ts`(95~113행 「two windows of one workspace come back after a restart」), `src/backend/fake.ts`(쓰기 기록), 필요하면 `src/core/scheduler.ts`
- Test: 위 spec 들

**Interfaces:**

- Produces: 가짜 백엔드의 메모 쓰기 횟수 기록 `FakeData.memoWrites: Record<string, number>`(메모 id → 성공한 쓰기 횟수). 앱 쪽 「쓸 것이 남지 않음」 신호가 필요하면 `WriteScheduler.pending(): number`(대기 키 수)를 두고 시험은 `window.__tote.app` 경유로 읽는다.

- [ ] **Step 1: 재현(고치기 전).** 세 시험을 각각 `--repeat-each=20` 으로 돌려 실패 수·부하·첫 실패 메시지를 보고에 적는다.
- [ ] **Step 2: 원인 판정.** 각 시험이 시간으로 대신하는 것을 적는다.
  - watch: ⌘Z 뒤 `toHaveText("두유")` 는 이미 참이라 ⌘Z 처리를 기다리지 못한다.
  - tear-off: 600ms 로 「저장이 일어나지 않음」 을 증명한다.
  - windows: quit 직전 세션·레이아웃 쓰기가 끝났는지 모른다.
  - 앱이 늦은 응답으로 상태를 덮는 결함이면(예: ⌘Z 가 교체 앞 편집을 되살림) 앱을 고친다.
- [ ] **Step 3: 신호로 바꾼다.**
  - watch: 교체 뒤 `undoDepth(view.state) === 0`(= 되돌릴 것이 없음)을 단언한 뒤 ⌘Z 를 누르고, 본문이 여전히 「두유」 인지 단언한다. 「저장이 일어나지 않음」 은 고정 지연 대신 `memoWrites` 가 늘지 않고 `pending()` 이 0 인 것으로 본다.
  - tear-off: 114행의 600ms 를 같은 방식으로 바꾼다.
  - windows: quit 전에 `sessionWindows` 와 함께 창별 레이아웃(`hub.windows[].layout`)이 기대 모양이 될 때까지 poll 한다.
- [ ] **Step 4: 확인(고친 뒤).** 같은 `--repeat-each=20`, 부하 기록. 셋 다 0 실패. 각 시험이 지키는 앱 코드(교체의 undo 기록 끊기, 떼어 낸 탭 쓰기 막기, 종료 전 세션 쓰기)를 하나씩 되돌려 실패하는 것을 보인다.
- [ ] **Step 5: 커밋** `test: wait for the write and undo signals instead of fixed delays`

### Task 2: 흔들리는 시험 B — 커서 0·좌표·타이머

**Files:**

- Modify: `tests/e2e/switcher.spec.ts`(329~371행의 「…gives the panes back」 둘), `tests/e2e/search-bar-app.spec.ts`(159~176행 「a reload leaves a closed bar closed」, 207행 느슨한 커서 단언), `tests/e2e/panes.spec.ts`(902~917행 더블클릭), `tests/e2e/search-bar.spec.ts`(69~82행 「…counted once it rests」, 200행 rAF 대기), `tests/e2e/settings.spec.ts`(약 150~175행, `setTimeout(resolve, 0)` 한 번), 원인이 앱이면 `src/app/docs.ts`·`src/app/pane.ts`·`src/app/surface.ts`
- Test: 위 spec 들

- [ ] **Step 1: 재현(고치기 전).** 다섯 시험을 각각 `--repeat-each=20`(부하 기록, 첫 실패 메시지).
- [ ] **Step 2: 「커서 0」 원인 찾기(superpowers:systematic-debugging).** 의심: `view.dispatch({selection})` 이 `Doc.update` 로 `doc.state` 에 반영되기 전에 `showNothing`/`setState` 가 끼어 옛 선택(0)이 돌아온다(`src/app/docs.ts` 의 `setText`·`reload`, `src/app/surface.ts` 의 `only`, `src/app/pane.ts` 의 `show`). 계측으로 확인하고, 앱 결함이면 앱을 고친다(떠나기·되돌려 주기 사이에 사용자의 선택을 잃지 않음). 시험은 `app.focused.tabs.active.state.selection.main.head` 를 단언해 증상을 직접 본다.
- [ ] **Step 3: 나머지를 신호로.**
  - panes 더블클릭: 탭 바·마지막 탭의 박스가 두 번 연속 같을 때까지 poll 한 뒤 좌표를 읽는다.
  - search-bar 「…counted once it rests」·200행: `page.clock.install()` 로 타이머·rAF 를 잡고 `runFor(149)` 에서 옛 값, `runFor(1)` 에서 새 값.
  - settings: `setTimeout(0)` 대신 경고 수를 `expect.poll` 로 기다린다. `leaving` 이 참인 경우의 「경고가 안 남」 은 로드 완료 신호(언어 설정 캐시나 로드 promise 를 `__tote` 로 노출)를 기다린 뒤 단언한다.
- [ ] **Step 4: 확인(고친 뒤).** 같은 `--repeat-each=20`, 다섯 다 0 실패. 변이 확인(Global Constraints).
- [ ] **Step 5: 커밋**(앱을 고쳤으면 `fix:` 와 `test:` 를 나눈다).

### Task 3: 탭 소유의 좁은 틈 셋

**Files:**

- Modify: `src/app/controller.ts`(`onAdopt` 396~400행, `adoptTab` 1166~1186행, `restoreSession` 436~468행), `src-tauri/src/app/mod.rs`(`OpenWindow`, `page_started` 634~638행, `drop_candidates` 1113~1126행)
- Test: `tests/e2e/tear-off.spec.ts`(또는 새 `tests/e2e/adopt.spec.ts`), `src-tauri/src/app/mod.rs` 의 tests

**Interfaces:**

- Produces(Rust): `OpenWindow` 에 `page_ready: bool` — `opened` 에서 false, `page_started` 에서 true. 워크스페이스 전환으로 페이지를 다시 열 때(`switch_window`)는 false 로 돌아갔다가 다음 `page_started` 에서 true. `drop_candidates` 는 `page_ready` 인 창만 후보로 낸다.
- Produces(TS): 복원 중 받은 탭은 `pendingAdopts: {tab, x, y}[]` 에 모았다가 `restoreSession` 이 `restoring = false` 를 한 직후 차례로 `adoptTab` 한다(그 안의 `showTab`·`saveSessionNow` 가 이제 돈다).

- [ ] **Step 1: 실패하는 시험**
  - e2e `a tab adopted while restoring is shown and saved after the restore`(Review Focus 1): 받는 창의 복원을 붙잡은 채(가짜 백엔드 읽기 게이트 — `holdReads` 등 기존 수단) `adopt` 를 보내고, 풀면 그 탭이 보이고 그 창 세션(`hub.layout`)에 있다.
  - e2e `an adopt whose memo is gone gives its place back`: 지워진 메모의 탭을 받으면 상태 표시줄에 「메모를 찾을 수 없습니다」 가 뜨고, 가짜 백엔드의 자리 기록(`data.places`)에서 그 탭이 이 창에 남지 않는다.
  - Rust `a window not yet started is not a drop candidate`, `a window back from a switch is a drop candidate again`(Review Focus 5).
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3: 구현.** `adoptTab` 이 메모를 못 찾아 돌아갈 때 `backend.releaseTab(<그 탭의 TabRef>)` 를 부른다.
- [ ] **Step 4:** 통과, `cargo test`·`pnpm test`·관련 e2e(개수 보고).
- [ ] **Step 5: 커밋** `fix: close the narrow gaps in handing a tab to another window`

### Task 4: 검색 개수 이어 세기

**Files:**

- Modify: `src/editor/search-count.ts`, `src/editor/search-bar.ts`, `src/editor/search-count.test.ts`, `tests/e2e/search-bar.spec.ts`, `docs/superpowers/specs/2026-10-20-tote-notes-editor-search-bar-design.md`(「동작 · 개수 세기」)

**Interfaces:**

- Produces:

  ```ts
  export interface Matches {
    from: number[];
    to: number[];
    capped: boolean;
    resume: number | null;
  }
  export function findMatches(state, query, limit?, budgetMs?, now?, from?: Matches): Matches;
  ```
  - `resume` 은 시간 예산으로 멈췄을 때 다음에 볼 문서 위치(이어 셀 자리), 끝까지 셌거나 상한(1000)에 닿았으면 `null`. `capped` 는 지금처럼 「n+」 표시용(시간이든 상한이든).
  - `from` 을 주면 그 `Matches` 의 결과 뒤에 이어 붙여 `resume` 부터 센다(`crossesLines` 질의는 마지막 결과의 `to` 부터).

- [ ] **Step 1: 실패하는 시험**
  - 단위 `a count stopped by time resumes to the exact total`: 주입한 시계로 예산을 넘기게 해 `resume` 이 생기고, 그 결과를 `from` 으로 다시 부르면 시계를 멈춘 경우의 결과와 같아진다(`total`·위치 배열 동일, `capped` false 또는 상한이면 true).
  - 단위: 상한(1000)에 닿으면 `resume` 은 `null`.
  - e2e `a count stopped by time goes on to the exact number`: `page.clock` 으로 예산 초과를 만든 뒤 시간을 흘리면 「n+」 가 정확한 「k / N」 으로 바뀐다.
  - e2e `an edit during a continued count starts the count over`(Review Focus 2): 이어 세기가 남은 상태에서 문서를 고치면 옛 위치로 잇지 않고 처음부터 다시 센다(결과 위치가 새 문서 기준).
  - e2e: 결과가 하나도 없는 채로 예산에 걸린 동안 「결과 없음」 과 「– / 0+」 를 오가지 않는다 — 이어 세는 동안 찾은 것이 0 이면 직전 표시를 그대로 둔다.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3: 구현.** `SearchBar` 가 `resume` 이 있으면 다음 이어 세기를 예약한다(`setTimeout(…, 0)` 한 번씩, 예산 30ms 그대로). 문서·검색어 변경과 `destroy` 는 예약을 버린다.
- [ ] **Step 4:** 통과(개수 보고). 스펙 「개수 세기」 문단을 「n+」 는 이어 세기 동안의 중간값이라고 고친다.
- [ ] **Step 5: 커밋** `feat: carry a time-capped count on to the exact number`

### Task 5: 편집기 명령 이름을 export 에서 얻기

**Files:**

- Modify: `src/shortcuts/keys.ts`(`bindingsOf` 278~291행의 `run.name`), `vite.config.ts`(66행 `keepNames`), `package.json`(14행 `build` 의 `check-build`), `docs/guides/development.md`(70~75행 이름 보존 설명)
- Delete: `scripts/check-build.ts`
- Test: `src/shortcuts/keys.test.ts`

**Interfaces:**

- Produces: `src/shortcuts/command-names.ts` 의 `commandName(run: Function): string | undefined` — `@codemirror/commands`, `@codemirror/search`, `@codemirror/autocomplete` 와 우리 모듈(`src/editor/ime.ts`, `src/editor/setup.ts`, `src/editor/search-bar.ts`)의 export 를 `import * as …` 로 가져와 `Map<Function, export 이름>` 을 만든다. `bindingsOf` 는 `commandName(run) ?? UNNAMED_EDITOR_COMMAND`.

- [ ] **Step 1: 실패하는 시험** `editor bindings are named from the exports, not Function.name`(Review Focus 3): `Object.defineProperty(selectLine, "name", { value: "Qp" })` 처럼 이름을 망가뜨린 함수로도 `editorBindings()` 가 `selectLine` 을 낸다(시험 안에서 복원). 그리고 지금 `UNNAMED_EDITOR_COMMAND` 로 떨어지는 바인딩(예: `redoSelection` 류)이 이름을 얻는다 — 어느 것이 바뀌는지 보고에 표로.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3: 구현**, 그다음 `keepNames`·`check-build` 를 걷고 개발 가이드의 해당 줄을 고친다.
- [ ] **Step 4: 번들 크기.** 걷기 전후 `pnpm build` 의 JS 합계(그리고 gzip)를 보고에 적는다. 네임스페이스 import 로 tree-shaking 이 깨져 **gzip 합계가 걷기 전보다 커지면** 이 태스크를 멈추고 보고한다(코디네이터가 판정). `pnpm test` 통과(개수 보고).
- [ ] **Step 5: 커밋** `refactor: name editor commands from their exports and drop keepNames`

### Task 6: 작은 시험 공백 묶음

**Files:**

- Modify: `src/editor/search-count.test.ts`, `src/theme/contrast.ts`·`src/theme/contrast.test.ts`, 새 `src/theme/default-variables.test.ts`, `src/editor/search-bar.ts`(69~87행 `openPanelEffect`), `src/editor/search-bar.test.ts`, `tests/e2e/settings.spec.ts`, `tests/e2e/helpers.ts`·`tests/e2e/panes.spec.ts`·`tests/e2e/pane-drag.spec.ts`, 줄번호 시험 자리(`src/app/controller.ts:1629~1636` 의 가드를 덮는 곳)

- [ ] **Step 1: 시험·작은 수정 (각각 실패를 먼저 본다)**
  1. 개수 1000 경계: 정확히 1000 개면 `capped:false`, 선택이 1000번째 결과면 `current` 1000. 빈 일치 정규식 시험에 기대값을 더한다(100줄 문서의 `^` 는 100). 커서 위의 빈 일치가 current 로 잡히는 것을 한 줄로 못 박는다.
  2. `contrastRatio`: 채널을 0~255, 알파를 0~1 로 자른다(`rgb(300 0 0)` 는 `rgb(255 0 0)` 와 같음). `hsl()`/`hsla()` 를 읽는다(시험: `hsl(0 0% 0%)` 와 `#000` 이 같은 비).
  3. `default-variables.test.ts`: `src/styles.css` 를 읽어 `:root` 와 다크 `@media` 블록의 변수 값이 `DEFAULT_VARIABLES` 의 같은 키와 같은지 본다(둘 중 한쪽에만 있는 키는 목록으로 실패).
  4. `openPanelEffect` 실패를 한 번만 알린다(실패를 기억해 다음 reload 부터는 조용히 `[]`). 단위 시험.
  5. 설정 e2e: 글꼴 크기 칸에 `14.5` 를 넣으면 15 로 저장된다.
  6. 줄번호 재설정이 뷰어(상태 없는) 탭이 섞인 창에서 던지지 않는다(e2e 또는 컨트롤러 단위).
  7. `panes.spec.ts`·`pane-drag.spec.ts` 의 지역 `session` 도우미를 `helpers.ts` 의 `paneSession`(필요하면 `widths` 선택 인자를 더함)으로 합친다.
  8. Rust `every_goal_has_one_button_and_one_sentence`(`src-tauri/src/app/lifecycle.rs:825`): 목표 하나의 버튼을 지워 실패하는지 한 번 보이고 되돌린다(보고에만, 커밋 없음).
- [ ] **Step 2:** 전체 `pnpm test`, 관련 e2e, `cargo test`(개수 보고).
- [ ] **Step 3: 커밋** `test: fill the small gaps the last plans carried over`

### Task 7: 문서

**Files:**

- Modify: 네 이월 문서(위 Spec 절)의 「다음 계획으로 넘기는 것」 — 이번에 끝낸 행에 「(안정화 후속에서 해결, 커밋 …)」 을 붙인다(지우지 않는다). `docs/guides/development.md` — `page.clock` 쓰는 법, 쓰기 신호(`memoWrites`·`pending()`)로 「일어나지 않음」 을 보는 법.
- Create: `docs/superpowers/reports/2026-10-20-tote-notes-stability-followups-report.md` — 태스크별 고치기 전·후 반복 결과(실패 수·부하), 찾은 원인, 남은 것.

- [ ] **Step 1:** 쓴다. **Step 2: 커밋** `docs: record the stability follow-ups`
