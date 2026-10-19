# tote-notes 자유 분할·탭 끌어 떼어 내기·워크스페이스 고르개 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 칸을 가로·세로로 자유롭게 나누고, 탭을 끄는 동안 놓일 자리를 마스크로 보이며, 탭을 창 밖으로 끌어 새 창이나 다른 창으로 옮기고, 워크스페이스를 사이드바 맨 위 콤보박스로 고르게 한다.

**Architecture:** 칸 배치는 순수 TS 나눔 나무(`src/app/layout.ts`)가 정하고, 칸 DOM 은 지금처럼 `.panes` 아래 평평하게 두되 나무가 계산한 사각형으로 **절대 위치**를 준다(칸 요소를 다른 부모로 옮기지 않아 뷰어 iframe 이 다시 불리지 않는다). 세션 파일의 봉투(`{version: 2, windows}`)는 Rust 가 그대로 두고, 창 레이아웃 안만 나무 모양으로 바뀐다(옛 `panes` 배열도 읽는다). 창 밖 놓기는 기존 `tear_off_tab` IPC 에 놓은 화면 좌표를 더해, Rust 가 그 자리의 같은 워크스페이스 창으로 옮기거나 그 자리에 새 창을 연다.

**Tech Stack:** TypeScript(CodeMirror 6, Vite), Rust(Tauri 2.12), Vitest, Playwright(WebKit), cargo test.

**Spec:** `docs/superpowers/specs/2026-10-19-tote-notes-free-splits-and-tab-drag-design.md` (이어서 `docs/superpowers/specs/2026-10-16-tote-notes-panes-and-windows-design.md`, 코어 `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`)

## Global Constraints

- 문구(그대로): 빈 칸 안내 「새 메모를 만드세요」, 버튼 「새 메모」, 보조 문구 「메모 목록에서 메모를 열거나 ⌘N 을 누르세요」. 메뉴·탭 메뉴 「왼쪽으로 나누기」「오른쪽으로 나누기」「위로 나누기」「아래로 나누기」「위쪽 칸으로」「아래쪽 칸으로」. 고르개 명령 「새 워크스페이스…」「워크스페이스 열기…」.
- 단축키: 오른쪽으로 나누기 ⌘\ (`CmdOrCtrl+\\`, 지금의 `split-pane`), 아래로 나누기 ⇧⌘\ (`CmdOrCtrl+Shift+\\`), 칸 이동 ⌥⌘← → ↑ ↓, 워크스페이스 ⌃1~⌃9.
- 최소 칸 크기: 너비 `MIN_PANE_PX = 320`, 높이 `MIN_PANE_HEIGHT_PX = 160`.
- 구역 판정: 칸의 각 변에서 그 축 길이의 **1/4** 안이 그 변의 구역, 나머지는 가운데. 모서리는 가장 가까운 변, 같으면 왼쪽·오른쪽이 먼저.
- 마스크: `var(--accent)` 의 `color-mix(in srgb, var(--accent) 20%, transparent)`, 위치·크기 전환 100ms.
- 끌기 시작 거리: 지금의 `DRAG_START_PX = 4` 를 그대로 쓴다.
- 「한 메모는 한 자리에」: 끌어 옮기기·다른 창으로 옮기기는 언제나 옮기기다.
- 디버그 앱은 언제나 `TOTE_DATA_DIR=<임시 폴더>` 로 띄우고, 끝나면 `~/Tote-dev`·`~/Library/Application Support/tote-dev` 가 생기지 않았는지 본다. `~/Tote` 는 건드리지 않는다(`docs/guides/development.md`).
- 테스트 보고는 실행 개수와 함께 한다. 포맷·린트(`pnpm fmt`, `pnpm lint`, `cargo fmt`, `cargo clippy --all-targets -- -D warnings`)를 커밋 전에 돌린다.

## 이 계획이 정한 것 (설계와 다른 곳)

- **세션 파일 버전은 올리지 않는다.** 설계는 「버전 3」 이라 했지만 봉투 `{version: 2, windows}` 는 Rust 가 쓰고 창 레이아웃은 Rust 에게 불투명하다. 그래서 창 레이아웃만 `{ frame?, layout, focusedPane }` 로 바꾸고, 옛 모양 `{ panes, focusedPane }` 도 계속 읽는다. Rust `adopt_tab` 이 쓰는 옛 모양은 그대로 둔다. Task 10 이 설계 문서의 그 문장을 고친다.
- **칸 DOM 은 평평하게 두고 절대 위치로 놓는다**(위 Architecture).
- **창 밖 놓기는 `tear_off_tab` 에 인자 `at` 하나를 더한다.** 없으면 지금처럼 ⌥⌘N 식 계단 자리에 새 창, 있으면 그 자리의 창으로 옮기거나 그 자리에 새 창.

## Review Focus

1. **끌기 중 조합 중인 한글·막 친 글:** 조합 중에 탭을 끌어 가장자리에 놓아도 글은 그 메모에 남는다 → Task 5 시험 `a composition in progress lands in its memo before a drag splits`.
2. **나눈 뒤 창을 작게 줄임:** 칸이 최소보다 작아져도 모두 너비·높이 > 0 으로 보이고, 다시 켜도 배치가 같다 → Task 4 시험 `panes stay visible when the window is made smaller than their minimum`.
3. **옛 세션:** 옛 `panes` 배열 세션과 Rust `adopt_tab` 이 쓴 한 칸 레이아웃이 탭을 잃지 않고 나무로 읽힌다 → Task 3 시험 `reads the old panes row into a row split`, `reads the layout adopt_tab writes`.
4. **떠나는 중이거나 다른 워크스페이스인 창 위에 놓기:** 탭은 사라지지 않고 새 창으로 떼어진다 → Task 8 시험 `window_at skips leaving and other workspace windows`, Task 9 시험 `a tab dropped on a window of another workspace opens in a new window`.
5. **창 밖에서 Esc·취소:** 아무것도 바뀌지 않는다 → Task 9 시험 `Esc outside the window calls the drag off`.

---

### Task 1: 창 밖 포인터 이벤트 확인 (스파이크, 실제 앱)

설계의 전제를 실제 앱에서 확인한다. **코드는 커밋하지 않는다**(임시 로그 패치는 확인 뒤 되돌린다). 화면을 쓴다.

**Files:**

- Create: `docs/superpowers/reports/2026-10-19-tote-notes-tab-drag-outside-spike.md`

- [ ] **Step 1:** `src/ui/tab-bar.ts` 의 `follow` 에 임시로 `pointermove`·`pointerup`·`blur` 의 `clientX/Y`, `screenX/Y`, `window.screenX/Y`, `innerWidth/innerHeight` 를 `console.log` 하고 디버그 번들을 만든다(`pnpm tauri build --debug --config src-tauri/tauri.dev.conf.json`). 로그는 개발 도구 대신 `backend` 의 기존 로그 경로나 `eprintln` 으로 받을 수 있게 아무 IPC 로 보내도 된다.
- [ ] **Step 2:** `open --env TOTE_DATA_DIR=<임시>` 로 띄우고, 탭을 눌러 창 밖(데스크톱, 다른 앱 창 위, 다른 모니터)으로 끌어 놓는다. 다음을 표로 적는다: 창 밖에서도 `pointermove` 가 오는가, 창 밖에서 놓으면 `pointerup` 이 오는가, `blur` 가 오는가, `screenX/Y` 가 Tauri `frame_of` 의 논리 좌표(창 왼쪽 위 = `window.screenX/Y`)와 같은 좌표계인가(창 모서리에서 잰 값 둘을 비교), 다른 모니터에서도 맞는가.
- [ ] **Step 3:** 패치를 되돌리고(`git diff` 가 비어야 한다) 앱·임시 폴더를 정리하고 개발용 폴더 두 곳이 없는지 본다.
- [ ] **Step 4:** 보고서를 쓴다. 결론 한 줄: 「창 밖 끌기 가능 / 불가능」. 불가능하면 `worker_done` 대신 코디네이터에게 묻고 멈춘다(설계 「지켜야 할 제약」 마지막 줄).
- [ ] **Step 5:** 보고서만 커밋한다.

```bash
git add docs/superpowers/reports/2026-10-19-tote-notes-tab-drag-outside-spike.md
git commit -m "docs: record whether a tab drag keeps its pointer outside the window"
```

### Task 2: 나눔 나무 (순수 TS)

**Files:**

- Modify: `src/app/layout.ts` (전부 바꾼다. `canSplit/split/remove/resize` 와 `normalize` 재수출은 Task 4 가 쓰지 않게 될 때까지 남겨도 되지만, Task 4 끝에는 지운다)
- Test: `src/app/layout.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export type Axis = "row" | "column";
  export type Side = "left" | "right" | "top" | "bottom";
  export type Zone = Side | "center";
  export interface LeafNode {
    kind: "pane";
    id: string;
  }
  export interface SplitNode {
    kind: "split";
    axis: Axis;
    children: LayoutNode[];
    shares: number[];
  }
  export type LayoutNode = LeafNode | SplitNode;
  /** In fractions of the area (0..1) unless said otherwise. */
  export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
  }
  export interface Divider {
    path: number[];
    index: number;
    axis: Axis;
    rect: Rect;
  }
  export const MIN_PANE_PX = 320;
  export const MIN_PANE_HEIGHT_PX = 160;
  export function leaf(id: string): LeafNode;
  export function leafIds(root: LayoutNode): string[]; // depth first
  export function splitAt(root: LayoutNode, id: string, side: Side, newId: string): LayoutNode;
  export function removeLeaf(root: LayoutNode, id: string): LayoutNode; // root itself is never removed
  export function rectsOf(root: LayoutNode, area?: Rect): Map<string, Rect>;
  export function dividersOf(root: LayoutNode, area?: Rect): Divider[];
  export function resizeAt(
    root: LayoutNode,
    path: number[],
    index: number,
    deltaPx: number,
    areaPx: { width: number; height: number },
  ): LayoutNode;
  export function canSplitRect(rectPx: Rect, side: Side): boolean;
  export function dropZone(rectPx: Rect, x: number, y: number): Zone;
  export function neighbor(rects: Map<string, Rect>, id: string, side: Side): string | null;
  ```
- 규칙: `splitAt` 은 새 잎을 `id` 의 `side` 쪽에 둔다. `id` 의 부모가 같은 축이면 형제로 끼우고 `id` 의 몫을 반씩 나눈다. 아니면 `id` 자리에 새 가지(축 `left/right → row`, `top/bottom → column`, 몫 `[0.5, 0.5]`)를 만든다. `removeLeaf` 는 몫을 같은 가지의 앞 형제(맨 앞이면 뒤 형제)에게 주고, 자식이 하나 남은 가지는 그 자식으로 바꾸며, 같은 축 가지가 같은 축 부모 안에 남으면 펼쳐 합친다. `divider.path` 는 루트에서 그 가지까지의 자식 번호, `index` 는 경계 앞 자식 번호. `resizeAt` 은 경계 양쪽이 최소 크기(축에 따라 320/160) 아래로 줄지 않게 하고, 둘 다 이미 최소 미만이면 그대로 둔다. `neighbor` 는 `side` 쪽으로 붙어 있고(간격 최소) 다른 축으로 겹치는 칸 중 겹침이 가장 큰 것, 같으면 위·왼쪽 것.

- [ ] **Step 1: 실패하는 시험을 쓴다** (`src/app/layout.test.ts`, 옛 시험은 지운다)

```ts
const row = (children: LayoutNode[], shares: number[]): SplitNode => ({
  kind: "split",
  axis: "row",
  children,
  shares,
});
const col = (children: LayoutNode[], shares: number[]): SplitNode => ({
  kind: "split",
  axis: "column",
  children,
  shares,
});

test("splitting a lone pane to the right makes a row of two halves", () =>
  expect(splitAt(leaf("a"), "a", "right", "b")).toEqual(row([leaf("a"), leaf("b")], [0.5, 0.5])));
test("splitting down inside a row nests a column", () =>
  expect(splitAt(row([leaf("a"), leaf("b")], [0.5, 0.5]), "b", "bottom", "c")).toEqual(
    row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]),
  ));
test("splitting left along the same axis adds a sibling sharing the pane's share", () =>
  expect(splitAt(row([leaf("a"), leaf("b")], [0.5, 0.5]), "a", "left", "c")).toEqual(
    row([leaf("c"), leaf("a"), leaf("b")], [0.25, 0.25, 0.5]),
  ));
test("a removed pane's share goes to the one before it", () =>
  expect(removeLeaf(row([leaf("c"), leaf("a"), leaf("b")], [0.25, 0.25, 0.5]), "a")).toEqual(
    row([leaf("c"), leaf("b")], [0.5, 0.5]),
  ));
test("a branch left with one child becomes that child", () =>
  expect(
    removeLeaf(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]), "c"),
  ).toEqual(row([leaf("a"), leaf("b")], [0.5, 0.5])));
test("the last pane is never removed", () => expect(removeLeaf(leaf("a"), "a")).toEqual(leaf("a")));
test("rects cover the area", () => {
  const rects = rectsOf(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]));
  expect(rects.get("a")).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
  expect(rects.get("c")).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
});
test("leaf ids go depth first", () =>
  expect(leafIds(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]))).toEqual([
    "a",
    "b",
    "c",
  ]));
test("a boundary moves by the dragged pixels", () =>
  expect(
    resizeAt(row([leaf("a"), leaf("b")], [0.5, 0.5]), [], 0, 100, { width: 1000, height: 800 })
      .shares,
  ).toEqual([0.6, 0.4]));
test("a boundary stops where a pane would go under its minimum", () =>
  expect(
    resizeAt(row([leaf("a"), leaf("b")], [0.5, 0.5]), [], 0, 400, { width: 1000, height: 800 })
      .shares,
  ).toEqual([0.68, 0.32]));
test("a column boundary keeps 160px", () =>
  expect(
    resizeAt(col([leaf("a"), leaf("b")], [0.5, 0.5]), [], 0, 300, { width: 1000, height: 800 })
      .shares,
  ).toEqual([0.8, 0.2]));
test("a pane splits only when both halves keep the minimum", () => {
  expect(canSplitRect({ x: 0, y: 0, width: 640, height: 320 }, "right")).toBe(true);
  expect(canSplitRect({ x: 0, y: 0, width: 639, height: 320 }, "left")).toBe(false);
  expect(canSplitRect({ x: 0, y: 0, width: 640, height: 319 }, "bottom")).toBe(false);
});
test("zones are the outer quarters, the nearest side in a corner", () => {
  const r = { x: 0, y: 0, width: 400, height: 400 };
  expect(dropZone(r, 50, 200)).toBe("left");
  expect(dropZone(r, 200, 200)).toBe("center");
  expect(dropZone(r, 200, 350)).toBe("bottom");
  expect(dropZone(r, 380, 395)).toBe("bottom");
  expect(dropZone(r, 390, 390)).toBe("right");
});
test("the neighbour is the touching pane that overlaps most", () => {
  const rects = rectsOf(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]));
  expect(neighbor(rects, "a", "right")).toBe("b");
  expect(neighbor(rects, "c", "left")).toBe("a");
  expect(neighbor(rects, "b", "bottom")).toBe("c");
  expect(neighbor(rects, "a", "left")).toBeNull();
});
test("dividers sit on the boundaries", () =>
  expect(dividersOf(row([leaf("a"), col([leaf("b"), leaf("c")], [0.5, 0.5])], [0.5, 0.5]))).toEqual(
    [
      { path: [], index: 0, axis: "row", rect: { x: 0.5, y: 0, width: 0, height: 1 } },
      { path: [1], index: 0, axis: "column", rect: { x: 0.5, y: 0.5, width: 0.5, height: 0 } },
    ],
  ));
```

- [ ] **Step 2:** `pnpm test src/app/layout.test.ts` → 실패(내보내지 않은 이름).
- [ ] **Step 3:** 위 Interfaces 대로 구현한다. 부동소수 비교가 흔들리면 시험 값에 `toBeCloseTo` 를 쓰지 말고 구현에서 몫을 1e-9 로 반올림하지 않는다 — 시험의 값은 정확히 나오는 값이다.
- [ ] **Step 4:** `pnpm test src/app/layout.test.ts` → 통과(개수 적기). 아직 controller 가 옛 함수를 쓰면 `pnpm typecheck` 가 실패할 수 있다. 옛 함수를 이 파일에 남겨 통과시키고 Task 4 에서 지운다.
- [ ] **Step 5:** 커밋 `feat(layout): lay panes out as a split tree`.

### Task 3: 세션의 나무 모양

**Files:**

- Modify: `src/core/session.ts`, `src/app/session-sync.ts`
- Test: `src/core/session.test.ts`, `src/app/session-sync.test.ts`

**Interfaces:**

- Consumes: Task 2 `LayoutNode`, `Axis`, `leafIds`.
- Produces:
  ```ts
  export interface PaneSession {
    tabs: SessionTab[];
    activeTab: number;
  } // width: read and dropped
  export interface SessionSplit {
    axis: Axis;
    children: SessionNode[];
    shares: number[];
  }
  export type SessionNode = PaneSession | SessionSplit;
  export interface WindowSession {
    frame?: WindowFrame;
    layout: SessionNode;
    focusedPane: number;
  } // focusedPane: depth-first leaf index
  export function isSessionPane(node: SessionNode): node is PaneSession; // has a tabs array
  export function sessionPanes(node: SessionNode): PaneSession[]; // depth first
  ```
  `SessionFile` 은 `version: 2` 그대로. `parseWindowSession(value)` 가 새 모양과 옛 모양(`panes` 배열 + `width`)을 모두 읽는다. 옛 배열은 칸이 하나면 그 잎, 둘 이상이면 `row` 가지(몫 = `normalizeWidths(width들)`). 가지가 깨졌으면(축이 `row/column` 이 아님, `children` 이 배열이 아니거나 비었음) 그 안에서 찾은 탭을 모두 한 잎에 모은다(활성 탭 0). 자식 하나짜리 가지는 그 자식으로 줄인다. `focusedPane` 이 잎 수 밖이면 0.
- `SessionSync` 의 `SessionLayout` 은 `{ layout: LayoutNode; panes: ReadonlyMap<string, Pane>; focusedPane: number }`, `RestoredLayout` 은 `{ layout: SessionNode; focusedPane: number }` 를 그대로 돌려주고 controller(Task 4)가 잎마다 칸을 만든다. `build` 는 `LayoutNode` 의 잎 id 를 그 칸의 `PaneSession` 으로 바꿔 `layout` 을 만든다.

- [ ] **Step 1: 실패하는 시험** (`src/core/session.test.ts` 에 더한다)

```ts
test("reads the old panes row into a row split", () => {
  const w = parseWindowSession({
    panes: [
      { tabs: [memoTab("a")], activeTab: 0, width: 3 },
      { tabs: [memoTab("b")], activeTab: 0, width: 1 },
    ],
    focusedPane: 1,
  });
  expect(w.layout).toMatchObject({ axis: "row", shares: [0.75, 0.25] });
  expect(sessionPanes(w.layout).map((p) => p.tabs.length)).toEqual([1, 1]);
  expect(w.focusedPane).toBe(1);
});
test("reads the layout adopt_tab writes", () => {
  const w = parseWindowSession({
    panes: [{ tabs: [memoTab("a")], activeTab: 0, width: 1 }],
    focusedPane: 0,
  });
  expect(isSessionPane(w.layout)).toBe(true);
});
test("reads a nested layout back as written", () => {
  const layout = {
    axis: "row",
    shares: [0.5, 0.5],
    children: [
      { tabs: [memoTab("a")], activeTab: 0 },
      {
        axis: "column",
        shares: [0.5, 0.5],
        children: [
          { tabs: [], activeTab: -1 },
          { tabs: [memoTab("c")], activeTab: 0 },
        ],
      },
    ],
  };
  expect(parseWindowSession({ layout, focusedPane: 2 })).toEqual({ layout, focusedPane: 2 });
});
test("a broken branch keeps its tabs in one pane", () => {
  const w = parseWindowSession({
    layout: {
      axis: "diagonal",
      children: [
        { tabs: [memoTab("a")], activeTab: 0 },
        { tabs: [memoTab("b")], activeTab: 0 },
      ],
    },
    focusedPane: 0,
  });
  expect(sessionPanes(w.layout)).toEqual([{ tabs: [memoTab("a"), memoTab("b")], activeTab: 0 }]);
});
test("shares that do not add up are normalised and a lone child replaces its branch", () => {
  const w = parseWindowSession({
    layout: {
      axis: "column",
      shares: [2, 2],
      children: [
        { tabs: [], activeTab: -1 },
        { axis: "row", shares: [1], children: [{ tabs: [memoTab("x")], activeTab: 0 }] },
      ],
    },
    focusedPane: 9,
  });
  expect(w.layout).toMatchObject({ axis: "column", shares: [0.5, 0.5] });
  expect(isSessionPane((w.layout as SessionSplit).children[1])).toBe(true);
  expect(w.focusedPane).toBe(0);
});
```

(`memoTab` 은 이 시험 파일의 기존 탭 만들기 도우미를 쓴다. 없으면 그 파일의 유효한 탭 JSON 하나를 함수로 감싼다.)
`src/app/session-sync.test.ts` 의 `widths` 기대값은 `layout` 기대값으로 바꾸고, `build` 가 `row[a, column[b, c]]` 를 같은 모양의 `SessionNode` 로 쓰는 시험 `builds the layout tree with each pane's tabs` 를 더한다.

- [ ] **Step 2:** `pnpm test src/core/session.test.ts src/app/session-sync.test.ts` → 실패.
- [ ] **Step 3:** 구현한다. `tests/e2e/helpers.ts` 의 `paneSession(tabs, focusedPane)` 은 **옛 모양을 그대로 만든다**(옛 세션 읽기를 e2e 가 계속 지나가게 한다). 새 도우미 `layoutSession(layout: object, focusedPane: number): string` 을 더한다. `sessionPane(page, window, pane)` 은 새 모양에서 깊이 우선 `pane` 번째 잎을 돌려준다. `src/backend/fake-hub.ts` 의 `adopt` 와 Rust `adopt_tab` 은 옛 모양 그대로 둔다.
- [ ] **Step 4:** 두 시험 파일 통과(개수). `pnpm typecheck` 는 Task 4 전까지 controller 에서 실패할 수 있다 — 이 태스크는 controller 를 고치지 않으므로, typecheck 실패가 controller·`session-sync` 소비처뿐인지 확인하고 보고에 적는다.
- [ ] **Step 5:** 커밋 `feat(session): keep a window's panes as a layout tree and read the old row`.

### Task 4: 칸을 나무로 그리고 나누기·닫기·이동·경계 끌기

**Files:**

- Modify: `src/app/controller.ts`, `src/app/pane.ts`, `src/styles.css`, `src-tauri/src/app/menu.rs`, `src/app/layout.ts`(옛 함수 지우기)
- Test: `tests/e2e/panes.spec.ts`, `src-tauri/src/app/menu.rs` 의 기존 시험(있으면)

**Interfaces:**

- Consumes: Task 2 전부, Task 3 `SessionLayout`/`RestoredLayout`/`sessionPanes`.
- Produces (controller):
  ```ts
  private layout: LayoutNode;                       // replaces widths
  splitPane(side?: Side, doc?: Doc | null): Promise<void>; // default "right", the focused pane's active tab
  focusPane(side: Side): void;
  closePane(pane: Pane): void;                      // share goes per removeLeaf; focus goes to the first leaf of the subtree that took the share
  layoutPanes(): void;                              // positions every .pane and .pane-divider from rectsOf/dividersOf
  ```
  `PaneHost.panes` 는 잎 순서(깊이 우선)의 칸 목록으로 남긴다. 칸의 id 는 `Pane` 의 기존 이름(`"pane-N"`)을 쓴다.
- 메뉴(Rust, `menu.rs` 보기 메뉴): `split-pane` 문구를 「오른쪽으로 나누기」 로, 새 항목 `split-pane-down` 「아래로 나누기」 `CmdOrCtrl+Shift+\\`, `focus-pane-up` 「위쪽 칸으로」 `Alt+CmdOrCtrl+Up`, `focus-pane-down` 「아래쪽 칸으로」 `Alt+CmdOrCtrl+Down`. controller `onMenu` 에 세 id 를 더한다.
- 그리기: `.panes` 는 `position: relative`, 각 `.pane` 은 `position: absolute` 로 `left/top/width/height` 를 `%` 로 받는다. 칸 사이 1px 선은 `.pane` 의 테두리로 그리고, `.pane-divider` 는 경계 위에 놓인 6px 짜리 투명 손잡이(`.row` 는 `col-resize`, `.column` 은 `row-resize`)다. 칸 요소는 처음 붙인 뒤 다른 부모로 옮기지 않는다.

- [ ] **Step 1: 실패하는 시험** (`tests/e2e/panes.spec.ts` 에 더한다. 기존 시험 중 좌우 배열을 단언하는 것은 같은 뜻의 새 단언으로 고친다)
  - `⇧⌘\ splits the focused pane downwards`: `menu(page, "split-pane-down")` 뒤 두 칸의 `boundingBox` 가 x 같고 y 가 다르며, 아래 칸이 포커스와 활성 탭을 갖는다.
  - `panes split both ways come back after a restart`: 오른쪽으로 나눈 뒤 오른쪽 칸을 아래로 나누고 재시작하면 칸 셋의 상대 위치(왼쪽 하나, 오른쪽 위·아래)가 같다. `sessionPane` 으로 탭도 확인한다.
  - `⌥⌘↑ and ⌥⌘↓ move the focus between stacked panes`.
  - `a horizontal boundary drags and keeps 160px`: 가로 경계를 아래 칸이 160px 미만이 될 만큼 끌면 아래 칸 높이 ≥ 160.
  - `closing a pane gives its room to the pane before it`: 칸 셋 중 가운데 칸을 비우고 닫으면 남은 둘이 영역을 다 덮는다(너비 합 = 영역 너비 ±2px).
  - `panes stay visible when the window is made smaller than their minimum` (Review Focus 2): 칸 넷(2×2)을 만든 뒤 `page.setViewportSize({ width: 500, height: 300 })` → 모든 `.pane` 의 너비·높이 > 0, 다시 크게 하면 몫이 처음과 같다.
  - `the old right-edge drop target is gone`: `.pane-drop-edge` 가 없다.
- [ ] **Step 2:** `pnpm test:e2e tests/e2e/panes.spec.ts` → 새 시험 실패.
- [ ] **Step 3:** 구현한다. `widths`·`areaWidth`·`mountPane` 의 이웃 찾기·`divider()`·`openPaneAfter`·`moveTabToNewPane`·`DROP_EDGE_PX`·`.pane-drop-edge` 를 나무 기반으로 바꾸거나 지운다(조사에서 나온 좌우 가정 자리: controller 의 `restoreSession`, `syncPanes`, `syncWidths`, `focus-pane-left/right`, `close-tab` 의 `panes.length > 1`). 나눌 수 없으면 지금의 `TOO_NARROW_TO_SPLIT` 를 띄운다(위·아래는 높이로 판정). 창 크기가 바뀌면 `layoutPanes` 를 다시 부른다(`%` 라 대개 저절로 맞는다).
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, `cargo test`, `pnpm test:e2e` 전체 통과(개수). `pane-drag.spec.ts` 의 오른쪽 가장자리 시험은 Task 5 가 바꾸므로 여기서 실패하면 그 시험만 `test.fixme` 로 두지 말고 이 태스크에서 「가운데에 놓기」 단언으로 바꾼다.
- [ ] **Step 5:** 커밋 `feat(panes): split panes both ways and lay them out from the tree`.

### Task 5: 끌기 구역과 마스크

**Files:**

- Modify: `src/app/controller.ts`(`dragTab`, `dropTarget`), `src/ui/tab-bar.ts`, `src/styles.css`
- Test: `tests/e2e/pane-drag.spec.ts`

**Interfaces:**

- Consumes: Task 2 `dropZone`, `canSplitRect`, `splitAt`; Task 4 `splitPane`·`layoutPanes`·`closePane`.
- Produces:
  ```ts
  type DropTarget = { pane: Pane; index: number } | { pane: Pane; zone: Zone } | null;
  ```
  탭 바 위면 `{pane, index}`(지금처럼 끼울 자리 표시, 마스크 없음), 칸 몸통 위면 `{pane, zone}`. 나눌 수 없는 쪽 구역은 `"center"` 로 바꾼다. 끌던 탭이 그 칸의 유일한 탭이고 자기 칸 가장자리면 `null`(마스크 없음, 놓아도 아무 일 없음).
- 마스크: `.panes` 안 하나뿐인 `.drop-mask`(절대 위치). `center` 면 칸 전체, 변이면 그쪽 절반. `left/top/width/height` 를 `transition: 100ms` 로 옮긴다. 끌기가 끝나면 지운다.
- 놓기: `center` → 그 칸의 마지막 탭으로 `moveTab`. 변 → `splitAt` 으로 새 칸을 그쪽에 만들고 탭을 옮긴다. 원래 칸이 비면 닫힌다(설계 「탭을 다 끌어 낸 칸은 닫힌다」, 창의 마지막 칸은 남는다).

- [ ] **Step 1: 실패하는 시험** (`pane-drag.spec.ts` 의 로컬 `drag()` 도우미를 쓴다)
  - `the mask covers the half a drop on the right edge would take`: 칸 하나에 탭 둘, 탭을 칸 몸통 오른쪽 1/8 지점까지 끌고(놓지 않고) `.drop-mask` 의 boundingBox 가 칸 오른쪽 절반(±2px).
  - `the mask covers the whole pane in the middle` 및 놓으면 그 칸 마지막 탭이 된다.
  - `dropping on the bottom edge stacks a new pane below`: 놓은 뒤 칸 둘, 아래 칸에 그 탭, 위 칸에 나머지.
  - `dropping on the top edge of another pane splits that pane`: 칸 둘(좌우)에서 왼쪽 탭을 오른쪽 칸 위쪽 가장자리에 놓으면 오른쪽 칸이 위·아래로 나뉘고 위 칸에 그 탭.
  - `a pane emptied by a drag closes`: 탭 하나뿐인 칸의 탭을 다른 칸 가운데 놓으면 칸 수가 줄고 남은 칸들이 영역을 덮는다.
  - `a side too small to split shows the whole pane instead`: 뷰포트를 칸 너비 600px 이 되게 해 오른쪽 가장자리로 끌면 마스크가 칸 전체.
  - `a lone tab over its own pane's edge shows no mask and stays`.
  - `a composition in progress lands in its memo before a drag splits` (Review Focus 1): 기존 조합 시험 도우미로 조합 중인 글을 두고 탭을 아래 가장자리에 놓으면 그 메모 본문에 조합한 글이 있다.
  - 기존 `Esc calls the drag off` 시험이 마스크도 사라지는지 단언하게 고친다.
- [ ] **Step 2:** `pnpm test:e2e tests/e2e/pane-drag.spec.ts` → 새 시험 실패.
- [ ] **Step 3:** 구현한다.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, `pnpm test:e2e` 전체 통과(개수), `pane-drag.spec.ts` `--repeat-each=5` 통과.
- [ ] **Step 5:** 커밋 `feat(panes): show where a dragged tab lands and split on the edges`.

### Task 6: 빈 칸 안내와 탭 바 빈자리 더블클릭

**Files:**

- Modify: `src/app/pane.ts`(`EMPTY_PANE`, `showEmptyText`, `PaneHost`), `src/app/surface.ts`(`showEmpty`), `src/ui/tab-bar.ts`, `src/app/controller.ts`, `src/styles.css`
- Test: `tests/e2e/panes.spec.ts`, `src/ui/tab-bar.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // pane.ts
  export const EMPTY_TITLE = "새 메모를 만드세요";
  export const EMPTY_NEW_MEMO = "새 메모";
  export const EMPTY_HINT = "메모 목록에서 메모를 열거나 ⌘N 을 누르세요";
  // PaneHost
  newMemoIn(pane: Pane, at: "after-active" | "end"): Promise<void>;
  // surface.ts
  showEmpty(view: { title: string; hint: string; action: { label: string; run: () => void } }): void;
  // tab-bar.ts actions
  newTab(): void;   // a double click on the bar itself, not on a tab
  ```

  빈 칸은 칸 수와 상관없이 같은 안내를 보인다(옛 `EMPTY_PANE` 와 「⌘N 으로 새 메모를 만드세요」 기본 문구는 없앤다). 버튼은 `newMemoIn(pane, "after-active")`(빈 칸이라 끝과 같다), 더블클릭은 `newMemoIn(pane, "end")`. 둘 다 그 칸에 포커스를 준다. `⌘N` 은 지금처럼 포커스된 칸의 활성 탭 뒤에 연다.

- [ ] **Step 1: 실패하는 시험**
  - `an empty pane says how to start and its button makes a memo there`: 칸 둘 중 빈 칸에 세 문구가 보이고, 「새 메모」 를 누르면 그 칸에 탭 하나·편집기 포커스, 다른 칸은 그대로.
  - `a window's only pane shows the same help`.
  - `a double click on the tab bar's free space opens a new memo as the last tab`: 탭 둘(활성은 첫째) 칸의 탭 바 빈자리(마지막 탭 오른쪽 20px)를 `dblclick` → 탭 셋, 새 탭이 셋째이고 활성.
  - `a double click on a tab opens nothing`.
  - `the help never shows over a viewer or an open memo`(빈 칸만).
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현. **Step 4:** 전체 통과(개수). **Step 5:** 커밋 `feat(panes): help an empty pane start a memo and open one on a double click`.

### Task 7: 워크스페이스 고르개 (띠를 대신한다)

**Files:**

- Create: `src/ui/workspace-switcher.ts`, `src/ui/workspace-switcher.test.ts`, `tests/e2e/switcher.spec.ts`
- Delete: `src/ui/rail.ts`, `src/ui/rail.test.ts`, `tests/e2e/rail.spec.ts`(시험 뜻은 옮긴다)
- Modify: `src/ui/sidebar.ts`, `src/app/controller.ts`, `src/styles.css`

**Interfaces:**

- Produces:

  ```ts
  export interface SwitcherItem {
    name: string;
    path: string;
    current: boolean;
    dot: boolean;
  }
  export function switcherItems(list: WorkspaceListItem[], currentPath: string): SwitcherItem[]; // was railItems, same order and rules, no label
  export function switcherShortcut(
    event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">,
  ): number | null; // was railShortcut
  export class WorkspaceSwitcher {
    readonly el: HTMLElement; // .ws-switcher
    constructor(actions: { pick(item: SwitcherItem): void; create(): void; open(): void });
    render(items: SwitcherItem[]): void;
    get isOpen(): boolean;
    close(): void;
  }
  ```

  `Sidebar` 생성자는 `(switcher, memoList, search)` 로, `switcher.el` 을 맨 위에 둔다(검색 패널일 때도 남는다). DOM: 버튼 `.ws-switcher-button[aria-haspopup=listbox][aria-expanded]` 에 지금 이름과 「▾」, 펼치면 `.ws-switcher-list[role=listbox]` 안에 `.ws-switcher-item[role=option]`(현재는 `.current` + `aria-selected=true` + 체크, 다른 창이 보이면 `.ws-switcher-dot`), 구분선, `.ws-switcher-command` 둘(「새 워크스페이스…」 → `create`, 「워크스페이스 열기…」 → `open`). 키보드: 펼친 동안 ↑↓ 로 고르고 Enter 로 정하고 Esc·바깥 클릭으로 닫는다. 버튼의 `mousedown` 은 `preventDefault` 해 편집기 포커스를 뺏지 않는다(지금의 띠와 같은 까닭 — 「떠나는 중」 포커스 복귀). controller 의 `pick` 은 지금의 `switchTo`, `create` 는 `newWorkspace`, `open` 은 `showPicker`. ⌃1~⌃9 는 `switcherItems` 순서. `body` 그리드의 48px 열을 지운다.

- [ ] **Step 1: 실패하는 시험**
  - 단위: `rail.test.ts` 의 네 시험을 이름만 바꿔 옮긴다.
  - e2e: `rail.spec.ts` 의 26개 시험을 같은 뜻으로 `switcher.spec.ts` 에 옮긴다. 띠 클릭은 「고르개를 펼쳐 항목 고르기」 도우미 `pickWorkspace(page, name)` 로, `.rail-item.current` 는 버튼 이름·`.current` 항목으로, `.rail-dot` 는 `.ws-switcher-dot` 로, `.rail-add` 는 「새 워크스페이스…」 로 바꾼다. 더하는 시험: `the switcher sits above the title filter and stays while searching`, `arrow keys and Enter switch, Esc closes without switching`, `「워크스페이스 열기…」 opens the picker`, `the rail is gone`(`.rail` 없음).
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현하고 옛 파일을 지운다. **Step 4:** `pnpm test`, `pnpm typecheck`, `pnpm test:e2e` 전체 통과(개수, `switcher.spec.ts` 개수가 26 + 4 인지). **Step 5:** 커밋 `feat(sidebar): switch workspaces from a picker above the title filter`.

### Task 8: 창 밖 놓기 — Rust 쪽

**Files:**

- Modify: `src-tauri/src/app/commands.rs`(`tear_off_tab`), `src-tauri/src/app/windows.rs`, `src-tauri/src/app/mod.rs`, `src/backend/types.ts`, `src/backend/tauri.ts`
- Test: `src-tauri/src/app/windows.rs`, `src-tauri/src/app/mod.rs` 의 시험 모듈

**Interfaces:**

- Produces:
  ```rust
  #[derive(Deserialize, Clone, Copy)] pub struct ScreenPoint { pub x: f64, pub y: f64 }
  #[derive(Serialize)] #[serde(rename_all = "camelCase")] pub enum TornOff { Moved, Window }
  // commands.rs
  pub async fn tear_off_tab(app, core, window, tab: String, tab_ref: TabRef, at: Option<ScreenPoint>) -> CmdResult<TornOff>;
  // windows.rs, pure
  pub struct WindowSpot<'a> { pub label: &'a str, pub frame: WindowFrame, pub same_workspace: bool, pub leaving: bool }
  pub fn window_at<'a>(spots: &[WindowSpot<'a>], at: ScreenPoint, from: &str) -> Option<&'a str>; // spots in recent-focus order; first that contains the point wins; skips `from`, other workspaces and leaving windows
  pub fn frame_at(at: ScreenPoint, source: WindowFrame) -> WindowFrame; // top-left at the point, the source's size; then `place`
  ```
  `at` 이 `None` 이면 지금과 같다(계단 자리 새 창, `Window`). `Some` 이면: 대상 창(`window_at`, 순서는 `core` 의 최근 포커스 순)이 있으면 같은 잠금 안에서 대상이 떠나는 중이 아닌지 다시 보고 `places.transfer(key, from, target)` 한 뒤 대상에 이벤트 `tote://adopt` 를 `{ tab, x, y }` 로 보낸다(`x, y` 는 대상 창 왼쪽 위 기준 논리 좌표 = 화면 좌표 − 대상 `frame_of` 의 x·y; 이 앱의 창은 내용이 제목 표시줄까지 덮으므로 그대로 내용 좌표다). 그리고 `Moved`. 없으면 `near = place(frame_at(at, frame_of(window)), monitors)` 로 `WindowPlan::Tab` 새 창, `Window`. 화면 좌표가 Task 1 보고와 다른 좌표계면 그 보고의 변환을 쓴다.
- TS: `tearOffTab(tab: string, ref: TabRef, at?: { x: number; y: number }): Promise<"moved" | "window">`, `onAdopt(handler: (tab: string, x: number, y: number) => void): Promise<() => void>`.

- [ ] **Step 1: 실패하는 시험** (Rust)
  - `window_at_picks_the_most_recent_window_under_the_point`: 겹친 두 창 중 앞 것.
  - `window_at_skips_leaving_and_other_workspace_windows` (Review Focus 4): 점 아래에 떠나는 중인 창, 다른 워크스페이스 창, 보내는 창 자신만 있으면 `None`.
  - `frame_at_puts_the_top_left_at_the_point_with_the_source_size`.
  - `a_tab_moved_to_another_window_belongs_to_it`: `AppCore` 시험 도우미로 두 창을 열고 옮긴 뒤 `key_for`/소유가 대상 창이다. 대상이 떠나는 중이면 `transfer` 하지 않는다.
- [ ] **Step 2:** `cargo test` → 실패. **Step 3:** 구현(이벤트 이름은 `tote://adopt`). **Step 4:** `cargo test`(개수), `cargo clippy --all-targets -- -D warnings`, `pnpm typecheck`(가짜 백엔드가 새 시그니처를 맞추게 최소로 고친다 — 동작은 Task 9). **Step 5:** 커밋 `feat(windows): move a tab dropped outside its window to the window there or a new one`.

### Task 9: 창 밖 놓기 — 화면과 가짜 백엔드

**Files:**

- Modify: `src/ui/tab-bar.ts`(`follow`, `TabDrag`), `src/app/controller.ts`(`dragTab`, `tearOff`, adopt 받기), `src/backend/fake.ts`, `src/backend/fake-hub.ts`, `src/styles.css`
- Test: `tests/e2e/tear-off.spec.ts`, `tests/e2e/windows.spec.ts`

**Interfaces:**

- Consumes: Task 8 `tearOffTab(…, at)`, `onAdopt`.
- Produces:
  ```ts
  export interface TabDrag { over(x: number, y: number): void; drop(x: number, y: number, screenX: number, screenY: number): void; cancel(): void }
  // controller
  tearOff(doc: Doc, at?: { x: number; y: number }): Promise<boolean>;
  adoptTab(tab: SessionTab, x: number, y: number): Promise<void>; // opens it as the last tab of the pane under (x, y), else the focused pane
  ```
  포인터가 창 안(`0 ≤ clientX < innerWidth`, `0 ≤ clientY < innerHeight`)이면 Task 5 그대로. 밖이면 마스크를 숨기고 끄는 탭에 `.dragging-out`(흐리게)을 준다. 밖에서 놓으면 `tearOff(doc, {x: screenX, y: screenY})` — 저장·「떠나는 중」 순서는 지금의 `tearOff` 그대로이고 실패하면 탭이 남고 까닭을 알린다. 창 밖에서 `blur` 가 오면(Task 1 보고에 따라) 취소가 아니라 끌기를 이어 가야 하면 그렇게 고친다. 받는 창은 `onAdopt` 로 탭을 받아 `adoptTab` 한다(세션 복원의 탭 만들기를 쓴다).
- 가짜: `fakeData.dropTargets?: { label: string; x: number; y: number; width: number; height: number; workspace?: string }[]`. `tearOffTab(tab, ref, at)` 은 `at` 이 어느 대상 안이고 그 대상이 같은 워크스페이스면(허브 모드) 허브 이벤트 `{ type: "adopt"; to: label; tab; x; y }` 를 보내고 `"moved"`, 아니면 지금의 떼어 내기 + `data.tornOff` 에 `at` 기록, `"window"`. 받는 페이지는 허브 이벤트를 `onAdopt` 로 넘긴다.
- Playwright 가 WebKit 에서 뷰포트 밖으로 마우스를 옮길 수 없으면, 시험은 `window.__tote` 류 기존 시험 훅(없으면 `tests/e2e/globals.d.ts` 에 하나 더한다)으로 `TabDrag` 를 직접 몰아도 된다. 그 경우 보고에 그 사실과 훅 이름을 적는다.

- [ ] **Step 1: 실패하는 시험**
  - `a tab dropped outside every window opens in a new window there`: `data.tornOff[0].at` 이 놓은 화면 좌표, 원래 창에서 탭이 빠짐.
  - `a tab dropped on another window of the workspace joins it`(허브, `windows.spec.ts`): 두 창, 첫 창 탭을 둘째 창 대상 안에 놓으면 둘째 창의 마지막 탭, 첫 창에서 빠짐, 글 그대로.
  - `a tab dropped on a window of another workspace opens in a new window` (Review Focus 4).
  - `Esc outside the window calls the drag off` (Review Focus 5): 밖에서 Esc → 탭·칸 그대로, `.dragging-out` 없음.
  - `dragging back over the tab bar and letting go keeps the tab where it was`.
  - `a tab whose save fails stays when dropped outside`(기존 저장 실패 도우미).
- [ ] **Step 2:** 실패 확인. **Step 3:** 구현. **Step 4:** `pnpm test`, `pnpm typecheck`, `pnpm test:e2e` 전체(개수), `tear-off.spec.ts`·`windows.spec.ts` `--repeat-each=5`. **Step 5:** 커밋 `feat(tabs): drag a tab out of the window to a new window or another one`.

### Task 10: 문서 맞추기와 화면 확인

**Files:**

- Modify: `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`(「창 배치」·「워크스페이스 띠」·「세션」), `docs/superpowers/specs/2026-10-16-tote-notes-panes-and-windows-design.md`(「하지 않는 것」·「칸 분할」·「워크스페이스 띠」 에 이 설계로 바뀌었다는 줄), `docs/superpowers/specs/2026-10-19-tote-notes-free-splits-and-tab-drag-design.md`(「세션」 의 버전 3 문장을 「이 계획이 정한 것」 대로)
- Create: `docs/superpowers/reports/2026-10-19-tote-notes-free-splits-smoke.md`

- [ ] **Step 1:** 세 스펙을 고친다(띠 → 고르개, 좌우만 → 자유 분할, 끌어 떼어 내기 있음, 세션 레이아웃 나무).
- [ ] **Step 2:** 디버그 번들을 만들어 화면에서 확인한다(사람에게 알린 뒤, `TOTE_DATA_DIR`). 표로 적는다: 네 방향 나누기·⇧⌘\·⌥⌘화살표, 마스크가 다섯 구역에서 보이는 자리, 가장자리 놓기로 나누기, 칸 비우면 닫힘, 빈 칸 안내·버튼, 탭 바 빈자리 더블클릭, 고르개 펼치기·고르기·⌃1, 탭을 창 밖 빈 곳에 놓기(새 창 자리), 같은 워크스페이스 다른 창 위에 놓기, 다른 모니터에 놓기, 재시작 뒤 나눈 모양.
- [ ] **Step 3:** 사람 확인 표를 쓴다(에이전트가 못 하는 것: 실제 손으로 끄는 느낌·마스크 애니메이션, 다른 앱 위에 놓기, 로그아웃 F-3·G-7 이월).
- [ ] **Step 4:** 정리(앱·임시 폴더, 개발용 폴더 두 곳 없음).
- [ ] **Step 5:** 커밋 `docs: bring the specs up to free splits and record the screen checks`.
