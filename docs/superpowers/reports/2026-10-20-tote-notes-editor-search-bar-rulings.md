# tote-notes 편집기 검색 띠(⌘F) — 실행 판정 기록

계획 `docs/superpowers/plans/2026-10-20-tote-notes-editor-search-bar.md` 를 실행하며 코디네이터가 내린 판정과 태스크 기록이다. 작업 폴더의 진행 기록을 옮긴 것이고, 화면 확인과 다음 계획 후보는 `docs/superpowers/reports/2026-10-20-tote-notes-editor-search-bar-smoke.md` 에 있다.

사용자 결정: 「⌘F 시 UI 개선만 진행해줘」, 시안 둘 가운데 위쪽 띠(B), 정리한 동작에 「진행해줘」. 화면(키보드·마우스)을 쓰는 확인은 사용자가 말할 때로 미뤘다.

Run: run_47a254e1e571. Worktree: .worktrees/tote-note/search-bar, base main e1c8816. main 에 그사이 지침 r25 커밋(`61c5f5b`, 겹치는 파일 없음)이 들어와 앞당기기 대신 병합 커밋 `20a71d0` 으로 넣었다.

Spec: docs/superpowers/specs/2026-10-20-tote-notes-editor-search-bar-design.md
Worktree: .worktrees/tote-note/search-bar (id d7bb71a1-a4d9-42ae-ae2a-85f82765b0a0), branch jang2162/search-bar, base main e1c8816
Orca run: run_47a254e1e571
Contract: contract.md (이 폴더)

## Preflight scan

| 짝/태스크    | 내놓는 것 ↔ 받는 것                                                     | 결과                                               |
| ------------ | ----------------------------------------------------------------------- | -------------------------------------------------- |
| T1 ↔ T3      | T1 CSS 변수 4개·`contrastRatio` ↔ T3 띠 스타일·대비 e2e                 | 맞음                                               |
| T2 ↔ T3      | `countMatches`·`countLabel`·`COUNT_LIMIT` ↔ T3 패널 update              | 맞음                                               |
| T3 ↔ T4      | T3 `searchBarKeymap` 빈 배열·⇄ 자리 ↔ T4 가 채움                        | 맞음                                               |
| T3·T4 ↔ T5   | 패널·펼침 StateField ↔ `carrySearch`                                    | 맞음                                               |
| T4 ↔ keys.ts | `editorBindings()` 가 ⌥⌘F 를 읽음                                       | 문자열 꼴이 `Alt+CmdOrCtrl+F` 계열 — 아래 Ruling 1 |
| T1 자체      | 시험 값 rgb(0 0 0/50%) on white ≈ 3.95 → 3.9~4.1                        | 맞음                                               |
| T2 자체      | "my my My" 3/2, "a "×5000 → 1000 capped                                 | 맞음                                               |
| T3 자체      | 문서 "my notes\nmy-app\nMySQL": my 3개, Aa 켜면 2개, notes 입력 → – / 1 | 맞음                                               |
| T4 자체      | "a a a" → 바꾸기 "b a a", 모두 "b b b", ⌘Z → 원래                       | 맞음                                               |
| T5 자체      | reload 는 setText 로 새 state — old state 를 setText 전에 잡아야 함     | 브리프에 있음                                      |
| T6           | 문서만                                                                  | 맞음                                               |

Ruling 1: T4 의 keys.test 는 문자열 `CmdOrCtrl+Alt+F` 를 그대로 비교하지 말고 `sameAccelerator(b.accelerator, "Alt+CmdOrCtrl+F")` 로 찾는다 — keys.ts 의 기존 표기는 `Alt+CmdOrCtrl+…` 이고 같음 판정 함수가 있다 — 틀리면 시험 하나가 철자 때문에 실패할 뿐.

## Tasks

Task 1: implementer term_c52754f4 (dispatch ctx_6ef948ae4a05) DONE_WITH_CONCERNS 169ac97 — vitest 328.
Ruling: 라이트 `--muted` #6e7781→#656d76 (앱 전체) 받아들임 — 계획의 대비 기준(--muted on --panel-bg ≥4.5)을 기존 값이 못 넘었다 — 틀리면 라이트 보조 글자가 조금 진해질 뿐, 되돌리기 쉬움.
Task 1 review: term_707247b4 (ctx_2539fd2de0b3), diff review-e1c8816..169ac97.diff
Task 1: complete (review Approved, Minor 3 기록: CSS↔DEFAULT 동기화 시험 없음, 채널 범위, hsl 미지원)
Task 2: implementer term_073f4ce0 (ctx_a012897cf057), base 169ac97660f81a26801745a511ba5a478b173880
Task 2: DONE 1981aaa (vitest 5). review term_5b43505e (ctx_cff556a366a9)
Task 2: complete (Approved, Minor 3 parked: 빈일치 단언 약함, 1000 경계, 커서 위 빈 일치가 current)
Task 3: implementer term_1ea18746 (ctx_6fe4191d9148) opus
Ruling: 띠 클래스 접두사 search-bar → find-bar — 사이드바 워크스페이스 검색이 이미 .search-bar 를 쓴다 — 틀리면 이름만 바꾸면 됨
Task 3: DONE 5c491c0 (e2e 347, vitest 333). review opus
Task 3 review: Needs fixes (I1: ⌘F in focused field no select-all; M2). Fix round 1: ctx_aa0d9317710d on term_1ea18746
Task 3 fix1: 7e8b00f (search-bar e2e 14, vitest 333). Concern: Cross-origin 잡음 1/3 실행 — 가이드는 「새로 보이면 변경을 의심」. 최종 리뷰 전에 base 대비 재현 확인 필요(이월). rereview ctx_0e69f8b645ee
Task 3: complete (rereview Approved; Minor 2 parked)
Task 4: implementer term_3ff342aa (ctx_354a3ec7be45) opus
Task 4: DONE_WITH_CONCERNS ab4aa9e (search-bar e2e 21, vitest 333, e2e 354/1 fail windows.spec 부하성). Ruling: 브리프와 갈린 5건 수용 — 모두 Task 3 판정·같은 이유의 scope·Task 5 용 export — 틀리면 이름만 바꾸면 됨
Task 4: complete (Approved 0/0/3; Minor 3건은 Task 5 로 넘김)
Task 5: implementer term_42505bb4 (ctx_f1e46a768615) opus
Task 5: DONE_WITH_CONCERNS 592a0a9 (search-bar 26+app 5, vitest 333, e2e 358/2 부하성). 걱정: 가짜 view 로 togglePanel effect 를 얻음(CM 내부 의존)
Task 5 review: Needs fixes (I1 reload 멈춤 위험; M3). Ruling: 코디네이터 대안(barOpen+ViewPlugin) 대신 리뷰어 권장(가두기+단위 시험) — dispatch 불가·defaultQuery 덮어쓰기 문제 — 틀리면 갱신 때 띠가 닫힐 뿐. fix1 started
Task 5 fix1: 576aa5f (vitest 336, e2e 360 부하 37 실패 0). rereview
Task 5: complete (rereview Approved; Minor parked)
Task 6: complete 86aebcb (docs only; 최종 리뷰에서 함께 읽힘)
Final review: With fixes (C0/I2/M3). vitest 336, e2e 360/0, Cross-origin 0.
Ruling: I2 는 이월하지 않고 고침 — 선택만 바뀌면 캐시로 current, 다시 세기는 30ms 시간 예산 「n+」 + 150ms 미루기 — 1MB 메모부터 타이핑마다 프레임을 먹고 10MB 는 키마다 0.3초라 사용자가 바로 겪는다 — 틀리면 개수 표시가 「n+」 로 덜 정확할 뿐.
Final fix: 7af7138..5106038 (vitest 339, e2e 362/0). final rereview

Merged: 20a71d0 (Final rereview Approved, C0/I0/M6 — Minor 6 은 스모크 문서 「다음 계획으로 넘기는 것」 으로).
