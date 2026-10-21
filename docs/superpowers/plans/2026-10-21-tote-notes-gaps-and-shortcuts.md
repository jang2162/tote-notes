# tote-notes 틈 메우기·단축키 후속 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ⌘Q 를 고정 단축키로 만들고 최소 macOS 를 13 으로 정한다. 탭 넘기기의 남은 틈 셋, 두 창의 단축키 동시 저장, 검색 띠의 옛 표시를 막는다. 병합·pull 뒤 `pnpm install` 이 저절로 돌게 하고, 단축키 녹음과 작은 화면 잔여를 메운다.

**Architecture:** 새 기능은 없다. 사용자 결정 둘(2026-10-21: 「⌘Q 는 설정 불가능」, 「최소 macOS 13」)과 이월 목록에서 화면 확인이 필요 없는 것을 골랐다. 탭 넘기기의 틈은 메모 파일은 남고 탭(세션 항목)·자리만 잃는 경로다. 고칠 때 메모 데이터 경로를 건드리지 않는다.

**Tech Stack:** TypeScript, CodeMirror 6, Tauri 2.12(Rust, muda 0.20), vitest, Playwright(WebKit, 가짜 백엔드), lefthook.

**Spec:** 동작 기준은 `docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md`(단축키), `docs/superpowers/specs/2026-10-19-tote-notes-free-splits-and-tab-drag-design.md`(탭 넘기기), `docs/superpowers/specs/2026-10-20-tote-notes-editor-search-bar-design.md`(개수 표시). 항목의 근거는 `docs/superpowers/reports/2026-10-20-tote-notes-stability-followups-report.md` 「남은 것」 과 `docs/superpowers/reports/2026-10-20-tote-notes-settings-and-shortcuts-smoke.md` 「다음 계획으로 넘기는 것」.

## Global Constraints

- 화면(실제 키보드·마우스, 실제 앱 창)을 쓰지 않는다. 디버그 앱이 필요하면 `TOTE_DATA_DIR=<임시 폴더>`. `~/Tote` 금지. `~/Tote-dev`·`~/Library/Application Support/tote-dev` 는 사용자가 쓰는 중이니 지우거나 고치지 않는다.
- 문구 그대로: 「tote 종료」, 고정 거절 「〈이름〉 에 고정된 단축키입니다」, 개수 꼴(「3 / 12」, 「– / 12」, 「– / 0+」, 「1000+」, 「결과 없음」, 「잘못된 정규식」). 새 문구는 태스크가 적은 것만 쓴다.
- Rust `FIXED`·`COMMANDS` 를 바꾸면 같은 커밋에서 `src-tauri/tests/fixtures/shortcut-table.json` 재생성과 `src/backend/fake-shortcuts.ts` 사본을 맞춘다.
- 고친 동작마다 그 수정을 되돌리면 실패하는 시험을 둔다(보고에 변이 결과).
- 고정 지연(`waitForTimeout`, `setTimeout(…, n)`)을 새로 들이지 않는다. 시간은 `page.clock`.
- 테스트 보고는 실행 개수와 함께. 커밋 전에 `pnpm fmt`, `pnpm lint`, `pnpm typecheck`, Rust 를 고쳤으면 `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`.
- `docs/guideline/` 는 지침 서버 사본이다. 고치지 않는다(제안할 문장은 보고에 적는다).
- 이번에 하지 않는 것: 화면 확인 목록 전부, 로그아웃, 측정, CodeMirror 상위 보고.

## Review Focus

1. 녹음 중 ⌘Q 를 눌러도 앱이 꺼지지 않고 「tote 종료 에 고정된 단축키입니다」 로 거절된다 — Task 1 e2e `⌘Q is fixed and recording it is refused`.
2. 받는 창이 닫기 라운드에 들어간 뒤 놓인 탭은 그 창으로 가지 않고 새 창으로 간다 — Task 2 Rust `a window in a close round is not a drop target`.
3. 다른 창이 먼저 단축키를 바꾼 뒤 이 창의 옛 표로 저장하면 거절되고, 다른 창의 변경이 남는다 — Task 3 e2e `a shortcut saved from a stale table is refused and the other window's change stays`.
4. 검색어를 바꾼 뒤 첫 이어 세기에서 0 개면 이전 검색어의 개수나 빨간 「잘못된 정규식」 이 남지 않는다 — Task 4 e2e `a new query never shows the last query's count`.
5. 숫자패드 키로 녹음한 단축키가 메뉴에 걸리고, `IntlBackslash` 는 녹음에서 반응하지 않는다 — Task 5 단위 `records numpad, Insert and Help but not IntlBackslash`.

---

### Task 1: ⌘Q 고정과 최소 macOS 13

**Files:**

- Modify: `src-tauri/src/shortcuts.rs`(`COMMANDS` 39행의 quit, `FIXED` 136~157행, `SETTINGS_ACCELERATOR` 132행 옆), `src-tauri/src/app/menu.rs`(`Slot` 44~64행, `shortcut_item` 158~164행, `build` 181~184행의 `map_or("설정…")`, `accelerators_while` 334~344행), `src/backend/fake-shortcuts.ts`, `src-tauri/tests/fixtures/shortcut-table.json`(재생성), `src-tauri/tauri.conf.json`, 스펙 71~73·81·101·124행
- Test: 위 Rust 파일의 tests, `src/backend/fake.test.ts`, `src/backend/fake-shortcuts.test.ts`, `src-tauri/src/appdata.rs` 736~755행 시험, `tests/e2e/shortcuts.spec.ts`

**Interfaces:**

- Produces(Rust): `pub const QUIT_ACCELERATOR: &str = "CmdOrCtrl+Q"`. `quit` 은 `COMMANDS` 에서 빠지고 `FIXED` 의 둘째 줄 `fixed("tote 종료", QUIT_ACCELERATOR)` 가 된다(첫 줄은 그대로 설정…). 메뉴 id `quit` 과 `on_event` 의 동작은 그대로.
- Produces(menu.rs): 고정 항목을 일반화한 `Slot::Fixed { id: &str, text: &str, accelerator: &str }`(설정…·tote 종료 둘). `build` 는 이름을 `COMMANDS` 에서 찾지 못하면 기본값으로 「설정…」 을 쓰지 않는다. `accelerators_while` 은 두 고정 항목을 모두 chain 한다(녹음 중에는 둘 다 뗀다).
- 읽기: settings.json 의 `quit` 항목은 모르는 id 로 버려진다(`sanitize` 가 이미 그렇게 한다). 패치에 `quit` 이 있으면 지금 「모르는 명령」 과 같은 오류로 거절된다.

- [ ] **Step 1: 실패하는 시험**
  - Rust `quit_is_fixed_and_cannot_be_rebound`: `FIXED` 에 「tote 종료」·`CmdOrCtrl+Q` 가 있고, `{"quit": "CmdOrCtrl+Shift+Q"}` 를 담은 settings.json 을 읽으면 그 항목이 버려지며, `CmdOrCtrl+Q` 를 다른 명령에 거는 패치는 「tote 종료 에 고정된 단축키입니다」 로 거절된다.
  - Rust `the_quit_menu_item_keeps_its_name_and_shortcut`: 메뉴의 quit 항목 이름이 「tote 종료」, 단축키가 ⌘Q 이고, 녹음 중(`suspend`)에는 떼었다가 되살린다.
  - e2e `⌘Q is fixed and recording it is refused`(Review Focus 1): 단축키 구역의 고정 묶음에 「tote 종료 ⌘Q」 줄이 있고 앱 명령 줄에는 없다. 아무 줄이나 녹음하며 ⌘Q 를 누르면 그 줄 아래 「tote 종료 에 고정된 단축키입니다」 가 뜨고 저장되지 않는다.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3: 구현.** 바뀌는 기존 시험을 새 표에 맞춘다(조사로 확인한 것: `shortcuts.rs` 379·423·443·485·502행, `menu.rs` 621·648·693·745행, `appdata.rs` 736행 — quit 대신 다른 명령으로 같은 뜻을 지킨다, `fake.test.ts` 86·114행, e2e 358행 25→24·366행 20→21). fixture 를 재생성한다.
- [ ] **Step 4: 최소 macOS 13.** `tauri.conf.json` 에 `"bundle": { "macOS": { "minimumSystemVersion": "13.0" } }`. `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json` 뒤 `plutil -p src-tauri/target/debug/bundle/macos/tote-dev.app/Contents/Info.plist | grep LSMinimumSystemVersion` 이 `"13.0"` 인 것을 보고에 적는다(앱을 띄우지 않는다). 스펙 124행의 「다음 계획이 최소 버전을 정하거나…」 를 「최소 macOS 13(WebKit 16)이라 subgrid 를 그대로 쓴다」 로, 72~73행에 ⌘Q 고정과 그 까닭(「종료할 길을 단축키에서 잃지 않게 — 사용자 결정 2026-10-21」)을 넣는다.
- [ ] **Step 5:** `cargo test`, `pnpm test`, `tests/e2e/shortcuts.spec.ts`·`tests/e2e/settings.spec.ts`(개수 보고).
- [ ] **Step 6: 커밋** `feat: fix ⌘Q and require macOS 13`

### Task 2: 탭 넘기기의 남은 틈 셋

**Files:**

- Modify: `src-tauri/src/app/mod.rs`(`OpenWindow` 187~198행, `page_started` 640~645행, `drop_candidates` 1122~1139행, `move_tab` 1146~1158행), `src-tauri/src/app/windows.rs`(`on_page_load` 353~358행), `src-tauri/src/app/flush.rs`(대상 창 질의), `src/app/controller.ts`(`onAdopt` 341~346행, `pendingAdopts` 218~220행, `adoptTab` 1177~1205행, `onFlush` 1221~1242행, `flushAll` 1210~1217행)
- Test: `src-tauri/src/app/mod.rs` tests, `tests/e2e/adopt.spec.ts`

**Interfaces:**

- Produces(Rust): `AppCore::page_loading(&self, label: &str)` — `on_page_load` 의 `PageLoadEvent::Started` 에서 불러 `page_ready = false`. `page_started` 가 다시 true 로 한다. 실기기에서 Started 가 `page_started` 보다 늦게 오면 그 창은 「준비 안 됨」 으로 남지만 그때 놓인 탭은 새 창으로 가므로 잃지 않는다(안전한 쪽 실패) — 이 문장을 `page_loading` 문서 주석에 둔다.
- Produces(Rust): 닫기·전환 라운드가 걸린 창을 `is_leaving()` 에 포함한다. `FlushCoordinator` 에 `fn targets(&self, label: &str) -> bool`(그 창을 닫거나 바꾸는 라운드가 돌고 있는가)을 두고 `drop_candidates`·`move_tab` 이 그것을 본다. 종료(Quit) 라운드는 포함하지 않는다.
- Produces(TS): 진행 중인 `adoptTab` 을 `adopting: Set<Promise<void>>` 로 들고, `onFlush` 는 `flushAll` 전에 `await Promise.allSettled([...adopting])` 한다.
- Produces(TS): 복원이 끝나지 않은 채 flush 가 오면(`restoring && pendingAdopts.length > 0`) Rust 가 가진 이 창의 레이아웃(`readWindowLayout`)을 읽어 첫 칸 끝에 받은 탭들을 덧붙여 `writeWindowLayout` 한다. `SessionSync.build` 로 쓰지 않는다(저장된 세션을 빈 칸으로 덮는다).

- [ ] **Step 1: 실패하는 시험**
  - Rust `a reloading page is not a drop candidate until it starts again`: `page_started` 뒤 `page_loading` 이면 후보가 `leaving`, 다음 `page_started` 뒤 다시 받는다.
  - Rust `a window in a close round is not a drop target`(Review Focus 2): 창 B 에 닫기 라운드를 시작하면 `drop_candidates` 가 B 를 `leaving` 으로 내고 `move_tab(A, B, key)` 가 거절된다. 라운드가 취소되면 다시 받는다. 종료 라운드는 영향 없음.
  - e2e `a window closed before its restore keeps the tabs it was handed`: 받는 창의 복원을 붙잡은 채 탭 둘을 보내고, 그 상태로 종료 flush 를 보내면 그 창 레이아웃(`hub.layout`)에 원래 탭 뒤로 받은 두 탭이 차례로 있다.
  - e2e `a close round waits for a tab still being adopted`: 받는 창의 `refreshMemos` 를 붙잡아 `adoptTab` 이 기다리는 동안 닫기 flush 를 보내면, 풀었을 때 flush 답보다 먼저 받은 탭이 세션에 쓰인다.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3: 구현.** `adopt.spec.ts` 의 기존 세 시험과 Rust 의 `page_ready` 시험 다섯(조사: `mod.rs` 2687~2751행)이 계속 통과해야 한다.
- [ ] **Step 4:** `cargo test`, `pnpm test`, `adopt.spec.ts`·`windows.spec.ts`·`tear-off.spec.ts` 각 `--repeat-each=10`(개수·부하 보고).
- [ ] **Step 5: 커밋** `fix: keep handed-over tabs through reloads, early closes and close rounds`

### Task 3: 두 창의 단축키 동시 저장

**Files:**

- Modify: `src-tauri/src/appdata.rs`(`SettingsPatch` 289~307행, `apply` 322~352행), `src/backend/types.ts`(224~226행 주석과 `SettingsPatch`), `src/backend/fake.ts`(1087~1117행), `src/ui/shortcut-settings.ts`(`commit` 163~181행, 「모두 기본값으로」 320~329행, `load` 300~317행), 스펙 89행
- Test: `src-tauri/src/appdata.rs` tests, `src/backend/fake.test.ts`, `tests/e2e/shortcuts.spec.ts`

**Interfaces:**

- Produces: `SettingsPatch.shortcuts_expected: Option<BTreeMap<String, Option<String>>>`(JSON `shortcutsExpected`). 있으면 `apply` 가 지금 저장된 `settings.shortcuts` 와 같은지 먼저 보고, 다르면 아무것도 바꾸지 않고 `Err("shortcuts changed")` 를 돌려준다. 없으면 지금처럼 통째 교체.
- 화면: `commit`·「모두 기본값으로」 는 마지막으로 읽은 저장 맵을 `shortcutsExpected` 로 함께 보낸다. `"shortcuts changed"` 로 거절되면 표를 다시 읽고 그 줄 아래(「모두 기본값으로」 면 구역 위 오류 자리)에 「다른 창에서 단축키가 바뀌어 다시 읽었습니다. 다시 해 주세요」 를 보인다.

- [ ] **Step 1: 실패하는 시험**
  - Rust `a shortcut patch made from a stale map is refused`: 저장 맵 `{save: ⌘⇧S}` 에서 `expected: {}` 로 보낸 패치는 거절되고 저장 맵은 그대로, `expected` 가 같으면 적용된다.
  - vitest: 가짜 백엔드가 같은 규칙을 따른다.
  - e2e `a shortcut saved from a stale table is refused and the other window's change stays`(Review Focus 3): 두 창의 설정을 연 채, 창 1 에서 「새 메모」 를 바꾸고(창 2 의 표 갱신 이벤트를 붙잡아 옛 표로 둔다) 창 2 에서 「저장」 을 바꾸면 창 2 에 위 문구가 뜨고, 저장 맵에 창 1 의 변경이 남는다. 다시 하면 둘 다 남는다.
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현, 스펙 89행에 규칙 한 문장. **Step 4:** `cargo test`, `pnpm test`, `shortcuts.spec.ts`·`settings.spec.ts`(개수 보고).
- [ ] **Step 5: 커밋** `fix: refuse a shortcut save made from a table another window has changed`

### Task 4: 검색 띠가 새 검색어에 옛 개수를 남기지 않기

**Files:**

- Modify: `src/editor/search-bar.ts`(`commit` 285~302행, `showCount` 366~381행), 스펙 「동작 · 개수 세기」
- Test: `tests/e2e/search-bar.spec.ts`(146행 시험 포함)

**Interfaces:**

- 규칙: 이어 세는 중 0 개일 때 직전 표시를 그대로 두는 것은 **직전 표시가 같은 검색어(질의 문자열·옵션)의 것일 때만**이다. 검색어가 바뀐 뒤 첫 표시가 「0 개, 이어 세는 중」 이면 「– / 0+」 를 보이고 `find-bar-error` 를 뗀다. `SearchBar` 가 마지막 표시를 만든 질의를 `shownFor: SearchQuery | null` 로 기억하고 `SearchQuery.eq` 로 비교한다.

- [ ] **Step 1: 실패하는 시험** e2e `a new query never shows the last query's count`(Review Focus 4): `page.clock` 과 기존 `slowLooks` 꼴로 (가) 「1 / 3」 이 보이는 상태에서 결과가 먼 곳에만 있는 검색어로 바꾸면 첫 표시가 「– / 0+」 이고, (나) 「잘못된 정규식」 상태에서 고친 정규식으로 바꾸면 빨간 표시가 바로 사라진다. 146행 「a count that finds nothing in its time keeps what it showed」 는 같은 검색어 안에서 계속 통과해야 한다.
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현. **Step 4:** `search-bar.spec.ts`·`search-bar-app.spec.ts`(개수 보고).
- [ ] **Step 5: 커밋** `fix: show a new query's own count from its first pass`

### Task 5: 단축키 녹음 잔여

**Files:**

- Modify: `src/shortcuts/keys.ts`(`keyOfCode` 187~196행, `SYMBOLS` 143~168행), `src-tauri/src/shortcuts.rs`(`recordable` 173~193행), `src/ui/shortcut-settings.ts`(`onKey` 90~100행, `stop` 129~146행)
- Test: `src/shortcuts/keys.test.ts`, Rust `shortcuts.rs` tests, `tests/e2e/shortcuts.spec.ts`

**Interfaces:**

- 녹음이 받는 키에 `Numpad0`~`Numpad9`, `NumpadAdd`·`NumpadSubtract`·`NumpadMultiply`·`NumpadDivide`·`NumpadDecimal`·`NumpadEnter`·`NumpadEqual`, `Insert`, `Help` 를 더한다. 표기: 숫자패드는 「키패드 1」 처럼 `키패드 ` 접두 + 글자(＋−×÷.↩=), `Insert`→「Insert」, `Help`→「Help」.
- `IntlBackslash` 는 muda 가 macOS 메뉴에 걸지 못한다. 녹음에서 반응하지 않고, Rust `recordable` 도 거절한다(손으로 쓴 settings.json 의 그 항목은 버려진다).
- 확정한 녹음의 keyup: 녹음을 끝낸 조합의 주 키 keyup(수식키 keyup 은 막지 않는다)은, 그 키들이 모두 놓일 때까지 capture 단계에서 막는다(`stop` 이 keyup 리스너를 바로 떼지 않고 「놓일 키 목록」 이 빌 때 뗀다). 창이 포커스를 잃으면 목록을 비운다.

- [ ] **Step 1: 실패하는 시험**
  - 단위 `records numpad, Insert and Help but not IntlBackslash`(Review Focus 5): `acceleratorFromEvent` 가 `Numpad1`+⌘ → `CmdOrCtrl+Numpad1`, `Insert`+⌥ → `Alt+Insert`, `IntlBackslash`+⌘ → null. 표기 단언. 「has only shortcuts TS reads」 가 계속 통과.
  - Rust `intl_backslash_is_not_recordable` 과, 숫자패드·Insert·Help 단축키가 `menu::put` 에서 오류 없이 걸리는 시험(muda `Accelerator` 파싱과 macOS 키 변환 함수를 직접 부를 수 있으면 그것으로, 아니면 파싱까지만 단언하고 보고에 적는다).
  - e2e `the keyup of a recorded shortcut reaches nothing`: ⌥Space 로 녹음을 끝낸 뒤 keyup 이 그 줄 버튼을 누르지 않아 녹음이 다시 시작되지 않는다(`.recording` 0 개, 저장된 값 ⌥Space).
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현, fixture·가짜 사본 맞추기. **Step 4:** `pnpm test`, `cargo test`, `shortcuts.spec.ts`(개수 보고).
- [ ] **Step 5: 커밋** `feat: record numpad, Insert and Help, and swallow the recorded keyup`

### Task 6: 작은 화면 잔여와 install 자동화

**Files:**

- Modify: `src/app/controller.ts`(`loadShortcuts` 499~509행, window focus 처리기 424~427행), `src/theme/vscode-theme.ts`(`CSS_VARIABLES` 34행 옆), `src/theme/default-variables.test.ts`(`NOT_THEMED`), `src/ui/dialogs.ts`(32행), `src/ui/workspace-switcher.ts`(72행 focusout), `lefthook.yml`, `docs/guides/development.md`(90행 부근)
- Test: `tests/e2e/panes.spec.ts`, `src/theme/vscode-theme.test.ts`, `src/ui/dialogs` 단위 또는 `settings.spec.ts`, `tests/e2e/switcher.spec.ts`

- [ ] **Step 1: 각각 실패하는 시험을 먼저 본다**
  1. 첫 단축키 표 읽기가 실패해 빈 칸 보조 문구가 비었으면, 창이 다시 포커스될 때 표를 다시 읽는다. e2e: 첫 `shortcutTable` 을 거절하게 한 뒤 window `focus` 를 보내면 보조 문구가 「…⌘N 을 누르세요」 가 된다.
  2. `--accent-fg` 를 테마에서 받는다: `CSS_VARIABLES` 에 `--accent-fg ← button.foreground`. `DEFAULT_VARIABLES` 와 `NOT_THEMED` 를 맞춘다. 단위: `button.foreground` 가 있는 테마가 `--accent-fg` 를 낸다.
  3. `modal()` 이 이름을 고를 때 글자가 빈 `h1`/`p` 는 건너뛴다(`[...querySelectorAll("h1, p")].find(e => e.textContent?.trim())`). 단위 또는 e2e.
  4. 고르개 목록이 창 비활성화로 focusout 되면(`relatedTarget === null && !document.hasFocus()`) 목록을 닫고 포커스를 연 자리로 돌려준다. 메뉴 동작으로 키가 옮겨 간 경우(`switcher.spec.ts:196`)는 지금처럼 돌려주지 않는다. e2e: 목록을 연 채 `window.blur` 상황을 만들고(포커스를 iframe 밖 새 창으로 옮기는 등 Playwright 가 만들 수 있는 방법) 돌아오면 키가 검색칸(또는 편집기)에 있다. 만들 수 없으면 판정 함수 단위 시험으로 대신하고 보고에 적는다.
  5. `lefthook.yml` 에 `post-merge` 와 `post-rewrite` 를 더한다. 잡은 `post-checkout` 의 `deps` 와 같은 `pnpm install`(런타임 잡 먼저, 순차). 개발 가이드 90행의 「merge·pull 뒤에는 `pnpm install` 을 다시 돌린다」 를 「훅이 돌린다. 훅을 처음 받은 체크아웃은 `pnpm install` 을 한 번 돌려 훅을 등록한다」 로 고친다. 확인: 임시 저장소나 이 워크트리에서 `pnpm exec lefthook run post-merge` 가 설치를 돌리는 출력(보고). 공용 지침에 넣을 문장은 보고 「지침 제안」 에 적는다(`docs/guideline/lefthook/02-post-checkout.md` 는 고치지 않는다).
- [ ] **Step 2:** `pnpm test`, 관련 e2e(개수 보고).
- [ ] **Step 3: 커밋** 항목별로 나눠도 된다(`fix: …`, `chore: run pnpm install after merges and rebases`).

### Task 7: 흔들림 후보 둘과 문서

**Files:**

- Modify: `tests/e2e/panes.spec.ts`(769~787행), `tests/e2e/language.spec.ts`(필요할 때만), 이월 문서 두 곳의 이번에 끝낸 행(「(틈 메우기·단축키 후속에서 해결, 커밋 …)」 을 붙인다, 지우지 않는다), 보고서 「79개」 오기
- Create: `docs/superpowers/reports/2026-10-21-tote-notes-gaps-and-shortcuts-report.md`

- [ ] **Step 1: 재현.** panes 「the old right-edge drop target is gone」 과 `language.spec.ts` 전체를 각각 `--repeat-each=20`(부하 기록, 실패 메시지 보존). 실패가 나면 개발 가이드 「부하에서만 실패하는 테스트는…」 대로 원인을 찾아 고친다(앱 결함이면 앱). 0 이면 「재현 안 됨」 과 부하를 기록하고 시험은 그대로 둔다.
- [ ] **Step 2: 보고서.** 태스크별 결과, 사용자 결정 둘의 반영, 남은 것(화면 확인 후보: 숫자패드 단축키가 실제 메뉴에서 동작하는지, `page_loading` 의 도착 순서, `post-rewrite` 가 rebase pull 에서 도는지), 지침 제안.
- [ ] **Step 3: 커밋** `docs: record the gap and shortcut follow-ups`
