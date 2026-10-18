# tote-notes 칸·창 후속 — 코디네이터 판정 기록

칸·창 후속 계획(`docs/superpowers/plans/2026-10-18-tote-notes-panes-followups.md`)을 실행하며 코디네이터가 사람 대신 내린 판정, 사람이 직접 답한 것, 리뷰에서 미룬 항목, 병합 때 넣기로 한 지침 문장이다. 실행용 진행 기록(git 밖)을 지우기 전에 해당 줄을 원문 그대로 옮겼다. 판정 줄은 `무엇을 정했나 — 왜 — 틀렸다면 드는 비용` 이다. 사람이 답한 것은 「HUMAN」 으로 적혔다. 미룬 항목 중 다음 계획이 다룰 것은 `2026-10-18-tote-notes-panes-followups-smoke.md` 「다음 계획으로 넘기는 것」 절에 정리돼 있고, 「Guideline to add」 줄은 병합 전에 `docs/guides/development.md` 와 계획 문서에 반영됐다.

## 사전 점검 표

| Pair / task                      | Produces → consumes                                                                                | Found                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------- |
| T1–T3 lifecycle.rs               | T1 system_quit Waiting/answer; T3 run/stay/switch_window exits                                     | disjoint functions, sequential — ok    |
| T1–T5 lifecycle.rs               | T5 ask_blocked message                                                                             | ok                                     |
| T1–T6 flush.rs/lifecycle finish  | T1 asking_close; T6 T1-3 test line, T1-1 in finish                                                 | ok                                     |
| T3–T4 lifecycle switch_window    | T3 stay at every exit → T4 re-handles held requests at the same exits                              | ok, T4 dispatch carries T3's exit list |
| T3–T5 controller tearOff         | T3 Doc.leaving guard → T5 splits refusal reason                                                    | ok                                     |
| T3–T6 finish destroy failure     | T3 stay → T6 T1-1 reverts closing at same spot                                                     | ok (plan says so)                      |
| T3–T7 tearOff/fake-hub/rail.spec | T3 does T11-5 flush goal + T12-5 → T7 only outside event, takeOut on new tearOff                   | ok                                     |
| T2–T6 windows.rs open_window     | T2 place → T6 T5-1 release on false                                                                | ok                                     |
| T4–T6 mod.rs                     | different functions                                                                                | ok                                     |
| T5–T7 rail.spec/controller       | different tests                                                                                    | ok                                     |
| T8                               | independent                                                                                        | ok                                     |
| T9                               | needs all                                                                                          | ok                                     |
| T1 self                          | Step 1 needs screen (sheet) + stderr log; tests pure                                               | ok — tell human before screen          |
| T2 self                          | numbers checked: C-2 → (4180,1038); (5000,100)→x 4380; big → 1440×2532                             | ok                                     |
| T3 self                          | ⌘N test: fake sets switching=true right after flush, so createMemo refused → test passes vacuously | Ruling 1                               |
| T4 self                          | test 2 「원래 대상 규칙대로」 vague                                                                | Ruling 2                               |
| T5 self                          | E-11 test needs fake to throw for a missing target                                                 | ok (fake throws when !other)           |
| T6 self                          | ok                                                                                                 |
| T7 self                          | many minors, cleanup items without tests (no behaviour change)                                     | ok                                     |
| T8 self                          | load generation `yes` must be killed                                                               | ok                                     |

## 판정·사람 답·미룬 항목 (원문, 시간순)

- Ruling 1: Fake `switchDelayMs` sits between the page's flushDone and the fake's data swap/`switching = true` (it models the real gap between the round's answer and `switch_window`, during which writes are still accepted) — otherwise the ⌘N-while-leaving test passes without a tab — cost if wrong: one fake-only fix round.
- Ruling 2: Task 4 test 2 — after an `Open` failure the held request is re-handled with the window no longer switching; assert it is not lost (imported into its target via `handle`'s existing no-window path, or a notice is pending for the window) — whichever `handle` does today for a target with no window — cost if wrong: test asserts the existing path rather than a new one.
- Ruling 3: Plan executes without a separate human plan review — the user said 「다음계획 진행해줘」 (write and run it) — cost if wrong: rework of a task the user would have scoped differently.
- Ruling: T1 dev 1 — SuspendedEvent keeps only the suspension ID; reply fetched at resume via replyAppleEventForSuspensionID: — Apple's API for it, verified -128 delivered — cost: none seen
- Ruling: T1 dev 2 — asking_close counts switch rounds too — the switch question is the same `.parent` sheet and steps_for_answer treats both alike; spec 「앱 종료를 막는 경우는 저장 실패 하나뿐」 — cost: switch-sheet + quit unverified on screen (Task 9 adds a row)
- Ruling: T1 dev 3/4 — AppCore::asking_close delegate in mod.rs and msg_send! instead of objc2-core-services — no new dependency (Global Constraint) — cost: untyped ObjC calls, guarded by SAFETY comments and a debug encoding check
- Ruling: T1 dev 5 — a refused terminate: answers the quit event with -128 — our handler replaces AppKit's default, so senders would otherwise get success for a cancelled quit — cost: if logout treats -128 differently than the default, logout cancel behaviour differs (G-7, human)
- Ruling: T1 dev 6 — plan Task 1 Step 3 command needs `--` before two filters — fix plan text at the merge doc pass — cost: none
- Note: T1 worker mis-clicked another agent's Chrome page (localhost:5173, wirebound) once via System Events absolute coords; contract now forbids absolute-coordinate clicks. Another agent drives Chrome on the same screen — screen runs may be disturbed (runs 5/6 unexplained auto-confirm).
- Task 1: re-review 1 — all 4 ADDRESSED; new Minors deferred below
- Task 1: minor (deferred): A) second applicationShouldTerminate: during Waiting::Terminate also gets TerminateCancel — AppKit behaviour not measured
- Task 1: minor (deferred): B) resume comment 「Nothing here may panic」 not wholly true (sharedAppleEventManager Retained)
- Ruling: Task 2 runs in parallel with the sheet probe; the probe is told to build only in its own sheet-probe worktree — keeps the plan moving while the probe measures — cost if wrong: a probe build mixing Task 2 edits (the probe records each build's commit)
- Ruling: Task 2 M2 (left/top not clamped: window may overhang a neighbour monitor by 40px/10px) is fixed now — spec 「새 창」 says the whole window goes inside a monitor; plan-mandated algorithm left the gap — cost: one small round
- Ruling: Task 2 M1 (delete unused frame_visible) and M3 (Err logs two lines) fixed in the same round — trivial — cost: none
- Task 2: minor (deferred): M4 no NaN/0-size input test for place (session parse normalises; low priority)
- Probe: question — base 1f3e03d also resolved 「그래도 닫기」; cause was a real HID mouse click (srcpid 0, human-like cursor path) at 23:40:27 / 23:42:23
- Probe: HUMAN ANSWERED — the person clicked the tote dialog while working in another app. Not a code defect. Probe told to stop screen runs, finish the rfd code-path check, clean up.
- Ruling: the "self-resolving sheet" Critical candidate is closed as a human click (person confirmed) — runs 5·6 and f1–f4 likely the same; Task 1's real-app recheck (Step 5 ①②) stands on the first round's results; Task 9 re-measures with the person told to keep hands off — cost if wrong: a real auto-confirm path stays (the probe's code read covers whether any non-click path to 1000 exists)
- Ruling: T3 leave() before the second flushAll — closes the gap the brief's order left (text typed during the second write would be dropped silently); normal order flushAll → leave → flushDone unchanged — cost: none seen
- Ruling: T3 leftovers ② reload() failure after switch_window leaves an empty, write-refusing window (pre-existing refusal; stay would not help) and ③ late onFlush after a round timeout empties the panes after an earlier stay — parked for the final review — cost: a rare stuck-empty window until reload/close
- Ruling: T3 ⑤ rail clicks while leaving are not guarded (only ⌃1–⌃9 per plan) — real app has no gap between answer and switch_window; second request is absorbed as AlreadyRunning — cost: fake-only double round
- Guideline to add at merge (docs/guides/development.md, new section 「zsh 에서 파일 목록은 배열로 넘긴다」): zsh does not split unquoted $VAR; pass file lists to oxfmt/oxlint as FILES=(a b c) arrays — a string passes one bogus path and both tools exit 0
- Probe: worker_done — human click confirmed; no non-button path ends the sheet with 1000 in our code (1f3e03d, 7d68687); trap noted: tauri-runtime-wry set_enabled(true) endSheet (not called). Cleaned up, sheet-probe worktree removed.
- Guideline to add at merge (docs/guides/development.md 「디버그 앱은 언제나 TOTE_DATA_DIR 을 주고 띄운다」, list end): a dialog answered with nobody pressing → suspect a person's/another tool's click first; NSAlert sheet buttons take the first click even when tote is not frontmost; tell with DYLD_INSERT_LIBRARIES wrapping -[NSApplication sendEvent:] and kCGEventSourceUnixProcessID (0 = HID); do not launch via nohup (SIP strips DYLD_*). Source: probe-sheet-report.md 「지침 보고」
- Ruling: T3 fix all six review Minors in one round — M1–M3 spec must state only true behaviour (Global Constraint); M5 doc.leaving stuck on a rejected handOver is a regression; M4 300ms-window e2e must not join the load-flake list (use a test-released gate); M6 the Review Focus #2 exits (Shown/NotSwitched after the write) need an e2e — cost: one fix round
- Task 3: minor (deferred): Rust ended() wiring and the "other window already shows it" exit are pinned only by the pure table and review — app smoke (Task 9) / final review
- Task 3: minor (deferred): an older tearOffDelayMs test still depends on a timer
- Ruling: T4 wrote implementation before watching the tests fail (TDD order broken) — accepted because the revert proof shows each new test fails without its fix — cost: none for correctness
- Ruling: T4 fix all six Minors in one round — M2 (held requests dropped when the window closes mid-switch) breaks the task's 「잃지 않는다」 requirement; M1/M3 are solved by one finish_switch(label) under one lock; M4 doc line; M5 cfg(test) or doc; M6 hold_request returns the request instead of cloning — cost: one fix round
- Task 4: minor (deferred): handle/lifecycle wiring has no unit test (needs AppHandle / tauri test feature)
- Ruling: T5 M1 (tearOff re-implements asksAboutFile's banner test) folded into Task 7's batch — Task 7 already edits controller.ts — cost: none
- Task 5: minor (deferred): save failure + banner together shows only the banner wording; untested
- Task 5: minor (deferred): ask_blocked and blocked_message each match the goal (button label vs sentence)
- Task 5: minor (deferred): blocked_message test placed before its helpers
- Task 6: minor (deferred): begin_flush two comment blocks should merge; one test comment line > 100 chars
- Task 6: minor (deferred): no direct assertion that a focused window without a layout joins the quit round (filter's right side)
- Task 6: minor (deferred): a window restoring a saved layout joins the quit round before its page is up and may wait for the timeout (scope note)
- Ruling: T7 fix round for M1 (leaving never resets), M3 (roundOpen guard testable — add the two-line test), M4 (setPointerCapture throw e2e), M5 (search.spec waits on a real signal before releaseClaim) and resolve both ⚠️ items in the same round — new timing-dependent tests must not join the flake list; cheap tests beat untested guards — cost: one small round
- Task 7: minor (deferred): M2 pageLeaving guard unit-tested in grammars.ts only; M5b hand-built session shapes in search.spec; M6 drag-page comment wording
- Ruling: T8 fix all six Minors in one round — M2/M3 break the base guideline 「도구가 보지 않는 것을 같은 자리에 적는다」 and the brief's 「무엇을 봤고 무엇을 배제했는지」; M1/M4/M5/M6 are a few lines — cost: one small round
- Task 9: question — orca computer click --restore-window after a quit relaunched tote-dev without TOTE_DATA_DIR (01:14:42) → ~/Tote-dev and ~/Library/Application Support/tote-dev created (empty defaults, no memos; coordinator verified). HUMAN APPROVED deletion; worker told to delete, avoid --restore-window on quitting clicks, record under tool limits.
- Guideline to add at merge (docs/guides/development.md 「디버그 앱은 언제나 TOTE_DATA_DIR 을 주고 띄운다」): `orca computer click --restore-window` on a click that quits the app can relaunch it through LaunchServices without TOTE_DATA_DIR, creating the dev folders — do not use --restore-window on quitting clicks
- Ruling: Task 9 (a report) gets no separate task review; the final whole-branch review reads it — cost: a report error caught later
- Guideline to add at merge: smoke report 「지침에 넣을 것」 — no --restore-window on quitting clicks; how to press a UserNotificationCenter alert; the CLI import flag is --import, not -i (plan/brief text said -i)
- Ruling: Final I-1 (logout through the new quit Apple Event handler unmeasured) does not block merge — no code defect found on any path; the person runs F-3/G-7 before release or the next plan; a failure gets a keyAEQuitReason fallback branch in the next plan — cost if wrong: a logout that waits on tote until the person cancels it
- Ruling: Final M-1, M-2 and M-6 fixed in one docs/comment dispatch with every promised guideline line; M-3 (work area), M-4 (cascade direction), M-5 (late flush_done after a timeout) go to the next plan via the smoke report's handover section — cost: those rare cases stay until the next plan
