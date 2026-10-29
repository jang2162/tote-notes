# tote-notes 워크스페이스 순서·숨김과 고르개 단축키 안내 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설정 「워크스페이스」 구역에서 끌어서 순서를 바꾸고 숨김을 켜면, 고르개와 ⌃1~⌃9 가 그 순서·숨김을 따르고, 펼친 고르개의 각 행 맨 오른쪽에 그 행의 ⌃ 단축키가 보인다.

**Architecture:** 순서·숨김은 워크스페이스 루트의 `.tote-workspaces.json` 에 (id, 폴더 이름) 쌍으로 산다. Rust 의 새 모듈 `workspace::order` 가 그 파일을 읽고 쓰고, 루트 아래 워크스페이스에 자리(`order`)와 `hidden` 을 매겨 `list_workspaces` 에 싣는다. 프론트는 경로만 다룬다 — 고르개와 설정 구역은 `order` 로 정렬하고, 바꾼 결과를 경로 목록 둘(`order`, `hidden`)로 `set_workspace_order` 에 보낸다. 변경은 기존 `tote://workspaces` 신호로 모든 창에 퍼진다.

**Tech Stack:** Rust(Tauri 2, serde), TypeScript(프레임워크 없음, `h` DOM 도우미), vitest, Playwright(WebKit, 가짜 백엔드).

**Spec:** `docs/superpowers/specs/2026-10-29-tote-notes-workspace-order-and-hiding-design.md`

## Global Constraints

- 순서 파일: `<워크스페이스 루트>/.tote-workspaces.json`, 모양 `{ "version": 1, "order": [{ "id", "name" }], "hidden": [{ "id", "name" }] }`. 쓰기는 `persist::write_json`. 읽기는 `persist::read_json` 을 **쓰지 않는다**(깨진 파일을 치워 둔다) — 깨졌거나 `version` 이 1 이 아니면 기본값(빈 목록 둘)이고 파일은 그대로 둔다. 필드 하나만 모양이 틀리면 그 필드만 빈 목록.
- 맞추는 순서: ① id·이름 둘 다 같음 ② 루트에 그 id 의 폴더가 하나뿐이면 id 만 같음 ③ 그 밖은 파일에 없는 것(맨 끝, 그들끼리 이름순). 항목 하나는 폴더 하나에만 맞는다.
- `.tote/workspace.json` 을 읽을 수 없는 워크스페이스는 id 가 없다: 맨 끝(이름순), 숨김 불가(설정의 체크박스 `disabled`), 저장할 때 빠진다.
- 문구(그대로): 구역 이름 「워크스페이스」(구역 목록에서 「일반」 바로 아래), 설명 「끌어서 순서를 바꿉니다. 고르개와 ⌃1~⌃9 가 이 순서를 따릅니다. 숨긴 워크스페이스는 고르개에 보이지 않습니다.」, 체크박스 「숨김」, 빈 목록 「워크스페이스 루트에 워크스페이스가 없습니다.」.
- 단축키 표기: 「⌃1」~「⌃9」, 숨기지 않은 것만 세어 매긴다. 10번째부터 없음. 흐린 글씨(`--muted`), 12px, `font-variant-numeric: tabular-nums`. 고르개에서는 다른 창 점 다음(맨 오른쪽). 명령 두 줄(「새 워크스페이스…」·「워크스페이스 열기…」)에는 없음.
- 「워크스페이스 열기…」 대화상자는 지금처럼 최근 사용순, 숨긴 것도 보인다.
- 순서·숨김을 바꾸면, 그리고 워크스페이스 루트를 바꾸면 `tote://workspaces` 를 모든 창에 보낸다.
- 하지 않는 것: 관리 구역에서 이름 바꾸기·지우기·만들기, ⌃ 키 바꾸기, 10번째 이후 단축키, 동기화로 바뀐 순서 파일 감시, 키보드로 순서 바꾸기.
- 다른 파일을 가리킬 때 줄번호가 아니라 이름(함수·셀렉터)으로 가리킨다.
- 디버그 앱은 언제나 `TOTE_DATA_DIR=<임시 폴더>` 로 띄운다(`docs/guides/development.md` 「디버그 앱은 언제나」). 화면(키보드·마우스)으로 하는 실기기 확인은 이 계획에서 하지 않는다. Task 5 가 목록만 쓴다.
- 테스트 보고에는 실행 개수를 적는다. 커밋 전에 `pnpm fmt`, `pnpm lint`, `pnpm typecheck`, Rust 를 고쳤으면 `cargo fmt --all` 과 `cargo clippy --all-targets --all-features -- -D warnings`(`src-tauri/` 에서).

## Review Focus

1. Finder 로 복제해 id 가 같은 두 폴더 중 하나만 숨기면 다른 하나는 고르개에 남는다 — Task 1 시험 `a duplicated folder keeps its own place and flag`.
2. 다른 기기의 새 빌드가 쓴 `version: 2` 파일은 읽을 때 지워지거나 이름이 바뀌지 않는다 — Task 1 시험 `an unknown version reads as default and is left alone`.
3. 지금 창의 워크스페이스를 숨겨도 닫힌 고르개 버튼에 이름이 남고, ⌃ 번호는 숨긴 것을 건너뛴다 — Task 3 시험 `hiding this window's workspace keeps its name on the button`.
4. 「숨김」 체크박스를 누르는 것이 끌기로 새지 않고, 끄는 중 Esc 는 아무것도 저장하지 않는다 — Task 4 시험 `a click on the hidden box is not a drag`, `Esc during a drag puts the row back and saves nothing`.
5. 저장이 실패하면 까닭이 상태 줄에 보이고 목록이 저장된 순서로 돌아간다 — Task 4 시험 `a failed save says why and shows the saved order`.

---

### Task 1: 순서 파일 (`workspace::order`)

**Files:**

- Create: `src-tauri/src/workspace/order.rs`
- Modify: `src-tauri/src/workspace/mod.rs` (`pub mod order;`, `Workspace::read_id`)

**Interfaces:**

- Produces:
  - `pub const ORDER_FILE: &str = ".tote-workspaces.json";`
  - `#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)] pub struct Entry { pub id: String, pub name: String }`
  - `#[derive(Clone, Debug, Default, PartialEq)] pub struct WorkspaceOrder { pub order: Vec<Entry>, pub hidden: Vec<Entry> }`
  - `pub fn load(root: &Path) -> WorkspaceOrder` — 읽기 전용. 없음·깨짐·`version != 1` 은 `Default`. 필드별 관대 읽기(`appdata.rs` 의 `lenient` 와 같은 방식. 그 함수를 `pub(crate)` 로 열어 써도 되고 같은 것을 둬도 된다).
  - `pub fn save(root: &Path, order: &WorkspaceOrder) -> io::Result<()>` — `version: 1` 을 붙여 `write_json`.
  - `#[derive(Clone, Debug, PartialEq)] pub struct Arranged { pub summary: WorkspaceSummary, pub id: Option<String>, pub hidden: bool }`
  - `pub fn arrange(summaries: Vec<(WorkspaceSummary, Option<String>)>, order: &WorkspaceOrder) -> Vec<Arranged>` — 입력은 `Workspace::list` 순서(이름순)와 각 id. 돌려주는 순서가 곧 자리다.
  - `pub fn arranged(root: &Path) -> Vec<Arranged>` — `Workspace::list(root)` + `Workspace::read_id` + `load` + `arrange`.
  - `impl Workspace { pub fn read_id(path: &Path) -> Option<String> }` — `.tote/workspace.json` 을 읽기만 한다(치워 두지 않는다).

- [ ] **Step 1: 실패하는 시험** (`order.rs` 의 `mod tests`, `tempfile` 과 `Workspace::create` 로 루트를 만든다)
  - `no_file_is_name_order_and_nothing_hidden` — 「나」「가」 를 만들면 `arranged` 가 가·나, 둘 다 `hidden == false`.
  - `the saved order and flags are followed` — 가·나·다, `order` = [다, 가], `hidden` = [가] 저장 → 다·가·나, 가만 숨김.
  - `a renamed folder keeps its place` — 「가」 를 순서 맨 끝에 저장한 뒤 폴더를 「라」 로 `fs::rename` → 「라」 가 그 자리.
  - `a duplicated folder keeps its own place and flag` — 「가」 를 만들고 그 폴더를 통째로 복사해 「가 사본」(같은 id). `order` = [{id, "가 사본"}, {id, "가"}], `hidden` = [{id, "가 사본"}] → 가 사본·가, 「가 사본」 만 숨김. 이어서 `order` = [{id, "옛 이름"}] 만 저장하면 둘 다 ③(맨 끝, 이름순)이다.
  - `an unknown version reads as default and is left alone` — 파일에 `{"version":2,"order":[...]}` → `load` 가 `Default`, 파일 바이트가 그대로, 루트에 `.corrupt-` 로 시작하는 파일이 없다. 같은 확인을 `"nope"` 내용으로도 한다.
  - `one bad field falls back alone` — `{"version":1,"order":"x","hidden":[{id,name}]}` → `order` 빈 목록, `hidden` 은 읽힌다.
  - `a workspace without a readable id goes last` — 「가」「나」 중 「가」 의 `.tote/workspace.json` 을 `"nope"` 로 → `arranged` 의 마지막이 가, `id == None`, 그 파일은 그대로(치워지지 않음).
  - `the order file is not a workspace` — `save` 뒤 `Workspace::list` 결과에 `.tote-workspaces.json` 이 없다.
  - `save_then_load_round_trips`.
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml workspace::order` 로 실패(컴파일 오류 포함) 확인.
- [ ] **Step 3:** 위 Interfaces 대로 구현. `arrange` 의 맞추기는 Global Constraints 의 ①②③ 순서로, `order` 와 `hidden` 에 각각 따로 적용한다. 항목은 한 번 맞으면 소비된다. ③ 끼리는 입력 순서(이름순)를 지킨다.
- [ ] **Step 4:** 같은 명령으로 통과 확인(실행 개수 보고). `cargo fmt --all`, `cargo clippy --all-targets --all-features -- -D warnings`.
- [ ] **Step 5: Commit** — `git add src-tauri/src/workspace/order.rs src-tauri/src/workspace/mod.rs` (+ `appdata.rs` 를 열었으면), `feat: read and write the workspace order file`.

### Task 2: 명령과 신호 (`list_workspaces`·`set_workspace_order`·루트 변경·처음 여는 워크스페이스)

**Files:**

- Modify: `src-tauri/src/app/commands.rs` (`WorkspaceListItem`, `workspace_items`, `list_workspaces`, 새 `set_workspace_order`, `patch_settings`, `mod tests`)
- Modify: `src-tauri/src/lib.rs` (`invoke_handler` 에 `commands::set_workspace_order`)
- Modify: `src-tauri/src/app/mod.rs` (`AppCore::fallback_workspace`, 그 시험)

**Interfaces:**

- Consumes: Task 1 의 `order::{arranged, Arranged, Entry, WorkspaceOrder, save}`, `Workspace::read_id`.
- Produces:
  - `WorkspaceListItem` 에 `order: Option<usize>`(루트 아래 워크스페이스의 자리, 0부터. `missing` 은 `None`), `hidden: bool`(`missing` 은 `false`), `orderable: bool`(id 를 읽을 수 있음. `missing` 은 `false`). JSON 이름은 `order`·`hidden`·`orderable`.
  - `fn workspace_items(arranged: Vec<Arranged>, recent: &[PathBuf], windows: impl Fn(&Path) -> usize) -> Vec<WorkspaceListItem>` — 돌려주는 **순서는 지금과 같은 최근 사용순**(「워크스페이스 열기…」 가 그대로 쓴다), `order` 는 `arranged` 에서의 자리.
  - `#[tauri::command] pub async fn set_workspace_order(app: AppHandle, core: State<'_, AppCore>, order: Vec<PathBuf>, hidden: Vec<PathBuf>) -> CmdResult<()>` — 경로마다 `Workspace::read_id` 와 폴더 이름으로 `Entry` 를 만들고(id 가 없으면 뺀다) `order::save(&core.workspace_root(), …)`, 그다음 `app.emit("tote://workspaces", ())`.
  - `patch_settings` 는 `patch.workspace_root.is_some()` 이면 `broadcast_config` 뒤에 `tote://workspaces` 도 보낸다.
  - `fallback_workspace`: 최근 목록에 쓸 것이 없을 때 `order::arranged(&root)` 에서 `hidden == false` 인 첫 번째, 없으면 첫 번째.

- [ ] **Step 1: 실패하는 시험**
  - `commands.rs` 의 기존 `workspace_items` 시험 두 개를 새 시그니처로 옮기고 `order`·`hidden` 을 확인한다.
  - `items_carry_their_place_and_flag_but_keep_recent_order` — 가·나·다, 순서 [다, 나, 가], 숨김 [나], 최근 [나] → 돌려준 이름 순서 나·가·다(최근 먼저, 나머지 이름순 — 지금 규칙), `order` 는 나=1·가=2·다=0, 나만 `hidden`.
  - `a missing recent workspace has no place` — 최근에만 있고 사라진 경로 → `order == None`, `hidden == false`, `orderable == false`.
  - `a workspace without a readable id is not orderable` — `.tote/workspace.json` 이 `"nope"` 인 것 → `orderable == false`, 자리는 맨 끝.
  - `mod.rs`: `the first launch opens the first workspace not hidden` — 최근 목록이 비고 가·나, 순서 [나, 가], 숨김 [나] → `fallback_workspace` 가 가. 숨김 [가, 나] 이면 나(순서상 첫 번째).
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml` 로 실패 확인.
- [ ] **Step 3:** 위 Interfaces 대로 구현하고 `lib.rs` 에 등록. 명령 시험은 `AppHandle` 이 필요 없는 부분(경로 → `Entry` 변환)을 작은 함수 `fn entries(paths: &[PathBuf]) -> Vec<Entry>` 로 빼서 `paths_without_an_id_are_left_out` 로 시험한다.
- [ ] **Step 4:** `cargo test --manifest-path src-tauri/Cargo.toml` 전체 통과(개수 보고), `cargo fmt --all`, clippy.
- [ ] **Step 5: Commit** — 세 파일, `feat: list workspaces with their place and hide flag, and save a new order`.

### Task 3: 프론트 백엔드와 고르개

**Files:**

- Modify: `src/backend/types.ts` (`WorkspaceListItem`, `Backend.setWorkspaceOrder`)
- Modify: `src/backend/tauri.ts` (`setWorkspaceOrder`)
- Modify: `src/backend/fake.ts` (`listWorkspaces`, `setWorkspaceOrder`, `FakeData.failWorkspaceOrder`)
- Modify: `src/ui/workspace-switcher.ts` (`switcherItems`, 새 `shortcutHint`, `render`)
- Modify: `src/app/controller.ts` (`refreshSwitcher`)
- Modify: `src/styles.css` (`.ws-switcher-key`)
- Test: `src/ui/workspace-switcher.test.ts`, `tests/e2e/switcher.spec.ts`

**Interfaces:**

- Consumes: Task 2 의 `order`·`hidden` 필드, `set_workspace_order` 명령(인자 `{ order: string[], hidden: string[] }`).
- Produces:
  - `WorkspaceListItem` 에 `order: number | null`, `hidden: boolean`, `orderable: boolean`.
  - `Backend.setWorkspaceOrder(order: string[], hidden: string[]): Promise<void>` — 두 인자 다 경로. `order` 는 루트 아래 워크스페이스 전부의 새 순서다.
  - 가짜: `listWorkspaces` 는 `order` 가 없는 시드 항목에 그 배열 안의 자리(`missing` 이면 `null`)를, `hidden` 이 없으면 `false` 를, `orderable` 이 없으면 `!missing` 을 채워 돌려준다(그래서 기존 시드가 그대로 컴파일되고 동작한다. `FakeData.workspaces` 의 타입을 그만큼 느슨하게 둔다). `setWorkspaceOrder` 는 `failWorkspaceOrder`(남은 횟수, `failWrites` 와 같은 방식)가 있으면 `BackendError` 로 거절하고, 아니면 각 항목의 `order`·`hidden` 을 고치고 `commit` 한 뒤 이 창과 허브의 다른 창에 `workspaces` 를 알린다.
  - `export function shortcutHint(index: number): string | null` — 0~8 이면 `"⌃1"`~`"⌃9"`, 그 밖은 `null`. 설정 구역(Task 4)도 쓴다.
  - `switcherItems(list, currentPath)` — `missing`·`hidden` 을 빼고 `order` 오름차순(이름순 정렬은 걷는다). NFC 정규화는 그대로.
  - `WorkspaceSwitcher.render(items: SwitcherItem[], currentName: string)` — 버튼 이름은 `currentName`. 워크스페이스 행 `i` 에 `shortcutHint(i)` 가 있으면 점 다음에 `span.ws-switcher-key` 와 `aria-keyshortcuts="Control+<n>"`.
  - `refreshSwitcher` 는 목록에서 `path === this.workspacePath` 인 항목의 이름(숨김이어도, NFC)을 `currentName` 으로 넘긴다.

- [ ] **Step 1: 실패하는 시험**
  - `workspace-switcher.test.ts`: `items follow the set order, not the name` (order 2·0·1 → 그 순서), `hidden and missing items are left out`, `shortcutHint names ⌃1 to ⌃9 and nothing past them` (0 → "⌃1", 8 → "⌃9", 9 → null), 그리고 기존 이름순 시험은 걷는다.
  - `switcher.spec.ts`:
    - 첫 시험 `the switcher lists the workspaces by name …` 를 `the switcher lists the workspaces in the set order with the current one marked` 로 바꾼다. 시드 [업무, 개인, 가계부] 그대로 → 목록 업무·개인·가계부, 키 표시 `.ws-switcher-key` 가 ["⌃1","⌃2","⌃3"], 명령 두 줄에는 `.ws-switcher-key` 가 없다. 이름순을 전제한 다른 시험의 기대도 시드 배열 순서로 고친다.
    - `the shortcut hint sits after the dot at the far right` — 다른 창이 보고 있는 항목에서 `.ws-switcher-dot` 다음 형제가 `.ws-switcher-key`.
    - `ten workspaces show hints on the first nine only`.
    - `hidden workspaces leave the list and give up their number` — 시드에서 개인 `hidden: true` → 목록 업무·가계부, ⌃2 가 가계부로 전환.
    - `hiding this window's workspace keeps its name on the button` — 업무 `hidden: true` → 버튼에 「업무」, 목록에 업무 없음, 처음 강조된 행이 첫 행, ⌃1 이 개인으로 전환.
    - `another window's new order reaches this switcher` — `startWindows` 로 두 창, 한 창이 `window.__tote` 경유로 `backend.setWorkspaceOrder` 를 부르면 다른 창 목록이 바뀐다(가짜가 허브로 `workspaces` 를 알리는지).
- [ ] **Step 2:** `pnpm test src/ui/workspace-switcher.test.ts` 와 `pnpm test:e2e tests/e2e/switcher.spec.ts` 로 실패 확인.
- [ ] **Step 3:** 위 Interfaces 대로 구현. CSS 는 `.ws-switcher-key { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }` 에 왼쪽 간격만 더한다(라벨이 이미 남는 폭을 차지한다).
- [ ] **Step 4:** `pnpm test`, `pnpm test:e2e tests/e2e/switcher.spec.ts tests/e2e/dialogs.spec.ts` 통과(개수 보고). `dialogs.spec.ts` 는 「워크스페이스 열기…」 가 최근 사용순·숨김 포함으로 남는지 보려고 함께 돈다 — 숨긴 항목이 대화상자에 보이는 시험 `the picker still lists a hidden workspace` 를 거기에 하나 더한다.
- [ ] **Step 5: Commit** — 위 파일들, `feat: order the switcher by the set order and show each workspace's shortcut`.

### Task 4: 설정 「워크스페이스」 구역

**Files:**

- Create: `src/ui/workspace-settings.ts`, `src/ui/workspace-settings.test.ts`
- Modify: `src/ui/settings.ts` (`SettingsSection`, `SECTIONS`, `SettingsOptions.onWorkspacesChanged`, `contents`)
- Modify: `src/app/controller.ts` (`showSettings` 가 `onWorkspacesChanged` 를 넘김. `backend.onWorkspacesChanged` 처리기가 `refreshSwitcher` 와 함께 설정 화면의 구독자도 부른다 — `configListeners` 와 같은 방식의 `workspaceListeners`)
- Modify: `src/styles.css` (`.ws-order-*`)
- Test: `tests/e2e/workspace-settings.spec.ts`

**Interfaces:**

- Consumes: Task 3 의 `Backend.listWorkspaces`·`setWorkspaceOrder`, `shortcutHint`.
- Produces:
  - `SettingsSection` 에 `"workspaces"`, `SECTIONS` 에서 `["general","일반"]` 바로 다음에 `["workspaces","워크스페이스"]`.
  - `SettingsOptions.onWorkspacesChanged: (handler: () => void) => () => void`.
  - `export function moveItem<T>(list: readonly T[], from: number, to: number): T[]` — `to` 는 놓일 자리(옮긴 뒤의 인덱스).
  - `export function workspacesSection(options: { backend: Backend; onWorkspacesChanged: (handler: () => void) => () => void; fail: (error: unknown) => void; saved: () => void }): { el: HTMLElement; dispose(): void }` — `fail` 은 설정 화면의 `status` 에 까닭을, `saved` 는 그것을 비운다(`settings.ts` 의 `save`·`fail` 과 같은 자리).
  - DOM(시험이 잡는 것): 목록 `ol.ws-order-list`, 행 `li.ws-order-row`(숨김이면 `.hidden` 도), 그 안에 `span.ws-order-grip`(⋮⋮), `span.ws-order-name`, `span.ws-order-key`, `label` 「숨김」 과 `input[type=checkbox]`. 놓일 자리 `div.ws-order-drop`. 빈 목록 `p.settings-note`.

- [ ] **Step 1: 실패하는 시험**
  - `workspace-settings.test.ts`: `moveItem` — `[a,b,c,d]` 에서 (0→2) `[b,c,a,d]`, (3→0) `[d,a,b,c]`, (1→1) 그대로.
  - `workspace-settings.spec.ts` (시드는 `switcher.spec.ts` 의 `seed` 꼴로 업무·개인·가계부):
    - `the 워크스페이스 section sits under 일반 and lists the workspaces in order` — 구역 탭 순서 일반·워크스페이스·편집기·모양·단축키·확장, 설명 문구 그대로, 행 이름 업무·개인·가계부, 키 ⌃1·⌃2·⌃3.
    - `dragging a row reorders the switcher and ⌃1` — 가계부 행을 첫 행 위로 끈다(`page.mouse` down·move·up) → 행 순서 가계부·업무·개인, 키 다시 매김, 설정을 닫고 고르개 목록이 같은 순서, ⌃1 이 가계부로 전환.
    - `a hidden workspace leaves the switcher and gives up its number` — 개인 「숨김」 체크 → 행에 `.hidden`, 개인 키 비고 가계부가 ⌃2, 고르개에서 개인이 빠짐.
    - `a click on the hidden box is not a drag` — 체크박스를 누르고 몇 px 움직였다 놓아도 행 순서가 그대로, 체크만 바뀐다.
    - `Esc during a drag puts the row back and saves nothing` — 끄는 중 Esc → 순서 그대로, 가짜의 `setWorkspaceOrder` 호출이 없다(저장된 `order` 가 그대로).
    - `a failed save says why and shows the saved order` — `failWorkspaceOrder: 1` 로 끌기 → `.modal-error` 에 까닭, 행 순서가 원래대로.
    - `another window's settings section follows a new order` — `startWindows` 두 창, 둘 다 설정 「워크스페이스」 를 연 채 한 창에서 끌기 → 다른 창의 행 순서가 바뀐다.
    - `no workspaces under the root says so` — 시드 `workspaces: []` → 「워크스페이스 루트에 워크스페이스가 없습니다.」.
    - `a workspace without an id cannot be hidden` — 시드에서 가계부 `orderable: false` → 그 행의 체크박스가 `disabled`, 행은 맨 끝.
    - `a hidden row is drawn muted` — 숨긴 행의 `.ws-order-name` 색이 `--muted` 값과 같다.
- [ ] **Step 2:** `pnpm test src/ui/workspace-settings.test.ts`, `pnpm test:e2e tests/e2e/workspace-settings.spec.ts` 로 실패 확인.
- [ ] **Step 3:** 구현.
  - 끌기는 포인터 이벤트로 한다(`src/ui/tab-bar.ts` 와 같은 방식). 행 어디서든 `pointerdown`, 체크박스·라벨에서 시작한 것은 끌기가 아니다. 4px 넘게 움직이면 끌기 시작(`setPointerCapture`), 놓일 자리에 `.ws-order-drop` 을 보이고, `pointerup` 이 목록 안이면 `moveItem` 결과로 다시 그리고 `setWorkspaceOrder(새 순서 경로, 숨긴 경로)` 를 보낸다. 목록 밖에서 놓거나 Esc(capture 단계에서 막아 모달이 닫히지 않게)면 원래대로.
  - 숨김 체크는 바로 `setWorkspaceOrder(지금 순서, 새 숨김)`.
  - 저장이 실패하면 `fail(error)` 후 `listWorkspaces()` 로 다시 그린다.
  - `onWorkspacesChanged` 가 오면 다시 읽어 그린다. 끄는 중이면 놓은 뒤로 미룬다.
  - `dispose` 는 구독을 끊고 끄는 중인 것을 버린다. `openSettings` 가 닫힐 때 부른다(`disposeShortcuts` 옆).
- [ ] **Step 4:** `pnpm test`(개수 보고), `pnpm test:e2e tests/e2e/workspace-settings.spec.ts tests/e2e/settings.spec.ts tests/e2e/switcher.spec.ts`(개수 보고). `settings.spec.ts` 에 구역 목록·화살표 키 순서를 전제한 시험이 있으면 새 구역에 맞게 고친다.
- [ ] **Step 5: Commit** — 위 파일들, `feat: reorder and hide workspaces in the settings 워크스페이스 section`.

### Task 5: 전체 확인과 실기기 확인 목록

**Files:**

- Create: `docs/superpowers/reports/2026-10-29-tote-notes-workspace-order-smoke.md`

- [ ] **Step 1:** `pnpm fmt:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`(전체), `src-tauri/` 에서 `cargo fmt --all --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test`. 각 실행 개수를 보고에 적는다.
- [ ] **Step 2:** 디버그 번들을 만든다(`pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json`). 띄우지는 않는다.
- [ ] **Step 3:** 사람이 화면으로 할 확인 목록을 보고서에 쓴다. 각 행에 띄우는 명령(`TOTE_DATA_DIR` 포함)과 기대 결과:
  - WKWebView 에서 설정 「워크스페이스」 행 끌기, 놓일 자리 줄이 보임.
  - 「숨김」 체크박스 클릭이 끌기로 새지 않음(트랙패드 탭 포함).
  - 고르개 펼침의 ⌃ 표시가 점 다음 맨 오른쪽, 다크·라이트에서 흐린 글씨가 읽힘.
  - 창 둘을 띄우고 한 창에서 순서를 바꾸면 다른 창 고르개가 바뀜.
  - 설정 「일반」 에서 루트를 바꾸면 열린 창의 고르개와 「워크스페이스」 구역이 새 루트의 목록으로 바뀜.
  - 루트의 `.tote-workspaces.json` 내용이 (id, 이름) 쌍이고, Finder 로 폴더 이름을 바꿔도 자리가 남음.
- [ ] **Step 4: Commit** — 보고서, `docs: list the on-device checks for workspace order and hiding`.
