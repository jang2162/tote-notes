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

1. **「없음」 저장이 메뉴에서 키를 뗀다(설정 A-2).** 새 메모 줄을 녹음해 ⌃⌥⌘J 로 바꾼 뒤 그 줄에서 Backspace. **기대:** 메뉴 새 메모의 `AXMenuItemCmdChar` 가 비고, ⌃⌥⌘J·⌘N 모두 메모를 만들지 않는다. 메뉴 「파일 › 새 메모」 클릭으로는 만들어진다.
2. **「모두 기본값으로」 가 기본값이 없는 명령의 키를 뗀다(설정 A-4).** 이름 바꾸기… 를 ⌃⌥⌘U 로 바꾼 뒤 「모두 기본값으로」 → 확인. **기대:** 메뉴 이름 바꾸기… 에 키 표시가 없고 ⌃⌥⌘U 가 「새 파일 이름」 대화상자를 띄우지 않는다. 새 메모는 ⌘N 으로 돌아온다.
3. **「바꾸기」 로 빼앗긴 명령의 키가 메뉴에서 사라진다(설정 A-6).** 새 메모를 ⌘O 로 녹음하고 「바꾸기」. **기대:** 메뉴 파일 열기… 에 키 표시가 없고 새 메모가 ⌘O 를 보인다. ⌘O 는 새 메모를 만든다.
4. **녹음 중 메뉴 키가 실제로 떼어진다.** 아무 줄이나 녹음을 시작한 채 메뉴 막대를 읽는다. **기대:** 사용자 정의 항목(새 메모, 저장, 설정…, tote 종료 등)의 `AXMenuItemCmdChar` 가 모두 비고, 녹음을 끝내면(Esc) 돌아온다. ⌘H·⌘M 등 macOS 기본 항목은 남는다(뗄 수 없다).
5. **앱을 다시 켜면 저장된 「없음」 이 메뉴에 반영된다.** 1을 한 뒤 「tote 종료」 로 끄고 같은 `TOTE_DATA_DIR` 로 다시 켠다. **기대:** 메뉴 새 메모에 키 표시가 없다(시작할 때 기본값으로 만든 뒤 저장된 값으로 떼는 길이다).
6. **편집기와 겹치는 메뉴 단축키는 메뉴가 이긴다(설정 B-3).** 탭 닫기에 ⌘L(경고 「편집기의 selectLine 을 가립니다」). 편집기 1줄 머리에서 ⌘L. **기대:** 탭이 닫히고 줄은 선택되지 않는다. 기본값 그대로 ⇧⌘\ 를 편집기 안에서 누르면 아래로 나뉘고(괄호로 커서가 가지 않는다), ⌥⌘↓ 는 아래 칸으로 간다(커서가 늘지 않는다). 검색 띠(⌘F) 입력칸에서 이름 바꾸기에 건 ⌘G 를 누르면 「새 파일 이름」 대화상자가 뜨고 다음 찾기로 가지 않는다. 새 창을 편집기 키(예: ⌘D `selectNextOccurrence`)에 걸어 편집기에서 누르면 새 창이 한 번만 열린다(메뉴와 페이지가 둘 다 돌지 않는다).
7. **글 입력칸에서 겹치는 키(아직 고치지 않은 것).** 다음 탭에 ⌘← 를 걸고 메모 목록 거르기 입력칸에서 ⌘← 를 누른다. **적을 것:** 커서가 줄 머리로 가는지(입력칸이 이김) 다음 탭으로 가는지(메뉴가 이김). 입력칸이 이기면 「알려진 한계」 대로이고, 바꿀지는 판단할 일이다. 끝나면 되돌린다.
8. **없는 글꼴은 기본 고정폭으로(설정 D-5 ①).** 글꼴에 `NoSuchFont Zz`. **기대:** 편집기 글이 세리프가 아니라 기본 글꼴(SF Mono 류)로 보인다. `3270 Nope`(숫자로 시작)도 같다.
9. **글꼴 크기를 바꾸면 줄번호가 바로 맞는다(설정 D-5 ②).** 줄이 여럿인 메모를 연 채 설정에서 글꼴 크기를 24 로. **기대:** 클릭이나 창 크기 바꾸기 없이 줄번호가 각 줄 옆에 맞는다. 다른 창의 편집기와, 그 창에서 숨어 있던 탭을 보였을 때도 맞는다. 글꼴 이름을 바꿀 때도 같다.
10. **앱이 비활성화되면 고르개가 닫힌다(자유 분할 B-12).** 고르개를 펼친 채 Finder 를 맨 앞으로 했다가 tote 로 돌아온다. **기대:** 목록이 닫혀 있고, 바로 치는 글이 편집기로 간다(목록 항목에 포커스가 남지 않는다). ↑↓·Enter·Esc 는 B-12 의 나머지 절차 그대로.
11. **탭 누르기는 탭을 고른다.** 탭 둘을 연 채 비활성 탭에 접근성 누르기(`orca computer click --element-index`, AXPress). **기대:** 그 탭이 골라지고 닫히지 않는다. 닫기 표시(×, 이름 「탭 닫기」)에 누르기를 하면 그 탭이 닫힌다. VoiceOver 로 탭을 VO-Space 해도 같다.

## 넘기는 것

| 무엇                                                                                                      | 출처                                                 | 까닭·짚은 원인                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 줄번호를 끈 순간 비활성 창의 다른 칸 선택 강조가 거터 폭만큼 어긋나 남았다가 창이 활성화되면 바로잡힘     | 설정 스모크 D-3, 스모크 보고 「그 밖에 본 것」       | 원인 미확인. 후보: 거터를 빼는 DOM 갱신은 dispatch 에서 바로 일어나지만 선택 강조(`drawSelection` 층)는 측정 단계(requestAnimationFrame)에서 다시 그린다. 비활성 창에서 WKWebView 가 그 프레임을 미루면 창이 활성화될 때까지 옛 자리에 남는다. 다시 잴 때는 비활성 창에 `requestAnimationFrame` 콜백이 언제 도는지 계측한다.                 |
| 재시작 복원 뒤 가장 큰 창의 제목이 「Alpha」 에서 「Alpha — 3」 으로 바뀜                                 | 자유 분할 스모크 B-18, 스모크 보고 「그 밖에 본 것」 | 원인 짚음: 제목 번호는 창의 정체가 아니라 그 워크스페이스의 창을 연 순서다(`AppCore::titles_of` 가 `windows_of` 순서로 `window_title(name, nth)`). 복원은 창을 다른 순서로 다시 열 수 있어 같은 창이 다른 번호를 받는다. 번호를 창에 붙여 둘지는 판단할 일이다.                                                                              |
| 새로 고칠 때 콘솔 `Fetch API cannot load ipc://localhost/suspend_shortcuts due to access control checks.` | 설정 스모크 A-9, 스모크 보고 「그 밖에 본 것」       | 원인 짚음: 녹음 중 새로 고치면 `pagehide` → 녹음기 `stop()` 이 `suspendShortcuts(false)` 를 보내는데, 문서가 떠나는 중이라 WebKit 이 그 IPC fetch 를 끊고 이렇게 적는다. 메뉴 키는 Rust `on_page_load` 의 `resume_if` 가 되돌리므로 동작에는 영향이 없다. 잡음을 없애려면 `pagehide` 길에서는 IPC 를 보내지 않는다(되돌리기는 Rust 가 한다). |
| 대용량 뷰어 도구 막대가 좁은 칸에서 두 줄로 접힘                                                          | 설정 스모크 D-6, 스모크 보고 「그 밖에 본 것」       | 원인 미확인. `.large-text-bar` 는 `flex-wrap` 이 없는 flex 이므로 막대 자체가 아니라 자식 안의 글(줄 수·상태 문구)이 줄바꿈되는 것으로 보인다. 후보: 자식에 `white-space: nowrap`·`min-width: 0` 이 없다. 좁은 칸 스크린숏으로 어느 자식이 접히는지부터 본다.                                                                                |
| 검색 토글 `Aa`·`.*` 가 편집기 글꼴 종류를 따르고 12px 고정                                                | 설정 스모크 D-7                                      | 의도 판단(사람 확인 행). `.search-toggle` 이 `font: 12px var(--editor-font)` 다. 이번 3번으로 `--editor-font` 는 설정값 뒤에 기본 고정폭 목록이 붙은 값이 되었다(없는 글꼴이면 고정폭). UI 글꼴로 바꿀지는 사람이 정한다.                                                                                                                    |
