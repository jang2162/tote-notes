# tote-notes 틈 메우기·단축키 후속 보고

기간 2026-10-21, 브랜치 `jang2162/gaps`, 기준 `149245f`. 계획 `docs/superpowers/plans/2026-10-21-tote-notes-gaps-and-shortcuts.md`.

## 사용자 결정 (2026-10-21)

- **⌘Q 는 설정 불가능.** `quit` 을 바꿀 수 있는 명령에서 빼고 고정 키(`tote 종료 ⌘Q`)로 옮겼다(`fbdbfb7`). 녹음 중에는 설정과 함께 메뉴 단축키에서 뗀다.
- **최소 macOS 13.** `bundle.macOS.minimumSystemVersion = "13.0"`(`fbdbfb7`). 번들의 `LSMinimumSystemVersion` 이 `13.0` 임을 `plutil` 로 확인했다. 그래서 「subgrid 를 못 쓰는 WebKit」 이월 행은 해결로 닫았다.

## 태스크별 결과

| Task | 커밋                                                  | 내용                                                                                                                                                                   | 시험(보고 기준)                         | 리뷰                                      |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| 1    | `fbdbfb7`                                             | ⌘Q 고정, 최소 macOS 13, 메뉴 `Slot::Fixed` 일반화                                                                                                                      | cargo 401, vitest 364, e2e 46, 변이 4   | Approved, Minor 3                         |
| 2    | `3e9af3f`, `e22b7cc`                                  | 탭 넘기기의 틈 셋: 다시 불러오는 페이지(`page_loading`), 복원 전 flush 가 받은 탭 보존, 닫기·전환 라운드 중 받기 거절, 복원 끝에 받는 중인 탭을 기다림                 | cargo 405, e2e 반복 80/90/230, 변이 9+5 | 1차 Needs fixes(I2 M4) → 재리뷰 모두 해결 |
| 3    | `679176a`, `b84c7b1`                                  | 단축키 저장이 읽은 표(`shortcutsExpected`)와 저장 맵이 다르면 거절. 기본값과 같은 항목은 비교에서 뺀다                                                                 | cargo 407, vitest 366, e2e 49, 변이 3+3 | 1차 Needs fixes(I1 M3) → 재리뷰 모두 해결 |
| 4    | `63e74f1`                                             | 새 검색어는 직전 검색어의 개수 표시를 물려받지 않고 첫 패스부터 자기 표시를 보인다                                                                                     | e2e 32, 변이 1                          | Approved, Minor 3                         |
| 5    | `ada0a23`                                             | 숫자패드·Insert·Help 녹음, `IntlBackslash` 거절, 녹음을 끝낸 키의 keyup 을 막음                                                                                        | vitest 367, cargo 409, e2e 25, 변이 4   | Approved, Minor 4                         |
| 6    | `77aed3c`, `e5f2f64`, `cdb2a02`, `fa2e439`, `c786b70` | 첫 표 읽기 실패 복구, `--accent-fg`, 모달 이름, 고르개 창 비활성화, lefthook `post-merge`·`post-rewrite`, 떼어 내기 거절 한국어 문구, 검색 띠 바꿈 칸, 녹음 keyup 정리 | `pnpm test` 370, cargo 409, e2e 393     | Approved, Minor 3                         |
| 7    | 이 보고의 커밋                                        | 흔들림 후보 둘 재현, 이월 문서 정리, 이 보고                                                                                                                           | 아래                                    | —                                         |

판정 메모:

- Task 1: Rust 고정 거절은 일반 문구고 화면 문구는 프론트가 만든다.
- Task 6: 녹음 keyup 목록은 **Meta keyup 일 때만** 비운다(브리프는 수식키 넷). ⌥Space 에서 ⌥ 를 먼저 놓으면 뒤따르는 Space keyup 이 줄 버튼을 눌러 녹음이 되살아나기 때문이다. 리뷰가 이 판단이 맞다고 확인했다.

## 흔들림 후보 둘 (Task 7 Step 1)

고치지 않았다. 재현되지 않았고 시험은 그대로다.

| 후보                                                       | 실행               | 결과                       | 부하(1분, 시작→끝) |
| ---------------------------------------------------------- | ------------------ | -------------------------- | ------------------ |
| `panes.spec.ts` 「the old right-edge drop target is gone」 | `--repeat-each=20` | 20 통과, 0 실패            | 30.7 → 43.5        |
| `language.spec.ts` 전체                                    | `--repeat-each=20` | 140 통과(7개 × 20), 0 실패 | 43.5 → 52.5        |

부하가 이월 문서가 말하는 15~28 보다 높았는데도 실패가 없었다. 다시 보이면 개발 가이드 「부하에서만 실패하는 테스트는…」 절차로 base 와 대조한다.

## 이월 문서 정리

「(틈 메우기·단축키 후속에서 해결, 커밋 …)」 을 붙인 행(지우지 않았다):

- `2026-10-20-tote-notes-settings-and-shortcuts-smoke.md`: `--accent-fg`(`e5f2f64`), 녹음할 수 없는 키(`ada0a23`), 첫 표 읽기 실패(`e5f2f64`), 확정 키 keyup(`ada0a23`, `c786b70`), subgrid(**해결 — 최소 macOS 13**, `fbdbfb7`), 모달 이름(`e5f2f64`), 두 창의 동시 저장(`679176a`, `b84c7b1`), `quit` 단축키(`fbdbfb7`).
- `2026-10-20-tote-notes-stability-followups-report.md`: 전환이 아닌 reload(`3e9af3f`), 검색 개수 표시 유지(`63e74f1`, `fa2e439`), 복원 전 닫힘(`3e9af3f`), merge·pull 뒤 `pnpm install`(`77aed3c`), 「79개」 오기.

「79개」 행은 고칠 곳이 없었다. 저장소 문서에서 「79개」 는 그 이월 행의 인용뿐이고(오기는 워커 보고 파일에 있었다), 영문 주석도 이미 「an」 이다. 그래서 행에 확인했다는 말만 붙였다.

## 이번에 닫지 않고 넘기는 것

| 무엇                                                                                                           | 출처                | 까닭·다음 걸음                                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `menu.rs` `shortcut_label` 이 「없음」 을 `None` 과 panic 둘로 나눈다                                          | Task 1 리뷰 Minor 2 | `build` 의 기존 `expect` 와 같은 수준. 통일하려면 둘 다 `Option` 이나 둘 다 panic                                   |
| `shortcut_items()`(`cfg(test)` 전용)와 `build` 의 순회가 두 군데에서 만들어진다                                | Task 1 리뷰 Minor 3 | 지금은 같은 슬롯 순회라 어긋날 위험이 낮다. `build` 가 `shortcut_items()` 를 쓰게 하면 하나가 된다                  |
| `--accent-fg` 는 `button.foreground` 만 보고 `--accent` 는 `button.background → focusBorder → textLink` 순이다 | Task 6 리뷰 Minor 3 | `button.background` 없이 `button.foreground` 만 주는 테마에서 짝이 어긋난다. 낮은 위험                              |
| `modal()` 이 `namingText` 를 부르는 줄을 되돌려도 자동 시험이 실패하지 않는다                                  | Task 6 리뷰 Minor 1 | 아래 화면 확인으로 대신한다. 시험을 더하려면 첫 `p` 가 빈 대화상자의 이름을 `getByRole("dialog", { name })` 로 단언 |
| `Escape` 로 설정을 닫을 때 `onConfigChanged` 구독이 안 풀린다                                                  | Task 6 보고         | 기존 문제. `done` 버튼만 `unsubscribe` 한다                                                                         |
| 바뀐 줄이 없을 때 4열 gap 이 오른쪽에 남는 모양                                                                | 설정·단축키 스모크  | 이번에 안 건드렸다. D-9 에서 실제로 보이는지 본다                                                                   |

## 화면 확인 후보

자동 시험이 닫지 못하는 것이다. 에이전트가 화면을 쓰는 확인이 아직 안 돌았다.

- **숫자패드·Insert·Help 단축키가 실제 메뉴에서 동작하는지.** muda 의 키 변환은 crate-private 라 시험에서 못 불렀다. 소스상 매핑은 있다.
- **⌘ 조합으로 녹음을 끝낸 뒤 keyup 이 도는지.** WebKit 이 ⌘ 를 누른 채 누른 키의 keyup 을 안 낸다는 가정에 기댄다. ⌘K 로 끝내고 ⌘ 를 놓은 뒤 K 를 다시 쳐서 줄이 녹음을 다시 시작하지 않는지 본다.
- **`page_loading` 의 도착 순서.** 실기기에서 `Started` 가 `page_started` 보다 늦게 오면 그 창은 다음 로드까지 「준비 안 됨」 으로 남는다. 탭을 잃지는 않지만(새 창으로 간다) 순서를 확인한다.
- **`post-rewrite` 가 rebase pull 에서 도는지.** `git pull --rebase` 뒤 훅 두 잡(runtime, deps)이 도는지 본다.
- **첫 `p` 가 빈 대화상자의 이름이 실제로 비지 않은 글로 붙는지.** `dialogs.ts` 의 `namingText` 연결은 자동 시험이 되돌려도 실패하지 않는다.
- **진짜 창 비활성화 때 고르개가 키를 돌려주는지.** Playwright 는 `document.hasFocus` 덮어쓰기로 대신했다. 실제 WebKit 이 창 비활성화에서 `hasFocus()` 를 false 로 돌려주는지는 사람이 본다.
- 이월 문서에서 오는 것: 실기기에서 `window.listen` 의 promise 가 리스너 등록 뒤에 풀리는지, 복원 중 받은 탭이 보이고 세션에 쓰이는지.

## 지침 제안

`docs/guideline/lefthook/02-post-checkout.md` 는 사본이라 고치지 않았다. 그 문서의 post-checkout 설명 끝에 새 단락으로 다음을 넣자고 제안한다.

> merge·pull(`post-merge`)과 rebase·amend(`post-rewrite`)는 `post-checkout` 이 돌지 않으므로 같은 설치 잡을 걸어 둔다. 훅을 처음 받은 체크아웃은 `pnpm install` 을 한 번 돌려 훅을 등록한다.
