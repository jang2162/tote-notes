# tote-notes 안전망 — 코디네이터 판정 기록

안전망 계획(`docs/superpowers/plans/2026-10-12-tote-notes-safety-net.md`)을 실행하며 코디네이터가 사람 대신 내린 판정 전부다. 실행용 진행 기록(git 밖)을 지우기 전에 옮겼다. 각 줄은 `무엇을 정했나 — 왜 — 틀렸다면 드는 비용` 이다. 사람이 직접 정한 것은 「사람」으로 표시했다. 사람 판단 항목의 답은 `2026-10-15-tote-notes-safety-net-smoke.md` 「사람 판단 필요」 절에 있다.

## 사전 점검

- 기본: preflight-report.md 의 모든 「제안 판정」을 채택한다(여럿이면 첫 안). 스펙과 부딪히면 스펙이 이긴다.
- B1 (Task 7): Dock 종료·로그아웃은 ExitRequested 로 오지 않는다. objc2 로 tao 델리게이트에 applicationShouldTerminate: 를 단다. **(나) NSTerminateLater 를 먼저 시도**해 실앱에서 flush_done 이 오고 라운드가 끝나는지 확인한다. 안 되면 **(가) NSTerminateCancel + begin(Quit) + app.exit(0)** 로 물러서고, 로그아웃이 취소되는 대가를 보고서 「사람 판단 필요」에 올린다. 창이 없으면 NSTerminateNow. 새 직접 의존은 lockfile 에 이미 있는 objc2 계열만.
- B2 (Task 7·17): TOTE_BACKGROUND=1 창은 화면에 올라오지 않는다. Task 17 은 사람 동의 뒤 TOTE_BACKGROUND 없이(TOTE_DATA_DIR 은 그대로) 띄운다. Task 7 Step 4 의 타이핑 확인은 Task 17 의 「Dock 종료」 행으로 옮기고, Task 7 은 화면 없이 확인한다(osascript quit 뒤 종료까지 시간과 세션 파일 mtime).
- M5 (Task 6): 제안대로. 타임아웃이어도 그 라운드에 막힘 이유가 있으면 대화상자를 띄운다(스펙 「저장 실패는 알린다」 우선); 막힘 없이 멈춘 창만 있으면 finish. 대화상자 중 중복 ⌘Q 는 「묻는 중」 상태로 막는다.
- M8: Task 18 표에 「에이전트 불가 — 사람」 행 자리를 미리 둔다.
- M9: 계약서 테스트 개수 갱신(완료).

## 실행 중 판정 (원문, 시간순)

- Ruling: adopt every preflight 「제안 판정」 (first option when several); spec wins on conflict — cost if wrong: one task's fix round
- Ruling: B1 Task 7 uses objc2 applicationShouldTerminate:, try NSTerminateLater first, fall back to Cancel+begin(Quit) and report logout-cancel cost — Dock quit verified not to reach ExitRequested — cost: unsafe ObjC hook; logout may be cancelled under fallback
- Ruling: B2 Task 17 launches without TOTE_BACKGROUND after consent; Task 7 typing check moves to Task 17 — background windows are not on screen — cost: smoke takes the human's screen (already consented step)
- Ruling: M5 timeout still shows the blocked-save dialog when a block reason arrived — spec "save failures are told" — cost: quit can wait on a dialog
- Ruling: Task 2 rescan race — option B (scan start sequence; registry keeps only a later-started scan) — two windows' rescans can overwrite a fresh install otherwise — cost: one field + few lines; goes into the fix round with review findings
- Ruling: Task 4 Minor 2 fixed now — redo cursor restore only for composition-made undos; plain edits keep CodeMirror redo — spec asks only for IME cursor restore — cost: one fix round
- Ruling: Task 4 fix 1 — drop redo→undoRestores recording (undiscriminable dead path; CM default keeps cursors) — cost: none observed
- Ruling: Task 5 Minor "deferred restore throws → window never writes its session" fixed now — breaks "what you type stays" — cost: small
- Ruling: Task 5 Minor "no-target notice not focused" fixed now (focus latest window) — CLI user must see failure — cost: steals focus on failure
- Ruling: Task 7 Minors fixed now — synchronous Done inside the hook would leave macOS waiting forever; silent early returns hide a quit that skips writing — cost: one small round
- Ruling: Task 9 I1 — spec 「완전한 폴더」 beats brief Step 4 wording; target-side failure fails the snapshot — cost: a disk-full tick produces no snapshot (retried next tick)
- Ruling: Task 9 M1/M3/M4 fixed now (retention per spec letter; stat check on link path; prune continues) — backup correctness is the plan's point — cost: one round
- Ruling: Task 11 M2 fixed now — index save failure must not swallow Modified (another app's edit could be overwritten silently) — cost: none
- Ruling: Task 11 M1/M3/M4 fixed now (cheap, rename-tracking correctness) — cost: one round
- Ruling: Task 12 conflict banner — hold timer/tab-switch saves while banner is up; ⌘W keeps tab; '내 버전' = resave; quit/close flush must not drop the other app's version (snapshot first or keep mine as draft) — spec: 고르게 한다 + nothing lost — cost: extra snapshot at quit or a banner that returns next launch
- Ruling: Task 12 — supersedes earlier quit ruling: at quit/close a conflicted memo keeps disk (other app's) and saves "my version" as a NEW memo (recover-like); drop backup_now if unused — constant time, nothing lost, spec "고르게 한다" — cost: a stray recovered memo after quitting with an unresolved conflict
- Ruling: Task 13 M1 (no line-length cap on match/context → multi-MB channel payloads) and M5 (grep umbrella crate) fixed now — UI hang risk; dependency hygiene — cost: one round
- Ruling: Task 14 M1–M4 fixed now (large-viewer go-to-line, late-file-event regression test, preview-branch test, keyboard open) — cheap, user-visible — cost: one round
- Ruling: Task 15 far jump — option A: pending answers carry viewport tokens guessed from INITIAL state (not cached), replaced by exact tokens on ready — catch-up cannot beat 6.8s on 200k lines; VS Code does the same — cost: briefly wrong colors when jumping into a block comment/template
- Ruling: Task 15 M1 (forget-grammars during multi-round collect leaves stale sent keys) fixed now — extension reinstall correctness — cost: small
- Ruling: Task 16 — background windows run no rAF; measure only rAF-free metrics now (cold start, first tokens, search, memory, watch batch); file-open ×5 and session restore deferred to an on-screen run with human consent during Task 17 using the same script — rules unchanged — cost: two metrics wait for the screen session
- Ruling: Task 16 M (rm -rf under TOTE_DATA_DIR without emptiness check) fixed now — script will run on the human's machine — cost: none
- Ruling: Task 16 M (perf_mark IPC + rAF in builds with metrics off; coloured leak) fixed now — cost: small
- Task 17 resume (2026-10-15): 사용자 "기억 안나, 다시 진행해줘". Ruling: 오염 입력은 출처 불명 외부 키 입력으로 기록만, 오염 메모 보존·판정 근거 제외, paste-text 유지, 포커스 확인 후 입력, 재발 시 기록하고 계속 — 원인 조사는 스모크 목적 밖 — 틀리면 실제 앱 유령 입력 버그를 놓침, 최종 리뷰에서 재확인.
- Task 17 (2026-10-15): 출처 불명 입력 원인 확정 — orca computer paste-text 가 AX 입력 후 ⌘V 로 시스템 클립보드를 한 번 더 붙이는 이중 전달(클립보드 1286B = 덧붙은 글 1286B). 앱 결함 아님. 워커는 이후 set-value(verified) 사용. 앞선 Ruling 의 "유령 입력 버그 놓침" 위험 해소.
- Ruling: Task 17 I2 — not re-checked by agent now (human using machine; launching steals focus); rows → 미확인, added to Task 18 — cost: one more human item
- Ruling: Task 17 (d) overlapping quit dialogs — defect candidate (CloseWindow round asking + Quit, flush.rs:57-60) → final review
- Ruling: Task 17 (a)(b) intended per spec; (c) tool limit; (e) intended 413, wording deferred to next plan; (f)(g) plan/record errors; self-quit: no crash report → not a crash
- Ruling: Task 18 separate task review folded into final review — docs-only transcription of coordinator-recorded results — cost: a transcription error caught one step later
- Ruling: final fix wave = I1, M5, M7 (docs) + M1, M6 (small contained code with tests) — M2, M3, M4 deferred to next plan and written into the report — M3 touches macOS logout answer path (risk of hanging logout), M2/M4 need design — cost if wrong: two confusing-dialog / missed-notice paths ship in this merge, no data loss
- Ruling(human): restore-50 re-measure deferred to after merge (load 26–48 for 1h); worker told to stop and write decisions only
