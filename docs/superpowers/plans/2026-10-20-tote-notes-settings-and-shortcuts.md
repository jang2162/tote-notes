# tote-notes 설정 화면 개편·줄번호·단축키 설정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 빈 칸 안내를 한 묶음으로 모으고, 편집기에 줄번호·글꼴 설정을 넣고, 설정 화면을 구역별로 나누고, 앱 명령 단축키를 바꿀 수 있게 한다.

**Architecture:** 설정 저장은 지금처럼 Rust `settings.json` 이 원천이고 `patch_settings` → `tote://config` 로 모든 창에 퍼진다. 단축키의 명령 표(id·이름·메뉴·기본값)와 고정 단축키 표, 검증은 Rust 한 곳에 두고 TS 는 `shortcut_table` 명령으로 받아 쓴다. 메뉴는 시작할 때 실제 단축키로 만들고, 항목 핸들을 보관해 설정이 바뀌면 `set_accelerator` 로 바꾼다. 편집기 줄번호는 새 CodeMirror Compartment 로, 글꼴은 CSS 변수로 반영한다.

**Tech Stack:** Tauri 2.12 (Rust, muda 0.20 메뉴), TypeScript, CodeMirror 6, vitest, Playwright(WebKit, 가짜 백엔드).

**Spec:** `docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md`

## Global Constraints

- 문구(그대로):
  - 설정 구역 「일반」「편집기」「모양」「단축키」「확장」. 모달 제목 「설정」.
  - 편집기 구역 「줄번호 표시」(체크박스), 「글꼴 크기」(숫자 11~24), 「글꼴」(입력, placeholder 「기본 글꼴」).
  - 일반 구역 루트 저장 버튼 「적용」(primary 아님). 기존 안내 「루트는 새로 여는 창부터 적용됩니다. 열린 창은 그대로입니다.」 유지.
  - 단축키 구역: 검색 placeholder 「명령 검색」, 녹음 중 「키를 누르세요」, 단축키 없음 「없음」, 줄 버튼 「되돌리기」, 구역 버튼 「모두 기본값으로」(확인 문구 「모든 단축키를 기본값으로 되돌릴까요?」, 확인 버튼 「되돌리기」), 충돌 「〈명령〉 에 이미 쓰고 있습니다」 + 버튼 「바꾸기」, 고정 충돌 「〈이름〉 에 고정된 단축키입니다」, 편집기 경고 「편집기의 〈명령〉 을 가립니다」, 고정 묶음 제목 「고정」.
  - 빈 칸 보조 문구: 단축키가 있으면 「메모 목록에서 메모를 열거나 〈단축키〉 을 누르세요」, 없으면 「메모 목록에서 메모를 여세요」. 미리보기 안내: 있으면 「미리보기 · 〈단축키〉 로 편집」, 없으면 「미리보기」. 기본값에서 지금 문구(⌘N, ⇧⌘V)와 글자 하나까지 같아야 한다.
- 기본값: 줄번호 켬, 글꼴 크기 14, 글꼴 빈 문자열(기본 글꼴).
- 단축키 표기: macOS 기호 ⌃⌥⇧⌘ 순서 + 키(글자는 대문자, 화살표 ←→↑↓, `\` `[` `]` `,` 그대로, F1~F12). 저장은 Tauri accelerator 문자열(`CmdOrCtrl+Shift+N` 꼴).
- 고정 단축키: 설정…(⌘,), ⌃1~⌃9, ⌘Z ⇧⌘Z ⌘X ⌘C ⌘V ⌘A, ⌘H ⌥⌘H ⌘M ⌃⌘F.
- 녹음이 받는 키: ⌘·⌃·⌥ 중 하나 이상 + 키, 또는 보조키 없는 F1~F12. Esc = 취소, Backspace·Delete = 없음.
- 대용량 뷰어는 14px·기본 글꼴에 묶는다.
- 디버그 앱은 언제나 `TOTE_DATA_DIR=<임시 폴더>`. `~/Tote` 는 건드리지 않는다. `~/Tote-dev`·`~/Library/Application Support/tote-dev` 는 사용자가 쓰고 있을 수 있으니 지우지 말고 작업 동안 바뀌지 않았는지로 판정한다(`docs/guides/development.md`).
- 화면(키보드·마우스)을 쓰는 확인은 이번 계획에서 하지 않는다. 사용자가 말할 때 한다. Task 8 이 목록만 쓴다.
- 테스트 보고는 실행 개수와 함께. 커밋 전에 `pnpm fmt`, `pnpm lint`, `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`.

## 이 계획이 정한 것

- **명령 표의 원천은 Rust 다.** `menu.rs` 의 하드코딩 accelerator 를 `shortcuts.rs` 의 표로 옮기고 메뉴 빌드도 그 표를 읽는다. TS 는 `Backend.shortcutTable()` 로 받는다. 표가 두 벌이 되지 않는다.
- **`SettingsPatch.shortcuts` 는 맵 전체를 바꾼다**(부분 패치가 아님). 단축키 화면은 언제나 지금 맵 전체를 계산해 보낸다. 「바꾸기」 처럼 두 명령을 한 번에 바꾸는 일이 한 번의 저장이 된다.
- **녹음 중 단축키 떼기는 창 라벨로 잡는다**: `suspend_shortcuts(on)` 은 부른 창 라벨을 기록하고, 그 창이 닫히거나 포커스를 잃으면 Rust 가 스스로 되돌린다. TS 도 녹음이 끝나는 모든 길(Esc, 바깥 클릭, blur, 모달 닫힘, `pagehide`)에서 `false` 를 보낸다. 둘 중 하나만 돌아도 되돌려진다.

## Review Focus

1. 녹음 중 모달을 Esc 로 닫거나, 창을 닫거나, 다른 앱으로 가면 메뉴 단축키가 돌아와 있다(돌아오지 않으면 앱 전체 단축키가 죽은 채 남는다). → Task 4 Rust 시험, Task 7 e2e.
2. `settings.json` 의 `shortcuts` 에 잘못된 항목 하나(모르는 id, 깨진 문자열, 고정과 같은 키, 다른 명령과 겹침)가 있어도 나머지 단축키·다른 설정이 그대로다. → Task 2 Rust 시험.
3. 글꼴 크기에 범위 밖 값·숫자 아닌 값을 넣거나 settings.json 에 손으로 적어도 11~24 로 묶이고 편집기가 깨지지 않는다. → Task 2, Task 6.
4. 줄번호를 바꿀 때 숨은 탭·다른 칸·다른 창의 편집기도 바뀐다(보이는 것만 바뀌면 탭을 바꿀 때 갑자기 달라진다). → Task 3 e2e.
5. 빈 칸 문구의 단축키(⌘N)를 지우거나 바꾸면 문구가 바로 따라간다(「undefined」·옛 표기 금지). → Task 5 단위·e2e.

---

### Task 1: 빈 칸 안내와 문제 화면을 한 묶음으로

**Files:**

- Modify: `src/app/surface.ts` (`showPlaceholder`)
- Modify: `src/styles.css` (`.editor-placeholder` 부근, `button.primary`, 다크 변수)
- Modify: `src/app/pane.ts` (빈 칸 버튼을 primary 로)
- Test: `tests/e2e/panes.spec.ts`

**Interfaces:**

- Produces: `showPlaceholder(text, action?, hint?)` 시그니처 그대로. DOM 은 `.editor-placeholder > .editor-placeholder-body > p, p.editor-placeholder-hint?, button?`.

- [ ] **Step 1: 실패하는 e2e** — `panes.spec.ts` 에 `the empty pane notice sits together in the middle` : 빈 칸에서 `.editor-placeholder-body` 가 하나 있고 그 안에 `p` 둘과 button 하나, 묶음의 세로 중심이 `.editor-placeholder` 세로 중심과 4px 안, 제목 `p` 아래끝과 버튼 위끝 사이가 80px 미만. 같은 판정을 `memo.spec.ts` 의 「열 수 없음」 화면(문구+「텍스트로 열기」)에도 하나.
- [ ] **Step 2:** `pnpm test:e2e panes.spec.ts memo.spec.ts` → 새 시험 실패.
- [ ] **Step 3: 구현** — `showPlaceholder` 가 자식을 `div.editor-placeholder-body` 로 감싼다. `.editor-placeholder` 는 그 하나를 가운데에(`display:grid; place-content:center`), 묶음은 세로 flex·`gap: 8px`·가운데 정렬. 제목 `p` 는 `--fg`·15px, 보조 문구는 `--muted`·12px, `p` 의 아래 margin 은 없앤다(간격은 gap 이 맡는다). 빈 칸의 「새 메모」 버튼에 `primary`. `button.primary` 의 글자색을 변수(`--accent-fg`)로 바꾸고 다크 기본에서 배경과 4.5:1 이상이 되게 다크 기본 primary 배경을 바꾼다(라이트는 그대로). 대비 값은 커밋 메시지에 적는다.
- [ ] **Step 4:** 위 두 spec 전체 통과 + 기존 `.editor-placeholder p` 셀렉터를 쓰는 `external.spec.ts` 통과. 실행 개수를 적는다.
- [ ] **Step 5: 커밋** `fix: keep the empty pane notice together in the middle`

### Task 2: 설정 저장 — 편집기 설정과 단축키 표 (Rust)

**Files:**

- Create: `src-tauri/src/shortcuts.rs`
- Modify: `src-tauri/src/appdata.rs` (`Settings`, `SettingsPatch`, `apply`)
- Modify: `src-tauri/src/lib.rs` (모듈 등록)
- Modify: `src-tauri/Cargo.toml` (필요하면 `muda = "0.20"` — Cargo.lock 의 버전과 같게. tauri 가 `Accelerator` 를 다시 내보내면 그것을 쓴다)

**Interfaces:**

- Produces (Rust):
  - `pub struct EditorSettings { pub line_numbers: bool, pub font_size: u8, pub font_family: String }` — serde camelCase, 기본 `true / 14 / ""`, 필드마다 `lenient`. `font_size` 는 읽을 때와 패치할 때 11..=24 로 묶는다(범위 밖은 가장 가까운 끝). 숫자 아님은 읽을 때 14, 패치에서는 거절.
  - `Settings.editor: EditorSettings`, `Settings.shortcuts: BTreeMap<String, Option<String>>` — `editor` 는 `#[serde(default, deserialize_with = "lenient")]`, `shortcuts` 는 항목마다 걸러 `sanitize` 를 거치는 `shortcut_overrides`(필드 모양 자체가 틀리면 `lenient` 처럼 비운다). `shortcuts` 는 비어 있으면 쓰지 않는다(`skip_serializing_if = "BTreeMap::is_empty"`).
  - `SettingsPatch` 에 `editor_line_numbers: Option<bool>`, `editor_font_size: Option<u8>`, `editor_font_family: Option<String>`, `shortcuts: Option<BTreeMap<String, Option<String>>>`.
  - `shortcuts.rs`:
    - `pub struct Command { pub id: &'static str, pub label: &'static str, pub menu: &'static str, pub default: Option<&'static str> }`
    - `pub const COMMANDS: &[Command]` — 지금 `menu.rs` 의 사용자 정의 항목 전부(설정 제외), 메뉴 순서대로. `menu` 는 「tote」「파일」「보기」「윈도우」.
    - `pub struct Fixed { pub name: &'static str, pub accelerator: &'static str }`, `pub const FIXED: &[Fixed]` — Global Constraints 의 고정 단축키(⌃1~⌃9 는 9개 항목, 이름 「워크스페이스 1」 … 「워크스페이스 9」. 설정은 「설정…」, 편집 메뉴는 메뉴 이름 그대로 「실행 취소」「실행 복귀」「오려두기」「복사하기」「붙여넣기」「모두 선택」, 「숨기기」「기타 숨기기」「최소화」「전체 화면」).
    - `pub fn same(a: &str, b: &str) -> bool` — 파싱한 accelerator 가 같은가(`CmdOrCtrl` 과 `Cmd`·`Super` 를 macOS 에서 같게).
    - `pub fn sanitize(saved: &BTreeMap<String, Option<String>>) -> BTreeMap<String, Option<String>>` — 설계 「저장과 적용」 의 항목별 규칙. 겹치면 사용자가 적은 쪽을 버리고, 둘 다 적었으면 `COMMANDS` 순서로 뒤의 것을 버린다.
    - `pub fn effective(saved) -> Vec<(&'static Command, Option<String>)>` — `sanitize` 뒤 기본값과 합친 실제 단축키.
    - `pub fn validate(map) -> Result<(), String>` — 패치용: 하나라도 규칙을 어기면 거절(오류 문구에 그 id).
- `SettingsPatch::apply` 는 `shortcuts` 를 `validate` 한 뒤 통째로 바꾼다. 거절은 `patch_settings` 가 `InvalidInput` 으로 돌려준다(`apply` 가 `Result` 를 돌려주게 바꾸고 호출자를 맞춘다).

- [ ] **Step 1: 실패하는 시험** (`appdata.rs`, `shortcuts.rs` 의 `#[cfg(test)]`):
  - `editor_settings_default_to_line_numbers_on_14_and_the_default_font` — `{}` 를 읽으면 `true, 14, ""`.
  - `a_font_size_out_of_range_is_clamped` — `fontSize: 40` → 24, `fontSize: 3` → 11, `fontSize: "big"` → 14, 그리고 `theme` 등 다른 필드는 그대로.
  - `one_bad_shortcut_entry_is_dropped_and_the_rest_kept` — `{"new-memo":"CmdOrCtrl+Shift+M","nope":"CmdOrCtrl+K","save":"Cmd+++","rename":"CmdOrCtrl+C","open-file":"CmdOrCtrl+Shift+M","close-tab":null}` → `sanitize` 결과는 `{"new-memo":Some("CmdOrCtrl+Shift+M"),"close-tab":None}`(`open-file` 은 `new-memo` 뒤라 버려짐).
  - `a_saved_shortcut_that_takes_another_commands_default_is_dropped` — `{"rename":"CmdOrCtrl+N"}` → 버려지고 `new-memo` 는 ⌘N 그대로.
  - `the_settings_command_cannot_be_rebound` — `{"settings":"CmdOrCtrl+K"}` → 버려짐, `validate` 는 거절.
  - `a_patch_with_an_unparsable_shortcut_is_refused_and_nothing_changes` — `apply` 가 `Err`, `settings` 가 패치 전과 같다.
  - `effective_matches_todays_menu` — 빈 맵의 `effective` 가 지금 `menu.rs` 의 accelerator 와 id 별로 같다(표로 적은 기댓값).
  - 기존 `a_patch_changes_only_the_fields_it_names` 에 새 필드 넷을 더한다.
- [ ] **Step 2:** `cargo test` → 새 시험 실패.
- [ ] **Step 3: 구현** (위 Interfaces).
- [ ] **Step 4:** `cargo test` 전체 통과, 개수 기록. `cargo clippy --all-targets -- -D warnings`.
- [ ] **Step 5: 커밋** `feat: store editor settings and shortcut overrides`

### Task 3: 편집기 줄번호와 글꼴 (TS)

**Files:**

- Modify: `src/backend/types.ts` (`Settings`, `SettingsPatch`), `src/backend/tauri.ts`, `src/backend/fake.ts` (기본값·`patchSettings`)
- Modify: `src/editor/setup.ts` (`EditorOptions.lineNumbers`, 새 Compartment, `lineNumbersEffect`, 거터 테마)
- Modify: `src/app/controller.ts` (설정 캐시, `extensions()`, `onConfigChanged()`)
- Modify: `src/theme/vscode-theme.ts` (`editorLineNumber.foreground` → `--line-number`, `editorLineNumber.activeForeground` → `--line-number-active`), `src/styles.css` (기본값, 대용량 뷰어 변수 분리)
- Test: `src/backend/fake.test.ts`, `src/theme/*.test.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**

- Consumes: Task 2 의 JSON 모양 `editor: { lineNumbers, fontSize, fontFamily }`, 패치 키 `editorLineNumbers`, `editorFontSize`, `editorFontFamily`.
- Produces: `Settings.editor: EditorSettings`(TS), `lineNumbersEffect(on: boolean): StateEffect<unknown>`(`setup.ts`), `AppController.settings: Settings` 캐시(`start()` 에서 읽고 `onConfigChanged()` 에서 갱신). CSS 변수 `--editor-size`·`--editor-font` 는 설정이 덮고, 대용량 뷰어는 `--large-text-size: 14px`·`--large-text-font`(지금 `--editor-font` 기본값)를 쓴다.

- [ ] **Step 1: 실패하는 시험**
  - vitest: 가짜 백엔드 `patchSettings({ editorFontSize: 30 })` → `settings().editor.fontSize === 24`(Rust 와 같은 묶기).
  - e2e `line numbers show by default and switch off in every tab and window`: 메모 둘을 두 칸에 열고(하나는 숨은 탭도 하나 더) `.cm-lineNumbers` 가 보인다 → 가짜 백엔드로 `patchSettings({ editorLineNumbers: false })` 후 설정 변경 이벤트 → 보이는 두 편집기에서 사라지고, 숨은 탭으로 바꿔도 없다. 다른 창(`startWindows`)에도 없다.
  - e2e `the editor font size follows the setting but the large text viewer stays at 14px`: `editorFontSize: 18` → `.cm-scroller` 계산 글꼴 크기 18px, 대용량 뷰어(기존 시험의 큰 파일 준비를 재사용) 14px.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3: 구현** — 재설정은 `reconfigureLanguage` 와 같은 방식으로 `this.docs` 전부(활성 view 면 dispatch, 아니면 `state.update`). 글꼴은 `document.documentElement.style` 에 변수로(테마 변수 적용과 부딪히지 않게 테마가 쓰지 않는 이름만). 거터: 배경 = 편집기 배경, 숫자 `var(--line-number, var(--muted))`, 활성 줄 숫자 `var(--line-number-active, var(--fg))`, 경계선 없음.
- [ ] **Step 4:** vitest·e2e 전체 통과, 개수 기록.
- [ ] **Step 5: 커밋** `feat: show line numbers and follow the editor font settings`

### Task 4: 메뉴가 단축키 표를 따르고, 녹음 중에는 단축키를 뗀다 (Rust)

**Files:**

- Modify: `src-tauri/src/app/menu.rs` (`build` 가 `shortcuts::effective` 를 읽음, 항목 핸들 보관)
- Modify: `src-tauri/src/app/commands.rs` (`shortcut_table`, `suspend_shortcuts`, `patch_settings` 뒤 메뉴 갱신), `src-tauri/src/lib.rs` (등록, 창 이벤트)
- Modify: `src/backend/types.ts`, `tauri.ts`, `fake.ts`

**Interfaces:**

- Produces:
  - Rust `pub struct MenuShortcuts` (manage 되는 state): 명령 id → `MenuItem<Wry>`, 지금 떼어 둔 창 라벨 `Option<String>`. `pub fn apply(&self, effective: &[(&Command, Option<String>)])`, `pub fn suspend(&self, label: &str)`, `pub fn resume(&self)`, `pub fn resume_if(&self, label: &str)`.
  - 떼기·되돌리기의 판단은 순수 함수로: `fn accelerators_while(suspended: bool, effective) -> Vec<(&str, Option<String>)>`(떼면 전부 `None`).
  - 커맨드 `shortcut_table() -> ShortcutTable`: `{ commands: [{ id, label, menu, default, current }], fixed: [{ name, accelerator }] }`(camelCase).
  - 커맨드 `suspend_shortcuts(window, on: bool)`.
  - `patch_settings` 가 저장한 뒤 `MenuShortcuts::apply` 를 부른다(떼어 둔 중이면 표만 바꾸고 되돌릴 때 새 표로).
  - 창이 `Destroyed` 되거나 `Focused(false)` 가 되면 `resume_if(label)`.
  - TS `Backend.shortcutTable(): Promise<ShortcutTable>`, `Backend.suspendShortcuts(on: boolean): Promise<void>`. 가짜 백엔드는 Rust 와 같은 표를 TS 상수로 들고(가짜 전용, `src/backend/fake-shortcuts.ts`), `suspended` 상태와 호출 기록을 `data` 에 남긴다. 가짜 표가 Rust 표와 어긋나지 않게 vitest 하나가 두 표의 id·기본값을 비교한다(Rust 표는 `cargo test` 가 JSON 으로 써 두는 픽스처 `src-tauri/tests/fixtures/shortcut-table.json` 을 읽는다. 픽스처가 낡으면 Rust 시험이 실패한다).
- [ ] **Step 1: 실패하는 시험** (Rust):
  - `suspended_menus_carry_no_accelerators_and_resume_restores_them`
  - `a_settings_change_while_suspended_takes_effect_on_resume`
  - `only_the_window_that_suspended_can_resume_by_focus_or_close` — 다른 라벨의 `resume_if` 는 아무것도 안 한다.
  - `the_table_lists_every_command_and_the_fixed_keys` — `COMMANDS` 의 id 가 메뉴 빌드가 쓰는 id 와 같다.
  - `the_shortcut_table_fixture_is_current` — 픽스처 파일과 지금 표가 같다.
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현. **Step 4:** `cargo test`·vitest 통과, 개수 기록.
- [ ] **Step 5: 커밋** `feat: build the menu from the shortcut table and suspend it while recording`

### Task 5: 단축키 표기·판정 (TS) 과 문구 반영

**Files:**

- Create: `src/shortcuts/keys.ts`, `src/shortcuts/keys.test.ts`
- Modify: `src/editor/setup.ts` (편집기 키맵 목록을 내보냄), `src/app/pane.ts`, `src/app/controller.ts` (문구가 표를 따름)
- Test: `tests/e2e/panes.spec.ts`

**Interfaces:**

- Produces (`keys.ts`):
  - `formatAccelerator(accelerator: string): string` — `"CmdOrCtrl+Shift+N"` → `"⇧⌘N"`, `"Alt+CmdOrCtrl+Left"` → `"⌥⌘←"`, `"CmdOrCtrl+\\"` → `"⌘\\"`, `"F5"` → `"F5"`.
  - `acceleratorFromEvent(event: Pick<KeyboardEvent, "key"|"code"|"metaKey"|"ctrlKey"|"altKey"|"shiftKey">): string | "cancel" | "clear" | null` — Global Constraints 의 녹음 규칙. 글자는 `code` 로 읽는다(⌥ 가 글자를 바꾸고 한글 입력기가 켜져 있어도 같은 키). 보조키만 누른 것은 `null`.
  - `sameAccelerator(a: string, b: string): boolean`
  - `editorBindings(): { accelerator: string; name: string }[]` — `setup.ts` 가 내보내는 키맵(`zedKeymap`, close-brackets, default, search, history)에서 macOS 에 적용되는 키(`mac` 우선)를 accelerator 로 바꾼다. 이름은 `run` 함수 이름(`selectLine` 등)을 그대로 쓴다.
  - `conflict(table: ShortcutTable, id: string, accelerator: string): { kind: "command"; id: string; label: string } | { kind: "fixed"; name: string } | { kind: "editor"; name: string } | null` — 고정 > 다른 명령 > 편집기 순서로 판정.
  - `shortcutHint(table: ShortcutTable, id: string): string | null` — 지금 단축키 표기, 없으면 `null`.
- 빈 칸 보조 문구와 미리보기 안내는 컨트롤러가 들고 있는 표로 만든다(Global Constraints 문구). 표는 `start()` 와 `onConfigChanged()` 에서 갱신하고, 바뀌면 빈 칸들과 상태 표시줄을 다시 그린다.

- [ ] **Step 1: 실패하는 시험**
  - `keys.test.ts`: 위 네 표기 예, `acceleratorFromEvent` — ⌘⇧ + `KeyN` → `"CmdOrCtrl+Shift+N"`, `KeyN` 만 → `null`, `F5` → `"F5"`, Esc → `"cancel"`, Backspace → `"clear"`, ⌥⌘ + `KeyN`(key 가 `˜`) → `"Alt+CmdOrCtrl+N"`; `conflict` — `rename` 에 ⌘N → command `new-memo`, ⌘C → fixed 「복사하기」, ⌘L → editor `selectLine`, ⇧⌘\ 의 기본값 `split-pane-down` 자기 자신 → editor(`cursorMatchingBracket`)이지 command 가 아니다.
  - e2e `the empty pane hint follows the new memo shortcut`: 가짜 표에서 `new-memo` 를 ⇧⌘M 으로 바꾸고 설정 변경 이벤트 → 보조 문구 「메모 목록에서 메모를 열거나 ⇧⌘M 을 누르세요」, `null` 로 → 「메모 목록에서 메모를 여세요」. 기본값에서는 지금 문구 그대로.
- [ ] **Step 2–4:** 실패 확인 → 구현 → 통과(개수 기록).
- [ ] **Step 5: 커밋** `feat: format shortcuts and let the pane hints follow them`

### Task 6: 설정 화면을 구역으로 나누고 편집기 구역을 넣는다

**Files:**

- Modify: `src/ui/settings.ts` (구역 목록·패널, 편집기 구역, 「적용」, 접근성), `src/ui/dialogs.ts`, `src/ui/versions.ts`(`aria-modal`, `aria-labelledby`), `src/styles.css`
- Modify: `src/app/controller.ts` (마지막 구역 기억 — 창 안에서만)
- Test: `tests/e2e/settings.spec.ts`

**Interfaces:**

- Produces: `openSettings(options: SettingsOptions & { section?: SettingsSection; onSection?: (s: SettingsSection) => void })`, `type SettingsSection = "general" | "editor" | "appearance" | "shortcuts" | "extensions"`. 단축키 구역은 Task 7 이 채우는 자리(`shortcutsSection(...)` 를 부를 빈 패널)만 둔다.
- 구역 목록은 `role="tablist"`·`tab`(`aria-selected`, `aria-controls`)·`tabpanel`, ↑↓ 로 이동, 한 번에 한 패널만 보인다. 모달 높이는 구역과 상관없이 같다.

- [ ] **Step 1: 실패하는 시험** — 기존 15개 케이스를 새 배치로 옮기고(구역을 먼저 고른다; 셀렉터 `input[name=workspaceRoot]` 등 이름은 그대로), 새로:
  - `settings open on 일반 and remember the last section in the window`
  - `the editor section saves line numbers, font size and font at once` — 체크박스 해제·크기 18·글꼴 「Menlo」 가 가짜 백엔드에 저장, 크기 칸에 30 → 24 로 보정되어 보인다.
  - `the root is saved with 적용 or Enter and only 닫기 is primary`
  - `the settings dialog is a labelled modal and its sections are tabs` — `aria-modal="true"`, `aria-labelledby` 가 제목을 가리킴, ↓ 로 다음 구역.
- [ ] **Step 2–4:** 실패 확인 → 구현 → `settings.spec.ts` 전체와 e2e 전체 통과(개수 기록).
- [ ] **Step 5: 커밋** `feat: split the settings screen into sections and add the editor section`

### Task 7: 단축키 구역

**Files:**

- Create: `src/ui/shortcut-settings.ts`
- Modify: `src/ui/settings.ts`(구역 연결), `src/styles.css`
- Test: `tests/e2e/shortcuts.spec.ts`(새 파일)

**Interfaces:**

- Consumes: Task 4 `shortcutTable()`·`suspendShortcuts()`, Task 5 `formatAccelerator`·`acceleratorFromEvent`·`conflict`, `patchSettings({ shortcuts })`(맵 전체).
- Produces: `shortcutsSection(options: { backend: Backend; onConfigChanged: (h: () => void) => () => void }): HTMLElement`.
- 저장할 맵 = 지금 표에서 기본값과 다른 명령만(`current` 가 `default` 와 다르면 그 값, 없으면 `null`).

- [ ] **Step 1: 실패하는 시험** (`shortcuts.spec.ts`):
  - `recording a new shortcut saves it and the menu table follows` — 「새 메모」 줄의 칸을 누르면 「키를 누르세요」, `suspendShortcuts(true)` 기록, ⇧⌘M 누르면 저장된 맵 `{"new-memo":"CmdOrCtrl+Shift+M"}`, `suspendShortcuts(false)` 기록, 줄에 「⇧⌘M」 과 「되돌리기」.
  - `Backspace clears a shortcut and 되돌리기 brings the default back`
  - `a key another command uses offers 바꾸기 and swaps them in one save` — 「이름 바꾸기」 에 ⌘N → 「새 메모 에 이미 쓰고 있습니다」, 「바꾸기」 → 맵 `{"new-memo":null,"rename":"CmdOrCtrl+N"}` 한 번 저장.
  - `a fixed key is refused` — ⌘C → 「복사하기 에 고정된 단축키입니다」, 저장 없음.
  - `an editor key is saved with a warning` — ⌘L → 저장, 「편집기의 selectLine 을 가립니다」.
  - `letters without a modifier are not recorded and Esc cancels` — `N` 만 → 여전히 「키를 누르세요」, Esc → 원래 값, 저장 없음, `suspendShortcuts(false)`.
  - `recording ends and shortcuts resume when the dialog closes or the window loses focus` — 녹음 중 모달 Esc(첫 Esc 는 녹음 취소, 두 번째가 모달 닫기)·`window.dispatchEvent(new Event("blur"))` 각각에서 `suspendShortcuts(false)` 가 마지막 기록.
  - `모두 기본값으로 asks first and clears the map`
  - `the search filters by name and by shortcut` — 「나누기」 → 두 줄, 「⌘N」 → 「새 메모」 한 줄.
  - `the fixed group lists the fixed keys and cannot be edited`
- [ ] **Step 2–4:** 실패 확인 → 구현 → 새 spec 과 e2e 전체 통과(개수 기록). 녹음 칸이 키를 받는 동안 `keydown` 은 capture 에서 `preventDefault`·`stopPropagation` 해 편집기·⌃1~⌃9 처리기로 가지 않게 한다.
- [ ] **Step 5: 커밋** `feat: let people record, clear and reset app shortcuts`

### Task 8: 문서 맞추기와 화면 확인 목록

**Files:**

- Modify: `docs/superpowers/specs/2026-10-07-tote-note-core-design.md` (「설정 화면은 최소로 둔다」 문장과 settings.json 설명)
- Modify: `docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md` (구현과 다른 곳)
- Create: `docs/superpowers/reports/2026-10-20-tote-notes-settings-and-shortcuts-smoke.md`
- Modify: `docs/guides/development.md` (새로 배운 것이 있으면)

- [ ] **Step 1:** 코어 스펙의 설정 화면 문장을 다섯 구역으로, settings.json 설명에 `editor`·`shortcuts` 를 더한다. 이 설계 문서에서 구현과 달라진 곳을 고친다.
- [ ] **Step 2:** 스모크 문서에 미룬 화면 확인을 절차·기대값으로 쓴다: 실제 메뉴에 바꾼 단축키가 표시되고 눌리는가, 녹음 중 ⌘N 이 새 메모를 만들지 않는가, 녹음 중 ⌘M·⌘H 가 창을 최소화·숨기는가(설계가 받아들인 한계 — 결과만 적는다), 메뉴 단축키와 편집기 키가 겹칠 때 어느 쪽이 받는가(⌘L 을 앱 명령에 걸고 편집기에서 누름), 줄번호·글꼴이 테마 바꿈과 다크에서 어떻게 보이는가, 빈 칸 안내 모양. 「사람 확인」 에 손 느낌 항목과 이월된 F-3·G-7·C-2b·C-2c 를 옮긴다.
- [ ] **Step 3:** `pnpm fmt`, 커밋 `docs: align the specs with the settings and shortcut work`

---

## 태스크 의존

1 은 독립. 2 → 3, 2 → 4 → 5 → 7, 3·5 → 6 → 7, 7 → 8. 실행 순서: 1, 2, 3, 4, 5, 6, 7, 8.
