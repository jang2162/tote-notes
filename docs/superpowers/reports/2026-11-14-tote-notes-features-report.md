# tote-notes 2026-11-14 기능 묶음 결과 보고서

2026-11-13 점검 끝에 추천된 기능 여덟 개를 2026-11-14 에 넣었다. 사용자가 설계 확인 없이 바로 진행하라고 해서, 동작·단축키·기본값은 코디네이터가 정했고 각 스펙에 「누가 정했나」 를 붙여 적었다. 워커 여덟이 두 차례(한 번에 넷)로 나눠 만들고, 브랜치마다 리뷰어(따로 띄운 워커)가 구분력을 실증한 뒤 `main` 에 병합했다. 그 뒤 CI 를 고친 브랜치 둘(`ci-watch`, `ci-tab`)과, 리뷰가 남긴 권고·사소 가운데 사용자 결정이 필요 없는 것을 닫은 `chore/features-followups` 가 이어졌다.

이 문서는 그 묶음의 판단 기록이다 — 무엇을 넣었나, 사람이 화면으로 볼 것, 이월한 것과 그 이유, 알려진 불안정 시험, CI, 다음 병렬 작업을 위한 디스크 한 줄. 각 기능의 결정과 그 출처는 스펙이 정본이다.

## 무엇을 넣었나

기능마다: 사람이 보는 동작 → 스펙 → 지키는 시험(하나 이상).

- **테마 고르개(theme-picker)** — 설정 「테마」 에서 자동·라이트·다크 말고도 설치한 확장의 테마를 하나 고르면 OS 모양과 상관없이 그 테마로 그리고, 창 크롬·메뉴·대화상자·스크롤 막대(네이티브 모양)도 그 테마의 종류를 따른다. 고른 테마의 확장을 끄면 자동으로 그리고 고른 값은 남는다 → `docs/superpowers/specs/2026-11-14-tote-notes-theme-picker-design.md` → e2e `settings.spec.ts` 「a theme picked from an installed extension is drawn whatever the OS, in an open preview too」, Rust `a_theme_files_type_is_read_from_its_installed_extension`(`app/appearance.rs`).
- **빠른 열기·명령 팔레트(quick-open)** — ⌘P 로 상자를 열어 메모와 어느 창이든 열린 외부 파일을 이름의 글자 순서로 찾고(한글·NFD 포함), `>` 로 시작하면 앱 명령을 찾아 실행한다 → `docs/superpowers/specs/2026-11-14-tote-notes-quick-open-design.md` → e2e `quick-open.spec.ts` 「the menu item opens it; typed and Enter, the memo opens in the focused pane」, vitest `quick-open-match.test.ts` 「answers as a fresh search through random edits …」.
- **마크다운 미리보기 보강(md-preview)** — 할 일 목록이 체크박스로 그려지고 누르면 원본의 `[ ]`↔`[x]` 한 글자가 바뀐다(⌘Z 로 되돌림). `http`·`https`·`mailto` 링크는 시스템 앱으로, 워크스페이스 메모 링크는 탭으로 열린다. 코드 블록은 편집기와 같은 문법·테마 색으로 칠한다 → `docs/superpowers/specs/2026-11-14-tote-notes-md-preview-design.md` → e2e `markdown.spec.ts` 「a task list shows checkboxes; a press flips the box in the text, and ⌘Z in the editor flips it back」, vitest `tasks.test.ts` 「pressing every box of many generated documents」.
- **편의 기능(conveniences)** — 문맥 메뉴에 「Finder 에서 보기」·「경로 복사」·「복제」·「다른 워크스페이스로 옮기기」(네이티브 하위 메뉴). 설정 「워크스페이스」 구역에서 어느 창에도 열려 있지 않은 워크스페이스의 이름을 바꾸고 macOS 휴지통으로 옮긴다 → `docs/superpowers/specs/2026-11-14-tote-notes-conveniences-design.md` → e2e `conveniences.spec.ts` 「a memo moves to another workspace under a free name, and the switch finds it there」, 「a memo whose tab asks about a change elsewhere stays, unsaved over that change」.
- **편집기 기본기(editor-basics)** — 대괄호 짝 강조, 「보기 › 줄 바꿈」(⌥Z, 체크 항목), 들여쓰기 설정, 상태 표시줄의 글자 수(설정), 줄번호 옆 접기 표시와 접기 키 → `docs/superpowers/specs/2026-11-14-tote-notes-editor-basics-design.md` → e2e `editor-basics.spec.ts` 「a fold marker folds its block, with the line numbers off too, and ⌥⌘[ folds a heading」, 「the character count shows only with its setting on, and counts the selection」.
- **목록 키보드(list-keyboard)** — 메모 목록·휴지통 목록이 Tab 한 자리의 `listbox` 가 되어 ↑↓·Home·End·Page·Enter·⌘Enter·⌘⌫·⇧F10 으로 쓰이고, ⌘클릭·⇧클릭·⇧↓·⌘A 로 여러 개를 골라 문맥 메뉴의 동작을 한꺼번에 적용한다. 이전 버전 목록·언어 고르기·상태 표시줄의 언어도 키로 된다 → `docs/superpowers/specs/2026-11-14-tote-notes-list-keyboard-design.md` → e2e `list-keyboard.spec.ts` 「⇧F10 and the menu key open the row's context menu, as a right click does」, 「a menu opened from the keys shows under the current row, one from a click at the pointer」.
- **이미지 붙여넣기(image-paste)** — 마크다운 메모에 클립보드 이미지를 붙여 넣거나 이미지 파일을 편집기 위에 놓으면 워크스페이스에 파일로 들어가고 그 자리에 `![](…)` 링크가 들어간다 → `docs/superpowers/specs/2026-11-14-tote-notes-image-paste-design.md` → e2e `image-paste.spec.ts` 「a pasted image goes to the workspace as <memo> 이미지 and its link where the cursor is; the preview shows it」, 「an image dropped on the editor of a memo in another language opens as a tab, not as a link」.
- **전역 빠른 메모(global-quick-note)** — 다른 앱이 앞에 있어도 전역 단축키(기본 ⌃⌥N)로 tote 가 앞으로 와 새 메모를 연다. 메뉴 막대 아이콘(설정 「일반」 의 스위치)에 「빠른 메모」·「Tote Notes 열기」·「종료」 → `docs/superpowers/specs/2026-11-14-tote-notes-global-quick-note-design.md` → Rust `the_default_is_no_app_or_fixed_key`·`quit_writes_every_window_first`, e2e `global-shortcut.spec.ts` 「설정 › 일반 shows the menu bar icon switch, off, and saves it」.

### 사용자가 알아야 할 기본값 (코디네이터의 판단)

- **새 설정의 기본값은 지금 동작과 같다** — 업데이트만으로 보이는 것이 바뀌지 않게. 글자 수는 끔, 메뉴 막대 아이콘은 끔, 줄 바꿈·들여쓰기는 전과 같다.
- **예외 하나: 접기 표시는 기본 켬이다.** 업데이트하면 줄번호 오른쪽에 접기 표시(접을 수 있는 줄에 `⌄`, 접힌 줄에 `›`)가 새로 보인다. 줄번호를 꺼 두었어도 보인다. 설정 「모양 › 편집기 › 접기 표시」 로 끈다(`editor.foldGutter`).
- **⌘P(빠른 열기)·⌥Z(줄 바꿈)는 「양보하는 기본값」 이다.** 이 판 전에 다른 명령에 그 키를 저장해 둔 사람은 그 키가 이기고 새 명령은 키 없이 시작한다. 그 키가 풀리면 기본 키로 돌아온다. ⌥Z 가 있는 동안 미국 자판의 ⌥Z(`Ω`)는 편집기에서 칠 수 없다(설정 › 단축키에서 지우거나 바꾼다).
- **전역 단축키 기본은 ⌃⌥N** 이다. 이것도 앱 명령에 양보한다(이 판 전에 ⌃⌥N 을 앱 명령에 걸어 둔 사람은 전역 키 없이 시작한다).
- **워크스페이스 지우기는 macOS 휴지통으로 옮기는 것이다.** Finder 의 휴지통에서 「되돌려 놓기」 로 되살린다. 백업 폴더는 앱 데이터에 그대로 남고, 되살린 워크스페이스는 같은 ID 라 백업을 이어 쓴다.
- **옛 판으로 되돌리면 고른 테마를 잃는다**(theme-picker 스펙 「데이터·저장」). 옛 판은 `theme.mode` 의 객체 값을 읽지 못해 자동으로 그리고, 설정을 하나라도 저장하면 `"auto"` 로 덮는다. 앱이 깨지지는 않는다 — 릴리스 노트에 적을 것.

### 후속 브랜치가 닫은 것 (`chore/features-followups`)

리뷰가 남긴 권고·사소 가운데 사용자 결정이 필요 없는 것. 항목마다 커밋을 나눴고, 새 시험은 고친 코드를 되돌려 깨지는 것을 보았다.

- **md-preview 체크박스 누르기가 큰 메모에서 창을 붙잡음** — 원인은 `marked.walkTokens` 가 콜백의 답을 단계마다 `Array.concat` 으로 모아 비용이 토큰 수의 제곱으로 느는 것이었다(재어 보니 같은 글의 `Lexer.lex` 22ms 대 `walkTokens` 1,158ms). 같은 순서로 직접 돌고, 바꾸기 전 읽기 한 번에서 상자 목록과 짐작할 줄을 함께 얻는다. `node` 로 `toggleTask` 만 잰 값(부하 9.5, 같은 방법으로 전후): 3,600줄·할 일 1,125개 69ms → 10ms, 12,000줄·할 일 3,750개 816~916ms → 32~33ms. 「누른 상자 하나만 뒤집히거나 아무것도 바뀌지 않는다」 퍼징은 그대로 통과한다. 새 시험: 직접 도는 순회가 `marked.walkTokens` 와 같은 상자 목록을 내는 것, 긴 메모의 누르기가 같은 글의 `Lexer.lex` 10번보다 싼 것(고치기 전 비율 46).
- **list-keyboard 키로 연 문맥 메뉴가 포인터 자리에 뜸** — ⇧F10·메뉴 키로 연 메뉴는 지금 행의 왼쪽 아래 모서리에 뜬다(`showPopupMenu(items, at)` → Rust `popup_menu_at`). 오른쪽 클릭은 그대로 포인터 자리.
- **quick-open 좁혀 찾기 조건을 지키는 시험이 없음** — 고정 시드 무작위 편집 1,500번(⌫, 가운데 고치기, 붙여넣기, 한글 조합 ㄱ→가→각, NFD·NFC) 뒤마다 처음부터 찾은 것과 결과·순서·굵게를 견준다. 조건을 「길이가 같거나 길면」 으로 망가뜨리면 이 시험만 깨진다(ㄱ 다음 「개」 의 결과가 빈다).
- **conveniences** — 옮기기 전 「충돌·삭제 배너」 검사를 지키는 시험(되돌리면 문구가 「저장하지 못해 …」 로 바뀌어 깨진다. 배너 검사가 없어도 저장이 충돌로 거절돼 옮겨지지는 않는다). 이름에 `&` 가 든 워크스페이스가 하위 메뉴에서 `&` 없이 보이던 것(muda 가 `&` 하나를 니모닉 표시로 지운다 — 모든 팝업 항목 글자의 `&` 를 `&&` 로). 「열리는 중」 거절이 영어 사유로 보이던 것(새 오류 코드 `workspace-opening` 과 한국어 문장). 배너가 있을 때의 문구를 스펙이 코드와 다르게 적은 것(스펙을 고쳤다).
- **image-paste** — 편집기 위 놓기의 `accepts()` 검사를 지키는 시험(다른 언어 메모의 편집기 위에 놓은 이미지는 탭으로 열린다). 스펙의 `import_image` 문장(`copy_in` 으로 적혀 있었으나 실제로는 메모리로 읽어 `add_memo` 로 쓴다). 저장 응답을 기다리는 사이의 한글 조합은 e2e 로 **재현되지 않아** 고치지 않았다(아래 「사람 확인」, 시도한 방법은 스펙 「시험」).
- **theme-picker** — `theme_file_type` 의 시험(설치된 확장 폴더에서 JSONC·`type` 없음·깨진 파일·없는 파일·`include` 를 읽는다). 스펙이 e2e 로 적은 「같은 이름 둘의 괄호」 는 vitest 가 본다고 고쳤다.
- **md-preview 사소** — 미리보기 누르기의 두 가드(답이 오기 전에 탭이 칸에서 떠남, 읽기 전용 탭)를 지키는 e2e. 같은 판의 더 새 색 요청(테마가 바뀔 때)이 앞 요청의 남은 블록을 워커에 보내지 않게. 미리보기 처리기(탭의 글을 바꾸고 링크를 여는 요청)를 번들 마크다운 미리보기 뷰어에만 준다(다른 확장의 미리보기 뷰어는 받지 못한다 — 지금은 레지스트리가 번들 뷰어만 싣지만 사용자 확장 뷰어를 들일 때 저절로 이 권한을 얻지 않게).
- **ci-watch 사소** — `docs/guides/development.md` 의 「앱에서는 늦은 감시 이벤트가 무해하다」 근거를 실제 순서(외부 파일 탭은 감시를 먼저 걸고 그 뒤에 연다)에 맞게 고쳤다.
- **개발 문서** — 「앱 명령을 더하면 Rust 의 표, 시험 고정 파일, 가짜 백엔드의 표를 함께 고친다」(설정 화면의 앱 명령 행 수는 이제 가짜의 표에서 계산한다는 것, 고정 단축키 21 은 손으로 고친다는 것), 「`getByRole` 은 `inert` 인 요소도 찾는다」(직접 확인: `inert` 안의 버튼은 찾히고 `aria-hidden` 안의 버튼은 찾히지 않는다).

## 사람 확인

화면·실기기(WKWebView, 실제 입력기, 실제 클립보드·Finder)가 있어야 보이는 것이다. 디버그 앱은 `docs/guides/development.md` 「디버그 앱은 언제나 `TOTE_DATA_DIR` 을 주고 띄운다」 절대로 띄운다.

**먼저 macOS 「키보드 탐색」 설정을 확인한다**(시스템 설정 › 키보드 › 「키보드 탐색」, `defaults read -g AppleKeyboardUIMode`). 이 설정이 꺼진 사람(macOS 기본값)은 Tab 으로 버튼·체크박스에 닿지 않고 ⌥Tab 으로 닿는다 — 앱의 결함이 아니라 macOS 의 관례다(CI 러너에서 이것으로 e2e 가 떨어졌다, 아래 「CI」). Tab 으로 버튼에 닿는 행은 설정을 켠 채와 끈 채(⌥Tab) 둘로 본다.

| 확인할 것                             | 절차                                                                                                                                                                   | 기대                                                                                                                                                                                                                 | 기능              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| ⌥Z 가 실제 메뉴로 가는가              | 편집기에 커서를 두고 ⌥Z                                                                                                                                                | 「보기 › 줄 바꿈」 이 켜지고 꺼진다(체크 표시가 따라간다). 편집기에 `Ω` 가 들어가지 않는다. ⌘ 없는 첫 기본 단축키라 WKWebView 가 글자 입력으로 먼저 먹으면 메뉴가 불리지 않는다 — 그러면 기본 키를 ⌘ 조합으로 바꾼다 | editor-basics     |
| ⌥Z 로 글자를 치던 자판                | ⌥Z 가 글자를 내는 자판(미국 `Ω` 등)으로 편집기에서 ⌥Z. 설정 › 단축키에서 줄 바꿈의 키를 지운 뒤 다시                                                                   | 기본 상태에서는 그 글자를 칠 수 없다(알려진 대가). 키를 지우면 글자가 쳐진다                                                                                                                                         | editor-basics     |
| 괄호 강조·접기 표시의 모양            | 라이트·다크 테마에서 괄호 옆에 커서, 접기 표시에 마우스                                                                                                                | 짝 강조와 짝 없는 괄호의 빨간 글자가 보이고, 접기 표시가 줄번호와 겹치지 않는다. 업데이트한 사람에게 접기 표시가 새로 보인다(기본 켬)                                                                                | editor-basics     |
| 전역 키 — 다른 앱이 앞일 때           | 다른 앱(브라우저 등)을 앞에 두고 ⌃⌥N                                                                                                                                   | tote 가 앞으로 와 마지막으로 포커스된 창에 새 메모가 열리고 편집기가 키를 받는다                                                                                                                                     | global-quick-note |
| 전역 키 — 창이 하나도 없을 때         | 창을 다 닫고(앱은 떠 있음) ⌃⌥N                                                                                                                                         | 최근 워크스페이스의 창이 열리고 새 메모                                                                                                                                                                              | global-quick-note |
| 전역 키 — 등록 실패                   | 다른 앱이 독점으로 잡은 키(예: 그 앱의 전역 단축키)를 설정 › 단축키 「전역」 줄에 녹음                                                                                 | 그 줄에 등록 실패 문구가 보이고 앱은 그대로 쓸 수 있다                                                                                                                                                               | global-quick-note |
| 전역 키 — 녹음 중 해제와 복구         | 앱 명령 줄 하나를 녹음하는 중에 ⌃⌥N, 그 뒤 녹음을 Esc 로 끝내고 다른 앱 앞에서 ⌃⌥N. 녹음 중 창을 닫거나 다른 창으로 포커스를 옮기는 경우도                             | 녹음 중 ⌃⌥N 은 녹음기에 와서 「전역 단축키 … 에 쓰고 있습니다」 가 뜨고, 녹음이 끝나면 전역 키가 다시 동작한다                                                                                                       | global-quick-note |
| 메뉴 막대 아이콘                      | 설정 「일반」 의 스위치를 켠다. 시스템을 라이트·다크로 바꿔 본다. 세 항목을 각각 누른다                                                                                | 아이콘이 두 모양에서 보인다. 「빠른 메모」 는 ⌃⌥N 과 같고, 「Tote Notes 열기」 는 창을 앞으로, 「종료」 는 저장하지 않은 글이 있으면 ⌘Q 처럼 먼저 쓴다                                                               | global-quick-note |
| 네이티브 모양 재적용                  | OS 를 라이트로 두고 다크 확장 테마를 고른다 → 라이트 테마 → `uiTheme` 이 모르는 값이고 파일 `type` 만 있는 테마 → 그 테마의 확장을 끈다 → 다시 켠다 → 앱을 다시 띄운다 | 창 크롬·메뉴·대화상자·스크롤 막대가 고른 테마의 종류를 따르고, 끄면 시스템, 켜면 돌아온다. 다시 띄우면 첫 창부터 그 모양이다                                                                                         | theme-picker      |
| 하위 메뉴와 옮기기                    | 메모 행 오른쪽 클릭 › 「다른 워크스페이스로 옮기기」 › 워크스페이스 하나. 그 워크스페이스를 보이는 창을 하나 띄워 둔 채로도                                            | 하위 메뉴가 네이티브로 그려지고(숨긴 것·이 창의 것 없음), 고르면 메모가 옮겨지고 대상 창의 목록에 바로 나타난다                                                                                                      | conveniences      |
| `&` 가 든 워크스페이스 이름           | 이름이 `R&D` 인 워크스페이스를 만들고 위 하위 메뉴를 연다                                                                                                              | 하위 메뉴에 `R&D` 로 보인다                                                                                                                                                                                          | conveniences      |
| Finder 에서 보기                      | 메모·외부 파일·휴지통 메모 탭에서 「Finder 에서 보기」                                                                                                                 | Finder 가 앞으로 와 그 파일을 선택해 보인다(`open -R`)                                                                                                                                                               | conveniences      |
| 한글 경로 복사                        | 한글 이름 메모(Finder 에서 만든 NFD 이름 포함)에서 「경로 복사」 → 터미널과 메모장에 붙여 넣는다                                                                       | 경로가 깨지지 않고 터미널에서 그 파일이 열린다                                                                                                                                                                       | conveniences      |
| 워크스페이스 지우기와 「되돌려 놓기」 | 설정 「워크스페이스」 에서 닫힌 워크스페이스를 휴지통으로 → Finder 휴지통에서 「되돌려 놓기」 → tote 고르개                                                            | macOS 휴지통에 있고, 되돌려 놓으면 고르개에 다시 보이고 백업(이전 버전)이 이어진다                                                                                                                                   | conveniences      |
| 실제 체크박스                         | 할 일 목록 메모의 미리보기에서 체크박스를 누른다(인용 안·중첩·CRLF 메모 포함). 스크롤한 채로도                                                                         | 누른 상자의 한 글자만 바뀌고 스크롤 자리가 그대로다. 읽기 전용(휴지통) 탭에는 미리보기가 없다                                                                                                                        | md-preview        |
| 체크박스의 ⌘Z                         | 위에서 누른 뒤 ⇧⌘P 로 편집으로 돌아가 ⌘Z                                                                                                                               | 체크 하나가 실행 취소 한 단계로 되돌아간다                                                                                                                                                                           | md-preview        |
| 링크                                  | 미리보기에서 `https` 링크, `mailto` 링크, 같은 워크스페이스 메모 링크(`[회의](<회의 준비.md>)`), `#제목` 링크를 누른다                                                 | 브라우저·메일 앱이 열린다. 메모는 탭으로(열려 있으면 그 자리로). `#제목` 은 미리보기 안에서 스크롤                                                                                                                   | md-preview        |
| 코드 색                               | ` ```ts ` 등 언어가 적힌 코드 블록이 있는 메모의 미리보기, 그 뒤 테마를 바꾼다                                                                                         | 편집기와 같은 색으로 칠해지고 테마를 바꾸면 새 테마 색으로 다시 칠해진다. 큰 메모(1만 줄 넘게)에서 체크박스를 눌러도 창이 멈칫하지 않는다                                                                            | md-preview        |
| 실제 앱 1만 메모 속도                 | `pnpm perf:fixtures` 의 1만 메모 워크스페이스에서 ⌘P 를 열고 한 글자씩 친다                                                                                            | 상자가 바로 뜨고 글자마다 끊김이 없다(vitest 에서는 글자마다 1~5ms, 실제 앱의 JavaScriptCore 에서는 재지 못했다)                                                                                                     | quick-open        |
| ⌘P 와 한글 입력기                     | ⌘P 로 연 상자에서 한글을 조합하며 ↑↓·Enter. ⌘P 가 실제 메뉴 「파일 › 빠른 열기…」 를 부르는지                                                                          | 조합 중의 Enter·화살표는 입력기 몫이고, 조합이 끝난 뒤 Enter 가 고른 행을 연다                                                                                                                                       | quick-open        |
| 키보드로 연 문맥 메뉴의 자리          | 메모 목록에서 ↓ 로 행을 옮기고 ⇧fn F10(또는 「F1, F2 등의 키를 표준 기능 키로 사용」 을 켜고 ⇧F10). 목록 맨 아래 행, 전체 화면, 휴지통 목록에서도                      | 메뉴가 지금 행의 왼쪽 아래 모서리에 뜬다(마우스 포인터 자리가 아니다). 화면 가장자리에서는 화면 안으로 옮겨진다                                                                                                      | list-keyboard     |
| VoiceOver                             | VoiceOver 를 켜고 메모 목록·휴지통 목록으로 Tab, ↑↓, ⇧↓, ⌘A                                                                                                            | 목록으로 읽히고, 지금 행의 이름과 「선택됨」 이 읽힌다. ⌘A·⌘⌫ 가 메뉴로 새지 않는다. 상태 표시줄의 알림이 읽힌다                                                                                                     | list-keyboard     |
| 클립보드 MIME                         | 스크린숏(⌘⌃⇧4), 미리보기 앱의 이미지 복사, 브라우저의 「이미지 복사」 를 마크다운 메모에 ⌘V                                                                            | 셋 다 이미지 파일과 링크가 들어간다. 들어가지 않는 것이 있으면 그 MIME 을 적어 둔다                                                                                                                                  | image-paste       |
| Retina 에서 놓은 좌표                 | Retina 화면에서 Finder 의 이미지 파일을 메모 둘째 줄 끝에 끌어 놓는다                                                                                                  | 링크가 놓은 줄에 들어간다(좌표 단위가 맞다)                                                                                                                                                                          | image-paste       |
| Finder 에서 복사한 파일 붙여넣기      | Finder 에서 이미지 파일을 ⌘C 하고 메모에 ⌘V                                                                                                                            | 무엇이 들어가는지 적는다(파일 이름 글자인지, 이미지인지)                                                                                                                                                             | image-paste       |
| 조합 중 붙여넣기                      | 큰 이미지를 ⌘V 하고 저장 응답이 오기 전에(바로) 한글을 치기 시작한다. 커서를 그대로 둔 채와 다른 줄로 옮겨 친 채 둘                                                    | 링크는 붙여넣은 자리에 들어가고, 치던 음절이 쪼개지거나 링크 뒤로 튀지 않는다. e2e 는 재현하지 못했다 — 링크를 넣는 편집이 조합 중에도 커서를 링크 뒤로 옮기는데, 실제 입력기가 이것에 어떻게 반응하는지가 볼 것     | image-paste       |

## 이월

### 이번에 닫지 않은 것 — 결정이나 큰 작업이 필요하다

- **이름을 정한 뒤 rename 전에 다른 앱이 같은 이름을 만들면 덮는다**(conveniences 리뷰).
  - 무엇: 가져오기·복구·다른 워크스페이스로 옮기기 셋 다 빈 이름을 고른 뒤 `rename` 한다. 그 사이(μs) 다른 앱이 같은 이름의 파일을 만들면 덮어쓴다.
  - 왜 남겼나: 셋을 함께 바꾸는 일이고, `renamex_np(RENAME_EXCL)` 은 macOS 전용 호출이라 다른 플랫폼의 길을 함께 정해야 한다.
  - 닫으려면: `renamex_np(…, RENAME_EXCL)` 로 「없을 때만」 옮기고, 실패하면 다음 이름으로 다시 고르는 작은 함수 하나를 셋이 쓴다.
- **`keyboard-types` 가 두 벌 들어온다**(global-quick-note 리뷰).
  - 무엇: `global-hotkey`(^0.7)와 `muda`(^0.8)가 서로 다른 판을 요구한다.
  - 왜 남겼나: 두 상위 크레이트의 판 제약이라 이 저장소에서 풀 수 없다.
  - 닫으려면: 둘 중 하나가 판을 올리면 잠금 파일을 갱신한다.
- **휴지통 목록은 아직 통째로 다시 그린다**(`replaceChildren`, list-keyboard). 메모 목록처럼 행을 재사용하게 바꾸는 일 — 누르는 중에 다시 그려지면 클릭을 잃는 꼴(개발 문서 「부하에서만 실패하는 테스트는 …」 의 「다시 그려도 클릭이 살아남는다」 항목)이 휴지통 목록에 남아 있다.
- **여러 개를 고른 「경로 복사」**(list-keyboard 스펙 「하지 않는 것」). 여럿을 고르면 항목이 빠진다. 닫으려면 경로 여러 개를 쓰는 네이티브 명령을 하나 더 둔다.
- **트레이 「종료」 를 `app.exit` 로 바꾸는 회귀를 시험이 잡지 못한다**(global-quick-note 리뷰, 후속에서도 못 했다).
  - 무엇: 「종료」 는 `act` 가 `Actions::begin(FlushGoal::Quit)` 을 부르는 것까지 시험한다(`quit_writes_every_window_first`). 그 뒤 한 줄 어댑터(`tray.rs` 의 `App::begin` → `lifecycle::begin`)는 시험이 지나지 않는다.
  - 왜 못 했나: 어댑터가 `AppHandle`(Wry 런타임)에 묶여 있고, 시험에서 앱 손잡이를 만들 tauri 의 `test` 기능(가짜 런타임)을 쓰지 않는다. 쓰려면 이 길의 함수들(`lifecycle::begin`, `quick_note::run`, …)을 런타임에 대해 제네릭으로 바꿔야 한다 — 한 줄을 지키려고 들일 변경이 아니다.
  - 닫으려면: 다른 이유로 tauri `test` 기능을 들일 때 함께 한다.

### 그 밖에 남긴 것

- **image-paste:** 저장 응답을 기다리는 사이의 한글 조합 — 재현되지 않아 고치지 않았다(위 「사람 확인」). 재현되면 조합이 끝난 뒤 링크를 넣는다(`placeLinks` 가 `view.composing` 이면 `compositionend` 를 기다린다). 리뷰가 적은 사소 넷 가운데 스펙의 `import_image` 문장 말고 셋은 기록이 남지 않아 자리를 특정하지 못했다.
- **theme-picker:** 리뷰의 사소 넷 가운데 「스펙이 없는 e2e 를 언급」 만 닫았다. 나머지 셋(가짜 백엔드의 문서 주석 자리, 옛 e2e 제목, 배열로 쓴 `ThemeRef` 를 serde 는 받고 페이지는 받지 않는 차이)은 리뷰 기록이 남지 않아 자리를 특정하지 못했다. 마지막 것은 손으로 고친 settings.json 에서만 생기고, 페이지는 그 값을 자동으로 그린다.
- **quick-open:** 짝 없는 서로게이트 뒤의 이모지가 굵게에서 빠진다. 「한 일의 수」 시험(`FileIndex.counts`)은 배열 할당 회귀를 잡지 못한다(시간 상한만 잡는다).
- **md-preview:** 호스트의 낡은 연결(닫힌 미리보기의 늦은 요청)에 따로 시험이 없다 — 판·`event.source` 검사와 `onShow` 가드가 지킨다. 미리보기를 닫아도 진행 중인 코드 색 작업은 끝까지 돈다(판이 바뀐 것만 멈춘다). 구현 보고서의 개발 문서 제안 둘은 기록이 남지 않아 옮기지 못했다.
- **ci-watch:** Rust 단계들이 `pnpm install` 의 성공에 묶여 있다(설치가 떨어지면 cargo 단계도 건너뛴다). FSEvents 의 `Rescan` 흔들림은 표식 파일로 막지 못한다. 원래 실패의 재현이 갈렸다(구현자 로컬 25/60, 리뷰어 0/180) — 판정은 CI 다음 실행들로 본다.
- **editor-basics:** `pnpm measure:long-line` 은 재리뷰가 다시 재도 경계 200,000 그대로였다(바꿀 것 없음).
- **list-keyboard:** 마지막 회차(AZERTY ⌘Q 고침, 상태 표시줄 충돌 풀이)는 재리뷰 없이 병합했다 — 리뷰어가 정한 고치는 방향 그대로이고 시험이 양쪽을 지킨다.

## 알려진 불안정 시험

`docs/superpowers/reports/2026-11-13-tote-notes-audit-fixes-report.md` 「알려진 불안정 시험」 의 표에 이번 묶음에서 본 것을 더한다. 부하는 `uptime` 1분 평균이고, 워커 넷이 한 머신에서 동시에 빌드·시험을 돌렸다.

| 시험                                                                                                                                                             | 본 것                                                                                                                                                                                                                                                                                | 판단                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memo-list.spec.ts` 의 두 창 시험들(「another window's pick of order applies here」, 「turning the preview off in settings applies to every window at once」 등) | 여러 워커의 전체 e2e 에서 여러 번, 단독 재실행은 통과                                                                                                                                                                                                                                | 전 문서의 두 행과 같은 꼴(가짜 백엔드의 두 창이 `localStorage` 한 덩어리를 나누는 경쟁, 개발 문서 「부하에서만 …」 의 두 창 항목). 앱 결함이 아니다 |
| `switcher.spec.ts` 「hidden workspaces leave the list and give up their number」                                                                                 | 전체 e2e 에서 부하 45 일 때 한 번, 단독 15/15 통과                                                                                                                                                                                                                                   | 부하에서만. 원인은 보지 않았다                                                                                                                      |
| `settings.spec.ts` 의 확장 설치 시험 하나                                                                                                                        | global-quick-note 재리뷰의 전체 e2e 에서 부하 때 한 번, 단독 3/3 통과. 기록에 이름이 남지 않았다 — 확장을 설치하는 시험은 「installing, replacing, disabling and removing a user extension」 과 「installing an extension makes the next file read its language files again」 둘이다 | 부하에서만. 다음에 떨어지면 이름과 첫 줄 메시지를 이 표에 적는다                                                                                    |

## CI

`.github/workflows/ci.yml` 의 첫 실행 셋(`main` 으로의 push):

1. **첫째 — cargo 의 감시기 시험 하나가 떨어졌다.** FSEvents 가 스트림을 열기 직전에 쓴 파일의 이벤트를 부하에서 연 뒤에 전하는 것이 원인이었다. `ci-watch` 가 시험을 표식 파일까지 기다리게 고쳤다(개발 문서 「부하에서만 실패하는 테스트는 …」 의 파일 감시 항목).
2. **둘째 — e2e 하나가 떨어졌다**(`toBeFocused` 가 `inactive`). 러너(`macos-latest`)는 macOS 「키보드 탐색」 이 꺼져 있어 Tab 이 버튼에 멈추지 않는다. `ci-tab` 이 키로 버튼에 닿는 시험을 ⌥Tab 으로 바꿨다(개발 문서 「e2e 가 키로 버튼에 닿게 할 때는 Tab 이 아니라 ⌥Tab 을 누른다」). 러너의 설정은 켜지 않는다 — 꺼진 러너가 macOS 기본값인 사람의 길을 본다.
3. **셋째 — 전부 통과.** 러너에서 e2e 단계가 약 14분 걸린다.

## 디스크

워크트리마다 `src-tauri/target` 이 3~5G 라, 워크트리 넷이 함께 빌드·시험을 돌리면 데이터 볼륨(`/System/Volumes/Data`)이 찼다 — 빌드가 실패하고 체크아웃이 반쯤 실패한 채 남았다. 다음 병렬 작업의 계획에 쓸 한 줄: **동시에 도는 워크트리 수 × 5G 에 여유 10G 를 더한 빈 공간을 시작 전에 `df -h /System/Volumes/Data` 로 확인하고, 모자라면 동시 수를 줄이거나 끝난 워크트리의 `src-tauri/target` 을 먼저 지운다.**
