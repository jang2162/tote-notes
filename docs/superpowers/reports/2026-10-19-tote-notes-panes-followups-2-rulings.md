# tote-notes 칸·창 후속 2 — 코디네이터 판정 기록

칸·창 후속 2 계획(`docs/superpowers/plans/2026-10-19-tote-notes-panes-followups-2.md`)을 실행하며 코디네이터가 사람 대신 내린 판정, 사람이 직접 정한 것, 리뷰에서 미룬 항목, 리뷰 결과다. 실행용 진행 기록(git 밖)을 지우기 전에 해당 줄을 원문 그대로 옮겼다. 판정 줄은 `무엇을 정했나 — 왜 — 틀렸다면 드는 비용` 이다. 미룬 항목 중 다음 계획이 다룰 것은 `2026-10-19-tote-notes-panes-followups-2-smoke.md` 「다음 계획으로 넘기는 것」 절에 정리돼 있다.

## 사전 점검 표

| Pair / task                 | Produces → consumes                                                                                                                                              | Found                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| T1–T2 commands.rs           | T1 tear-off uses cascade; T2 flush_done returns bool                                                                                                             | different functions — ok |
| T2–T3 lifecycle.rs / mod.rs | T2 ack → bool, window_is_leaving; T3 blocked_labels, begin_flush comments, quit filter test                                                                      | different functions — ok |
| T2–T4 fake.ts               | T2 adds staleFlush; T4 removes tearOffDelayMs if unused                                                                                                          | ok                       |
| T1–T5, T2–T5                | smoke checks both on screen                                                                                                                                      | ok                       |
| T1 self                     | numbers checked: corner (4180,1038)→(4156,1014); (500,300)→(524,324); (2740,300)→(2716,324); Dock clamp x 61, menu bar y 33; tall → 1539 at y 33; zero size kept | ok                       |
| T2 self                     | late-answer e2e via staleFlush + requestFlush(77,"switch"); focus test needs the existing cancel path (fake treats save failure as 「취소」)                     | ok                       |
| T3 self                     | ok                                                                                                                                                               |
| T4 self                     | ok                                                                                                                                                               |
| T5 self                     | ok                                                                                                                                                               |

## 사람이 정한 것

- Human: the logout check (F-3·G-7, final review I-1 of the previous plan) is deferred to later by the person.

## 판정

- Ruling: plan runs without a separate human plan review — the person said 「다음 계획 진행해줘」 — cost if wrong: rework of a task scoped differently.
- Ruling: T1's three Minors (cascade unwraps `work` twice; no bottom-only overflow test; no test for cascade's +24 fallback when the probe is on no monitor) folded into Task 3 (Rust tidy-up) — cheap, same file family — cost: none
- Task 2: question — rail mousedown blurs the search input before leave() can remember it (WebKit); proposes mousedown preventDefault on the rail nav (rail.ts, outside the file list). Ruling: approved, on condition the title-on-focus-loss still happens on the switch/close path (e2e shown or onFlush calls it) — cost if wrong: a new memo keeps untitled after a rail switch
- Ruling: T2 race (late flush_done between expire's Done(switch/close) and prepare_switch/closing marking the window) is fixed in this task's fix round — Review Focus 4 says a late answer must not give panes back to a window that is actually switching/closing; the gap can drop typed text silently — cost: one more fix round
- Ruling: T2 rail.ts mousedown preventDefault accepted (outside the file list) — needed for focus restore after a rail click; title-on-switch shown by a new e2e
- Ruling: T2 fix round covers I1 (mark in_switch/closing inside expire_flush's lock, as the review specifies), all five Minors, and the ⚠️ — switchTo settles compositions in every pane before asking the backend, because the rail no longer blurs the editor and the spec says a click settles the composition first — cost: one fix round
- Ruling: T4 Minors 1, 2, 3, 6 (comments naming what each test checks; assert the tab has the failed class before the banner-overlap move) folded into the final fix dispatch; 4 and 5 deferred — cost: none
- Ruling: Task 5 (a report) gets no separate review; the final review reads it and decides the smallest fix for the title-bar height finding — cost: a report error caught later
- Ruling: Final I1 — delete TITLE_BAR_HEIGHT (Tauri 2.12.1's default macOS TitleBarStyle::Visible turns on a full-size content view, so a frame's inner height is the whole window's on every Mac); this overrides the plan's Global Constraint value 「제목 표시줄 28px」, which was wrong — the spec never named 28, and 「위로 24px」 becomes true — cost if wrong: windows overlap the title bar of a non-default style (none in this app)
- Ruling: Final M1–M4, the reviewer's guideline sentence (keep the failing run's test-results), the smoke report's two guideline rows, and the windows.spec.ts:95 handover row go into the same final fix dispatch; the fix worker re-checks C-2 and a full-height restore on screen once
- Ruling: final-fix screen re-check skipped — the Mac screen was locked (person away); the two checks go to the smoke report's person table, unit tests pin the arithmetic — cost if wrong: a title-bar overlap on the real screen found later by the person

## 미룬 항목

- Task 2: minor (deferred): windows.spec.ts:95 failed once at load 34 (unrelated, passed alone x5 and in the second full run) — not on the known load-flake list; final review to judge
- Task 3: minor (deferred): merged begin_flush comment lines are 102/101 chars (mod.rs) — wrap in the final docs pass
- Task 3: minor (deferred): the cascade no-monitor fallback test pins existing behaviour (cannot fail on revert); every_goal_has_one_button_and_one_sentence has no Red evidence
- Task 4: minor (deferred): settings.spec negative assertion relies on one setTimeout(0); panes.spec / pane-drag.spec keep local session builders that may duplicate paneSession

## 리뷰 결과

- Task 1: review dispatched ctx_b8fb6dbd8bca sonnet
- Task 1: review Approved (C0 I0 M3)
- Task 2: review dispatched ctx_d08d58fac4de opus
- Task 2: review Needs fixes (C0 I1 M5 ⚠️1) — I1 the expire race also exists for close rounds; ⚠️ a rail click on a workspace open in another window may no longer settle a composition (no blur now)
- Task 2: re-review 1 — all ADDRESSED
- Task 3: review Approved (C0 I0 M3)
- Task 4: review Approved (C0 I0 M6)
- Final review: With fixes — C0 I1 M4; reviewer ran cargo 357, vitest 254, typecheck (no e2e)
- Final re-review: merge-ready, C0 I0 M4 (M1 smoke L77 label, M2 frame_of comment placement — fixed on main after merge; M3 accepted; M4 guide line added on main)

병합 뒤 main 에서 최종 재리뷰의 Minor 1(스모크 보고서 옛 계산 표시)·2(`frame_of` 주석 자리)·4(화면 잠금 확인 문장, `docs/guides/development.md`)를 반영했다. Minor 3(상수 제거의 구분력은 되돌려 돌린 증거가 아니라 값 차이로 갈음)은 받아들였다.
