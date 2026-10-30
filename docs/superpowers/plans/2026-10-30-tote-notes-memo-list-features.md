# tote-notes 메모 목록 기능 묶음 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드바 메모 목록에 이름 바꾸기·내용 검색·미리보기·정렬·고정을 더하고, 닫기 창의 「버리기」 를 「저장하지 않음」 으로 바꾼다.

**Architecture:** 목록의 원본은 백엔드 `list_memos` 의 `MemoInfo` 다. 고정(`pinned`)·조회 시각(`viewedMs`)·미리보기(`preview`)를 거기에 더하고, 정렬·고정 구역 나누기·필터는 프론트의 순수 함수(`src/ui/memo-order.ts`)가 한다. 내용 일치는 워크스페이스 검색 엔진(`src-tauri/src/search/`)을 「메모마다 첫 일치 하나」 로 부르는 새 명령이 맡고, 문맥 메뉴·정렬 메뉴는 이미 있는 탭 문맥 메뉴의 네이티브 팝업을 넓혀 쓴다.

**Tech Stack:** Tauri 2(Rust), TypeScript + Vite, vitest, Playwright(`FakeBackend`), grep-searcher.

**Spec:** `docs/superpowers/specs/2026-10-30-tote-notes-memo-list-features-design.md`

## Global Constraints

- 버튼 이름 「저장하지 않음」, 안내 문장 「저장하지 않으면 바뀐 내용이 사라집니다.」 그대로. 식별자 `"discard"`·`ExternalDoc.discard` 는 바꾸지 않는다.
- 문맥 메뉴 항목: 「이름 바꾸기…」, 「맨 위에 고정」 / 「고정 해제」. 이름 입력 창은 `promptText("새 파일 이름", …)`.
- 필터 안내 글 「제목·내용 검색」. 내용 물음은 `SEARCH_DEBOUNCE_MS`(150ms) 뒤. 맞는 것이 없으면 「맞는 메모가 없습니다」.
- 미리보기: `settings.json` `sidebar.preview`(기본 `true`), 패치 `sidebarPreview`, 설정 화면 「사이드바」 구역의 「메모 목록에 내용 미리보기」. 100자, 파일 앞 4KB(UTF-8 경계). 행 높이 켜짐 46px / 꺼짐 28px.
- 정렬: `sidebar.sort` = `"modified-desc"`(기본) · `"modified-asc"` · `"viewed-desc"` · `"viewed-asc"`. 메뉴 이름 「최근 수정순」 · 「오래된 수정순」 · 「최근 조회순」 · 「오래된 조회순」. 동점은 이름순.
- 조회 시각은 이 기기에만, 변화가 멈추고 1초 뒤 쓰기, 창 닫기·앱 끄기 때 즉시. 본 적 없는 메모의 조회 시각 = 수정 시각.
- 고정: `index.json` 항목의 `pinned: true`(고정이 아니면 쓰지 않는다). 고정 구역이 목록 높이의 40% 를 넘으면 구역 안에서 스크롤.

## 「만드는 사람에게 남긴 것」 의 결정

- **네이티브 팝업:** 탭 문맥 메뉴의 `show_tab_menu` 를 `show_popup_menu` 로 넓힌다. 항목에 `checked`(있으면 `CheckMenuItem`)를 더한다. 이유: 메뉴를 띄우고 고른 id 를 돌려주는 경로(`TabMenu` 의 pick 기록, 메인 스레드 한 바퀴 기다리기)가 이미 실기기에서 검증됐다. 탭 전용 이름은 사이드바·정렬 메뉴에 맞지 않아 이름만 바꾼다(`TAB_MENU` 접두사는 `POPUP_MENU` 로).
- **내용 일치 명령:** 새 명령 `find_in_memos(queries, request_id) -> Vec<ContentHit>` 를 둔다. 스트리밍 명령을 그대로 쓰면 메모 하나에 일치를 200개까지 보내고(목록에는 첫 하나만 쓴다), 검색 패널과 취소 번호를 나눠 써서 필터가 패널의 검색을 끊는다. 새 명령은 `search::search` 를 「파일당 1개」 한도로 부르고 결과를 모아 한 번에 돌려준다. 취소 번호는 창마다 따로(`begin_memo_filter`). NFC 규칙은 프론트가 질의를 NFC·NFD 두 꼴로 보내고(`queries`), 백엔드가 둘을 `|` 로 이은 리터럴 패턴(대소문자 무시)으로 찾는다 — 파일이 어느 꼴로 저장돼 있어도 맞는다. 새 크레이트(`unicode-normalization`)를 들이지 않으려는 선택이다.
- **조회 시각 자리:** 앱 데이터 폴더 `viewed/<워크스페이스 ID>.json`(`{"version":1,"viewed":{"<메모 ID>":<ms>}}`). 이유: 세션 파일은 `write_layouts` 가 여러 곳에서 통째로 다시 쓰므로 조회 시각을 그 모든 자리로 날라야 하고, 워크스페이스 폴더 안에 두면 동기화가 붙을 때 폴더와 함께 다른 기기로 간다. 워크스페이스 ID 가 바뀌면(읽을 수 없는 `workspace.json`) 조회 기록은 새로 시작한다.
- **정렬 버튼·고정 표시·행 높이:** 정렬 버튼은 필터 칸 오른쪽 24px 정사각 버튼에 위아래 화살표 SVG(`aria-label="정렬"`), 고정 표시는 행 오른쪽 끝의 작은 핀 SVG(`.memo-pin`). 행 높이는 스펙 값(46px)으로 두고 실기기 확인 항목에 넣는다.
- **미리보기를 목록과 함께 줄지:** 함께 준다(`MemoInfo.preview`). 측정(Task 5)으로 판정한다 — 목표를 넘으면 같은 태스크 안에서 「목록 먼저, 미리보기는 `list_previews` 로 뒤따라」 로 바꾼다.

## 스펙과 다르게 하는 것

- **다른 창에 열린 메모의 이름 바꾸기:** 스펙은 「열린 탭의 바뀐 내용은 이름을 바꾸기 전에 저장된다」 고 한다. 이 창에 열린 탭은 `MemoDoc.rename`(저장 → 이름 바꾸기)을 그대로 지난다. **다른 창**에 열린 탭은 그 창에 저장을 시키는 경로가 없어(창끼리 답을 기다리는 왕복이 없다) 이름부터 바꾼다. 쓰기는 ID 로 가므로 그 창의 저장 전 내용은 바뀐 이름의 파일에 들어가고(잃지 않는다), 그 창의 자동 제목은 백엔드가 막는다(`retitle_memo` 는 `autoTitle: false` 면 그대로 둔다). 그 창의 탭 이름은 다음 목록 읽기(`tote://memos`, 300ms 모음)에서 따라온다 — Task 2 가 「목록을 다시 읽으면 열린 메모 탭의 정보가 목록을 따른다」 를 더한다.

## Review Focus

1. **조회순에서 메모를 열 때 목록이 다시 정렬돼도 스크롤 위치가 그대로다** — Task 4 e2e `opening a memo under the viewed order re-sorts and keeps the scroll`.
2. **세션 복원·워크스페이스 전환으로 되살린 활성 탭은 조회 시각을 바꾸지 않는다** — Task 4 e2e `a restored active tab is not counted as viewed`.
3. **필터를 비우면 늦게 도착한 내용 답이 목록을 다시 바꾸지 않는다** — Task 6 e2e `an answer that arrives after the filter is cleared is dropped`.
4. **고정한 메모가 필터에 안 맞으면 구역과 구분선이 숨는다** — Task 3 단위 `splitPinned` + e2e `the pinned zone hides when no pinned memo matches`.
5. **이름을 바꾸면 고정·조회 시각이 ID 로 따라간다** — Task 3 Rust `pinned_survives_a_rename`, Task 4 Rust `viewed_times_are_kept_by_id`.

---

### Task 1: 「저장하지 않음」

**Files:**

- Modify: `src/ui/dialogs.ts:105`, `src/app/docs.ts:1052`(주석), `tests/e2e/external.spec.ts:50`

- [ ] **Step 1:** `tests/e2e/external.spec.ts` 의 `getByRole("button", { name: "버리기" })` 를 `"저장하지 않음"` 으로 바꾸고, 같은 시험에 `await expect(page.getByRole("button", { name: "버리기" })).toHaveCount(0)` 를 더한다.
- [ ] **Step 2:** `TOTE_E2E_PORT=<워크트리 포트> pnpm exec playwright test tests/e2e/external.spec.ts` — 그 시험이 FAIL.
- [ ] **Step 3:** `askUnsaved` 의 버튼 글을 「저장하지 않음」 으로, `docs.ts` 주석의 「버리기」 를 「저장하지 않음」 으로.
- [ ] **Step 4:** 같은 명령 — PASS.
- [ ] **Step 5:** 커밋 `feat: call the close question's discard button 저장하지 않음`.

### Task 2: 네이티브 팝업 넓히기와 사이드바에서 이름 바꾸기

**Files:**

- Modify: `src-tauri/src/app/menu.rs`(`TabMenuItem` → `PopupMenuItem`, `show_popup_menu`), `src-tauri/src/app/commands.rs`, `src-tauri/src/lib.rs`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/tauri.test.ts`, `src/backend/fake.ts`, `src/app/controller.ts`, `src/ui/memo-list.ts`
- Test: `src-tauri/src/app/menu.rs`(기존 route 시험), `tests/e2e/memo-list.spec.ts`(새 파일)

**Interfaces:**

- Produces: `interface PopupMenuItem { id: string; text: string; checked?: boolean }`; `Backend.showPopupMenu(items: PopupMenuItem[]): Promise<string | null>`(옛 `showTabMenu` 대체). 가짜: `data.popupMenus`(옛 `tabMenus`), `data.popupMenuPick`(옛 `tabMenuPick`).
- Produces: `MemoList` 생성자 `new MemoList(host: MemoListHost)`, `interface MemoListHost { open(id: string): void; openAt(id: string, line: number, column: number): void; menu(id: string): void; sort(): void }`. 행의 `contextmenu` 가 `host.menu(id)` 를 부르고 기본 동작을 막는다.
- Produces: `AppController.renameMemo(id: string): Promise<void>` — 이 창에 탭이 있으면 `MemoDoc.rename`, 없으면 `backend.renameMemo` 후 `memoList.upsert`.

- [ ] **Step 1:** Rust: `PopupMenuItem { id, text, #[serde(default)] checked: Option<bool> }`. 기존 `route` 시험의 접두사 이름을 바꾸고, `checked` 가 빠진 JSON 이 읽히는 시험 `popup_items_read_without_checked` 를 더한다. `cargo test popup` FAIL → 구현(`checked` 가 `Some` 이면 `CheckMenuItemBuilder::with_id(..).checked(..)`) → PASS.
- [ ] **Step 2:** TS 이름 바꾸기(`showTabMenu` → `showPopupMenu`, 명령 `show_popup_menu`). `pnpm typecheck` 와 `tauri.test.ts`·탭 메뉴 e2e(`grep -rl tabMenu tests`) 통과.
- [ ] **Step 3: 실패하는 e2e** `tests/e2e/memo-list.spec.ts`:
  - `renaming a memo that is not open from its context menu` — 메모 둘(가·나), 탭 없음, `popupMenuPick: "rename"`. 「나」 행 `click({ button: "right" })` → `popupMenus` 마지막 항목 id 가 `["rename","pin"]`, 글 `["이름 바꾸기…","맨 위에 고정"]` → 이름 창에 「다.md」 → 행 「다」 가 보이고 가짜 `memos[나].file === "다.md"`, `autoTitle === false`.
  - `renaming an open memo from the sidebar saves it first and renames its tab` — 「가」 를 열고 글을 친 뒤(저장 타이머 전) 문맥 메뉴로 이름 바꾸기 → 가짜 `memos[가]` 내용에 친 글이 있고 탭 이름이 바뀐다.
  - `a bad name from the sidebar shows the same error` — `"a/b"` → 상태 표시줄에 「파일 → 이름 바꾸기…」 와 같은 오류 문구.
  - `another window's rename reaches this window's open tab` — `startWindows` 두 창, 창 1 에 「가」 탭, 창 2 사이드바에서 「가」 를 「라.md」 로 → 창 1 탭 이름 「라」.
- [ ] **Step 4:** FAIL 확인.
- [ ] **Step 5: 구현** — `MemoList` 가 `MemoListHost` 를 받는다. 컨트롤러 `memoMenu(id)`: `showPopupMenu([{id:"rename",text:"이름 바꾸기…"}])`(고정 항목은 Task 3) → `renameMemo(id)`. `renameMemo` 는 `renameActive` 와 같은 창(`promptText("새 파일 이름", file)`)과 같은 오류 경로(`report`). `refreshMemos` 뒤 열린 `MemoDoc` 마다 목록의 정보와 `file`·`autoTitle`·`language` 가 다르면 `doc.setInfo(listed)`(새 공개 메서드가 아니면 `follow(listed)` 로 이름 짓는다).
- [ ] **Step 6:** PASS. `pnpm fmt && pnpm lint:fix`, `cargo fmt --all`, clippy.
- [ ] **Step 7:** 커밋 `feat: rename a memo from the sidebar's context menu`.

### Task 3: 고정

**Files:**

- Modify: `src-tauri/src/workspace/index.rs`(`MemoEntry.pinned`), `src-tauri/src/workspace/memo.rs`(`MemoInfo.pinned`), `src-tauri/src/workspace/ops.rs`(`set_pinned`), `src-tauri/src/app/commands.rs`·`lib.rs`(`set_memo_pinned`), `src/backend/*`, `src/app/controller.ts`, `src/ui/memo-list.ts`, `src/styles.css`
- Create: `src/ui/memo-order.ts`, `src/ui/memo-order.test.ts`
- Test: `tests/e2e/memo-list.spec.ts`

**Interfaces:**

- Produces(Rust): `MemoEntry.pinned: bool`(`#[serde(default, skip_serializing_if = "is_false")]`), `MemoInfo.pinned: bool`(같은 생략), `Workspace::set_pinned(&mut self, id: &str, pinned: bool) -> Result<MemoInfo, WorkspaceError>`, 명령 `set_memo_pinned(id, pinned) -> MemoInfo`(뒤에 `memos_changed`).
- Produces(TS): `MemoInfo.pinned?: boolean`; `Backend.setMemoPinned(id: string, pinned: boolean): Promise<MemoInfo>`; `splitPinned(memos: readonly MemoInfo[]): { pinned: MemoInfo[]; rest: MemoInfo[] }`(순서 보존).

- [ ] **Step 1: 실패하는 Rust 시험** — `index.rs`: `pinned_is_written_only_when_set`(고정 없는 항목의 JSON 에 `pinned` 키가 없고, 고정하면 `"pinned":true`, 옛 파일(키 없음)은 `false` 로 읽힌다). `ops.rs`: `pinned_survives_a_rename`(고정 → `rename_memo` → `memo_info(id).pinned`), `deleting_a_pinned_memo_drops_its_entry`. `memo.rs` 의 직렬화 시험에 `pinned` 가 없을 때 키가 없다는 기대가 그대로 맞는지. FAIL → 구현 → PASS.
- [ ] **Step 2: 실패하는 단위 시험** `memo-order.test.ts`: `splitPinned keeps each side in the order given`, `a pinned memo is not in the rest`.
- [ ] **Step 3: 실패하는 e2e** — `pinning a memo moves it to the zone above the list`(문맥 메뉴 둘째 항목 「맨 위에 고정」 → `.memo-pinned .memo-row` 에 그 메모, `.memo-scroller` 에는 없음, 행에 `.memo-pin`, 가짜 `memos[id].pinned === true`), `unpinning`(다시 열면 글이 「고정 해제」), `the pinned zone stays put while the list scrolls`(메모 200개, 하나 고정, `.memo-scroller` 를 `scrollTop = 2000` → 고정 행의 `boundingBox().y` 가 그대로), `the pinned zone scrolls on its own past 40%`(고정 40개 → `.memo-pinned` 의 `clientHeight <= 0.4 * .memo-pane 높이 + 1` 이고 `scrollHeight > clientHeight`), `the pinned zone hides when no pinned memo matches`(필터에 고정 메모와 안 맞는 글 → `.memo-pinned` 와 `.memo-pinned-divider` 가 숨음), `another window follows a pin`.
- [ ] **Step 4:** FAIL 확인.
- [ ] **Step 5: 구현** — `MemoList` 구조: `.memo-pane` = `.memo-filter-row`(필터 + 정렬 버튼 자리) · `.memo-pinned`(자기 스크롤, `max-height: 40%`) · `.memo-pinned-divider` · `.memo-scroller`. 두 구역 다 가상 스크롤(`visibleRows`). 문맥 메뉴에 `{ id: "pin", text: info.pinned ? "고정 해제" : "맨 위에 고정" }`. 고르면 `setMemoPinned` → `memoList.upsert`. 열린 탭의 `MemoDoc.info` 도 `pinned` 를 따른다(`setInfo` 가 이미 통째로 바꾼다면 그대로).
- [ ] **Step 6:** PASS, 포맷·린트·clippy.
- [ ] **Step 7:** 커밋 `feat: pin memos to a zone above the memo list`.

### Task 4: 정렬과 조회 시각

**Files:**

- Create: `src-tauri/src/workspace/viewed.rs`
- Modify: `src-tauri/src/appdata.rs`(`SidebarSettings`, 패치 `sidebar_sort`), `src-tauri/src/workspace/{mod,memo}.rs`, `src-tauri/src/app/{mod,commands}.rs`, `src-tauri/src/lib.rs`, `src/backend/*`, `src/app/{controller,pane}.ts`, `src/ui/memo-list.ts`, `src/ui/memo-order.ts`
- Test: `src-tauri/src/workspace/viewed.rs`, `src-tauri/src/appdata.rs`, `src/ui/memo-order.test.ts`, `tests/e2e/memo-list.spec.ts`

**Interfaces:**

- Produces(Rust): `appdata::SidebarSettings { preview: bool /* Task 5 */, sort: SortOrder }`, `enum SortOrder { ModifiedDesc, ModifiedAsc, ViewedDesc, ViewedAsc }`(`#[serde(rename_all = "kebab-case")]`, 기본 `ModifiedDesc`, 모르는 값은 기본), `SettingsPatch.sidebar_sort: Option<SortOrder>`.
- Produces(Rust): `viewed::ViewedTimes { load(path: PathBuf) -> ViewedTimes; get(&self, id) -> Option<u64>; record(&mut self, id: &str, ms: u64) -> u64 /* generation */; save_if(&mut self, generation: u64) -> io::Result<bool>; save_now(&mut self) -> io::Result<()> /* 더러울 때만 */; retain(&mut self, ids: impl Fn(&str) -> bool) }`. 파일 `<data_dir>/viewed/<workspace id>.json`. `Workspace::attach_viewed(&mut self, times: ViewedTimes)`, `Workspace::memo_viewed(&mut self, id, ms) -> Result<u64, WorkspaceError>`. `MemoInfo.viewed_ms: Option<u64>`(없으면 생략).
- Produces(명령): `memo_viewed(id)` — 지금 시각을 기록하고 형제 창에 `tote://memos`, 1초 뒤 같은 세대면 쓴다(`tauri::async_runtime::spawn` + `sleep`). 창이 닫히거나 앱이 끝날 때(`write_session` 을 부르는 닫기·종료 자리) `save_now`.
- Produces(TS): `type MemoSort = "modified-desc" | "modified-asc" | "viewed-desc" | "viewed-asc"`, `Settings.sidebar: { preview: boolean; sort: MemoSort }`, `SettingsPatch.sidebarSort?: MemoSort`, `MemoInfo.viewedMs?: number`, `Backend.memoViewed(id: string): Promise<void>`, `sortMemos(memos: readonly MemoInfo[], sort: MemoSort): MemoInfo[]`, `MemoList.setSort(sort: MemoSort)`, 정렬 메뉴 항목 표 `SORT_ITEMS: { id: MemoSort; text: string }[]`.

- [ ] **Step 1: 실패하는 Rust 시험** — `viewed.rs`: `viewed_times_round_trip`, `only_the_latest_generation_saves`(record 두 번 → `save_if(첫 세대)` 는 `false` 이고 파일 없음, `save_if(둘째)` 는 `true`), `save_now_writes_only_when_dirty`, `an_unreadable_file_starts_empty`, `viewed_times_are_kept_by_id`(Workspace 에 붙여 기록 → 이름 바꾸기 → `memo_info(id).viewed_ms` 그대로). `appdata.rs`: `sidebar_sort_defaults_and_survives_a_bad_value`(`{}` → `ModifiedDesc`, `"sidebar":{"sort":"viewed-asc"}` → `ViewedAsc`, `"sort":"x"` → 기본, 다른 필드 유지), 패치 `{"sidebarSort":"modified-asc"}` 적용. FAIL → 구현 → PASS.
- [ ] **Step 2: 실패하는 단위 시험** `memo-order.test.ts`: 넷 각각의 순서(수정 시각 1·2·3, 조회 시각을 엇갈리게), `ties go by name`(넷 모두), `a memo never viewed counts its modified time`.
- [ ] **Step 3: 실패하는 e2e** — `the sort button picks one of four, checked`(정렬 버튼 → `popupMenus` 마지막이 넷, 지금 것만 `checked: true`; `popupMenuPick: "modified-asc"` → 행 순서가 뒤집히고 가짜 `settings.sidebar.sort === "modified-asc"`), `the viewed order follows opening`(조회순, 탭 누르기·사이드바 열기·⌃Tab 류 탭 옮기기 뒤 맨 위), `opening a memo under the viewed order re-sorts and keeps the scroll`, `a restored active tab is not counted as viewed`(세션에 활성 탭 → `memoViewedCalls` 0), `another window's view re-sorts this one`.
- [ ] **Step 4:** FAIL 확인.
- [ ] **Step 5: 구현** — `Pane.activate` 가 `tabs.active = doc` 뒤에 `host.viewed(doc)`. 컨트롤러 `viewed(doc)`: `restoring` 이면 아무것도 하지 않고, `MemoDoc` 이면 `memoList.upsert({...info, viewedMs: Date.now()})` 후 `backend.memoViewed(id)`(실패는 `console.warn`). 설정의 `sidebar.sort` 는 `loadSettings`·`onConfigChanged` 에서 `memoList.setSort`. 정렬 버튼은 `host.sort()` → `showPopupMenu(SORT_ITEMS.map(… checked))` → `patchSettings({ sidebarSort })`. `setSort` 는 스크롤 위치를 건드리지 않는다. 가짜: `memoViewed` 가 `data.viewed[id] = tick()`, `memoViewedCalls` 를 세고 형제 창에 `memosTouched`; `listMemos` 가 `viewedMs` 를 싣는다.
- [ ] **Step 6:** PASS, 포맷·린트·clippy.
- [ ] **Step 7:** 커밋 `feat: sort the memo list by modified or viewed time`.

### Task 5: 미리보기 (측정 포함)

**Files:**

- Create: `src-tauri/src/workspace/preview.rs`
- Modify: `src-tauri/src/workspace/{mod,memo}.rs`, `src-tauri/src/appdata.rs`(`sidebar.preview`, 패치 `sidebar_preview`), `src/backend/*`, `src/ui/{memo-list,settings}.ts`, `src/app/controller.ts`, `src/styles.css`, `scripts/measure-perf.sh`, `tests/measure/perf.md`(「측정 전에 더한 것」), `docs/superpowers/reports/2026-10-30-tote-notes-memo-list-perf.md`(새 보고)
- Test: `src-tauri/src/workspace/preview.rs`, `src-tauri/src/appdata.rs`, `src/ui/memo-list.test.ts`, `tests/e2e/memo-list.spec.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**

- Produces(Rust): `preview::PREVIEW_CHARS = 100`, `preview::PREVIEW_BYTES = 4096`, `preview::preview_of(head: &[u8]) -> Option<String>`(앞 4KB 를 받는다. NUL 이 있으면 `None`. UTF-8 경계에서 자른 뒤 줄 규칙). `MemoInfo.preview: Option<String>`(텍스트 메모만, 없으면 생략). `Workspace` 의 캐시 `previews: HashMap<String /* id */, (u64 /* mtime ms */, u64 /* size */, String /* file */, Option<String>)>` — 셋이 같으면 다시 읽지 않는다.
- Produces(TS): `Settings.sidebar.preview: boolean`, `SettingsPatch.sidebarPreview?: boolean`, `MemoInfo.preview?: string`, `ROW_HEIGHT = 28`, `PREVIEW_ROW_HEIGHT = 46`, `visibleRows(scrollTop, height, count, rowHeight)`, `MemoList.setPreview(on: boolean)`. 설정 구역 `"sidebar"`(「사이드바」, 「편집기」 앞), 체크박스 `name="sidebarPreview"`.
- Produces(측정): 프론트 마크 `memos-listed`(첫 `setMemos` 직후, `mark`), 시나리오 `list-10k` — `memos-10k`, 세션 없음, 지표 `process-start` → `memos-listed`, **목표 1,500ms**(콜드 스타트 목표를 그대로 쓴다: 목록은 첫 창이 서기 전에 받는다). 규칙(5회 중앙값, load < 3)은 `tests/measure/perf.md` 그대로. 측정 전에 `perf.md` 「측정 전에 더한 것」 에 이 시나리오를 적는다.

- [ ] **Step 1: 측정 준비와 「전」 값** — `memos-listed` 마크와 `list-10k` 시나리오를 더하고(미리보기 없이), `pnpm perf:fixtures <S>/fixtures`, `TOTE_DATA_DIR=$(mktemp -d) PERF_ONLY="list-10k cold-start" pnpm perf:measure <S>/fixtures`. 값을 기록한다. 커밋 `perf: time the first memo listing of a 10,000-memo workspace`.
- [ ] **Step 2: 실패하는 Rust 시험** — `preview.rs`: `the_title_line_is_skipped`(`"제목\n\n본문 하나\n둘"` → `"본문 하나 둘"`), `a_shebang_line_is_skipped_first`(`"#!/bin/sh\necho\nls"` → `"ls"`), `markdown_marks_go`(`"# t\n## 소제목\n- 가\n* 나\n+ 다\n> 라\n12. 마"` → `"소제목 가 나 다 라 마"`), `spaces_fold`, `cut_at_100_chars`(문자 수), `nothing_after_the_title_is_empty`(`Some("")`), `a_cut_utf8_sequence_is_dropped`(4096 바이트째가 한글 중간), `binary_has_none`. `memo.rs`: 이미지 메모의 `preview` 없음, 텍스트 메모에 있음, 같은 mtime·크기면 다시 읽지 않음(`previews_are_cached_until_the_file_changes` — 파일 내용을 mtime·크기를 같게 바꿔도 옛 미리보기). `appdata.rs`: `sidebar_preview_is_on_by_default_and_survives_a_bad_value`, 패치. FAIL → 구현 → PASS.
- [ ] **Step 3: 실패하는 TS·e2e** — 단위: `visibleRows` 가 두 높이에서 맞는 범위(46px 에서 `scrollTop 460` → 시작 행 `10 - OVERSCAN`). e2e: `a memo row shows its preview under the name`(`.memo-preview` 글), `rows are 46px with the preview and 28px without`, `turning the preview off in settings applies to every window at once`(설정 「사이드바」 → 체크 해제 → 두 창 모두 `.memo-preview` 없음·28px, 가짜 `settings.sidebar.preview === false`). 가짜 `listMemos` 는 Rust 와 같은 규칙의 `preview` 를 싣는다 — 규칙을 TS 로 다시 쓰지 않도록 시드에 `preview` 를 직접 줄 수 있게 하고(`FakeMemo.preview?`), 없으면 가짜만의 간단한 근사(제목 줄 다음 줄들)를 쓴다고 주석에 밝힌다.
- [ ] **Step 4:** FAIL 확인.
- [ ] **Step 5: 구현.** 행은 미리보기가 켜지면 둘째 줄 `.memo-preview`(한 줄, 말줄임). 텍스트가 아닌 메모는 빈 둘째 줄.
- [ ] **Step 6:** PASS, 포맷·린트·clippy.
- [ ] **Step 7: 「후」 값** — Step 1 과 같은 명령. 목표(1,500ms)를 넘으면 `list_memos` 에서 미리보기를 빼고 `list_previews(ids) -> Vec<(id, Option<String>)>` 로 뒤따라 채운다(같은 캐시). 전후 값과 다시 재는 명령을 보고 파일에 적는다.
- [ ] **Step 8:** 커밋 `feat: show a preview of each memo under its name`.

### Task 6: 필터가 내용도 찾는다

**Files:**

- Modify: `src-tauri/src/search/mod.rs`(한도 인자), `src-tauri/src/app/{mod,commands}.rs`, `src-tauri/src/lib.rs`, `src/backend/*`, `src/ui/{memo-list,memo-order}.ts`, `src/app/controller.ts`, `src/styles.css`
- Test: `src-tauri/src/search/mod.rs`, `src/ui/memo-order.test.ts`, `tests/e2e/memo-list.spec.ts`

**Interfaces:**

- Produces(Rust): `search::Limits { per_file: usize, total: usize }`(`search` 가 받는다. 패널은 `Limits::PANEL` = 200·2000), `search::literal_any(queries: &[String]) -> SearchQuery`(각각 `regex::escape` 해 `|` 로 잇고 `regex: true`, `case_sensitive: false`), 명령 `find_in_memos(queries: Vec<String>, request_id: u64) -> Vec<ContentHit>`, `ContentHit { memo_id, line, column, text }`(camelCase). 한도 `per_file 1`, `total usize::MAX`. 새 번호가 오면 앞의 것은 다음 파일에서 멈추고 빈 목록을 돌려준다. `AppCore::begin_memo_filter`/`memo_filter_is_live`.
- Produces(TS): `ContentHit { memoId; line; column; text }`, `Backend.findInMemos(queries: string[], requestId: number): Promise<ContentHit[]>`, `filterMemos(memos, query, hits: ReadonlyMap<string, ContentHit>): MemoInfo[]`(제목 일치 ∪ 내용 일치, 입력 순서 보존), `snippet(hit: ContentHit, query: string): { before: string; match: string; after: string }`(NFC 로 맞춘 `text` 에서 접은 질의를 찾고 앞은 최대 12자, 잘렸으면 `…`).

- [ ] **Step 1: 실패하는 Rust 시험** — `the_filter_finds_the_first_match_of_each_memo`(한 파일에 일치 셋 → `ContentHit` 하나, 첫 줄), `the_filter_ignores_case`, `the_filter_matches_text_literally`(`"a.b"` 가 `"axb"` 에 안 맞음), `the_filter_matches_either_normalization`(파일은 NFD `"한글"`, 질의 `["한글"(NFC), NFD]` → 맞음), `the_filter_skips_binary_and_big_files`(NUL 파일, 5MB 초과). 기존 패널 시험은 `Limits::PANEL` 로 그대로. FAIL → 구현 → PASS.
- [ ] **Step 2: 실패하는 단위 시험** — `filterMemos unites title and content matches`(제목만·내용만·둘 다·아무것도), `snippet marks the match`(앞이 길면 `…`+12자), `snippet finds a decomposed match`(NFD `text`).
- [ ] **Step 3: 실패하는 e2e** — `the filter's placeholder is 제목·내용 검색`, `title matches show at once and content matches after 150ms`(`page.clock`: `runFor(149)` 에 내용 일치 행 없음, `runFor(1)` 뒤 있음), `a content match shows the matching line with the match marked`(`.memo-preview mark` 글이 질의), `with the preview off a content match stays one line`(`.memo-preview` 없음, 28px), `clicking a content match opens the memo at the first match`(커서 위치 = 일치 줄·열), `nothing matches shows 맞는 메모가 없습니다`, `a newer keystroke cancels the earlier ask`(가짜 `memoFilterCalls` 의 앞 번호가 버려짐), `an answer that arrives after the filter is cleared is dropped`(가짜가 답을 붙잡았다가 필터를 비운 뒤 풀기 → 목록이 전부), `the pinned zone filters by content too`.
- [ ] **Step 4:** FAIL 확인.
- [ ] **Step 5: 구현** — `MemoList` 가 입력마다 제목으로 즉시 다시 거르고, 150ms 타이머 뒤 `host.findInMemos(query)`(컨트롤러가 번호를 붙여 `[q.normalize("NFC"), q.normalize("NFD")]` 로 부른다). 답은 그때의 질의와 지금 질의가 같을 때만 쓴다. 필터를 비우면 타이머를 지우고 `cancel`(번호만 올린다). 행 클릭은 내용 일치면 `host.openAt(id, line, column)`(컨트롤러의 `openMatch`), 아니면 `host.open(id)`.
- [ ] **Step 6:** PASS, 포맷·린트·clippy.
- [ ] **Step 7:** 커밋 `feat: let the memo list's filter find memos by their content`.

### Task 7: 마무리 검증과 실기기 확인 목록

- [ ] **Step 1:** `pnpm typecheck`, `pnpm test`(`Tests N passed`), `cargo test --no-fail-fast`(src-tauri, `test result:` 줄 합), `TOTE_E2E_PORT=<포트> pnpm test:e2e`(`N passed`). 개수를 적는다.
- [ ] **Step 2: 구분력 실증** — 기능마다 프로덕션 코드 한 곳을 손으로 되돌려 핵심 시험 하나가 실패하는지 보고 `git restore` 로 되돌린다(`git status` 깨끗).
- [ ] **Step 3:** 실기기에서 못 본 항목(문맥 메뉴·정렬 메뉴의 네이티브 팝업과 체크 표시, 고정 구역의 스크롤, 미리보기 행이 실제 글꼴에서 잘리지 않는지 — 46px)을 `docs/superpowers/reports/2026-10-30-tote-notes-memo-list-features-smoke.md` 에 확인 목록으로 남기고 커밋.
