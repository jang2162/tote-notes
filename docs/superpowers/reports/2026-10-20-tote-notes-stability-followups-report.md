# tote-notes 안정화 후속 결과 보고서

계획: `docs/superpowers/plans/2026-10-20-tote-notes-stability-followups.md`. 브랜치 `jang2162/stability`, 기준 `main` `47cb440`.

## 병합 뒤 할 일

1. **최상위 체크아웃(과 이미 있는 다른 워크트리)에서 `pnpm install` 을 한 번 다시 돌린다.** `@codemirror/view` 패치(`patches/@codemirror__view@6.43.14.patch`, `pnpm-workspace.yaml` 의 `patchedDependencies`)는 install 때 적용된다. post-checkout 훅은 설치를 돌리지만 merge·pull 로 받은 체크아웃은 훅이 돌지 않는다. 안 돌리면 그 체크아웃의 개발 서버·e2e 는 패치 없는 CodeMirror 로 돌고, `tests/e2e/highlight.spec.ts` 「colours that land just after the editor takes the focus leave the cursor in place」 가 실패한다.
2. 사용자 결정 하나가 남아 있다: CodeMirror 상위에 결함을 보고할지(아래 「Task 2 상위 보고」).

## 요약

| 태스크                | 커밋                                    | 한 줄                                                                  |
| --------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| 1 흔들리는 시험 A     | `1a4794b` `c128a80`                     | 고정 지연 셋을 쓰기·undo 신호로. 가짜 백엔드의 재시작 모델 결함을 고침 |
| 2 흔들리는 시험 B     | `9fb7fe4` `28e5d56` `7436f4f` `dba18e9` | 커서 0 은 CodeMirror 결함(패치), 옛 state 덮어쓰기는 앱 결함(고침)     |
| 3 탭 소유의 좁은 틈   | `9cebc58` `d7fa1d2`                     | 복원 중 받은 탭, 메모 없는 탭, 시작 중인 창                            |
| 4 검색 개수 이어 세기 | `78dc3cd`                               | 「n+」 가 정확한 「k / N」 으로 풀린다                                 |
| 5 편집기 명령 이름    | `e09bafc`                               | `keepNames` 걷음. gzip 498,283 → 492,998 B                             |
| 6 작은 시험 공백      | `c61b878` `090dc1c`                     | 공백 여덟 항목                                                         |
| 7 문서                | 이 커밋                                 | 이월 표 표시, 개발 가이드, 이 보고서                                   |

최종 시험 수(Task 6 끝 기준 마지막 전체 실행): vitest 42 파일 364 통과, e2e 375 통과, `cargo test` 399 통과(lib). 부하는 공용 머신이라 20~36.

## 태스크별 고치기 전·후

반복은 `--repeat-each=20`, 부하는 `uptime` 1분 평균(시작 → 끝).

### Task 1 — 저장 대기·재시작

|                                                  | 고치기 전                                                                                                                                                      | 고친 뒤                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 네 시험(watch 둘, tear-off, windows 재시작) × 20 | 80 중 **2 실패**(둘 다 windows 재시작), 부하 15.51 → 39.50. 첫 줄 `expect(locator).toHaveText(expected) failed`, `titles(againSecond)` 기대 `["나"]` 받음 `[]` | 1차 80 중 1 실패(watch 「디스크 버전」, `Received: "우유 계란"`), 부하 41.54 → 73.53. 최종 **80 통과 / 0 실패**, 부하 62.41 → 101.53 |
| 수정 회차 1: 같은 경합을 가진 4개 + windows × 20 | 80 통과(부하가 낮으면 안 남), 47.03 → 57.32                                                                                                                    | **100 통과 / 0 실패**, 38.19 → 60.37                                                                                                 |

- **원인.**
  - windows 재시작: 앱 결함이 아니라 가짜 `FakeHub` 의 재시작 모델이었다. 재시작 뒤 ws-1 페이지만 떠 있는 동안 ws-1 이 레이아웃을 쓰면 가짜가 등록된 창만으로 세션 파일을 다시 써서 ws-2 레이아웃이 지워졌다. 가짜에 「다시 열 창」 목록(`HubState.reopening`, 라벨 기준)을 두어 Rust 와 같게 했다. Rust 쪽 같은 틈은 없다(`restore` 가 모든 창을 먼저 등록한다).
  - watch 「디스크 버전」: 입력의 저장 타이머(500ms)가 「다른 앱의 쓰기」 와 `outside()` 사이에 끼면 저장이 먼저 디스크에 쓰여 충돌 배너가 뜨고 「디스크 버전」 이 tote 자신이 쓴 글이 됐다. 앱은 디스크를 정확히 보여 주므로 시험의 시간 가정이었다. 입력·쓰기·`outside()` 를 한 `page.evaluate` 안에서 동기로 한다(`typeWhileChangedElsewhere`). 같은 패턴 네 시험도 고쳤다.
  - 고정 지연 셋(`waitForTimeout` 1000·700·600)은 `memoWrites`·`pending()`·`undoDepth` 신호로 바꿨다.
- **변이.** 교체의 undo 기록 끊기 되돌리기, 충돌 중 저장 막기 삭제, 떼어 내는 탭 숨기기 삭제, 세션 쓰기 삭제, 옛 `register` 되돌리기 모두 대상 시험이 실패했다(windows 재시작은 10/10).
- **남은 것.** Task 1 이 본 `Cross-origin script load denied` 줄은 Task 2 의 base 대조로도 가를 수 없었다(아래).

### Task 2 — 커서 0·좌표·타이머

| 시험                                                               | 고치기 전                                                                             | 고친 뒤                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------- |
| switcher 「…gives the panes back」 둘                              | **3 실패 / 40**, 부하 50.75 → 64.64. `Expected: "안건 셋"` `Received: " 셋안건"`      | 0 / 40, 66.55 → 74.08                 |
| search-bar-app 「closed bar closed」 + 「reload in another pane…」 | **1 실패 / 40**. `Expected: "alpha alpha"` `Received: "alpha"`                        | 0 / 40, 74.08 → 95.99                 |
| panes 더블클릭                                                     | **1 실패 / 20**. `TypeError: Cannot read properties of null (reading 'x')`            | 0 / 20                                |
| watch 「cursor in place」                                          | **1 실패 / 20**. 46행 `Expected: 1` `Received: 0`                                     | 0 / 40(새 시험과 함께), 77.17 → 71.83 |
| search-bar 「counted once it rests」·조합 Enter, settings 둘       | 0 실패(고치기 전에도 0. 「한 프레임」·`setTimeout(0)` 을 걷은 것이라 RED 증거는 변이) | 0 / 80                                |

- **원인 1 — 커서 0 (`@codemirror/view` 결함).** `DOMObserver.readSelectionRange` 에 「포커스 뒤 200ms 안에 브라우저가 선택을 편집기 맨 앞으로 옮겼다」 보정 분기가 있다. 이 분기가 캐시된 선택을 지금 DOM 선택으로 갱신하지 않고 `updateSelection()` 을 불러서, 옮기기 전 캐시와 비교해 「이미 제자리」 로 보고 아무것도 쓰지 않는다. 칸이 다시 보이며 편집기가 포커스를 받은 뒤 200ms 안에 첫 하이라이트가 오면 WebKit 이 DOM 선택을 `(cm-line, 0)` 으로 접고, 다음 measure 의 `flush` 가 그것을 사람의 선택으로 받아 커서가 0 이 된다. 코디네이터 판정으로 `pnpm patch` 한 줄(`this.selectionRange.setRange(range)`)을 더했다. 최신 6.43.15 도 같은 코드라 판이 올라가도 패치를 다시 만들어야 한다(절차는 개발 가이드 「`@codemirror/view` 는 패치해서 쓴다」). 결정적 시험(highlight.spec)은 패치 전 5/5 실패, 후 20/20 통과. 패치를 해제하면 5/5 실패.
- **원인 2 — 늦은 measure 가 다시 읽은 state 를 덮음 (앱 결함).** `showReloaded` 가 스크롤 위치를 읽으려고 `lineBlockAtHeight` 를 부르면 CodeMirror 가 밀린 measure 를 그 자리에서 돌리고, 그 갱신이 `AppController.onUpdate` → `doc.update` 로 가서 reload 가 막 넣은 새 state 를 옛 state 로 되돌린다. 화면에 옛 글이 남고 배너도 없는 채로 첫 키를 치면 저장이 「옛 글 + 그 글자」 를 써서 다른 앱의 변경이 조용히 사라지는 데이터 손실 경로였다(Task 2 리뷰 확인). **`onUpdate` 가 탭이 지금 들고 있는 state 에서 시작하지 않은 갱신(`update.startState !== doc.state`)을 버리게 했다.** 결정적 시험은 고치기 전 5/5 실패, 후 20/20. 가드를 지우면 3/3 실패. Task 3 에서 `docChanged` 인 갱신을 버릴 때만 `console.warn` 을 낸다(전체 e2e 에서 의도된 시험 하나 뒤에만 한 번 나온다).
- **나머지 신호로 바꾼 것.** switcher 는 탭의 선택(`state.selection.main.head`)을 직접 단언, 느슨한 커서 단언은 `"alpha oneX"` 와 head 10, panes 더블클릭은 박스가 두 번 연속 같을 때까지 poll, search-bar 는 `page.clock` 의 `runFor(149)`/`runFor(1)`, settings 는 `expect.poll` 과 언어 설정 로드 promise(`AppController.languageConfigs`).
- **변이.** 아홉 가지를 하나씩 되돌려 모두 대상 시험이 실패했다. 단 `stay()` 끝의 `takeKeys()` 삭제는 switcher 둘이 통과했다(`pane.show` 가 이미 포커스를 줌). 변이 대상을 `pane.show` 로 바꿔 6/6 실패를 확인했다.
- **Task 2 상위 보고(사용자 결정).** 올리는 것은 사용자가 정한다. 아래 요약이 그대로 이슈 본문이 되도록 썼다.

  > **@codemirror/view 6.43.14 / 6.43.15: the "browser moved the selection to the start on focus" reset in `DOMObserver.readSelectionRange` compares against a stale cached selection, does nothing, and then lets the bogus selection through.**
  >
  > In `readSelectionRange`, when `local && !this.selectionChanged && lastFocusTime > Date.now() - 200 && atElementStart(this.dom, range)`, the code sets `lastFocusTime = 0` and calls `view.docView.updateSelection()` — but `this.selectionRange` still holds the selection from before the browser moved it. `updateSelection` compares the wanted position with that stale range, finds them equivalent, and writes nothing. The DOM selection stays at the line start, and since `lastFocusTime` is now 0, the next `flush` (e.g. `measure` → `forceFlush`) reads it as a user selection and moves the cursor to the start of the line.
  >
  > Trigger seen in WebKit (Safari / WKWebView): the editor gets focus while the DOM selection is inside `contentDOM` but not on the text (so the focus-time check does not fire), the cursor is placed mid-line, and within 200ms a decoration update wraps the caret's text node in a mark span. WebKit collapses the DOM selection to `(line, 0)` when the text node is moved.
  >
  > Reproduction: an editor with a mark decoration that arrives asynchronously (an async highlighter); before it arrives, `view.dispatch({selection: {anchor: 3}})` on `"echo hello"`, focus another element, `getSelection().collapse(view.contentDOM, view.contentDOM.childNodes.length)`, `view.focus()`, then dispatch the decoration effect and call `view.measure()` → `state.selection.main.head` is 0 (expected 3). Deterministic in Playwright WebKit.
  >
  > Fix: call `this.selectionRange.setRange(range)` before `view.docView.updateSelection()` in that branch, so the comparison sees where the browser actually put the selection.

- **Cross-origin 잡음 줄 base 대조.** base `47cb440` 에서 `watch.spec.ts` 전체 × 20(부하 72.23 → 87.80): 219 통과 / 1 실패(base 에도 있는 「cursor in place」 커서 0), `Cross-origin script load denied` 줄 0, `Importing a module script is canceled` 줄 12. 이 브랜치의 반복·e2e 전체에서도 Cross-origin 줄은 0. 변경 탓인지 가를 수 없다(표본 부족).

### Task 3 — 탭 소유의 좁은 틈 셋

| 시험                                                                     | 고치기 전                                                 | 고친 뒤                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------- |
| e2e `a tab adopted while restoring is shown and saved after the restore` | 실패: 탭 순서 `["나","가"]`(기대 `["가","나"]`)           | 통과                                                     |
| e2e `an adopt whose memo is gone gives its place back`                   | 실패: `places["memo:gone"]` 이 `"ws-1"` 로 남음           | 통과                                                     |
| Rust 새 시험 5개 중                                                      | 2 실패(`a_window_not_yet_started…`, `a_tab_let_go_over…`) | 5 통과                                                   |
| 수정 회차: adopt e2e 5개                                                 | 1 실패(리스너를 `workspaceInfo` 뒤에 붙인 옛 순서)        | 5 통과, × 20 = **100 통과 / 0 실패**, 부하 22.13 → 29.63 |

- **구현.** 복원 중 받은 탭은 `pendingAdopts` 에 모았다가 `restoreSession` 이 `restoring = false` 를 한 직후 차례로 `adoptTab` 한다. `adoptTab` 이 탭을 못 만들면 `releaseTab` 으로 자리를 돌려준다. Rust 는 `OpenWindow.page_ready`(등록에서 false, `page_started` 에서 true, `switch_window` 에서 false)를 둔다.
- **수정 회차: 남은 틈 닫기.** `page_started` 는 페이지의 첫 명령 안에서 켜지는데 `onAdopt` 리스너는 여러 await 뒤에야 붙어, 그 사이 떨어진 탭의 `tote://adopt`(쌓이지 않는 Tauri 이벤트)가 사라졌다. `Backend.onAdopt` 가 `Promise<void>` 를 돌려주고 `start()` 맨 앞에서 리스너를 붙인 뒤 `workspaceInfo()` 를 부른다.
- **Task 3 의 준비 안 된 창 판정(코디네이터).** 브리프의 「`page_ready` 인 창만 후보」 대신 **준비 안 된 창을 목록에서 빼지 않고 `leaving=true` 로 낸다.** `window_at` 은 「포인트 아래 맨 앞 창이 정한다」 원칙이라, 빼면 화면에 떠 있는 준비 안 된 창을 건너뛰고 뒤에 가려진 같은 워크스페이스 창으로 탭이 간다. 틀리면 「뒤 창으로 간다」 는 동작이다. 시험 `a_tab_let_go_over_a_window_not_yet_started_gets_a_window_of_its_own` 이 앞 창이 준비 안 됐을 때 새 창을 낸다는 것을 지킨다. 또 `page_ready` 초기값은 `opened` 가 아니라 등록(`add_window`)에서 false 다(`opened` 는 `builder.build()` 뒤라 `page_started` 가 먼저 올 수 있다).
- **Task 2 리뷰 Minor 처리.** M1 `docChanged` 인 갱신을 버릴 때 `console.warn`, M3 panes 더블클릭 poll 에 `last !== null`, M4 settings 경고를 모든 읽기가 끝난 뒤 `toHaveLength` 로.
- **변이.** `page_started` 의 `page_ready = true` 삭제 → Rust 4 실패, `saveSessionNow` → `saveSessionSoon` → e2e 1 의 세션 단언 실패, 대기열 역순 비우기·`open()` 건너뛰기·`releaseTab` 제거 모두 대상 시험 실패. `switch_window` 의 `page_ready = false` 제거는 `a_switch_takes_the_page_ready_mark…` 만 실패한다(`a_window_back_from_a_switch…` 는 `switching` 이 덮어 회귀 시험으로만 남는다).

### Task 4 — 검색 개수 이어 세기

| 시험            | 고치기 전                                             | 고친 뒤                                           |
| --------------- | ----------------------------------------------------- | ------------------------------------------------- |
| 단위            | **2 실패 / 10**                                       | `src/editor/` 6 파일 39 통과                      |
| e2e 새 시험 3개 | **3 실패**(`Expected "1 / 20", Received "1 / 4+"` 등) | × 20 = **60 통과 / 0 실패**, 부하 10.69 → 16.44   |
| 전체            | —                                                     | `pnpm test` 40 파일 348, `pnpm test:e2e` 373 통과 |

- **구현.** `findMatches` 가 `resume`(다음에 볼 문서 위치)을 돌려주고 `carried` 로 이어 붙인다. `SearchBar` 가 `setTimeout(…, 0)` 한 번씩 이어 세고(예산 30ms 그대로), 문서·검색어 변경·닫힘이 예약을 버린다. 이어 세는 동안 찾은 것이 0 이면 직전 표시를 둔다.
- **브리프와 다른 점.** 빈 결과 뒤의 `resume` 은 `to + 1` 이다(CodeMirror 의 여러 줄 커서가 시작 자리의 빈 결과를 스스로 건너뛰므로 `to` 에서 다시 세면 한 번에 센 수와 어긋난다).
- **알려진 한계.** 줄을 넘는 정규식이 `^`·단어 경계·뒤돌아보기에 기대면 이어 센 개수가 하나쯤 어긋날 수 있다(CodeMirror 의 다음 찾기도 같은 방식). 스펙 「동작 · 개수 세기」 에 한계 문장을 넣었다.
- **변이.** 다섯 가지(Review Focus 2 의 `more` 를 안 버림 → `Received "2 / 21"` 포함) 모두 대상 시험 실패.

### Task 5 — 편집기 명령 이름

- **판정.** 계획대로 `import * as` 로 모았더니 gzip 합계가 **498,283 → 505,206 B(+6,923)** 로 커졌다(네임스페이스 import 가 tree-shaking 을 막음). 계획의 기준(커지면 멈춤)에 따라 멈추고 보고했고, 코디네이터가 「키맵에 걸린 명령만 명시 import 한 이름 표 + 모든 바인딩이 이름을 얻는다는 단위 시험」 으로 판정했다.
- **결과.** `src/shortcuts/command-names.ts`(키맵이 거는 명령만 이름으로 import) → gzip **498,283 → 492,998 B**(−5,285), raw 1,462,042 → 1,426,795 B(−35,247). 부하 14~16. `keepNames`·`scripts/check-build.ts`·`check-build` 단계를 걷었다.
- **시험.** `command-names.test.ts` 가 `editorKeymap` 의 모든 `run`/`shift` 가 표에서 이름을 얻는지 본다(표에서 `selectLine` 을 빼면 실패). `keys.test.ts` 「editor bindings are named from the exports, not Function.name」 는 이름을 `Qp` 로 망가뜨려도 `selectLine` 이 나온다. 전체 `pnpm exec vitest run` 41 파일 351 통과.
- **이름을 새로 얻은 바인딩**(전엔 모두 「편집기 명령」, 12개): ⌘Z/⌘⇧Z `undoWithCursors`/`redoWithCursors`, ⌘Enter `insertBlankLine`, Enter/⇧Enter `insertNewlineAndIndent`, F3/⇧F3·⌘G/⇧⌘G `findNext`/`findPrevious`, ⌘U/⌘⇧U `undoSelection`/`redoSelection`, Ctrl+A `cursorLineStart`. 그래서 e2e 「이름 없는 함수의 키는 편집기 단축키로」 시험(⇧⌘U)의 기대 문구가 「편집기의 redoSelection 을 가립니다」 로 바뀌었다(의도된 동작 변화).
- **Task 5 리뷰 Minor 처리.** 별칭 우선순위가 표 순서에 숨은 의존이라는 리뷰 Minor 2 는 사실이 아니었다(`@codemirror/commands`·search·autocomplete 의 함수 export 중 같은 함수를 가리키는 이름이 없고 `cursorLineBoundaryLeft` 와 `Backward` 는 다른 함수다). 그래서 「나중 항목이 이긴다」 서술을 코드 주석·개발 가이드·스펙에서 걷었다. 긴 문서 주석 한 줄(Minor 3)은 접었다. 설정·단축키 스펙 77·125행(과 76행)의 `keepNames`·`Function.name`·`check-build` 서술은 새 방식으로 고쳤다. 보고의 「79개」 개수 오기와 영문 주석 오기는 남아 있다(아래 이월).

### Task 6 — 작은 시험 공백

여덟 항목(1000 경계, `contrastRatio` clamp·`hsl()`, 기본 변수 시험, `openPanelEffect` 한 번만 알림, 글꼴 14.5→15, 뷰어 섞인 줄번호 재설정, `paneSession` 합치기, Rust 목표 버튼 시험). RED 가 의미 있는 것은 RED 를 봤고(clamp·hsl, 패널 실패, 뷰어 가드), 구현이 이미 맞아 처음부터 통과한 것(1000 경계, 14.5)은 공백 메우기로 기록했다. 수정 회차는 hsl 의 `rad`/`grad` 가 오류 없이 틀리던 것(단위 환산·읽을 수 없으면 throw), `NOT_THEMED` 목록을 값까지 비교, 알파 중복 정리. 항목 8 은 `lifecycle.rs:148` 의 버튼을 `""` 로 바꾸면 시험이 실패하는 것을 보이고 되돌렸다(커밋 없음). 최종 `pnpm test` 42 파일 364, e2e 375, `cargo test` 399 통과.

## 남은 것 (이월 목록)

문서로 쓸 지침이 아니라 다음 계획이 고를 거리다.

| 무엇                                                                                                                                                                                                      | 출처                                   | 까닭·다음 걸음                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Importing a module script is canceled` 줄 수를 이 브랜치 쪽에서 세지 않았다                                                                                                                              | Task 2 리뷰 Minor 5                    | base ×20(부하 72~88)에서 12줄. 잡음 판정에는 브랜치 쪽 수도 필요하다. 개발 가이드 `E2E 전에 WebKit 을 설치한다` 절에 「이 줄은 base 에서도 부하가 높을 때 나온다」 를 넣을 수 있다                                                           |
| `Cross-origin script load denied` 줄이 변경 탓인지 가를 수 없다                                                                                                                                           | Task 1·2                               | base 와 이 브랜치 모두 이번엔 0 줄. 표본이 쌓이면 다시 본다. 표본: 2026-10-21 틈 메우기·단축키 후속 최종 리뷰의 전체 e2e(부하 35~43, 여러 worker)에서 `Script error` 2줄과 함께 1줄, 393 통과                                                |
| 실기기(Tauri)에서 `window.listen` 의 promise 가 리스너 등록 뒤에 풀리는지 검증하지 못했다                                                                                                                 | Task 3 재리뷰                          | 안 맞으면 `tote://adopt` 틈이 한 왕복만큼 되살아난다. 화면 확인 목록 후보                                                                                                                                                                    |
| 전환이 아닌 페이지 reload(개발 중 ⌘R·HMR)에서 새 페이지가 리스너를 붙이기 전 틈이 남는다 (틈 메우기·단축키 후속에서 해결, 커밋 `3e9af3f`: 페이지 로드가 시작되면 `page_loading` 이 준비 안 됨으로 돌린다) | Task 3                                 | `page_ready` 는 `switch_window` 에서만 false 로 돌아간다. 그 사이에 놓인 탭은 사라진다(메모는 자리를 쥔 창이 `reveal` 로 다시 연다). 앱이 전환 말고 페이지를 다시 읽는 경로는 코드에서 찾지 못했다                                           |
| 검색 개수의 「0 일 때 표시 유지」 가 다른 검색어의 옛 표시를 이어 세기가 끝날 때까지 남긴다 (틈 메우기·단축키 후속에서 해결, 커밋 `63e74f1`, `fa2e439`)                                                   | Task 4 리뷰 Minor 2                    | 잘못된 정규식을 고친 직후 「잘못된 정규식」 이 빨간 채 남거나 옛 「1 / 3」 이 남을 수 있다. 직전 표시가 「잘못된 정규식」 일 때만 유지하지 않게 하는 정도로 고친다                                                                           |
| `findMatches(…, undefined, undefined, undefined, carried)` 위치 인자                                                                                                                                      | Task 4 리뷰 Minor 3                    | 호출처가 둘뿐이라 둔다. 늘어나면 선택 인자를 객체로 묶는다                                                                                                                                                                                   |
| 이어 센 개수가 한 번에 센 수와 다른 「알려진 차이」 를 단언하는 시험이 없다                                                                                                                               | Task 4 리뷰                            | `"ab\nb"`, `a\|^b\|\n\n` 로 한 번에 센 값과 다름을 못 박으면 CodeMirror 를 올려 차이가 사라질 때 알 수 있다                                                                                                                                  |
| 표 개수 오기와 영문 주석 오기                                                                                                                                                                             | Task 5 리뷰 Minor 1·4                  | 보고서의 「79개」 합이 84 이고 표는 82개다(동작 영향 없음). `command-names.ts` 의 「a `import * as`」 는 「an」 (틈 메우기·단축키 후속에서 확인: 저장소 문서에 「79개」 는 이 행의 인용뿐이고 코드 주석은 이미 「an」 이라 고칠 곳이 없었다) |
| 표에 있고 키맵에 없는 명령을 잡는 시험이 없다                                                                                                                                                             | Task 5 리뷰 Minor 5                    | 번들에 쓸모없는 코드가 들어갈 수 있으나 크기가 줄었으므로 실해는 없다                                                                                                                                                                        |
| `settings` 경고의 `poll(...).toBe(1)` 이 「정확히 하나」 를 지키지 않던 것                                                                                                                                | Task 2 Minor 4                         | Task 3 M4 로 되찾았다(모든 읽기가 끝난 뒤 `toHaveLength`)                                                                                                                                                                                    |
| `SecurityError` 걸러내기가 한 시험에만 있다                                                                                                                                                               | Task 6 리뷰 Minor 5                    | 다른 시험이 필요로 하면 `quietErrors` 와 정리한다                                                                                                                                                                                            |
| `search-bar.test.ts` afterEach 의 `openSearchPanel` 원복                                                                                                                                                  | Task 6 리뷰 Minor 4                    | 빼면 새 시험 2개가 실패해 중복이 아니다(`vi.resetModules()` 가 `vi.mock` 대역을 되돌리지 않는다). 주석의 「outlive it」 은 과장일 수 있다                                                                                                    |
| 복원이 한 번도 성공하지 못한 채 창이 닫히면 그 사이 받은 탭이 세션에 남지 않는다 (틈 메우기·단축키 후속에서 해결, 커밋 `3e9af3f`: 복원 전 flush 가 받은 탭을 레이아웃에 쓴다)                             | 최종 리뷰 Minor 8, Task 3 리뷰 Minor 3 | 첫 목록 읽기가 실패하고 다시 포커스되지 않은 창이 닫히면 `pendingAdopts` 가 메모리와 함께 사라진다. 자리는 Rust 의 `closed` 가 풀고 메모 파일은 디스크에 있다. 막으려면 닫기 라운드에서 `pendingAdopts` 를 `adoptTab` 없이 세션에 넣는다     |
| `onUpdate` 가드가 `docChanged` 갱신을 버리면 경고만 하고 화면을 탭에 맞추지 않는다                                                                                                                        | 최종 리뷰 Minor 5                      | 지금은 그 경로가 없다(`doc.state` 를 편집기 밖에서 바꾸는 자리는 모두 동기 흐름). 생기면 버린 직후 `view.setState(doc.state)` 나 `report` 로 상태 표시줄에 알린다                                                                            |
| merge·pull 뒤 `pnpm install` 이 사람의 기억에 기댄다 (틈 메우기·단축키 후속에서 해결, 커밋 `77aed3c`: `post-merge`·`post-rewrite` 훅. `verifyDepsBeforeRun` 검증은 여전히 안 했다)                        | 최종 리뷰 Minor 6                      | 잊으면 그 체크아웃이 패치 없이 조용히 돈다. pnpm 10 의 `verifyDepsBeforeRun` 이 patch hash 변경을 잡는지는 검증하지 않았다. 다음 계획 후보                                                                                                   |
| e2e 출력에 정체를 가리지 못한 줄: 메시지 없는 `[console.error] @`(`changeLanguage` ← `importExternal` ← `onMenu` 스택, 「가져오기」 시험), vite 의 `__dirname` 경고                                       | 최종 리뷰 Minor 7                      | 이 브랜치가 `docs.ts` 를 건드리지 않아 base 부터 있던 줄로 보이나 base 에서 같은 시험을 돌려 대조하지 않았다. 대조한 뒤 개발 가이드 「알려진 잡음」 에 넣을지 정한다                                                                         |
| 흔들림 후보: panes 「the old right-edge drop target is gone」, language.spec 시간 초과 2건                                                                                                                | Task 1·3                               | 각각 e2e 전체에서 한 번씩 났고 이후 실행에서는 재현되지 않았다. 다시 보이면 개발 가이드의 재현 절차로 base 와 대조한다                                                                                                                       |
| 화면 확인                                                                                                                                                                                                 | Task 2·3                               | 실제 앱(WKWebView)에서 「탭·워크스페이스에서 돌아와 200ms 안에 색이 오면 커서가 줄 머리로 튐」 과 「찾기 띠를 닫는 순간 다른 앱의 변경이 오면 화면에 옛 글이 남음」 이 사라졌는지, 복원 중 받은 탭이 보이고 세션에 쓰이는지 사람이 본다      |

## 지침 제안 (공용 지침 서버용)

- **lefthook pre-commit 과 Apple Git 2.54**(`docs/guideline/lefthook/00-toolchain.md`, 사본이라 직접 고치지 않았다): 「lefthook 의 pre-commit 은 unstaged 변경이 있으면 `git diff … --output <파일> --` 를 부른다. 이 꼴을 `--no-index` 로 읽는 git(Apple Git 2.54)에서는 훅이 `failed to create a diff for all files` 로 커밋을 막으므로, 커밋 때 작업 트리를 index 와 같게 만든다.」 이 저장소의 `docs/guides/development.md` 에는 이미 들어 있다(`dba18e9`).
