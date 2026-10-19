# tote-notes 설정 화면 개편·줄번호·단축키 설정 — 실행 판정 기록

계획 `docs/superpowers/plans/2026-10-20-tote-notes-settings-and-shortcuts.md` 를 실행하며 코디네이터가 내린 판정과 태스크 기록이다. 작업 폴더의 진행 기록을 옮긴 것이고, 화면 확인과 다음 계획 후보는 `docs/superpowers/reports/2026-10-20-tote-notes-settings-and-shortcuts-smoke.md` 에 있다.

사용자 결정: 「설정 내용에 따른 분리 필요. 추가적인 개선점은 직접 찾아서 작업해줘」 — 그래서 설계·계획을 따로 검토받지 않고 실행했다. 화면(키보드·마우스)을 쓰는 확인은 사용자가 말할 때로 미뤘다.

Run: run_9533831488bd. Worktree: .worktrees/tote-note/settings-shortcuts (id d7bb71a1-a4d9-42ae-ae2a-85f82765b0a0), base main 37bb75d.
Spec: docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md

## Preflight scan

| 범위  | 생산 / 소비                                                                                                             | 판정                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| T2→T3 | T2 Rust `editor{lineNumbers,fontSize,fontFamily}`, 패치 `editorLineNumbers/FontSize/FontFamily` → T3 TS 타입·가짜       | 이름 일치. 가짜 묶기(11~24) 가 Rust 와 같아야 함 — T3 시험에 있음 |
| T2→T4 | `shortcuts::COMMANDS/FIXED/effective/sanitize/validate` → `MenuShortcuts::apply`, `shortcut_table`                      | 일치                                                              |
| T4→T5 | `ShortcutTable {commands[{id,label,menu,default,current}], fixed[{name,accelerator}]}` → `conflict/shortcutHint`        | 일치                                                              |
| T4→T7 | `suspendShortcuts(on)` → 녹음                                                                                           | 일치                                                              |
| T5→T7 | `formatAccelerator/acceleratorFromEvent/conflict` → 단축키 구역                                                         | 일치                                                              |
| T3→T6 | 패치 키 → 편집기 구역                                                                                                   | 일치                                                              |
| T6→T7 | `openSettings` 의 단축키 패널 자리 → `shortcutsSection`                                                                 | 일치                                                              |
| T1↔T5 | 둘 다 `pane.ts` 빈 칸 문구                                                                                              | T1 은 DOM·CSS, T5 는 문구 — 순차라 충돌 없음                      |
| T1    | 시험(묶음·중심·간격) vs 구현(wrapper+place-content)                                                                     | 자기 일치                                                         |
| T2    | 시험 기대값: open-file 은 new-memo 뒤라 버려짐(COMMANDS 메뉴 순서: install-cli, quit, new-memo, new-window, open-file…) | 일치                                                              |
| T4    | 픽스처 파일 `src-tauri/tests/fixtures/shortcut-table.json` 을 Rust 가 비교하고 vitest 가 읽음                           | 일치                                                              |
| T5    | ⇧⌘\ 자기 자신은 command 충돌이 아님(자기 제외)                                                                          | 일치                                                              |
| T7    | 첫 Esc 녹음 취소, 둘째 Esc 모달 닫기 — dialogs.ts Escape 처리와 capture 순서 확인 필요                                  | 구현 중 판단                                                      |
| T8    | 문서만                                                                                                                  | 일치                                                              |

Ruling: 화면 확인은 계획에서 뺀다(사용자 「마우스 키보드 필요한 작업은 나중에」) — Task 8 이 목록만 쓴다 — 틀리면 병합 뒤 화면 확인에서 발견.

Task 1: complete — b27a6bd (e2e 72 통과, 구분력 실증). 리뷰 Approved, Minor 3 → Task 8 로: 다크의 모든 primary 버튼(확인·버전·설정)이 어두운 글자로 바뀜을 화면 확인 목록에; 테마가 --accent 를 덮을 때 --accent-fg 도 함께 덮어야 함을 다음 계획 이월에.
Task 2: aa3b219 (cargo 386). 리뷰 Needs fixes — Important 1(보조키 없는·⇧만 붙은 단축키 통과).
Ruling: 패치의 숫자 아닌 editorFontSize 는 14 로 바꾸지 않고 거절한다 — 조용히 바꾸는 것보다 잘못된 호출을 드러내는 편이 낫다 — 틀리면 TS 가 숫자만 보내므로 사용자 영향 없음. 계획 문구는 수정 회차가 고침.
Ruling: TS 녹음 규칙(Task 5)은 Rust 와 같게: ⇧ 만 붙은 키는 F 키 포함 거절 — 다르면 TS 가 보낸 패치를 Rust 가 거절.
Task 2 fix round 1: dispatched (task_8bf512137248) on implementer terminal.
Task 2 fix r1: 17f5211 (cargo 387). 남김: 계획 Task 2 Interfaces 의 'shortcuts lenient' 문구 → Task 8.
Task 2: complete — aa3b219, 17f5211 (cargo 387). 재리뷰 All addressed. 남김 → Task 4(그 함수를 만질 때): sanitize doc 주석에 녹음 규칙 한 줄. → Task 8: 계획 Interfaces 의 'shortcuts lenient' 문구.
Task 3: complete — 546aa7d (vitest 282, e2e 305). 리뷰 Approved. 남김 → Task 6: 살아 있는 두 번째 창이 설정 변경 이벤트로 줄번호가 바뀌는 e2e(Review Focus 4). → Task 8 화면 확인: styles.css 의 `font: 12px var(--editor-font)` 두 곳이 사용자 글꼴을 따름.
Task 4: 92daf96 (cargo 392, vitest 286, e2e 305). 리뷰 Needs fixes — Important 1(새로 고침 시 Rust 되돌리기 없음) + Minor 5 전부 수정 회차로.
Task 4 fix r1: 771acf2 (cargo 394, vitest 286). 화면 확인으로: page load 되돌리기, 저장 뒤 최신 맵 걸기(문장은 task-4-fix1-report).
Task 4: complete — 92daf96, 771acf2 (cargo 394, vitest 286). 재리뷰 All addressed. 남김 → Task 8: task-4-fix1-report 의 「화면 확인으로 미룸」 다섯 줄과 debug_assert 를 화면 확인 목록에; shortcuts.rs:198 주석 줄 106자 다시 감싸기.
Ruling: editorBindings 이름은 배포 빌드에서 압축돼 깨짐 → vite keepNames 로 보존(A) — 크기 증가는 데스크톱 앱에서 무시할 만함 — 틀리면 경고 문구가 함수 이름 대신 압축 이름이 됨(화면 확인에서 보임).
Task 5: 81bd05a (vitest 302, e2e 307). 리뷰 Approved, Minor 7. 수정 회차로 1·4·5·7. → Task 7: Minor 2(이름 없는 편집기 명령이면 「편집기 단축키를 가립니다」). → 다음 계획: Minor 3(export 이름 역맵으로 keepNames 걷기), Minor 6(숫자패드·§·Insert·Help 녹음 안 됨).
Task 5 fix r1: 7207251 (vitest 304, e2e 308). 남김: 첫 표 읽기 실패 시 다음 설정 변경까지 보조 문구 비어 있음(의도).
Task 5: complete — 81bd05a, 7207251 (vitest 304, e2e 308). 재리뷰 All addressed.
Task 6: complete — f02c354 (settings.spec 22, e2e 313, vitest 304). 리뷰 Approved. 옛 시험 이름 14개(15 케이스) 모두 새 파일에 있음을 코디네이터가 대조. Minor 1(저장 실패 뒤 같은 값 재시도 막힘) → Task 7. Minor 2·3·4 → 남김(문서 주석·시험 공백·실질 위험 없음).
Task 7: 1ff2fcc (e2e 330, vitest 304). 리뷰 Needs fixes — Important 2(onHide 닿을 길·시험 없음 → 걷기, 단축키 줄 grid 깨짐) + Minor 3·4·6 수정 회차. Minor 5(확정 키 keyup 누출) → Task 8 화면 확인.
Task 7 fix r1: 2b0b61a (e2e 332, vitest 304).
Task 7: complete — 1ff2fcc, 2b0b61a (e2e 332, vitest 304). 재리뷰 All addressed. 남김 → Task 8: subgrid 미지원 WebKit(macOS 13 미만)에서 단축키 줄이 한 열로 무너짐(tauri.conf 에 minimumSystemVersion 없음 — 다음 계획), 바뀐 줄 없을 때 4열 gap 이 오른쪽에 남음(화면 확인), Minor 5 확정 키 keyup 누출(화면 확인).
Task 8: complete — 467ae2c (문서, 시험 없음).
Final review: With fixes — Important 1(바꾸기 뒤 되돌리기가 내부 id 오류로 실패) + Minor 1·2·3 한 번의 수정 회차. 전체 시험 vitest 304, e2e 332, cargo 394.
