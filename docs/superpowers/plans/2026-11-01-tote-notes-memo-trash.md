# tote-notes 메모 휴지통·줄번호 글자 크기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 메모 목록 문맥 메뉴에서 메모를 워크스페이스 안 `.trash` 로 옮기고, 사이드바에서 휴지통을 보고·복구하고·영구 삭제하고, 60일(설정) 지난 것을 저절로 비운다. 편집기 줄번호 글자를 본문의 0.85배로 줄인다.

**Architecture:** 휴지통 저장은 Rust `workspace` 모듈의 새 파일 `trash.rs` 가 맡는다(`.trash/<id>/<file>` + `.trash/trash.json`). Tauri 명령이 그것을 프런트에 내고, 같은 워크스페이스의 다른 창에는 `tote://trash` 로 알린다. 프런트는 사이드바에 세 번째 패널 `"trash"`(휴지통 목록)를 더하고, 휴지통 메모는 읽기 전용 탭 `TrashDoc` 으로 연다.

**Tech Stack:** Rust(Tauri 2, serde, objc2 없음), TypeScript, CodeMirror 6, Playwright e2e(가짜 백엔드 `src/backend/fake.ts`), vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-11-01-tote-notes-memo-trash-design.md` — 각 태스크를 시작하기 전에 해당 절을 읽는다. 이 계획과 스펙이 다르면 스펙을 따르고 다르다고 보고한다.

## Global Constraints

- 휴지통 자리: `<워크스페이스>/.trash/<id>/<옮길 때의 파일 이름>`, 정보 `.trash/trash.json` = `{ "version": 1, "items": { "<id>": { "file", "deletedAt"(ms), "autoTitle", "language"?, "pinned"? } } }` (스펙 「저장」).
- 옮기기 쓰기 순서: 파일 → `index.json` → `trash.json` (스펙 「저장」).
- 맞추기: 폴더만 있고 정보에 없는 항목·다시 만든 항목의 `deletedAt` = 맞춘 그 시각(지금). 원래 이름 = 폴더 안 파일 이름, `autoTitle`·`language`·`pinned` = 꺼짐·없음·꺼짐 (스펙 「저장」).
- 메뉴 문구: 「휴지통으로 이동」(구분선 뒤 맨 아래), 휴지통 행 「복구」 / 구분선 / 「영구 삭제」, 맨 아래 「휴지통 비우기」, 비었을 때 「휴지통이 비었습니다」, 머리줄 「← 메모」·「휴지통 N」, 버튼 접근 이름 「휴지통」·`title` 「휴지통 (N개)」 (스펙 「휴지통 화면」).
- 확인 창: 휴지통으로 옮길 때 **없음**. 영구 삭제 「「<이름>」 를 영구 삭제할까요? 되돌릴 수 없습니다.」, 비우기 「휴지통의 메모 N개를 영구 삭제할까요? 되돌릴 수 없습니다.」, 버튼 「취소」·위험 스타일 「영구 삭제」 (스펙 「휴지통 화면」).
- 휴지통 탭 띠: 「휴지통에 있는 메모입니다 · <지운 시각>」, 버튼 「복구」·「영구 삭제」 (스펙 「내용 보기」).
- 자동 비우기: `settings.json` `trash.retentionDays`, 기본 60, `null` = 안 비움, 1~3650 으로 묶음. 워크스페이스를 열 때와 한 시간마다. `deletedAt` 이 미래면 지우지 않는다 (스펙 「자동 비우기」).
- 설정 화면 「일반」: 「휴지통 자동 비우기」 — 숫자 칸 「[60] 일 지난 메모」 + 「안 비움」 체크 (스펙 「자동 비우기」).
- 복구: 같은 ID, `autoTitle`·`language`·`pinned` 그대로, 이름이 있으면 `free_name` 번호, 덮어쓰지 않음 (스펙 「복구」).
- 빈 자동 제목 메모를 닫을 때의 삭제(`MemoDoc.close`)는 바꾸지 않는다.
- 줄번호 글자 = 본문의 0.85배, 줄과 세로 위치 1px 안 (스펙 「줄번호 글자 크기」).
- 커밋은 경로로 stage, 메시지 영어, 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 코드를 고친 뒤 `cargo fmt --all`, `cargo clippy --all-targets --all-features -- -D warnings`, `pnpm fmt`, `pnpm lint`. 테스트 실행 개수를 보고에 적는다.

## Review Focus

1. **다른 창에 열린 메모를 지울 때** — 한 메모는 한 창에만 열린다(`src-tauri/src/app/places.rs`). 그 창이 저장하고 탭을 닫은 뒤 옮겨야 하고, 저장 안 된 글이 사라지면 안 된다. Task 5 의 e2e `trashing a memo open in another window saves it there and closes its tab`.
2. **저장이 실패한 탭의 메모를 지울 때** — 옮기지 않고 알린다. Task 5 e2e `a memo whose save failed is not trashed`.
3. **파일 감시가 앱 자신의 옮기기·복구를 외부 변경으로 볼 때** — 「삭제됨」 배너나 중복 항목이 생기면 안 된다. Task 2 테스트 `trashing_and_restoring_leave_no_fs_change_to_report`.
4. **같은 이름 메모가 있는 채로 복구** — 덮어쓰지 않고 「이름 2」. Task 2 `restore_takes_a_free_name_when_the_old_one_is_taken`.
5. **시계가 거꾸로 갔거나 `trash.json` 이 깨졌을 때의 자동 비우기** — 아무것도 일찍 지우지 않는다. Task 2 `expire_keeps_items_from_the_future_and_rebuilt_ones`.

---

### Task 1: 줄번호 글자 크기

**Files:**

- Modify: `src/editor/setup.ts` (`appTheme` 의 `.cm-gutters`·`.cm-lineNumbers .cm-gutterElement`)
- Test: `tests/e2e/line-numbers.spec.ts` (새로)

**Interfaces:** 없음(다른 태스크와 독립).

- [ ] **Step 1: 실패하는 e2e 를 쓴다** — `line numbers are 0.85 of the text and sit on their lines`: 세 줄 메모를 열고 `.cm-lineNumbers .cm-gutterElement` 의 계산된 `font-size` 가 `.cm-content` 의 0.85배(±0.5px)인지, 1·2·3번째 줄마다 줄번호 요소 글자 상자의 세로 가운데와 `.cm-line` 의 세로 가운데 차이가 1px 이하인지 본다(`getBoundingClientRect` 로 텍스트 범위를 잰다 — 줄번호는 `Range` 로, 줄은 첫 글자 `Range` 로).
- [ ] **Step 2: 돌려 실패를 본다** — `pnpm exec playwright test tests/e2e/line-numbers.spec.ts` → font-size 단언에서 FAIL.
- [ ] **Step 3: 구현** — 줄번호 칸 글자를 `0.85em` 으로 하고, 줄번호 요소의 줄 높이를 본문 `.cm-line` 의 계산된 줄 높이(px)와 같게 둔다. 글자가 작아져도 줄 상자 높이는 그대로여야 Step 1 의 가운데 단언이 맞는다. 활성 줄 번호도 같은 크기.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, 이어 `pnpm exec playwright test` 전체(실행 개수 기록).
- [ ] **Step 5: 커밋** — `style: shrink the line numbers to 0.85 of the text`.

### Task 2: 휴지통 저장소 (Rust)

**Files:**

- Create: `src-tauri/src/workspace/trash.rs`
- Modify: `src-tauri/src/workspace/mod.rs` (`mod trash;`, `pub use trash::TrashedInfo;`), `src-tauri/src/workspace/ops.rs` (공유 정리 함수만)
- Test: `trash.rs` 안 `#[cfg(test)] mod tests`

**Interfaces:**

- Produces:
  - `pub const TRASH_DIR: &str = ".trash";`
  - `#[derive(Clone, Debug, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub struct TrashedInfo { pub id: String, pub file: String, pub deleted_ms: u64, pub auto_title: bool, pub language: Option<String>(skip if none), pub pinned: bool(skip if false), pub kind: FileKind }`
  - `impl Workspace`:
    - `pub fn trash_memo(&mut self, id: &str, now_ms: u64) -> Result<TrashedInfo, WorkspaceError>`
    - `pub fn list_trash(&mut self, now_ms: u64) -> Result<Vec<TrashedInfo>, WorkspaceError>` — 맞추기를 하고 `deleted_ms` 내림차순.
    - `pub fn read_trashed(&self, id: &str) -> Result<Vec<u8>, WorkspaceError>` — `read_memo` 와 같은 텍스트 판정.
    - `pub fn restore_memo(&mut self, id: &str) -> Result<MemoInfo, WorkspaceError>`
    - `pub fn purge_trashed(&mut self, id: &str) -> Result<(), WorkspaceError>`
    - `pub fn empty_trash(&mut self) -> Result<usize, WorkspaceError>` — 지운 개수.
    - `pub fn expire_trash(&mut self, now_ms: u64, retention_days: Option<u32>) -> Result<Vec<String>, WorkspaceError>` — 지운 ID 들. `None` 이면 빈 Vec.
  - 없는 ID 는 `WorkspaceError::UnknownMemo`.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`ops.rs` 테스트의 `workspace()` 도우미와 같은 방식). 각 테스트 이름과 단언:
  - `trash_moves_the_file_and_leaves_the_memo_list`: 메모 `회의록.md`(고정·언어 markdown)를 `trash_memo(id, 1000)` → 루트에 파일 없음, `.trash/<id>/회의록.md` 있음, `list_memos()` 에 없음, `list_trash(1000)` = `[TrashedInfo{file:"회의록.md", deleted_ms:1000, pinned:true, language:Some("markdown"), ..}]`, `.tote/index.json` 에 ID 없음.
  - `the_same_name_trashed_twice_keeps_both`: 같은 이름을 만들고 지우기를 두 번 → `list_trash` 2개, 둘 다 읽힘.
  - `restore_brings_back_the_id_name_pin_and_language`: 지운 뒤 `restore_memo` → `MemoInfo` 의 id·file·pinned·language·auto_title 이 지우기 전과 같고 `.trash/<id>` 없음, `trash.json` 에 없음.
  - `restore_takes_a_free_name_when_the_old_one_is_taken`: `a.md` 를 지우고 새 `a.md` 를 만든 뒤 복구 → 복구된 것 `a 2.md`, 새 `a.md` 내용 그대로.
  - `restore_keeps_auto_title`: 자동 제목 메모를 이름 충돌 상태로 복구 → `auto_title == true`.
  - `purge_and_empty_remove_for_good`: `purge_trashed` 뒤 `.trash/<id>` 없음·목록에 없음, `empty_trash` 가 남은 개수를 돌려주고 `.trash` 안 항목 0.
  - `expire_deletes_only_what_is_past_its_days`: 60일 기한, `deleted_ms` 가 `now - 61일`·`now - 59일`인 둘 → 앞의 것만 지움.
  - `expire_keeps_items_from_the_future_and_rebuilt_ones`: `deleted_ms = now + 1일` 항목은 남음; `trash.json` 을 지우고 `list_trash(now)` 로 다시 만든 항목은 `deleted_ms == now` 이고 바로 이어 `expire_trash(now, Some(1))` 해도 남음; `trash.json` 을 `{ broken` 으로 바꿔도 같고 깨진 파일은 옆으로 치워짐.
  - `an_orphan_folder_joins_the_trash`: `.trash/<id>/x.md` 만 손으로 만든 뒤 `list_trash(now)` → 그 항목, `deleted_ms == now`, `auto_title == false`.
  - `trashing_and_restoring_leave_no_fs_change_to_report`: 지우기 뒤 `apply_fs_events(&{"회의록.md"}, &[])` 가 빈 변경, 복구 뒤 `apply_fs_events(&{복구 이름}, &[])` 도 빈 변경.
  - `retention_none_never_expires`: `expire_trash(now, None)` 은 아무것도 안 지움.
- [ ] **Step 2: 실패 확인** — `cargo test --manifest-path src-tauri/Cargo.toml trash -- --nocapture` → 컴파일 실패(없는 함수).
- [ ] **Step 3: 구현** — `trash.rs` 에 `TrashFile`(`trash.json` 직렬화) 과 위 메서드. `trash_memo` 는 `delete_memo` 가 정리하는 `last_written`·`inodes`·`viewed` 를 같이 정리하고 `mark_changed()`; `restore_memo` 는 `add_memo` 처럼 쓴 파일로 기록해(`wrote`·`track_inode`) 감시가 외부 변경으로 보지 않게 한다. `trash.json` 쓰기는 `persist::write_json`, 깨진 파일 치우기는 `MemoIndex::load` 가 쓰는 방식(`persist::set_aside`)을 그대로. 일 단위 = `86_400_000` ms.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, 이어 `cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast` 전체(개수 기록), fmt·clippy.
- [ ] **Step 5: 커밋** — `feat: keep trashed memos in the workspace's .trash folder`.

### Task 3: 명령·이벤트·설정 (Rust)

**Files:**

- Modify: `src-tauri/src/app/commands.rs`, `src-tauri/src/lib.rs`(명령 등록), `src-tauri/src/app/menu.rs`(`PopupMenuItem` 구분선), `src-tauri/src/appdata.rs`(`TrashSettings`, 패치), `src-tauri/src/app/mod.rs`(열 때·한 시간마다 비우기)
- Test: 각 파일의 기존 테스트 모듈

**Interfaces:**

- Consumes: Task 2 의 `Workspace` 메서드.
- Produces (프런트가 부르는 이름 그대로):
  - 명령 `trash_memo(id) -> TrashOutcome`, `#[serde(tag = "kind", rename_all = "camelCase")] enum TrashOutcome { Trashed { item: TrashedInfo }, Elsewhere }` — 그 메모의 자리(`Places`)를 다른 창이 쥐고 있으면 옮기지 않고 그 창에 `tote://trash-memo` (payload `{ id }`) 를 보내고 `Elsewhere`.
  - 명령 `list_trash() -> Vec<TrashedInfo>`, `read_trashed(id) -> 바이트`(`read_memo` 와 같은 응답 방식), `restore_memo(id) -> MemoInfo`, `purge_trashed(id) -> ()`, `empty_trash() -> usize`.
  - 바꾸는 명령은 모두 끝에 `memos_changed` 와 같은 형제 창들에 `tote://trash` (payload 없음) 를 보낸다: `pub fn trash_changed(app: &AppHandle, label: &str)`. 복구는 `memos_changed` 도 부른다.
  - `PopupMenuItem` 에 `#[serde(default)] pub separator: bool` — 참이면 `id`·`text` 를 보지 않고 구분선(`PredefinedMenuItem::separator`).
  - `Settings.trash: TrashSettings { retention_days: Option<u32> }`, 기본 `Some(60)`, 읽을 때 1~3650 으로 묶고 0 은 `None`. `SettingsPatch.trash_retention_days: Option<Option<u32>>`(`double_option`).
  - 자동 비우기: 워크스페이스를 연 직후와, 백업 스레드가 도는 주기와 별개로 한 시간마다(`AppCore` 에 `pub fn expire_trash_all(&self, now_ms: u64) -> Vec<String>`(비운 것이 있는 창 라벨) 을 두고 기존 백업 스레드 루프나 새 타이머에서 부른다), 비운 것이 있으면 그 창들에 `tote://trash`.
- [ ] **Step 1: 실패하는 테스트** — `appdata.rs`: `trash_retention_defaults_to_60_and_clamps`(없음→Some(60), 0→None, 5000→3650, `null`→None, `"x"`→Some(60)), `a_patch_sets_and_clears_retention`. `menu.rs`: `a_separator_item_reads_without_id_or_text`(JSON `{"separator":true}` 역직렬화). `mod.rs`: `expire_trash_all_empties_old_items_of_open_workspaces`(열린 워크스페이스 하나에 61일 전 항목 → 지워지고 그 창 라벨이 돌아옴).
- [ ] **Step 2: 실패 확인** — `cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast` → 새 테스트 컴파일 실패.
- [ ] **Step 3: 구현** — 위 Interfaces 대로. `trash_memo` 의 자리 확인은 `claim_tabs` 가 쓰는 `AppCore` 의 places 조회와 같은 잠금 안에서 한다(옮기는 사이 다른 창이 그 메모를 열지 못하게 그 창 라벨로 claim 한 뒤 옮기고 release).
- [ ] **Step 4: 통과 확인** — 전체 `cargo test --no-fail-fast`, fmt, clippy.
- [ ] **Step 5: 커밋** — `feat: trash commands, the trash event and the retention setting`.

### Task 4: 프런트 백엔드 계층

**Files:**

- Modify: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`
- Test: `src/backend/fake.test.ts`(있으면 거기, 없으면 새로)

**Interfaces:**

- Consumes: Task 3 의 명령·이벤트 이름.
- Produces (`Backend` 인터페이스):
  - `interface TrashedInfo { id: string; file: string; deletedMs: number; autoTitle: boolean; language?: string; pinned?: boolean; kind: FileKind }`
  - `type TrashOutcome = { kind: "trashed"; item: TrashedInfo } | { kind: "elsewhere" }`
  - `trashMemo(id: string): Promise<TrashOutcome>`, `listTrash(): Promise<TrashedInfo[]>`, `readTrashed(id: string): Promise<Uint8Array>`, `restoreMemo(id: string): Promise<MemoInfo>`, `purgeTrashed(id: string): Promise<void>`, `emptyTrash(): Promise<number>`
  - `onTrashChanged(handler: () => void): void`, `onTrashRequest(handler: (id: string) => void): void` (`tote://trash-memo`)
  - `PopupMenuItem` 에 `separator?: boolean` (있으면 `id`·`text` 는 빈 문자열로 보낸다).
  - `Settings.trash: { retentionDays: number | null }`, `SettingsPatch.trashRetentionDays?: number | null`.
  - 가짜: `FakeData.trash?: Record<string, FakeMemo & { deletedMs: number }>`; 시험용 `trashChanged()`·`trashRequest(id)` (다른 창 흉내), `FakeHub` 가 있으면 자리를 쥔 창에 `trashRequest` 를 보내고 `elsewhere`. 가짜의 복구 이름 충돌 규칙은 `add` 가 쓰는 번호 규칙과 같게.
- [ ] **Step 1: 실패하는 테스트** — `fake trash moves, lists newest first, restores with a free name, purges and empties`.
- [ ] **Step 2: 실패 확인** — `pnpm test src/backend` → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `pnpm test`(개수), `pnpm exec tsc --noEmit`(또는 저장소의 타입체크 스크립트).
- [ ] **Step 5: 커밋** — `feat: the trash in the backend interface and the fake`.

### Task 5: 휴지통으로 옮기기 (문맥 메뉴)

**Files:**

- Modify: `src/app/controller.ts` (`memoMenu`, 새 `trashMemo`, `onTrashRequest` 연결)
- Test: `tests/e2e/trash.spec.ts` (새로)

**Interfaces:**

- Consumes: Task 4.
- Produces: `AppController.trashMemo(id: string): Promise<void>` — 이 창에 탭이 있으면 그 탭을 `close()` 로 닫는다(저장 포함). `close()` 가 `false`(저장 실패·충돌)면 옮기지 않고 상태 표시줄에 「저장하지 못해 휴지통으로 옮기지 않았습니다」. 닫힌 뒤 `backend.trashMemo(id)`; `trashed` 면 `memoList.remove(id)`, 휴지통 목록이 보이면 새로 읽음; `elsewhere` 면 아무것도 안 함(그 창이 한다). `onTrashRequest(id)` 는 같은 `trashMemo(id)` 를 부른다.
- [ ] **Step 1: 실패하는 e2e** —
  - `the memo menu ends with a separator and 휴지통으로 이동`: `popupMenus` 마지막 메뉴의 끝 두 항목이 `{separator:true}`, `{id:"trash", text:"휴지통으로 이동"}`.
  - `trashing moves the memo out of the list without asking`: `popupMenuPick:"trash"` → 행이 사라지고 모달 없음, `data.trash` 에 그 ID.
  - `trashing an open memo saves its last edit first and closes its tab`: 편집 직후 옮기기 → 탭 없음, `data.trash[id]` 내용이 마지막 편집.
  - `a memo whose save failed is not trashed`: 쓰기 실패를 걸고 → `data.trash` 없음, 탭 남음, 상태 표시줄 문구.
  - `trashing a memo open in another window saves it there and closes its tab`: 허브 두 창, 창 B 에 연 메모를 창 A 에서 옮기기 → B 탭 닫힘, `data.trash` 에 B 의 마지막 편집.
- [ ] **Step 2: 실패 확인** — `pnpm exec playwright test tests/e2e/trash.spec.ts` FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 이 파일, 이어 e2e 전체(개수).
- [ ] **Step 5: 커밋** — `feat: move a memo to the trash from the memo list`.

### Task 6: 휴지통 목록 (사이드바)

**Files:**

- Create: `src/ui/trash-list.ts`, `src/ui/trash-button.ts`
- Modify: `src/ui/sidebar.ts` (`SidebarPane = "memos" | "search" | "trash"`, 생성자에 두 부품), `src/app/controller.ts`, `src/ui/dialogs.ts` (`confirm` 에 `danger` 선택지), `src/styles.css`
- Test: `src/ui/trash-list.test.ts`, `tests/e2e/trash.spec.ts`

**Interfaces:**

- Consumes: Task 4, Task 5.
- Produces:
  - `interface TrashListHost { open(id: string): void; menu(id: string): void; back(): void; empty(): void }`
  - `class TrashList { readonly el: HTMLElement; constructor(host: TrashListHost); setItems(items: TrashedInfo[]): void; get(id: string): TrashedInfo | undefined; get count(): number }` — 행 이름 표시는 `MemoList` 와 같은 규칙, 시각은 미리보기 행의 시각 표기 함수를 재사용.
  - `class TrashButton { readonly el: HTMLButtonElement; constructor(onClick: () => void); setCount(n: number): void }` — `title` 「휴지통 (N개)」.
  - `confirm(message: string, okLabel: string, tone?: "danger"): Promise<boolean>`.
  - `AppController.showTrash(): Promise<void>` (목록 읽고 패널 전환), `restoreTrashed(id)`, `purgeTrashed(id)`, `emptyTrash()` — 영구 삭제·비우기는 확인 창 뒤에만. `onTrashChanged` 로 목록 새로 읽기, 워크스페이스 전환 때도.
- [ ] **Step 1: 실패하는 테스트** — 단위 `trash list shows newest first, says when empty and disables 비우기`; e2e `the trash button swaps the memo list for the trash and back`, `a trashed row's menu restores it into the memo list`, `영구 삭제 asks once and removes for good`, `휴지통 비우기 asks with the count`, `another window's trash change shows here`.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — 하단 줄 높이 44px·두 버튼 28px 규칙(`docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md` 「설정 화면」)을 지키고 업데이트 버튼은 남은 폭.
- [ ] **Step 4: 통과 확인** — `pnpm test`, e2e 전체(개수).
- [ ] **Step 5: 커밋** — `feat: the trash in the sidebar`.

### Task 7: 휴지통 메모 읽기 전용 탭

**Files:**

- Modify: `src/app/docs.ts` (`TrashDoc`), `src/app/controller.ts`, `src/app/pane.ts`(필요한 만큼), `src/ui/banner.ts`(`BannerKind` 에 `"trash"`), `src/styles.css`
- Test: `tests/e2e/trash.spec.ts`

**Interfaces:**

- Consumes: Task 4, Task 6.
- Produces: `class TrashDoc extends Doc { readonly kind = "trashed"; info: TrashedInfo }` — 읽기 전용(`EditorState.readOnly`·`EditorView.editable` false), 세션에 넣지 않음, 자리(`Places`) claim 하지 않음(설계자 판단: 휴지통 메모는 다른 창에서도 같은 내용이다), 같은 ID 의 `TrashDoc` 이 열려 있으면 그 탭으로. 띠는 Global Constraints 의 문구. `AppController.openTrashed(id)`. 복구되면 그 탭 자리에 `MemoDoc`(같은 ID) 이 들어가고(`Tabs.replace`) claim 한다. claim 이 거절되면(다른 창이 이미 그 메모를 열었으면) 이 탭은 닫는다 — 한 메모는 한 자리에. 영구 삭제·자동 비우기로 목록에서 사라지면 탭을 닫는다(`onTrashChanged` 에서 확인).
- [ ] **Step 1: 실패하는 e2e** — `a trashed row opens read-only with the trash banner`, `복구 in the banner turns the tab into the memo`, `a purged memo's tab closes, in every window`, `trashed tabs do not come back after a restart`.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — e2e 전체(개수), `pnpm test`.
- [ ] **Step 5: 커밋** — `feat: open a trashed memo read-only`.

### Task 8: 설정 칸

**Files:**

- Modify: `src/ui/settings.ts` (「일반」 구역)
- Test: `tests/e2e/settings.spec.ts`(있는 파일에 더함)

**Interfaces:** Consumes: Task 4 의 `Settings.trash`·`SettingsPatch.trashRetentionDays`.

- [ ] **Step 1: 실패하는 e2e** — `the general section sets the trash retention`: 기본 60 이 보이고, 30 입력 → 패치 `{trashRetentionDays:30}`, 「안 비움」 체크 → `{trashRetentionDays:null}` 이고 숫자 칸 비활성, 0·빈 칸·문자는 저장된 값으로 되돌아가고 보내지 않음, 5000 → 3650 으로 보이고 보냄.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — 글꼴 크기 칸의 묶기·되돌리기 코드를 공유 함수로 꺼내 둘이 같이 쓴다.
- [ ] **Step 4: 통과 확인** — e2e 전체(개수).
- [ ] **Step 5: 커밋** — `feat: set how long the trash keeps memos`.

### Task 9: 문서·지침 표

**Files:**

- Modify: `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`(메모를 지우는 길·`.trash` 를 말하는 절), `docs/superpowers/specs/2026-10-30-tote-notes-memo-list-features-design.md`(「이름 바꾸기」 의 「항목은 … 둘이다」 문장), `.ruler/90-reference.md`(이 스펙·이 계획 행), 새 `docs/superpowers/reports/2026-11-01-tote-notes-memo-trash-smoke.md`(실기기 확인 항목: 문맥 메뉴 구분선·새 항목, 하단 줄 두 버튼+업데이트 버튼, 휴지통 패널, 읽기 전용 탭, 줄번호 기준선)
- [ ] **Step 1:** 위 문장들을 고친다. 문서 규칙은 `docs/guideline/base/04-citation.md`.
- [ ] **Step 2:** `pnpm exec ruler apply` 후 `git status` — 추적 파일 변경은 `.ruler/90-reference.md` 와 위 문서뿐이어야 한다.
- [ ] **Step 3: 커밋** — `docs: the memo trash in the core and memo list specs, and its smoke checklist`.
