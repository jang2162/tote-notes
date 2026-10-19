# tote-notes 자유 분할·탭 끌어 떼어 내기·워크스페이스 고르개 — 코디네이터 판정 기록

자유 분할 계획(`docs/superpowers/plans/2026-10-19-tote-notes-free-splits-and-tab-drag.md`)을 실행하며 코디네이터가 사람 대신 내린 판정, 사람이 정한 것, 리뷰에서 미룬 항목, 리뷰 결과, 병합 때 넣기로 한 지침 문장이다. 실행용 진행 기록(git 밖)을 지우기 전에 해당 줄을 원문 그대로 옮겼다. 판정 줄은 `무엇을 정했나 — 왜 — 틀렸다면 드는 비용` 이다. 미룬 화면 확인과 다음 계획으로 넘기는 것은 `2026-10-19-tote-notes-free-splits-smoke.md` 에 정리돼 있고, 「Guideline to add」 줄은 병합 전에 `docs/guides/development.md` 에 반영됐다.

## 사전 점검 표

| Pair / task                                  | Produces → consumes                                                                     | Found                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| T2–T4 layout.ts                              | T2 tree API (old functions kept); T4 consumes, deletes old                              | ok                                                     |
| T3–T4 session.ts / session-sync / controller | T3 changes SessionLayout/RestoredLayout; T4 rewrites restore                            | T3 text allows typecheck to fail until T4 — see ruling |
| T4–T5 controller dragTab / pane-drag.spec    | T4 removes the right-edge target; T5 rewrites dragTab and zones                         | ok (T4 turns the edge test into a centre drop)         |
| T5–T9 tab-bar TabDrag                        | T9 widens drop() with screen coords                                                     | ok                                                     |
| T4–T6 pane.ts PaneHost                       | T6 adds newMemoIn; T4 keeps panes as depth-first leaves                                 | ok                                                     |
| T7 sidebar / controller / styles.css         | independent of T4–T6 except styles.css grid                                             | ok                                                     |
| T8–T9 types.ts tearOffTab / onAdopt          | T8 Rust + TS types, fake compiles; T9 behaviour                                         | ok                                                     |
| T1 → T8/T9                                   | spike report gives the screen-coordinate system and blur behaviour                      | ok                                                     |
| T2 self                                      | numbers re-checked (0.25/0.5 splits, 0.68/0.32, 0.8/0.2, zones 1/4, corner tie → right) | ok                                                     |
| T3 self                                      | old row 3:1 → 0.75/0.25; focusedPane 9 → 0                                              | ok                                                     |
| T4 self                                      | ok                                                                                      |
| T5 self                                      | 600px pane cannot split left/right (300 < 320) → centre                                 | ok                                                     |
| T6–T10 self                                  | ok                                                                                      |

## 사람이 정한 것

- Human: 「질문 건너뛰고 바로 시작해줘」 — no brainstorming questions, no plan review; the person asked for Zed-like splits, a drop mask, free horizontal/vertical splits, a workspace combo above the title filter, empty-pane help with a new-memo button, double-click on the tab bar's free space for a new memo, and Chrome-like tab drag out of the window.
- HUMAN: 「마우스 키보드 필요한 작업은 나중에」 — Task 1 stopped mid screen use. Ruling: all screen work (the rest of T1, T10's screen checks) moves to one batch at the end, run only when the person says so; T2–T9 go ahead without the screen; T8/T9 take T1's partial result and pin assumptions in tests — cost if an assumption is wrong: a fix round after the deferred screen check

## 판정

- Ruling: every task ends with pnpm typecheck and the whole e2e suite green — T3 adapts the controller's SessionSync call minimally (the current row as a row LayoutNode) instead of leaving typecheck red until T4 — a red branch between tasks hides regressions — cost: a few throwaway lines in T3
- Ruling: plan runs without a separate human plan review — the person said 「질문 건너뛰고 바로 시작해줘」 — cost if wrong: rework of a task scoped differently
- Ruling: tasks run one at a time in the one worktree (T1 patches tab-bar.ts temporarily; parallel work would test against it) — cost: wall-clock
- Task 1: question (no empty desktop) — Ruling: drop on the left monitor's menu bar (y≈15), never over another app's window; check the press reached tote-dev first — a missed press would click another agent's Chrome — cost: none
- Task 1: notice — ~/Tote-dev and AppSupport/tote-dev existed before dispatch (16:36, workspace 메모; the person's own pnpm app:dev run). Ruling: leave them; workers check they were not modified during their run instead of absence — cost: none
- Ruling: T2 fix round 1 — I1 as the review's smallest fix plus its test; Minors 1 (nested-path resize test) and 2 (neighbor left-first tie test) added; Minor 3 (removeLeaf of a missing id tidies) and 4 (corner tie by ratio, not pixels — the plan says 「가장 가까운 변」, ratio is accepted) left — cost: none
- Ruling: T3 fix round 1 — I1 (revert the three branches named in the review one at a time, record which tests fail), Minor 3 (comment: RestoredLayout.panes in the layout's leaf order) and Minor 5 (tests: a non-object child inside a sound branch; an old row of three panes); Minors 1 and 2 carried into Task 4's dispatch (Task 4 replaces those lines); Minors 4 and 6 accepted — cost: none
- Ruling: the tab context menu's four split items (spec 「메뉴와 단축키」) are in no task's brief — a plan gap; added to Task 6 — cost: none
- Ruling: .pane DOM order is not the leaf order after a split (elements never move); Task 5/6 e2e pick panes by on-screen position (a helper sorting by top, then left), never by nth — cost: none
- Ruling: T4 Minors 1 (focusPane .catch(report)), 2 (restore into the local panes), 3 (expectBoxes rounds x) and 4 (check the e2e 「Script error」/「Cross-origin」 noise against base) folded into Task 5; 5 (listener left on a detached grip) accepted — cost: none
- Ruling: the 「Script error」/「Cross-origin」 e2e noise also shows on base in full parallel runs — a known-noise line goes into development.md at merge; the same composition race in panes.spec goes to Task 6, in rail.spec to Task 7 (which moves it to switcher.spec) — cost: none
- Ruling: T5 Minors 1 (a test that pins the body-rect zone: inBody(pane, 1/2, 0.24) → top half mask), 2 (splitWithTab comment: splits as the mask showed, not re-measured) and 3 (panesByPosition comment) folded into Task 6; Minor 4 → the development.md noise line says the Cross-origin line did not reproduce on base — cost: none
- Ruling: T6 Minors 1 (tab-menu split of a lone tab → empty new pane; narrow window → TOO_NARROW message), 3 (mousedown+move on the bar's free space shows no .drop-mask) and 4 (hint colour var(--muted)) folded into Task 7; 2 (weak negative tests) accepted — cost: none
- Ruling: T7 fix round 1 — I1 and I2 as the review's smallest fixes with their tests and revert evidence; Minors 1 (windows.rs comment), 2 (keyboard.type, ArrowDown end, Enter on 「새 워크스페이스…」, focus back to the search input) and 3 (aria-activedescendant) included; 4 (focus ring) and 5 (long comment lines) accepted — cost: one fix round
- Task 8: question — Ruling: window_at uses occlusion (skip only the sender; the frontmost window under the point decides — another workspace or leaving → new window), with a test; onAdopt returns void like the other on* handlers — the plan's 「first that contains … skips …」 would drop a tab into a hidden window; Promise<() => void> broke the backend's convention — cost: none
- Ruling: Task 9 brings the target window to the front after a move (windows::focus, as Chrome does) and the adopting window writes its layout at once (narrows the session gap Task 8 reported); a target whose page is still loading misses tote://adopt — rare, left for the final review — cost: none
- Ruling: T8 fix round 1 — I1 via an identity screen_point at the Some(at) entry carrying the assumption; Minor 1 (refuse when the sender is leaving), 3 (serde shape tests for TornOff and Adopt) and 4 (quitting refusal test) included; Minor 2 (a tab adopted by a window whose page missed tote://adopt cannot be opened anywhere until that window closes) goes to Task 9 — reveal of a tab the window does not have opens it there — cost: one fix round
- Ruling: T9 small fix round — Minors 1 (tearOff ignores a doc already leaving), 2a (adoptTab looks up memoTab again after refreshMemos), 3 (fake dropTargets: only open windows occlude; note that leaving is not modelled) and 5 (sender saves its session at once after takeOut) — the drag makes a second tear-off of the same tab easy; Minors 2b (adopt while restoring) and 4 (release the place when the adopted tab cannot be made) go to the final review — cost: one short round
- Ruling: Task 10 (docs) gets no separate review; the final review reads it — cost: a doc error caught later
- Ruling: Final I1 (a drag whose out-of-window pointerup never comes stays alive and the next click drops the tab) fixed before merge with the one-line buttons===0 guard and its test; smoke report Minors 1–3 fixed in the same round; Task 9 「saveSessionNow throws」 closed as unreachable (WriteScheduler.flush never rejects); Minors 4–7 and the two flakes go to the next plan via the smoke report — cost: one fix round

## 미룬 항목

- Task 1: deferred (partial, no measurement — stopped before any press; patch reverted; dev folders untouched). Resume steps in task-1-report.md 「남은 것」; drop point = left monitor menu bar y≈15
- Task 5: minor (deferred): tear-off.spec.ts:92 「a tab being torn off does not take its editor back when shown again」 failed once in a full run (「!둘째」 — Meta+ArrowDown raced the typed key), 10/10 alone; wait for the selection after the click if it returns
- Task 7: minor (deferred): watch.spec 「디스크 버전 replaces」 flaked 3/20 under load (⌘Z raced the replace); judged unrelated, no base comparison — the final review decides whether to compare against base
- Task 9: minor (deferred): if saveSessionNow throws after the hand-over, tearOff rejects for a tab already moved (writes.flush error path unread)

## 지침에 넣기로 한 것

- Guideline to add (at merge): development.md 「디버그 앱은 언제나 TOTE_DATA_DIR…」 first paragraph — when the two dev folders already exist, judge by `find … -newer <marker>` instead of absence (task-1-report.md 「지침 보고」)
- Guideline to add (at merge): development.md — the two sentences in task-5-report.md 「지침 보고」 (known Script error/Cross-origin noise in parallel e2e; composition tests wait for the body text before sending composition events)
- Guideline to add (at merge): development.md e2e — when an overlay takes focus, its side effects (composition end on blur) can silently weaken a discrimination test; prove it by removing the guarded code (task-7-review.md 「지침 보고」); T10 fixes the spec/plan's 48px rail width arithmetic (task-7-report.md)

## 리뷰 결과

- Task 2: review dispatched ctx_7bad82ac5ce7 sonnet
- Task 2: review Needs fixes (C0 I1 M4) — I1 resizeAt freezes a pair when only one side is under its minimum
- Task 2: re-review 1 — all ADDRESSED (one Minor: the nested resize test's value comes from the min-height clamp, delta itself unpinned — accepted)
- Task 3: review dispatched ctx_7dbb2bd58ec0 sonnet
- Task 3: review Needs fixes (C0 I1 M6) — I1 no per-branch revert evidence
- Task 3: re-review 1 — all ADDRESSED
- Task 4: review dispatched ctx_50f842644ba4 opus
- Task 4: review Approved (C0 I0 M5)
- Task 5: review dispatched ctx_401a9ce63e71 opus
- Task 5: review Approved (C0 I0 M4); tear-off.spec:92 failure judged unrelated (menu path, no drag) — a pre-existing race
- Task 6: review dispatched ctx_c604f0caec7e sonnet
- Task 6: review Approved (C0 I0 M4)
- Task 7: review dispatched ctx_799ff6ba8650 sonnet
- Task 7: review Needs fixes (C0 I2 M5) — I1 an open list that loses focus (native menu accelerator) stays open and swallows typing; I2 the composition test no longer discriminates (opening the list blurs the editor)
- Task 7: re-review 1 — all ADDRESSED (Minor: the list closes without restoring focus when the window deactivates — harmless)
- Task 8: review dispatched ctx_408e08270a8d opus
- Task 8: review Needs fixes (C0 I1 M4) — I1 the coordinate assumption is spread over window_at, frame_at and to_window_point while the comment says one function
- Task 8: re-review 1 — all ADDRESSED
- Task 9: review dispatched ctx_15f20e025742 opus
- Task 9: review Approved (C0 I0 M5); the sender's 1s session timer loses no tab (quit flushes; a crash leaves it in both sessions and the next claim opens one)
- Task 9: re-review 1 — all ADDRESSED (one unverified Minor: saveSessionNow error path after the hand-over)
- Final review: With fixes — C0 I1 M7; reviewer ran vitest 278, cargo 372, e2e 300 (load 7–8.5); Review Focus all pinned; no path loses a tab or text
- Final re-review: all ADDRESSED, mergeable
