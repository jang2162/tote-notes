# tote-notes 안정화 후속 — 실행 판정 기록

계획 `docs/superpowers/plans/2026-10-20-tote-notes-stability-followups.md` 를 실행하며 코디네이터가 내린 판정과 태스크 기록이다. 작업 폴더의 진행 기록을 옮긴 것이고, 결과와 이월 목록은 `docs/superpowers/reports/2026-10-20-tote-notes-stability-followups-report.md` 에 있다.

사용자 결정: 「다음 계획 진행해줘」. 화면(키보드·마우스)을 쓰는 확인은 이번 계획에서 뺐다. CodeMirror 상위 보고 여부는 사용자 결정으로 남겼다.

병합: main 을 `6b03e4c` 로 앞당겼다(병합 커밋 없음). 최종 리뷰 「병합 가능」(C0/I0/M8, vitest 364·cargo 399·e2e 375), Minor 는 문서 수정 회차 `6b03e4c` 로 처리하고 재리뷰 「병합 가능」.

Spec: 새 설계 없음 — 계획의 Spec 절이 이월 문서 넷과 기준 스펙 셋을 가리킨다(판정은 그 스펙 기준, 잠정 아님).
Worktree: .worktrees/tote-note/stability, branch jang2162/stability, base main 47cb440. Run: run_aa3ef98ba5d9.

## Preflight scan

| 짝/태스크 | 겹침                                                               | 결과                                            |
| --------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| T1 ↔ T3   | tear-off.spec·fake.ts 둘 다 손댐(순차)                             | T1 의 `memoWrites`·`pending()` 을 T3 가 써도 됨 |
| T2 ↔ T4   | search-bar.spec 둘 다(T2 는 69~82·200행, T4 는 새 시험)            | 순차, T4 는 T2 의 page.clock 꼴을 따름          |
| T2 ↔ T6   | panes.spec(T2 더블클릭, T6 도우미 합치기)                          | 순차                                            |
| T5 ↔ T7   | development.md(T5 이름 보존 줄, T7 새 줄)                          | 순차                                            |
| T4 자체   | `resume` + `from` 이어 붙이기, crossesLines 는 마지막 to 부터      | 맞음                                            |
| T3 자체   | page_ready: opened false / page_started true / switch_window false | 맞음                                            |
| T5 자체   | gzip 합계가 커지면 멈춤 — 판정 기준이 숫자로 있음                  | 맞음                                            |
| T6 자체   | 항목 8 은 보고만(커밋 없음)                                        | 맞음                                            |

e2e 포트: 이 워크트리는 TOTE_E2E_PORT=1493.

## Tasks

Task 1: implementer term_03f8dee7 (ctx_7ba358227919) opus
Ruling T1: windows restart 흔들림은 가짜 FakeHub 재시작 모델 결함(A 로 고침) — 앱은 실행 때 창을 모두 연다 — Rust 의 같은 틈 여부는 워커가 코드로 확인
Task 1: DONE 1a4794b (질문 msg_1e230ff663e4 미응답으로 B 진행 — 남은 같은 패턴 4개는 수정 회차에서 고치기로 판정). Rust 같은 틈 없음(restore 가 모든 창 먼저 등록). review started
(재시작 뒤 run-use 로 런을 이 터미널 term_6d0b9df1 에 다시 붙임)
Task 1: review Approved C0/I1/M4 → fix round 1 to same implementer (I1 재실행, 질문 A 로 4개 시험, M1·M2)
Task 1: fix1 DONE c128a80 (커서 0 결함 후보 → Task 2 로). re-review started
Ruling T1-fix1: 커서 0 결함 후보(늦은 하이라이트) → Task 2 에서 원인 확인·앱 수정, Cross-origin base 대조도 Task 2 — 같은 증상이라 한 곳에서 판정 — 틀리면 Task 2 가 커짐
Task 1: complete (c128a80, re-review Approved, Minor 2 → layoutWrites 시드는 Task 2 로)
Ruling T2: 커서 0 근본 원인 = @codemirror/view readSelectionRange 포커스 200ms 보정 분기(캐시 미갱신). pnpm patch 한 줄(A)로 고침 — 근본 원인이고 버전 바뀌면 pnpm 이 알림 — 틀리면 패치 걷고 앱 쪽 우회(B/C)
Task 2: DONE 9fb7fe4 28e5d56 7436f4f dba18e9 (CM 패치 + onUpdate 옛 state 갱신 버림 + 신호 대기). review started (opus)
Task 2: complete (Approved C0/I0/M5 → M1·M3·M4 Task 3, M2·M5 Task 7)
Ruling T3: 준비 안 된 창은 drop 후보에서 빼지 않고 leaving=true — 맨 앞 창 원칙이 우선 — 틀리면 뒤 창으로 보내는 동작
Task 3: DONE 9cebc58 (pendingAdopts, page_ready, T2 Minor). review started (opus)
Task 3: review Approved C0/I0/M7 → fix round 1 (M1 리스너 먼저 붙이기 + M2~M4 시험)
Task 3: fix1 DONE d7fa1d2. re-review started
Task 3: complete (d7fa1d2, re-review Approved M3 → Task 7)
Task 4: dispatched opus (노트 없이 나가 send 로 보탬)
Task 4: DONE 78dc3cd. review started (opus)
Task 4: complete (78dc3cd, Approved C0/I0/M3 → M1 스펙 문장 Task 7)
Ruling T5: gzip +6.9KB(네임스페이스 import 가 tree-shaking 을 막음) → 키맵에 걸린 명령만 명시 import + 「모든 바인딩이 이름을 얻는다」 단위 시험으로 keepNames 대체 — 크기 늘지 않음이 조건 — 그래도 크면 Task 5 중단(keepNames 유지)
Task 5: DONE e09bafc (gzip 498,283→492,998). review started
Task 5: complete (e09bafc, Approved M5 → 스펙 낡은 서술·별칭 주석 Task 7)
Task 6: DONE c61b878. review started
Task 6: review Approved M5 → fix round 1 (hsl 단위, NOT_THEMED 구멍)
Task 6: fix1 DONE 090dc1c. re-review started
Task 6: complete (090dc1c, re-review Approved)
Task 7: complete (b286e47). final review started (opus)
Final review: 병합 가능 C0/I0/M8 (vitest 364, cargo 399, e2e 375) → 문서 Minor 한 번에 고치는 회차
Final fix: 6b03e4c. final re-review started
