# tote-notes 스모크 불합격 고치기 보고

2026-10-25, 브랜치 `jang2162/smoke-fixes`, 기준 main `380e535`. 원본은 2026-10-25 스모크 결과다: `2026-10-20-tote-notes-settings-and-shortcuts-smoke.md`(A-2·A-4·A-6·B-3·C-1·D-5), `2026-10-19-tote-notes-free-splits-smoke.md`(B-8·B-12), `2026-10-21-tote-notes-gaps-and-shortcuts-report.md` 「화면 확인 후보」. 화면 확인은 하지 않았다(Orca 권한 확인 창이 떠 있어 키 입력이 막힌다). 실제 앱으로 다시 볼 것은 아래 「화면 확인 후보」 에 있다.

## 항목별 결과

### 1. 메뉴 단축키를 떼는 것이 실제 메뉴에 반영되지 않음 (설정 A-2·A-4·A-6) — `9303cb3`

- **진단.** muda 0.20.0 macOS `MenuChild::set_accelerator` 는 `Some` 일 때만 `setKeyEquivalent` 를 부르고 `None` 이면 아무것도 하지 않는다. 앱의 모든 떼는 길(「없음」 저장, 「모두 기본값으로」 로 기본값이 없는 명령, 녹음 중 `suspend`)이 tauri `MenuItem::set_accelerator(None)` → 이 함수다. 시험 하네스 없는 시험(아래)이 실제 AppKit 메뉴에서 `set_accelerator(None)` 뒤 key equivalent 가 `n` 으로 남는 것을 재현했다.
- **판 올리기를 고르지 않은 까닭.** muda 최신 0.21.2 와 GitHub `dev` 브랜치의 같은 함수가 그대로다. tauri 최신 2.12.4 도 muda `0.20` 에 묶여 있다. 올려도 고쳐지지 않는다.
- **고친 것.** `src-tauri/src/app/key_equivalents.rs`: `NSApp.mainMenu` 에서 하위 메뉴 제목과 항목 이름으로 `NSMenuItem` 을 찾아 key equivalent 와 modifier mask 를 비운다. `menu.rs` 의 슬롯을 `set`/`clear` 둘로 나누고, `put` 이 `None` 과 파싱되지 않는 문자열을 모두 `clear` 로 보낸다(tauri 가 파싱 실패를 `None` 으로 바꿔 옛 키를 남기던 길도 막힌다). 실제 항목 `MenuEntry::clear` 는 tauri 로 muda 의 기록을 맞춘 뒤 AppKit 에서 비운다. 앱 시작 때도 같다: tauri 는 setup 전에 메뉴를 `NSApp` 에 건다(`App::build` 의 `init_app_menu`).
- **다른 우회와 비교.** 항목을 지우고 같은 자리에 다시 만들어 끼우는 길은 tauri 공개 API 만 쓰지만 항목 핸들이 바뀌어 보관한 핸들과 활성 상태를 다시 맞춰야 한다. 메뉴 전체를 다시 짓는 길은 열린 메뉴·창 메뉴 지정까지 다시 해야 한다. NSMenuItem 을 직접 비우는 것이 가장 좁다.
- **시험.** `src-tauri/tests/menu_key_equivalents.rs`(`harness = false`, 메인 스레드에서 muda 로 실제 AppKit 메뉴 막대를 만든다. muda 는 메인 스레드가 아니면 panic 하므로 일반 시험 하네스로는 못 만든다): ① muda `set_accelerator(None)` 뒤 키가 남는다 — muda 가 고치면 이 단언이 실패해 우회를 걷을 때를 알린다 ② `clear` 뒤 키·mask 가 비고, 같은 하위 메뉴의 다른 항목과 다른 하위 메뉴의 같은 이름 항목은 그대로다 ③ muda 가 그 뒤에 다시 거는 키는 제대로 붙는다 ④ 없는 항목·메뉴는 `false`. `menu.rs` 단위 시험: `no_shortcut_and_one_that_does_not_parse_both_take_the_key_off`, `an_item_is_found_by_its_submenu_and_name`(하위 메뉴 안 이름이 겹치지 않음).
- **구분력.** `clear` 의 두 줄(`setKeyEquivalent`·mask)을 지우면 AppKit 시험이 `left: Some(("n", NSEventModifierFlags(1048576)))`/`right: Some(("", NSEventModifierFlags(0)))` 로 실패. `put` 의 파싱 검사를 지우면 단위 시험 `no_shortcut_and_one_that_does_not_parse_both_take_the_key_off` 가 실패. 둘 다 복구 뒤 통과.
- **닿지 않는 것.** tauri `MenuItem<Wry>` 에서 우회로 이어지는 연결(`MenuEntry::clear` 가 `key_equivalents::clear` 를 부르는 것)은 tauri 앱을 띄워야 해서 시험이 없다. 화면 확인으로 본다.

### 2. 메뉴 단축키와 편집기 키가 겹치면 편집기가 이김 (설정 B-3) — `7c9dcbb`

- **진단.** WKWebView 는 키를 페이지에 먼저 주고 페이지가 처리하지 않을 때만 메뉴로 넘긴다(B-3: ⌘L 을 `selectLine` 이 받았다). 설정 화면의 「〈명령〉 을 가립니다」 경고와 기본값 ⇧⌘\·⌥⌘↑↓(편집기 키와 겹침)는 메뉴가 이긴다는 전제다.
- **고친 것(코디네이터 판정 「메뉴가 이긴다」).** `src/shortcuts/keys.ts` `menuKeymap`: 단축키 표에서 지금 키가 편집기 키맵의 키와 같은 명령마다, 그 편집기 바인딩의 키 이름 그대로 바인딩을 만든다(범위 `editor search-panel`, `preventDefault`). `src/editor/setup.ts` 가 이것을 Compartment 안 `Prec.highest(keymap.of(…))` 로 편집기 키맵보다 앞에 둔다. CodeMirror 는 같은 키의 바인딩을 우선순위대로 합쳐 시도하므로 이 바인딩이 먼저 돈다. 누르면 새 Rust 명령 `run_menu_command` → `menu::run_command` 가 그 id 가 앱 명령인지 보고(아니면 `bad-request`), 메뉴 이벤트와 같은 분기(`menu::run`)에 **부른 창**을 넘겨 실행한다. 그래서 `new-window`·`close-window`·`install-cli` 처럼 네이티브에서만 하는 명령도 메뉴와 같다. 단축키 표가 바뀌면(`shortcutsChanged`) 보이지 않는 탭의 상태까지 다시 건다.
- **겹치는 키만 거는 까닭.** 겹치지 않는 키는 페이지가 처리하지 않아 메뉴가 그대로 받는다. 모든 앱 단축키를 페이지에 걸면 페이지 길과 메뉴 길이 둘 다 도는 경우가 있는지 따로 재야 한다. B-3 은 페이지가 `preventDefault` 한 키를 메뉴가 받지 않는다는 것을 보였으므로, 페이지가 가로채는 키는 그 자리에서 메뉴 명령으로 바꾸면 한 번만 돈다.
- **편집기 밖.** 검색 띠 입력칸은 `runScopeHandlers(view, event, "search-panel")` 로 같은 키맵을 돌리므로 범위 `search-panel` 로 함께 덮었다(⌘G·⇧⌘G·⌘↩ 등). 페이지 쪽에서 ⌘·⌃ 조합을 먹는 다른 처리기는 없다(`metaKey`·`ctrlKey`·`altKey` 를 읽는 곳을 셌다: 워크스페이스 고르개(⌃1~⌃9, 고정), 대용량 뷰어(보조키 없을 때만), 검색 띠). 남는 것은 일반 글 입력칸(메모 목록 거르기, 워크스페이스 검색, 설정 입력칸, 대화상자)의 WebKit 기본 편집 키다. 사용자가 그런 키(⌘←·⌥← 류)를 앱 단축키로 걸면 어느 쪽이 받는지는 화면 확인 전이다. 기본값에는 그런 키가 없다. 설계 「알려진 한계」 에 적었다.
- **녹음 중 떼기는 남겼다.** 웹뷰가 먼저 받고 녹음기가 window capture 에서 `preventDefault` 하므로 녹음 중 메뉴 키는 이미 막힌다(B-1·B-2·A-11: 1번 결함으로 떼기가 실제로는 아무것도 안 했는데도 ⌘N·⌘Q·⌘M·⌘H 가 녹음 중 아무것도 실행하지 않았다). 그래도 이것은 다섯 키로 잰 것이지 WebKit 이 모든 키·모든 순간에 이 순서를 보장한다고 확인한 것이 아니다. 떼기는 1번으로 실제 동작하게 됐고 값이 싸서 안전망으로 둔다. 설계 「녹음 중에 명령이 실행되지 않게」 에 근거와 함께 적었다.
- **녹음과의 관계.** 녹음 중에는 포커스가 설정 모달에 있고, 녹음기가 window capture 에서 `stopImmediatePropagation` 하므로 CodeMirror 가 키를 보지 못한다. 이 키맵이 녹음을 방해할 길이 없다(기존 e2e 「the keys pressed while recording reach nothing else」 가 그대로 통과).
- **설계 문서.** `2026-10-20-tote-notes-settings-and-shortcuts-design.md` 「무엇을 바꿀 수 있나」 절의 편집기 단축키 항목(옛 「실제 앱에서 어느 쪽이 받는지는 화면 확인으로 본다」)·「녹음 중에 명령이 실행되지 않게」(옛 「웹뷰가 먼저 받는지 실제 앱으로 재기 전」)·⌘H·⌘M 문단·「알려진 한계」·「시험이 보여야 하는 것」 을 실측과 새 동작으로 고쳤다.
- **시험.** e2e `tests/e2e/shortcuts.spec.ts`: 「an app shortcut that is an editor key too runs the app command, not the editor's」(탭 닫기 ⌘L → 가짜 백엔드 `menuCommandRuns` 가 `["close-tab"]`, 탭이 닫힘), 「an editor key no app shortcut has stays the editor's, and a table change hands it over in every tab」(기본값에서 ⌘L 은 selectLine, 다른 창이 표를 바꾸면 보이는 탭과 숨어 있던 탭 모두 메뉴 명령), 「an app shortcut wins over the search bar's keys in its fields too」(이름 바꾸기 ⌘G, 검색 띠 입력칸에서 ⌘G → `["rename"]`). 단위: `menuKeymap` 두 시험(기본값의 겹침 셋과 ⌘L, 범위·`preventDefault`, 같은 키 하나만), `only_an_app_command_runs_from_the_editor`(Rust, `quit`·`settings`·탭 메뉴 id 거절), `tauri.test.ts` 의 명령 이름.
- **구분력.** `menuKeymap` 이 아무것도 만들지 않게 하면 e2e 셋 모두 실패(첫 실패 `expect(received).toEqual(expected) // deep equality`). 범위에서 `search-panel` 을 빼면 검색 띠 시험만 실패. 숨은 탭을 다시 걸지 않게 하면 표 변경 시험만 실패. 모두 복구 뒤 통과.
- **e2e 가 보는 것과 아닌 것.** e2e 는 페이지가 키를 넘기는지를 본다. 넘긴 명령이 실제 메뉴와 같은 일을 하는지는 Rust 의 같은 분기이고, 실제 앱에서 키가 페이지에 먼저 온다는 전제는 화면 확인이다.

### 3. 글꼴 두 가지 (설정 D-5) — `bb856b1`

- **① 없는 글꼴이 세리프로 떨어짐.** `applyEditorFont` 가 `--editor-font` 를 설정값 하나로 덮어 대체 목록이 없었다. `src/app/editor-font.ts` `editorFontStack` 이 설정값(이름 하나나 쉼표 목록) 뒤에 `var(--large-text-font)` 를 붙인다. CSS 가 따옴표 없이 읽지 못하는 이름(`3270 Nope`, 따옴표·세미콜론이 든 것, `initial` 같은 예약어)은 따옴표로 감싸 한 글꼴 이름이 된다. 그래서 그런 값도 선언 전체가 무효가 되지 않고 기본 고정폭으로 떨어진다. 이것 때문에 기존 e2e 「the editor font size follows the setting but the large text viewer stays at 14px」 의 마지막 기대(못 읽는 값이면 변수가 빈다)를 「따옴표로 감싼 이름 + 기본 목록」 으로 바꿨다 — 옛 시험의 뜻(마지막 값을 남기지 않고 기본 글꼴로 떨어진다)은 그대로다.
- **② 크기를 바꾸면 줄번호가 옛 줄 높이에 남음.** 브리프가 권한 `requestMeasure` 로는 고쳐지지 않는다. 계측해 보니 CodeMirror 의 측정은 돌지만 `contentDOM` 높이가 칸 높이(665px)에 고정돼 글꼴과 상관없이 같아서 「내용 높이가 안 바뀌었다」 고 보고 줄 높이를 다시 재지 않았다(`ViewState.measure` 의 `measureContent` 가 false). CodeMirror 가 줄 높이를 다시 재는 공개된 계기는 테마가 바뀌거나 다시 그릴 때(`mustMeasureContent`)다. 그래서 편집기 글꼴을 Compartment 안의 편집기 테마(`fontEffect`)로 걸고, 설정이 바뀌면 줄번호와 같은 방식으로 모든 탭의 상태(보이는 것은 dispatch, 숨은 것은 state 갱신)를 다시 설정한다. 루트의 `--editor-size`·`--editor-font` 는 편집기 글꼴을 쓰는 다른 화면(검색 토글 등)을 위해 그대로 둔다.
- **시험.** e2e `tests/e2e/settings.spec.ts`: 「a font that is not there falls back to the default monospace, not to serif」(편집기 안에서 `iiiiiiiiii` 와 `MMMMMMMMMM` 의 폭이 같은지로 실제 그려진 글꼴이 고정폭인지 본다. `NoSuchFont Zz`, `3270 Nope`), 「a new font size remeasures the open editors, so the line numbers stay with their lines」(크기를 24 로 바꾸고 애니메이션 프레임 두 번 뒤 줄번호 요소와 줄 요소의 위·높이가 1px 안에서 맞는지). 단위 `src/app/editor-font.test.ts` 4개.
- **구분력.** `editorFontStack` 이 설정값을 그대로 돌려주게 하면 대체 글꼴 e2e(`editorIsMonospace` 단언)와 단위 4개가 실패. 줄번호 시험은 고치기 전 코드(`HEAD` 의 `setup.ts`·`controller.ts`)로 10번 돌려 10번 모두 정렬 단언(`[[39,39,22,37],[61,76,22,37],…]`)에서 실패, 고친 코드로 20번 모두 통과(부하 7.5).
- **줄번호 시험을 처음에 잘못 쓴 것.** 처음에는 정렬을 poll 로 기다렸는데, 고치기 전 코드에서도 통과했다. 마크다운 메모의 색칠이 나중에 다시 그려 우연히 재측정을 일으키기 때문이다. 그래서 poll 대신 프레임 두 번 뒤 한 번만 보고, 색칠이 없는 일반 텍스트 메모를 쓴다. 실제 앱(스모크)에서는 그 우연이 없어 어긋남이 남았다.

### 4. 앱이 비활성화돼도 워크스페이스 고르개가 열린 채 (자유 분할 B-12, 틈 보고 「진짜 창 비활성화 때 고르개」) — `6ef1899`

- **진단.** 목록은 자기 `focusout` 으로만 닫혔다. WKWebView 는 다른 앱이 앞으로 올 때 포커스를 목록에 둔 채 `focusout` 없이 창 `blur` 만 낸다.
- **고친 것.** 목록이 열린 동안 창 `blur` 를 듣고, 오면 닫으며 키를 목록을 열기 전 자리로 돌려준다(창이 돌아오면 그리로 간다). 보기 칸 iframe 으로 포커스가 옮겨 가는 경우는 목록의 `focusout` 이 먼저 와서 닫히고 그때 `blur` 처리기도 떼어지므로 따로 다루지 않는다. `visibilitychange` 는 쓰지 않았다: 앱 전환으로 창이 가려지지 않아도 `blur` 는 온다.
- **지난 시험이 실제와 달랐던 까닭.** 「a list left with the window closes and gives the keys back when the window returns」 는 `document.hasFocus` 를 false 로 덮어쓰고 포커스된 요소를 직접 `blur()` 해서 「창 비활성화」 를 흉내 냈다. 요소를 `blur()` 하면 `focusout` 이 난다 — 다른 브라우저가 창 비활성화 때 하는 일이다. WKWebView 는 요소를 blur 하지 않으므로 그 시험은 실제 앱에서 일어나지 않는 길을 덮고 있었다. 그 시험은 그 길(요소가 blur 되는 브라우저)을 지키도록 남기고 주석을 고쳤다.
- **설계 문서.** 코어 설계 「워크스페이스 고르개」 의 「고르개가 포커스를 잃으면 닫힌다」 에 창 비활성화 때의 동작과 까닭을 더했다.
- **시험.** e2e `tests/e2e/switcher.spec.ts` 「a list left with the app closes on the window's blur alone and gives the keys back」: 목록에 포커스가 있는 채 `window` 에 `blur` 만 보내면 목록이 닫히고 편집기가 포커스를 받고, 넣은 글이 편집기로 간다.
- **구분력.** 창 `blur` 처리기를 걸지 않게 하면 `expect(locator).toBeHidden() failed`. 복구 뒤 통과.

### 5. 탭에 접근성 「누르기」 를 하면 탭이 닫힘 (스모크 보고 「그 밖에 본 것」) — `b59ad7d`

- **진단(WebKit 소스로 확정).** `AccessibilityObject::press()` 는 `actionElement()` 를 누른다. `AccessibilityNodeObject::actionElement()` 는 역할이 `Tab`(그리고 Button·MenuItem·ListItem 등)이면 「저자가 ARIA 요소 안에 진짜 컨트롤을 숨겼는지」 보려고 `nativeActionElement` 로 자손을 훑어 첫 `<button>`·`<select>`·폼 `<input>`·편집 가능 요소를 대신 누른다. 탭의 닫기 표시가 `<button>` 이었다. 그래서 VoiceOver 나 AXPress 로 탭을 고르면 닫기가 눌렸다. 브리프의 「탭이 `mousedown` 으로만 고른다」 도 맞다: 탭 자체에는 `click` 처리기가 없었다.
- **고친 것.** 닫기 표시를 `role="button"`·`aria-label="탭 닫기"` 인 `<span>` 으로 바꿨다(`nativeActionElement` 는 요소 이름으로 `button` 을 찾으므로 span 은 걸리지 않는다). 이제 탭 자체가 누르기를 받고, WebKit 은 탭 가운데를 hit test 해 제목 span 을 누른다. 그 click 이 탭으로 올라와 `event.detail === 0`(포인터 없는 click: 접근성 누르기, `click()`)이면 탭을 고른다. 마우스는 지금처럼 `mousedown` 에서 고른다. 닫기 표시는 여전히 누를 수 있는 버튼이다.
- **남는 위험.** WebKit 은 탭의 가운데를 hit test 한다. 탭이 아주 좁아 가운데가 닫기 표시 위에 오면 누르기가 닫기로 간다. 지금 탭은 제목 앞 12px·뒤 6px 안쪽 여백과 제목이 있어 그렇지 않다.
- **시험.** e2e `tests/e2e/memo.spec.ts` 「pressing a tab as assistive technology does selects it and closes nothing」: 모든 `role="tab"` 안에 `button, select, input, [contenteditable]` 가 없다(WebKit 규칙을 그대로 옮긴 구조 단언), 탭에 `click()` 하면 골라지고 탭 수가 그대로, 편집기가 그 메모를 보인다. 「the close mark of a tab closes it, with the mouse and pressed as a button」: 닫기 표시가 이름 「탭 닫기」 인 버튼으로 찾아지고 마우스 클릭과 `click()` 모두 닫는다. Playwright 는 AXPress 를 못 하므로 구조 단언이 WebKit 규칙을 대신한다 — 실제 누르기는 화면 확인이다.
- **구분력.** 탭의 `click` 처리기를 끄면 「골라진다」 단언(`expect(locator).toHaveText(expected) failed`, 활성 탭이 「나」)이 실패. 닫기 표시를 다시 `<button>` 으로 하면 구조 단언(`expect(received).toHaveLength(expected)`)이 실패. 복구 뒤 통과.
- **지침 문서.** `docs/guides/development.md` 「디버그 앱은 언제나 `TOTE_DATA_DIR` 을 주고 띄운다」 의 탭 누르기 줄을 원인과 지금 상태(화면 확인 전)로 고쳤다.

### 6. 낡은 문서 — `db7ecce`

- 자유 분할 설계 「칸 배치」 절의 「⌘W 로 마지막 탭을 닫은 칸은 지금처럼 빈 칸으로 남는다」 → 탭이 다 빠진 칸은 끌어 냈든 ⌘W 로 닫았든 닫히고 몫과 포커스는 이웃으로 간다(`takeOut`, e2e 「closing the last tab of a pane closes the pane」). 칸이 하나뿐이면 남아 빈 칸 안내를 보인다.
- 자유 분할 스모크 B-8 의 「기대」 칸을 같은 동작으로 고치고, 결과 칸이 본 「나눠 만든 빈 칸에서 ⌘W → 칸이 닫힘」 도 기대에 남겼다.
- 설정 스모크 C-1 의 「기대」 칸: ⇧⌘U 는 「편집기의 redoSelection 을 가립니다」.
- 「결과」 칸은 고치지 않았다(oxfmt 가 표의 칸 폭을 다시 맞춰 구분선 줄이 바뀌었다. `git diff -w` 로 보면 고친 것은 기대 문장뿐이다).

## 화면 확인 후보

자동 시험이 닫지 못하는 것이다. 디버그 번들(`docs/guides/development.md` 「디버그 앱은 언제나 `TOTE_DATA_DIR` 을 주고 띄운다」)로 본다. 메뉴의 단축키 표시는 System Events 로 `AXMenuItemCmdChar`·`AXMenuItemCmdModifiers` 를 읽는다(스모크 A-2 와 같은 방법).

1. **「없음」 저장이 메뉴에서 키를 뗀다(설정 A-2).** 새 메모 줄을 녹음해 ⌃⌥⌘J 로 바꾼 뒤, 그 줄을 다시 눌러 녹음을 시작하고 Backspace(녹음하지 않은 줄에서 Backspace 는 아무 일도 하지 않는다). **기대:** 메뉴 새 메모의 `AXMenuItemCmdChar` 가 비고, ⌃⌥⌘J·⌘N 모두 메모를 만들지 않는다. 메뉴 「파일 › 새 메모」 클릭으로는 만들어진다. 결과(2026-10-25): 합격. 새 메모를 ⌃⌥⌘J 로 녹음(메뉴 J/6, settings `"new-memo": "Ctrl+Alt+CmdOrCtrl+J"`) 뒤 녹음을 다시 시작해 Backspace → 줄 「없음」·「되돌리기」, settings `"new-memo": null`, 메뉴 새 메모 `AXMenuItemCmdChar` 빔(missing value, mods 8). 편집기에서 ⌃⌥⌘J·⌘N → 메모 수 3 그대로, 메뉴 「파일 › 새 메모」 클릭 → `untitled.md` 생김. 같은 방법으로 보낸 ⇧⌘] 는 다음 탭으로 가서 키 전달은 확인. 빈 칸 안내도 「메모 목록에서 메모를 여세요」 로 ⌘N 언급이 빠졌다. 참고: 녹음하지 않은 줄에 포커스만 두고 Backspace 를 누르면 아무 일도 없다 — 절차의 「그 줄에서 Backspace」 는 녹음 중의 Backspace 다.
2. **「모두 기본값으로」 가 기본값이 없는 명령의 키를 뗀다(설정 A-4).** 이름 바꾸기… 를 ⌃⌥⌘U 로 바꾼 뒤 「모두 기본값으로」 → 확인. **기대:** 메뉴 이름 바꾸기… 에 키 표시가 없고 ⌃⌥⌘U 가 「새 파일 이름」 대화상자를 띄우지 않는다. 새 메모는 ⌘N 으로 돌아온다. 결과(2026-10-25): 합격. 이름 바꾸기… ⌃⌥⌘U(메뉴 U/6) → 「모두 기본값으로」 → 「모든 단축키를 기본값으로 되돌릴까요?」 [되돌리기] → 줄 「없음」, 메뉴 이름 바꾸기… 키 빔, 새 메모 N/0, settings `shortcuts` 없음. 편집기에서 ⌃⌥⌘U → 대화상자 없음, ⌘N → `untitled 2.md` 생김.
3. **「바꾸기」 로 빼앗긴 명령의 키가 메뉴에서 사라진다(설정 A-6).** 새 메모를 ⌘O 로 녹음하고 「바꾸기」. **기대:** 메뉴 파일 열기… 에 키 표시가 없고 새 메모가 ⌘O 를 보인다. ⌘O 는 새 메모를 만든다. 결과(2026-10-25): 합격. 새 메모 ⌘O 녹음 → 「파일 열기… 에 이미 쓰고 있습니다」 [바꾸기] → 새 메모 ⌘O·파일 열기… 「없음」, settings `{"new-memo": "CmdOrCtrl+O", "open-file": null}`, 메뉴 새 메모 O/0·파일 열기… 키 빔. 편집기에서 ⌘O → `untitled 3.md` 생김, 열기 대화상자 없음(CGWindowList 에 tote 창 하나).
4. **녹음 중 메뉴 키가 실제로 떼어진다.** 아무 줄이나 녹음을 시작한 채 메뉴 막대를 읽는다. **기대:** 사용자 정의 항목(새 메모, 저장, 설정…, tote 종료 등)의 `AXMenuItemCmdChar` 가 모두 비고, 녹음을 끝내면(Esc) 돌아온다. ⌘H·⌘M 등 macOS 기본 항목은 남는다(뗄 수 없다). 결과(2026-10-25): 합격. 새 메모 줄 녹음 중: 설정…·tote 종료·새 메모·저장·탭 닫기·왼쪽 칸으로·다음 탭·미리보기 전환 등 사용자 정의 항목의 `AXMenuItemCmdChar` 가 모두 빔(mods 8). Hide tote-dev(H/0)·Hide Others·Undo·Redo·Cut·Copy·Paste·Select All·Minimize(M/0)·Toggle Full Screen 은 남음. Esc 로 녹음을 끝내자 ,/0·Q/0·N/0·S/0·W/0·←(vk 123, mods 2)·]/1·V/1 로 돌아옴.
5. **앱을 다시 켜면 저장된 「없음」 이 메뉴에 반영된다.** 1을 한 뒤 「tote 종료」 로 끄고 같은 `TOTE_DATA_DIR` 로 다시 켠다. **기대:** 메뉴 새 메모에 키 표시가 없다(시작할 때 기본값으로 만든 뒤 저장된 값으로 떼는 길이다). 결과(2026-10-25): 합격. 1을 한 뒤 「tote 종료」(종료 코드 0)로 끄고 같은 `TOTE_DATA_DIR` 로 다시 켬 → 메뉴 새 메모 키 빔(missing value, mods 8), 나머지 파일 메뉴 키는 기본값.
6. **편집기와 겹치는 메뉴 단축키는 메뉴가 이긴다(설정 B-3).** 탭 닫기에 ⌘L(경고 「편집기의 selectLine 을 가립니다」). 편집기 1줄 머리에서 ⌘L. **기대:** 탭이 닫히고 줄은 선택되지 않는다. 기본값 그대로 ⇧⌘\ 를 편집기 안에서 누르면 아래로 나뉘고(괄호로 커서가 가지 않는다), ⌥⌘↓ 는 아래 칸으로 간다(커서가 늘지 않는다). 검색 띠(⌘F) 입력칸에서 이름 바꾸기에 건 ⌘G 를 누르면 「새 파일 이름」 대화상자가 뜨고 다음 찾기로 가지 않는다. 새 창을 편집기 키(예: ⌘D `selectNextOccurrence`)에 걸어 편집기에서 누르면 새 창이 한 번만 열린다(메뉴와 페이지가 둘 다 돌지 않는다). 결과(2026-10-25): 합격(네 부분 모두). ① 탭 닫기 ⌘L(경고 「편집기의 selectLine 을 가립니다」, 메뉴 L/0), first 메모 1줄 머리(「줄 1, 열 1」)에서 ⌘L → first 탭이 닫힘, 다시 연 first 의 커서 「줄 1, 열 1」·선택 없음. ② 기본값 ⇧⌘\ 를 `(alpha beta) [gamma]` 의 `(` 바로 앞에서 → 아래로 나뉨(위 칸 y 467–819, 아래 칸 819–1172), 커서 「줄 1, 열 1」 그대로. ③ ⌥⌘↑ → 위 칸, 한 번 더 → 그대로, ⌥⌘↓ → 아래 칸, 한 번 더 → 그대로. 상태 줄에 「커서 N개」 없음. ④ 이름 바꾸기 ⌘G(경고 「편집기의 findNext 을 가립니다」), bracket 메모에서 ⌘F·찾기 `foo`(「– / 2」) 뒤 찾기 칸에서 ⌘G → 「새 파일 이름」(값 `bracket.md`), 개수 「– / 2」 그대로. ⑤ 새 창 ⌘D(경고 「편집기의 selectNextOccurrence 을 가립니다」), 편집기에서 ⌘D → 창 「Alpha — 2」 하나만 생김(4.5초 뒤에도 둘), 원래 편집기 커서 「줄 1, 열 1」·선택 없음. 끝나고 「모두 기본값으로」.
7. **글 입력칸에서 겹치는 키(아직 고치지 않은 것).** 다음 탭에 ⌘← 를 걸고 메모 목록 거르기 입력칸에서 ⌘← 를 누른다. **적을 것:** 커서가 줄 머리로 가는지(입력칸이 이김) 다음 탭으로 가는지(메뉴가 이김). 입력칸이 이기면 「알려진 한계」 대로이고, 바꿀지는 판단할 일이다. 끝나면 되돌린다. 결과(2026-10-25): 입력칸이 이긴다(「알려진 한계」 대로). 다음 탭 ⌘←(경고 「편집기의 cursorLineBoundaryLeft 을 가립니다」, 메뉴 vk 123/mods 0). 탭이 다섯인 칸에 초점을 두고 거르기 칸에 `lin`, 커서 끝(AX 범위 {4,3}) → ⌘← → 커서 머리({1,0}), 활성 탭 `untitled 2` 그대로. 대조로 같은 칸 편집기에서 ⌘← → 다음 탭(first → untitled 2)으로 감. 끝나고 「모두 기본값으로」.
8. **없는 글꼴은 기본 고정폭으로(설정 D-5 ①).** 글꼴에 `NoSuchFont Zz`. **기대:** 편집기 글이 세리프가 아니라 기본 글꼴(SF Mono 류)로 보인다. `3270 Nope`(숫자로 시작)도 같다. 결과(2026-10-25): 합격. 글꼴 `NoSuchFont Zz`·`3270 Nope`(settings `fontFamily` 에 그대로 저장) → 편집기 글이 고정폭으로 보이고, 편집기 영역 잘라 낸 그림이 기본 글꼴(빈 값) 때와 픽셀까지 같음(BMP md5 일치). 대조로 `Georgia` 는 세리프로 바뀜(md5 다름). 끝나고 빈 값으로 되돌림.
9. **글꼴 크기를 바꾸면 줄번호가 바로 맞는다(설정 D-5 ②).** 줄이 여럿인 메모를 연 채 설정에서 글꼴 크기를 24 로. **기대:** 클릭이나 창 크기 바꾸기 없이 줄번호가 각 줄 옆에 맞는다. 다른 창의 편집기와, 그 창에서 숨어 있던 탭을 보였을 때도 맞는다. 글꼴 이름을 바꿀 때도 같다. 결과(2026-10-25): 합격. lines 메모(60줄)를 위 칸에, 숨은 탭 first 를 같은 칸에, 다른 창 「Alpha — 2」 에 markdown 을 연 채 설정에서 글꼴 크기 24 → 클릭·창 크기 바꾸기 없이 찍은 두 창 모두 줄번호가 각 줄 옆에 맞음. ⇧⌘[ 로 숨었던 first 를 보여도 맞음. 크기 24 인 채 글꼴 이름을 `Georgia` 로 바꿔도 두 창 모두 맞음. 줄번호 칸은 AX 에 드러나지 않아 스크린샷으로 봤다. 끝나고 빈 값·14 로 되돌림.
10. **앱이 비활성화되면 고르개가 닫힌다(자유 분할 B-12).** 고르개를 펼친 채 Finder 를 맨 앞으로 했다가 tote 로 돌아온다. **기대:** 목록이 닫혀 있고, 바로 치는 글이 편집기로 간다(목록 항목에 포커스가 남지 않는다). ↑↓·Enter·Esc 는 B-12 의 나머지 절차 그대로. 결과(2026-10-25): 합격. **좌표 클릭을 씀**(코디네이터 허락, 끌기 조건 ①~⑤ 적용 — 고르개 버튼 한가운데 (1519, 489) 왼쪽 클릭 1회, 보내기 전 CGWindowList 로 맨 위 창이 「Alpha」 인지 확인, 첫 시도는 알림 센터 배너가 위에 있어 도구가 보내지 않음, 클릭 전후 칸 셋·탭 그대로). 빈 `untitled 2` 편집기에 포커스를 둔 채 클릭으로 펼침 → Finder 를 맨 앞으로(frontmost 확인) → tote 로 돌아옴 → 목록 닫힘, 포커스 편집기, 키 `a`(2벌식이라 `ㅁ`)가 편집기에 들어가 저장됨(지움). 실제 WKWebView 순서: 창 `blur`(활성=목록) → 목록 `focusout`(relatedTarget=편집기, `hasFocus=false`) → 편집기 `focusin` → 돌아올 때 창 `focus`(활성=편집기). 펼칠 때 버튼에 `focusin` 은 없었다. 참고: 접근성 누르기(AXPress)로 펼치면 버튼이 먼저 포커스를 받아 「열기 전 자리」 가 버튼이 되고, 돌아온 뒤 포커스가 편집기가 아니라 버튼에 남는다(목록은 닫힘). VoiceOver 로 버튼을 눌러 연 사람에게는 맞는 자리로 볼 수 있다.
11. **탭 누르기는 탭을 고른다.** 탭 둘을 연 채 비활성 탭에 접근성 누르기(`orca computer click --element-index`, AXPress). **기대:** 그 탭이 골라지고 닫히지 않는다. 닫기 표시(×, 이름 「탭 닫기」)에 누르기를 하면 그 탭이 닫힌다. VoiceOver 로 탭을 VO-Space 해도 같다. 결과(2026-10-25): 합격(탭 고르기) · 사람 확인(닫기 표시·VoiceOver). 탭 다섯인 칸의 비활성 탭 first 에 `orca computer click --element-index`(AXPress) → first 가 `tab.active`, 탭 수 5 그대로, 파일 수 그대로. 닫기 표시는 접근성 트리에 따로 없다 — 탭(`AXRadioButton`)의 자식이 드러나지 않고 이름만 「first 탭 닫기」 처럼 합쳐진다(ARIA `tab` 은 자식을 표현용으로 다룬다). 그래서 닫기 표시에 누르기는 할 수 없었고, 스크린리더가 탭 이름을 「… 탭 닫기」 로 읽을 수 있다. VoiceOver VO-Space 는 사람이 본다.

12. **고르개를 연 채 다른 칸의 뷰어 iframe 을 누른다(리뷰가 더한 후보).** **기대:** 목록이 닫히고 포커스가 iframe 에 남는다(편집기로 끌려가지 않는다). 실제 WKWebView 의 `focusout`·창 `blur` 순서를 적는다 — Playwright WebKit 에서는 `focusout`(relatedTarget 없음) → 창 `blur` 였다. 결과(2026-10-25): 합격. **좌표 클릭을 씀**(10과 같은 조건 — 고르개 버튼 (1519, 489), 미리보기 iframe 한가운데 (2285, 1011), 각각 맨 위 창 「Alpha」 확인 뒤 왼쪽 클릭 1회). 위 칸 빈 편집기에 포커스, 아래 오른쪽 칸에 markdown 을 미리보기 전환(⇧⌘V)으로 띄운 채 고르개를 펼치고 iframe 을 클릭 → 목록 닫힘, 포커스 AX 「뷰어」 웹 영역(2초 뒤에도 그대로), 초점 칸이 미리보기 칸으로 옮김, 탭 그대로. 실제 WKWebView 순서: 목록 `focusout`(relatedTarget 없음, `hasFocus=true`) → 창 `blur`(활성=`viewer-frame`) — Playwright WebKit 과 같다. 그 뒤 편집기 `focusin` 은 없었다.

## 넘기는 것

| 무엇                                                                                                                                              | 출처                                                                                                    | 까닭·짚은 원인                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 줄번호를 끈 순간 비활성 창의 다른 칸 선택 강조가 거터 폭만큼 어긋나 남았다가 창이 활성화되면 바로잡힘                                             | 설정 스모크 D-3, 스모크 보고 「그 밖에 본 것」                                                          | 원인 미확인. 후보: 거터를 빼는 DOM 갱신은 dispatch 에서 바로 일어나지만 선택 강조(`drawSelection` 층)는 측정 단계(requestAnimationFrame)에서 다시 그린다. 비활성 창에서 WKWebView 가 그 프레임을 미루면 창이 활성화될 때까지 옛 자리에 남는다. 다시 잴 때는 비활성 창에 `requestAnimationFrame` 콜백이 언제 도는지 계측한다.                                                                                                                                                                                                                                                                                                                                   |
| 재시작 복원 뒤 가장 큰 창의 제목이 「Alpha」 에서 「Alpha — 3」 으로 바뀜                                                                         | 자유 분할 스모크 B-18, 스모크 보고 「그 밖에 본 것」                                                    | 원인 짚음: 제목 번호는 창의 정체가 아니라 그 워크스페이스의 창을 연 순서다(`AppCore::titles_of` 가 `windows_of` 순서로 `window_title(name, nth)`). 복원은 창을 다른 순서로 다시 열 수 있어 같은 창이 다른 번호를 받는다. 번호를 창에 붙여 둘지는 판단할 일이다.                                                                                                                                                                                                                                                                                                                                                                                                |
| 새로 고칠 때 콘솔 `Fetch API cannot load ipc://localhost/suspend_shortcuts due to access control checks.`                                         | 설정 스모크 A-9, 스모크 보고 「그 밖에 본 것」                                                          | 원인 짚음: 녹음 중 새로 고치면 `pagehide` → 녹음기 `stop()` 이 `suspendShortcuts(false)` 를 보내는데, 문서가 떠나는 중이라 WebKit 이 그 IPC fetch 를 끊고 이렇게 적는다. 메뉴 키는 Rust `on_page_load` 의 `resume_if` 가 되돌리므로 동작에는 영향이 없다. 잡음을 없애려면 `pagehide` 길에서는 IPC 를 보내지 않는다(되돌리기는 Rust 가 한다).                                                                                                                                                                                                                                                                                                                   |
| 대용량 뷰어 도구 막대가 좁은 칸에서 두 줄로 접힘                                                                                                  | 설정 스모크 D-6, 스모크 보고 「그 밖에 본 것」                                                          | 원인 미확인. `.large-text-bar` 는 `flex-wrap` 이 없는 flex 이므로 막대 자체가 아니라 자식 안의 글(줄 수·상태 문구)이 줄바꿈되는 것으로 보인다. 후보: 자식에 `white-space: nowrap`·`min-width: 0` 이 없다. 좁은 칸 스크린숏으로 어느 자식이 접히는지부터 본다.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 검색 토글 `Aa`·`.*` 가 편집기 글꼴 종류를 따르고 12px 고정                                                                                        | 설정 스모크 D-7                                                                                         | 의도 판단(사람 확인 행). `.search-toggle` 이 `font: 12px var(--editor-font)` 다. 이번 3번으로 `--editor-font` 는 설정값 뒤에 기본 고정폭 목록이 붙은 값이 되었다(없는 글꼴이면 고정폭). UI 글꼴로 바꿀지는 사람이 정한다.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| settings.json 을 손으로 고쳐 글꼴 이름에 줄바꿈·제어 문자가 들면 `.cm-scroller` 규칙 전체가 무효가 되어 글꼴 크기까지 기본(13px)으로 떨어진다     | 스모크 불합격 고치기 리뷰 Minor 1                                                                       | `src/app/editor-font.ts` 가 따옴표로 감쌀 때 `"`·`\` 만 이스케이프한다. 설정 화면 입력칸은 한 줄이고 `trim()` 해서 손으로 고칠 때만 생긴다. 고칠 방향: `\n`·`\r`·`\f` 를 CSS 이스케이프(`\a `)로 바꾸거나 제어 문자를 지우고, `editor-font.test.ts` 에 한 줄 (마무리 회차에서 해결, 커밋 `a23d613`: 따옴표 안의 줄바꿈을 CSS 이스케이프로 쓴다)                                                                                                                                                                                                                                                                                                                |
| tauri `MenuItem` 에서 AppKit 지우기(`MenuEntry::clear`)로 가는 연결을 시험이 덮지 않는다                                                          | 스모크 불합격 고치기 리뷰 Minor 2(구현이 밝힌 공백)                                                     | 연결을 되돌려도 시험이 통과함을 리뷰가 실증했다. 위험은 낮다 — 화면 확인 후보 1~5 가 실제 메뉴로 덮는다 (마무리 회차: 코드 변경 없음. 화면 확인 후보 1~5 가 2026-10-25 화면 확인에서 합격해 실제 메뉴로 덮였다. 그 연결을 보는 자동 시험은 여전히 없다)                                                                                                                                                                                                                                                                                                                                                                                                        |
| e2e `tests/e2e/shortcuts.spec.ts:710` 「an app shortcut that is an editor key too runs the app command, not the editor's」 가 부하에서 한 번 실패 | 마무리 회차 리뷰 「실행 개수」(`smoke-fixes-3` 워크트리 `.superpowers/handoff/smoke-fixes-3-review.md`) | 이 브랜치와 무관한 기존 시험이다(마무리 회차 diff 가 건드리지 않은 파일·경로). 표본: 전체 실행 1/2(부하 9→30), 같은 시험 단독 `--repeat-each=20` 0/20(부하 30). 첫 줄 `Expected: "줄 1, 열 3" / Received: "줄 1, 열 2"`(717행, `page.keyboard.type("하나")` 뒤 5초 동안 열 2). 스냅숏에 편집기 내용이 없어 글자가 빠졌는지 상태 표시만 늦었는지는 가르지 못했다. 다음에 볼 것: `docs/guides/development.md` 「부하에서만 실패하는 테스트는 시간 대신 완료 신호를 기다리게 고친다」 를 따라 재현을 부하와 함께 적고, 실패한 실행의 `test-results/` 를 옮겨 둔 뒤, 편집기 본문(`view.state.doc`)과 `.status-position` 을 따로 단언해 어느 쪽이 늦는지부터 가른다 |

## 재개 스모크 불합격 고치기

2026-10-25, 브랜치 `jang2162/smoke-fixes-2`, 기준 main `c56f743`. 원본은 재개 스모크(워크트리 `jang2162/smoke-run`, 아직 main 에 병합 전)의 불합격 세 행이다: 검색 띠 B-5·A-4, 설정 B-8. 화면 확인은 하지 않았다(다른 워커가 화면에서 디버그 앱을 쓰고 있어 e2e 도 headless 만 돌렸다). 실제 앱으로 다시 볼 것은 아래 「이 회차의 화면 확인 후보」 에 있다.

### 1. 모두 바꾸기 뒤 메뉴 편집 › Undo 가 본문을 되돌리지 못함 (검색 띠 B-5) — `1cc47f7`

- **원인(WebKit 소스로 확정).** 시스템 Undo 항목은 `undo:` 를 first responder 로 보내고, WKWebView 의 `NSUndoManager` 에서 한 칸을 꺼낸다. 그 칸은 WebKit 이 스스로 한 편집(`WebViewImpl::registerEditCommand`)뿐이다. 꺼낸 칸을 되돌릴 때 WebCore 는 그 칸의 편집 루트에 `beforeinput`(`historyUndo`)을 보낸다(`EditCommandComposition::unapply` → `Editor::willUnapplyEditing`). CodeMirror 의 `history()` 는 contentDOM 에서 이것을 받아 자기 `undo` 를 부른다. 그래서 평소 타이핑은 메뉴 Undo 로 되돌려졌다 — 꺼낸 칸이 편집기 타이핑이면 CodeMirror 가 받는다. 모두 바꾸기는 CodeMirror 의 트랜잭션이라 WebKit 기록에 없고, 그 위 칸은 바꾸기 입력칸의 타이핑이었다. 그 칸의 `beforeinput` 은 입력칸으로 가서 입력칸이 되돌려지고 포커스가 그리로 갔다(스모크가 본 그대로).
- **모두 바꾸기만의 문제가 아니다.** Playwright WebKit 에서 새 페이지마다 편집 하나를 하고 `document.queryCommandEnabled("undo")` 를 봤다. WebKit 기록에 들어가는 것은 글자 타이핑(닫는 괄호 자동 입력이 붙는 `(` 포함)뿐이고, Enter·Backspace·Tab·⌥↑ 줄 옮기기·⇧⌘D·붙여넣기(CodeMirror 처리기)·`view.dispatch` 는 들어가지 않는다. 「바꾸기」 한 번도 같다(트랜잭션). 그래서 옛 항목은 이런 편집만 한 메모에서는 꺼져 있었고, 타이핑 칸이 CodeMirror 기록보다 적으면 중간에 꺼졌다.
- **고른 방법: 편집 메뉴의 실행 취소·실행 복귀를 앱 항목으로.** `beforeinput` 만 받는 방법은 고르지 않았다. 그 길은 WebKit 기록에 칸이 있을 때만 열리므로 위의 Enter·붙여넣기 등은 그대로 못 되돌리고, 항목의 켜짐도 WebKit 기록을 따른다. 앱 항목(id `undo`·`redo`, 이름 「실행 취소」·「실행 복귀」, 키 ⌘Z·⇧⌘Z 고정)은 `tote://menu` 로 포커스된 창의 페이지에 가고, 페이지(`src/editor/history-menu.ts` `runHistoryMenu`)가 고른다.
  - 편집기에 포커스가 있으면 그 편집기의 `undoWithCursors`·`redoWithCursors`(⌘Z 키와 같다).
  - 포커스가 페이지(body)나 칸 자체에 있으면 그 칸의 편집기(편집기를 보일 때).
  - 입력칸·`select`·편집 가능 요소·뷰어 iframe, 그리고 사이드바·대화상자의 요소이면 `document.execCommand("undo"|"redo")` — WebKit 의 되돌리기 그대로다. WebKit 은 스크립트의 Undo 명령을 받는다(`EditorCommand.cpp` 의 `Undo` 가 `supported`, `WebEditCommandProxy::unapply` 의 주석이 `execCommand()` 길을 적어 둔다). Playwright WebKit 에서도 입력칸 타이핑을 되돌렸다.
  - tote 창이 아니라 다른 창(시트 등)이 키를 갖고 있으면 Rust 가 key window 에 `undo:`·`redo:` 를 보낸다(`menu::history` → `system_history`, `NSApplication::sendAction_to_from`).
- **입력칸의 되돌리기가 본문에 닿는 길도 막았다(B-2 의 기대).** WebKit 기록은 창 하나에 하나라서, 입력칸에서 되돌리다 보면 그 아래 칸인 편집기 타이핑에 닿는다. 그 `beforeinput` 은 포커스가 없는 편집기로 가고, CodeMirror 가 본문을 되돌린다(Playwright 로 재현: 입력칸에 포커스를 둔 채 `execCommand("undo")` 가 편집 가능 요소의 타이핑을 되돌렸다). `historyStaysWithTheKeys`(`Prec.highest` 의 `beforeinput` 처리기, `history()` 앞)가 포커스 없는 편집기에 온 `historyUndo`·`historyRedo` 를 버린다. 스모크 B-2 가 합격한 것은 그 세션의 WebKit 기록에 편집기 타이핑이 없었기 때문으로 보인다.
- **바뀐 것.** `src-tauri/src/app/menu.rs`(시스템 `undo`/`redo` 슬롯을 앱 고정 항목으로, `history`·`system_history`), `src-tauri/src/shortcuts.rs`(`UNDO_ACCELERATOR`·`REDO_ACCELERATOR`), `src/app/controller.ts`(`onMenu` 의 `undo`·`redo`), `src/editor/history-menu.ts`(새 파일), `src/editor/setup.ts`. 앱 고정 항목이 되어 녹음 중에는 설정…·tote 종료처럼 키가 떼어진다.
- **설계 문서.** 검색 띠 설계 「동작」 에 「메뉴 되돌리기」, 설정·단축키 설계 「하지 않는 것」 의 시스템 편집 메뉴 줄.
- **시험.** e2e `tests/e2e/search-bar-app.spec.ts`: 「the menu's undo takes back 모두 바꾸기 with the editor's keys, not the bar's typing」(찾기·바꾸기 칸에 키로 친 뒤 모두 바꾸기 → 편집기에서 메뉴 `undo` 가 본문을 되돌리고 바꾸기 칸·포커스는 그대로, `redo`, 포커스를 뗀 채 `undo` 는 칸의 편집기, 끝에 편집기 포커스로 `execCommand("undo")` 를 하면 바꾸기 칸이 지워지고 본문은 그대로 — 옛 항목이 한 일을 고정해 WebKit 이 바뀌면 알린다), 「the menu's undo in a field of the bar takes back the field, never the memo」(편집기에 친 뒤 찾기 칸에 친 것을 메뉴 `undo` 로 되돌리고, 더 눌러도 본문 그대로). Rust `undo_and_redo_are_the_apps_items_with_the_fixed_keys`(편집 메뉴의 항목·이름·키가 `FIXED` 와 같다), `only_an_app_command_runs_from_the_editor` 에 `undo`·`redo`, 고정 항목 목록·녹음 중 떼기 시험의 개수.
- **구분력.** `historyStaysWithTheKeys` 를 빼면 입력칸 시험이 `Expected: "one two" / Received: "one"` 으로 실패. `onMenu` 의 `undo`·`redo` 분기를 끄면 두 시험 모두 실패(`Expected: "a a a" / Received: "b b b"`, `Expected: "" / Received: "x"`). 「페이지나 칸 자체」 분기를 끄면 첫 시험의 포커스 뗀 단언(258행)만 실패. 모두 복구 뒤 통과.
- **닿지 않는 것.** 실제 메뉴 클릭이 앱 항목으로 오는 것과 `system_history`(다른 창이 키를 가질 때)는 e2e 가 보지 못한다(가짜 백엔드가 id 를 바로 보낸다). 화면 확인 후보 1~4.

### 2. 다크 슬롯 Light+ 에서 띠 입력칸·사이드바 글자가 안 읽힘 (검색 띠 A-4) — `d0df67a`

- **원인(코드로 확인).** `ThemeManager.refresh` 가 `themeVariables(theme, appearance)` 에 OS 모양(슬롯)을 넘기고, `themeVariables` 는 `DEFAULT_VARIABLES[appearance]` 에서 시작해 테마가 준 키만 덮는다. 번들 Light+·Dark+ 에서 tote 변수에 닿는 키는 `editor.background`·`editor.foreground` 둘뿐이라, 다크 슬롯 Light+ 는 `--bg`·`--fg` 만 라이트가 되고 `--input-bg`·`--panel-bg`·`--sidebar-bg`·`--muted` 는 다크 기본값으로 남았다.
- **고친 것(브리프가 권한 방향).** `themeKind`(`src/theme/vscode-theme.ts`): 매니페스트 `uiTheme`(`vs`·`hc-light` 라이트, `vs-dark`·`hc-black` 다크), 없거나 모르면 테마 파일 `type`(`light`·`hcLight`·`dark`·`hc`), 그것도 없으면 슬롯. 매니저는 이 종류로 `themeVariables` 를 부르고, `ActiveTheme` 에 `kind` 를 더해 페이지의 `color-scheme`·`data-appearance` 도 종류를 따르게 했다(라이트 테마면 스크롤 막대·폼 컨트롤도 밝게). `appearance` 는 슬롯 그대로다. 테마 종류를 무시하는 다른 방법(테마의 `editor.background` 밝기로 종류를 짐작)은 고르지 않았다 — VS Code 도 매니페스트 `uiTheme` 로 기본 테마를 고른다.
- **설계 문서.** 코어 설계 「테마」 에 슬롯과 테마 종류 문단, 검색 띠 설계 「색」 에 한 줄. 설계에 슬롯·종류에 대한 서술은 없었다(「OS 모양을 따른다」 뿐).
- **시험.** 단위 `src/theme/manager.test.ts` 「ThemeManager with the bundled themes」: 번들 매니페스트와 테마 파일을 디스크에서 읽어 **번들 테마 둘 × 슬롯 둘** 네 경우마다 실제 `ThemeManager` 로 고르고, 찾기 칸 글자·자리표시·띠 버튼·띠 토글·사이드바 글자·사이드바 보조 글자·편집기 글자·페이지 보조 글자(8쌍)의 대비가 4.5:1 이상인지 `contrastRatio` 로 본다. 「takes the colours a theme leaves out from its kind, not from the slot」(다크 슬롯 Light+ 의 `kind`·`--input-bg`·`--sidebar-bg`). `vscode-theme.test.ts` 「themeKind」(우선순위 9가지).
- **구분력.** 매니저가 종류 대신 슬롯을 넘기게 하면 3개 실패(다크 슬롯 Light+, 라이트 슬롯 Dark+, 종류 시험), 같은 슬롯 두 경우는 통과. 실패 값: 다크 슬롯 Light+ 의 찾기 칸 글자 1.15:1, 띠 버튼·사이드바 메모 이름 1.21:1, 페이지 보조 글자 3.21:1. 복구 뒤 통과.
- **남는 것.** 뷰어 프레임(마크다운 미리보기·미디어)의 `color-scheme` 은 `light dark`(OS 모양)이다. 뷰어는 테마 변수만 받으므로 글자 대비는 같지만, 다크 OS 에서 라이트 테마면 뷰어 안 스크롤 막대·폼 컨트롤은 어두울 수 있다. 라이트 슬롯 Dark+ 는 시스템 모양을 라이트로 바꿔야 해서 화면 확인은 사람 몫이다.

### 3. ⌘+키패드 1 로 건 단축키를 메인 줄 ⌘1 도 실행 (설정 B-8) — `8a67d61`

- **원인(AppKit 실험으로 확인).** 스크래치의 Swift 실험 앱(창 없음, `NSMenu.performKeyEquivalent` 에 합성 키 이벤트)으로 쟀다. 항목 마스크에 `NSEventModifierFlagNumericPad` 가 들어 있어도(읽으면 `0x300000`) AppKit 은 맞출 때 그 플래그를 보지 않는다. 키패드 0~9·−·.·÷·= 항목은 메인 줄 같은 글자 ⌘키에도 실행되고, 메인 줄 항목도 키패드에 실행된다. 두 항목이 있으면 메뉴 순서로 앞의 것이 둘 다 가져간다. 키패드 ＋·× 항목은 메인 줄 ⇧⌘=·⇧⌘8 에도 실행되지만, ⇧⌘=·⇧⌘8 항목은 키패드로 실행되지 않는다. 키패드 ↩ 는 메인 줄 ↩ 와 갈린다.
- **AppKit 으로 가를 수 있나.** key equivalent·마스크로는 없다(위). 메뉴 대리자 `menuHasKeyEquivalent:forEvent:target:action:` 로 키 맞추기를 대신하면 가를 수 있지만, muda 가 만든 메뉴의 대리자를 바꿔야 해서 고르지 않았다. `key_equivalents.rs` 의 직접 접근(항목의 키·마스크 읽고 쓰기)으로는 가를 수 없다.
- **고른 것: 같은 키로 본다 — 메인 줄 키로 녹음.** 숫자패드 녹음은 사용자 결정이 아니라 틈 메우기 계획 Task 5 의 결정이었으므로 질문 없이 정했다.
  - 키패드 0~9·−·.·÷·= 는 메인 줄 키로 녹음한다(⌘키패드 1 → `CmdOrCtrl+1`, 「⌘1」). 양쪽 다 실행되는 것이 실제 동작이라 그 이름이 맞고, 메인 줄 키를 쓰는 명령과 같은 키로 충돌 검사를 받는다. 키패드로 누르던 사람도 그대로 쓸 수 있다. 녹음에서 받지 않는 쪽은 고르지 않았다: 받지 않으면 키패드로만 단축키를 누르는 사람에게 반응 없는 키가 되는데, 메인 줄 키로 녹음해도 키패드가 똑같이 실행하므로 막을 까닭이 없다.
  - 키패드 ＋·× 는 녹음에서 반응하지 않는다(`IntlBackslash` 와 같은 처리). 어느 이름으로 걸어도 동작을 말하지 못한다(키패드로 걸면 ⇧⌘= 도 실행, 메인 줄로 걸면 키패드가 안 닿음).
  - 키패드 ↩ 는 그대로 「⌘키패드 ↩」.
  - Rust `recordable` 은 키패드 ↩ 말고 키패드 키를 거절한다. 손으로 쓴 settings.json 항목과 이 규칙 전 빌드가 녹음해 저장한 항목은 읽을 때 버려진다(그 명령은 기본값으로 돌아간다). 옮겨 적지 않은 것은 `IntlBackslash` 의 선례를 따른 것이고, 숫자패드 녹음이 들어온 지 나흘이라 저장된 값이 거의 없다.
- **설계 문서.** 설정·단축키 설계 「화면」 의 녹음 목록.
- **시험.** 단위 `src/shortcuts/keys.test.ts`: 「records a keypad key a menu cannot tell from a main-row key as that key」(14개 키 × 보조키 두 벌, 표기 「⌘1」, `sameAccelerator` 로 `Cmd+1` 과 같음), 「does not record the keypad's ＋ and ×…」, 「records Insert, Help and the keypad's Enter but not IntlBackslash」(옛 시험을 나눔). Rust `the_other_keypad_keys_are_not_recordable`(8개 키 거절·`sanitize` 가 버림·`validate` 오류, 메인 줄 `CmdOrCtrl+1` 은 통과), `the_keypad_enter_insert_and_help_shortcuts_parse_and_are_recordable`. e2e `tests/e2e/shortcuts.spec.ts` 「a keypad key records as its main-row twin, which another command may have」(이름 바꾸기… 가 ⌘1 일 때 새 메모에 ⌘키패드 1 → 「이름 바꾸기… 에 이미 쓰고 있습니다」, 바꾸기 → 「⌘1」 저장, ⌘키패드 ＋ 는 녹음이 이어지고 ⌘키패드 ↩ 는 저장). AppKit 고정 시험 `src-tauri/tests/menu_keypad.rs`(`harness = false`): muda 로 `CmdOrCtrl+Numpad1`·`CmdOrCtrl+2` 항목을 만들어 마스크에 NumericPad 가 있음을 읽고, 메인 줄 ⌘1 이 키패드 항목을, 키패드 ⌘2 가 메인 줄 항목을 실행하는지 본다 — AppKit 이 가르게 되면 실패해 키패드 키를 다시 받을 때를 알린다. 시험 키 이벤트를 만들려고 dev-dependency 로 `objc2-app-kit` 의 `NSGraphicsContext`, `objc2-foundation` 의 `NSGeometry` 기능을 더했다.
- **구분력.** TS 의 짝 대응을 옛 정규식으로 되돌리면 단위 「…as that key」 와 e2e 가 실패(`element(s) not found`: 충돌 문구가 안 뜸). TS `recordable` 의 키패드 거절 줄을 빼면 단위 「＋ and ×」 가 실패. Rust 거절 줄을 빼면 `the_other_keypad_keys_are_not_recordable` 이 실패. AppKit 고정 시험은 항목을 `Numpad3` 으로 바꾸면 마스크 단언에서 실패. 모두 복구 뒤 통과.

### 이 회차의 화면 확인 후보

디버그 번들(`docs/guides/development.md` 「디버그 앱은 언제나 `TOTE_DATA_DIR` 을 주고 띄운다」)로 본다.

1. **모두 바꾸기 뒤 메뉴 실행 취소(검색 띠 B-5).** 찾기 「줄」·바꾸기 「ZZ」 를 키로 친 뒤 모두 바꾸기, 편집기를 누르고 메뉴 편집 › 실행 취소. **기대:** 본문이 한 번에 돌아오고, 바꾸기 칸 「ZZ」 와 편집기 포커스가 그대로다. 실행 복귀로 다시 바뀐다. 편집 메뉴의 두 항목 이름이 「실행 취소」·「실행 복귀」 이고 ⌘Z·⇧⌘Z 가 보인다. 결과(2026-10-25): 합격. 번들 `aaed03c`. 편집 메뉴는 「실행 취소」 Z/0(⌘Z)·「실행 복귀」 Z/1(⇧⌘Z)이고, 그 아래 Cut·Copy·Paste·Select All 은 영어 그대로다. `hangul.md` 에서 ⌘F, 찾기 칸에 「줄」(2벌식 키 코드), 바꾸기 펼치기, 바꾸기 칸에 「ZZ」(ABC 로 잠깐 바꿔 ⇧Z 키 코드 두 번 — `orca computer type-text` 는 이 칸에 `AXReplaceSelection` 으로 넣어 키 입력이 아니었다) → 모두 바꾸기 → 세 줄 모두 `ZZ`. 편집기를 요소 누르기로 포커스하고 메뉴 편집 › 실행 취소 클릭 → 세 줄이 한 번에 「줄」, 바꾸기 칸 「ZZ」 그대로, 포커스 편집기(`AXTextArea`) 그대로. 메뉴 실행 복귀 클릭 → 다시 세 줄 `ZZ`(파일에도 저장), 포커스 편집기.
2. **Enter·붙여넣기만 한 메모에서 메뉴 실행 취소.** 새 메모에서 Enter 세 번, 메뉴 실행 취소. **기대:** 줄이 줄어든다(옛 항목은 꺼져 있었을 것이다 — 옛 번들이 있으면 비교해 적는다). 결과(2026-10-25): 합격. 새 메모(⌘N, `untitled.md`)에서 Enter 키 코드 세 번 → 상태 줄 「줄 4, 열 1」, 메뉴 실행 취소는 켜져 있음(`enabled` true) → 클릭 한 번에 「줄 3, 열 1」(글자 수 4 → 3). 옛 번들은 같은 경로에 덮어써 비교하지 못했다. 붙여넣기는 사람의 클립보드를 써야 해서 하지 않았다.
3. **입력칸의 되돌리기는 본문을 건드리지 않는다(검색 띠 B-2 변형).** 편집기에 글자 몇 개를 친 뒤 ⌘F, 찾기 칸에 친다. 찾기 칸에 포커스를 둔 채 메뉴 실행 취소와 ⌘Z 키를 여러 번. **기대:** 찾기 칸 입력이 되돌려지고, 몇 번을 더 눌러도 본문은 그대로다. 메모 목록 거르기 입력칸에서도 같다. 결과(2026-10-25): 합격. 2의 메모 셋째 줄에 「가나 」(키 코드) → ⌘F, 찾기 칸에 「나」. 찾기 칸에 포커스를 둔 채 메뉴 실행 취소 4번 → 「ㄴ」·빈 값·빈 값·빈 값, 이어 ⌘Z 키 4번 → 빈 값 그대로, 포커스는 끝까지 찾기 칸. 본문은 디스크에서 `\n\n가나 ` 그대로(자동 제목으로 `가나.md`). 메모 목록 거르기 칸에 「한」 → 메뉴 4번 「하」·「ㅎ」·빈 값·빈 값, ⌘Z 4번 빈 값 그대로, 본문 그대로. WebKit 은 한글을 조합 단계마다 되돌린다(한 → 하 → ㅎ).
4. **다른 창이 키를 가질 때.** 파일 › 파일 열기… 대화상자의 검색칸에 글자를 친 뒤 ⌘Z. **기대:** 그 검색칸의 입력이 되돌려진다(`system_history`). 되돌려지지 않거나 메뉴가 꺼져 있으면 대화상자가 앱 모달인지 시트인지와 함께 적는다. 결과(2026-10-25): 합격. 대화상자는 Alpha 창의 시트(`AXSheet`, CGWindowList 에는 「Open」 880×448 창으로 따로 보인다). 검색칸은 요소 누르기(`AXConfirm`)로 포커스가 가지 않아 System Events 로 `AXFocused` 를 줬다(그 전에 친 「가」 는 목록의 타자 고르기로 가고 아무것도 열지 않았다). 「가나」 키 코드 → ⌘Z 한 번에 빈 값(두 번 더 눌러도 빈 값). 다시 「나」 → 메뉴 편집 › 실행 취소(켜져 있음) 클릭 → 빈 값. 메모 본문 그대로. 시트는 Cancel 로 닫았다.
5. **다크 슬롯 Light+(검색 띠 A-4).** 설정에서 다크 테마를 Light+ 로. **기대:** 띠 입력칸·사이드바·상태 줄이 밝은 바탕에 어두운 글자이고, 스크롤 막대도 밝다. 마크다운 미리보기를 열면 글자는 읽히되 미리보기 안 스크롤 막대가 어두울 수 있다(위 「남는 것」) — 본 그대로 적는다. 라이트 슬롯 Dark+ 는 시스템 모양을 라이트로 바꿔야 하므로 사람이 본다. 결과(2026-10-25): 합격(미리보기 안 스크롤 막대는 못 봄). 다크 OS 에서 설정 › 모양 › 다크 테마 「Light+ (tote.themes)」(settings `"dark": {"extension": "tote.themes", "label": "Light+"}`). hangul 메모 ⌘F 「줄」(1 / 3)·바꾸기 펼침: 찾기·바꾸기 칸·띠 단추는 흰 바탕에 검은 글자, 사이드바는 옅은 회색 바탕에 검은 글자, 상태 줄은 흰 바탕에 회색 글자, 지금 결과는 진한 칠+테두리, 나머지는 옅은 칠. 인스펙터 콘솔로 읽은 페이지 값: `color-scheme` light, `data-appearance` light(`prefers-color-scheme: dark` 는 true), `--fg` #000000·`--bg` #FFFFFF·`--muted` #656d76·`--input-bg` #ffffff·`--panel-bg`·`--sidebar-bg` #f6f8fa — 대비는 글자/입력칸 21:1, 글자/사이드바 19.73:1, 보조 글자 5.25:1(흰 바탕)·4.93:1(#f6f8fa). 편집기 스크롤 막대(긴 메모에서 ⌘↓ 직후 캡처)는 흰 바탕 위 어두운 회색 `#8f8f8f` — 라이트 모양이다. 마크다운 미리보기(보기 › 미리보기 전환)는 흰 바탕에 검은 글자로 읽힌다. 미리보기 안 스크롤 막대는 휠로 스크롤하는 동안 6장을 찍었지만 오른쪽 가장자리에 막대가 그려지지 않아(모두 `#ffffff`, 스크롤은 됨) 어두운지 보지 못했다. 라이트 슬롯 Dark+ 는 사람 확인(시스템 모양을 바꿔야 한다). 끝나고 다크 슬롯을 기본으로 되돌렸다.
6. **키패드 녹음(설정 B-8).** 아무 명령에 ⌘+키패드 1 을 녹음. **기대:** 「⌘1」 로 저장되고, 메인 줄 ⌘1 과 키패드 ⌘1 모두 그 명령을 실행한다. ⌘+키패드 ＋ 는 반응하지 않는다. ⌘+키패드 ↩ 는 「⌘키패드 ↩」 로 저장되고 메인 줄 ⌘↩ 로는 실행되지 않는다. 결과(2026-10-25): 부분 불합격 — **편집기 안에서 ⌘+키패드 ↩ 가 메뉴로 가지 않는다.** 이전 버전… 줄에 ⌘+키패드 1(키 코드 83) → 「⌘1」, settings `"versions": "CmdOrCtrl+1"`, 메뉴 char 1/0. markdown 메모 편집기에서 메인 줄 ⌘1(18) → 「이전 버전」 대화상자, Esc 뒤 키패드 ⌘1(83) → 같은 대화상자(합격). 이름 바꾸기… 줄에서 ⌘+키패드 ＋(69) → 「키를 누르세요」 그대로(합격), 이어 ⌘+키패드 ↩(76) → 「⌘키패드 ↩」, settings `"rename": "CmdOrCtrl+NumpadEnter"`, 메뉴 vk 76/0(합격), 설정 화면에 편집기 경고 없음. first 메모 편집기에서 메인 줄 ⌘↩(36) → 대화상자 없음, 편집기가 빈 줄을 넣음(메뉴가 받지 않음 — 합격). **같은 편집기에서 키패드 ⌘↩(76) → 대화상자 없이 편집기가 또 빈 줄을 넣었다(불합격).** 포커스를 페이지 본체(`AXWebArea`)로 옮기면 키패드 ⌘↩ 가 「새 파일 이름」 대화상자를 연다 — 메뉴 항목은 맞게 걸려 있다. 원인으로 보이는 곳: `src/shortcuts/keys.ts` `menuKeymap` 은 편집기 키 중 `sameAccelerator` 가 같은 것만 앱 명령으로 가로챈다. 편집기의 `Mod-Enter`(`insertBlankLine`)는 `CmdOrCtrl+Enter`(code `Enter`)라 `CmdOrCtrl+NumpadEnter` 와 다르다고 보고 넘기지만, CodeMirror 는 `event.key` 로 맞춰(키패드 ↩ 도 `Enter`) 키패드 ⌘↩ 에도 `Mod-Enter` 를 실행하고, 웹뷰가 메뉴보다 키를 먼저 받으니 편집기가 이긴다(설정 B-3 과 같은 순서). 같은 이유로 `conflict` 도 「편집기의 insertBlankLine 을 가립니다」 경고를 내지 않는다. 코드는 고치지 않았다. 끝나고 「모두 기본값으로」.

**입력칸 되돌리기 회귀 확인(2026-10-25, 번들 `aaed03c`).** 편집 메뉴 실행 취소를 앱 항목으로 바꾼 수정이 편집기가 아닌 입력칸을 망가뜨리지 않는지, 입력칸마다 그 전에 편집기에 친 글이 WebKit 기록에 있는 상태에서 키 코드로 친 뒤 메뉴 클릭과 ⌘Z 키를 바닥 너머까지 눌렀다. 네 곳 모두 합격 — 입력칸의 입력만 되돌려지고 메모 본문(디스크 파일로 확인)은 한 번도 바뀌지 않았으며 포커스는 그 입력칸에 남았다. ① 찾기 칸: 위 3. ② 바꾸기 칸: first 메모에 「하 」 를 친 뒤 바꾸기 칸에 「나」 → 메뉴 4번 「ㄴ」·빈 값·빈 값·빈 값, ⌘Z 4번 빈 값 그대로, `first.md` 는 `first memo\n하 ` 그대로. ③ 메모 목록 거르기 칸: 위 3. ④ 이름 바꾸기 대화상자(「새 파일 이름」, 6에서 키패드 ⌘↩ 로 연 것): `first.md` 의 `fi` 뒤에 「가」 → 메뉴 3번 「fiㄱrst.md」·「first.md」·「first.md」, 다시 「가」 → ⌘Z 6번 「가」 선택·「fiㄱrst.md」·「first.md」 뒤로 그대로, Esc 로 취소 — 파일 이름·본문 그대로.

### 실행 개수

모두 마지막 커밋(`8a67d61`) 위에서. 부하 `load averages` 9~11.

- vitest `pnpm exec vitest run`: 파일 44, 시험 387 통과.
- `cargo test --no-fail-fast`: 단위 416 통과, AppKit 하네스 `menu_key_equivalents: ok`·`menu_keypad: ok`(각각 시험 하나짜리 `main`), doc 시험 0.
- e2e `TOTE_E2E_PORT=1461 pnpm exec playwright test`: 410 통과(worker 7, 57.6초). `Script error`·`Cross-origin` 줄 0.
- `tsc --noEmit`: 오류 0. oxlint(`--no-error-on-unmatched-pattern -f json`): 파일 167, 규칙 96, 진단 0. 이 판의 oxlint 는 에이전트가 돌리면 깨끗할 때 아무것도 출력하지 않아 `-f json` 으로 개수를 읽었다.
- `cargo clippy --all-targets --all-features -- -D warnings`: 경고 0. `cargo fmt --all --check`: 차이 0.

## 마무리 회차

2026-10-25, 브랜치 `jang2162/smoke-fixes-3`, 기준 main `aaed03c`. 원본은 재개 스모크 화면 확인의 11번(탭 닫기 표시가 접근성 트리에 없음), 재개 스모크 불합격 고치기 리뷰(이하 「둘째 리뷰」)의 Minor 1·3·4·5, 이 보고 「넘기는 것」 의 글꼴 줄바꿈 행, 틈 메우기 보고의 `quietErrors` 행이다. 화면 확인은 하지 않았다(e2e 는 headless 만). 실제 앱으로 볼 것은 아래 「이 회차의 화면 확인 후보」 에 있다.

### 1. 탭의 닫기 표시가 접근성 트리에 없음 (재개 스모크 화면 확인 11번) — `0f7bcd1`, `08d2e96`

- **원인.** ARIA `tab` 은 자식을 표현용으로 다룬다. 앞 회차(`b59ad7d`)가 닫기 표시를 `role="tab"` 요소 안의 `role="button"` span 으로 바꿨으므로, 트리에 버튼이 드러나지 않고 탭 이름이 「first 탭 닫기」 처럼 합쳐졌다. 그래서 접근성 누르기로 탭을 닫을 길이 없었다.
- **고친 것(브리프가 권한 방향).** 탭 상자(`.tab`, `role="none"`) 안에 라벨(`.tab-label`, `role="tab"`, `aria-selected`, 힌트 `title`)과 그 형제인 진짜 `<button class="tab-close" aria-label="탭 닫기" tabindex="-1">` 를 둔다. 트리는 `tablist` › `tab "가"`, `button "탭 닫기"`, `tab "나" [selected]`, `button "탭 닫기"` 이다(Playwright ARIA 스냅숏). 끌기·가운데 클릭·오른쪽 클릭·마우스 고르기 처리기는 전처럼 탭 상자에 있다. 탭 바 레이아웃은 바꾸기 전후 `.tab`·`.tab-title`·`.tab-close` 상자가 픽셀까지 같다(임시 측정 시험, 커밋하지 않음): 상자의 왼쪽·위아래 여백을 라벨로 옮겼다.
- **함께 바꾼 둘.**
  - 닫기 버튼을 `visibility: hidden` 대신 `opacity: 0` 으로 감춘다. `visibility: hidden` 인 버튼은 트리에서 빠져서 비활성 탭은 여전히 누르기로 닫을 수 없다. 마우스로는 탭 위에 있어야 닿고 그때 보이므로 달라지는 것이 없다.
  - `aria-selected` 를 더했다. 전에는 활성 탭을 트리가 알 수 없었다.
- **설계·안내 문서.** 코어 설계 「칸」 에 「탭의 닫기 버튼」 줄, `docs/guides/development.md` 의 탭 누르기 줄을 지금 구조로.
- **시험.** e2e `tests/e2e/memo.spec.ts`: 「pressing a tab as assistive technology does …」 에 탭 수 2·접근 이름이 메모 이름뿐(`toHaveAccessibleName("가")`)·`aria-selected`, 누르기는 `role="tab"` 요소에. 「the close mark of a tab closes it …」 을 탭 셋으로: 닫기 버튼 3개가 모두 트리에 있음, 탭 라벨 가운데 클릭으로 닫힘(전에는 가운데 클릭을 보는 시험이 없었다), 비활성 탭의 닫기 버튼 `click()` 로 그 탭만 닫힘, 마우스 클릭으로 닫힘. `tests/e2e/save-failure.spec.ts` 는 저장 실패 사유를 라벨의 `title` 과 접근 설명에서 읽는다(`08d2e96` — 첫 커밋 뒤 전체 e2e 에서 이 시험이 `.tab` 의 `title` 을 찾다 실패해서 고쳤다). 끌기(`tear-off`·`pane-drag`·`panes`)·⌘W·다음/이전 탭은 기존 시험이 그대로 통과한다.
- **구분력.** 닫기 버튼을 다시 라벨 안에 두면 구조 단언(`Expected length: 0 / Received length: 2`)이 실패. CSS 를 `visibility: hidden` 으로 되돌리면 버튼 수 단언(`Expected: 2 / Received: 0`)이 실패. 탭의 `auxclick` 처리기를 끄면 가운데 클릭 단언이 실패. 모두 복구 뒤 통과.
- **남는 것.** 더러운 탭·저장 실패 탭의 ` ●`·` ⚠` 는 `.tab-title::after` 의 생성 내용이라 접근 이름에 들 수 있다(VoiceOver 가 「가 ●」 로 읽을 수 있다). 이번에는 건드리지 않았다.

### 2. `applyToDocument` 가 테마 종류로 `color-scheme` 을 정하는 것 (둘째 리뷰 Minor 1) — `c66e1a6`

- **시험.** `src/theme/manager.test.ts` 「applyToDocument › draws the page as the theme's kind, not the slot it was picked for」: `document` 를 `vi.stubGlobal` 로 두고 `appearance: "dark"`, `kind: "light"` 를 넘겨 `colorScheme`·`data-appearance` 가 `light`, 변수가 그대로 들어가는지 본다.
- **구분력.** 두 줄을 `active.appearance` 로 되돌리면 `Expected: "light" / Received: "dark"` 로 실패. 복구 뒤 통과.

### 3. `themeKind` 가 프로토타입 키를 종류로 읽음 (둘째 리뷰 Minor 3) — `5acf88d`

- **고친 것.** `uiTheme`·`type` 표를 객체 리터럴에서 `Map` 으로. 모르는 값(`constructor`·`toString`·`__proto__` 등)은 다음 단계(`type` → 슬롯)로 넘어간다.
- **시험.** `src/theme/vscode-theme.test.ts` 「takes a name the object prototype has for an unknown kind」: 네 경우와, 그 종류로 `themeVariables` 를 부르면 다크 기본 `--bg` 가 나오는지.
- **구분력.** 고치기 전 코드로 이 시험이 `expected [Function Object] to be 'light'` 로 실패하는 것을 먼저 봤다.

### 4. 저장된 키패드 단축키를 버림 (둘째 리뷰 Minor 4) — `cf61fa0`

- **고친 것.** `shortcuts::from_keypad`(`src-tauri/src/shortcuts.rs`)가 저장값의 키패드 0~9·−·.·÷·= 를 메인 줄 짝 키로 옮긴다(`CmdOrCtrl+Numpad1` → `CmdOrCtrl+1`, 화면이 녹음하는 이름 그대로). settings.json 을 읽는 `shortcut_overrides`(`appdata.rs`)가 `sanitize` 전에 부른다. 키 부분은 muda 와 같이 마지막 `+` 뒤로 가른다(`split_key_and_modifiers`). 근거는 둘째 리뷰의 AppKit 실험: 그 키패드 항목은 원래 메인 줄 키에도 실행됐다.
- **겹침.** 옮긴 값이 다른 명령과 겹치면 지금의 `sanitize`(`clashing`)가 정한다: 기본값과는 기본값이, 두 재정의 사이에서는 `COMMANDS` 앞의 것이 남는다. 고정 키(⌃1 = 워크스페이스 1)에 닿으면 버린다.
- **바꾸지 않은 것.** 짝이 없는 키패드 ＋·× 는 지금처럼 버린다. 화면이 보내는 바꿈(`validate`)은 옮기지 않는다 — 화면은 키패드 키를 보내지 않으므로 바꿈에 든 키패드 항목(↩ 말고)은 지금처럼 거절한다.
- **설계 문서.** 설정·단축키 설계 「화면」 녹음 목록의 settings.json 키패드 항목 줄(옮김, 겹침, ＋·× 는 버림, 바꿈은 거절).
- **시험.** Rust `a_saved_keypad_key_is_read_as_its_main_row_twin`(8가지 옮김, 짝 없는 키·키패드 ↩·보통 키·파싱 안 되는 값은 그대로이고 `sanitize` 가 판정), `a_keypad_key_moved_onto_a_taken_key_clashes_as_any_override`(두 순서 모두 이름 바꾸기… 가 남고 탭 닫기는 ⌘W, ⌃키패드 1 은 버림), `appdata::a_saved_keypad_shortcut_is_read_as_its_main_row_twin`(settings.json 읽기에서 옮김과 ＋ 버림). `the_other_keypad_keys_are_not_recordable` 는 그대로 통과(바꿈은 거절).
- **구분력.** `shortcut_overrides` 에서 `from_keypad` 를 빼면 appdata 시험 실패. 짝 표에서 `NumpadEqual` 을 빼면 첫 시험 실패. 옮기기를 통째로 끄면 셋 다 실패(416 통과·3 실패). 모두 `cargo test --lib --no-fail-fast`, 복구 뒤 통과.

### 5. 검색 띠 설계 「메뉴 되돌리기」 문장 (둘째 리뷰 Minor 5) — `2c7f1ae`

- 검색 띠 설계 78행 끝에 리뷰가 준 문장을 그대로 넣었다: 「WebKit 의 기록은 창 하나에 하나라서, 맨 위 칸이 다른 칸의 입력칸 것이면 그 입력칸이 되돌려지고 포커스가 그리로 간다(시스템 항목과 같다).」

### 6. 글꼴 이름의 줄바꿈 (이 보고 「넘기는 것」, 첫 리뷰 Minor 1) — `a23d613`

- **고친 것.** `src/app/editor-font.ts`: 따옴표 안의 `\n`·`\r`·`\f` 를 CSS 이스케이프(`\a `·`\d `·`\c `)로 쓴다. 따옴표로 감싸는 이름과 이미 따옴표인 이름 둘 다. 단어 사이의 줄바꿈은 전처럼 공백이 되어 따옴표 없이 읽힌다. 지우지 않고 이스케이프한 것은 이름을 바꾸지 않기 위해서다. 다른 제어 문자는 CSS 문자열 안에서 문제가 없다(따옴표 없는 이름이면 식별자 검사에 걸려 따옴표로 감싸진다).
- **설계 문서.** 설정·단축키 설계의 글꼴 칸 줄에 한 문장.
- **시험.** 단위 `src/app/editor-font.test.ts` 「writes a newline in a name as its escape …」(세 문자, 이미 따옴표인 이름, 단어 사이 줄바꿈, 출력에 날것의 줄바꿈이 없음). e2e `tests/e2e/settings.spec.ts` 「a font that is not there falls back …」 끝에 글꼴 크기 18·이름 `3270\nNope` 단계: 편집기 `.cm-scroller` 의 글꼴 크기가 18px 이고 고정폭.
- **구분력.** 고치기 전 `editor-font.ts` 로 e2e 가 리뷰가 말한 증상 그대로 `Expected: "18px" / Received: "13px"`, 단위 시험이 `"3270\nNope"` 로 실패. 이미 따옴표인 이름 쪽만 되돌리면 단위 시험이 `"Fira\r\nCode"` 로 실패. 복구 뒤 통과.

### 7. `quietErrors` 회귀 시험의 빈 곳 둘 (틈 메우기 보고 「이번에 닫지 않고 넘기는 것」) — `913b2a5`

- **방법.** Vite 서버 출력은 Playwright 가 `[WebServer] …` 로 찍을 뿐 시험이 읽을 수 없다. 대신 페이지가 Vite 에 보내는 프레임을 읽는다: Vite 클라이언트의 콘솔 감싸개는 HMR 웹소켓으로 `{"event":"vite:forward-console", …}` 를 보내고(`setupForwardConsoleHandler`), 서버는 그것을 받아 `[console.error] …` 로 찍기만 한다. `page.on("websocket")` 의 `framesent` 로 잡는다. 전달이 켜졌는지는 서버가 내준 `/@vite/client` 의 `const forwardConsole = {…}` 로 판정한다.
- **시험.** `tests/e2e/quiet-errors.spec.ts`: 두 기존 시험이 Vite 로 간 것도 `["other"]` 인지 본다. 새 시험 「every error after the first still goes to Vite, not to the console alone」: 걸러지지 않는 오류 셋이 콘솔과 Vite 양쪽에 모두 간다.
- **구분력.** `quietErrors` 가 호출마다 자기 필터를 걸게 하면(두 번째 호출의 이른 반환 제거) 「a second filter …」 가 Vite 쪽 단언에서 실패(`alpha` 가 감) — 콘솔 쪽은 통과하므로 옛 시험으로는 못 잡던 것이다. `finally` 의 `inside = false` 를 지우면 새 시험이 Vite 쪽에서 실패(`two`·`three` 가 안 감). 복구 뒤 통과.
- **한계(시험 머리 주석에 적음).** 전달은 Vite 가 에이전트를 볼 때만 켜진다. 사람의 실행에서는 Vite 쪽 단언을 건너뛰고 「not checked」 주석을 남긴다(에이전트 환경 변수를 지우고 돌려 세 시험 통과·주석을 확인). 보는 것은 페이지가 보낸 프레임이고 서버가 찍은 줄 자체는 아니다.

### 둘째 리뷰 Minor 처리

| Minor | 무엇                                                    | 처리                                                                                                 |
| ----- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1     | `applyToDocument` 의 종류를 시험이 고정하지 않음        | 마무리 회차에서 해결, 커밋 `c66e1a6`                                                                 |
| 2     | `menu::history` 의 `system_history` 에 시험이 닿지 않음 | 그대로. 가짜 백엔드로는 닿지 않는 길이고, 앞 회차 화면 확인 후보 4(파일 열기 대화상자에서 ⌘Z)가 본다 |
| 3     | `themeKind` 가 프로토타입 키를 종류로 읽음              | 마무리 회차에서 해결, 커밋 `5acf88d`                                                                 |
| 4     | 저장된 키패드 단축키를 버림                             | 마무리 회차에서 해결, 커밋 `cf61fa0`                                                                 |
| 5     | 검색 띠 설계 문장이 실제보다 넓음                       | 마무리 회차에서 해결, 커밋 `2c7f1ae`                                                                 |

### 이 회차의 화면 확인 후보

디버그 번들(`docs/guides/development.md` 「디버그 앱은 언제나 `TOTE_DATA_DIR` 을 주고 띄운다」)로 본다.

1. **탭 닫기 버튼(재개 스모크 화면 확인 11번의 나머지).** 탭 셋을 연 채 접근성 트리(`orca computer` 트리)를 읽는다. **기대:** 탭마다 `AXRadioButton`(이름은 메모 이름뿐, 「탭 닫기」 가 붙지 않는다) 다음에 버튼 「<메모 이름> 탭 닫기」(수정 회차 3, 전에는 모두 「탭 닫기」) 가 있고, 비활성 탭의 버튼도 있다. 활성 탭은 선택됨(`AXValue` 1)으로 보인다. ① 비활성 탭에 접근성 누르기(`click --element-index`) → 그 탭이 골라지고 닫히지 않는다(앞 회차 11번 합격이 그대로인지). ② 비활성 탭의 「탭 닫기」 버튼에 접근성 누르기 → 그 탭만 닫히고 활성 탭은 그대로. ③ 활성 탭의 「탭 닫기」 누르기 → 닫힌다. ④ VoiceOver 로 탭을 읽으면 메모 이름(과 선택됨)만 읽고, VO-Space 로 고르며, 다음 항목으로 가면 「<메모 이름> 탭 닫기, 버튼」 을 읽는다(사람). ⑤ 마우스: 비활성 탭 위에 올리면 × 가 보이고, 누르면 닫힌다. 탭 사이 끌기·가운데 클릭이 전처럼 된다.
2. **닫기 버튼을 누르고 끌어 빼기(수정 회차 1).** 탭 셋(가·나·다, 다가 활성)에서 편집기에 글자를 친 뒤, 비활성 탭 「가」 의 × 위에서 마우스를 누르고 누른 채 아래로 끌어 빼 놓는다. 이어서 Space 와 Enter. **기대:** 탭이 닫히지 않고, 두 키는 편집기에 공백과 줄바꿈으로 들어간다(포커스가 편집기에 남는다). 비활성 탭 「나」 의 × 를 그냥 눌러 닫은 뒤 바로 글자를 치면 편집기에 들어간다. 칸 둘에서 다른 칸의 비활성 탭을 닫은 뒤에도 키가 원래 편집기에 있다.
3. **VoiceOver 가 닫기 버튼 이름을 읽는 것(수정 회차 3, 사람).** 탭 「가」·「나」 를 연 채 VoiceOver 로터의 버튼 목록을 연다. **기대:** 「가 탭 닫기」·「나 탭 닫기」 로 갈려 보인다. 메모 이름을 바꾸면(파일 › 이름 바꾸기…) 그 버튼 이름이 새 이름으로 바뀐다. 탭 목록 안에서 탭과 버튼이 섞여 읽히는 모양(수정 회차 2, ARIA tablist 규칙을 벗어난 구조)도 본 그대로 적는다.
4. **편집기 안 키패드 ⌘↩(재개 스모크 화면 확인 6 의 불합격, 수정 회차 4).** 이름 바꾸기… 에 ⌘+키패드 ↩ 를 녹음한다. **기대:** 「⌘키패드 ↩」 로 저장되고 그 줄에 「편집기의 insertBlankLine 을 가립니다」 가 보인다. 메모 편집기에 포커스를 두고 키패드 ⌘↩ → 「새 파일 이름」 대화상자가 열리고 빈 줄은 들어가지 않는다. 메인 줄 ⌘↩ → 빈 줄이 들어가고 대화상자는 열리지 않는다. 검색 띠 입력칸에서도 같다. 거꾸로 이름 바꾸기… 를 메인 줄 ⌘↩ 로 녹음하고 편집기에서 키패드 ⌘↩ → 빈 줄이 들어가고 대화상자가 열리지 않는지(설정 설계의 추론: 메인 줄 ↩ 로 건 메뉴 항목은 키패드 ↩ 에 실행되지 않는다). 편집기 밖(메모 목록)에서 키패드 ⌘↩ 로 메뉴 항목이 실행되는지도 함께 적는다.

### 실행 개수

모두 마지막 코드 커밋(`08d2e96`) 위에서. 부하 `load averages` 16~25.

- vitest `pnpm exec vitest run`: 파일 44, 시험 390 통과(앞 회차 387 + 이 회차 3).
- `cargo test --no-fail-fast`: 단위 419 통과(416 + 3), main 0, AppKit 하네스 `menu_key_equivalents: ok`·`menu_keypad: ok`, doc 0.
- e2e `TOTE_E2E_PORT=1461 pnpm exec playwright test`: 411 통과(worker 7, 58.5초, 410 + 새 시험 1). `Script error`·`Cross-origin` 줄 0.
- `tsc --noEmit`: 오류 0. oxlint(`--no-error-on-unmatched-pattern -f json`): 파일 167, 규칙 96, 진단 0.
- `cargo clippy --all-targets --all-features -- -D warnings`: 경고 0. `cargo fmt --all --check`: 차이 0.

### 수정 회차

2026-10-25, 같은 브랜치. 원본은 마무리 회차 리뷰(`smoke-fixes-3` 워크트리 `.superpowers/handoff/smoke-fixes-3-review.md`)의 결함 1~3 과 재개 스모크 화면 확인 6 의 부분 불합격(키패드 ⌘↩), 리뷰가 본 부하 실패 1건이다. 화면 확인은 하지 않았다(e2e 는 headless 만). 새 화면 확인 후보는 위 「이 회차의 화면 확인 후보」 2~4 에 더했다.

#### 1. 보이지 않는 닫기 버튼이 포커스를 쥐고 Space·Enter 로 탭을 닫음 (리뷰 결함 1, Important) — `086691c`

- **고친 것(리뷰가 권한 방향).** 닫기 버튼의 `mousedown` 에서 `preventDefault()` 해 마우스가 포커스를 옮기지 않는다(`src/ui/tab-bar.ts`). 포커스는 편집기(또는 칸)에 그대로 남는다. 접근성 누르기와 `click()` 은 mousedown 이 없으므로 그대로다. 리뷰의 다른 길(`tabIndex` 빼기 — macOS 키보드 탐색을 켠 사람에게 Tab 순서에 든다, 형제 자리의 `span role=button`)보다 바꾸는 것이 적고 base 보다 낫다(편집기 포커스까지 남는다).
- **시험.** e2e `tests/e2e/memo.spec.ts` 「a close button pressed with the mouse leaves the keys where they were」: 탭 셋(다가 활성)에서 비활성 탭 「가」 의 × 위에서 누르고 200px 끌어 빼 놓은 뒤 포커스가 `.tab-close` 가 아니고 칸 안이며, Space·Enter 뒤 탭 셋이 그대로. 이어서 비활성 탭 「나」 를 마우스로 닫은 뒤 포커스가 `.tab-close` 가 아니고 칸 안.
- **구분력.** 고치기 전 코드로 셋 다 따로 실패한다: 첫 포커스 단언(`close: true`), 첫 단언을 뺀 채 Space·Enter 뒤 탭 수(`Expected - 1`, 탭이 닫힘), 앞의 둘을 뺀 채 닫은 뒤 포커스(`pane: false`, 리뷰의 `BODY` 증상). 복구 뒤 통과.
- **설계.** 코어 설계 「탭의 닫기 버튼」 줄 끝에 리뷰가 준 문장.

#### 2. 닫기 버튼이 tablist 자식 규칙을 벗어남 (리뷰 결함 2, Minor) — `9479e8f`

코디네이터 판정대로 받아들였다. 코드는 바꾸지 않았고 코어 설계 「탭의 닫기 버튼」 줄에 리뷰가 준 「받아들이면 넣을 문장」 을 넣었다.

#### 3. 닫기 버튼 이름이 모두 「탭 닫기」 (리뷰 결함 3, Minor) — `b933627`

- **고친 것.** 버튼의 `aria-label`·`title` 을 `「<탭 이름> 탭 닫기」` 로. 탭 바는 그릴 때마다 탭을 새로 만들므로 이름 바꾸기를 따라간다. 코어 설계 「탭의 닫기 버튼」 줄과 `docs/guides/development.md` 탭 누르기 줄의 이름을 맞췄다. 기존 시험의 `getByRole("button", { name: "탭 닫기" })` 는 exact 가 아니라 그대로 맞는다.
- **시험.** e2e `memo.spec.ts` 「a tab's close button is named after its tab and follows a rename」: 탭 「가」·「나」 의 버튼 이름이 `["가 탭 닫기", "나 탭 닫기"]`, 「나」 를 `목록.md` 로 이름 바꾸면 `"목록 탭 닫기"`.
- **구분력.** 고치기 전 코드로 이름 단언이 실패(`"탭 닫기"` 둘). 이름을 탭 id 별로 처음 본 제목에 묶어 두면(이름 바꾸기를 안 따라가면) 「목록 탭 닫기」 단언이 실패. 복구 뒤 통과.

#### 4. 편집기 안에서 ⌘+키패드 ↩ 가 메뉴로 가지 않음 (재개 스모크 화면 확인 6, 부분 불합격) — `ca3a59d`

- **원인(진단 그대로 확인).** `menuKeymap`·`conflict` 가 `CmdOrCtrl+NumpadEnter` 를 편집기의 `Mod-Enter`(`CmdOrCtrl+Enter`)와 다른 키로 봤다. CodeMirror 는 `event.key` 로 키를 맞추고 키패드 ↩ 의 `key` 도 `Enter` 라 ⌘키패드 ↩ 에 `insertBlankLine` 이 실행됐다. e2e 에서 같은 증상이 재현됐다(메뉴 명령 0회).
- **고른 방향: (a).** 근거: AppKit 은 두 키를 가르므로(화면 확인 6 에서 메인 줄 ⌘↩ 로는 키패드 항목이 실행되지 않았다) 편집기도 메뉴와 똑같이 가르게 하는 것이 「메뉴가 이긴다」 는 설계 규칙 그대로다. (b) 는 사용자가 가를 수 있던 키를 빼앗고, 이미 저장된 `CmdOrCtrl+NumpadEnter` 의 동작도 바꾼다.
  - `editorRunsOn`: 편집기 키와 단축키를 비교할 때 키패드 ↩ 를 ↩ 로 본다. `conflict` 가 이것을 써서 ⌘키패드 ↩ 를 녹음하면 「편집기의 insertBlankLine 을 가립니다」 경고가 난다. `menuKeymap` 도 이것으로 편집기 키를 고른다.
  - ↩·키패드 ↩ 에 건 단축키는 키 이름 바인딩 대신 CodeMirror 의 `any` 바인딩 하나로 건다. `KeyBinding.run` 은 뷰만 받아 `code` 를 볼 수 없어서다. `Prec.highest` 의 `any` 는 모든 키에서 편집기 바인딩보다 먼저 불린다(`buildKeymap` 이 `_any.run` 을 모든 키의 실행 목록 앞에 둔다, `@codemirror/view` 6.43.14). 이벤트를 `acceleratorFromEvent` 로 읽어 단축키와 같을 때만 명령을 실행하고 키를 막는다. 다른 쪽 ↩ 는 `false` 로 편집기에 넘긴다.
  - 그래서 메인 줄 ⌘↩ 로 건 명령도 이제 ⌘키패드 ↩ 는 편집기에 남긴다(전에는 키 이름 바인딩이라 둘 다 명령이었다). 메인 줄 ↩ 항목이 키패드 ↩ 에 실행되지 않는다는 것은 화면 확인 6 의 관찰을 거꾸로 짚은 추론이다 — 화면 확인 후보 4.
- **같은 꼴의 다른 키.** 편집기 키 109개 중 키패드 키와 글자가 같은 것은 `⌘↩`(insertBlankLine)·`⌘/`(toggleComment)·`↩`·`⇧↩` 뿐이다(`editorBindings()` 를 덤프해 봄). 키패드 ÷ 는 메인 줄 / 로 녹음되고 메뉴도 둘을 같게 보므로 편집기와 어긋나지 않는다. `↩`·`⇧↩` 는 ⌘⌃⌥ 가 없어 녹음되지 않는다. 키패드 ＋·× 는 녹음하지 않는다. 그래서 같은 꼴은 키패드 ↩ 하나다.
- **시험.** 단위 `src/shortcuts/keys.test.ts`: `conflict` 가 `CmdOrCtrl+NumpadEnter` 를 편집기의 insertBlankLine 과 겹친다고 하고 `Ctrl+NumpadEnter` 는 겹침 없음. `menuKeymap` 이 `CmdOrCtrl+NumpadEnter`·`CmdOrCtrl+Enter` 에 `any` 바인딩 둘을 만들고, 키패드 ↩ 는 앞의 명령만, 메인 줄 ↩ 는 뒤의 명령만 실행하며 키를 막는다. ⇧ 가 더 붙은 ↩ 와 다른 키는 받지 않는다. 편집기 키가 없는 `Ctrl+NumpadEnter` 는 바인딩이 없다. e2e `tests/e2e/shortcuts.spec.ts` 「in the editor ⌘keypad ↩ runs the app command on it, and the main row's ⌘↩ stays the editor's」: 저장을 ⌘키패드 ↩ 로 두고 편집기에서 키패드 ⌘↩ → `save` 한 번·본문 그대로·포커스 편집기, 메인 줄 ⌘↩ → 빈 줄·메뉴 명령 그대로. (`rename` 으로 쓰면 대화상자가 포커스를 가져가 메인 줄 단언이 성립하지 않아 `save` 로 했다.)
- **구분력.** `keys.ts` 를 통째로 되돌림 → 단위 둘·e2e 의 메뉴 명령 단언 실패. `code` 로 가르는 분기만 끔(키 이름 바인딩으로) → 단위 `menuKeymap` 시험과 e2e 의 메인 줄 ⌘↩ 단언(빈 줄 대신 저장) 실패. 복구 뒤 통과.
- **설계.** 설정 설계 「편집기 단축키는 고정이 아니다」 줄 끝에 ↩·키패드 ↩ 예외와 추론의 범위.

#### 5. 부하 실패 표본 — `e8b5ee5`

리뷰가 본 `tests/e2e/shortcuts.spec.ts:710` 부하 실패를 이 보고 「넘기는 것」 표에 새 행으로 더했다(전체 실행 1/2, 단독 0/20·부하 30, 첫 줄, 다음에 볼 것). 이 회차의 전체 e2e 1회(아래)에서는 실패하지 않았다.

#### 실행 개수

모두 `e8b5ee5` 위에서(작업 트리 깨끗). 부하 `load averages` 4~11.

- vitest `pnpm exec vitest run`: 파일 44, 시험 392 통과(마무리 회차 390 + 이 회차 2).
- `cargo test --no-fail-fast`: 단위 419 통과, main 0, AppKit 하네스 `menu_key_equivalents: ok`·`menu_keypad: ok`, doc 0(Rust 는 바꾸지 않았다).
- e2e `TOTE_E2E_PORT=1461 pnpm exec playwright test`: 414 통과(worker 7, 52.3초, 411 + 새 시험 3). `Script error`·`Cross-origin` 줄 0.
- `tsc --noEmit`: 오류 0. oxlint(`--no-error-on-unmatched-pattern -f json`): 파일 167, 규칙 96, 진단 0.
- `cargo clippy --all-targets --all-features -- -D warnings`: 경고 0. `cargo fmt --all --check`: 차이 0.
