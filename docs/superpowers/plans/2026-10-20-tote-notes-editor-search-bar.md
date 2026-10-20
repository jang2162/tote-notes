# tote-notes 편집기 검색 띠(⌘F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ⌘F 를 누르면 CodeMirror 기본 검색 패널 대신, 테마 색을 따르고 대비가 맞는 두 줄짜리 한국어 검색 띠(찾기 줄 + 접히는 바꾸기 줄)가 칸 맨 위에 뜬다.

**Architecture:** 검색 엔진·결과 칠·명령은 `@codemirror/search` 6.7 그대로 두고, `search({ top: true, createPanel })` 로 패널 DOM 만 새로 만든다. 개수 세기와 대비 계산은 DOM 없는 순수 함수로 빼서 단위 시험한다. 바꾸기 줄 펼침은 작은 StateField 로 탭(EditorState)마다 기억하고, 파일 다시 읽기 때 검색 상태를 새 state 로 옮긴다.

**Tech Stack:** TypeScript, CodeMirror 6 (`@codemirror/search` 6.7.2, `@codemirror/view`, `@codemirror/state`), vitest, Playwright(WebKit, 가짜 백엔드).

**Spec:** `docs/superpowers/specs/2026-10-20-tote-notes-editor-search-bar-design.md`

## Global Constraints

- 문구(그대로): 찾기 입력칸 placeholder 「찾기」, 바꾸기 입력칸 placeholder 「바꿀 내용」, 버튼 「바꾸기」「모두 바꾸기」. 개수: 「3 / 12」 꼴(슬래시 앞뒤 공백 하나), 지금 결과가 아닐 때 「– / 12」(U+2013), 상한 「1000+」, 결과 없음 「결과 없음」, 틀린 정규식 「잘못된 정규식」, 입력이 비면 빈 문자열.
- aria-label·title(그대로): 「대소문자 구분」「단어 단위」「정규식」「이전 결과」「다음 결과」「바꾸기 펼치기」「닫기」. 토글과 ⇄ 는 `aria-pressed`.
- 토글 글자: `Aa`·`ab`·`.*`. 아이콘 버튼 글자 ↑ ↓ ⇄ × (빌더가 SVG 로 바꿔도 되지만 aria-label 은 위 그대로).
- 크기(스펙 「모양」 그대로): 띠 안쪽 여백 6px 10px, 줄 사이 6px, 입력칸 높이 26px·모서리 6px·왼쪽 안쪽 8px, 토글 22×20px(모서리 4px), 아이콘 버튼 24×24px(모서리 5px), 글자 버튼 높이 24px·좌우 10px, 개수 최소 폭 52px·12px 글자·`tabular-nums`, 요소 사이 4px. 입력칸 글꼴 `var(--editor-font)`, 크기 13px 고정.
- 개수 상한 1000. 상한은 표시에만 걸린다.
- 대비: 띠의 글자 4.5:1 이상, 토글·아이콘 테두리 3:1 이상, 다크·라이트 기본 테마 둘 다.
- 새 CSS 변수 이름(그대로): `--input-bg`, `--search-match`, `--search-match-current`, `--search-match-border`. `src/styles.css`(라이트·다크)와 `DEFAULT_VARIABLES`(`src/theme/vscode-theme.ts`)에 같은 값.
- 하지 않는 것: 워크스페이스 검색(⇧⌘F), 대용량 뷰어 검색칸, 검색 기록, 선택 안에서만 찾기.
- 디버그 앱은 언제나 `TOTE_DATA_DIR=<임시 폴더>`. `~/Tote` 는 건드리지 않는다. `~/Tote-dev`·`~/Library/Application Support/tote-dev` 는 사용자가 쓰고 있을 수 있으니 지우지 말고 작업 동안 바뀌지 않았는지로 판정한다(`docs/guides/development.md`).
- 화면(키보드·마우스)을 쓰는 확인은 이번 계획에서 하지 않는다. Task 6 이 목록만 쓴다.
- 테스트 보고는 실행 개수와 함께. 커밋 전에 `pnpm fmt`, `pnpm lint`, `pnpm typecheck`.

## Review Focus

1. 한글 조합 중 찾기 입력칸에서 Enter(조합 확정)를 누르면 다음 결과로 넘어가지 않고 조합만 끝난다 — Task 3 시험 `a composing Enter in the find field does not move`.
2. 찾기 입력칸에서 ⌘Z 는 입력칸 글자를 되돌리고 메모 본문은 그대로다 — Task 3 시험 `⌘Z in the find field leaves the memo alone`.
3. 빈 문자열에 맞는 정규식(`^`, `a*`)이 개수 세기를 멈추게 하지 않는다 — Task 2 시험 `an empty-matching regexp still finishes`.
4. VS Code 테마가 `input.background` 등을 주지 않으면 새 변수가 기본값으로 남는다 — Task 1 시험 `a theme without the find colours keeps the defaults`.
5. 띠가 열린 탭을 다른 칸으로 옮기거나 칸을 나눠도 띠가 그 탭을 따라가고 원래 칸에 남지 않는다 — Task 5 시험 `the bar follows its tab to another pane`.

---

### Task 1: 색 변수와 대비

**Files:**

- Create: `src/theme/contrast.ts`, `src/theme/contrast.test.ts`
- Modify: `src/styles.css`(`:root` 와 다크 블록), `src/theme/vscode-theme.ts`(`CSS_VARIABLES`, `DEFAULT_VARIABLES`), `src/theme/vscode-theme.test.ts`, `src/editor/setup.ts`(`appTheme`)

**Interfaces:**

- Produces: `contrastRatio(fg: string, bg: string, base?: string): number` — `#rgb`·`#rrggbb`·`#rrggbbaa`·`rgb()/rgba()`(쉼표·공백·`/` 알파) 를 읽는다. 반투명 `bg` 는 `base`(기본 `#ffffff`) 위에, 반투명 `fg` 는 합성된 `bg` 위에 섞은 뒤 WCAG 상대 휘도로 비를 낸다. 읽을 수 없는 색은 오류를 던진다.
- Produces: CSS 변수 `--input-bg`, `--search-match`, `--search-match-current`, `--search-match-border`.

- [ ] **Step 1: 실패하는 시험**
  - `contrast.test.ts`: `contrastRatio("#000000","#ffffff")` 가 21 (소수 둘째 자리), `contrastRatio("#ffffff","#ffffff")` 가 1, `contrastRatio("rgb(0 0 0 / 50%)","#ffffff")` 가 3.9 이상 4.1 이하, `contrastRatio("#zzz","#fff")` 가 던짐.
  - 같은 파일 `describe("search bar colours")`: 라이트·다크 `DEFAULT_VARIABLES` 각각에 대해 아래 짝이 기준 이상.
    - 4.5 이상: (`--fg`, `--input-bg`), (`--muted`, `--input-bg`), (`--muted`, `--panel-bg`), (`--fg`, `--panel-bg`), (`--danger`, `--panel-bg`), (`--fg`, `--search-match` 를 `--bg` 위에 합성), (`--fg`, `--search-match-current` 를 `--bg` 위에 합성).
    - 3 이상: (`--accent`, `--input-bg`) — 포커스·켜진 토글 테두리, (`--search-match-border`, `--bg`).
  - `vscode-theme.test.ts`: `a theme without the find colours keeps the defaults` — 빈 `colors` 로 `themeVariables` 를 부르면 네 변수가 `DEFAULT_VARIABLES` 값과 같다. 그리고 `input.background`·`editor.findMatchHighlightBackground`·`editor.findMatchBackground`·`editor.findMatchBorder` 를 주면 차례로 `--input-bg`·`--search-match`·`--search-match-current`·`--search-match-border` 가 그 값이 된다.
- [ ] **Step 2:** `pnpm test src/theme` 로 실패 확인.
- [ ] **Step 3: 구현**
  - `contrast.ts` 를 쓴다.
  - 네 변수의 라이트·다크 값을 정해 `styles.css` 와 `DEFAULT_VARIABLES` 양쪽에 같은 값으로 넣고, `CSS_VARIABLES` 에 위 VS Code 키로 잇는다. 값은 시험이 통과하는 것으로 고른다(다크 `--input-bg` 는 `--bg` 보다 어둡게, 라이트는 흰색 계열. `--search-match` 는 옅은 노랑 반투명, `--search-match-current` 는 진한 주황 반투명, `--search-match-border` 는 불투명 주황).
  - `appTheme` 에 `.cm-searchMatch`(바탕 `--search-match`), `.cm-searchMatch.cm-searchMatch-selected`(바탕 `--search-match-current`, `outline: 1px solid var(--search-match-border)`)를 넣는다.
- [ ] **Step 4:** `pnpm test` 전체 통과(개수 보고).
- [ ] **Step 5: 커밋** `feat: add the find colours and a contrast check`

### Task 2: 개수 세기

**Files:**

- Create: `src/editor/search-count.ts`, `src/editor/search-count.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export const COUNT_LIMIT = 1000;
  export interface MatchCount {
    total: number;
    capped: boolean;
    current: number | null;
  }
  export function countMatches(state: EditorState, query: SearchQuery, limit?: number): MatchCount;
  export function countLabel(query: SearchQuery, count: MatchCount | null): string;
  ```
  - `countMatches` 는 `query.getCursor(state)` 로 앞에서부터 세다가 `limit` 개를 넘는 결과를 하나 만나면 멈추고 `{ total: limit, capped: true }`. `current` 는 주 선택(`state.selection.main`)의 from·to 가 어느 결과와 정확히 같을 때 그 1부터 센 번호, 아니면 `null`. 결과가 `limit` 뒤에 있으면 `null`.
  - `countLabel`: `query.search === ""` → `""`, `!query.valid` → `"잘못된 정규식"`, `count.total === 0` → `"결과 없음"`, 그 밖에 `` `${current ?? "–"} / ${total}${capped ? "+" : ""}` ``. 틀린 정규식이면 `countMatches` 를 부르지 않는다(호출자가 `count` 로 `null` 을 넘긴다).

- [ ] **Step 1: 실패하는 시험** (`EditorState.create({ doc, selection })` 과 `new SearchQuery({...})` 로)
  - `"my my My"` 에서 `search: "my"` → total 3(대소문자 무시가 기본), `caseSensitive: true` → 2.
  - 선택이 두 번째 결과(3..5)와 같으면 `current` 2, 커서만 있으면 `null`.
  - `"a ".repeat(5000)` 에서 `search: "a"` → `{ total: 1000, capped: true }`, 선택이 0..1 이면 `current` 1, 선택이 4000번째 결과면 `null`.
  - `countLabel` 표: 빈 검색 `""`, `{search:"(", regexp:true}` → `"잘못된 정규식"`, 0개 → `"결과 없음"`, `{3,12,false}`·current 3 → `"3 / 12"`, current null → `"– / 12"`, capped current 17 → `"17 / 1000+"`.
  - `an empty-matching regexp still finishes`: 100 줄 문서에 `{search:"^", regexp:true}` 와 `{search:"a*", regexp:true}` 가 끝나고 total 이 `limit` 이하.
- [ ] **Step 2:** `pnpm test src/editor/search-count` 실패 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** 통과(개수 보고).
- [ ] **Step 5: 커밋** `feat: count find results up to a limit`

### Task 3: 검색 띠 — 찾기 줄

**Files:**

- Create: `src/editor/search-bar.ts`, `tests/e2e/search-bar.spec.ts`
- Modify: `src/editor/setup.ts`(`search({ top: true })` 를 `searchBar()` 로 바꾸고 `editorKeymap` 에 `searchBarKeymap` 을 `searchKeymap` 앞에), `src/styles.css`(띠 스타일, 클래스 접두사 `search-bar`)

**Interfaces:**

- Consumes: Task 1 변수, Task 2 `countMatches`·`countLabel`.
- Produces: `export function searchBar(): Extension`, `export const searchBarKeymap: readonly KeyBinding[]`(이 Task 에서는 빈 배열로 두고 Task 4 가 채움), 패널 루트 클래스 `.search-bar`, 찾기 줄 `.search-bar-find`, 찾기 입력칸 `input.search-bar-input[name=search][main-field=true]`, 토글 `button.search-bar-toggle[name=case|word|re]`, 개수 `.search-bar-count`, 버튼 `button[name=prev|next|replace-toggle|close]`.

- [ ] **Step 1: 실패하는 e2e** (`tests/e2e/pages/editor.html` 로 연다 — `tests/e2e/editor.spec.ts` 의 `open` 과 같은 방식. ⌘F 는 편집기 키라 `page.keyboard.press("Meta+f")` 로 누른다)
  - `⌘F opens the bar with the selected word`: 문서 `"my notes\nmy-app\nMySQL"`, 0..2 선택 후 ⌘F → `.search-bar` 보임, 입력칸 값 `my`, 입력칸 포커스, 개수 `1 / 3`.
  - `Enter and ⇧Enter step through the results`: Enter → `2 / 3`, Enter → `3 / 3`, ⇧Enter → `2 / 3`, 그리고 `window.view.state.selection.main` 이 그 결과 범위.
  - `typing recounts without moving`: 입력칸에 `notes` 를 쳐 넣으면 개수 `– / 1`(커서가 결과 위가 아님), 편집기 선택은 그대로.
  - `the toggles change the query`: `Aa` 누르면 `aria-pressed="true"` 이고 개수 `1 / 2`(대소문자 구분: `my`·`my`), `.*` 켜고 `(` 입력 → `잘못된 정규식` 이고 입력칸 `aria-invalid="true"`, 없는 말 → `결과 없음`.
  - `Esc closes the bar and gives the keys back`: Esc → `.search-bar` 없음, `.cm-content` 포커스, 선택은 마지막 결과 그대로.
  - `a composing Enter in the find field does not move`(Review Focus 1): 입력칸에 `isComposing: true` 인 `keydown` Enter 를 `dispatchEvent` 로 보낸 뒤 개수·선택이 그대로.
  - `⌘Z in the find field leaves the memo alone`(Review Focus 2): 입력칸에 `x` 를 친 뒤 ⌘Z → 입력칸 값에서 `x` 가 빠지거나(WebKit 기본 되돌리기) 그대로이되, `window.view.state.doc.toString()` 은 처음 문서와 같다.
  - `the bar's text meets the contrast floor`: 다크(`page.emulateMedia({ colorScheme: "dark" })`)와 라이트 각각에서 입력칸·개수·버튼의 계산된 `color` 와 그 바탕(`background-color`, 투명이면 띠 바탕)으로 `contrastRatio` 가 4.5 이상(시험 페이지에 `contrastRatio` 를 노출하거나 같은 식을 시험에 둔다).
- [ ] **Step 2:** `pnpm test:e2e tests/e2e/search-bar.spec.ts` 실패 확인.
- [ ] **Step 3: 구현** `searchBar()` = `search({ top: true, createPanel })` + 키 처리.
  - 패널은 `{ dom, top: true, mount, update }`. 입력은 `input` 이벤트마다 `setSearchQuery.of(new SearchQuery({...}))` 를 dispatch, `update` 에서는 `getSearchQuery(state)` 가 바뀌었으면(⌘F 가 선택을 넣었을 때) 입력칸·토글을 맞춘다. 개수는 `update` 에서 문서·선택·검색어 중 하나라도 바뀌었을 때만 `countMatches` 로 다시 센다(한 번 `requestAnimationFrame` 으로 미뤄도 된다 — 스펙이 맡김).
  - 찾기 입력칸 keydown: `event.isComposing` 이면 아무것도 안 함. Enter → `findNext`, ⇧Enter → `findPrevious`, Esc → `closeSearchPanel`(포커스는 CodeMirror 가 편집기로 돌려준다). ⌘G·⇧⌘G·F3 은 `searchKeymap` 에 있으니 건드리지 않는다.
  - ⇄ 버튼은 이 Task 에서 자리만 두고(Task 4 가 동작을 붙임) 숨기지 않는다.
- [ ] **Step 4:** e2e 이 파일 통과, `pnpm test`·`pnpm typecheck` 통과(개수 보고).
- [ ] **Step 5: 커밋** `feat: replace the find panel with the search bar`

### Task 4: 검색 띠 — 바꾸기 줄과 ⌥⌘F

**Files:**

- Modify: `src/editor/search-bar.ts`, `tests/e2e/search-bar.spec.ts`, `src/styles.css`, `src/shortcuts/keys.test.ts`(편집기 목록에 ⌥⌘F)

**Interfaces:**

- Produces: `export const openSearchWithReplace: Command`, `searchBarKeymap = [{ key: "Mod-Alt-f", run: openSearchWithReplace, preventDefault: true }]`, 바꾸기 펼침 StateField(이름은 빌더)와 `export const setReplaceOpen: StateEffectType<boolean>`, 바꾸기 줄 `.search-bar-replace`, 입력칸 `input.search-bar-input[name=replace]`, 버튼 `button[name=replace]`·`button[name=replace-all]`.

- [ ] **Step 1: 실패하는 시험**
  - e2e `⇄ shows the replace row and remembers it`: 처음엔 `.search-bar-replace` 안 보임, ⇄ 누르면 보이고 ⇄ 가 `aria-pressed="true"`, Esc 로 닫고 ⌘F 로 다시 열면 펼친 채.
  - e2e `⌥⌘F opens with the replace row`: 닫힌 상태에서 `Meta+Alt+f` → 띠와 바꾸기 줄이 보이고 포커스는 찾기 입력칸.
  - e2e `바꾸기 replaces the current result and moves on`: `"a a a"`, 찾기 `a`, 바꿀 내용 `b`, 「바꾸기」 → 문서 `"b a a"` 이고 선택이 다음 `a`. 바꾸기 입력칸에서 Enter 도 같은 동작.
  - e2e `모두 바꾸기 is one ⌘Z away`: 「모두 바꾸기」 → `"b b b"`, 편집기에 포커스를 두고 `Meta+z` 한 번 → `"a a a"`. 바꾸기 입력칸의 ⌘Enter 도 모두 바꾸기. (안 되돌아오면 `undoWithCursors` 를 고치는 것까지 이 Task — 스펙)
  - e2e `a regexp replace uses groups`: `.*` 켜고 찾기 `(a)`, 바꿀 내용 `[$1]`, 모두 바꾸기 → `"[a] [a] [a]"`.
  - `keys.test.ts`: `editorBindings()` 에 `CmdOrCtrl+Alt+F` 가 있다.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 구현. 「바꾸기」 = `replaceNext`, 「모두 바꾸기」 = `replaceAll`. 바꾸기 입력칸도 `input` 마다 `SearchQuery` 의 `replace` 를 갱신한다.
- [ ] **Step 4:** 통과(개수 보고). `pnpm test` 전체도.
- [ ] **Step 5: 커밋** `feat: add the replace row and ⌥⌘F`

### Task 5: 칸·탭·다시 읽기

**Files:**

- Modify: `src/editor/search-bar.ts`, `src/app/docs.ts`(`reload`), 필요하면 `src/app/controller.ts`
- Test: `tests/e2e/search-bar-app.spec.ts`(앱 페이지, `tests/e2e/helpers.ts` 의 `start`)

**Interfaces:**

- Consumes: Task 3·4.
- Produces: `export function carrySearch(from: EditorState): StateEffect<unknown>[]` — `from` 에 띠가 열려 있었으면 `setSearchQuery`(같은 검색어·옵션), 바꾸기 펼침, 띠 열림 effect 를 돌려준다. 닫혀 있었으면 `[]`.

- [ ] **Step 1: 실패하는 e2e**
  - `each tab keeps its own bar`: 탭 둘을 열고 첫 탭에서 ⌘F·검색어 `alpha`, 둘째 탭으로 가면 띠 없음, 첫 탭으로 돌아오면 띠와 `alpha`.
  - `two panes do not share a bar`: 칸을 나눠(메뉴 `split-pane`) 두 칸에 다른 메모, 왼쪽 칸에서 ⌘F → 오른쪽 칸 안에 `.search-bar` 없음.
  - `the bar follows its tab to another pane`(Review Focus 5): 띠가 열린 탭을 탭 메뉴/끌기로 다른 칸으로 옮기면 새 칸에 띠와 검색어가 있고 원래 칸에는 없다(끌기는 `tests/e2e/pane-drag.spec.ts` 의 방식).
  - `a reload keeps the bar open`: 띠를 연 탭의 파일을 가짜 백엔드에서 바깥 변경으로 바꿔(기존 외부 변경 시험의 방식 — `tests/e2e/memo.spec.ts`·`watch.spec.ts` 를 본뜸) 다시 읽히게 하면 띠가 열린 채이고 검색어·옵션·펼침이 그대로, 개수는 새 본문 기준.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** `carrySearch` 구현, `reload` 가 `setText` 뒤 `this.state = this.state.update({ effects: carrySearch(old) }).state` 로 옮긴다(old 는 `setText` 전의 state). 칸·탭이 이미 맞게 돈다면 그 시험은 고정용으로 남긴다.
- [ ] **Step 4:** 이 파일과 기존 e2e 전체 통과(개수 보고).
- [ ] **Step 5: 커밋** `feat: keep the search bar per tab and across a reload`

### Task 6: 문서와 화면 확인 목록

**Files:**

- Modify: `docs/superpowers/specs/2026-10-20-tote-notes-editor-search-bar-design.md`(만든 대로 다른 점이 있으면 고침), `docs/guides/development.md`(검색 띠 e2e 를 `editor.html` 에서 돌린다는 한 줄이 필요하면)
- Create: `docs/superpowers/reports/2026-10-20-tote-notes-editor-search-bar-smoke.md`

- [ ] **Step 1:** 스모크 문서에 사람·에이전트 화면 확인 목록을 쓴다. 각 항목에 절차와 기대값. 최소: 다크·라이트 기본 테마에서 띠 모양(시안 B 와 비교), VS Code 테마(Dark+ 등)를 골랐을 때 입력칸·결과 색, 실제 한글 입력기로 찾기 입력칸에 한글 치고 Enter, ⌥⌘F 가 실제 앱에서 메뉴에 먹히지 않고 띠를 여는지, 결과 수만 개 메모에서 타이핑 끊김.
- [ ] **Step 2:** 「다음 계획으로 넘기는 것」 절에 구현 중 미룬 것을 적는다.
- [ ] **Step 3: 커밋** `docs: list the search bar screen checks`
