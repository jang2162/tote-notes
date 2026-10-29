# tote-notes 제목 줄 탭·사이드바 접기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** macOS 에서 기본 제목 표시줄을 없애고 신호등 버튼·앱 이름·탭을 창 맨 윗줄 한 줄에 놓으며, 사이드바를 버튼·「보기」 메뉴·⌘B 로 접고 펼 수 있게 하고, 접힌 상태를 창마다 세션에 남긴다.

**Architecture:** 창을 만들 때 Rust 가 macOS 에서 제목 표시줄을 Overlay 로 바꾸고, 초기 스크립트(`initialization_script`)로 페이지에 창 라벨·macOS 여부·저장된 접힘 상태를 넘긴다. 페이지는 그 값(다시 읽기를 건넌 값이 `sessionStorage` 에 있으면 그것)을 `AppController` 생성자에서 동기로 읽어 `<html>` 클래스(`mac-titlebar`, `sidebar-collapsed`)를 첫 그림 전에 정한다. 창 끌기는 `data-tauri-drag-region` 을 쓰지 않고 앱이 `mousedown` 에서 `startDragging()` 을 직접 부른다.

**Tech Stack:** Tauri 2.12 (Rust, `WebviewWindowBuilder`, muda 메뉴), TypeScript, CSS, vitest, Playwright(WebKit, 가짜 백엔드).

**Spec:** `docs/superpowers/specs/2026-10-29-tote-notes-titlebar-tabs-and-sidebar-toggle-design.md`

## 전제

- **실행은 `jang2162/feat-sidebar-footer`(사이드바 맨 아래 설정 버튼·그 옆 업데이트 버튼)가 들어간 main 에서 시작한다.** 시작 전에 확인한다: `test -f src/ui/settings-button.ts && grep -q 'sidebar-footer' src/ui/sidebar.ts && echo ok` → `ok`. 아니면 멈추고 알린다. 이 계획의 `Sidebar` 생성자·`.sidebar-footer` 언급은 그 브랜치가 들어간 모양을 기준으로 한다.
- 이 계획은 `AppCore::switch_window`(`src-tauri/src/app/mod.rs`)와 `src-tauri/src/app/commands.rs` 를 고치지 않는다. 워크스페이스 전환을 건너는 접힘 상태는 페이지 쪽 `sessionStorage` 가 맡는다(Task 5). `jang2162/feat-workspace-order` 와 겹치는 파일은 없다. 그 브랜치가 먼저 들어왔으면 Task 2 끝에 `cargo test` 전체를 한 번 더 돈다.
- 작업은 워크트리에서 한다. e2e 는 워크트리 전용 포트로 돈다: `TOTE_E2E_PORT=<워크트리 전용 포트> pnpm exec playwright test <파일>` (`docs/guides/development.md` 「E2E 전에 WebKit 을 설치한다」, `docs/guideline/base/08-shared-resources.md`). 아래 명령의 `$P` 가 그 포트다.

## Global Constraints

- 문구(그대로):
  - 앱 이름 「Tote Notes」(굵게, macOS 에서만) — 스펙 「목표」·「macOS 가 아닐 때」.
  - 버튼 `aria-label`·`title`: 펼쳤을 때 「사이드바 접기」, 접었을 때 「사이드바 펼치기」. `title` 에는 지금 걸린 단축키를 설정 버튼과 같은 꼴로 붙인다(`사이드바 접기 (⌘B)`, 키가 없으면 붙이지 않는다) — 스펙 「사이드바 접기」.
  - 「보기」 메뉴 항목 「사이드바 접기/펼치기」, id `toggle-sidebar`, 기본 키 `CmdOrCtrl+B` — 스펙 「사이드바 접기」.
  - 접힌 동안 업데이트가 있으면 펼치기 버튼에 덧붙이는 말 「업데이트 있음」 — 스펙 「사이드바 접기」.
- 저장된 사람의 키가 ⌘B 를 쓰고 있으면 그 키가 이기고 `toggle-sidebar` 는 키 없이 시작한다. 다른 명령의 기본 키와 겹치는 저장 키를 버리는 지금 규칙(`a_saved_shortcut_that_takes_another_commands_default_is_dropped`)은 그대로다 — 스펙 「사이드바 접기」.
- 사이드바 열 너비가 **0.16초** 동안 줄고 는다. `prefers-reduced-motion` 이면 바로 바뀐다. 첫 그림에서는 돌지 않는다 — 스펙 「사이드바 접기」·「세션」.
- 접으면 완전히 사라진다(열 0). 펼친 너비는 지금처럼 240px. 최소 창 너비 480px 는 그대로 — 스펙 「하지 않는 것」·「사이드바 접기」.
- 맨 윗줄 높이는 사이드바 윗줄과 탭 줄이 함께 쓰는 CSS 변수 하나로, 34~38px 안에서 정한다 — 스펙 「창 틀 (macOS)」. **계획 판단:** `--top-row-height: 36px`, macOS 가 아닐 때도 같은 변수를 쓴다.
- 창 틀: macOS 에서만 `title_bar_style(TitleBarStyle::Overlay)`·`hidden_title(true)`·`traffic_light_position`. 창 제목 문자열은 지금처럼 정한다. `accept_first_mouse(true)` 는 그대로 — 스펙 「창 틀 (macOS)」·「하지 않는 것」·「지켜야 할 제약」.
- macOS 배치는 `<html>` 의 클래스 하나로 켠다. **계획 판단:** 이름 `mac-titlebar`. 앱은 Rust 의 `cfg!(target_os = "macos")` 를 초기 스크립트로 받아 켠다. 가짜 백엔드(브라우저 미리보기·e2e)는 `FakeData.macTitlebar` 가 `true` 일 때만 켠다 — 스펙 「macOS 가 아닐 때」.
- 권한: `src-tauri/capabilities/default.json` 에 `core:window:allow-start-dragging`, 그리고 앱이 확대를 부르므로 `core:window:allow-toggle-maximize` — 스펙 「창 끌기」.
- 탭 줄 DOM(`.tabbar`, `.tab`, `.tab-label`, `.tab-close`)과 역할 구조는 그대로. 앞머리는 `.tabbar` 밖에 둔다. 새 색을 하드코딩하지 않는다. 테마에서 오지 않는 새 변수는 `src/theme/default-variables.test.ts` 의 `NOT_THEMED` 에 넣는다 — 스펙 「지켜야 할 제약」.
- 디버그 앱은 언제나 `TOTE_DATA_DIR=<임시 폴더>` 로 띄운다(`docs/guides/development.md` 「디버그 앱은 언제나 `TOTE_DATA_DIR` 을 주고 띄운다」).
- 테스트 보고는 실행 개수와 함께. 0개면 통과가 아니다. 커밋 전에 `pnpm fmt`, `pnpm lint`, `pnpm typecheck`, `(cd src-tauri && cargo fmt --all && cargo clippy --all-targets -- -D warnings)`. 커밋할 파일은 경로로 stage 한다.

## 이 계획이 정한 것 (계획 판단)

- **접힘 상태의 출처는 셋이고 우선순위가 있다.** ① 같은 창 페이지가 남긴 `sessionStorage["tote.sidebarCollapsed.<창 라벨>"]`(페이지는 시작할 때와 바꿀 때마다 지금 값을 남긴다. 다시 읽기 — 워크스페이스 전환 — 를 건너는 값이다) ② 초기 스크립트의 `sidebarCollapsed`(Rust 가 창을 만들 때 그 창의 저장된 배치에서 읽은 값) ③ 펼침. 페이지는 세션 파일에서 읽은 `sidebarCollapsed` 로 상태를 바꾸지 않는다 — 시작 값이 이미 그것이거나(실행), 전환 전 값이 이겨야 한다(전환). 다르면 세션을 다시 쓴다. 라벨로 키를 나누는 것은 `window.open` 이 연 창(가짜 허브의 새 창)이 여는 쪽 `sessionStorage` 를 복사받기 때문이다.
- **세션에는 접혔을 때만 `"sidebarCollapsed": true` 를 쓴다.** 펼친 창의 세션은 지금과 글자 하나 다르지 않아, 세션 JSON 을 통째로 비교하는 기존 시험이 그대로 선다. 읽을 때는 `true` 만 접힘이다(Rust·TS 같게).
- **창 끌기는 `src/ui/window-drag.ts` 의 `dragsWindow` 한 곳이 맡는다.** `data-tauri-drag-region` 을 어디에도 쓰지 않는다(그 속성의 두 번 누르기 확대가 탭 줄의 새 탭과 겹치지 않게). 첫 누르기(`detail === 1`)에 끌기, 사이드바 윗줄만 두 번째 누르기를 그 자리에서 뗄 때 확대(`toggleMaximize`) — Tauri `drag.js` 의 macOS 규칙과 같다. 창 끌기는 macOS 배치일 때만 켠다(다른 OS 는 기본 제목 표시줄이 있다).
- **탭 줄 빈 곳 판정은 지금 `dblclick` 과 같은 「`event.target` 이 `.tabbar` 자신」 이다.** `TabBar` 는 고치지 않고, `Pane` 이 자기 탭 줄에 `dragsWindow` 를 건다.
- **앞머리는 칸 DOM 안에 둔다.** `Pane` 에 `.pane-head`(앞머리 자리 + `.tabbar`)를 만들고, 컨트롤러가 앞머리 요소 하나를 `layoutPanes` 마다 왼쪽 맨 위 칸(`rect.x`·`rect.y` 가 `EDGE` 이하)의 `.pane-head` 맨 앞으로 옮긴다. 펼쳐 있을 때는 CSS 로 감춘다. 탭을 앞머리에 놓으면 `dropTarget` 이 `.pane-head` 를 탭 줄로 쳐서 `indexAt` 이 0 을 준다.
- **버튼은 둘이다**: 사이드바 윗줄의 접기 버튼(`aria-expanded="true"`)과 앞머리의 펼치기 버튼(`aria-expanded="false"`). 둘 다 설정 버튼처럼 Tab 순서에 든다(스펙 「사이드바 접기」의 「다른 도구 버튼들의 관례」 → `SettingsButton`). 키보드로 펼치기 버튼을 눌러 펼치면 포커스는 사이드바의 접기 버튼으로 간다(감춰지는 버튼에 포커스가 남지 않게). 마우스·메뉴·⌘B 로 펼칠 때는 포커스를 옮기지 않는다.
- **⌘B 양보는 명령 표의 표시 하나다.** `Command.yields: bool` — 기본 키가 저장된 키에 양보하는 명령. 지금은 `toggle-sidebar` 하나다. 표(`CommandRow`)에도 `yields` 를 실어(거짓이면 쓰지 않음) 가짜 백엔드 사본이 고정 파일로 Rust 와 맞는지 시험한다.
- 메뉴 자리: 「보기」 맨 위에 `toggle-sidebar`, 구분선, 그 아래 지금 순서. 명령 표(`COMMANDS`)도 같은 순서로 `search-workspace` 앞에 넣는다(`the_table_lists_every_command_and_the_fixed_keys` 가 두 순서를 같게 요구한다).
- 신호등 시작 좌표 `LogicalPosition::new(14.0, 11.0)`, 신호등 자리 너비 `--traffic-lights-width: 80px`. Task 9 의 화면 확인에서 세로 가운데·덮임을 재고 어긋나면 이 둘만 고친다.
- 업데이트 표시: 펼치기 버튼에 `.has-update`(점), `aria-label` 「사이드바 펼치기 · 업데이트 있음」, `title` 「사이드바 펼치기 (⌘B) · 업데이트 있음」. 「 · 」 는 상태 표시줄·미리보기 안내가 쓰는 이음표다.
- 앞머리의 빈 곳은 창을 끌지만 두 번 누르기에는 아무것도 하지 않는다(확대는 사이드바 윗줄만, 새 탭은 탭 줄만).
- 접는 동안 사이드바 내용은 줄바꿈·재배치되지 않고 잘린다(내용 너비를 `--sidebar-width` 로 둔다). 메모 목록의 `ResizeObserver` 가 0.16초 동안 매 프레임 다시 그리지 않게 하려는 것이다.

## Review Focus

1. 손으로 고친 세션의 `sidebarCollapsed` 가 `"true"`·`1`·`null` 이면 Rust(초기 스크립트)와 TS(세션 읽기) 모두 펼침으로 읽는다. 한쪽만 접힘으로 읽으면 실행마다 세션이 다시 쓰이거나 상태가 뒤집힌다. → Task 2 Rust 시험, Task 5 vitest.
2. `sessionStorage` 를 읽거나 쓰다 예외가 나도 시작 값으로 열리고 접기·펼치기가 그대로 된다. → Task 5 vitest.
3. 최소 너비(480px) 창에서 접고 탭이 많아도 앞머리가 줄어들거나 탭에 덮이지 않고, 탭 줄은 여전히 가로로 스크롤된다. → Task 4 e2e.
4. 애니메이션 중에 다시 접기·펼치기(⌘B 두 번)를 하면 마지막 상태로 끝나고 `inert`·너비·클래스가 서로 맞는다. → Task 4 e2e.
5. ⌘B 를 양보한 `toggle-sidebar` 의 「되돌리기」 는 다른 명령의 키를 소리 없이 빼앗지 않고 「〈명령〉 에 이미 쓰고 있습니다」 와 「바꾸기」 를 띄운다. → Task 1 e2e.

---

### Task 1: `toggle-sidebar` 명령과 양보하는 기본 키

**Files:**

- Modify: `src-tauri/src/shortcuts.rs` (`Command`, `command`, `COMMANDS`, `resolve`, `CommandRow`, `table`, 시험)
- Modify: `src-tauri/src/app/menu.rs` (`MENUS` 의 「보기」, 시험)
- Modify: `src-tauri/tests/fixtures/shortcut-table.json` (재생성)
- Modify: `src/backend/types.ts` (`ShortcutCommand.yields?`)
- Modify: `src/backend/fake-shortcuts.ts` (`FAKE_SHORTCUT_COMMANDS`, `resolveShortcuts`)
- Test: `src/backend/fake-shortcuts.test.ts`, `tests/e2e/shortcuts.spec.ts`

**Interfaces:**

- Produces (Rust): `Command { …, pub yields: bool }`; `const fn yielding(id, label, menu, default) -> Command`(나머지는 `command` 그대로 `yields: false`). `CommandRow.yields: bool` — `#[serde(skip_serializing_if = …)]` 로 거짓이면 쓰지 않는다.
- Produces (TS): `ShortcutCommand.yields?: true`. 메뉴 id `"toggle-sidebar"` 가 페이지의 `onMenu` 로 온다(라우팅은 지금 `Route::App` 그대로 — 새 코드 없음).

- [ ] **Step 1: 실패하는 Rust 시험** (`shortcuts.rs` 의 `mod tests`)
  - `the_sidebar_toggle_is_cmd_b_in_the_view_menu` — `COMMANDS` 의 `toggle-sidebar` 가 `label == "사이드바 접기/펼치기"`, `menu == "보기"`, `default == Some("CmdOrCtrl+B")`, `yields == true`. `shortcut_of(&BTreeMap::new(), "toggle-sidebar") == Some("CmdOrCtrl+B")`.
  - `a_saved_cmd_b_keeps_its_command_and_the_sidebar_toggle_starts_with_none` — `{"rename":"CmdOrCtrl+B"}`: `sanitize` 가 그대로 돌려주고, `rename` 은 `Some("CmdOrCtrl+B")`, `toggle-sidebar` 는 `None`, `validate` 는 `Ok`. 기본 키가 있는 명령 `{"new-memo":"CmdOrCtrl+B"}` 도 같다(`new-memo` ⌘B, `toggle-sidebar` 없음).
  - `only_the_sidebar_toggle_gives_its_default_way` — `COMMANDS.iter().filter(|c| c.yields).map(|c| c.id)` 가 `["toggle-sidebar"]`. 기존 `a_saved_shortcut_that_takes_another_commands_default_is_dropped` 는 고치지 않고 그대로 통과해야 한다.
  - `effective_matches_todays_menu` 의 기댓값에 `("toggle-sidebar", Some("CmdOrCtrl+B"))` 를 `search-workspace` 앞에 넣는다.
  - `the_table_marks_only_the_yielding_default` — `serde_json::to_value(&table(&BTreeMap::new()))` 의 `commands` 중 `yields` 키가 있는 것은 `toggle-sidebar` 하나이고 값은 `true`.
  - `menu.rs`: `the_view_menu_starts_with_the_sidebar_toggle` — `MENUS` 의 「보기」 앞 세 칸이 `[Slot::Command("toggle-sidebar"), Slot::Separator, Slot::Command("search-workspace")]`.
- [ ] **Step 2:** `(cd src-tauri && cargo test shortcuts:: && cargo test menu::)` → 새 시험이 컴파일 오류 또는 실패.
- [ ] **Step 3: 구현** — `yields` 필드와 `yielding` 생성자, `COMMANDS` 에 `yielding("toggle-sidebar", "사이드바 접기/펼치기", "보기", Some("CmdOrCtrl+B"))` 를 `search-workspace` 앞에. `resolve` 는 `kept` 에 없는 `yields` 명령의 기본 키를, `kept` 의 어떤 `Some` 값과 `same` 이면 `None` 으로 준다(그러면 `clashing` 이 그 기본 키를 이긴 것으로 보지 않는다). `CommandRow`·`table` 에 `yields`. `MENUS` 「보기」 맨 앞에 `Slot::Command("toggle-sidebar"), Slot::Separator`.
- [ ] **Step 4:** 고정 파일 재생성 `(cd src-tauri && UPDATE_FIXTURES=1 cargo test the_shortcut_table_fixture_is_current)` 뒤 `(cd src-tauri && cargo test)` 전체 통과, 실행 개수 기록.
- [ ] **Step 5: 실패하는 TS 시험**
  - `fake-shortcuts.test.ts` 의 「has Rust's commands …」 매핑에 `yields` 를 더한다: `({ id, label, menu, default: keys, ...(yields ? { yields } : {}) })`.
  - 같은 파일에 `describe("sanitizeShortcuts")` → `it("lets a saved ⌘B stand and leaves the sidebar toggle with none")`: `sanitizeShortcuts({ rename: "CmdOrCtrl+B" })` 가 `{ rename: "CmdOrCtrl+B" }`, `resolveShortcuts(그것)` 에서 `toggle-sidebar` 자리가 `null`, `refusedShortcut({ rename: "CmdOrCtrl+B" })` 가 `null`.
  - `shortcuts.spec.ts` 「the search filters by name and by shortcut」 의 `toHaveCount(25)` → `26`.
  - `shortcuts.spec.ts` 새 시험 `a saved ⌘B keeps its command, and resetting the sidebar toggle asks before taking it` — seed `settings: { ...defaultFakeData().settings, shortcuts: { rename: "CmdOrCtrl+B" } }`: `keys(panel, "rename")` 「⌘B」, `keys(panel, "toggle-sidebar")` 「없음」. `row(panel, "toggle-sidebar")` 의 「되돌리기」 → `.shortcut-note` 가 `/이름 바꾸기… 에 이미 쓰고 있습니다/`, `patches` 는 `[]`. 「바꾸기」 → `savedMap` 이 `{}`, `toggle-sidebar` 「⌘B」, `rename` 「없음」.
- [ ] **Step 6:** `pnpm exec vitest run src/backend/fake-shortcuts.test.ts` 와 `TOTE_E2E_PORT=$P pnpm exec playwright test tests/e2e/shortcuts.spec.ts` → 새 시험 실패.
- [ ] **Step 7: 구현** — `types.ts` 에 `yields?: true`, `FAKE_SHORTCUT_COMMANDS` 의 `search-workspace` 앞에 `{ id: "toggle-sidebar", label: "사이드바 접기/펼치기", menu: "보기", default: "CmdOrCtrl+B", yields: true }`, `resolveShortcuts` 에 Rust `resolve` 와 같은 양보.
- [ ] **Step 8:** 위 두 명령 통과(개수 기록), `pnpm exec vitest run` 전체 통과.
- [ ] **Step 9: 커밋** `feat: add the sidebar toggle command, whose ⌘B gives way to a saved key`

### Task 2: 창 틀과 시작 값 (Rust)

**Files:**

- Modify: `src-tauri/src/session/mod.rs` (`layout_sidebar_collapsed`, 시험)
- Modify: `src-tauri/src/app/windows.rs` (`open_window`, `window_start_script`, 상수, 시험)
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**

- Produces (Rust): `pub fn layout_sidebar_collapsed(layout: &Value) -> bool` — `layout["sidebarCollapsed"]` 이 JSON `true` 일 때만 참. `fn window_start_script(label: &str, mac_titlebar: bool, sidebar_collapsed: bool) -> String` — `window.__TOTE_WINDOW_START__ = <JSON>;`, JSON 은 `serde_json::json!` 으로 만든 `{"label", "macTitlebar", "sidebarCollapsed"}`.
- Produces (페이지에 보이는 것): 전역 `window.__TOTE_WINDOW_START__ = { label: string, macTitlebar: boolean, sidebarCollapsed: boolean }` 이 페이지 스크립트보다 먼저 있다(메인 프레임만 — `initialization_script`, `…_for_all_frames` 가 아님). Task 3 이 읽는다.

- [ ] **Step 1: 실패하는 시험**
  - `session/mod.rs`: `the_sidebar_is_collapsed_only_when_the_layout_says_true` — `json!({"sidebarCollapsed": true})` → 참. `{"sidebarCollapsed": "true"}`, `{"sidebarCollapsed": 1}`, `{"sidebarCollapsed": null}`, `{"sidebarCollapsed": false}`, `{"panes": []}` → 거짓.
  - `windows.rs`: `the_start_script_names_the_window_its_title_bar_and_its_sidebar` — `window_start_script("ws-3", true, false)` 가 `window.__TOTE_WINDOW_START__ = ` 로 시작하고 `;` 로 끝나며, 그 사이를 `serde_json::from_str` 한 값이 `json!({"label": "ws-3", "macTitlebar": true, "sidebarCollapsed": false})`. `("ws-1", false, true)` 도 하나.
- [ ] **Step 2:** `(cd src-tauri && cargo test layout_sidebar && cargo test start_script)` → 실패(없는 함수).
- [ ] **Step 3: 구현**
  - `open_window`: `WindowPlan::Restore(k)` 갈래가 `core.saved_layout(&path, k)` 한 번으로 `frame`(지금처럼 `layout_frame`)과 `collapsed`(`layout_sidebar_collapsed`)를 함께 얻는다. `Fresh`·`Tab` 은 `false`(스펙 「세션」 — 새 창·떼어 낸 창·처음 여는 워크스페이스는 펼침). 저장된 배치가 없으면 `false`.
  - 빌더: `.initialization_script(window_start_script(&label, cfg!(target_os = "macos"), collapsed))`. `#[cfg(target_os = "macos")]` 블록에서 `.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(tauri::LogicalPosition::new(TRAFFIC_LIGHTS_X, TRAFFIC_LIGHTS_Y))`, 상수 `TRAFFIC_LIGHTS_X = 14.0`, `TRAFFIC_LIGHTS_Y = 11.0`(계획 판단, 주석: 맨 윗줄 `--top-row-height` 36px 의 세로 가운데. CSS `--traffic-lights-width` 와 짝). `.title(title)`·`.accept_first_mouse(true)` 는 그대로.
  - `default.json` 의 `permissions` 에 `"core:window:allow-start-dragging"`, `"core:window:allow-toggle-maximize"`.
- [ ] **Step 4:** `(cd src-tauri && cargo test)` 전체 통과(개수 기록), `cargo build` 통과(tauri-build 가 권한 이름을 검사한다), clippy.
- [ ] **Step 5: 커밋** `feat: overlay the macOS title bar and hand each window its start values`

### Task 3: 백엔드 면 — 시작 값·창 끌기·확대 (TS)

**Files:**

- Modify: `src/backend/types.ts` (`WindowStart`, `Backend`)
- Modify: `src/backend/tauri.ts`, `src/backend/fake.ts` (`FakeData`, `FakeBackend`)
- Test: `src/backend/tauri.test.ts`, `src/backend/fake.test.ts`

**Interfaces:**

- Consumes: Task 2 의 `window.__TOTE_WINDOW_START__`.
- Produces:
  - `export interface WindowStart { label: string; macTitlebar: boolean; sidebarCollapsed: boolean }`
  - `Backend.windowStart(): WindowStart` — **동기**. 같은 값을 매번 돌려준다.
  - `Backend.startWindowDrag(): Promise<void>`, `Backend.toggleWindowZoom(): Promise<void>`.
  - `FakeData.macTitlebar?: boolean`, `FakeData.windowDrags?: number`, `FakeData.windowZooms?: number`(「Absent in old seeds」 꼴).

- [ ] **Step 1: 실패하는 시험**
  - `tauri.test.ts`: `getCurrentWebviewWindow` 모의를 `{ label: "ws-9", startDragging: vi.fn(), toggleMaximize: vi.fn() }` 로 바꾸고 `describe("TauriBackend window start")`:
    - `it("reads the values the native side put on the page")` — `__TOTE_WINDOW_START__ = { label: "ws-2", macTitlebar: true, sidebarCollapsed: true }` 를 두고 만든 백엔드의 `windowStart()` 가 그 값.
    - `it("reads anything else as an expanded window that is not macOS, named by its label")` — 전역이 없거나 `{ macTitlebar: "yes", sidebarCollapsed: 1, label: 5 }` 면 `{ label: "ws-9", macTitlebar: false, sidebarCollapsed: false }`.
    - `it("drags and zooms through the window")` — `startWindowDrag()`·`toggleWindowZoom()` 이 모의의 `startDragging`·`toggleMaximize` 를 한 번씩 부른다.
  - `fake.test.ts`: `describe("FakeBackend window start")`:
    - `it("is not macOS and expanded by default")` — `defaultFakeData()` 로 `{ label: <FAKE_LABEL 값>, macTitlebar: false, sidebarCollapsed: false }`.
    - `it("takes macOS from the seed and the sidebar from the window's saved layout")` — `macTitlebar: true`, `session` 에 `sidebarCollapsed: true` 인 창 하나 → 둘 다 참. `sidebarCollapsed: "true"` 이면 거짓.
    - `it("counts drags and zooms")` — 각각 두 번 부르면 `data.windowDrags === 2`, `data.windowZooms === 2`.
- [ ] **Step 2:** `pnpm exec vitest run src/backend/tauri.test.ts src/backend/fake.test.ts` → 실패.
- [ ] **Step 3: 구현** — `TauriBackend` 은 생성할 때 전역을 한 번 읽어 필드마다 타입을 보고(`=== true`, `typeof label === "string"`) 거른다. 전역의 타입은 `declare global { interface Window { __TOTE_WINDOW_START__?: unknown } }`. 가짜는 `readWindowLayout` 의 본문을 동기 사설 메서드로 빼서 같은 배치에서 `parseJson` 후 `sidebarCollapsed === true` 를 읽는다(허브가 있으면 `hub.layout`). 두 카운터는 `commit()` 한다.
- [ ] **Step 4:** 같은 명령 통과(개수), `pnpm typecheck`.
- [ ] **Step 5: 커밋** `feat: let the page read its window's start values and drag or zoom the window`

### Task 4: 사이드바 윗줄·접기·앞머리

**Files:**

- Create: `src/ui/sidebar-toggle.ts` (`SidebarToggle`, `tabLead`)
- Modify: `src/ui/sidebar.ts` (윗줄)
- Modify: `src/app/pane.ts` (`.pane-head`, `attachLead`)
- Modify: `src/app/controller.ts` (상태, `onMenu`, `layoutPanes`, `dropTarget`, `shortcutsChanged`, 생성자)
- Modify: `src/styles.css`, `src/theme/default-variables.test.ts` (`NOT_THEMED`)
- Create: `tests/e2e/sidebar-toggle.spec.ts`

**Interfaces:**

- Consumes: Task 1 의 메뉴 id `toggle-sidebar`, Task 3 의 `Backend.windowStart()`.
- Produces:
  - `src/ui/sidebar-toggle.ts`:
    - `export class SidebarToggle { readonly el: HTMLButtonElement; constructor(role: "collapse" | "expand", onPress: () => void); setShortcut(shortcut: string | null | undefined): void }` — `class="sidebar-toggle"`, `type="button"`, `aria-expanded` 는 collapse `"true"`/expand `"false"`, 이름은 Global Constraints. 아이콘은 사각형 + 왼쪽 세로줄 SVG(`currentColor`, `aria-hidden`). `setUpdate` 는 Task 6 이 더한다.
    - `export function tabLead(expand: SidebarToggle): HTMLElement` — `div.tab-lead` > `span.traffic-lights-room` + 버튼.
  - `Sidebar` 생성자 맨 앞에 `collapse: SidebarToggle` 을 받는다: `new Sidebar(collapse, switcher, memoList, search, settings, update)`. `readonly head: HTMLElement` = `div.sidebar-head` > `span.traffic-lights-room`, `span.app-name`(「Tote Notes」), `collapse.el`(오른쪽 끝). `nav.sidebar` 의 첫 자식.
  - `Pane.head: HTMLElement`(`div.pane-head` > 앞머리 자리 + `tabBar.el`), `Pane.attachLead(lead: HTMLElement): void`(이미 자식이면 아무것도 안 함, 아니면 `head` 맨 앞으로). `Pane.el` 의 자식은 `head`, `surface.el`.
  - `AppController`: 필드 `collapseButton`·`expandButton`(`SidebarToggle`), `lead`(`tabLead(expandButton)`). `get sidebarCollapsed(): boolean`, `setSidebarCollapsed(collapsed: boolean): void`, `toggleSidebar(): void`(UI 시험이 `window.__tote.app` 로 읽는다). `onMenu` 의 `"toggle-sidebar"` → `toggleSidebar()`. `"search-workspace"` 는 먼저 `setSidebarCollapsed(false)`.
  - `<html>` 클래스: `mac-titlebar`(생성자에서 `windowStart().macTitlebar`), `sidebar-collapsed`(접힘), `sidebar-animates`(`setSidebarCollapsed` 가 처음 불릴 때 붙이고 떼지 않는다 — 첫 그림에서는 전환이 없게).
  - CSS 변수(`:root`, `NOT_THEMED` 에 `SAME(...)` 로): `--top-row-height: 36px`, `--sidebar-width: 240px`.

- [ ] **Step 1: 실패하는 e2e** (`sidebar-toggle.spec.ts`, 기본은 macOS 가 아닌 배치. `toggle = (page, name) => page.getByRole("button", { name, exact: true })` 는 `name` 으로 「사이드바 접기」/「사이드바 펼치기」 를 찾는다. 업데이트가 붙은 이름은 Task 6.)
  - `the toggle collapses the sidebar to nothing and the lead's button brings it back` — 「사이드바 접기」 클릭 → `html` 이 `sidebar-collapsed`, `.sidebar` 가 `inert`, `.sidebar` 너비가 0 이 될 때까지 poll, 첫 칸(`.pane` 중 x 가 가장 작은 것)의 x 가 0. `.tab-lead` 가 보이고 그 안의 「사이드바 펼치기」 의 `aria-expanded` 가 `"false"`. 그것을 클릭 → 클래스 없음, `inert` 없음, 너비 240 까지 poll, `.tab-lead` 안 보임, 「사이드바 접기」 의 `aria-expanded` 가 `"true"`.
  - `the menu's toggle collapses and expands` — `menu(page, "toggle-sidebar")` 두 번에 위와 같은 두 상태.
  - `collapsing takes the keys out of the sidebar to the focused pane` — 메모 하나 열고 `.memo-filter` 에 포커스 → 메뉴 접기 → `.cm-content` 포커스. 열린 탭이 없을 때는 `document.activeElement` 가 `.pane.focused`. 접힌 뒤 `.memo-filter` 를 `focus()` 해도 포커스되지 않는다.
  - `expanding with the keys on the lead's button puts them on the sidebar's toggle` — 접고 `.tab-lead button` 을 `focus()` 후 Enter → 「사이드바 접기」 가 포커스.
  - `the toggles name the shortcut they have` — 「사이드바 접기」 `title` 「사이드바 접기 (⌘B)」, 접은 뒤 펼치기 버튼 「사이드바 펼치기 (⌘B)」. seed `settings.shortcuts: { rename: "CmdOrCtrl+B" }` 로 시작하면 `title` 이 「사이드바 접기」.
  - `the top row is one height in the sidebar and in the tab bar` — `.sidebar-head` 와 `.pane-head` 의 높이가 둘 다 36, 위끝이 둘 다 0.
  - `not on macOS there is no app name and no room for the traffic lights` — `html` 에 `mac-titlebar` 없음, `.app-name` 안 보임, 「사이드바 접기」 의 오른끝이 `.sidebar-head` 오른끝에서 12px 안. 접은 뒤 펼치기 버튼의 x 와 첫 칸의 x 차이가 8 이하(스펙 「실패로 치는 것」 의 빈칸).
  - `the lead stays in the top left pane as the panes change` — 접고 메모 하나 연 뒤 `split-pane` → `.tab-lead` 는 하나이고 x 가 0 인 칸 안. `focus-pane-left` → `close-tab` → `close-tab`(빈 칸 닫힘) → 남은 칸 안에 `.tab-lead`. `split-pane-down` 하면 위 칸에 남는다.
  - `a tab dropped on the lead goes before the first tab` — 접고 메모 둘(가·나)을 연 뒤 「나」 탭을 `hold`/끌기 도우미로 `.tab-lead` 가운데에 놓는다 → 탭 순서 「나」「가」, 칸 수 1(나누지 않음).
  - `the lead is no tab: the tab list holds tabs and their close buttons only` — `.tabbar .tab-lead` 0개, `[role=tablist] button:not(.tab-close)` 0개.
  - `the column slides for 0.16s, at once with reduced motion, and not at the start` — 시작 직후 `getComputedStyle(document.body).transitionDuration` 이 `"0s"`. 한 번 접으면 `"0.16s"`. `page.emulateMedia({ reducedMotion: "reduce" })` 로 시작해 접으면 `"0s"` 이고 같은 `evaluate` 안에서 읽은 `.sidebar` 너비가 0.
  - `searching the workspace expands a collapsed sidebar, which stays so after the search closes` — 접고 `menu(page, "search-workspace")` → 펼침, `.search-panel` 보이고 그 입력에 포커스. Esc → 메모 목록, 여전히 펼침.
  - Review Focus 3 `a collapsed narrow window keeps the lead whole and the tab bar scrolling` — 뷰포트 480×600, 메모 8개를 탭으로 열고 접는다 → `.tab-lead` 너비가 1100 폭에서 잰 값과 같고, 펼치기 버튼 가운데의 `elementFromPoint` 가 그 버튼, `.pane-head .tabbar` 의 `scrollWidth > clientWidth`.
  - Review Focus 4 `two toggles in a row end in the last state` — 한 `evaluate` 안에서 `backend.menu("toggle-sidebar")` 두 번 → 끝내 클래스 없음, `inert` 없음, 너비 240.
- [ ] **Step 2:** `TOTE_E2E_PORT=$P pnpm exec playwright test tests/e2e/sidebar-toggle.spec.ts` → 실패.
- [ ] **Step 3: 구현**
  - 컨트롤러: 생성자에서 `windowStart()` 를 필드로 두고 `mac-titlebar` 를 `root.replaceChildren` 전에 정한다. `setSidebarCollapsed`: `sidebar-animates` → `sidebar-collapsed` 토글 → `sidebar.el.inert = collapsed` → 접을 때 `sidebar.el.contains(document.activeElement)` 이면 `this.focused.takeKeys()`. 펼치기 버튼의 `onPress` 는 눌리기 전 `document.activeElement` 가 자기면 펼친 뒤 접기 버튼에 `focus()`. `layoutPanes` 끝에서 왼쪽 맨 위 칸에 `attachLead`. `dropTarget` 의 탭 줄 판정을 `hit.includes(pane.head)` 로. `shortcutsChanged` 에서 두 버튼에 `this.shortcutHint("toggle-sidebar")`.
  - CSS: `body` 열을 `var(--sidebar-width) minmax(0, 1fr)`, `html.sidebar-collapsed body` 는 `0 minmax(0, 1fr)`(사이드바 오른쪽 선도 0). `html.sidebar-animates body { transition: grid-template-columns 0.16s ease }`, `@media (prefers-reduced-motion: reduce)` 에서 `transition: none`. `.sidebar` 는 `overflow: hidden`, 자식은 `--sidebar-width` 너비를 지킨다. `.sidebar-head`·`.pane-head` 는 `height: var(--top-row-height)`, `box-sizing: border-box`, 아래 `1px solid var(--border)`, 배경 `var(--sidebar-bg)`(탭 줄의 아래 선은 `.pane-head` 로 옮겨 앞머리까지 한 줄로). `.tabbar` 는 `.pane-head` 안에서 `flex: 1; min-width: 0`(가로 스크롤 유지). `.tab-lead` 는 `html:not(.sidebar-collapsed)` 에서 `display: none`, `flex: none`. `.app-name`·`.traffic-lights-room` 은 `html:not(.mac-titlebar)` 에서 `display: none`. `.sidebar-toggle` 은 `.settings-button` 과 같은 모양(투명 배경, `--muted`, hover). 포커스 링이 잘리지 않게 윗줄 버튼과 사이드바 가장자리 사이에 `--focus-ring-room` 이상.
- [ ] **Step 4:** 새 spec 통과(개수). 맨 윗줄 높이·사이드바 구조가 바뀌므로 `pnpm test:e2e` 전체(특히 `focus-rings.spec.ts`, `sidebar-footer.spec.ts`, `panes.spec.ts`, `pane-drag.spec.ts`, `startup.spec.ts`)와 `pnpm exec vitest run` 전체 통과, 개수 기록. 위치를 픽셀로 단언하던 기존 시험이 깨지면 새 높이(36px)에서 그 시험이 지키던 관계가 그대로인지 보고 값만 맞춘다 — 관계가 깨졌으면 구현을 고친다.
- [ ] **Step 5: 커밋** `feat: collapse the sidebar from its top row, the menu or ⌘B, and expand it from the tab bar's lead`

### Task 5: 접힘 상태를 창마다 남기고 깜빡이지 않게 열기

**Files:**

- Create: `src/app/sidebar-state.ts`, `src/app/sidebar-state.test.ts`
- Modify: `src/core/session.ts` (`WindowSession`, `parseWindowSession`), `src/core/session.test.ts`
- Modify: `src/app/session-sync.ts` (`SessionLayout`, `RestoredLayout`, `build`, `restore`), `src/app/session-sync.test.ts`
- Modify: `src/app/controller.ts` (생성자, `setSidebarCollapsed`, `restoreSession`, `SessionSync` 에 넘기는 배치)
- Create: `tests/e2e/sidebar-session.spec.ts`

**Interfaces:**

- Consumes: Task 3 `WindowStart`, Task 4 `setSidebarCollapsed`.
- Produces:
  - `src/app/sidebar-state.ts`:
    - `export function storedCollapsed(storage: () => Pick<Storage, "getItem"> | null, label: string): boolean | null` — 키 `tote.sidebarCollapsed.<label>`, 값 `"true"`/`"false"` 만 읽고 나머지·예외는 `null`.
    - `export function storeCollapsed(storage: () => Pick<Storage, "setItem"> | null, label: string, collapsed: boolean): void` — 예외는 삼킨다.
    - `export function startsCollapsed(start: WindowStart, stored: boolean | null): boolean` — `stored ?? start.sidebarCollapsed`.
    - `storage` 인자는 `() => window.sessionStorage` 를 넘긴다(접근 자체가 던질 수 있어 함수로 받는다).
  - `WindowSession.sidebarCollapsed?: true`. `SessionLayout.sidebarCollapsed: boolean`, `RestoredLayout.sidebarCollapsed: boolean`.

- [ ] **Step 1: 실패하는 vitest**
  - `sidebar-state.test.ts`: `it("prefers what the page kept over the start value")` — 저장 `"true"`/`"false"` 가 시작 값(반대)을 이긴다. `it("falls back to the start value for nothing, garbage or a storage that throws")` — `null`, `"1"`, `getItem` 이 던짐, `storage()` 자체가 던짐 → `startsCollapsed` 가 시작 값. `it("keys by the window, and a storage that throws on write is no failure")` — `ws-1` 에 쓴 값이 `ws-2` 로는 `null`, `setItem` 이 던져도 예외 없음. (Review Focus 2)
  - `session.test.ts` 의 `describe("parseWindowSession")` 에 `it("reads the sidebar as collapsed only for true")` — `sidebarCollapsed: true` → `true`, `"true"`·`1`·`null`·`false`·없음 → 속성 자체가 없음(`not.toHaveProperty("sidebarCollapsed")`). (Review Focus 1)
  - `session-sync.test.ts`: `SessionSync.build` 가 배치의 `sidebarCollapsed: true` 를 `sidebarCollapsed: true` 로 쓰고 `false` 면 속성을 쓰지 않는다. `SessionSync.restore` 가 세션의 값을 `RestoredLayout.sidebarCollapsed` 로(없으면 `false`).
- [ ] **Step 2:** `pnpm exec vitest run src/app/sidebar-state.test.ts src/core/session.test.ts src/app/session-sync.test.ts` → 실패.
- [ ] **Step 3: 구현(순수 부분)** — 위 Interfaces 대로.
- [ ] **Step 4: 실패하는 e2e** (`sidebar-session.spec.ts`. `firstFrames` = `addInitScript` 로 매 `requestAnimationFrame` 마다 `.sidebar` 가 있으면 그 너비를 `window.__sidebarWidths` 에 쌓는 기록기. `saved(page, n = 0)` = `JSON.parse(data.session).windows[n].sidebarCollapsed`.)
  - `a window saved collapsed opens collapsed from its first frame` — `firstFrames` 후 `start(page, { session: <창 하나, sidebarCollapsed: true> })` → `__sidebarWidths` 가 비어 있지 않고 전부 0, `transitionDuration` 이 `"0s"`.
  - `collapsing is saved in the window's session and comes back at the next launch` — `startWindows` 로 열고 접기 → `saved` 가 `true` 될 때까지 poll → `backend.quit()`·닫기 → `firstFrames` 를 context 에 걸고 `openWindow(context, "ws-1")` → 접힘, 기록 전부 0. 펼치면 `saved` 가 `undefined` 될 때까지 poll.
  - `an old session or a value that is not true opens expanded` — 버전 1 세션, `sidebarCollapsed: "true"` 인 세션 각각 → `sidebar-collapsed` 없음.
  - `a new window and a torn-off tab's window open expanded` — 허브에서 첫 창을 접고 메모를 둘 연 뒤 `menu(first, "new-window")` 로 연 창, `menu(first, "move-tab-to-new-window")` 로 연 창 모두 펼침(여는 쪽 `sessionStorage` 를 복사받아도 라벨이 달라 펼친다). 첫 창은 그대로 접힘.
  - `switching the workspace keeps the window's state, and the workspace it goes to saves it` — 고르개 시험(`switcher.spec.ts` 의 `seed`·`open`, 떠나는 페이지의 쓰기 거절을 `quietErrors` 로 거르는 것까지)의 꼴로 시작해 접고 `Control+2`(접힌 동안 ⌃ 숫자도 듣는다) → 다시 읽힌 페이지가 첫 프레임부터 접힘(`firstFrames`), `data.session`(이제 개인의 것)의 `sidebarCollapsed` 가 `true` 될 때까지 poll. 반대로 개인 쪽 세션을 `sidebarCollapsed: true` 로 두고, 한 번도 접고 펴지 않은 업무에서 전환 → 펼침, 개인 세션에서 속성이 사라질 때까지 poll.
  - `an expanded state the search brought is saved` — 접힌 세션으로 시작해 `menu(page, "search-workspace")` → Esc → `saved` 가 `undefined` 될 때까지 poll.
- [ ] **Step 5:** `TOTE_E2E_PORT=$P pnpm exec playwright test tests/e2e/sidebar-session.spec.ts` → 실패.
- [ ] **Step 6: 구현(컨트롤러)** — 생성자: `startsCollapsed(start, storedCollapsed(() => sessionStorage, start.label))` 로 정하고 클래스·`inert` 를 `root.replaceChildren` 전에(이때 `sidebar-animates` 는 붙이지 않는다). 정한 값은 그 자리에서 `storeCollapsed` 로도 남긴다 — 한 번도 접고 펴지 않은 창도 다시 읽기 뒤에 시작 값(초기 스크립트는 창을 만들 때의 값에 묶여 있고, 가짜는 전환한 쪽의 세션을 읽는다)이 아니라 지금 값으로 열린다. `setSidebarCollapsed` 는 `storeCollapsed` 와 `saveSessionSoon()` 을 더한다. `SessionSync` 에 넘기는 배치 함수에 `sidebarCollapsed`. `restoreSession` 은 `restoring = false` 뒤에 `restored.sidebarCollapsed !== this.sidebarCollapsed` 이면 `saveSessionSoon()` — 상태는 바꾸지 않는다(이 계획이 정한 것 첫 항목).
- [ ] **Step 7:** 새 spec·vitest 통과(개수), `switcher.spec.ts`·`windows.spec.ts`·`tear-off.spec.ts`·`startup.spec.ts` 통과(개수).
- [ ] **Step 8: 커밋** `feat: keep each window's collapsed sidebar in its session, from the first frame`

### Task 6: 접힌 동안의 업데이트 표시

**Files:**

- Modify: `src/ui/sidebar-toggle.ts` (`setUpdate`), `src/ui/update-button.ts` (변화 알림), `src/app/controller.ts`, `src/styles.css`
- Test: `tests/e2e/sidebar-toggle.spec.ts`

**Interfaces:**

- Consumes: Task 4 `SidebarToggle`.
- Produces: `UpdateButton` 생성자 두 번째 인자 `onShown: (shown: boolean) => void` — `show`·`hide` 가 부른다. 컨트롤러는 `(shown) => this.expandButton.setUpdate(shown)` 를 넘긴다. `setUpdate(true)` 는 `.has-update` 와 이름 「사이드바 펼치기 · 업데이트 있음」, `title` 「사이드바 펼치기 (⌘B) · 업데이트 있음」(키 없으면 「사이드바 펼치기 · 업데이트 있음」). 접기 버튼의 `setUpdate` 는 아무것도 바꾸지 않는다(펼쳐 있으면 업데이트 버튼이 보인다).

- [ ] **Step 1: 실패하는 e2e** (`announce` 는 `sidebar-footer.spec.ts` 의 것과 같은 `backend.announceUpdate({ version: "0.2.0", current: "0.1.0", notes: "" })`)
  - `an update found while collapsed marks the lead's button, and expanding shows the update button` — 접고 `announce` → `.tab-lead .sidebar-toggle` 이 `has-update`, `aria-label` 「사이드바 펼치기 · 업데이트 있음」, `title` 「사이드바 펼치기 (⌘B) · 업데이트 있음」. 그 버튼을 누르면 `.update-button` 이 「업데이트 0.2.0」 으로 보인다.
  - `an update found before collapsing marks the button as it collapses` — `announce` 후 접기 → 같은 표시.
  - `the mark goes with the update button` — 표시가 있는 상태에서 `backend.currentUpdate` 가 `null` 을 주게 하고 펼쳐 업데이트 버튼을 누른다(→ `hide`) → 다시 접으면 `has-update` 없음, 이름 「사이드바 펼치기」.
- [ ] **Step 2:** `TOTE_E2E_PORT=$P pnpm exec playwright test tests/e2e/sidebar-toggle.spec.ts -g "update|mark"` → 실패.
- [ ] **Step 3: 구현** — 점은 `.sidebar-toggle.has-update::after`, 색 `var(--accent)`(하드코딩 금지).
- [ ] **Step 4:** 통과(개수) + `update.spec.ts`·`sidebar-footer.spec.ts` 통과(개수).
- [ ] **Step 5: 커밋** `feat: mark the expand button when an update waits behind the collapsed sidebar`

### Task 7: macOS 맨 윗줄 — 신호등 자리·앱 이름·창 끌기

**Files:**

- Create: `src/ui/window-drag.ts`
- Modify: `src/app/pane.ts` (`PaneHost`, 탭 줄에 `dragsWindow`), `src/app/controller.ts` (사이드바 윗줄·앞머리에 `dragsWindow`, `PaneHost` 구현), `src/styles.css`, `src/theme/default-variables.test.ts`
- Create: `tests/e2e/titlebar.spec.ts`

**Interfaces:**

- Consumes: Task 3 `startWindowDrag`·`toggleWindowZoom`·`windowStart().macTitlebar`, Task 4 `Sidebar.head`·`Pane.head`·`tabLead`.
- Produces:
  - `export function dragsWindow(el: HTMLElement, options: { isFree(target: Element): boolean; canDrag(): boolean; start(): void; onDouble?: () => void }): void` — 왼쪽 버튼 `mousedown` 이 `isFree` 이고 `canDrag()` 일 때: `detail === 1` 이면 `preventDefault()` 후 `start()`. `onDouble` 이 있으면 `detail === 2` 인 `mousedown` 의 좌표를 기억하고, `detail === 2` 인 `mouseup` 이 같은 좌표·`isFree` 이면 `onDouble()`. 그 밖에는 아무것도 하지 않는다(이벤트 전파를 막지 않는다 — 칸의 capture `mousedown` 포커스와 탭 줄의 `dblclick` 이 그대로 받는다).
  - `PaneHost.canDragWindow(pane: Pane): boolean` — macOS 배치이고 그 칸의 `rectsOf(layout)` 위끝이 `EDGE` 이하. `PaneHost.dragWindow(): void` — `backend.startWindowDrag()`(실패는 `report`).
  - 걸리는 곳: 사이드바 윗줄(`isFree` = 버튼 밖, `onDouble` = `toggleWindowZoom`), 각 칸의 탭 줄(`isFree` = `target === tabBar.el`, `canDrag` = `host.canDragWindow(this)`, `onDouble` 없음), 앞머리(`isFree` = 버튼 밖, `onDouble` 없음).
  - CSS 변수 `--traffic-lights-width: 80px`(`NOT_THEMED`).

- [ ] **Step 1: 실패하는 e2e** (`titlebar.spec.ts`. `mac = { macTitlebar: true }` 로 seed. `drags(page)`/`zooms(page)` 는 `data.windowDrags ?? 0`/`data.windowZooms ?? 0`. 「빈 곳」 은 그 요소의 상자 안에서 자식이 없는 점 — 탭 줄은 마지막 탭 오른쪽, 사이드바 윗줄은 앱 이름과 버튼 사이.)
  - `on macOS the top row leaves the traffic lights their room and names the app` — `html` 이 `mac-titlebar`, `.app-name` 이 「Tote Notes」 로 보이고 `font-weight` 600 이상, 그 x ≥ 80. 접은 뒤 펼치기 버튼 x ≥ 80, 첫 탭 x ≥ 펼치기 버튼 오른끝. `.sidebar-head` 와 `.pane-head` 높이가 같다(36).
  - `a press on the top row's free space drags the window, and nowhere else` — 사이드바 윗줄 빈 곳 `mouse.down/up` → 1, 앱 이름 위 → 2, 「사이드바 접기」 클릭 → 2 그대로(그리고 접힘), 다시 펼친 뒤 탭 줄 빈 곳 → 3, 탭 라벨 누르기 → 3 그대로이고 그 탭이 활성, 편집기·상태 표시줄 누르기 → 3 그대로.
  - `pressing the tab bar's free space still focuses that pane` — 오른쪽으로 나눈 뒤 왼쪽 칸 탭 줄 빈 곳 누르기 → 그 칸이 `.focused`, 끌기 횟수 +1.
  - `a lower pane's tab bar does not drag the window` — `split-pane-down` 뒤 아래 칸 탭 줄 빈 곳 → 0, 위 칸 → 1. `split-pane`(오른쪽) 뒤 오른쪽 칸 탭 줄 빈 곳 → +1.
  - `the lead's free space drags the window and its button does not` — 접고 `.traffic-lights-room` 위 누르기 → +1, 펼치기 버튼 → 그대로(펼침).
  - `a tab dragged across the free space moves the tab, not the window` — 탭 둘, 첫 탭을 눌러 탭 줄 빈 곳을 지나 끝에 놓는다 → 끌기 0, 순서가 바뀐다.
  - `double-clicking the sidebar's top row zooms; double-clicking the tab bar's free space opens a tab and does not zoom` — 사이드바 윗줄 빈 곳 `dblclick` → 확대 1. 탭 줄 빈 곳 `dblclick` → 탭 수 +1, 확대 1 그대로. `[data-tauri-drag-region]` 0개. 사이드바 윗줄에서 `mouse.down({ clickCount: 2 })` → `mouse.move(+5, 0)` → `mouse.up({ clickCount: 2 })` → 확대 그대로(Tauri `drag.js` 와 같은 「움직이면 취소」).
  - `not on macOS nothing drags or zooms the window` — seed 없이 사이드바 윗줄·탭 줄 빈 곳 누르기, 사이드바 윗줄 `dblclick` → 둘 다 0. 탭 줄 빈 곳 `dblclick` 은 여전히 새 탭.
- [ ] **Step 2:** `TOTE_E2E_PORT=$P pnpm exec playwright test tests/e2e/titlebar.spec.ts` → 실패.
- [ ] **Step 3: 구현** — 위 Interfaces. CSS: `html.mac-titlebar .sidebar-head .traffic-lights-room`, `html.mac-titlebar .tab-lead .traffic-lights-room` 에 `width: var(--traffic-lights-width); flex: none`. `.app-name` 은 `font-weight: 600`, 남는 자리는 빈 곳으로 늘어난다(`flex: 1` 인 빈 칸 또는 `margin-right: auto`). 사이드바 윗줄·앞머리는 `user-select: none`.
- [ ] **Step 4:** 새 spec 통과(개수) + `sidebar-toggle.spec.ts`·`pane-drag.spec.ts`·`panes.spec.ts`·`tear-off.spec.ts` 통과(개수), `pnpm exec vitest run` 전체.
- [ ] **Step 5: 커밋** `feat: drag the window from the macOS top row and zoom it from the sidebar's`

### Task 8: 문서와 화면 확인 목록

**Files:**

- Modify: `docs/superpowers/specs/2026-10-07-tote-note-core-design.md` (「창 배치」 문단, 「세션」 절)
- Modify: `.ruler/90-reference.md` (이 계획의 행)
- Create: `docs/superpowers/reports/2026-10-29-tote-notes-titlebar-tabs-smoke.md`

- [ ] **Step 1:** 코어 스펙 「창 배치」 문단에 사이드바 윗줄(macOS 는 신호등 자리·「Tote Notes」, 오른쪽 끝 접기 버튼), 접기(버튼·「보기」 메뉴·⌘B, 접으면 왼쪽 맨 위 칸 탭 줄 앞머리에 펼치기 버튼), macOS 의 맨 윗줄 탭과 창 끌기를 넣는다. 「세션」 절에 창 배치가 접힌 상태(`sidebarCollapsed`)를 함께 남긴다는 것과 새 창·떼어 낸 창은 펼친다는 것을 넣는다. 지금 상태로만 쓴다(연대기 금지 — `docs/guideline/base/04-citation.md` 「문서는 지금을 말한다」).
- [ ] **Step 2:** `.ruler/90-reference.md` 의 이 스펙 행 아래에 행 하나를 넣는다 — 「언제」 칸은 「tote-notes 제목 줄 탭·사이드바 접기 계획을 실행할 때」, 「읽을 파일」 칸은 이 계획의 경로(`docs/superpowers/plans/2026-10-29-tote-notes-titlebar-tabs-and-sidebar-toggle.md`, 다른 행처럼 백틱으로). 그 뒤 `pnpm exec ruler apply` 를 돌리고, `git status` 의 추적 파일 변경이 `.ruler/90-reference.md` 와 이 태스크의 문서뿐인지 본다.
- [ ] **Step 3:** 화면 확인 문서를 쓴다. 각 항목에 절차·기대값·결과 칸(Task 9 가 채움):
  - A. 신호등이 맨 윗줄 세로 가운데에 있고(위아래 여백 차이 2px 안), 앱 이름·워크스페이스 고르개·접었을 때의 펼치기 버튼·첫 탭을 덮지 않는다(펼침·접힘 둘 다).
  - B. 사이드바 윗줄 빈 곳·앱 이름, 맨 윗줄 탭 줄 빈 곳, 앞머리 빈 곳을 끌면 창이 옮겨진다. 버튼·탭·아래 칸의 탭 줄에서는 옮겨지지 않는다. 탭을 끌어 칸 사이로 옮기기와 창 밖으로 떼어 내기가 그대로 된다.
  - C. 사이드바 윗줄 두 번 누르기 = 창 확대 켜고 끄기. 탭 줄 빈 곳 두 번 누르기 = 새 탭 하나, 창 크기 그대로. **이 항목이 실패하면**(창 끌기가 첫 `mouseup` 을 가져가 `dblclick` 이 오지 않으면) 탭 줄의 새 탭을 「`event.target` 이 `.tabbar` 자신인 `detail === 2` 의 `mousedown`」 으로 바꾸는 것을 결정 요청으로 올린다(스펙 「창 끌기」 의 `dblclick` 판정 문장과 맞춰야 한다).
  - D. 전체 화면(⌃⌘F)에서 신호등이 사라져도 배치가 그대로이고, 위로 마우스를 올려 나오는 시스템 막대와 겹쳐도 탭을 누를 수 있다.
  - E. 창을 끄고 다시 켜면 창 크기·위치가 그대로다(Overlay 로 `inner_size` 의 뜻이 바뀌어 실행마다 커지거나 줄지 않는다 — `frame_of` 의 「full-size content view」 주석이 맞는지). 이 판 이전 세션으로 처음 켤 때 한 번 달라지는 양도 적는다.
  - F. 접은 창을 끄고 켜면 펼친 모습이 한 번도 보이지 않고 접힌 채 뜬다. 접은 채 ⌃2 로 워크스페이스를 바꾸면 다시 읽힌 페이지도 깜빡임 없이 접혀 있다(`sessionStorage` 가 `window.reload()` 를 건넌다).
  - G. ⌘B 가 메뉴에서 「보기 › 사이드바 접기/펼치기」 에 붙어 보이고 눌린다. 설정에서 다른 명령에 ⌘B 를 건 뒤 다시 켜면 그 명령이 ⌘B 를 갖고 메뉴 항목에는 키가 없다.
  - H. 창이 비활성일 때 탭 줄을 처음 누르면 페이지에 닿는다(`accept_first_mouse`) — 그 누르기가 빈 곳이면 창이 앞으로 오며 끌린다.
- [ ] **Step 4:** `pnpm fmt`, 커밋 `docs: describe the top row and the sidebar toggle, and list the screen checks`

### Task 9: 실제 앱 화면 확인 (macOS)

e2e 는 브라우저라 신호등·창 끌기·확대·전체 화면을 보지 못한다(스펙 「만드는 사람에게 맡기는 것」). 이 태스크는 **사람이 하거나, 사람이 화면 조작을 허락한 에이전트가 한다.** 허락이 없으면 문서의 결과 칸을 비워 둔 채 사람에게 넘기고 끝낸다.

- [ ] **Step 1:** `pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json` → `src-tauri/target/debug/bundle/macos/Tote Notes Dev.app`. 임시 폴더 `S` 를 만들고 `touch "$S/start-marker"`, `open --env TOTE_DATA_DIR="$S/data" "src-tauri/target/debug/bundle/macos/Tote Notes Dev.app"`(`TOTE_BACKGROUND` 는 주지 않는다 — 화면에 올라와야 한다). 화면 잠금부터 본다: `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked`.
- [ ] **Step 2:** Task 8 문서의 A~H 를 차례로 하고 결과를 적는다. A 가 어긋나면 `TRAFFIC_LIGHTS_X`·`TRAFFIC_LIGHTS_Y`(windows.rs)와 `--traffic-lights-width`(styles.css)만 고쳐 다시 빌드·확인하고, 고친 값과 이유를 결과 칸에 적는다.
- [ ] **Step 3:** 끝나면 앱을 끄고 `find ~/.tote-dev ~/Tote-dev "$HOME/Library/Application Support/tote-dev" -newer "$S/start-marker"` 가 비어 있는지 본다.
- [ ] **Step 4:** 상수를 고쳤으면 `titlebar.spec.ts` 를 다시 돌린다(개수). 커밋 `docs: record the screen checks of the top row and the sidebar toggle`(상수를 고쳤으면 `fix: centre the traffic lights on the top row` 를 따로).

---

## 태스크 의존

1·2 는 독립. 2 → 3 → 4 → 5, 4 → 6, 3·4 → 7, 1~7 → 8 → 9. 실행 순서: 1, 2, 3, 4, 5, 6, 7, 8, 9.
