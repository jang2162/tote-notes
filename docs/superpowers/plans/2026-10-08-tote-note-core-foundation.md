# tote-note 코어 기반 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 아무 때나 막 적고, 꺼도 다시 켜면 그대로인 메모 앱의 첫 동작판을 만든다 — 워크스페이스와 메모 색인, 제목 자동 생성, 자동 저장과 ⌘S, 세션 유지, 편집기(하이라이트 없이), 메모 목록, `tote` CLI.

**Architecture:** 저장소 루트에 Tauri 2 앱을 둔다(`src/` 프론트엔드, `src-tauri/` Rust). Rust 는 디스크와 OS 를 다루는 모듈(`persist`·`appdata`·`workspace`·`session`·`cli`)과, 그것을 Tauri 에 잇는 `app` 으로 나눈다. 프론트엔드는 `Backend` 인터페이스 하나로만 Rust 에 닿는다. 같은 인터페이스의 메모리 구현(`FakeBackend`)으로 브라우저에서 UI 흐름을 시험한다.

**Tech Stack:** Tauri 2(Rust, `tauri-plugin-single-instance`, `tauri-plugin-dialog`), TypeScript + Vite(프레임워크 없음), CodeMirror 6(`@codemirror/*`), Vitest, Playwright(WebKit), `cargo test`.

**Spec:** `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`. 스파이크 결과는 `docs/superpowers/reports/2026-10-07-tote-note-spikes.md`(「한글 입력」·「편집 성능」 절). 실행자는 두 문서를 함께 읽는다.

## 이 계획의 위치

코어는 계획 셋으로 나눠 쓴다. 이 문서는 첫째다.

1. **코어 기반(이 문서)** — 워크스페이스·색인·제목 자동 생성, 저장(자동·⌘S·원자적 쓰기), 세션 유지, 편집기(하이라이트 없이), 메모 목록, `tote` CLI.
2. **확장과 화면** — 확장 로더, TextMate 하이라이트(Oniguruma, Worker), 테마, 언어 바꾸기·자동 인식, 뷰어 샌드박스와 `files` 모듈(토큰 URL), 마크다운 미리보기(세션의 편집·미리보기 모드 포함), 미디어 뷰어, 대용량 텍스트 뷰어, CSP, 설정 화면(워크스페이스 루트·테마·확장 목록), 언어 설정(`language-configuration.json`: ⌘/·괄호·단어 경계 — 이 계획에서 ⌘/ 는 동작하지 않는다). 컨트롤러를 나눌 때 세션 복원 테스트(스크롤 복원·세션에서 빠진 메모·`recover()` 의 셋째 시도)를 함께 두고 `ERROR_TEXT` 를 `Partial<Record<BackendErrorCode, string>>` 로 좁힌다. 뷰어 iframe 을 넣는 태스크는 CSP 와 뷰어 격리를 함께 끝낸다 — 외부 파일 명령(`read_external`·`save_external`·`import_file`)이 임의의 절대 경로를 읽고 쓰기 때문이다.
3. **안전망** — 백업, 워크스페이스 검색, 파일 감시와 외부 변경·충돌·삭제 배너, 저장 실패 재시도와 종료 경고(탭의 「저장 실패」 표시와 상태 표시줄의 저장 상태 포함), 워크스페이스 위치 다시 지정, 크기별 단계의 나머지, 성능 계측과 목표치, CLI 요청 실패(inbox·가져오기·`-w`)의 알림, Finder 에서 이름이 바뀐 열린 메모의 옛 이름 재생성, Dock 종료·로그아웃의 쓰고 닫기(`applicationShouldTerminate`), 시작 때 `listMemos` 가 실패하면 세션 쓰기를 막기, 복구로 메모 ID 가 바뀔 때 사이드바 활성 표시, 개발 번들의 「셸 명령 설치」가 다른 번들의 링크를 바꾸는 범위(앱 이름이 같을 때만 바꾸도록 좁힌다).

## 스펙이 이 계획에 넘긴 것과 이 계획이 정한 것

- **키맵(스펙 「편집기」 「세부 단축키는 구현 계획에서 확정한다」).** Task 11 의 표가 확정본이다.
- **첫 실행.** 워크스페이스가 하나도 없으면 루트 아래에 `메모` 워크스페이스를 만들어 연다. 이름을 묻는 화면 없이 바로 적을 수 있게 하기 위해서다.
- **`workspace.json` 에는 이름을 넣지 않는다.** 스펙의 「이름 = 폴더 이름」을 따른다. 이름을 두 곳에 두면 Finder 에서 폴더 이름을 바꿨을 때 둘이 갈라진다. 파일에는 `version` 과 `id` 만 둔다.
- **「메모 1MB」 는 UTF-16 길이(`doc.length`) 100만으로 잰다.** 키 입력마다 UTF-8 바이트 수를 세면 그것이 아끼려는 비용이 된다.
- **세션 파일 형식**은 프론트엔드가 정한다(Task 10 `SessionFile`). Rust 는 JSON 객체인지와 창 위치만 본다.
- **UI 테스트의 목은 IPC 가 아니라 `Backend` 인터페이스에 붙인다.** 스펙 「테스트」 의 「Vite 개발 서버에 Tauri IPC 목」 을 두 겹으로 나눴다. 화면 흐름은 같은 인터페이스의 메모리 구현(`FakeBackend`)으로 Playwright 에서 보고, 명령 이름·인자·헤더는 `invoke` 를 가로채는 Vitest(Task 9 `tauri.test.ts`)로 본다. Rust 명령과 실제로 이어지는지는 Task 8·15 의 실제 앱 확인이 본다.
- **개발 빌드는 데이터를 따로 쓴다.** 디버그 빌드는 `~/Library/Application Support/tote-dev`·`~/Tote-dev` 를 쓰고, `TOTE_DATA_DIR` 이 있으면 모든 것을 그 아래로 옮긴다. `pnpm app:dev` 는 식별자도 `dev.tote.note.dev` 로 바꾼다. 개발 실행이 설치된 tote 에 인자를 넘기거나 그 메모를 건드리지 않게 하기 위해서다.

## 이 계획이 다루지 않는 것

다음 계획의 몫이다. 이 계획의 코드가 이것들을 흉내 내지 않는다.

- 하이라이트·테마·확장·언어 바꾸기·언어 자동 인식, 뷰어·마크다운 미리보기·대용량 텍스트 뷰어(2번). 이 계획에서 텍스트가 아닌 파일과 100MB 가 넘는 파일은 「열 수 없음」 자리표시만 보인다.
- 파일 감시와 외부 변경 처리(3번). 이 계획은 창이 포커스를 얻을 때 메모 목록을 다시 읽는 것까지만 한다. 열려 있는 메모의 파일이 Finder 에서 이름이 바뀌거나 지워지면, 창이 포커스를 얻어 목록을 다시 읽은 뒤에 친 글은 옛 이름의 새 메모로 저장하고 알린다(Task 13 의 복구 — 입력을 잃지 않는 최소한의 장치). 그 전의 저장은 옛 이름 파일을 알림 없이 다시 만든다(3번 계획의 파일 감시가 고친다).
- 저장 실패의 5초 재시도와 종료 경고(3번). 이 계획은 상태 표시줄에 오류를 보이고, 다음 편집 때와 탭·창을 닫을 때 다시 저장한다. 탭 닫기는 계속 실패하면 탭을 남긴다. 계속 실패하는 채로의 ⌘Q 를 막는 것은 3번의 종료 경고다.
- 콜드 스타트·세션 복원·검색의 목표치와 계측(3번).
- **Dock 의 「종료」·로그아웃으로 끄는 경우.** 이 경로는 macOS 의 `terminate:` 로 바로 끝나서 「쓰고 닫기」 신호(Task 8)를 거치지 않는다. 그때 지켜 주는 것은 자동 저장 간격(0.5초)과 창이 포커스를 잃을 때의 즉시 저장이다. Task 15 스모크에서 실제 손실을 확인하고, 고치는 것은 3번 계획이다(`applicationShouldTerminate`).

## Global Constraints

모든 태스크의 요구 사항에 아래가 포함된다. 값은 스펙에서 그대로 옮겼다.

- 플랫폼은 macOS 먼저다. 경로·하드링크·CLI 설치·앱 데이터 위치처럼 OS 에 기대는 코드는 Rust 모듈 경계 안(`appdata`, `cli`, `persist`)에 가둔다.
- 앱 셸 Tauri 2, 프론트엔드 TypeScript, 백엔드 Rust, 편집기 CodeMirror 6.
- **파일 내용은 JSON 문자열이 아니라 Tauri 2 바이너리 IPC 로 주고받는다.** 이름·경로는 퍼센트 인코딩한 헤더(`x-memo-id`, `x-path`, `x-file-name`)로 보낸다.
- **원자적 쓰기:** 같은 폴더의 임시 파일에 쓴 뒤 rename 한다. 파일을 제자리에서 고치지 않는다.
- 워크스페이스는 `.tote/workspace.json` 이 있는 폴더다. tote 가 만든 폴더만 연다. 평평하다 — 하위 폴더와 점(`.`)으로 시작하는 파일은 무시한다.
- 메모는 경로가 아니라 ID(UUID)로 식별하고, ID 는 `.tote/index.json` 에 둔다. 항목은 `file`, `autoTitle`, `language`(없으면 생략)다. 다른 앱이 넣은 파일은 새 ID 와 `autoTitle: false` 를 받는다.
- **제목 규칙:** 첫 번째 비어 있지 않은 줄에서 앞쪽 `#` 와 공백을 걷고, `/ \ : * ? " < > |` 와 제어 문자를 공백으로 바꿔 연속 공백을 하나로 줄인다. 앞쪽 `.` 은 걷는다. **60자**에서 자른다. 결과가 비면 `untitled`. 확장자는 그대로. 겹치면 ` 2`, ` 3` …. 타이핑할 때마다가 아니라 **커서가 첫 줄을 벗어날 때, 탭이 포커스를 잃을 때, 탭을 닫거나 앱을 끌 때** 바꾼다. 사용자가 이름을 바꾸면 `autoTitle: false`, 가져온 파일은 처음부터 `false`.
- **새 메모는 `.md`** 로 시작한다.
- **저장 간격:** 메모 1MB 이하 **0.5초**, 1MB 초과 **3초**. 탭이 포커스를 잃거나 앱을 끌 때는 즉시. 외부 파일은 ⌘S 로만 쓰고, 저장 전 수정분은 변화가 멈추고 **1초** 뒤 `buffers/` 에 경로·편집 시작 때 디스크 내용 해시·수정된 내용으로 보관한다. 저장하거나 버리면 지운다.
- **세션:** 기기별 `.tote/sessions/<기기 ID>.json`. 변화가 멈추고 **1초** 뒤에 쓰고, 창을 닫거나 앱을 끌 때는 즉시 쓴다. 복원할 때는 **활성 탭의 내용만** 읽는다. 외부 파일 항목에는 기기 ID 를 항상 기록한다.
- 비어 있는 새 메모의 탭을 닫으면 파일도 지운다. 저장 전 수정분이 있는 외부 파일의 탭을 닫을 때만 저장 / 버리기 / 취소를 묻는다. 앱을 끌 때는 묻지 않고 수정분을 보관한다.
- **인코딩:** UTF-8 만 편집한다(BOM 은 유지). 줄바꿈(LF/CRLF)은 파일의 것을 유지한다. UTF-8 로 읽을 수 없거나 앞 8KB 에 NUL 바이트가 있으면 「텍스트로 열 수 없음」. **100MB 를 넘는 파일은 편집기로 열지 않는다.**
- **한글 조합이 시작되면 선택을 주 선택 하나로 합친다**(스파이크 보고서 「한글 입력」 — WKWebView 에서 조합은 주 선택에만 들어간다).
- 기기 전용 데이터는 `~/Library/Application Support/tote/`(`machine.json`, `settings.json`, `state.json`, `buffers/`)에 둔다. 워크스페이스 루트 기본값은 `~/Tote`.
- `tote` CLI 의 동작은 스펙 「`tote` CLI」 절을 그대로 따른다. 폴더 인자는 거절하고 stderr 에 적은 뒤 종료 코드 1, 없는 `-w` 워크스페이스도 종료 코드 1, `--wait` 은 넣지 않는다.
- 주석·문서 규칙: `docs/guideline/base/03-comments.md`(「왜」를 남기고 코드를 되읽은 주석은 쓰지 않는다). 코드 주석은 영어(실험 앱 `spikes/lab` 과 같은 관례), 사용자에게 보이는 문구는 한국어.
- **커밋:** 경로를 명시해 stage 한다(`git add -A` 금지). 커밋 전에 `pnpm exec oxfmt <바꾼 파일>`, `pnpm exec oxlint --fix <바꾼 TS 파일>`, `cargo fmt --manifest-path src-tauri/Cargo.toml` 을 돌린다. 테스트 결과는 **실행된 개수**와 함께 보고한다(0개면 통과가 아니다).
- **포트:** Playwright 가 띄우는 Vite 서버는 `TOTE_E2E_PORT`(기본 1430)를 쓴다. 워크트리를 여럿 동시에 돌리면 워크트리마다 다른 값을 준다(`docs/guideline/base/08-shared-resources.md`). `tauri dev` 는 1420 고정이라 한 번에 한 워크트리에서만 띄운다.
- **에이전트가 앱을 띄울 때는 `TOTE_BACKGROUND=1` 과 `TOTE_DATA_DIR=<임시 폴더>`** 를 준다(디버그 빌드만). 사람의 화면을 빼앗지 않고, 사람의 메모를 건드리지 않는다.

## Review Focus

스펙이 암시하지만 태스크의 기본 테스트가 놓치기 쉬운 입력이다. 사람이 쓰다가 가장 먼저 부딪힐 것부터 적었다. 줄마다 그것을 고정하는 테스트를 소유 태스크에 넣었다.

1. **Finder 에서 이름이 바뀌거나 지워진 메모에 계속 타이핑한다.** 사람은 친 글이 사라지지 않기를 기대한다. 저장이 `unknown-memo` 로 실패하면 내용을 새 메모로 저장하고 알린다. Task 13 의 `recovers a memo whose file vanished` 가 고정한다.
2. **Finder 가 만든 한글 파일 이름(NFD)과 입력한 제목(NFC).** 같은 이름으로 보여야 하고, 같은 이름으로 겹쳐야 한다. Task 4 의 `a_title_that_differs_only_in_unicode_normalisation_counts_as_taken` 과 Task 12 의 `filterMemos` 테스트가 고정한다.
3. **실행 권한이 있는 스크립트나 심볼릭 링크를 외부 파일로 열어 ⌘S 한다.** 저장 뒤에도 실행 권한과 링크가 그대로여야 한다. Task 1 의 `keeps_the_executable_bit`·`writes_through_a_symlink_and_keeps_the_link` 와 Task 5 의 `saving_keeps_an_executable_script_executable` 이 고정한다.
4. **대화상자 입력칸에서 한글 조합을 Enter 로 확정한다.** 그 Enter 가 「확인」으로 처리되면 마지막 글자가 빠진 이름이 제출된다. Task 12 의 `Enter that finishes a composition does not submit` 이 고정한다.
5. **타이핑 직후 ⌘Q·창 닫기, 그리고 응답하지 않는 창.** 쓰고 나서 닫혀야 하고, 멈춘 창 하나가 종료를 막으면 안 된다. Task 7 의 `a_round_that_times_out_still_finishes` 와 Task 14 의 `a flush request writes pending edits and the title before answering` 이 고정한다.

---

## 파일 구조

```
package.json                     앱 의존성과 스크립트(루트 하나에 둔다 — post-checkout 의 pnpm install 이 그대로 설치한다)
index.html, vite.config.ts, tsconfig.json, playwright.config.ts
src/
  main.ts                        백엔드를 고르고 AppController 를 띄운다
  styles.css                     화면 배치와 색 변수
  backend/types.ts               Backend 인터페이스와 주고받는 값의 타입
  backend/tauri.ts               실제 앱의 Backend (invoke·이벤트·창)
  backend/fake.ts                메모리 Backend — 브라우저 미리보기와 UI 테스트
  core/names.ts                  splitName·basename
  core/codec.ts                  UTF-8·BOM·줄바꿈 읽고 쓰기
  core/title.ts                  제목 규칙
  core/scheduler.ts              키별 지연 쓰기(겹치지 않게, flush 가능)
  core/session.ts                세션 파일 형식과 읽기
  editor/setup.ts                CodeMirror 확장 묶음과 키맵
  editor/alt-mouse.ts            ⌥클릭 커서 추가, ⌥드래그 사각 선택
  editor/ime.ts                  조합 시작 때 주 선택만 남기기
  ui/dom.ts, ui/memo-list.ts, ui/tab-bar.ts, ui/status-bar.ts, ui/dialogs.ts
  app/docs.ts                    탭 하나의 문서 — MemoDoc·ExternalDoc·가져오기
  app/controller.ts              창 하나 — 탭·편집기·세션·메뉴·쓰고 닫기
tests/e2e/                       Playwright (WebKit)
src-tauri/
  Cargo.toml, build.rs, tauri.conf.json, tauri.dev.conf.json, capabilities/default.json
  resources/tote                 셸 명령 스크립트(앱 번들 안 Resources/bin/tote)
  src/main.rs                    CLI 모드면 CLI 앞단, 아니면 앱
  src/lib.rs                     Tauri 빌더 연결
  src/persist/mod.rs             원자적 쓰기, 해시, JSON 파일
  src/persist/external.rs        외부 파일 열기·⌘S 저장·편집 시작 해시
  src/appdata.rs                 기기 데이터: 경로, machine/settings/state
  src/workspace/{mod,names,index,memo,ops}.rs
  src/session/mod.rs             세션 파일, 창 위치
  src/session/drafts.rs          외부 파일의 저장 전 수정분
  src/cli/{mod,front,install}.rs `tote` 인자 해석, 앱 넘기기, 설치
  src/app/mod.rs                 AppCore — 창↔워크스페이스, 포커스 순서, 대기 열기
  src/app/flush.rs               쓰고 닫기 라운드 장부
  src/app/{commands,windows,menu,lifecycle,requests}.rs   Tauri 연결
```

---

### Task 1: 앱 골격, 검사 파이프라인, 원자적 쓰기

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`, `.gitignore`, `lefthook.yml`, `mise.toml`
- Create: `index.html`, `vite.config.ts`, `tsconfig.json`, `src/main.ts`, `src/styles.css`, `src/core/names.ts`, `src/core/names.test.ts`
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.dev.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/.gitignore`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/persist/mod.rs`
- Create: `src-tauri/icons/` (`spikes/lab/src-tauri/icons/` 복사)

**Interfaces:**

- Produces (TS, `src/core/names.ts`): `splitName(name: string): { stem: string; ext: string }`, `basename(path: string): string`.
- Produces (Rust, `crate::persist`): `atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()>`, `is_temp_file(name: &str) -> bool`, `content_hash(bytes: &[u8]) -> String`(소문자 hex SHA-256).
- Produces (스크립트): `pnpm dev`(Vite 1420), `pnpm build`, `pnpm typecheck`, `pnpm test`(Vitest), `pnpm tauri`, `pnpm app:dev`.

- [ ] **Step 1: 툴체인과 의존성**

`mise.toml` 의 rust 줄을 바꾼다(clippy 를 pre-push 가 부른다).

```toml
rust = { version = "1.99.0", components = "rustfmt,clippy" }
```

```bash
mise install
```

`package.json` 에 `"type": "module"` 을 넣고 `scripts` 를 아래로 바꾼 뒤, 의존성을 설치한다.

```json
  "type": "module",
  "scripts": {
    "prepare": "pnpm exec ruler apply && pnpm exec lefthook install",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "lint": "oxlint --no-error-on-unmatched-pattern",
    "lint:fix": "oxlint --fix",
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "tauri": "tauri",
    "app:dev": "tauri dev --config src-tauri/tauri.dev.conf.json"
  },
```

```bash
pnpm add @codemirror/state @codemirror/view @codemirror/commands @codemirror/search @codemirror/autocomplete @codemirror/language @codemirror/lang-markdown @tauri-apps/api@^2 @tauri-apps/plugin-dialog@^2
pnpm add -D @tauri-apps/cli@^2 typescript@~6.0.3 vite@^8 vitest@^5 @types/node@^24
```

- [ ] **Step 2: 프론트엔드 골격**

`index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>tote</title>
    <link rel="stylesheet" href="/src/styles.css" />
    <script type="module" src="/src/main.ts"></script>
  </head>
  <body></body>
</html>
```

`vite.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tauri prints Rust errors to the same terminal; keep them on screen.
  clearScreen: false,
  server: {
    // `tauri dev` loads exactly this port (devUrl in src-tauri/tauri.conf.json).
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "node"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src", "tests", "vite.config.ts", "playwright.config.ts"]
}
```

`src/main.ts`(Task 14 가 바꾼다):

```ts
document.body.textContent = "tote";
```

`src/styles.css`(Task 12 가 바꾼다):

```css
html,
body {
  height: 100%;
  margin: 0;
}
```

- [ ] **Step 3: Rust 골격**

```bash
mkdir -p src-tauri/src/persist src-tauri/capabilities
cp -R spikes/lab/src-tauri/icons src-tauri/icons
```

`src-tauri/Cargo.toml`:

```toml
[package]
name = "tote"
version = "0.1.0"
description = "tote-note: a light notes app that keeps everything as you left it"
edition = "2021"

[lib]
# The `_lib` suffix keeps the library apart from the `tote` binary (cargo#8519 on Windows).
name = "tote_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
uuid = { version = "1", features = ["v4"] }

[dev-dependencies]
tempfile = "3"

# No `panic = "abort"`: with unwinding a panicking command fails alone, while abort would take the
# whole app — and every unsaved edit in it — down with it.
[profile.release]
codegen-units = 1
lto = true
opt-level = 3
strip = true
```

`src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/.gitignore`:

```
/target/
/gen/schemas
```

`src-tauri/tauri.conf.json`(CSP 는 뷰어 샌드박스와 함께 2번 계획이 정한다. 이 계획의 화면은 메모 내용을 HTML 로 그리지 않는다):

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "tote",
  "version": "0.1.0",
  "identifier": "dev.tote.note",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": false,
    "windows": [],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["app"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

`src-tauri/tauri.dev.conf.json`(`pnpm app:dev` 와 에이전트 빌드가 `--config` 로 겹친다. 단일 인스턴스는 식별자로 상대를 찾으므로, 개발 실행이 설치된 tote 에 인자를 넘기지 않게 식별자를 가른다):

```json
{
  "identifier": "dev.tote.note.dev",
  "productName": "tote-dev"
}
```

`src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "What a workspace window may call besides tote's own commands",
  "windows": ["ws-*"],
  "permissions": ["core:default"]
}
```

`src-tauri/src/main.rs`:

```rust
// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tote_lib::run()
}
```

`src-tauri/src/lib.rs`(Task 8 이 바꾼다):

```rust
pub mod persist;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "ws-scaffold",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("tote")
            .inner_size(1100.0, 760.0)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tote");
}
```

- [ ] **Step 4: 무시 목록과 훅**

`.gitignore` 의 Ruler 블록 **바깥**, 파일 끝에 덧붙인다.

```
/dist/
/test-results/
/playwright-report/
```

`lefthook.yml` 을 아래로 바꾼다. Rust 포맷은 pre-commit 에서 고치고, pre-push 는 저장소 전체를 고치지 않고 검사한다(`docs/guideline/lefthook/01-pre-push.md`).

```yaml
pre-commit:
  parallel: true
  jobs:
    - name: fmt
      run: "pnpm exec oxfmt --no-error-on-unmatched-pattern {staged_files}"
      stage_fixed: true
    - name: lint
      glob: "*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue,svelte,astro}"
      run: "pnpm exec oxlint --fix {staged_files}"
      stage_fixed: true
    - name: rustfmt
      glob: "*.rs"
      run: "rustfmt --edition 2021 {staged_files}"
      stage_fixed: true

# pre-commit 은 staged 파일만 보므로 드리프트는 여기서 저장소 전체로 잡는다.
pre-push:
  parallel: true
  jobs:
    - name: fmt-check
      run: "pnpm exec oxfmt --check ."
    - name: lint
      run: "pnpm exec oxlint --no-error-on-unmatched-pattern"
    - name: rustfmt-check
      run: "cargo fmt --manifest-path src-tauri/Cargo.toml --check"
    - name: clippy
      run: "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings"
    - name: typecheck
      run: "pnpm exec tsc --noEmit"

# 순차 실행이다 — 런타임이 맞은 뒤에 설치가 돌아야 한다.
post-checkout:
  jobs:
    - name: runtime
      # 새 워크트리는 새 경로라 mise.toml 신뢰가 이어지지 않는다. trust 없이 install 이 실패하면
      # git worktree add 와 그것을 감싼 도구(Orca 등)가 워크트리를 만들고도 실패로 끝난다.
      run: "if command -v mise >/dev/null; then mise trust --quiet && mise install; else echo 'mise 가 없어 런타임 버전을 맞추지 못했다'; fi"
    - name: deps
      run: "pnpm install"
```

```bash
pnpm exec lefthook install
pnpm exec lefthook validate
```

Expected: `All good`.

- [ ] **Step 5: 실패하는 테스트 작성**

`src/core/names.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { basename, splitName } from "./names";

describe("splitName", () => {
  it("splits at the last dot", () => {
    expect(splitName("회의 준비.md")).toEqual({ stem: "회의 준비", ext: "md" });
    expect(splitName("archive.tar.gz")).toEqual({ stem: "archive.tar", ext: "gz" });
  });

  it("keeps a leading dot in the stem and reads no dot as no extension", () => {
    expect(splitName(".env")).toEqual({ stem: ".env", ext: "" });
    expect(splitName("Makefile")).toEqual({ stem: "Makefile", ext: "" });
    expect(splitName("a.")).toEqual({ stem: "a", ext: "" });
  });
});

describe("basename", () => {
  it("takes the last path component", () => {
    expect(basename("/Users/me/스크립트/deploy.sh")).toBe("deploy.sh");
    expect(basename("deploy.sh")).toBe("deploy.sh");
  });
});
```

`src-tauri/src/persist/mod.rs` 는 테스트만 담아 만든다.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn creates_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("새 메모.md");
        atomic_write(&path, "안녕".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "안녕");
    }

    #[test]
    fn replaces_contents_without_leaving_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(names(dir.path()), vec!["a.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deploy.sh");
        fs::write(&path, "echo old\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        atomic_write(&path, b"echo new\n").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlink_and_keeps_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.txt");
        let link = dir.path().join("link.txt");
        fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        atomic_write(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_keeps_the_old_contents() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let result = atomic_write(&path, b"new");
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        assert_eq!(names(dir.path()), vec!["a.txt"]);
    }

    #[test]
    fn temp_files_are_recognised() {
        assert!(is_temp_file(".tote-tmp-0123abcd"));
        assert!(!is_temp_file("tote-tmp.md"));
    }

    #[test]
    fn hash_is_lowercase_hex_sha256() {
        assert_eq!(
            content_hash(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
```

- [ ] **Step 6: 테스트가 실패하는지 확인**

```bash
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml persist
```

Expected: Vitest 는 `Failed to resolve import "./names"`, cargo 는 `cannot find function atomic_write` 등으로 컴파일 실패.

- [ ] **Step 7: 구현**

`src/core/names.ts`:

```ts
/** Splits `name` at its last dot. A leading dot belongs to the stem; no dot means no extension.
 * `split_name` in src-tauri/src/workspace/names.rs must agree. */
export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot + 1) } : { stem: name, ext: "" };
}

/** The last component of a POSIX path. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
```

`src-tauri/src/persist/mod.rs` 의 테스트 위에 넣는다.

```rust
//! Writing files so that a crash never leaves one half-written.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const TEMP_PREFIX: &str = ".tote-tmp-";

/// Replaces the contents of `path` with `bytes`: they go to a temporary file in the same folder,
/// which is then renamed over `path`, so a crash leaves the old or the new contents and never a
/// mix. Files are never modified in place — backups hard-link earlier copies and rely on that.
///
/// The replaced file's permissions carry over (a script stays executable), and a symlink is
/// followed so the file it points to changes while the link stays a link. Extended attributes
/// such as Finder tags do not carry over.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = follow_link(path)?;
    let dir = target
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent folder"))?;
    // Named after a UUID only: the target's name plus a suffix could pass the 255-byte limit.
    let temp = dir.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4().simple()));
    let result = write_and_rename(&temp, &target, bytes);
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_and_rename(temp: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create(temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    if let Ok(meta) = fs::metadata(target) {
        fs::set_permissions(temp, meta.permissions())?;
    }
    fs::rename(temp, target)
}

fn follow_link(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path),
        _ => Ok(path.to_path_buf()),
    }
}

/// A temporary file `atomic_write` left behind when the app died between write and rename. The
/// leading dot keeps it out of memo listings either way.
pub fn is_temp_file(name: &str) -> bool {
    name.starts_with(TEMP_PREFIX)
}

/// Hex SHA-256 of `bytes`. It is stored in draft files, so it must stay the same across builds —
/// which rules out std's `DefaultHasher`.
pub fn content_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
```

- [ ] **Step 8: 테스트 통과 확인**

```bash
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: Vitest `Tests  3 passed (3)`, cargo `test result: ok. 7 passed`. 개수를 보고에 적는다.

- [ ] **Step 9: 빌드와 검사**

```bash
pnpm typecheck
pnpm build
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json
```

Expected: 모두 오류 없이 끝나고 `src-tauri/target/debug/tote` 가 생긴다. 창 확인은 Task 8 이 한다(이 골격은 화면 없는 창 하나만 띄운다).

- [ ] **Step 10: 포맷·린트·커밋**

```bash
pnpm exec oxfmt package.json index.html vite.config.ts tsconfig.json src src-tauri/tauri.conf.json src-tauri/tauri.dev.conf.json src-tauri/capabilities src-tauri/Cargo.toml lefthook.yml mise.toml
pnpm exec oxlint --fix src
cargo fmt --manifest-path src-tauri/Cargo.toml
git status --short
git add package.json pnpm-lock.yaml .gitignore lefthook.yml mise.toml index.html vite.config.ts tsconfig.json src/main.ts src/styles.css src/core/names.ts src/core/names.test.ts src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs src-tauri/.gitignore src-tauri/tauri.conf.json src-tauri/tauri.dev.conf.json src-tauri/capabilities/default.json src-tauri/icons src-tauri/src/main.rs src-tauri/src/lib.rs src-tauri/src/persist/mod.rs
git commit -m "feat(app): scaffold the tote app with atomic file writes"
```

---

### Task 2: 기기 데이터 — 앱 데이터 폴더, machine·settings·state

**Files:**

- Modify: `src-tauri/src/persist/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`
- Create: `src-tauri/src/appdata.rs`

**Interfaces:**

- Consumes: Task 1 `atomic_write`.
- Produces (`crate::persist`): `read_json<T: DeserializeOwned>(path) -> io::Result<Option<T>>`(없으면 `None`, 깨졌으면 `<이름>.corrupt-<unix ms>` 로 옮기고 `None`), `set_aside(path) -> io::Result<PathBuf>`, `write_json<T: Serialize>(path, &T) -> io::Result<()>`(폴더를 만들고 끝에 줄바꿈).
- Produces (`crate::appdata`):
  - `AppPaths { data_dir: PathBuf, default_workspace_root: PathBuf }`, `AppPaths::resolve() -> Option<AppPaths>`, `AppPaths::from_parts(override_dir, os_data_dir, home, debug) -> Option<AppPaths>`, `machine_file()`, `settings_file()`, `launch_file()`(=`state.json`), `buffers_dir()`, `inbox_dir()`.
  - `Machine { version: u32, device_id: String, device_name: String }`, `Machine::load_or_create(path, device_name: impl FnOnce() -> String) -> io::Result<Machine>`, `device_name() -> String`.
  - `Settings { workspace_root: Option<PathBuf> }`(JSON `workspaceRoot`), `Settings::load(path) -> io::Result<Settings>`, `workspace_root(&self, &AppPaths) -> PathBuf`, `workspace_root_with_home(&self, &AppPaths, home: Option<&Path>) -> PathBuf`.
  - `LaunchState { open_windows: Vec<PathBuf>, recent: Vec<PathBuf> }`(JSON `openWindows`, `recent`), `load(path)`, `save(&self, path)`, `touch(&mut self, workspace: &Path)`, `add_open(&mut self, &Path)`, `remove_open(&mut self, &Path)`.

- [ ] **Step 1: 의존성**

```bash
cargo add --manifest-path src-tauri/Cargo.toml dirs@6
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src-tauri/src/persist/mod.rs` 의 `mod tests` 안에 덧붙인다.

```rust
    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct Sample {
        name: String,
    }

    #[test]
    fn json_round_trips_and_creates_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/폴더/a.json");
        write_json(&path, &Sample { name: "메모".into() }).unwrap();
        assert!(fs::read_to_string(&path).unwrap().ends_with("}\n"));
        assert_eq!(read_json::<Sample>(&path).unwrap(), Some(Sample { name: "메모".into() }));
    }

    #[test]
    fn missing_json_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_json::<Sample>(&dir.path().join("none.json")).unwrap(), None);
    }

    #[test]
    fn unreadable_json_is_set_aside_with_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.json");
        fs::write(&path, "{ broken").unwrap();
        assert_eq!(read_json::<Sample>(&path).unwrap(), None);
        let names = names(dir.path());
        assert_eq!(names.len(), 1);
        assert!(names[0].starts_with("index.json.corrupt-"));
        assert_eq!(fs::read_to_string(dir.path().join(&names[0])).unwrap(), "{ broken");
    }
```

`src-tauri/src/appdata.rs` 를 테스트만 담아 만들고, `lib.rs` 맨 위에 `pub mod appdata;` 를 넣는다.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn an_override_dir_holds_everything() {
        let paths = AppPaths::from_parts(
            Some("/tmp/t".into()),
            Some("/os".into()),
            Some("/home".into()),
            false,
        )
        .unwrap();
        assert_eq!(paths.data_dir, PathBuf::from("/tmp/t"));
        assert_eq!(paths.default_workspace_root, PathBuf::from("/tmp/t/workspaces"));
        assert_eq!(paths.launch_file(), PathBuf::from("/tmp/t/state.json"));
    }

    #[test]
    fn debug_builds_keep_their_own_folders() {
        let os = Some(PathBuf::from("/os"));
        let home = Some(PathBuf::from("/home"));
        let release = AppPaths::from_parts(None, os.clone(), home.clone(), false).unwrap();
        let debug = AppPaths::from_parts(None, os, home, true).unwrap();
        assert_eq!(release.data_dir, PathBuf::from("/os/tote"));
        assert_eq!(release.default_workspace_root, PathBuf::from("/home/Tote"));
        assert_eq!(debug.data_dir, PathBuf::from("/os/tote-dev"));
        assert_eq!(debug.default_workspace_root, PathBuf::from("/home/Tote-dev"));
    }

    #[test]
    fn the_device_id_is_created_once() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("machine.json");
        let first = Machine::load_or_create(&file, || "맥북".into()).unwrap();
        let second = Machine::load_or_create(&file, || "다른 이름".into()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.device_name, "맥북");
        assert!(uuid::Uuid::parse_str(&first.device_id).is_ok());
    }

    #[test]
    fn an_unreadable_machine_file_is_set_aside_and_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("machine.json");
        fs::write(&file, "{ not json").unwrap();
        let machine = Machine::load_or_create(&file, || "맥북".into()).unwrap();
        assert!(uuid::Uuid::parse_str(&machine.device_id).is_ok());
        let aside = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("machine.json.corrupt-"))
            .count();
        assert_eq!(aside, 1);
    }

    #[test]
    fn the_workspace_root_defaults_and_expands_home() {
        let paths = AppPaths::from_parts(Some("/data".into()), None, None, false).unwrap();
        let home = Some(Path::new("/home"));
        assert_eq!(
            Settings::default().workspace_root_with_home(&paths, home),
            PathBuf::from("/data/workspaces")
        );
        let settings = Settings { workspace_root: Some("~/노트".into()) };
        assert_eq!(settings.workspace_root_with_home(&paths, home), PathBuf::from("/home/노트"));
    }

    #[test]
    fn settings_are_read_from_camel_case_json() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        fs::write(&file, r#"{ "workspaceRoot": "/x", "theme": "later" }"#).unwrap();
        assert_eq!(Settings::load(&file).unwrap().workspace_root, Some(PathBuf::from("/x")));
    }

    #[test]
    fn recent_moves_to_the_front_without_duplicates_and_is_capped() {
        let mut launch = LaunchState::default();
        for i in 0..25 {
            launch.touch(Path::new(&format!("/w/{i}")));
        }
        launch.touch(Path::new("/w/3"));
        assert_eq!(launch.recent.len(), 20);
        assert_eq!(launch.recent[0], PathBuf::from("/w/3"));
        assert_eq!(launch.recent.iter().filter(|p| **p == Path::new("/w/3")).count(), 1);
    }

    #[test]
    fn launch_state_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        let mut launch = LaunchState::default();
        launch.add_open(Path::new("/w/업무"));
        launch.add_open(Path::new("/w/업무"));
        launch.add_open(Path::new("/w/개인"));
        launch.remove_open(Path::new("/w/개인"));
        launch.save(&file).unwrap();
        let loaded = LaunchState::load(&file).unwrap();
        assert_eq!(loaded.open_windows, vec![PathBuf::from("/w/업무")]);
        assert!(fs::read_to_string(&file).unwrap().contains("openWindows"));
    }
}
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: `cannot find function write_json`, `cannot find type AppPaths` 등으로 컴파일 실패.

- [ ] **Step 4: 구현**

`src-tauri/src/persist/mod.rs` 의 `use` 를 넓히고 함수를 더한다.

```rust
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;
```

```rust
/// Reads JSON from `path`. Missing is `Ok(None)`. A file that does not parse as `T` is moved aside
/// to `<name>.corrupt-<unix ms>` and also reads as `Ok(None)`: the caller starts over without
/// destroying what was there (spec 「오류 처리」).
pub fn read_json<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(Some(value)),
        Err(_) => {
            set_aside(path)?;
            Ok(None)
        }
    }
}

/// Renames `path` to `<name>.corrupt-<unix ms>` next to it and returns the new path.
pub fn set_aside(path: &Path) -> io::Result<PathBuf> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".corrupt-{millis}"));
    let aside = path.with_file_name(name);
    fs::rename(path, &aside)?;
    Ok(aside)
}

/// Writes `value` as pretty JSON through `atomic_write`, creating the folder when needed.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)
}
```

`src-tauri/src/appdata.rs` 의 테스트 위에 넣는다.

```rust
//! This device's own files, outside every workspace (spec 「워크스페이스와 데이터 모델」): the device
//! ID, settings, and which workspace windows to reopen. Where they live is decided here and
//! nowhere else.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::persist::{read_json, write_json};

#[derive(Clone, Debug, PartialEq)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub default_workspace_root: PathBuf,
}

impl AppPaths {
    /// `TOTE_DATA_DIR` moves everything for one run — workspaces included — so tests and smoke
    /// checks never touch real notes. Debug builds use `tote-dev` and `~/Tote-dev` so a development
    /// run never touches the notes of an installed tote.
    pub fn resolve() -> Option<AppPaths> {
        AppPaths::from_parts(
            std::env::var_os("TOTE_DATA_DIR").map(PathBuf::from),
            dirs::data_dir(),
            dirs::home_dir(),
            cfg!(debug_assertions),
        )
    }

    pub fn from_parts(
        override_dir: Option<PathBuf>,
        os_data_dir: Option<PathBuf>,
        home: Option<PathBuf>,
        debug: bool,
    ) -> Option<AppPaths> {
        if let Some(dir) = override_dir {
            return Some(AppPaths {
                default_workspace_root: dir.join("workspaces"),
                data_dir: dir,
            });
        }
        let suffix = if debug { "-dev" } else { "" };
        Some(AppPaths {
            data_dir: os_data_dir?.join(format!("tote{suffix}")),
            default_workspace_root: home?.join(format!("Tote{suffix}")),
        })
    }

    pub fn machine_file(&self) -> PathBuf {
        self.data_dir.join("machine.json")
    }

    pub fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn launch_file(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }

    pub fn buffers_dir(&self) -> PathBuf {
        self.data_dir.join("buffers")
    }

    /// Text piped into `tote -`, parked until the app turns it into a memo.
    pub fn inbox_dir(&self) -> PathBuf {
        self.data_dir.join("inbox")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub version: u32,
    pub device_id: String,
    pub device_name: String,
}

impl Machine {
    /// The device ID is made once and kept: sessions and external-file tabs are keyed by it, so a
    /// new ID makes this device forget its tabs in every workspace.
    pub fn load_or_create(path: &Path, device_name: impl FnOnce() -> String) -> io::Result<Machine> {
        if let Some(machine) = read_json::<Machine>(path)? {
            return Ok(machine);
        }
        let machine = Machine {
            version: 1,
            device_id: uuid::Uuid::new_v4().to_string(),
            device_name: device_name(),
        };
        write_json(path, &machine)?;
        Ok(machine)
    }
}

/// The name people know this Mac by (System Settings › General › Sharing), else the host name.
pub fn device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Some(name) = command_output("scutil", &["--get", "ComputerName"]) {
        return name;
    }
    command_output("hostname", &[]).unwrap_or_else(|| "unknown".into())
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program).args(args).output().ok()?;
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// `settings.json`. Later plans add the theme and extension switches; unknown fields are ignored
/// on read and this plan never writes the file.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<PathBuf>,
}

impl Settings {
    pub fn load(path: &Path) -> io::Result<Settings> {
        Ok(read_json(path)?.unwrap_or_default())
    }

    pub fn workspace_root(&self, paths: &AppPaths) -> PathBuf {
        self.workspace_root_with_home(paths, dirs::home_dir().as_deref())
    }

    /// The configured root with a leading `~` expanded (people edit this file by hand).
    pub fn workspace_root_with_home(&self, paths: &AppPaths, home: Option<&Path>) -> PathBuf {
        let Some(root) = &self.workspace_root else {
            return paths.default_workspace_root.clone();
        };
        match (root.strip_prefix("~"), home) {
            (Ok(rest), Some(home)) => home.join(rest),
            _ => root.clone(),
        }
    }
}

const RECENT_LIMIT: usize = 20;

/// `state.json`: what to reopen at the next launch and which workspace was used last.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchState {
    /// Workspace windows open when tote last quit, in the order they were opened.
    #[serde(default)]
    pub open_windows: Vec<PathBuf>,
    /// Workspaces by last use, most recent first.
    #[serde(default)]
    pub recent: Vec<PathBuf>,
}

impl LaunchState {
    pub fn load(path: &Path) -> io::Result<LaunchState> {
        Ok(read_json(path)?.unwrap_or_default())
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        write_json(path, self)
    }

    pub fn touch(&mut self, workspace: &Path) {
        self.recent.retain(|p| p != workspace);
        self.recent.insert(0, workspace.to_path_buf());
        self.recent.truncate(RECENT_LIMIT);
    }

    pub fn add_open(&mut self, workspace: &Path) {
        if !self.open_windows.iter().any(|p| p == workspace) {
            self.open_windows.push(workspace.to_path_buf());
        }
    }

    pub fn remove_open(&mut self, workspace: &Path) {
        self.open_windows.retain(|p| p != workspace);
    }
}
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: `test result: ok. 18 passed`(persist 10, appdata 8).

- [ ] **Step 6: 포맷·검사·커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm exec oxfmt src-tauri/Cargo.toml
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/persist/mod.rs src-tauri/src/appdata.rs
git commit -m "feat(app): keep device identity, settings and launch state in the app data folder"
```

---

### Task 3: 워크스페이스와 메모 색인

**Files:**

- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`
- Create: `src-tauri/src/workspace/mod.rs`, `src-tauri/src/workspace/names.rs`, `src-tauri/src/workspace/index.rs`, `src-tauri/src/workspace/memo.rs`

**Interfaces:**

- Consumes: Task 1 `atomic_write`·`is_temp_file`, Task 2 `read_json`·`write_json`.
- Produces (`crate::workspace`):
  - `const TOTE_DIR: &str = ".tote"`, `const DEFAULT_WORKSPACE: &str = "메모"`.
  - `enum WorkspaceError { NotAWorkspace(PathBuf), AlreadyExists(PathBuf), InvalidName(String), UnknownMemo(String), Io(io::Error) }`(`thiserror`, `From<io::Error>`).
  - `struct Workspace` — `create(root: &Path, name: &str) -> Result<Workspace, WorkspaceError>`, `open(path: &Path) -> Result<Workspace, WorkspaceError>`(루트를 `canonicalize` 한다), `is_workspace(path: &Path) -> bool`, `list(root: &Path) -> Vec<WorkspaceSummary>`(이름순), `id(&self) -> &str`, `root(&self) -> &Path`, `name(&self) -> String`(폴더 이름).
  - `struct WorkspaceSummary { name: String, path: PathBuf }`.
  - `Workspace::list_memos(&mut self) -> Result<Vec<MemoInfo>, WorkspaceError>`(수정 시각 내림차순, 같으면 파일 이름순), `Workspace::memo_info(&self, id: &str) -> Result<MemoInfo, WorkspaceError>`.
  - `struct MemoInfo { id, file, auto_title: bool, language: Option<String>, modified_ms: u64, size: u64, kind: FileKind }` — JSON 은 camelCase, `language` 는 없으면 생략.
  - `enum FileKind { Text, Image, Video, Audio, Document }` — JSON 은 소문자. `kind_for(file_name: &str) -> FileKind`.
- Produces (`crate::workspace::names`): `split_name(&str) -> (&str, &str)`, `join_name(stem, ext) -> String`, `is_valid_file_name(&str) -> bool`, `unique_file_name(stem, ext, is_taken: impl FnMut(&str) -> bool) -> String`.
- Produces (`crate::workspace::index`): `MemoEntry { file: String, auto_title: bool, language: Option<String> }`, `MemoIndex`(`load(root)`, `reconcile(root) -> io::Result<bool>`, `save()`, `get`, `get_mut`, `insert`, `remove`, `iter`), `memo_files(root) -> io::Result<BTreeSet<String>>`, `reconcile_entries(&mut BTreeMap<String, MemoEntry>, &BTreeSet<String>, new_id) -> bool`.

- [ ] **Step 1: 의존성**

```bash
cargo add --manifest-path src-tauri/Cargo.toml thiserror@2
```

- [ ] **Step 2: 실패하는 테스트 작성**

`lib.rs` 에 `pub mod workspace;` 를 넣는다. 아래 파일들을 테스트만 담아 만든다. `workspace/mod.rs` 는 모듈 선언도 함께 둔다.

`src-tauri/src/workspace/mod.rs`:

```rust
pub mod index;
pub mod memo;
pub mod names;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn create_then_open_keeps_the_id() {
        let root = tempfile::tempdir().unwrap();
        let created = Workspace::create(root.path(), "업무 메모").unwrap();
        let opened = Workspace::open(&root.path().join("업무 메모")).unwrap();
        assert_eq!(created.id(), opened.id());
        assert_eq!(opened.name(), "업무 메모");
        assert!(uuid::Uuid::parse_str(opened.id()).is_ok());
        assert!(root.path().join("업무 메모/.tote/workspace.json").is_file());
        assert!(root.path().join("업무 메모/.tote/index.json").is_file());
    }

    #[test]
    fn create_refuses_bad_names_and_existing_folders() {
        let root = tempfile::tempdir().unwrap();
        for bad in ["", " ", ".숨김", "a/b", "a:b"] {
            assert!(matches!(
                Workspace::create(root.path(), bad),
                Err(WorkspaceError::InvalidName(_))
            ));
        }
        fs::create_dir(root.path().join("있음")).unwrap();
        assert!(matches!(
            Workspace::create(root.path(), "있음"),
            Err(WorkspaceError::AlreadyExists(_))
        ));
    }

    #[test]
    fn a_plain_folder_is_not_a_workspace() {
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(
            Workspace::open(root.path()),
            Err(WorkspaceError::NotAWorkspace(_))
        ));
    }

    #[test]
    fn an_unreadable_workspace_file_gets_a_new_id_and_is_set_aside() {
        let root = tempfile::tempdir().unwrap();
        let first = Workspace::create(root.path(), "w").unwrap();
        let file = root.path().join("w/.tote/workspace.json");
        fs::write(&file, "nope").unwrap();
        let reopened = Workspace::open(&root.path().join("w")).unwrap();
        assert_ne!(reopened.id(), first.id());
        let aside = fs::read_dir(root.path().join("w/.tote"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("workspace.json.corrupt-"))
            .count();
        assert_eq!(aside, 1);
    }

    #[test]
    fn list_finds_only_workspaces() {
        let root = tempfile::tempdir().unwrap();
        Workspace::create(root.path(), "나").unwrap();
        Workspace::create(root.path(), "가").unwrap();
        fs::create_dir(root.path().join("그냥 폴더")).unwrap();
        let names: Vec<String> = Workspace::list(root.path()).into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["가", "나"]);
    }

    #[test]
    fn opening_removes_leftover_temp_files() {
        let root = tempfile::tempdir().unwrap();
        Workspace::create(root.path(), "w").unwrap();
        let leftover = root.path().join("w/.tote-tmp-deadbeef");
        fs::write(&leftover, "half").unwrap();
        Workspace::open(&root.path().join("w")).unwrap();
        assert!(!leftover.exists());
    }
}
```

`src-tauri/src/workspace/names.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_matches_the_frontend() {
        assert_eq!(split_name("회의 준비.md"), ("회의 준비", "md"));
        assert_eq!(split_name("archive.tar.gz"), ("archive.tar", "gz"));
        assert_eq!(split_name(".env"), (".env", ""));
        assert_eq!(split_name("Makefile"), ("Makefile", ""));
        assert_eq!(split_name("a."), ("a", ""));
        assert_eq!(join_name("a", ""), "a");
        assert_eq!(join_name("a", "md"), "a.md");
    }

    #[test]
    fn valid_names() {
        assert!(is_valid_file_name("회의 준비.md"));
        for bad in ["", ".hidden", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\u{0}b", "a\u{85}b", " a", "a "] {
            assert!(!is_valid_file_name(bad), "{bad:?} should be rejected");
        }
        assert!(!is_valid_file_name(&"가".repeat(86))); // 258 bytes
    }

    #[test]
    fn unique_names_count_up_from_two() {
        let taken = ["메모.md", "메모 2.md"];
        assert_eq!(unique_file_name("메모", "md", |n| taken.contains(&n)), "메모 3.md");
        assert_eq!(unique_file_name("새", "md", |n| taken.contains(&n)), "새.md");
        assert_eq!(unique_file_name("Makefile", "", |n| n == "Makefile"), "Makefile 2");
    }
}
```

`src-tauri/src/workspace/index.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn entry(file: &str, auto_title: bool) -> MemoEntry {
        MemoEntry { file: file.into(), auto_title, language: None }
    }

    #[test]
    fn reconcile_drops_missing_files_and_indexes_new_ones() {
        let mut memos = BTreeMap::from([
            ("a".to_string(), entry("남음.md", true)),
            ("b".to_string(), entry("사라짐.md", true)),
        ]);
        let files = BTreeSet::from(["남음.md".to_string(), "새 파일.sh".to_string()]);
        let mut ids = ["n1".to_string()].into_iter();
        assert!(reconcile_entries(&mut memos, &files, || ids.next().unwrap()));
        assert_eq!(memos.get("a"), Some(&entry("남음.md", true)));
        assert_eq!(memos.get("b"), None);
        assert_eq!(memos.get("n1"), Some(&entry("새 파일.sh", false)));
        assert!(!reconcile_entries(&mut memos, &files, || unreachable!()));
    }

    #[test]
    fn two_entries_for_one_file_keep_the_first() {
        let mut memos = BTreeMap::from([
            ("a".to_string(), entry("x.md", true)),
            ("b".to_string(), entry("x.md", false)),
        ]);
        let files = BTreeSet::from(["x.md".to_string()]);
        assert!(reconcile_entries(&mut memos, &files, || unreachable!()));
        assert_eq!(memos.keys().collect::<Vec<_>>(), vec!["a"]);
    }

    #[cfg(unix)]
    #[test]
    fn memo_files_are_plain_files_at_the_top_level() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("메모.md"), "").unwrap();
        fs::write(dir.path().join(".DS_Store"), "").unwrap();
        fs::create_dir_all(dir.path().join("하위/폴더")).unwrap();
        fs::write(dir.path().join("하위/안쪽.md"), "").unwrap();
        std::os::unix::fs::symlink(dir.path().join("메모.md"), dir.path().join("링크.md")).unwrap();
        let files = memo_files(dir.path()).unwrap();
        assert_eq!(files, BTreeSet::from(["링크.md".to_string(), "메모.md".to_string()]));
    }

    #[test]
    fn an_unreadable_index_is_rebuilt_from_the_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(TOTE_DIR)).unwrap();
        fs::write(dir.path().join(TOTE_DIR).join("index.json"), "{ broken").unwrap();
        fs::write(dir.path().join("살아남음.md"), "내용").unwrap();
        let index = MemoIndex::load(dir.path()).unwrap();
        let entries: Vec<&MemoEntry> = index.iter().map(|(_, e)| e).collect();
        assert_eq!(entries, vec![&entry("살아남음.md", false)]);
        let reread = MemoIndex::load(dir.path()).unwrap();
        assert_eq!(reread.iter().count(), 1);
        let aside = fs::read_dir(dir.path().join(TOTE_DIR))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("index.json.corrupt-"))
            .count();
        assert_eq!(aside, 1);
    }
}
```

`src-tauri/src/workspace/memo.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    use crate::workspace::Workspace;

    fn set_mtime(path: &std::path::Path, secs: u64) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
    }

    #[test]
    fn kinds_come_from_the_extension() {
        assert_eq!(kind_for("a.md"), FileKind::Text);
        assert_eq!(kind_for("a.svg"), FileKind::Text);
        assert_eq!(kind_for("사진.JPG"), FileKind::Image);
        assert_eq!(kind_for("clip.mov"), FileKind::Video);
        assert_eq!(kind_for("voice.m4a"), FileKind::Audio);
        assert_eq!(kind_for("doc.pdf"), FileKind::Document);
        assert_eq!(kind_for("Makefile"), FileKind::Text);
    }

    #[test]
    fn memos_are_listed_newest_first_and_follow_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::create(root.path(), "w").unwrap();
        let dir = ws.root().to_path_buf();
        fs::write(dir.join("오래됨.md"), "a").unwrap();
        fs::write(dir.join("새것.md"), "bb").unwrap();
        set_mtime(&dir.join("오래됨.md"), 1_000);
        set_mtime(&dir.join("새것.md"), 2_000);
        let list = ws.list_memos().unwrap();
        let files: Vec<&str> = list.iter().map(|m| m.file.as_str()).collect();
        assert_eq!(files, vec!["새것.md", "오래됨.md"]);
        assert_eq!(list[0].size, 2);
        assert_eq!(list[0].modified_ms, 2_000_000);
        assert!(!list[0].auto_title);

        fs::remove_file(dir.join("오래됨.md")).unwrap();
        let files: Vec<String> = ws.list_memos().unwrap().into_iter().map(|m| m.file).collect();
        assert_eq!(files, vec!["새것.md"]);
    }

    #[test]
    fn memo_info_reports_unknown_ids() {
        let root = tempfile::tempdir().unwrap();
        let ws = Workspace::create(root.path(), "w").unwrap();
        assert!(matches!(ws.memo_info("nope"), Err(WorkspaceError::UnknownMemo(_))));
    }

    #[test]
    fn memo_info_serialises_for_the_frontend() {
        let info = MemoInfo {
            id: "i".into(),
            file: "a.md".into(),
            auto_title: true,
            language: None,
            modified_ms: 5,
            size: 1,
            kind: FileKind::Text,
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"id":"i","file":"a.md","autoTitle":true,"modifiedMs":5,"size":1,"kind":"text"}"#
        );
    }
}
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml workspace
```

Expected: `cannot find type Workspace`, `cannot find function split_name` 등으로 컴파일 실패.

- [ ] **Step 4: 구현**

`src-tauri/src/workspace/names.rs` 의 테스트 위:

```rust
//! File-name rules shared by workspace folders, memo titles and imports.

/// Characters macOS, Windows or a shell chokes on in a file name (spec 「제목 자동 생성」).
const FORBIDDEN: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
/// APFS and most file systems cap a name at 255 bytes.
const MAX_NAME_BYTES: usize = 255;

/// Splits at the last dot: `a.tar.gz` → (`a.tar`, `gz`). A leading dot belongs to the stem and
/// no dot means no extension. `splitName` in src/core/names.ts must agree.
pub fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot + 1..]),
        _ => (name, ""),
    }
}

pub fn join_name(stem: &str, ext: &str) -> String {
    if ext.is_empty() {
        stem.to_string()
    } else {
        format!("{stem}.{ext}")
    }
}

/// A name tote may create in a workspace: not empty, no forbidden or control characters, not a
/// dot file (listings skip those), no surrounding spaces, at most 255 bytes.
pub fn is_valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_BYTES
        && name.trim() == name
        && !name.starts_with('.')
        && !name.chars().any(|c| FORBIDDEN.contains(&c) || c.is_control())
}

/// `stem.ext`, then `stem 2.ext`, `stem 3.ext`, … — the first one `is_taken` lets through.
pub fn unique_file_name(stem: &str, ext: &str, mut is_taken: impl FnMut(&str) -> bool) -> String {
    let mut candidate = join_name(stem, ext);
    let mut n = 2;
    while is_taken(&candidate) {
        candidate = join_name(&format!("{stem} {n}"), ext);
        n += 1;
    }
    candidate
}
```

`src-tauri/src/workspace/index.rs` 의 테스트 위:

```rust
//! `.tote/index.json`: memo ID → file name. The memo files are the original, so the index can be
//! rebuilt from them whenever it is missing or unreadable (new IDs, `autoTitle: false`).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::TOTE_DIR;
use crate::persist::{read_json, write_json};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoEntry {
    pub file: String,
    pub auto_title: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Deserialize)]
struct IndexFile {
    memos: BTreeMap<String, MemoEntry>,
}

#[derive(Serialize)]
struct IndexFileRef<'a> {
    version: u32,
    memos: &'a BTreeMap<String, MemoEntry>,
}

pub struct MemoIndex {
    path: PathBuf,
    memos: BTreeMap<String, MemoEntry>,
}

impl MemoIndex {
    /// Loads the index of the workspace at `root` and brings it in line with the files there.
    pub fn load(root: &Path) -> io::Result<MemoIndex> {
        let path = root.join(TOTE_DIR).join("index.json");
        let memos = read_json::<IndexFile>(&path)?
            .map(|file| file.memos)
            .unwrap_or_default();
        let mut index = MemoIndex { path, memos };
        if index.reconcile(root)? || !index.path.is_file() {
            index.save()?;
        }
        Ok(index)
    }

    /// Drops entries whose file is gone and indexes new files. Returns whether anything changed.
    pub fn reconcile(&mut self, root: &Path) -> io::Result<bool> {
        let files = memo_files(root)?;
        Ok(reconcile_entries(&mut self.memos, &files, || {
            uuid::Uuid::new_v4().to_string()
        }))
    }

    pub fn save(&self) -> io::Result<()> {
        write_json(&self.path, &IndexFileRef { version: 1, memos: &self.memos })
    }

    pub fn get(&self, id: &str) -> Option<&MemoEntry> {
        self.memos.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut MemoEntry> {
        self.memos.get_mut(id)
    }

    pub fn insert(&mut self, id: String, entry: MemoEntry) {
        self.memos.insert(id, entry);
    }

    pub fn remove(&mut self, id: &str) -> Option<MemoEntry> {
        self.memos.remove(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &MemoEntry)> {
        self.memos.iter()
    }
}

/// The files that are memos: regular files (or links to them) directly in `root`. Dot files are
/// skipped, which also skips `.tote/` and leftover temporary files.
pub fn memo_files(root: &Path) -> io::Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !name.starts_with('.') && fs::metadata(entry.path()).is_ok_and(|m| m.is_file()) {
            names.insert(name);
        }
    }
    Ok(names)
}

/// Drops entries whose file is gone and gives every unindexed file a new ID with
/// `autoTitle: false` (tote did not name it). Two entries naming one file keep the first. A file
/// renamed while tote was not watching therefore becomes a new memo; only its tab position is
/// lost (spec 「메모 ID 와 색인」).
pub fn reconcile_entries(
    memos: &mut BTreeMap<String, MemoEntry>,
    files: &BTreeSet<String>,
    mut new_id: impl FnMut() -> String,
) -> bool {
    let before = memos.len();
    let mut seen = BTreeSet::new();
    memos.retain(|_, entry| files.contains(&entry.file) && seen.insert(entry.file.clone()));
    let mut changed = memos.len() != before;
    for file in files.difference(&seen) {
        memos.insert(
            new_id(),
            MemoEntry { file: file.clone(), auto_title: false, language: None },
        );
        changed = true;
    }
    changed
}
```

`src-tauri/src/workspace/memo.rs` 의 테스트 위:

```rust
//! What the memo list shows about each memo.

use std::fs;
use std::io;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::index::MemoEntry;
use super::names::split_name;
use super::{Workspace, WorkspaceError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Text,
    Image,
    Video,
    Audio,
    Document,
}

/// Guessed from the extension: listing 10,000 memos must not open every file. Which viewer
/// actually opens a file is decided by the extension registry of a later plan.
pub fn kind_for(file_name: &str) -> FileKind {
    let ext = split_name(file_name).1.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "bmp" | "tif" | "tiff" | "avif" => {
            FileKind::Image
        }
        "mp4" | "mov" | "m4v" | "webm" => FileKind::Video,
        "mp3" | "m4a" | "wav" | "aac" | "flac" | "ogg" | "aiff" => FileKind::Audio,
        "pdf" => FileKind::Document,
        _ => FileKind::Text,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoInfo {
    pub id: String,
    pub file: String,
    pub auto_title: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub modified_ms: u64,
    pub size: u64,
    pub kind: FileKind,
}

impl Workspace {
    /// Every memo, most recently modified first. Picks up files other apps added or removed.
    pub fn list_memos(&mut self) -> Result<Vec<MemoInfo>, WorkspaceError> {
        if self.index.reconcile(&self.root)? {
            self.index.save()?;
        }
        let mut list: Vec<MemoInfo> = self
            .index
            .iter()
            .filter_map(|(id, entry)| self.info_for(id, entry).ok())
            .collect();
        list.sort_by(|a, b| {
            b.modified_ms
                .cmp(&a.modified_ms)
                .then_with(|| a.file.cmp(&b.file))
        });
        Ok(list)
    }

    pub fn memo_info(&self, id: &str) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?;
        Ok(self.info_for(id, entry)?)
    }

    pub(super) fn entry(&self, id: &str) -> Result<&MemoEntry, WorkspaceError> {
        self.index
            .get(id)
            .ok_or_else(|| WorkspaceError::UnknownMemo(id.to_string()))
    }

    fn info_for(&self, id: &str, entry: &MemoEntry) -> io::Result<MemoInfo> {
        let meta = fs::metadata(self.root.join(&entry.file))?;
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        Ok(MemoInfo {
            id: id.to_string(),
            file: entry.file.clone(),
            auto_title: entry.auto_title,
            language: entry.language.clone(),
            modified_ms,
            size: meta.len(),
            kind: kind_for(&entry.file),
        })
    }
}
```

`src-tauri/src/workspace/mod.rs` 의 맨 위, 즉 `pub mod …;` 선언보다 앞(`//!` 모듈 문서가 선언 뒤에 오면 E0753 으로 컴파일되지 않는다). 선언은 아래 `use` 들 뒤에 둔다. 테스트 위:

```rust
//! A workspace is a folder tote made (it has `.tote/workspace.json`). Its memos are the files
//! directly inside it, known by ID through `.tote/index.json` and never by path: automatic titles
//! rename files, and sync must still recognise a renamed file as the same memo.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::persist::{is_temp_file, read_json, write_json};
use index::MemoIndex;
use names::is_valid_file_name;

pub use memo::{kind_for, FileKind, MemoInfo};

pub const TOTE_DIR: &str = ".tote";
/// Made on the first launch so there is somewhere to type right away.
pub const DEFAULT_WORKSPACE: &str = "메모";

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("not a tote workspace: {0}")]
    NotAWorkspace(PathBuf),
    #[error("already exists: {0}")]
    AlreadyExists(PathBuf),
    #[error("invalid name: {0}")]
    InvalidName(String),
    #[error("no memo with id {0}")]
    UnknownMemo(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// `.tote/workspace.json`. No name: a workspace is named after its folder, so renaming the
/// folder in Finder cannot leave two names disagreeing.
#[derive(Serialize, Deserialize)]
struct WorkspaceFile {
    version: u32,
    id: String,
}

pub struct Workspace {
    root: PathBuf,
    id: String,
    index: MemoIndex,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub name: String,
    pub path: PathBuf,
}

impl Workspace {
    pub fn create(root: &Path, name: &str) -> Result<Workspace, WorkspaceError> {
        let name = name.trim();
        if !is_valid_file_name(name) {
            return Err(WorkspaceError::InvalidName(name.to_string()));
        }
        let path = root.join(name);
        if path.symlink_metadata().is_ok() {
            return Err(WorkspaceError::AlreadyExists(path));
        }
        write_json(
            &path.join(TOTE_DIR).join("workspace.json"),
            &WorkspaceFile { version: 1, id: new_id() },
        )?;
        Workspace::open(&path)
    }

    pub fn open(path: &Path) -> Result<Workspace, WorkspaceError> {
        let file = path.join(TOTE_DIR).join("workspace.json");
        if !file.is_file() {
            return Err(WorkspaceError::NotAWorkspace(path.to_path_buf()));
        }
        let meta = match read_json::<WorkspaceFile>(&file)? {
            Some(meta) => meta,
            // Unreadable (read_json set it aside): a new ID keeps the memos usable; only state
            // keyed by the ID, such as this workspace's backups, starts over.
            None => {
                let meta = WorkspaceFile { version: 1, id: new_id() };
                write_json(&file, &meta)?;
                meta
            }
        };
        let root = fs::canonicalize(path)?;
        remove_temp_files(&root);
        let index = MemoIndex::load(&root)?;
        Ok(Workspace { root, id: meta.id, index })
    }

    pub fn is_workspace(path: &Path) -> bool {
        path.join(TOTE_DIR).join("workspace.json").is_file()
    }

    /// The workspaces directly under `root`, by name.
    pub fn list(root: &Path) -> Vec<WorkspaceSummary> {
        let Ok(entries) = fs::read_dir(root) else {
            return Vec::new();
        };
        let mut list: Vec<WorkspaceSummary> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let path = entry.path();
                (!name.starts_with('.') && Workspace::is_workspace(&path))
                    .then_some(WorkspaceSummary { name, path })
            })
            .collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Temporary files of writes that never reached their rename (the app died in between).
fn remove_temp_files(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_str().is_some_and(is_temp_file) {
            let _ = fs::remove_file(entry.path());
        }
    }
}
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: `test result: ok. 35 passed`(이전 18 + workspace 6, names 3, index 4, memo 4).

- [ ] **Step 6: 포맷·검사·커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/workspace
git commit -m "feat(workspace): open and create workspaces and index memos by ID"
```

---

### Task 4: 메모 파일 조작

**Files:**

- Modify: `src-tauri/src/workspace/mod.rs`(`mod ops;` 한 줄)
- Create: `src-tauri/src/workspace/ops.rs`

**Interfaces:**

- Consumes: Task 3 `Workspace`, `MemoEntry`, `names::*`, Task 1 `atomic_write`.
- Produces (`impl Workspace`, 모두 `Result<_, WorkspaceError>`):
  - `create_memo(&mut self, ext: &str, contents: &[u8]) -> MemoInfo` — `untitled.<ext>`(겹치면 ` 2`…), `autoTitle: true`.
  - `read_memo(&self, id) -> Vec<u8>`, `write_memo(&mut self, id, contents: &[u8]) -> MemoInfo`(ID 로 지금 파일 이름을 찾아 원자적으로 쓴다. 파일이 지워졌으면 다시 만든다).
  - `retitle_memo(&mut self, id, stem: &str) -> MemoInfo` — `autoTitle` 인 메모만, 확장자 유지, 겹치면 ` 2`, 대소문자만 다른 자기 이름은 그대로 rename. 잘못된 `stem` 은 `InvalidName`.
  - `rename_memo(&mut self, id, file: &str) -> MemoInfo` — 사람이 고른 이름. `autoTitle: false`. 다른 파일이 그 이름이면 `AlreadyExists`.
  - `delete_memo(&mut self, id) -> ()`(파일이 이미 없어도 된다).
  - `import_memo(&mut self, file_name: &str, contents: &[u8]) -> MemoInfo`, `import_file(&mut self, path: &Path) -> MemoInfo` — 그 이름(겹치면 ` 2`)으로 복사, `autoTitle: false`.

- [ ] **Step 1: 실패하는 테스트 작성**

`workspace/mod.rs` 의 모듈 선언에 `mod ops;` 를 더하고, `src-tauri/src/workspace/ops.rs` 를 테스트만 담아 만든다.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let root = tempfile::tempdir().unwrap();
        let ws = Workspace::create(root.path(), "w").unwrap();
        (root, ws)
    }

    fn listed(ws: &Workspace) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(ws.root())
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn new_memos_start_untitled_and_count_up() {
        let (_root, mut ws) = workspace();
        let a = ws.create_memo("md", b"").unwrap();
        let b = ws.create_memo("md", b"").unwrap();
        assert_eq!((a.file.as_str(), b.file.as_str()), ("untitled.md", "untitled 2.md"));
        assert!(a.auto_title);
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn writes_follow_the_memo_through_a_rename() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        ws.write_memo(&memo.id, "# 회의".as_bytes()).unwrap();
        ws.retitle_memo(&memo.id, "회의").unwrap();
        let info = ws.write_memo(&memo.id, "# 회의\n안건".as_bytes()).unwrap();
        assert_eq!(info.file, "회의.md");
        assert_eq!(ws.read_memo(&memo.id).unwrap(), "# 회의\n안건".as_bytes());
        assert_eq!(listed(&ws), vec!["회의.md"]);
    }

    #[test]
    fn a_title_already_taken_gets_a_number() {
        let (_root, mut ws) = workspace();
        let a = ws.create_memo("md", b"").unwrap();
        let b = ws.create_memo("md", b"").unwrap();
        assert_eq!(ws.retitle_memo(&a.id, "회의").unwrap().file, "회의.md");
        assert_eq!(ws.retitle_memo(&b.id, "회의").unwrap().file, "회의 2.md");
        // Its own number is not a reason to rename again.
        assert_eq!(ws.retitle_memo(&b.id, "회의").unwrap().file, "회의 2.md");
    }

    #[test]
    fn a_case_only_title_change_renames_the_same_file() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        ws.retitle_memo(&memo.id, "memo").unwrap();
        assert_eq!(ws.retitle_memo(&memo.id, "Memo").unwrap().file, "Memo.md");
        assert_eq!(listed(&ws), vec!["Memo.md"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_title_that_differs_only_in_unicode_normalisation_counts_as_taken() {
        // Finder may write Korean names decomposed (NFD) while typed titles are composed (NFC);
        // APFS treats them as one name, so the memo must not take it.
        let (_root, mut ws) = workspace();
        let nfd = "\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}.md"; // 한글.md, decomposed
        fs::write(ws.root().join(nfd), "").unwrap();
        let memo = ws.create_memo("md", b"").unwrap();
        assert_eq!(ws.retitle_memo(&memo.id, "한글").unwrap().file, "한글 2.md");
    }

    #[test]
    fn titles_leave_manually_named_memos_alone() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        ws.rename_memo(&memo.id, "내 이름.md").unwrap();
        let info = ws.retitle_memo(&memo.id, "다른 제목").unwrap();
        assert_eq!(info.file, "내 이름.md");
        assert!(!info.auto_title);
    }

    #[test]
    fn titles_that_would_escape_the_folder_are_refused() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        for bad in ["../밖", "a/b", "", ".숨김"] {
            assert!(matches!(
                ws.retitle_memo(&memo.id, bad),
                Err(WorkspaceError::InvalidName(_))
            ));
        }
        assert_eq!(listed(&ws), vec!["untitled.md"]);
    }

    #[test]
    fn rename_refuses_a_name_another_file_has() {
        let (_root, mut ws) = workspace();
        let a = ws.create_memo("md", b"").unwrap();
        ws.import_memo("deploy.sh", b"echo").unwrap();
        assert!(matches!(
            ws.rename_memo(&a.id, "deploy.sh"),
            Err(WorkspaceError::AlreadyExists(_))
        ));
        assert!(matches!(
            ws.rename_memo(&a.id, "a/b.md"),
            Err(WorkspaceError::InvalidName(_))
        ));
    }

    #[test]
    fn delete_removes_file_and_entry_even_if_the_file_is_gone() {
        let (_root, mut ws) = workspace();
        let a = ws.create_memo("md", b"").unwrap();
        let b = ws.create_memo("md", b"").unwrap();
        ws.delete_memo(&a.id).unwrap();
        fs::remove_file(ws.root().join(&b.file)).unwrap();
        ws.delete_memo(&b.id).unwrap();
        assert!(listed(&ws).is_empty());
        assert!(matches!(ws.memo_info(&a.id), Err(WorkspaceError::UnknownMemo(_))));
    }

    #[test]
    fn imports_keep_the_name_and_never_auto_title() {
        let (root, mut ws) = workspace();
        let outside = root.path().join("deploy.sh");
        fs::write(&outside, "echo hi\n").unwrap();
        let first = ws.import_file(&outside).unwrap();
        let second = ws.import_memo("deploy.sh", b"echo edited\n").unwrap();
        assert_eq!((first.file.as_str(), second.file.as_str()), ("deploy.sh", "deploy 2.sh"));
        assert!(!first.auto_title && !second.auto_title);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "echo hi\n");
        assert_eq!(ws.read_memo(&second.id).unwrap(), b"echo edited\n");
    }

    #[test]
    fn unknown_ids_are_reported() {
        let (_root, mut ws) = workspace();
        assert!(matches!(ws.read_memo("x"), Err(WorkspaceError::UnknownMemo(_))));
        assert!(matches!(ws.write_memo("x", b""), Err(WorkspaceError::UnknownMemo(_))));
        assert!(matches!(
            ws.import_file(Path::new("/nonexistent/a.txt")),
            Err(WorkspaceError::Io(_))
        ));
    }
}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml ops
```

Expected: `no method named create_memo` 등으로 컴파일 실패.

- [ ] **Step 3: 구현**

`src-tauri/src/workspace/ops.rs` 의 테스트 위:

```rust
//! Creating, saving, renaming and removing memo files. Every operation goes through the memo ID,
//! so a save that lands right after a title rename still finds the file.

use std::fs;
use std::io;
use std::path::Path;

use super::index::MemoEntry;
use super::names::{is_valid_file_name, join_name, split_name, unique_file_name};
use super::{MemoInfo, Workspace, WorkspaceError};
use crate::persist::atomic_write;

impl Workspace {
    pub fn create_memo(&mut self, ext: &str, contents: &[u8]) -> Result<MemoInfo, WorkspaceError> {
        let file = self.free_name("untitled", ext, None);
        self.add_memo(file, true, contents)
    }

    pub fn read_memo(&self, id: &str) -> Result<Vec<u8>, WorkspaceError> {
        let file = &self.entry(id)?.file;
        Ok(fs::read(self.root.join(file))?)
    }

    /// Writes by ID. A file deleted under us is written again: the editor's text is the newest
    /// copy there is.
    pub fn write_memo(&mut self, id: &str, contents: &[u8]) -> Result<MemoInfo, WorkspaceError> {
        let file = self.entry(id)?.file.clone();
        atomic_write(&self.root.join(file), contents)?;
        self.memo_info(id)
    }

    /// Renames an automatically titled memo to `<stem>.<its extension>`; memos the person named
    /// are left alone. `stem` comes from the frontend's title rule and is checked again here
    /// because a file name is the one thing that must never leave the workspace folder.
    pub fn retitle_memo(&mut self, id: &str, stem: &str) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?.clone();
        if !entry.auto_title {
            return self.memo_info(id);
        }
        let ext = split_name(&entry.file).1.to_string();
        if !is_valid_file_name(&join_name(stem, &ext)) {
            return Err(WorkspaceError::InvalidName(stem.to_string()));
        }
        let file = self.free_name(stem, &ext, Some(&entry.file));
        self.move_memo(id, &entry.file, file, true)
    }

    /// A name the person chose: used as is, and the memo stops getting automatic titles.
    pub fn rename_memo(&mut self, id: &str, file: &str) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?.clone();
        let file = file.trim();
        if !is_valid_file_name(file) {
            return Err(WorkspaceError::InvalidName(file.to_string()));
        }
        let to = self.root.join(file);
        if to.symlink_metadata().is_ok() && !same_file(&self.root.join(&entry.file), &to) {
            return Err(WorkspaceError::AlreadyExists(to));
        }
        self.move_memo(id, &entry.file, file.to_string(), false)
    }

    pub fn delete_memo(&mut self, id: &str) -> Result<(), WorkspaceError> {
        let file = self.entry(id)?.file.clone();
        match fs::remove_file(self.root.join(file)) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        self.index.remove(id);
        self.index.save()?;
        Ok(())
    }

    /// Copies `contents` in as a new memo named `file_name` (`a.sh`, `a 2.sh`, …). The person
    /// chose that name, so automatic titles stay off.
    pub fn import_memo(&mut self, file_name: &str, contents: &[u8]) -> Result<MemoInfo, WorkspaceError> {
        if !is_valid_file_name(file_name) {
            return Err(WorkspaceError::InvalidName(file_name.to_string()));
        }
        let (stem, ext) = split_name(file_name);
        let file = self.free_name(stem, ext, None);
        self.add_memo(file, false, contents)
    }

    /// `import_memo` with the bytes and the name of a file on disk; the file itself is not touched.
    pub fn import_file(&mut self, path: &Path) -> Result<MemoInfo, WorkspaceError> {
        let contents = fs::read(path)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| WorkspaceError::InvalidName(path.display().to_string()))?;
        self.import_memo(name, &contents)
    }

    fn add_memo(&mut self, file: String, auto_title: bool, contents: &[u8]) -> Result<MemoInfo, WorkspaceError> {
        atomic_write(&self.root.join(&file), contents)?;
        let id = uuid::Uuid::new_v4().to_string();
        self.index.insert(id.clone(), MemoEntry { file, auto_title, language: None });
        self.index.save()?;
        self.memo_info(&id)
    }

    fn move_memo(&mut self, id: &str, from: &str, to: String, auto_title: bool) -> Result<MemoInfo, WorkspaceError> {
        if from != to {
            fs::rename(self.root.join(from), self.root.join(&to))?;
        }
        if let Some(entry) = self.index.get_mut(id) {
            entry.file = to;
            entry.auto_title = auto_title;
        }
        self.index.save()?;
        self.memo_info(id)
    }

    /// `stem.ext`, then `stem 2.ext`, … — the first name no other file in the folder uses. The
    /// file system decides what "uses" means: on APFS `Memo.md`, `memo.md` and a decomposed
    /// Hangul spelling all collide. `own` (the memo's current file) never counts as taken, which
    /// lets a memo change only the case of its name.
    fn free_name(&self, stem: &str, ext: &str, own: Option<&str>) -> String {
        let own = own.map(|file| self.root.join(file));
        unique_file_name(stem, ext, |candidate| {
            let path = self.root.join(candidate);
            path.symlink_metadata().is_ok() && own.as_deref().is_none_or(|own| !same_file(own, &path))
        })
    }
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    a == b
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: `test result: ok. 46 passed`(이전 35 + ops 11; macOS 가 아니면 NFD 테스트가 빠져 45).

- [ ] **Step 5: 포맷·검사·커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
git add src-tauri/src/workspace/mod.rs src-tauri/src/workspace/ops.rs
git commit -m "feat(workspace): create, save, retitle, rename, delete and import memos by ID"
```

---

### Task 5: 세션 파일, 저장 전 수정분, 외부 파일

**Files:**

- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/persist/mod.rs`(`pub mod external;`)
- Create: `src-tauri/src/session/mod.rs`, `src-tauri/src/session/drafts.rs`, `src-tauri/src/persist/external.rs`

**Interfaces:**

- Consumes: Task 1·2 `persist`, Task 3 `TOTE_DIR`·`kind_for`·`FileKind`.
- Produces (`crate::session`): `session_file(root, device_id) -> PathBuf`, `read_session(root, device_id) -> io::Result<Option<String>>`, `write_session(root, device_id, json: &str) -> io::Result<()>`(JSON 객체가 아니면 `InvalidData`), `WindowFrame { x, y, width, height: f64 }`, `read_window_frame(root, device_id) -> Option<WindowFrame>`.
- Produces (`crate::session::drafts`): `DraftHeader { version: u32, path: PathBuf, base_hash: Option<String> }`, `DraftStore::new(dir: PathBuf)`, `put(path, base_hash: Option<&str>, contents) -> io::Result<()>`, `get(path) -> io::Result<Option<(DraftHeader, Vec<u8>)>>`, `remove(path) -> io::Result<()>`.
- Produces (`crate::persist::external`): `ExternalInfo { path, exists, size, kind: FileKind, draft: Option<DraftInfo> }`, `DraftInfo { disk_changed: bool }`(JSON camelCase), `ExternalFiles::new(DraftStore)`, `open(path) -> io::Result<ExternalInfo>`(폴더면 `InvalidInput`), `read(path) -> io::Result<Vec<u8>>`(없으면 빈 내용), `read_draft(path)`, `keep_draft(path, contents)`, `discard_draft(path)`, `save(path, contents) -> io::Result<u64>`.

- [ ] **Step 1: 실패하는 테스트 작성**

`lib.rs` 에 `pub mod session;` 을, `persist/mod.rs` 의 `//!` 모듈 문서 바로 아래에 `pub mod external;` 을 넣는다(`//!` 보다 앞에 두면 E0753 으로 컴파일되지 않는다). 세 파일을 테스트만 담아 만든다(`session/mod.rs` 는 `pub mod drafts;` 선언도 둔다).

`src-tauri/src/session/mod.rs`:

```rust
pub mod drafts;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn sessions_round_trip_per_device() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(read_session(root.path(), "d1").unwrap(), None);
        write_session(root.path(), "d1", r#"{"version":1,"tabs":[]}"#).unwrap();
        let text = read_session(root.path(), "d1").unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(read_session(root.path(), "d2").unwrap(), None);
        assert!(session_file(root.path(), "d1").ends_with(".tote/sessions/d1.json"));
    }

    #[test]
    fn only_json_objects_are_written() {
        let root = tempfile::tempdir().unwrap();
        let err = write_session(root.path(), "d", "[1,2]").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn an_unreadable_session_starts_empty_and_is_set_aside() {
        let root = tempfile::tempdir().unwrap();
        let file = session_file(root.path(), "d");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "{ broken").unwrap();
        assert_eq!(read_session(root.path(), "d").unwrap(), None);
        assert!(!file.exists());
    }

    #[test]
    fn the_window_frame_is_read_when_usable() {
        let root = tempfile::tempdir().unwrap();
        write_session(root.path(), "d", r#"{"window":{"x":10,"y":20,"width":900,"height":700}}"#).unwrap();
        assert_eq!(
            read_window_frame(root.path(), "d"),
            Some(WindowFrame { x: 10.0, y: 20.0, width: 900.0, height: 700.0 })
        );
        write_session(root.path(), "d", r#"{"window":{"x":0,"y":0,"width":20,"height":20}}"#).unwrap();
        assert_eq!(read_window_frame(root.path(), "d"), None);
        write_session(root.path(), "d", r#"{"tabs":[]}"#).unwrap();
        assert_eq!(read_window_frame(root.path(), "d"), None);
    }
}
```

`src-tauri/src/session/drafts.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn drafts_round_trip_and_go_away() {
        let dir = tempfile::tempdir().unwrap();
        let store = DraftStore::new(dir.path().join("buffers"));
        let path = Path::new("/Users/me/스크립트/배포.sh");
        assert_eq!(store.get(path).unwrap(), None);
        store.put(path, Some("abc"), "echo 수정\n".as_bytes()).unwrap();
        let (header, contents) = store.get(path).unwrap().unwrap();
        assert_eq!(header.path, path);
        assert_eq!(header.base_hash.as_deref(), Some("abc"));
        assert_eq!(contents, "echo 수정\n".as_bytes());
        store.remove(path).unwrap();
        store.remove(path).unwrap();
        assert_eq!(store.get(path).unwrap(), None);
    }

    #[test]
    fn a_draft_for_a_file_that_did_not_exist_has_no_base() {
        let dir = tempfile::tempdir().unwrap();
        let store = DraftStore::new(dir.path().to_path_buf());
        store.put(Path::new("/new.txt"), None, b"").unwrap();
        let (header, contents) = store.get(Path::new("/new.txt")).unwrap().unwrap();
        assert_eq!(header.base_hash, None);
        assert!(contents.is_empty());
    }

    #[test]
    fn an_unreadable_draft_reads_as_none_and_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let store = DraftStore::new(dir.path().to_path_buf());
        let path = Path::new("/a.txt");
        store.put(path, None, b"x").unwrap();
        let file = fs::read_dir(dir.path()).unwrap().next().unwrap().unwrap().path();
        fs::write(&file, "no header line").unwrap();
        assert_eq!(store.get(path).unwrap(), None);
        assert!(!file.exists());
    }
}
```

`src-tauri/src/persist/external.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn files(dir: &Path) -> ExternalFiles {
        ExternalFiles::new(DraftStore::new(dir.join("buffers")))
    }

    #[test]
    fn a_missing_path_opens_empty_and_save_creates_it() {
        let dir = tempfile::tempdir().unwrap();
        let ext = files(dir.path());
        let path = dir.path().join("새 파일.txt");
        let info = ext.open(&path).unwrap();
        assert!(!info.exists);
        assert_eq!(info.draft, None);
        assert!(ext.read(&path).unwrap().is_empty());
        assert_eq!(ext.save(&path, "처음".as_bytes()).unwrap(), 6);
        assert_eq!(fs::read_to_string(&path).unwrap(), "처음");
    }

    #[test]
    fn a_draft_survives_a_restart_and_notices_disk_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "disk").unwrap();
        let before = files(dir.path());
        before.open(&path).unwrap();
        before.keep_draft(&path, b"edited").unwrap();

        let after = files(dir.path()); // a new process: nothing remembered in memory
        let info = after.open(&path).unwrap();
        assert_eq!(info.draft, Some(DraftInfo { disk_changed: false }));
        assert_eq!(after.read_draft(&path).unwrap(), b"edited");

        fs::write(&path, "someone else").unwrap();
        let info = files(dir.path()).open(&path).unwrap();
        assert_eq!(info.draft, Some(DraftInfo { disk_changed: true }));
    }

    #[test]
    fn saving_or_discarding_removes_the_draft() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "disk").unwrap();
        let ext = files(dir.path());
        ext.open(&path).unwrap();
        ext.keep_draft(&path, b"edited").unwrap();
        ext.save(&path, b"edited").unwrap();
        assert_eq!(ext.open(&path).unwrap().draft, None);
        ext.keep_draft(&path, b"again").unwrap();
        ext.discard_draft(&path).unwrap();
        assert_eq!(ext.open(&path).unwrap().draft, None);
        assert_eq!(fs::read_to_string(&path).unwrap(), "edited");
    }

    #[cfg(unix)]
    #[test]
    fn saving_keeps_an_executable_script_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deploy.sh");
        fs::write(&path, "echo old\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let ext = files(dir.path());
        ext.open(&path).unwrap();
        ext.save(&path, b"echo new\n").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o755);
    }

    #[test]
    fn folders_and_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let ext = files(dir.path());
        assert_eq!(ext.open(dir.path()).unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
        let photo = dir.path().join("사진.png");
        fs::write(&photo, [0u8, 1, 2]).unwrap();
        let info = ext.open(&photo).unwrap();
        assert_eq!((info.kind, info.size), (FileKind::Image, 3));
    }
}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- session external
```

Expected: `cannot find function read_session`, `cannot find type DraftStore` 등으로 컴파일 실패.

- [ ] **Step 3: 구현**

`src-tauri/src/session/mod.rs` 의 맨 위, 즉 `pub mod …;` 선언보다 앞(`//!` 모듈 문서가 선언 뒤에 오면 E0753 으로 컴파일되지 않는다). 선언은 아래 `use` 들 뒤에 둔다. 테스트 위:

```rust
//! Per-device session files, `.tote/sessions/<device ID>.json` (spec 「세션」). The frontend owns
//! their schema (`SessionFile` in src/core/session.ts); this side only checks that they are JSON
//! objects and reads the window frame, which it needs before the window — and so its frontend —
//! exists.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::persist::{read_json, write_json};
use crate::workspace::TOTE_DIR;

pub fn session_file(root: &Path, device_id: &str) -> PathBuf {
    root.join(TOTE_DIR)
        .join("sessions")
        .join(format!("{device_id}.json"))
}

/// The session text, or `None` when this device has none for the workspace yet. An unreadable
/// file is set aside and the window starts with no tabs.
pub fn read_session(root: &Path, device_id: &str) -> io::Result<Option<String>> {
    Ok(read_json::<Map<String, Value>>(&session_file(root, device_id))?
        .map(|map| Value::Object(map).to_string()))
}

pub fn write_session(root: &Path, device_id: &str, json: &str) -> io::Result<()> {
    let map: Map<String, Value> = serde_json::from_str(json)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    write_json(&session_file(root, device_id), &map)
}

/// Where a workspace window was, in logical pixels (outer position, inner size).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The saved window frame when the session has a usable one.
pub fn read_window_frame(root: &Path, device_id: &str) -> Option<WindowFrame> {
    let text = fs::read_to_string(session_file(root, device_id)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let frame: WindowFrame = serde_json::from_value(value.get("window")?.clone()).ok()?;
    let finite = [frame.x, frame.y, frame.width, frame.height]
        .iter()
        .all(|v| v.is_finite());
    (finite && frame.width >= 200.0 && frame.height >= 150.0).then_some(frame)
}
```

`src-tauri/src/session/drafts.rs` 의 테스트 위:

```rust
//! Unsaved edits of external files, kept on this device only (`buffers/` in the app data folder)
//! until the person saves or discards them (spec 「저장」). One file per path — a JSON header line,
//! then the edited bytes — so one atomic write keeps header and contents together.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::persist::{atomic_write, content_hash, set_aside};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftHeader {
    pub version: u32,
    pub path: PathBuf,
    /// Hash of the file on disk when editing started; `None` when it did not exist yet.
    pub base_hash: Option<String>,
}

pub struct DraftStore {
    dir: PathBuf,
}

impl DraftStore {
    pub fn new(dir: PathBuf) -> DraftStore {
        DraftStore { dir }
    }

    pub fn put(&self, path: &Path, base_hash: Option<&str>, contents: &[u8]) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let header = DraftHeader {
            version: 1,
            path: path.to_path_buf(),
            base_hash: base_hash.map(str::to_string),
        };
        let mut bytes = serde_json::to_vec(&header)?;
        bytes.push(b'\n');
        bytes.extend_from_slice(contents);
        atomic_write(&self.file_for(path), &bytes)
    }

    pub fn get(&self, path: &Path) -> io::Result<Option<(DraftHeader, Vec<u8>)>> {
        let file = self.file_for(path);
        let bytes = match fs::read(&file) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        let parsed = bytes.iter().position(|&b| b == b'\n').and_then(|end| {
            let header: DraftHeader = serde_json::from_slice(&bytes[..end]).ok()?;
            Some((header, bytes[end + 1..].to_vec()))
        });
        match parsed {
            // The path check guards against two paths whose hashes share the file-name prefix.
            Some((header, contents)) if header.path == path => Ok(Some((header, contents))),
            Some(_) => Ok(None),
            None => {
                set_aside(&file)?;
                Ok(None)
            }
        }
    }

    pub fn remove(&self, path: &Path) -> io::Result<()> {
        match fs::remove_file(self.file_for(path)) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        }
    }

    fn file_for(&self, path: &Path) -> PathBuf {
        let hash = content_hash(path.as_os_str().as_encoded_bytes());
        self.dir.join(format!("{}.draft", &hash[..32]))
    }
}
```

`src-tauri/src/persist/external.rs` 의 테스트 위:

```rust
//! External files: anything opened from outside the workspace. Written only on ⌘S; edits in
//! between live in drafts. The hash of the file when editing started travels with the draft, so
//! a restored draft can tell whether the file changed on disk meanwhile.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::{atomic_write, content_hash};
use crate::session::drafts::DraftStore;
use crate::workspace::{kind_for, FileKind};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalInfo {
    pub path: PathBuf,
    pub exists: bool,
    pub size: u64,
    pub kind: FileKind,
    pub draft: Option<DraftInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInfo {
    /// The file on disk changed after the edits in the draft started.
    pub disk_changed: bool,
}

pub struct ExternalFiles {
    drafts: DraftStore,
    /// Hash of each open file when editing started (`None`: it did not exist yet).
    bases: Mutex<HashMap<PathBuf, Option<String>>>,
}

impl ExternalFiles {
    pub fn new(drafts: DraftStore) -> ExternalFiles {
        ExternalFiles { drafts, bases: Mutex::new(HashMap::new()) }
    }

    /// Looks at the file and remembers what it looked like when editing starts. A waiting draft
    /// keeps the base it was made against.
    pub fn open(&self, path: &Path) -> io::Result<ExternalInfo> {
        let meta = match fs::metadata(path) {
            Ok(meta) => Some(meta),
            Err(err) if err.kind() == io::ErrorKind::NotFound => None,
            Err(err) => return Err(err),
        };
        if meta.as_ref().is_some_and(|m| m.is_dir()) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "a folder is not a file"));
        }
        let disk_hash = match meta {
            Some(_) => Some(content_hash(&fs::read(path)?)),
            None => None,
        };
        let (base, draft) = match self.drafts.get(path)? {
            Some((header, _)) => {
                let changed = header.base_hash != disk_hash;
                (header.base_hash, Some(DraftInfo { disk_changed: changed }))
            }
            None => (disk_hash, None),
        };
        self.bases_lock().insert(path.to_path_buf(), base);
        Ok(ExternalInfo {
            path: path.to_path_buf(),
            exists: meta.is_some(),
            size: meta.map_or(0, |m| m.len()),
            kind: kind_for(&path.file_name().unwrap_or_default().to_string_lossy()),
            draft,
        })
    }

    /// The file's bytes; a path that does not exist yet reads as empty.
    pub fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        match fs::read(path) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
            other => other,
        }
    }

    pub fn read_draft(&self, path: &Path) -> io::Result<Vec<u8>> {
        self.drafts
            .get(path)?
            .map(|(_, contents)| contents)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no draft"))
    }

    pub fn keep_draft(&self, path: &Path, contents: &[u8]) -> io::Result<()> {
        let remembered = self.bases_lock().get(path).cloned();
        let base = match remembered {
            Some(base) => base,
            None => fs::read(path).ok().map(|bytes| content_hash(&bytes)),
        };
        self.drafts.put(path, base.as_deref(), contents)
    }

    pub fn discard_draft(&self, path: &Path) -> io::Result<()> {
        self.drafts.remove(path)
    }

    /// ⌘S: writes the file (creating it if needed), drops the draft, and makes the saved contents
    /// the new base.
    pub fn save(&self, path: &Path, contents: &[u8]) -> io::Result<u64> {
        atomic_write(path, contents)?;
        self.drafts.remove(path)?;
        self.bases_lock()
            .insert(path.to_path_buf(), Some(content_hash(contents)));
        Ok(contents.len() as u64)
    }

    fn bases_lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Option<String>>> {
        self.bases.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: `test result: ok. 58 passed`(이전 46 + session 4, drafts 3, external 5).

- [ ] **Step 5: 포맷·검사·커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
git add src-tauri/src/lib.rs src-tauri/src/persist src-tauri/src/session
git commit -m "feat(session): session files, drafts of external files and ⌘S saving"
```

---

### Task 6: `tote` CLI — 인자 해석, 앱에 넘기기, 셸 명령 설치

**Files:**

- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/cli/mod.rs`, `src-tauri/src/cli/front.rs`, `src-tauri/src/cli/install.rs`, `src-tauri/resources/tote`

**Interfaces:**

- Consumes: Task 2 `AppPaths`·`Settings`, Task 3 `Workspace::is_workspace`·`names::is_valid_file_name`, Task 1 `atomic_write`.
- Produces (`crate::cli`):
  - `REQUEST_FLAG = "--tote-request="`, `USAGE: &str`.
  - `CliRequest { workspace: Option<String>, files: Vec<PathBuf>, import: bool, stdin_file: Option<PathBuf> }`(JSON camelCase), `to_arg(&self) -> String`, `find_in(args) -> Option<CliRequest>`.
  - `parse_args(&[String]) -> Result<Parsed, UsageError>`, `enum Parsed { Help, Run { workspace, paths, import, stdin } }`.
  - `absolute(cwd: &Path, path: &str) -> PathBuf`, `resolve(workspace, paths, import, cwd, workspace_root) -> Result<Resolved, String>`, `Resolved { request: CliRequest, rejected: Vec<String> }`.
- Produces (`crate::cli::front`): `run_if_cli() -> Option<i32>`(`TOTE_CLI=1` 일 때만), `app_bundle(exe: &Path) -> Option<PathBuf>`.
- Produces (`crate::cli::install`): `install(script, preferred, fallback) -> io::Result<Installed>`, `enum Installed { Preferred(PathBuf), Fallback(PathBuf) }`.
- 요청이 앱에 닿는 길: 새로 뜨는 앱의 argv, 또는 실행 중인 앱의 단일 인스턴스 콜백 argv 안의 `--tote-request=<json>` 한 개. 처리는 Task 8 `requests::handle`.

- [ ] **Step 1: 실패하는 테스트 작성**

`lib.rs` 에 `pub mod cli;` 를 넣는다. 세 파일을 테스트만 담아 만든다(`cli/mod.rs` 는 `pub mod front; pub mod install;` 선언도 둔다).

`src-tauri/src/cli/mod.rs`:

```rust
pub mod front;
pub mod install;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn options_and_paths() {
        assert_eq!(
            parse_args(&args(&["-w", "업무", "--import", "a.sh", "-", "--", "-x.txt"])).unwrap(),
            Parsed::Run {
                workspace: Some("업무".into()),
                paths: args(&["a.sh", "-x.txt"]),
                import: true,
                stdin: true
            }
        );
        assert_eq!(
            parse_args(&[]).unwrap(),
            Parsed::Run { workspace: None, paths: vec![], import: false, stdin: false }
        );
        assert_eq!(parse_args(&args(&["--help"])).unwrap(), Parsed::Help);
        assert_eq!(parse_args(&args(&["-w"])), Err(UsageError::MissingWorkspace));
        assert_eq!(
            parse_args(&args(&["--wait"])),
            Err(UsageError::UnknownOption("--wait".into()))
        );
    }

    #[test]
    fn relative_paths_resolve_against_the_calling_folder() {
        let cwd = Path::new("/Users/me/작업");
        assert_eq!(absolute(cwd, "a.sh"), PathBuf::from("/Users/me/작업/a.sh"));
        assert_eq!(absolute(cwd, "../b/./c.md"), PathBuf::from("/Users/me/b/c.md"));
        assert_eq!(absolute(cwd, "/etc/hosts"), PathBuf::from("/etc/hosts"));
        assert_eq!(absolute(Path::new("/"), "../../x"), PathBuf::from("/x"));
    }

    #[test]
    fn folders_are_rejected_one_by_one() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("폴더")).unwrap();
        fs::write(dir.path().join("a.sh"), "").unwrap();
        let resolved =
            resolve(None, &args(&["a.sh", "폴더", "없는.txt"]), false, dir.path(), dir.path()).unwrap();
        assert_eq!(
            resolved.request.files,
            vec![dir.path().join("a.sh"), dir.path().join("없는.txt")]
        );
        assert_eq!(resolved.rejected.len(), 1);
        assert!(resolved.rejected[0].contains("폴더는 열 수 없습니다"));
    }

    #[test]
    fn importing_needs_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = resolve(None, &args(&["없음.txt"]), true, dir.path(), dir.path()).unwrap();
        assert!(resolved.request.files.is_empty());
        assert_eq!(resolved.rejected.len(), 1);
    }

    #[test]
    fn an_unknown_workspace_stops_everything() {
        let root = tempfile::tempdir().unwrap();
        crate::workspace::Workspace::create(root.path(), "업무").unwrap();
        assert!(resolve(Some("업무".into()), &[], false, root.path(), root.path()).is_ok());
        assert!(resolve(Some("없는곳".into()), &[], false, root.path(), root.path()).is_err());
        assert!(resolve(Some("../업무".into()), &[], false, root.path(), root.path()).is_err());
    }

    #[test]
    fn requests_survive_the_trip_through_argv() {
        let request = CliRequest {
            workspace: Some("업무".into()),
            files: vec!["/a b/파일.sh".into()],
            import: true,
            stdin_file: None,
        };
        let argv = vec!["/Applications/tote.app/Contents/MacOS/tote".to_string(), request.to_arg()];
        assert_eq!(CliRequest::find_in(&argv), Some(request));
        assert_eq!(CliRequest::find_in(["tote"]), None);
    }
}
```

`src-tauri/src/cli/front.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_bundle_around_the_binary() {
        assert_eq!(
            app_bundle(Path::new("/Applications/tote.app/Contents/MacOS/tote")),
            Some(PathBuf::from("/Applications/tote.app"))
        );
        assert_eq!(app_bundle(Path::new("/repo/src-tauri/target/debug/tote")), None);
    }
}
```

`src-tauri/src/cli/install.rs`:

```rust
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &Path) -> PathBuf {
        let script = dir.join("bin-tote");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        script
    }

    #[test]
    fn links_into_the_preferred_folder() {
        let dir = tempfile::tempdir().unwrap();
        let script = script(dir.path());
        let preferred = dir.path().join("usr-local-bin");
        fs::create_dir(&preferred).unwrap();
        assert_eq!(
            install(&script, &preferred, &dir.path().join("fallback")).unwrap(),
            Installed::Preferred(preferred.join("tote"))
        );
        assert_eq!(fs::read_link(preferred.join("tote")).unwrap(), script);
    }

    #[test]
    fn falls_back_when_the_preferred_folder_is_locked_or_missing() {
        let dir = tempfile::tempdir().unwrap();
        let script = script(dir.path());
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        let fallback = dir.path().join("home/.local/bin");
        let result = install(&script, &locked, &fallback);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result.unwrap(), Installed::Fallback(fallback.join("tote")));
        assert_eq!(
            install(&script, &dir.path().join("missing"), &fallback).unwrap(),
            Installed::Fallback(fallback.join("tote"))
        );
    }

    #[test]
    fn replaces_an_old_link_but_never_a_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let script = script(dir.path());
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        std::os::unix::fs::symlink("/old/place", bin.join("tote")).unwrap();
        install(&script, &bin, &dir.path().join("fb")).unwrap();
        assert_eq!(fs::read_link(bin.join("tote")).unwrap(), script);
        fs::remove_file(bin.join("tote")).unwrap();
        fs::write(bin.join("tote"), "someone else's").unwrap();
        let err = install(&script, &bin, &dir.path().join("fb")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
    }
}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml cli
```

Expected: `cannot find function parse_args` 등으로 컴파일 실패.

- [ ] **Step 3: 구현**

`src-tauri/src/cli/mod.rs` 의 맨 위, 즉 `pub mod …;` 선언보다 앞(`//!` 모듈 문서가 선언 뒤에 오면 E0753 으로 컴파일되지 않는다). 선언은 아래 `use` 들 뒤에 둔다. 테스트 위:

```rust
//! The `tote` shell command (spec 「`tote` CLI」). The script in the app bundle runs the app binary
//! with `TOTE_CLI=1`; that process checks the arguments, prints problems to stderr, hands a
//! `CliRequest` to the app (starting it when needed) and exits — the shell never waits for tote.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::workspace::names::is_valid_file_name;
use crate::workspace::Workspace;

/// A request travels as one argument, `--tote-request=<json>`: in the app's own argv on a fresh
/// launch, or in the argv single-instance forwards to a running app.
pub const REQUEST_FLAG: &str = "--tote-request=";

pub const USAGE: &str = "사용법: tote [-w 워크스페이스] [--import] [파일…] [-]
  tote                 앱을 앞으로 가져온다
  tote a.sh b.md       가장 최근 창에 외부 탭으로 연다
  tote -w 업무 a.sh    그 워크스페이스에 연다
  tote --import a.sh   워크스페이스로 복사해 메모로 연다
  echo 내용 | tote -   표준 입력으로 새 메모를 만든다";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRequest {
    /// Folder name under the workspace root (`-w`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// Absolute paths; folders were already turned away.
    #[serde(default)]
    pub files: Vec<PathBuf>,
    #[serde(default)]
    pub import: bool,
    /// Text read from stdin (`tote -`), parked in a file under the app data folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin_file: Option<PathBuf>,
}

impl CliRequest {
    pub fn to_arg(&self) -> String {
        let json = serde_json::to_string(self).expect("plain data always serialises");
        format!("{REQUEST_FLAG}{json}")
    }

    pub fn find_in<I, S>(args: I) -> Option<CliRequest>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        args.into_iter().find_map(|arg| {
            let json = arg.as_ref().strip_prefix(REQUEST_FLAG)?;
            serde_json::from_str(json).ok()
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum Parsed {
    Help,
    Run {
        workspace: Option<String>,
        paths: Vec<String>,
        import: bool,
        stdin: bool,
    },
}

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum UsageError {
    #[error("알 수 없는 옵션: {0}")]
    UnknownOption(String),
    #[error("-w 뒤에 워크스페이스 이름이 필요합니다")]
    MissingWorkspace,
}

pub fn parse_args(args: &[String]) -> Result<Parsed, UsageError> {
    let mut workspace = None;
    let mut paths = Vec::new();
    let (mut import, mut stdin, mut only_paths) = (false, false, false);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if only_paths {
            paths.push(arg.clone());
            continue;
        }
        match arg.as_str() {
            "-h" | "--help" => return Ok(Parsed::Help),
            "-w" | "--workspace" => {
                workspace = Some(args.next().ok_or(UsageError::MissingWorkspace)?.clone())
            }
            "--import" => import = true,
            "-" => stdin = true,
            "--" => only_paths = true,
            option if option.starts_with('-') => {
                return Err(UsageError::UnknownOption(option.to_string()))
            }
            _ => paths.push(arg.clone()),
        }
    }
    Ok(Parsed::Run { workspace, paths, import, stdin })
}

/// `cwd.join(path)` with `.` and `..` folded away without touching the disk: the path may not
/// exist yet (`tote new.txt` creates it on ⌘S), and links stay as the person typed them.
pub fn absolute(cwd: &Path, path: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in cwd.join(path).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub struct Resolved {
    pub request: CliRequest,
    /// Lines for stderr; any of them makes the exit code 1.
    pub rejected: Vec<String>,
}

/// Checks the arguments before the app sees them, because only this process can still answer the
/// shell. An unknown `-w` workspace stops everything; folders are turned away one by one.
pub fn resolve(
    workspace: Option<String>,
    paths: &[String],
    import: bool,
    cwd: &Path,
    workspace_root: &Path,
) -> Result<Resolved, String> {
    if let Some(name) = &workspace {
        if !is_valid_file_name(name) || !Workspace::is_workspace(&workspace_root.join(name)) {
            return Err(format!("워크스페이스가 없습니다: {name}"));
        }
    }
    let mut files = Vec::new();
    let mut rejected = Vec::new();
    for path in paths {
        let path = absolute(cwd, path);
        if path.is_dir() {
            rejected.push(format!("폴더는 열 수 없습니다: {}", path.display()));
        } else if import && !path.is_file() {
            rejected.push(format!("가져올 파일이 없습니다: {}", path.display()));
        } else {
            files.push(path);
        }
    }
    Ok(Resolved {
        request: CliRequest { workspace, files, import, stdin_file: None },
        rejected,
    })
}
```

`src-tauri/src/cli/front.rs` 의 테스트 위:

```rust
//! What runs when the `tote` script starts the app binary.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::{parse_args, resolve, CliRequest, Parsed, USAGE};
use crate::appdata::{AppPaths, Settings};
use crate::persist::atomic_write;

/// Runs the command line when the `tote` script started this binary (`TOTE_CLI=1`). Returns the
/// exit code, or `None` to start the app as usual.
pub fn run_if_cli() -> Option<i32> {
    if std::env::var_os("TOTE_CLI").as_deref() != Some(OsStr::new("1")) {
        return None;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    Some(run(&args))
}

fn run(args: &[String]) -> i32 {
    let (workspace, paths, import, stdin) = match parse_args(args) {
        Ok(Parsed::Run { workspace, paths, import, stdin }) => (workspace, paths, import, stdin),
        Ok(Parsed::Help) => {
            println!("{USAGE}");
            return 0;
        }
        Err(err) => {
            eprintln!("tote: {err}\n{USAGE}");
            return 2;
        }
    };
    let Some(app_paths) = AppPaths::resolve() else {
        eprintln!("tote: 앱 데이터 폴더를 찾지 못했습니다");
        return 1;
    };
    let root = Settings::load(&app_paths.settings_file())
        .unwrap_or_default()
        .workspace_root(&app_paths);
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(err) => {
            eprintln!("tote: 현재 폴더를 알 수 없습니다: {err}");
            return 1;
        }
    };
    let mut resolved = match resolve(workspace, &paths, import, &cwd, &root) {
        Ok(resolved) => resolved,
        Err(message) => {
            eprintln!("tote: {message}");
            return 1;
        }
    };
    for message in &resolved.rejected {
        eprintln!("tote: {message}");
    }
    if stdin {
        match park_stdin(&app_paths.inbox_dir()) {
            Ok(file) => resolved.request.stdin_file = Some(file),
            Err(err) => {
                eprintln!("tote: 표준 입력을 읽지 못했습니다: {err}");
                return 1;
            }
        }
    }
    if let Err(err) = launch(&resolved.request) {
        eprintln!("tote: 앱을 실행하지 못했습니다: {err}");
        return 1;
    }
    i32::from(!resolved.rejected.is_empty())
}

fn park_stdin(dir: &Path) -> io::Result<PathBuf> {
    let mut text = Vec::new();
    io::stdin().read_to_end(&mut text)?;
    std::fs::create_dir_all(dir)?;
    let file = dir.join(format!("{}.txt", uuid::Uuid::new_v4().simple()));
    atomic_write(&file, &text)?;
    Ok(file)
}

/// Hands the request to the app. Inside an app bundle this goes through LaunchServices
/// (`open -n`): the new process passes the request to a running tote through single-instance and
/// exits, or becomes tote when none runs. A development binary outside a bundle is started
/// directly, in its own process group so closing the terminal does not take tote with it.
fn launch(request: &CliRequest) -> io::Result<()> {
    let exe = std::env::current_exe()?;
    if let Some(bundle) = app_bundle(&exe) {
        let status = Command::new("open")
            .arg("-n")
            .arg(&bundle)
            .arg("--args")
            .arg(request.to_arg())
            .status()?;
        return if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("open: {status}")))
        };
    }
    let mut command = Command::new(exe);
    command
        .arg(request.to_arg())
        .env_remove("TOTE_CLI")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map(|_| ())
}

/// `/Applications/tote.app` for a binary at `/Applications/tote.app/Contents/MacOS/tote`.
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    is_bundle.then(|| bundle.to_path_buf())
}
```

`src-tauri/src/cli/install.rs` 의 테스트 위:

```rust
//! 「셸 명령 설치」: a `tote` symlink to the script inside the app bundle (spec 「`tote` CLI」).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum Installed {
    /// In the preferred folder, which shells have on PATH.
    Preferred(PathBuf),
    /// In the fallback folder, which the person may still have to put on PATH.
    Fallback(PathBuf),
}

/// Links `<preferred>/tote` to `script`, or `<fallback>/tote` (creating the folder) when the
/// preferred folder is missing or not writable — `/usr/local/bin` needs admin rights on many Macs.
pub fn install(script: &Path, preferred: &Path, fallback: &Path) -> io::Result<Installed> {
    let target = preferred.join("tote");
    match link(script, &target) {
        Ok(()) => return Ok(Installed::Preferred(target)),
        Err(err)
            if matches!(err.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound) => {}
        Err(err) => return Err(err),
    }
    fs::create_dir_all(fallback)?;
    let target = fallback.join("tote");
    link(script, &target)?;
    Ok(Installed::Fallback(target))
}

/// Replaces an earlier `tote` link (the app moved) but never a file someone else put there.
fn link(script: &Path, at: &Path) -> io::Result<()> {
    match fs::symlink_metadata(at) {
        Ok(meta) if meta.file_type().is_symlink() => fs::remove_file(at)?,
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} 가 이미 있고 tote 가 만든 것이 아닙니다", at.display()),
            ))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(script, at)
    }
    #[cfg(not(unix))]
    {
        let _ = script;
        Err(io::Error::new(io::ErrorKind::Unsupported, "macOS only for now"))
    }
}
```

`src-tauri/src/main.rs`:

```rust
// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The `tote` script runs this binary with TOTE_CLI=1: check the arguments, hand them to the
    // app and exit, instead of starting a second app.
    if let Some(code) = tote_lib::cli::front::run_if_cli() {
        std::process::exit(code);
    }
    tote_lib::run()
}
```

`src-tauri/resources/tote`:

```sh
#!/bin/sh
# The `tote` shell command, installed as a symlink to this file inside tote.app. It runs the app
# binary in command-line mode (src-tauri/src/cli/front.rs), which checks the arguments and hands
# them to the app.
self="$(readlink -f "$0")"
exec env TOTE_CLI=1 "$(dirname "$self")/../../MacOS/tote" "$@"
```

```bash
chmod +x src-tauri/resources/tote
```

`src-tauri/tauri.conf.json` 의 `bundle` 에 넣는다(번들 안 `Contents/Resources/bin/tote` 가 된다. 실행 파일은 Cargo 바이너리 이름 `tote` 그대로 `Contents/MacOS/tote` 다).

```json
    "resources": { "resources/tote": "bin/tote" },
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: `test result: ok. 68 passed`(이전 58 + cli 6, front 1, install 3).

- [ ] **Step 5: 앱을 띄우지 않는 경로를 실제로 돌려 본다**

```bash
cargo build --manifest-path src-tauri/Cargo.toml
BIN=src-tauri/target/debug/tote
TOTE_CLI=1 "$BIN" --help; echo "exit=$?"
TOTE_CLI=1 TOTE_DATA_DIR="$(mktemp -d)" "$BIN" -w 없는곳 a.txt; echo "exit=$?"
TOTE_CLI=1 "$BIN" --wait; echo "exit=$?"
```

Expected: 사용법이 찍히고 `exit=0`, `tote: 워크스페이스가 없습니다: 없는곳` 과 `exit=1`, `tote: 알 수 없는 옵션: --wait` 과 `exit=2`. 셋 다 앱 창이 뜨지 않는다.

- [ ] **Step 6: 포맷·검사·커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm exec oxfmt src-tauri/tauri.conf.json
git add src-tauri/src/lib.rs src-tauri/src/main.rs src-tauri/src/cli src-tauri/resources/tote src-tauri/tauri.conf.json
git commit -m "feat(cli): parse tote arguments, hand them to the app and install the shell command"
```

---

### Task 7: 앱 상태와 「쓰고 닫기」 장부

**Files:**

- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/app/mod.rs`, `src-tauri/src/app/flush.rs`

**Interfaces:**

- Consumes: Task 2 `appdata`, Task 3 `Workspace`, Task 5 `ExternalFiles`·`DraftStore`, Task 1 `content_hash`.
- Produces (`crate::app::flush`): `enum FlushGoal { CloseWindow(String), Quit }`, `enum Begin { Started { id: u64, windows: Vec<String> }, Done(FlushGoal), AlreadyRunning }`, `FlushCoordinator::{begin(goal, windows) -> Begin, ack(id, window) -> Option<FlushGoal>, expire(id) -> Option<FlushGoal>, window_gone(window) -> Vec<FlushGoal>}`.
- Produces (`crate::app`):
  - `lock<T>(&Mutex<T>) -> MutexGuard<T>`(독이 든 잠금도 연다).
  - `enum PendingOpen { Memo { id }, External { path } }` — JSON `{"kind":"memo","id":…}` / `{"kind":"external","path":…}`.
  - `struct AppCore { paths, machine, workspace_root, external, … }` — `load() -> Result<AppCore, String>`, `new(paths, machine, &settings, launch)`, `label_for(path) -> String`(`ws-` + 경로 해시 16자), `register(label, Workspace)`, `forget(label)`, `workspace(label) -> Option<Arc<Mutex<Workspace>>>`, `path_of(label) -> Option<PathBuf>`, `is_open_path(path) -> bool`, `recent() -> Vec<PathBuf>`, `opened(label)`, `focused(label)`, `closed(label) -> Vec<FlushGoal>`, `latest_window() -> Option<String>`, `push_pending(label, PendingOpen)`, `take_pending(label) -> Vec<PendingOpen>`, `take_open_windows() -> Vec<PathBuf>`, `fallback_workspace() -> Option<PathBuf>`(정규화된 경로), `begin_flush(goal) -> Begin`, `ack_flush(id, label)`, `expire_flush(id)`, `start_quit()`, `is_quitting() -> bool`.

- [ ] **Step 1: 실패하는 테스트 작성**

`lib.rs` 에 `pub mod app;` 을 넣는다. `src-tauri/src/app/mod.rs` 는 `pub mod flush;` 선언과 테스트, `src-tauri/src/app/flush.rs` 는 테스트만 담아 만든다.

`src-tauri/src/app/flush.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn labels(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_close_waits_for_its_window() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, windows } =
            f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"]))
        else {
            panic!("expected a round")
        };
        assert_eq!(windows, labels(&["a"]));
        assert_eq!(f.ack(id, "a"), Some(FlushGoal::CloseWindow("a".into())));
        assert_eq!(f.ack(id, "a"), None);
    }

    #[test]
    fn a_quit_waits_for_every_window() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["a", "b"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.ack(id, "a"), None);
        assert_eq!(f.ack(id, "b"), Some(FlushGoal::Quit));
    }

    #[test]
    fn nothing_to_wait_for_is_done_at_once() {
        let mut f = FlushCoordinator::default();
        assert_eq!(f.begin(FlushGoal::Quit, vec![]), Begin::Done(FlushGoal::Quit));
    }

    #[test]
    fn a_running_quit_absorbs_new_requests() {
        let mut f = FlushCoordinator::default();
        assert!(matches!(f.begin(FlushGoal::Quit, labels(&["a"])), Begin::Started { .. }));
        assert_eq!(f.begin(FlushGoal::Quit, labels(&["a"])), Begin::AlreadyRunning);
        assert_eq!(
            f.begin(FlushGoal::CloseWindow("a".into()), labels(&["a"])),
            Begin::AlreadyRunning
        );
    }

    #[test]
    fn a_round_that_times_out_still_finishes() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["hung"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.expire(id), Some(FlushGoal::Quit));
        assert_eq!(f.expire(id), None);
        assert_eq!(f.ack(id, "hung"), None);
    }

    #[test]
    fn a_closed_window_counts_as_answered() {
        let mut f = FlushCoordinator::default();
        let Begin::Started { id, .. } = f.begin(FlushGoal::Quit, labels(&["a", "b"])) else {
            panic!("expected a round")
        };
        assert_eq!(f.ack(id, "a"), None);
        assert_eq!(f.window_gone("b"), vec![FlushGoal::Quit]);
    }
}
```

`src-tauri/src/app/mod.rs`:

```rust
pub mod flush;

#[cfg(test)]
mod tests {
    use super::*;

    fn core(dir: &Path) -> AppCore {
        let paths = AppPaths::from_parts(Some(dir.join("data")), None, None, false).unwrap();
        let machine = Machine {
            version: 1,
            device_id: "device".into(),
            device_name: "맥".into(),
        };
        AppCore::new(paths, machine, &Settings::default(), LaunchState::default())
    }

    fn open(core: &AppCore, name: &str) -> String {
        let workspace = Workspace::create(&core.workspace_root, name).unwrap();
        let label = AppCore::label_for(workspace.root());
        core.register(&label, workspace);
        core.opened(&label);
        label
    }

    fn saved(core: &AppCore) -> LaunchState {
        LaunchState::load(&core.paths.launch_file()).unwrap()
    }

    #[test]
    fn labels_are_stable_per_folder() {
        let a = AppCore::label_for(Path::new("/w/업무"));
        assert_eq!(a, AppCore::label_for(Path::new("/w/업무")));
        assert_ne!(a, AppCore::label_for(Path::new("/w/개인")));
        assert!(a.starts_with("ws-") && a.len() == 19);
    }

    #[test]
    fn the_latest_window_follows_focus_and_is_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        assert_eq!(core.latest_window(), Some(b.clone()));
        core.focused(&a);
        assert_eq!(core.latest_window(), Some(a.clone()));
        assert_eq!(saved(&core).recent[0], core.path_of(&a).unwrap());
        assert_eq!(saved(&core).open_windows.len(), 2);
    }

    #[test]
    fn closing_a_window_forgets_it_unless_quitting() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        let b_path = core.path_of(&b).unwrap();
        core.closed(&a);
        assert_eq!(saved(&core).open_windows, vec![b_path.clone()]);
        core.start_quit();
        core.closed(&b);
        assert_eq!(saved(&core).open_windows, vec![b_path]);
    }

    #[test]
    fn quitting_reopens_the_latest_window_last() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let b = open(&core, "나");
        core.focused(&a);
        core.start_quit();
        assert_eq!(
            saved(&core).open_windows,
            vec![core.path_of(&b).unwrap(), core.path_of(&a).unwrap()]
        );
        assert!(core.is_quitting());
    }

    #[test]
    fn pending_opens_are_taken_once() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        core.push_pending(&a, PendingOpen::External { path: "/x.sh".into() });
        assert_eq!(
            core.take_pending(&a),
            vec![PendingOpen::External { path: "/x.sh".into() }]
        );
        assert!(core.take_pending(&a).is_empty());
        assert_eq!(
            serde_json::to_string(&PendingOpen::Memo { id: "m".into() }).unwrap(),
            r#"{"kind":"memo","id":"m"}"#
        );
    }

    #[test]
    fn the_fallback_is_the_latest_workspace_that_still_exists() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        assert_eq!(core.fallback_workspace(), None);
        let a = open(&core, "가");
        let a_path = core.path_of(&a).unwrap();
        core.closed(&a);
        assert_eq!(core.fallback_workspace(), Some(a_path.clone()));
        std::fs::rename(&a_path, dir.path().join("옮김")).unwrap();
        let other = Workspace::create(&core.workspace_root, "다른").unwrap();
        assert_eq!(core.fallback_workspace(), Some(other.root().to_path_buf()));
    }

    #[test]
    fn a_window_closing_mid_quit_completes_the_round() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let Begin::Started { id, windows } = core.begin_flush(FlushGoal::Quit) else {
            panic!("expected a round")
        };
        assert_eq!(windows, vec![a.clone()]);
        assert_eq!(core.closed(&a), vec![FlushGoal::Quit]);
        assert_eq!(core.ack_flush(id, &a), None);
    }
}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml app
```

Expected: `cannot find type FlushCoordinator`, `cannot find type AppCore` 등으로 컴파일 실패.

- [ ] **Step 3: 구현**

`src-tauri/src/app/flush.rs` 의 테스트 위:

```rust
//! Bookkeeping for "write everything, then close": closing a window or quitting first asks the
//! affected windows to write their edits (`tote://flush`) and waits until each answers
//! (`flush_done`) — or until a timeout, so a hung page never keeps tote from closing.

use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlushGoal {
    CloseWindow(String),
    Quit,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Begin {
    /// Ask these windows to flush, tagged with round `id`.
    Started { id: u64, windows: Vec<String> },
    /// Nobody to wait for: carry the goal out now.
    Done(FlushGoal),
    /// A quit, or this very close, is already waiting.
    AlreadyRunning,
}

#[derive(Default)]
pub struct FlushCoordinator {
    next_id: u64,
    rounds: BTreeMap<u64, Round>,
}

struct Round {
    goal: FlushGoal,
    waiting: BTreeSet<String>,
}

impl FlushCoordinator {
    pub fn begin(&mut self, goal: FlushGoal, windows: Vec<String>) -> Begin {
        let busy = self
            .rounds
            .values()
            .any(|round| round.goal == FlushGoal::Quit || round.goal == goal);
        if busy {
            return Begin::AlreadyRunning;
        }
        if windows.is_empty() {
            return Begin::Done(goal);
        }
        self.next_id += 1;
        let id = self.next_id;
        let waiting = windows.iter().cloned().collect();
        self.rounds.insert(id, Round { goal, waiting });
        Begin::Started { id, windows }
    }

    /// `window` answered round `id`; returns the goal once nobody is left to wait for.
    pub fn ack(&mut self, id: u64, window: &str) -> Option<FlushGoal> {
        let round = self.rounds.get_mut(&id)?;
        round.waiting.remove(window);
        if round.waiting.is_empty() {
            self.rounds.remove(&id).map(|round| round.goal)
        } else {
            None
        }
    }

    /// Round `id` ran out of time: returns its goal if it was still waiting.
    pub fn expire(&mut self, id: u64) -> Option<FlushGoal> {
        self.rounds.remove(&id).map(|round| round.goal)
    }

    /// `window` is gone; it counts as having answered every round.
    pub fn window_gone(&mut self, window: &str) -> Vec<FlushGoal> {
        let finished: Vec<u64> = self
            .rounds
            .iter_mut()
            .filter_map(|(id, round)| {
                round.waiting.remove(window);
                round.waiting.is_empty().then_some(*id)
            })
            .collect();
        finished
            .into_iter()
            .filter_map(|id| self.rounds.remove(&id).map(|round| round.goal))
            .collect()
    }
}
```

`src-tauri/src/app/mod.rs` 의 맨 위, 즉 `pub mod …;` 선언보다 앞(`//!` 모듈 문서가 선언 뒤에 오면 E0753 으로 컴파일되지 않는다). 선언은 아래 `use` 들 뒤에 둔다. 테스트 위:

```rust
//! The app's shared state: which window shows which workspace, focus order for routing, pending
//! opens for windows still loading, and the close/quit bookkeeping. No Tauri types in here, so it
//! is tested with plain values; src/app/windows.rs and friends connect it to Tauri.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;

use crate::appdata::{device_name, AppPaths, LaunchState, Machine, Settings};
use crate::persist::content_hash;
use crate::persist::external::ExternalFiles;
use crate::session::drafts::DraftStore;
use crate::workspace::Workspace;
use flush::{Begin, FlushCoordinator, FlushGoal};

/// A poisoned lock only means another command panicked; the data is still the best there is.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a window's frontend should open when it next asks (`take_pending_opens`): the window may
/// still be loading when a `tote` command arrives.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PendingOpen {
    Memo { id: String },
    External { path: PathBuf },
}

pub struct AppCore {
    pub paths: AppPaths,
    pub machine: Machine,
    pub workspace_root: PathBuf,
    pub external: ExternalFiles,
    inner: Mutex<Inner>,
}

struct Inner {
    windows: HashMap<String, OpenWindow>,
    /// Window labels, most recently focused first.
    focus: Vec<String>,
    launch: LaunchState,
    flush: FlushCoordinator,
    quitting: bool,
}

struct OpenWindow {
    path: PathBuf,
    workspace: Arc<Mutex<Workspace>>,
    pending: Vec<PendingOpen>,
}

impl AppCore {
    pub fn load() -> Result<AppCore, String> {
        let paths = AppPaths::resolve().ok_or("could not find the app data folder")?;
        let machine = Machine::load_or_create(&paths.machine_file(), device_name)
            .map_err(|err| format!("machine.json: {err}"))?;
        let settings = Settings::load(&paths.settings_file())
            .map_err(|err| format!("settings.json: {err}"))?;
        let launch = LaunchState::load(&paths.launch_file())
            .map_err(|err| format!("state.json: {err}"))?;
        Ok(AppCore::new(paths, machine, &settings, launch))
    }

    pub fn new(paths: AppPaths, machine: Machine, settings: &Settings, launch: LaunchState) -> AppCore {
        let workspace_root = settings.workspace_root(&paths);
        let external = ExternalFiles::new(DraftStore::new(paths.buffers_dir()));
        AppCore {
            paths,
            machine,
            workspace_root,
            external,
            inner: Mutex::new(Inner {
                windows: HashMap::new(),
                focus: Vec::new(),
                launch,
                flush: FlushCoordinator::default(),
                quitting: false,
            }),
        }
    }

    /// One window per workspace folder. The label comes from the folder, so opening the same
    /// workspace again finds its window; two folders never share one even if a copied folder
    /// carries the same workspace ID.
    pub fn label_for(path: &Path) -> String {
        format!("ws-{}", &content_hash(path.as_os_str().as_encoded_bytes())[..16])
    }

    pub fn register(&self, label: &str, workspace: Workspace) {
        let window = OpenWindow {
            path: workspace.root().to_path_buf(),
            workspace: Arc::new(Mutex::new(workspace)),
            pending: Vec::new(),
        };
        lock(&self.inner).windows.insert(label.to_string(), window);
    }

    pub fn forget(&self, label: &str) {
        lock(&self.inner).windows.remove(label);
    }

    pub fn workspace(&self, label: &str) -> Option<Arc<Mutex<Workspace>>> {
        lock(&self.inner).windows.get(label).map(|w| w.workspace.clone())
    }

    pub fn path_of(&self, label: &str) -> Option<PathBuf> {
        lock(&self.inner).windows.get(label).map(|w| w.path.clone())
    }

    pub fn is_open_path(&self, path: &Path) -> bool {
        lock(&self.inner).windows.values().any(|w| w.path == path)
    }

    pub fn recent(&self) -> Vec<PathBuf> {
        lock(&self.inner).launch.recent.clone()
    }

    /// A window finished opening: it is the newest, and it reopens at the next launch.
    pub fn opened(&self, label: &str) {
        let mut inner = lock(&self.inner);
        let Some(path) = inner.windows.get(label).map(|w| w.path.clone()) else {
            return;
        };
        inner.launch.add_open(&path);
        inner.launch.touch(&path);
        bring_to_front(&mut inner.focus, label);
        self.save_launch(&inner.launch);
    }

    pub fn focused(&self, label: &str) {
        let mut inner = lock(&self.inner);
        let Some(path) = inner.windows.get(label).map(|w| w.path.clone()) else {
            return;
        };
        inner.launch.touch(&path);
        bring_to_front(&mut inner.focus, label);
        self.save_launch(&inner.launch);
    }

    /// A window is gone. Returns the flush rounds it was the last one to wait for.
    pub fn closed(&self, label: &str) -> Vec<FlushGoal> {
        let mut inner = lock(&self.inner);
        let removed = inner.windows.remove(label);
        inner.focus.retain(|l| l != label);
        // While quitting, windows close one by one; the list to reopen was fixed by start_quit.
        if let (Some(window), false) = (removed, inner.quitting) {
            inner.launch.remove_open(&window.path);
            self.save_launch(&inner.launch);
        }
        inner.flush.window_gone(label)
    }

    pub fn latest_window(&self) -> Option<String> {
        lock(&self.inner).focus.first().cloned()
    }

    pub fn push_pending(&self, label: &str, open: PendingOpen) {
        if let Some(window) = lock(&self.inner).windows.get_mut(label) {
            window.pending.push(open);
        }
    }

    pub fn take_pending(&self, label: &str) -> Vec<PendingOpen> {
        lock(&self.inner)
            .windows
            .get_mut(label)
            .map(|w| std::mem::take(&mut w.pending))
            .unwrap_or_default()
    }

    /// The windows to reopen at launch. They are listed again as each one opens.
    pub fn take_open_windows(&self) -> Vec<PathBuf> {
        std::mem::take(&mut lock(&self.inner).launch.open_windows)
    }

    /// The workspace to show when nothing says which: the most recently used one that still
    /// exists, else the first under the workspace root.
    pub fn fallback_workspace(&self) -> Option<PathBuf> {
        let recent = self.recent();
        recent
            .into_iter()
            .find(|path| Workspace::is_workspace(path))
            .or_else(|| {
                let first = Workspace::list(&self.workspace_root).into_iter().next()?;
                Some(fs::canonicalize(&first.path).unwrap_or(first.path))
            })
    }

    pub fn begin_flush(&self, goal: FlushGoal) -> Begin {
        let mut inner = lock(&self.inner);
        let windows = match &goal {
            FlushGoal::CloseWindow(label) => vec![label.clone()],
            FlushGoal::Quit => inner.windows.keys().cloned().collect(),
        };
        inner.flush.begin(goal, windows)
    }

    pub fn ack_flush(&self, id: u64, label: &str) -> Option<FlushGoal> {
        lock(&self.inner).flush.ack(id, label)
    }

    pub fn expire_flush(&self, id: u64) -> Option<FlushGoal> {
        lock(&self.inner).flush.expire(id)
    }

    /// Fixes what reopens at the next launch: every open window, the most recently focused last
    /// so it ends up in front.
    pub fn start_quit(&self) {
        let mut inner = lock(&self.inner);
        inner.quitting = true;
        let order: Vec<PathBuf> = inner
            .focus
            .iter()
            .rev()
            .filter_map(|label| inner.windows.get(label).map(|w| w.path.clone()))
            .collect();
        inner.launch.open_windows = order;
        self.save_launch(&inner.launch);
    }

    pub fn is_quitting(&self) -> bool {
        lock(&self.inner).quitting
    }

    fn save_launch(&self, launch: &LaunchState) {
        if let Err(err) = launch.save(&self.paths.launch_file()) {
            eprintln!("tote: could not save state.json: {err}");
        }
    }
}

fn bring_to_front(focus: &mut Vec<String>, label: &str) {
    focus.retain(|l| l != label);
    focus.insert(0, label.to_string());
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: `test result: ok. 81 passed`(이전 68 + flush 6, app 7).

- [ ] **Step 5: 포맷·검사·커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
git add src-tauri/src/lib.rs src-tauri/src/app
git commit -m "feat(app): track workspace windows, focus order and flush-before-close rounds"
```

---

### Task 8: Tauri 연결 — 명령, 창, 메뉴, 쓰고 닫기, 단일 인스턴스

**Files:**

- Modify: `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs`, `src-tauri/src/app/mod.rs`(모듈 선언), `src/main.ts`(자리표시)
- Create: `src-tauri/src/app/commands.rs`, `src-tauri/src/app/windows.rs`, `src-tauri/src/app/menu.rs`, `src-tauri/src/app/lifecycle.rs`, `src-tauri/src/app/requests.rs`

**Interfaces:**

- Consumes: Task 1–7 전부.
- Produces (명령 — 이름·인자·반환이 프론트엔드 `TauriBackend`(Task 9)와 맞아야 한다):

| 명령                                    | 인자                        | 반환                                  |
| --------------------------------------- | --------------------------- | ------------------------------------- |
| `workspace_info`                        | —                           | `{ id, name, path, deviceId }`        |
| `list_memos`                            | —                           | `MemoInfo[]`                          |
| `create_memo`                           | —                           | `MemoInfo`                            |
| `read_memo`                             | `{ id }`                    | 바이트(`ArrayBuffer`)                 |
| `write_memo`                            | 바이트 + 헤더 `x-memo-id`   | `MemoInfo`                            |
| `retitle_memo`                          | `{ id, stem }`              | `MemoInfo`                            |
| `rename_memo`                           | `{ id, file }`              | `MemoInfo`                            |
| `delete_memo`                           | `{ id }`                    | —                                     |
| `import_memo`                           | 바이트 + 헤더 `x-file-name` | `MemoInfo`                            |
| `import_file`                           | `{ path }`                  | `MemoInfo`                            |
| `read_session` / `write_session`        | — / `{ json }`              | `string \| null` / —                  |
| `take_pending_opens`                    | —                           | `PendingOpen[]`                       |
| `open_external`                         | `{ path }`                  | `ExternalInfo`                        |
| `read_external` / `read_external_draft` | `{ path }`                  | 바이트                                |
| `keep_external_draft` / `save_external` | 바이트 + 헤더 `x-path`      | — / 쓴 바이트 수                      |
| `discard_external_draft`                | `{ path }`                  | —                                     |
| `list_workspaces`                       | —                           | `{ name, path, open }[]`(최근 사용순) |
| `create_workspace` / `open_workspace`   | `{ name }` / `{ path }`     | — (창을 연다)                         |
| `flush_done`                            | `{ id }`                    | —                                     |
| `close_window`                          | —                           | —                                     |

- 헤더 값은 `encodeURIComponent` 로 인코딩한다. 오류는 `{ code, message }` — `code` 는 `not-a-workspace`, `already-exists`, `invalid-name`, `unknown-memo`, `not-found`, `bad-request`, `no-workspace`, `io`, `app`.
- Produces (이벤트 — 대상은 창 하나): `tote://menu`(메뉴 ID 문자열), `tote://flush`(라운드 ID 숫자), `tote://pending`(내용 없음).
- 메뉴 ID: `new-memo`, `open-file`, `save`, `import`, `rename`, `close-tab`, `next-tab`, `prev-tab`, `open-workspace`, `new-workspace`. `quit`, `install-cli`, `close-window` 는 Rust 가 직접 처리한다.
- Produces (Rust): `windows::{show(app, path) -> Result<String, CommandError>, restore(app, Option<CliRequest>), open_latest(app), focus(app, label), on_event, background() -> bool, frame_visible(&WindowFrame, &[(f64, f64, f64, f64)]) -> bool}`, `lifecycle::{begin, ack, finish}`, `requests::handle(app, CliRequest)`, `menu::{build, on_event}`.

- [ ] **Step 1: 의존성과 권한**

```bash
cargo add --manifest-path src-tauri/Cargo.toml tauri-plugin-single-instance@2 tauri-plugin-dialog@2 percent-encoding@2
```

`src-tauri/capabilities/default.json` 의 `permissions` 를 `["core:default", "dialog:allow-open"]` 로 바꾼다.

- [ ] **Step 2: 실패하는 테스트 작성**

`src-tauri/src/app/mod.rs` 의 `pub mod flush;` 옆에 모듈을 선언한다.

```rust
pub mod commands;
pub mod flush;
pub mod lifecycle;
pub mod menu;
pub mod requests;
pub mod windows;
```

`src-tauri/src/app/windows.rs` 를 테스트만 담아 만든다. 나머지 넷(`commands.rs`, `menu.rs`, `lifecycle.rs`, `requests.rs`)은 빈 파일로 만든다.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_frame_is_reused_only_on_a_present_monitor() {
        let monitors = [(0.0, 0.0, 1512.0, 982.0), (-1920.0, 0.0, 1920.0, 1080.0)];
        let frame = |x: f64, y: f64| WindowFrame { x, y, width: 900.0, height: 700.0 };
        assert!(frame_visible(&frame(100.0, 50.0), &monitors));
        assert!(frame_visible(&frame(-1800.0, 100.0), &monitors));
        assert!(!frame_visible(&frame(4000.0, 100.0), &monitors));
        assert!(!frame_visible(&frame(100.0, 50.0), &[]));
    }
}
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

```bash
cargo test --manifest-path src-tauri/Cargo.toml windows
```

Expected: `cannot find function frame_visible` 로 컴파일 실패.

- [ ] **Step 4: 명령 구현**

`src-tauri/src/app/commands.rs`:

```rust
//! The commands the frontend invokes (src/backend/tauri.ts). File contents travel as raw bytes
//! (Tauri's binary IPC); names and paths go in percent-encoded headers, never inside JSON strings.

use std::borrow::Cow;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State, WebviewWindow};

use super::{lifecycle, lock, windows, AppCore, PendingOpen};
use crate::persist::external::ExternalInfo;
use crate::session;
use crate::workspace::{MemoInfo, Workspace, WorkspaceError};

/// What a rejected command returns. `code` is what the frontend branches on (`BackendError`).
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> CommandError {
        CommandError { code, message: message.into() }
    }
}

impl From<WorkspaceError> for CommandError {
    fn from(err: WorkspaceError) -> CommandError {
        let code = match &err {
            WorkspaceError::NotAWorkspace(_) => "not-a-workspace",
            WorkspaceError::AlreadyExists(_) => "already-exists",
            WorkspaceError::InvalidName(_) => "invalid-name",
            WorkspaceError::UnknownMemo(_) => "unknown-memo",
            WorkspaceError::Io(io) => io_code(io),
        };
        CommandError::new(code, err.to_string())
    }
}

impl From<io::Error> for CommandError {
    fn from(err: io::Error) -> CommandError {
        CommandError::new(io_code(&err), err.to_string())
    }
}

impl From<tauri::Error> for CommandError {
    fn from(err: tauri::Error) -> CommandError {
        CommandError::new("app", err.to_string())
    }
}

fn io_code(err: &io::Error) -> &'static str {
    match err.kind() {
        io::ErrorKind::NotFound => "not-found",
        io::ErrorKind::InvalidData | io::ErrorKind::InvalidInput => "bad-request",
        _ => "io",
    }
}

type CmdResult<T> = Result<T, CommandError>;

fn workspace_of(core: &AppCore, window: &WebviewWindow) -> CmdResult<Arc<Mutex<Workspace>>> {
    core.workspace(window.label()).ok_or_else(|| {
        CommandError::new("no-workspace", format!("{} shows no workspace", window.label()))
    })
}

fn header(request: &Request<'_>, name: &str) -> CmdResult<String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| CommandError::new("bad-request", format!("missing header {name}")))?;
    percent_decode_str(raw)
        .decode_utf8()
        .map(Cow::into_owned)
        .map_err(|_| CommandError::new("bad-request", format!("header {name} is not UTF-8")))
}

fn body<'a>(request: &'a Request<'_>) -> CmdResult<&'a [u8]> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        // An empty Uint8Array may arrive as an empty JSON payload.
        InvokeBody::Json(value)
            if value.is_null() || value.as_object().is_some_and(|o| o.is_empty()) =>
        {
            Ok(&[])
        }
        InvokeBody::Json(_) => Err(CommandError::new("bad-request", "expected raw bytes")),
    }
}

/// External paths come from the person (dialog, drop, `tote`); a relative one is a bug.
fn absolute_path(path: &str) -> CmdResult<PathBuf> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(CommandError::new("bad-request", format!("not an absolute path: {}", path.display())))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    id: String,
    name: String,
    path: PathBuf,
    device_id: String,
}

#[tauri::command]
pub fn workspace_info(core: State<'_, AppCore>, window: WebviewWindow) -> CmdResult<WorkspaceInfo> {
    let workspace = workspace_of(&core, &window)?;
    let workspace = lock(&workspace);
    Ok(WorkspaceInfo {
        id: workspace.id().to_string(),
        name: workspace.name(),
        path: workspace.root().to_path_buf(),
        device_id: core.machine.device_id.clone(),
    })
}

// File I/O commands are async so they run off the main thread; a sync command would block the
// event loop while a large memo is written.

#[tauri::command]
pub async fn list_memos(core: State<'_, AppCore>, window: WebviewWindow) -> CmdResult<Vec<MemoInfo>> {
    let workspace = workspace_of(&core, &window)?;
    let list = lock(&workspace).list_memos()?;
    Ok(list)
}

#[tauri::command]
pub async fn create_memo(core: State<'_, AppCore>, window: WebviewWindow) -> CmdResult<MemoInfo> {
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).create_memo("md", &[])?;
    Ok(info)
}

#[tauri::command]
pub async fn read_memo(core: State<'_, AppCore>, window: WebviewWindow, id: String) -> CmdResult<Response> {
    let workspace = workspace_of(&core, &window)?;
    let bytes = lock(&workspace).read_memo(&id)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn write_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    request: Request<'_>,
) -> CmdResult<MemoInfo> {
    let id = header(&request, "x-memo-id")?;
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).write_memo(&id, body(&request)?)?;
    Ok(info)
}

#[tauri::command]
pub async fn retitle_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
    stem: String,
) -> CmdResult<MemoInfo> {
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).retitle_memo(&id, &stem)?;
    Ok(info)
}

#[tauri::command]
pub async fn rename_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
    file: String,
) -> CmdResult<MemoInfo> {
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).rename_memo(&id, &file)?;
    Ok(info)
}

#[tauri::command]
pub async fn delete_memo(core: State<'_, AppCore>, window: WebviewWindow, id: String) -> CmdResult<()> {
    let workspace = workspace_of(&core, &window)?;
    lock(&workspace).delete_memo(&id)?;
    Ok(())
}

#[tauri::command]
pub async fn import_memo(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    request: Request<'_>,
) -> CmdResult<MemoInfo> {
    let name = header(&request, "x-file-name")?;
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).import_memo(&name, body(&request)?)?;
    Ok(info)
}

#[tauri::command]
pub async fn import_file(core: State<'_, AppCore>, window: WebviewWindow, path: String) -> CmdResult<MemoInfo> {
    let path = absolute_path(&path)?;
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).import_file(&path)?;
    Ok(info)
}

#[tauri::command]
pub async fn read_session(core: State<'_, AppCore>, window: WebviewWindow) -> CmdResult<Option<String>> {
    let root = lock(&workspace_of(&core, &window)?).root().to_path_buf();
    Ok(session::read_session(&root, &core.machine.device_id)?)
}

#[tauri::command]
pub async fn write_session(core: State<'_, AppCore>, window: WebviewWindow, json: String) -> CmdResult<()> {
    let root = lock(&workspace_of(&core, &window)?).root().to_path_buf();
    session::write_session(&root, &core.machine.device_id, &json)?;
    Ok(())
}

#[tauri::command]
pub fn take_pending_opens(core: State<'_, AppCore>, window: WebviewWindow) -> Vec<PendingOpen> {
    core.take_pending(window.label())
}

#[tauri::command]
pub async fn open_external(core: State<'_, AppCore>, path: String) -> CmdResult<ExternalInfo> {
    Ok(core.external.open(&absolute_path(&path)?)?)
}

#[tauri::command]
pub async fn read_external(core: State<'_, AppCore>, path: String) -> CmdResult<Response> {
    Ok(Response::new(core.external.read(&absolute_path(&path)?)?))
}

#[tauri::command]
pub async fn read_external_draft(core: State<'_, AppCore>, path: String) -> CmdResult<Response> {
    Ok(Response::new(core.external.read_draft(&absolute_path(&path)?)?))
}

#[tauri::command]
pub async fn keep_external_draft(core: State<'_, AppCore>, request: Request<'_>) -> CmdResult<()> {
    let path = absolute_path(&header(&request, "x-path")?)?;
    core.external.keep_draft(&path, body(&request)?)?;
    Ok(())
}

#[tauri::command]
pub async fn discard_external_draft(core: State<'_, AppCore>, path: String) -> CmdResult<()> {
    core.external.discard_draft(&absolute_path(&path)?)?;
    Ok(())
}

#[tauri::command]
pub async fn save_external(core: State<'_, AppCore>, request: Request<'_>) -> CmdResult<u64> {
    let path = absolute_path(&header(&request, "x-path")?)?;
    Ok(core.external.save(&path, body(&request)?)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListItem {
    name: String,
    path: PathBuf,
    open: bool,
}

#[tauri::command]
pub fn list_workspaces(core: State<'_, AppCore>) -> Vec<WorkspaceListItem> {
    let recent = core.recent();
    let mut list: Vec<WorkspaceListItem> = Workspace::list(&core.workspace_root)
        .into_iter()
        .map(|summary| {
            let path = std::fs::canonicalize(&summary.path).unwrap_or(summary.path);
            WorkspaceListItem { open: core.is_open_path(&path), name: summary.name, path }
        })
        .collect();
    // Most recently used first; the rest keep their name order (the sort is stable).
    list.sort_by_key(|item| recent.iter().position(|p| *p == item.path).unwrap_or(usize::MAX));
    list
}

#[tauri::command]
pub async fn create_workspace(app: AppHandle, core: State<'_, AppCore>, name: String) -> CmdResult<()> {
    let workspace = Workspace::create(&core.workspace_root, &name)?;
    windows::show(&app, workspace.root())?;
    Ok(())
}

#[tauri::command]
pub async fn open_workspace(app: AppHandle, path: String) -> CmdResult<()> {
    windows::show(&app, &absolute_path(&path)?)?;
    Ok(())
}

#[tauri::command]
pub async fn flush_done(app: AppHandle, window: WebviewWindow, id: u64) -> CmdResult<()> {
    lifecycle::ack(&app, id, window.label());
    Ok(())
}

#[tauri::command]
pub async fn close_window(window: WebviewWindow) -> CmdResult<()> {
    window.close()?;
    Ok(())
}
```

- [ ] **Step 5: 창·쓰고 닫기·요청 구현**

`src-tauri/src/app/windows.rs` 의 테스트 위:

```rust
//! Workspace windows: one per workspace folder, labelled by `AppCore::label_for`.

use std::path::Path;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

use super::commands::CommandError;
use super::flush::FlushGoal;
use super::{lifecycle, requests, AppCore};
use crate::cli::CliRequest;
use crate::session::{read_window_frame, WindowFrame};
use crate::workspace::{Workspace, DEFAULT_WORKSPACE};

const DEFAULT_WIDTH: f64 = 1100.0;
const DEFAULT_HEIGHT: f64 = 760.0;

/// Debug builds started with `TOTE_BACKGROUND=1` — smoke checks run by agents — open windows
/// without taking focus, so a check never pulls the person's screen away.
pub fn background() -> bool {
    cfg!(debug_assertions) && std::env::var_os("TOTE_BACKGROUND").is_some()
}

/// Shows the window of the workspace at `path`, opening it when needed. Returns its label.
pub fn show(app: &AppHandle, path: &Path) -> Result<String, CommandError> {
    let core = app.state::<AppCore>();
    let path = std::fs::canonicalize(path)?;
    let label = AppCore::label_for(&path);
    if app.get_webview_window(&label).is_some() {
        focus(app, &label);
        return Ok(label);
    }
    let workspace = Workspace::open(&path)?;
    let title = workspace.name();
    let frame = read_window_frame(workspace.root(), &core.machine.device_id);
    core.register(&label, workspace);
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .min_inner_size(480.0, 320.0)
        .focused(!background());
    let builder = match frame.filter(|f| frame_visible(f, &monitor_rects(app))) {
        Some(f) => builder.position(f.x, f.y).inner_size(f.width, f.height),
        None => builder.inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT).center(),
    };
    if let Err(err) = builder.build() {
        core.forget(&label);
        return Err(err.into());
    }
    core.opened(&label);
    Ok(label)
}

pub fn focus(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        if !background() {
            let _ = window.set_focus();
        }
    }
}

/// Reopens the windows open at the last quit, then carries out the `tote` request that started
/// the app, if any.
pub fn restore(app: &AppHandle, request: Option<CliRequest>) {
    let core = app.state::<AppCore>();
    let mut shown = 0;
    for path in core.take_open_windows() {
        match show(app, &path) {
            Ok(_) => shown += 1,
            Err(err) => eprintln!("tote: {}: {}", path.display(), err.message),
        }
    }
    let names_a_workspace = request.as_ref().is_some_and(|r| r.workspace.is_some());
    if shown == 0 && !names_a_workspace {
        open_latest(app);
    }
    if let Some(request) = request {
        requests::handle(app, request);
    }
}

/// Opens the most recently used workspace; on a first launch makes the default one.
pub fn open_latest(app: &AppHandle) {
    let core = app.state::<AppCore>();
    let path = match core.fallback_workspace() {
        Some(path) => path,
        None => match Workspace::create(&core.workspace_root, DEFAULT_WORKSPACE) {
            Ok(workspace) => workspace.root().to_path_buf(),
            Err(err) => {
                eprintln!("tote: {err}");
                return;
            }
        },
    };
    if let Err(err) = show(app, &path) {
        eprintln!("tote: {}: {}", path.display(), err.message);
    }
}

pub fn on_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    let Some(core) = app.try_state::<AppCore>() else {
        return;
    };
    let label = window.label();
    match event {
        WindowEvent::Focused(true) => core.focused(label),
        // Closing writes first: the frontend gets `tote://flush`, and the window goes once it
        // answers or the timeout runs out.
        WindowEvent::CloseRequested { api, .. } if !core.is_quitting() => {
            api.prevent_close();
            lifecycle::begin(app, FlushGoal::CloseWindow(label.to_string()));
        }
        WindowEvent::Destroyed => {
            for goal in core.closed(label) {
                lifecycle::finish(app, goal);
            }
        }
        _ => {}
    }
}

/// Monitors as (x, y, width, height) in logical pixels.
fn monitor_rects(app: &AppHandle) -> Vec<(f64, f64, f64, f64)> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let (pos, size) = (monitor.position(), monitor.size());
            (
                f64::from(pos.x) / scale,
                f64::from(pos.y) / scale,
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            )
        })
        .collect()
}

/// A saved frame is reused only when its title bar lies on a monitor that is still there —
/// otherwise the window would open where nobody can see or grab it.
pub fn frame_visible(frame: &WindowFrame, monitors: &[(f64, f64, f64, f64)]) -> bool {
    let (x, y) = (frame.x + 40.0, frame.y + 10.0);
    monitors
        .iter()
        .any(|&(mx, my, mw, mh)| x >= mx && x < mx + mw && y >= my && y < my + mh)
}
```

`src-tauri/src/app/lifecycle.rs`:

```rust
//! Closing a window and quitting: the affected windows write their edits first, then tote goes.
//! Writing on close and quit is what bounds the loss when a hidden window's timers stall
//! (spec 「저장」).

use std::time::Duration;

use tauri::{AppHandle, Emitter, EventTarget, Manager};

use super::flush::{Begin, FlushGoal};
use super::AppCore;

/// Long enough to write any memo to a local disk; short enough that a hung page cannot keep tote
/// from closing.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(3);

pub fn begin(app: &AppHandle, goal: FlushGoal) {
    let round = app.state::<AppCore>().begin_flush(goal);
    match round {
        Begin::Done(goal) => finish(app, goal),
        Begin::AlreadyRunning => {}
        Begin::Started { id, windows } => {
            for label in &windows {
                let _ = app.emit_to(EventTarget::webview_window(label.as_str()), "tote://flush", id);
            }
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(FLUSH_TIMEOUT);
                let goal = app.state::<AppCore>().expire_flush(id);
                if let Some(goal) = goal {
                    finish(&app, goal);
                }
            });
        }
    }
}

/// A window's frontend answered round `id` (`flush_done`).
pub fn ack(app: &AppHandle, id: u64, label: &str) {
    let goal = app.state::<AppCore>().ack_flush(id, label);
    if let Some(goal) = goal {
        finish(app, goal);
    }
}

pub fn finish(app: &AppHandle, goal: FlushGoal) {
    match goal {
        FlushGoal::CloseWindow(label) => {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.destroy();
            }
        }
        FlushGoal::Quit => {
            app.state::<AppCore>().start_quit();
            app.exit(0);
        }
    }
}
```

`src-tauri/src/app/requests.rs`:

```rust
//! What a `tote` command asks of the running app (spec 「`tote` CLI」).

use std::fs;

use tauri::{AppHandle, Emitter, EventTarget, Manager};

use super::{lock, windows, AppCore, PendingOpen};
use crate::cli::CliRequest;
use crate::workspace::WorkspaceError;

pub fn handle(app: &AppHandle, request: CliRequest) {
    let core = app.state::<AppCore>();
    let label = match &request.workspace {
        Some(name) => windows::show(app, &core.workspace_root.join(name)).map_err(|e| e.message),
        None => match core.latest_window() {
            Some(label) => {
                windows::focus(app, &label);
                Ok(label)
            }
            None => {
                windows::open_latest(app);
                core.latest_window().ok_or_else(|| "no workspace window".to_string())
            }
        },
    };
    let label = match label {
        Ok(label) => label,
        Err(message) => {
            eprintln!("tote: {message}");
            return;
        }
    };
    let Some(workspace) = core.workspace(&label) else {
        return;
    };
    for path in &request.files {
        if !request.import {
            core.push_pending(&label, PendingOpen::External { path: path.clone() });
            continue;
        }
        match lock(&workspace).import_file(path) {
            Ok(info) => core.push_pending(&label, PendingOpen::Memo { id: info.id }),
            Err(err) => eprintln!("tote: {}: {err}", path.display()),
        }
    }
    if let Some(file) = &request.stdin_file {
        let created = fs::read(file)
            .map_err(WorkspaceError::from)
            .and_then(|text| lock(&workspace).create_memo("md", &text));
        match created {
            Ok(info) => core.push_pending(&label, PendingOpen::Memo { id: info.id }),
            Err(err) => eprintln!("tote: {}: {err}", file.display()),
        }
        let _ = fs::remove_file(file);
    }
    // The frontend picks these up now, or when it finishes loading if the window is new.
    let _ = app.emit_to(EventTarget::webview_window(label.as_str()), "tote://pending", ());
}
```

- [ ] **Step 6: 메뉴 구현**

`src-tauri/src/app/menu.rs`:

```rust
//! The menu bar. Edit uses the system items — in a WKWebView copy and paste only work through
//! them. Tab actions go to the frontend of the latest window as `tote://menu`.

use std::io;
use std::path::Path;

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow, Wry};
use tauri_plugin_dialog::DialogExt;

use super::flush::FlushGoal;
use super::{lifecycle, windows, AppCore};
use crate::cli::front::app_bundle;
use crate::cli::install::{install, Installed};

fn item(app: &AppHandle, id: &str, text: &str, accelerator: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    let builder = MenuItemBuilder::with_id(id, text);
    match accelerator {
        Some(accelerator) => builder.accelerator(accelerator),
        None => builder,
    }
    .build(app)
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let tote = SubmenuBuilder::new(app, "tote")
        .about(None)
        .separator()
        .item(&item(app, "install-cli", "셸 명령 설치…", None)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        // Not the system Quit item: that one terminates at once, without writing pending edits.
        .item(&item(app, "quit", "tote 종료", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let file = SubmenuBuilder::new(app, "파일")
        .item(&item(app, "new-memo", "새 메모", Some("CmdOrCtrl+N"))?)
        .item(&item(app, "open-file", "파일 열기…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item(app, "save", "저장", Some("CmdOrCtrl+S"))?)
        .item(&item(app, "import", "워크스페이스로 가져오기", None)?)
        .item(&item(app, "rename", "이름 바꾸기…", None)?)
        .separator()
        .item(&item(app, "close-tab", "탭 닫기", Some("CmdOrCtrl+W"))?)
        .item(&item(app, "close-window", "창 닫기", Some("CmdOrCtrl+Shift+W"))?)
        .separator()
        .item(&item(app, "open-workspace", "워크스페이스 열기…", Some("CmdOrCtrl+Shift+O"))?)
        .item(&item(app, "new-workspace", "새 워크스페이스…", Some("CmdOrCtrl+Shift+N"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "편집")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "보기")
        .item(&item(app, "next-tab", "다음 탭", Some("CmdOrCtrl+Shift+]"))?)
        .item(&item(app, "prev-tab", "이전 탭", Some("CmdOrCtrl+Shift+["))?)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "윈도우")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&tote, &file, &edit, &view, &window])
        .build()
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "quit" => lifecycle::begin(app, FlushGoal::Quit),
        "install-cli" => install_cli(app),
        "close-window" => {
            if let Some(window) = latest_window(app) {
                let _ = window.close();
            }
        }
        id => match latest_window(app) {
            Some(window) => {
                let _ = app.emit_to(EventTarget::webview_window(window.label()), "tote://menu", id);
            }
            // No window to act in: open one rather than drop the action silently.
            None => windows::open_latest(app),
        },
    }
}

fn latest_window(app: &AppHandle) -> Option<WebviewWindow> {
    let label = app.state::<AppCore>().latest_window()?;
    app.get_webview_window(&label)
}

fn install_cli(app: &AppHandle) {
    let message = match link_cli(app) {
        Ok(Installed::Preferred(at)) => {
            format!("{} 에 설치했습니다. 터미널에서 tote 를 쓸 수 있습니다.", at.display())
        }
        Ok(Installed::Fallback(at)) => format!(
            "{} 에 설치했습니다.\n셸의 PATH 에 이 폴더가 없다면 ~/.zshrc 에 다음 줄을 넣으세요.\nexport PATH=\"$HOME/.local/bin:$PATH\"",
            at.display()
        ),
        Err(err) => format!("설치하지 못했습니다: {err}"),
    };
    app.dialog().message(message).title("셸 명령 설치").show(|_| {});
}

fn link_cli(app: &AppHandle) -> io::Result<Installed> {
    let exe = std::env::current_exe()?;
    if app_bundle(&exe).is_none() {
        return Err(io::Error::other("앱 번들(tote.app)에서 실행할 때만 설치할 수 있습니다"));
    }
    let script = app.path().resource_dir().map_err(io::Error::other)?.join("bin/tote");
    let home = dirs::home_dir().ok_or_else(|| io::Error::other("홈 폴더를 찾지 못했습니다"))?;
    install(&script, Path::new("/usr/local/bin"), &home.join(".local/bin"))
}
```

- [ ] **Step 7: 빌더 연결**

`src-tauri/src/lib.rs` 를 아래로 바꾼다.

```rust
pub mod app;
pub mod appdata;
pub mod cli;
pub mod persist;
pub mod session;
pub mod workspace;

use tauri::{Manager, RunEvent};

use app::{commands, menu, requests, windows, AppCore};
use cli::CliRequest;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // A smoke check run by an agent must not activate tote over the person's work.
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(!windows::background());
    let app = builder
        // The first plugin: a second launch — the `tote` command — hands its request to the
        // running app here and exits. It finds that app by identifier, which is why development
        // runs use their own (src-tauri/tauri.dev.conf.json).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            requests::handle(app, CliRequest::find_in(&argv).unwrap_or_default());
        }))
        .plugin(tauri_plugin_dialog::init())
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .on_window_event(windows::on_event)
        .setup(|app| {
            app.manage(AppCore::load()?);
            windows::restore(app.handle(), CliRequest::find_in(std::env::args()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_info,
            commands::list_memos,
            commands::create_memo,
            commands::read_memo,
            commands::write_memo,
            commands::retitle_memo,
            commands::rename_memo,
            commands::delete_memo,
            commands::import_memo,
            commands::import_file,
            commands::read_session,
            commands::write_session,
            commands::take_pending_opens,
            commands::open_external,
            commands::read_external,
            commands::read_external_draft,
            commands::keep_external_draft,
            commands::discard_external_draft,
            commands::save_external,
            commands::list_workspaces,
            commands::create_workspace,
            commands::open_workspace,
            commands::flush_done,
            commands::close_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tote");
    app.run(|app, event| match event {
        // The last window closed: stay in the Dock like other Mac apps; ⌘Q quits.
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => windows::open_latest(app),
        _ => {}
    });
}
```

`src/main.ts` 를 자리표시로 바꾼다(Task 14 가 바꾼다). 창마다 자기 워크스페이스에 닿는지 보는 용도다.

```ts
import { invoke } from "@tauri-apps/api/core";

void invoke<{ name: string }>("workspace_info").then(
  (info) => {
    document.body.textContent = `tote — ${info.name}`;
  },
  (err: unknown) => {
    document.body.textContent = `tote: ${JSON.stringify(err)}`;
  },
);
```

- [ ] **Step 8: 테스트와 검사**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm typecheck
```

Expected: `test result: ok. 82 passed`(이전 81 + windows 1), clippy·tsc 오류 없음.

- [ ] **Step 9: 실제 앱으로 확인 (에이전트가 돌린다)**

사람의 데이터와 화면을 건드리지 않게 `TOTE_DATA_DIR` 과 `TOTE_BACKGROUND` 를 준다. 식별자는 개발용(`dev.tote.note.dev`)이다.

```bash
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json
BIN="$PWD/src-tauri/target/debug/tote"
SMOKE="$(mktemp -d)"
export TOTE_DATA_DIR="$SMOKE/data" TOTE_BACKGROUND=1
"$BIN" > "$SMOKE/app.log" 2>&1 & APP=$!
sleep 6
WS="$TOTE_DATA_DIR/workspaces/메모"
test -f "$WS/.tote/workspace.json" && echo "ok: default workspace"
cat "$TOTE_DATA_DIR/state.json"
echo "# 파이프 메모" | TOTE_CLI=1 "$BIN" -; echo "stdin exit=$?"
printf 'echo hi\n' > "$SMOKE/x.sh"; chmod +x "$SMOKE/x.sh"
TOTE_CLI=1 "$BIN" --import "$SMOKE/x.sh"; echo "import exit=$?"
TOTE_CLI=1 "$BIN" "$SMOKE"; echo "folder exit=$?"
sleep 4
ls "$WS"; cat "$WS/untitled.md"; cat "$WS/.tote/index.json"
ls -A "$TOTE_DATA_DIR/inbox"
pgrep -f "$BIN" | wc -l
kill "$APP"; sleep 1
"$BIN" >> "$SMOKE/app.log" 2>&1 & APP=$!
sleep 6
cat "$TOTE_DATA_DIR/state.json"
kill "$APP"
grep -i -E "panic|error" "$SMOKE/app.log" || echo "ok: no panics"
```

Expected:

- `ok: default workspace`, `state.json` 의 `openWindows` 와 `recent` 에 `…/workspaces/메모` 가 있다.
- `stdin exit=0`, `import exit=0`, `folder exit=1`(그 전에 `tote: 폴더는 열 수 없습니다: …` 한 줄).
- 워크스페이스에 `untitled.md`(내용 `# 파이프 메모`)와 `x.sh` 가 있고, `index.json` 에 둘이 있다(`untitled.md` 는 `autoTitle: true`, `x.sh` 는 `false`).
- 앱 프로세스는 하나다(CLI 가 띄운 프로세스는 요청을 넘기고 끝났다).
- 다시 띄운 뒤에도 `openWindows` 에 `메모` 가 남아 있다(강제 종료 뒤 복원), 로그에 panic 이 없다.
- `ls -A "$TOTE_DATA_DIR/inbox"` 가 아무것도 찍지 않는다(앱이 받아 메모로 만든 뒤 지웠다).

창의 내용(`tote — 메모`)과 메뉴 동작은 화면이 필요해 Task 15 에서 사람이 본다.

- [ ] **Step 10: 포맷·커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
pnpm exec oxfmt src/main.ts src-tauri/capabilities/default.json
pnpm exec oxlint --fix src/main.ts
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/capabilities/default.json src-tauri/src/lib.rs src-tauri/src/app src/main.ts
git commit -m "feat(app): connect commands, workspace windows, menu, flush-before-close and single instance"
```

---

### Task 9: 프론트 기반 — 백엔드 인터페이스, 문서 코덱, 제목 규칙

**Files:**

- Create: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/tauri.test.ts`, `src/core/codec.ts`, `src/core/codec.test.ts`, `src/core/title.ts`, `src/core/title.test.ts`

**Interfaces:**

- Consumes: Task 8 의 명령·이벤트 표(이름과 인자가 그대로 맞아야 한다), Task 1 `splitName`.
- Produces (`src/backend/types.ts`): `FileKind`, `MemoInfo`, `WorkspaceInfo`, `ExternalInfo`, `PendingOpen`, `WorkspaceListItem`, `WindowFrame`, `class BackendError { code: string }`, `errorCode(err: unknown): string | null`, `interface Backend`(아래 코드의 메서드 전부).
- Produces (`src/backend/tauri.ts`): `class TauriBackend implements Backend`.
- Produces (`src/core/codec.ts`): `type Eol = "\n" | "\r\n"`, `decodeText(bytes: Uint8Array): { text, eol, bom } | null`, `encodeText(text: string, bom: boolean): Uint8Array`, `longestLine(text: string): number`.
- Produces (`src/core/title.ts`): `TITLE_MAX_CHARS = 60`, `UNTITLED = "untitled"`, `titleFromLine(line: string): string`, `titleLine(doc: Text): { text: string; number: number }`, `memoTitle(doc: Text): string`.

- [ ] **Step 1: 백엔드 인터페이스**

`src/backend/types.ts`:

```ts
/** What the frontend asks of the native side (src-tauri/src/app/commands.rs). The app runs on
 * `TauriBackend`; the browser preview and the UI tests run on `FakeBackend`, an in-memory
 * stand-in with the same behaviour. */

export type FileKind = "text" | "image" | "video" | "audio" | "document";

export interface MemoInfo {
  id: string;
  file: string;
  autoTitle: boolean;
  language?: string;
  modifiedMs: number;
  size: number;
  kind: FileKind;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  deviceId: string;
}

export interface ExternalInfo {
  path: string;
  exists: boolean;
  size: number;
  kind: FileKind;
  /** An unsaved draft is waiting; `diskChanged` says the file changed after editing started. */
  draft: { diskChanged: boolean } | null;
}

export type PendingOpen = { kind: "memo"; id: string } | { kind: "external"; path: string };

export interface WorkspaceListItem {
  name: string;
  path: string;
  open: boolean;
}

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rejected call. `code` comes from `CommandError` on the Rust side. */
export class BackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}

export function errorCode(err: unknown): string | null {
  return err instanceof BackendError ? err.code : null;
}

export interface Backend {
  workspaceInfo(): Promise<WorkspaceInfo>;
  listMemos(): Promise<MemoInfo[]>;
  createMemo(): Promise<MemoInfo>;
  readMemo(id: string): Promise<Uint8Array>;
  writeMemo(id: string, bytes: Uint8Array): Promise<MemoInfo>;
  retitleMemo(id: string, stem: string): Promise<MemoInfo>;
  renameMemo(id: string, file: string): Promise<MemoInfo>;
  deleteMemo(id: string): Promise<void>;
  importMemo(fileName: string, bytes: Uint8Array): Promise<MemoInfo>;
  importFile(path: string): Promise<MemoInfo>;

  readSession(): Promise<string | null>;
  writeSession(json: string): Promise<void>;
  takePendingOpens(): Promise<PendingOpen[]>;

  openExternal(path: string): Promise<ExternalInfo>;
  readExternal(path: string): Promise<Uint8Array>;
  readExternalDraft(path: string): Promise<Uint8Array>;
  keepExternalDraft(path: string, bytes: Uint8Array): Promise<void>;
  discardExternalDraft(path: string): Promise<void>;
  saveExternal(path: string, bytes: Uint8Array): Promise<void>;

  listWorkspaces(): Promise<WorkspaceListItem[]>;
  createWorkspace(name: string): Promise<void>;
  openWorkspace(path: string): Promise<void>;

  /** Where this window is, for the session; `null` where there is no native window. */
  windowFrame(): Promise<WindowFrame | null>;
  /** The 「파일 열기」 dialog; empty when cancelled. */
  pickFiles(): Promise<string[]>;
  flushDone(id: number): Promise<void>;
  closeWindow(): Promise<void>;

  onMenu(handler: (id: string) => void): void;
  onFlush(handler: (id: number) => void): void;
  onPending(handler: () => void): void;
  onFileDrop(handler: (paths: string[]) => void): void;
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/backend/tauri.test.ts` — Task 8 의 명령 표와 같은 이름·인자·헤더로 부르는지 `invoke` 를 가로채 본다(스펙 「테스트」 의 IPC 목). Rust 쪽과 실제로 이어지는지는 Task 8·15 의 실제 앱 확인이 본다.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TauriBackend } from "./tauri";
import { BackendError } from "./types";

// Only invoke is under test; the window, webview and dialog modules reach the native side, so
// they are stubbed.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// The command table of src-tauri/src/app/commands.rs. A renamed command or argument key fails
// only at runtime inside the app, so the names are pinned here.
describe("TauriBackend", () => {
  const backend = new TauriBackend();

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(new ArrayBuffer(0));
  });

  it("calls each command with the argument names commands.rs takes", async () => {
    const calls: [() => Promise<unknown>, string, Record<string, unknown> | undefined][] = [
      [() => backend.workspaceInfo(), "workspace_info", undefined],
      [() => backend.listMemos(), "list_memos", undefined],
      [() => backend.createMemo(), "create_memo", undefined],
      [() => backend.readMemo("m"), "read_memo", { id: "m" }],
      [() => backend.retitleMemo("m", "제목"), "retitle_memo", { id: "m", stem: "제목" }],
      [() => backend.renameMemo("m", "a.md"), "rename_memo", { id: "m", file: "a.md" }],
      [() => backend.deleteMemo("m"), "delete_memo", { id: "m" }],
      [() => backend.importFile("/a.sh"), "import_file", { path: "/a.sh" }],
      [() => backend.readSession(), "read_session", undefined],
      [() => backend.writeSession("{}"), "write_session", { json: "{}" }],
      [() => backend.takePendingOpens(), "take_pending_opens", undefined],
      [() => backend.openExternal("/a.sh"), "open_external", { path: "/a.sh" }],
      [() => backend.readExternal("/a.sh"), "read_external", { path: "/a.sh" }],
      [() => backend.readExternalDraft("/a.sh"), "read_external_draft", { path: "/a.sh" }],
      [() => backend.discardExternalDraft("/a.sh"), "discard_external_draft", { path: "/a.sh" }],
      [() => backend.listWorkspaces(), "list_workspaces", undefined],
      [() => backend.createWorkspace("업무"), "create_workspace", { name: "업무" }],
      [() => backend.openWorkspace("/w/업무"), "open_workspace", { path: "/w/업무" }],
      [() => backend.flushDone(3), "flush_done", { id: 3 }],
      [() => backend.closeWindow(), "close_window", undefined],
    ];
    for (const [run, command, args] of calls) {
      invoke.mockClear();
      await run();
      expect(invoke).toHaveBeenCalledWith(command, args, undefined);
    }
  });

  it("sends contents as raw bytes and names in percent-encoded headers", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await backend.writeMemo("id 1", bytes);
    expect(invoke).toHaveBeenLastCalledWith("write_memo", bytes, {
      headers: { "x-memo-id": "id%201" },
    });
    await backend.importMemo("회의.md", bytes);
    expect(invoke).toHaveBeenLastCalledWith("import_memo", bytes, {
      headers: { "x-file-name": "%ED%9A%8C%EC%9D%98.md" },
    });
    await backend.keepExternalDraft("/a b/c.sh", bytes);
    expect(invoke).toHaveBeenLastCalledWith("keep_external_draft", bytes, {
      headers: { "x-path": "%2Fa%20b%2Fc.sh" },
    });
    await backend.saveExternal("/a b/c.sh", bytes);
    expect(invoke).toHaveBeenLastCalledWith("save_external", bytes, {
      headers: { "x-path": "%2Fa%20b%2Fc.sh" },
    });
  });

  it("turns a rejection into a BackendError that keeps the code", async () => {
    invoke.mockRejectedValueOnce({ code: "unknown-memo", message: "no memo with id m" });
    const error = await backend.readMemo("m").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: "unknown-memo", message: "no memo with id m" });
    invoke.mockRejectedValueOnce("the window is gone");
    await expect(backend.listMemos()).rejects.toMatchObject({ code: "app" });
  });
});
```

`src/core/codec.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decodeText, encodeText, longestLine } from "./codec";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("decodeText", () => {
  it("reads UTF-8 and notes LF line endings", () => {
    expect(decodeText(utf8("가나\n다"))).toEqual({ text: "가나\n다", eol: "\n", bom: false });
  });

  it("keeps CRLF and the BOM so a save writes them back", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("a\r\nb")]);
    expect(decodeText(bytes)).toEqual({ text: "a\r\nb", eol: "\r\n", bom: true });
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
    expect(decodeText(new Uint8Array([0xc3, 0x28]))).toBeNull();
  });

  it("treats a NUL byte near the start as binary", () => {
    expect(decodeText(new Uint8Array([0x41, 0x00, 0x42]))).toBeNull();
  });

  it("reads an empty file", () => {
    expect(decodeText(new Uint8Array())).toEqual({ text: "", eol: "\n", bom: false });
  });
});

describe("encodeText", () => {
  it("writes the BOM back only when the file had one", () => {
    expect([...encodeText("a", true)]).toEqual([0xef, 0xbb, 0xbf, 0x61]);
    expect([...encodeText("한", false)]).toEqual([0xed, 0x95, 0x9c]);
  });
});

describe("longestLine", () => {
  it("measures the longest line", () => {
    expect(longestLine("ab\nabcd\n")).toBe(4);
    expect(longestLine("")).toBe(0);
  });
});
```

`src/core/title.test.ts`:

```ts
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { memoTitle, titleFromLine, titleLine } from "./title";

describe("titleFromLine", () => {
  it("strips heading marks and leading space", () => {
    expect(titleFromLine("  ## 회의 준비")).toBe("회의 준비");
  });

  it("turns characters a file name cannot hold into spaces", () => {
    expect(titleFromLine('a/b:c*d?"e<f>g|h\\i')).toBe("a b c d e f g h i");
  });

  it("collapses spaces and drops leading dots", () => {
    expect(titleFromLine("  ..  숨김   파일 ")).toBe("숨김 파일");
    expect(titleFromLine("# .env 설정")).toBe("env 설정");
  });

  it("cuts at 60 characters without splitting an emoji", () => {
    const title = titleFromLine("가".repeat(59) + "😀😀");
    expect(Array.from(title)).toHaveLength(60);
    expect(title.endsWith("😀")).toBe(true);
  });

  it("falls back to untitled", () => {
    expect(titleFromLine("###")).toBe("untitled");
    expect(titleFromLine("")).toBe("untitled");
  });

  it("composes decomposed Hangul", () => {
    expect(titleFromLine("한")).toBe("한");
  });

  it("drops control characters", () => {
    expect(titleFromLine("a\tb\u0007c\u0085d")).toBe("a b c d");
  });
});

describe("titleLine and memoTitle", () => {
  it("take the first non-blank line", () => {
    const doc = Text.of(["", "   ", "# 제목", "본문"]);
    expect(titleLine(doc)).toEqual({ text: "# 제목", number: 3 });
    expect(memoTitle(doc)).toBe("제목");
  });

  it("call a blank memo untitled, on line 1", () => {
    const doc = Text.of(["", ""]);
    expect(titleLine(doc)).toEqual({ text: "", number: 1 });
    expect(memoTitle(doc)).toBe("untitled");
  });
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

```bash
pnpm test
```

Expected: `Failed to resolve import "./tauri"`, `"./codec"`, `"./title"` 로 세 파일 실패.

- [ ] **Step 4: 구현**

`src/backend/tauri.ts`:

```ts
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";

import {
  BackendError,
  type Backend,
  type ExternalInfo,
  type MemoInfo,
  type PendingOpen,
  type WindowFrame,
  type WorkspaceInfo,
  type WorkspaceListItem,
} from "./types";

async function call<T>(
  cmd: string,
  args?: InvokeArgs,
  headers?: Record<string, string>,
): Promise<T> {
  try {
    return await invoke<T>(cmd, args, headers ? { headers } : undefined);
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null;
    if (e && typeof e === "object" && typeof e.code === "string") {
      throw new BackendError(e.code, typeof e.message === "string" ? e.message : e.code);
    }
    throw new BackendError("app", String(err));
  }
}

const bytesOf = (buffer: ArrayBuffer) => new Uint8Array(buffer);
// Header values must be ASCII; names and paths are Korean as often as not.
const enc = encodeURIComponent;

export class TauriBackend implements Backend {
  private readonly window = getCurrentWebviewWindow();

  workspaceInfo() {
    return call<WorkspaceInfo>("workspace_info");
  }
  listMemos() {
    return call<MemoInfo[]>("list_memos");
  }
  createMemo() {
    return call<MemoInfo>("create_memo");
  }
  async readMemo(id: string) {
    return bytesOf(await call<ArrayBuffer>("read_memo", { id }));
  }
  writeMemo(id: string, bytes: Uint8Array) {
    return call<MemoInfo>("write_memo", bytes, { "x-memo-id": enc(id) });
  }
  retitleMemo(id: string, stem: string) {
    return call<MemoInfo>("retitle_memo", { id, stem });
  }
  renameMemo(id: string, file: string) {
    return call<MemoInfo>("rename_memo", { id, file });
  }
  deleteMemo(id: string) {
    return call<void>("delete_memo", { id });
  }
  importMemo(fileName: string, bytes: Uint8Array) {
    return call<MemoInfo>("import_memo", bytes, { "x-file-name": enc(fileName) });
  }
  importFile(path: string) {
    return call<MemoInfo>("import_file", { path });
  }

  readSession() {
    return call<string | null>("read_session");
  }
  writeSession(json: string) {
    return call<void>("write_session", { json });
  }
  takePendingOpens() {
    return call<PendingOpen[]>("take_pending_opens");
  }

  openExternal(path: string) {
    return call<ExternalInfo>("open_external", { path });
  }
  async readExternal(path: string) {
    return bytesOf(await call<ArrayBuffer>("read_external", { path }));
  }
  async readExternalDraft(path: string) {
    return bytesOf(await call<ArrayBuffer>("read_external_draft", { path }));
  }
  keepExternalDraft(path: string, bytes: Uint8Array) {
    return call<void>("keep_external_draft", bytes, { "x-path": enc(path) });
  }
  discardExternalDraft(path: string) {
    return call<void>("discard_external_draft", { path });
  }
  async saveExternal(path: string, bytes: Uint8Array) {
    await call<number>("save_external", bytes, { "x-path": enc(path) });
  }

  listWorkspaces() {
    return call<WorkspaceListItem[]>("list_workspaces");
  }
  createWorkspace(name: string) {
    return call<void>("create_workspace", { name });
  }
  openWorkspace(path: string) {
    return call<void>("open_workspace", { path });
  }

  async windowFrame(): Promise<WindowFrame> {
    const scale = await this.window.scaleFactor();
    const position = (await this.window.outerPosition()).toLogical(scale);
    const size = (await this.window.innerSize()).toLogical(scale);
    return { x: position.x, y: position.y, width: size.width, height: size.height };
  }

  async pickFiles() {
    return (await open({ multiple: true, directory: false })) ?? [];
  }

  flushDone(id: number) {
    return call<void>("flush_done", { id });
  }
  closeWindow() {
    return call<void>("close_window");
  }

  onMenu(handler: (id: string) => void) {
    void this.window.listen<string>("tote://menu", (event) => handler(event.payload));
  }
  onFlush(handler: (id: number) => void) {
    void this.window.listen<number>("tote://flush", (event) => handler(event.payload));
  }
  onPending(handler: () => void) {
    void this.window.listen("tote://pending", () => handler());
  }
  onFileDrop(handler: (paths: string[]) => void) {
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") handler(event.payload.paths);
    });
  }
}
```

`src/core/codec.ts`:

```ts
/** Text files as tote reads and writes them: UTF-8 only, with the BOM and the line endings kept
 * as found (spec 「저장」). */

export type Eol = "\n" | "\r\n";

export interface DecodedText {
  text: string;
  eol: Eol;
  bom: boolean;
}

const BOM = [0xef, 0xbb, 0xbf];
/** The binary test the spec uses for backups too: a NUL byte in the first 8 KB. */
const BINARY_PROBE_BYTES = 8192;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** The text of `bytes`, or `null` when they are not text (binary, or not valid UTF-8). */
export function decodeText(bytes: Uint8Array): DecodedText | null {
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
  const bom = BOM.every((byte, i) => bytes[i] === byte);
  let text: string;
  try {
    text = decoder.decode(bom ? bytes.subarray(BOM.length) : bytes);
  } catch {
    return null;
  }
  return { text, eol: text.includes("\r\n") ? "\r\n" : "\n", bom };
}

/** `text` must already use the file's line ending (`Text.sliceString(0, length, eol)`). */
export function encodeText(text: string, bom: boolean): Uint8Array {
  const body = encoder.encode(text);
  if (!bom) return body;
  const out = new Uint8Array(BOM.length + body.length);
  out.set(BOM);
  out.set(body, BOM.length);
  return out;
}

/** Length of the longest line. Soft wrap stays off above a limit: wrapping one huge line costs
 * seconds. */
export function longestLine(text: string): number {
  let longest = 0;
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    const stop = end === -1 ? text.length : end;
    longest = Math.max(longest, stop - start);
    if (end === -1) return longest;
    start = end + 1;
  }
}
```

`src/core/title.ts`:

```ts
import type { Text } from "@codemirror/state";

/** Spec 「제목 자동 생성」: the file-name stem a memo takes from its first non-blank line. */
export const TITLE_MAX_CHARS = 60;
export const UNTITLED = "untitled";
/** A title line further down is ignored; the check runs on every cursor move. */
const TITLE_SCAN_LINES = 1000;

const FORBIDDEN = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);

/** Control characters as Rust's `char::is_control` counts them (C0, DEL, C1): the backend
 * refuses names containing any. */
function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

export function titleFromLine(line: string): string {
  const cleaned = Array.from(line.normalize("NFC").replace(/^[\s#]+/, ""), (ch) =>
    FORBIDDEN.has(ch) || isControl(ch) ? " " : ch,
  ).join("");
  const stem = cleaned
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  const cut = Array.from(stem).slice(0, TITLE_MAX_CHARS).join("").trim();
  return cut || UNTITLED;
}

/** The first non-blank line and its number (line 1 for a blank memo). */
export function titleLine(doc: Text): { text: string; number: number } {
  const last = Math.min(doc.lines, TITLE_SCAN_LINES);
  for (let n = 1; n <= last; n++) {
    const line = doc.line(n);
    if (line.text.trim() !== "") return { text: line.text, number: n };
  }
  return { text: "", number: 1 };
}

export function memoTitle(doc: Text): string {
  return titleFromLine(titleLine(doc).text);
}
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
pnpm test
pnpm typecheck
```

Expected: `Tests  22 passed (22)`(names 3, tauri 3, codec 7, title 9), tsc 오류 없음.

- [ ] **Step 6: 포맷·린트·커밋**

```bash
pnpm exec oxfmt src
pnpm exec oxlint --fix src
git add src/backend/types.ts src/backend/tauri.ts src/backend/tauri.test.ts src/core/codec.ts src/core/codec.test.ts src/core/title.ts src/core/title.test.ts
git commit -m "feat(frontend): backend interface, text codec and the title rule"
```

---

### Task 10: 쓰기 스케줄러와 세션 형식

**Files:**

- Create: `src/core/scheduler.ts`, `src/core/scheduler.test.ts`, `src/core/session.ts`, `src/core/session.test.ts`

**Interfaces:**

- Produces (`src/core/scheduler.ts`): `class WriteScheduler(onError: (key: string, error: unknown) => void)` — `schedule(key, delayMs, write: () => Promise<void>)`(새 쓰기가 대기 중인 쓰기를 대신한다), `flush(key): Promise<void>`(대기 중인 쓰기를 바로 돌리고, 도는 쓰기까지 끝나면 끝난다), `flushAll()`, `cancel(key)`. 한 키의 쓰기는 겹치지 않는다.
- Produces (`src/core/session.ts`): `SessionFile { version: 1; window?: {x,y,width,height}; activeTab: number; tabs: SessionTab[] }`, `SessionTab = { kind: "memo"; memoId } | { kind: "external"; deviceId; path }`(둘 다 `selection?: SelectionJSON`, `scrollAnchor?: number`), `SelectionJSON { ranges: {anchor, head}[]; main: number }`(CodeMirror `EditorSelection.toJSON()` 형식), `parseSession(text: string | null): SessionFile`, `restoreSelection(json, doc: Text): EditorSelection`.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/scheduler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WriteScheduler } from "./scheduler";

describe("WriteScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes once, after changes stop for the delay", async () => {
    const writes: string[] = [];
    const s = new WriteScheduler(() => {});
    s.schedule("a", 500, async () => void writes.push("first"));
    await vi.advanceTimersByTimeAsync(300);
    s.schedule("a", 500, async () => void writes.push("second"));
    await vi.advanceTimersByTimeAsync(499);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual(["second"]);
  });

  it("flush writes now and the timer then has nothing left", async () => {
    const writes: string[] = [];
    const s = new WriteScheduler(() => {});
    s.schedule("a", 5000, async () => void writes.push("x"));
    await s.flush("a");
    expect(writes).toEqual(["x"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toEqual(["x"]);
  });

  it("never runs two writes of one key at once", async () => {
    let running = 0;
    let most = 0;
    const slow = () =>
      new Promise<void>((resolve) => {
        running++;
        most = Math.max(most, running);
        setTimeout(() => {
          running--;
          resolve();
        }, 100);
      });
    const s = new WriteScheduler(() => {});
    s.schedule("a", 0, slow);
    await vi.advanceTimersByTimeAsync(10);
    s.schedule("a", 0, slow);
    await vi.advanceTimersByTimeAsync(500);
    expect(most).toBe(1);
  });

  it("flush waits for a write that is already running", async () => {
    let done = false;
    const s = new WriteScheduler(() => {});
    s.schedule(
      "a",
      0,
      () => new Promise<void>((resolve) => setTimeout(() => resolve(void (done = true)), 100)),
    );
    await vi.advanceTimersByTimeAsync(1);
    const flushed = s.flush("a");
    await vi.advanceTimersByTimeAsync(100);
    await flushed;
    expect(done).toBe(true);
  });

  it("cancel drops a pending write", async () => {
    const writes: string[] = [];
    const s = new WriteScheduler(() => {});
    s.schedule("a", 100, async () => void writes.push("x"));
    s.cancel("a");
    await vi.advanceTimersByTimeAsync(1000);
    await s.flush("a");
    expect(writes).toEqual([]);
  });

  it("reports a failed write and keeps going", async () => {
    const errors: unknown[] = [];
    const writes: string[] = [];
    const s = new WriteScheduler((_key, error) => errors.push(error));
    s.schedule("a", 0, async () => {
      throw new Error("disk full");
    });
    await vi.advanceTimersByTimeAsync(1);
    s.schedule("a", 0, async () => void writes.push("retry"));
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toHaveLength(1);
    expect(writes).toEqual(["retry"]);
  });

  it("flushAll covers every key", async () => {
    const writes: string[] = [];
    const s = new WriteScheduler(() => {});
    s.schedule("a", 9999, async () => void writes.push("a"));
    s.schedule("b", 9999, async () => void writes.push("b"));
    await s.flushAll();
    expect(writes.sort()).toEqual(["a", "b"]);
  });
});
```

`src/core/session.test.ts`:

```ts
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { parseSession, restoreSelection } from "./session";

describe("parseSession", () => {
  it("starts empty without a file or with a broken one", () => {
    for (const text of [null, "", "{ broken", "[1]", '{"tabs":"x"}']) {
      expect(parseSession(text)).toEqual({ version: 1, activeTab: -1, tabs: [] });
    }
  });

  it("keeps the active tab when an earlier tab is dropped", () => {
    const session = parseSession(
      JSON.stringify({
        version: 1,
        activeTab: 2,
        tabs: [
          {
            kind: "memo",
            memoId: "a",
            selection: { ranges: [{ anchor: 1, head: 2 }], main: 0 },
            scrollAnchor: 40,
          },
          { kind: "mystery" },
          { kind: "external", deviceId: "d", path: "/x.sh" },
        ],
      }),
    );
    expect(session.activeTab).toBe(1);
    expect(session.tabs).toEqual([
      {
        kind: "memo",
        memoId: "a",
        selection: { ranges: [{ anchor: 1, head: 2 }], main: 0 },
        scrollAnchor: 40,
      },
      { kind: "external", deviceId: "d", path: "/x.sh" },
    ]);
  });

  it("reads the window frame when it is complete", () => {
    expect(
      parseSession('{"tabs":[],"window":{"x":1,"y":2,"width":800,"height":600}}').window,
    ).toEqual({
      x: 1,
      y: 2,
      width: 800,
      height: 600,
    });
    expect(parseSession('{"tabs":[],"window":{"x":"1"}}').window).toBeUndefined();
  });
});

describe("restoreSelection", () => {
  it("pulls positions past the end back in and keeps the main range", () => {
    const sel = restoreSelection(
      {
        ranges: [
          { anchor: 1, head: 1 },
          { anchor: 10, head: 10 },
        ],
        main: 1,
      },
      Text.of(["abc"]),
    );
    expect(sel.ranges.map((r) => r.head)).toEqual([1, 3]);
    expect(sel.mainIndex).toBe(1);
  });

  it("starts at the top without a saved selection", () => {
    expect(restoreSelection(undefined, Text.of(["abc"])).main.head).toBe(0);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
pnpm test
```

Expected: `Failed to resolve import "./scheduler"`, `"./session"` 으로 두 파일 실패.

- [ ] **Step 3: 구현**

`src/core/scheduler.ts`:

```ts
type Write = () => Promise<void>;

interface Slot {
  timer: ReturnType<typeof setTimeout> | null;
  next: Write | null;
  running: Promise<void> | null;
}

/** Delayed writes, one queue per key. A newer write replaces a pending one, two writes of a key
 * never overlap, and `flush` runs the pending write at once — the safety net for timers that a
 * hidden window barely runs (spec 「저장」). */
export class WriteScheduler {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly onError: (key: string, error: unknown) => void) {}

  schedule(key: string, delayMs: number, write: Write): void {
    const slot = this.slot(key);
    slot.next = write;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => void this.flush(key), delayMs);
  }

  /** Runs the pending write of `key` now and resolves once no write of it is left. */
  async flush(key: string): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot) return;
    for (;;) {
      if (slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      if (slot.running) {
        await slot.running;
        continue;
      }
      const write = slot.next;
      if (!write) return;
      slot.next = null;
      slot.running = write()
        .catch((error: unknown) => this.onError(key, error))
        .finally(() => {
          slot.running = null;
        });
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((key) => this.flush(key)));
  }

  /** Drops the pending write of `key`; one already running still finishes. */
  cancel(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    slot.next = null;
  }

  private slot(key: string): Slot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { timer: null, next: null, running: null };
      this.slots.set(key, slot);
    }
    return slot;
  }
}
```

`src/core/session.ts`:

```ts
import { EditorSelection, type Text } from "@codemirror/state";

/** One workspace window on one device, `.tote/sessions/<device ID>.json` (spec 「세션」). The
 * backend only checks that it is a JSON object and reads `window` before the window exists. */
export interface SessionFile {
  version: 1;
  /** Outer position and inner size in logical pixels. */
  window?: { x: number; y: number; width: number; height: number };
  /** Index into `tabs`; -1 when there are none. */
  activeTab: number;
  tabs: SessionTab[];
}

/** `EditorSelection.toJSON()`. */
export interface SelectionJSON {
  ranges: { anchor: number; head: number }[];
  main: number;
}

interface TabPlace {
  selection?: SelectionJSON;
  /** Document position at the top of the viewport. */
  scrollAnchor?: number;
}

export type SessionTab =
  | ({ kind: "memo"; memoId: string } & TabPlace)
  | ({ kind: "external"; deviceId: string; path: string } & TabPlace);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Reads a session leniently: a tab that does not parse is dropped, not the whole session. */
export function parseSession(text: string | null): SessionFile {
  const session: SessionFile = { version: 1, activeTab: -1, tabs: [] };
  let raw: unknown = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    return session;
  }
  if (!isObject(raw) || !Array.isArray(raw.tabs)) return session;
  const active = raw.activeTab;
  raw.tabs.forEach((value: unknown, index: number) => {
    const tab = parseTab(value);
    if (!tab) return;
    if (index === active) session.activeTab = session.tabs.length;
    session.tabs.push(tab);
  });
  const frame = parseFrame(raw.window);
  if (frame) session.window = frame;
  return session;
}

function parseTab(value: unknown): SessionTab | null {
  if (!isObject(value)) return null;
  const place: TabPlace = {};
  const selection = parseSelection(value.selection);
  if (selection) place.selection = selection;
  if (isNumber(value.scrollAnchor)) place.scrollAnchor = value.scrollAnchor;
  if (value.kind === "memo" && typeof value.memoId === "string") {
    return { kind: "memo", memoId: value.memoId, ...place };
  }
  if (
    value.kind === "external" &&
    typeof value.deviceId === "string" &&
    typeof value.path === "string"
  ) {
    return { kind: "external", deviceId: value.deviceId, path: value.path, ...place };
  }
  return null;
}

function parseSelection(value: unknown): SelectionJSON | undefined {
  if (!isObject(value) || !Array.isArray(value.ranges)) return undefined;
  const ranges = value.ranges
    .filter(
      (r: unknown): r is { anchor: number; head: number } =>
        isObject(r) && isNumber(r.anchor) && isNumber(r.head),
    )
    .map(({ anchor, head }) => ({ anchor, head }));
  if (ranges.length === 0) return undefined;
  return { ranges, main: Number.isInteger(value.main) ? (value.main as number) : 0 };
}

function parseFrame(value: unknown): SessionFile["window"] {
  if (!isObject(value)) return undefined;
  const { x, y, width, height } = value;
  return isNumber(x) && isNumber(y) && isNumber(width) && isNumber(height)
    ? { x, y, width, height }
    : undefined;
}

/** `json` fitted to `doc`: positions past its end (the file shrank since) are pulled in. */
export function restoreSelection(json: SelectionJSON | undefined, doc: Text): EditorSelection {
  if (!json || json.ranges.length === 0) return EditorSelection.single(0);
  const clamp = (pos: number) => Math.max(0, Math.min(doc.length, pos));
  const ranges = json.ranges.map((r) => EditorSelection.range(clamp(r.anchor), clamp(r.head)));
  const main = json.main >= 0 && json.main < ranges.length ? json.main : 0;
  return EditorSelection.create(ranges, main);
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
pnpm test
pnpm typecheck
```

Expected: `Tests  34 passed (34)`(이전 22 + scheduler 7, session 5).

- [ ] **Step 5: 포맷·린트·커밋**

```bash
pnpm exec oxfmt src/core
pnpm exec oxlint --fix src/core
git add src/core/scheduler.ts src/core/scheduler.test.ts src/core/session.ts src/core/session.test.ts
git commit -m "feat(frontend): debounced write scheduler and the session file format"
```

---

### Task 11: 편집기 — Zed 식 키맵, ⌥ 마우스, 한글 조합

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `src/editor/setup.ts`, `src/editor/alt-mouse.ts`, `src/editor/ime.ts`, `src/editor/ime.test.ts`, `playwright.config.ts`, `tests/e2e/globals.d.ts`, `tests/e2e/pages/editor.html`, `tests/e2e/pages/editor.ts`, `tests/e2e/editor.spec.ts`

**Interfaces:**

- Consumes: Task 1 `splitName`.
- Produces (`src/editor/setup.ts`): `editorExtensions({ fileName, wrap, onUpdate }): Extension[]`, `languageFor(fileName): Extension`, `languageEffect(fileName): StateEffect<unknown>`(언어 Compartment 재설정), `zedKeymap: KeyBinding[]`, `insertIndent: Command`.
- Produces (`src/editor/alt-mouse.ts`): `altMouseSelection(): Extension`. (`src/editor/ime.ts`): `compositionSelection(sel): EditorSelection | null`, `collapseSelectionOnComposition: Extension`.
- Produces (스크립트): `pnpm test:e2e`(Playwright, WebKit).

**키맵(스펙 「편집기」 의 「세부 단축키는 구현 계획에서 확정한다」 확정본):**

| 동작                            | 키                                                                 | 출처                                  |
| ------------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| 커서 추가                       | ⌥클릭                                                              | `altMouseSelection`                   |
| 사각 선택(지금 선택을 대신한다) | ⌥드래그                                                            | `altMouseSelection`                   |
| 위·아래 줄에 커서 추가          | ⌘⌥↑ / ⌘⌥↓                                                          | CodeMirror 기본                       |
| 다음 같은 단어 선택 / 모두 선택 | ⌘D / ⌘⇧L                                                           | CodeMirror 검색 키맵                  |
| 마지막 선택 되돌리기            | ⌘U                                                                 | CodeMirror 기록 키맵                  |
| 커서 하나로                     | Esc                                                                | CodeMirror 기본                       |
| 줄 선택                         | ⌘L                                                                 | `zedKeymap`                           |
| 줄 복제                         | ⌘⇧D                                                                | `zedKeymap`                           |
| 줄 옮기기 / 줄 지우기           | ⌥↑ ⌥↓ / ⌘⇧K                                                        | CodeMirror 기본                       |
| 들여쓰기 / 내어쓰기             | Tab(커서마다 들여쓰기 단위, 선택이 있으면 줄 단위) / ⇧Tab, ⌘] / ⌘[ | `zedKeymap`, CodeMirror 기본          |
| 주석 토글                       | ⌘/                                                                 | CodeMirror 기본(언어 설정은 2번 계획) |
| 파일 안 찾기 / 다음 / 이전      | ⌘F / ⌘G / ⌘⇧G                                                      | CodeMirror 검색 키맵                  |

⌘⇧] / ⌘⇧[(탭 이동), ⌘N·⌘O·⌘S·⌘W·⌘⇧W·⌘⇧O·⌘⇧N·⌘Q 는 메뉴가 갖는다(Task 8). 메뉴와 편집기가 같은 키를 갖지 않게 한다 — WKWebView 는 페이지가 막은 키를 메뉴에 넘기지 않는다.

- [ ] **Step 1: Playwright 준비**

```bash
pnpm add -D @playwright/test
pnpm exec playwright install webkit
```

`package.json` 의 `scripts` 에 `"test:e2e": "playwright test"` 를 더한다.

`playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

// Worktrees run side by side, so the port comes from the environment
// (docs/guideline/base/08-shared-resources.md); strictPort makes a clash fail loudly.
const port = Number(process.env.TOTE_E2E_PORT ?? 1430);

export default defineConfig({
  testDir: "tests/e2e",
  // WebKit is the engine closest to the app's WKWebView.
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
```

`tests/e2e/globals.d.ts`(Task 12·14 가 넓힌다):

```ts
import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

declare global {
  interface Window {
    view: EditorView;
    EditorSelection: typeof EditorSelection;
  }
}

export {};
```

`tests/e2e/pages/editor.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>editor</title>
    <script type="module" src="./editor.ts"></script>
  </head>
  <body style="margin: 0">
    <div id="editor" style="height: 400px"></div>
  </body>
</html>
```

`tests/e2e/pages/editor.ts`:

```ts
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorExtensions } from "../../../src/editor/setup";

const params = new URLSearchParams(location.search);
const view = new EditorView({
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc: params.get("doc") ?? "",
    extensions: editorExtensions({
      fileName: params.get("file") ?? "note.md",
      wrap: true,
      onUpdate: () => {},
    }),
  }),
});
view.focus();
// The specs drive and inspect the editor through these.
Object.assign(window, { view, EditorSelection });
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/editor/ime.test.ts`:

```ts
import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { compositionSelection } from "./ime";

describe("compositionSelection", () => {
  it("keeps only the main range of several", () => {
    const sel = EditorSelection.create(
      [EditorSelection.cursor(2), EditorSelection.range(4, 6), EditorSelection.cursor(9)],
      1,
    );
    expect(compositionSelection(sel)?.ranges.map((r) => [r.from, r.to])).toEqual([[4, 6]]);
  });

  it("leaves a single cursor alone", () => {
    expect(compositionSelection(EditorSelection.single(3))).toBeNull();
  });
});
```

`tests/e2e/editor.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, doc: string, file = "note.md") {
  await page.goto(
    `/tests/e2e/pages/editor.html?file=${encodeURIComponent(file)}&doc=${encodeURIComponent(doc)}`,
  );
  await expect(page.locator(".cm-content")).toBeFocused();
}

/** A screen point just inside the character at `pos`. */
function pointAt(page: Page, pos: number) {
  return page.evaluate((p) => {
    const rect = window.view.coordsAtPos(p)!;
    return { x: rect.left + 2, y: (rect.top + rect.bottom) / 2 };
  }, pos);
}

const ranges = (page: Page) =>
  page.evaluate(() => window.view.state.selection.ranges.map((r) => [r.anchor, r.head]));
const text = (page: Page) => page.evaluate(() => window.view.state.doc.toString());

test("⌥click adds a cursor and keeps the one already there", async ({ page }) => {
  await open(page, "one\ntwo\nthree");
  const a = await pointAt(page, 1);
  const b = await pointAt(page, 5);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down("Alt");
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up("Alt");
  expect(await ranges(page)).toEqual([
    [1, 1],
    [5, 5],
  ]);
});

test("⌥drag selects a rectangle that replaces the selection", async ({ page }) => {
  await open(page, "abcd\nefgh\nijkl");
  const start = await pointAt(page, 1);
  const end = await pointAt(page, 12);
  await page.mouse.click(start.x - 4, start.y); // a plain cursor first, which must not survive
  await page.keyboard.down("Alt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect(await ranges(page)).toEqual([
    [1, 2],
    [6, 7],
    [11, 12],
  ]);
});

test("a composition starting with several cursors keeps only the main one", async ({ page }) => {
  await open(page, "하나\n둘\n셋");
  await page.evaluate(() => {
    const { view, EditorSelection } = window;
    view.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.cursor(2), EditorSelection.cursor(4), EditorSelection.cursor(6)],
        0,
      ),
    });
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  });
  expect(await ranges(page)).toEqual([[2, 2]]);
});

test("⌘D adds the next occurrence of the selected word", async ({ page }) => {
  await open(page, "foo bar foo");
  await page.evaluate(() => window.view.dispatch({ selection: { anchor: 0, head: 3 } }));
  await page.keyboard.press("Meta+d");
  expect(await ranges(page)).toEqual([
    [0, 3],
    [8, 11],
  ]);
});

test("Enter continues a Markdown list and Tab indents at the cursor", async ({ page }) => {
  await open(page, "");
  await page.keyboard.type("- 하나");
  await page.keyboard.press("Enter");
  await page.keyboard.type("둘");
  expect(await text(page)).toBe("- 하나\n- 둘");
  await page.keyboard.press("Tab");
  expect(await text(page)).toBe("- 하나\n- 둘  ");
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

```bash
pnpm test
pnpm test:e2e
```

Expected: Vitest 는 `Failed to resolve import "./ime"`, Playwright 는 페이지가 `../../../src/editor/setup` 을 불러오지 못해 5개 모두 실패.

- [ ] **Step 4: 구현**

`src/editor/ime.ts`:

```ts
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** The selection to keep when an IME composition starts. WKWebView feeds the composition to the
 * main selection only and leaves stray jamo at the others, so the others go first (spec 「편집기」,
 * spike report 「한글 입력」). `null` when there is nothing to drop. */
export function compositionSelection(selection: EditorSelection): EditorSelection | null {
  return selection.ranges.length > 1 ? EditorSelection.create([selection.main]) : null;
}

export const collapseSelectionOnComposition = EditorView.domEventHandlers({
  compositionstart(_event, view) {
    const next = compositionSelection(view.state.selection);
    if (next) view.dispatch({ selection: next, userEvent: "select" });
    // CodeMirror still runs its own composition handling.
    return false;
  },
});
```

`src/editor/alt-mouse.ts`:

```ts
import { EditorState } from "@codemirror/state";
import { EditorView, rectangularSelection, type MouseSelectionStyle } from "@codemirror/view";

// CodeMirror's own rectangle gesture, taken from its facet: its geometry is kept, and only the
// choice between adding to the selection and replacing it is made here.
const rectangle = EditorState.create({ extensions: rectangularSelection() }).facet(
  EditorView.mouseSelectionStyle,
)[0];

/** A move this small is still a click (trackpads jitter). */
const DRAG_THRESHOLD_PX = 4;

/** ⌥click adds a cursor; ⌥drag selects a rectangle that replaces the selection (spec 「편집기」).
 * CodeMirror alone adds the rectangle to the selection, which leaves the cursor from the click
 * before it behind as a stray extra cursor. */
export function altMouseSelection() {
  return EditorView.mouseSelectionStyle.of((view, start) => {
    if (!start.altKey || start.button !== 0) return null;
    const style = rectangle(view, start);
    if (!style) return null;
    return {
      update: (update) => style.update(update),
      get(current, extend) {
        const moved =
          Math.abs(current.clientX - start.clientX) + Math.abs(current.clientY - start.clientY);
        return style.get(current, extend, moved <= DRAG_THRESHOLD_PX);
      },
    } satisfies MouseSelectionStyle;
  });
}
```

`src/editor/setup.ts`:

```ts
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  copyLineDown,
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  selectLine,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  type Command,
  type KeyBinding,
  type ViewUpdate,
} from "@codemirror/view";

import { splitName } from "../core/names";
import { altMouseSelection } from "./alt-mouse";
import { collapseSelectionOnComposition } from "./ime";

/** Tab: an indent unit at every cursor; with text selected, indents the selected lines. */
export const insertIndent: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
  view.dispatch(
    state.update(state.replaceSelection(state.facet(indentUnit)), {
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/** The Zed bindings CodeMirror's keymaps lack or bind elsewhere; the rest of the plan's key table
 * is CodeMirror's default. */
export const zedKeymap: KeyBinding[] = [
  { key: "Mod-l", run: selectLine, preventDefault: true },
  { key: "Mod-Shift-d", run: copyLineDown, preventDefault: true },
  { key: "Tab", run: insertIndent, shift: indentLess },
];

const language = new Compartment();

/** Markdown gets its editing aids (list continuation) from the bundled parser and keymap. Colours
 * come later from TextMate highlighting, so no highlight style is attached here. */
export function languageFor(fileName: string): Extension {
  const ext = splitName(fileName).ext.toLowerCase();
  return ext === "md" || ext === "markdown" ? markdown() : [];
}

/** Switches the language of a state built by `editorExtensions` (after a rename). */
export function languageEffect(fileName: string) {
  return language.reconfigure(languageFor(fileName));
}

/** Colours come from the CSS variables in styles.css, which a later plan fills from the theme. */
const appTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font)",
    fontSize: "var(--editor-size)",
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--fg)", padding: "8px 0" },
  ".cm-line": { padding: "0 16px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  ".cm-panels": { backgroundColor: "var(--sidebar-bg)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
});

export interface EditorOptions {
  fileName: string;
  /** Soft wrap; off when a line is too long to wrap cheaply (`WRAP_LIMIT` in src/app/docs.ts). */
  wrap: boolean;
  onUpdate: (update: ViewUpdate) => void;
}

export function editorExtensions(options: EditorOptions): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    altMouseSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSpecialChars(),
    highlightSelectionMatches(),
    closeBrackets(),
    search({ top: true }),
    collapseSelectionOnComposition,
    options.wrap ? EditorView.lineWrapping : [],
    language.of(languageFor(options.fileName)),
    keymap.of([
      ...zedKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
    ]),
    appTheme,
    EditorView.updateListener.of(options.onUpdate),
  ];
}
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
```

Expected: Vitest `Tests  36 passed (36)`, Playwright `5 passed`, tsc 오류 없음. ⌥ 드래그 테스트가 위치 때문에 흔들리면 `pointAt` 의 `+ 2` 를 글자 폭의 절반보다 작게 유지했는지 본다.

- [ ] **Step 6: 포맷·린트·커밋**

```bash
pnpm exec oxfmt package.json playwright.config.ts src/editor tests
pnpm exec oxlint --fix src/editor tests playwright.config.ts
git add package.json pnpm-lock.yaml playwright.config.ts src/editor tests/e2e/globals.d.ts tests/e2e/pages/editor.html tests/e2e/pages/editor.ts tests/e2e/editor.spec.ts
git commit -m "feat(editor): Zed-style keymap, alt-click cursors, rectangle drag and IME selection collapse"
```

---

### Task 12: 화면 부품 — 메모 목록, 탭, 상태 표시줄, 대화상자

**Files:**

- Modify: `src/styles.css`, `tests/e2e/globals.d.ts`
- Create: `src/ui/dom.ts`, `src/ui/memo-list.ts`, `src/ui/memo-list.test.ts`, `src/ui/tab-bar.ts`, `src/ui/status-bar.ts`, `src/ui/dialogs.ts`, `tests/e2e/pages/dialogs.html`, `tests/e2e/pages/dialogs.ts`, `tests/e2e/dialogs.spec.ts`

**Interfaces:**

- Consumes: Task 9 `MemoInfo`·`WorkspaceListItem`, Task 1 `splitName`.
- Produces (`src/ui/dom.ts`): `h(tag, props?, ...children)` — `props` 는 그 요소의 속성 + `class`·`data`.
- Produces (`src/ui/memo-list.ts`): `ROW_HEIGHT = 28`, `filterMemos(memos, query)`, `byRecent(a, b)`, `visibleRows(scrollTop, height, count): [start, end]`, `class MemoList(onOpen: (id) => void)` — `el`, `get(id)`, `setMemos(list)`, `upsert(info)`, `remove(id)`, `setActive(id | null)`. 행 DOM: `.memo-row.kind-<kind>[.active] > .memo-icon + .memo-name(이름에서 확장자 뺀 것) + .memo-ext`. 필터 입력은 `.memo-filter`.
- Produces (`src/ui/tab-bar.ts`): `TabView { id, title, hint, dirty, external, active }`, `class TabBar({ select(id), close(id) })` — `el`, `render(tabs)`. 탭 DOM: `.tab[.active][.dirty][.external] > .tab-title + .tab-close`.
- Produces (`src/ui/status-bar.ts`): `languageLabel(fileName)`, `class StatusBar` — `el`, `setMessage(text, tone?)`, `setPosition(state | null)`, `setLanguage(label)`. 메시지는 `.status-message`.
- Produces (`src/ui/dialogs.ts`): `askUnsaved(name): Promise<"save" | "discard" | "cancel">`, `promptText(message, initial): Promise<string | null>`, `workspacePicker(items, { open(path), create(name): Promise<string | null> }): Promise<void>`. 모두 `.modal-backdrop > .modal`, 버튼 이름은 `저장`·`버리기`·`취소`·`확인`·`만들기`.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ui/memo-list.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { MemoInfo } from "../backend/types";
import { byRecent, filterMemos, visibleRows } from "./memo-list";

const memo = (file: string, modifiedMs = 0): MemoInfo => ({
  id: file,
  file,
  autoTitle: false,
  modifiedMs,
  size: 0,
  kind: "text",
});

describe("filterMemos", () => {
  it("matches decomposed Hangul from Finder against composed input", () => {
    const nfd = memo("한글 메모.md".normalize("NFD"));
    expect(filterMemos([nfd, memo("다른.md")], "한글")).toEqual([nfd]);
  });

  it("ignores case and keeps everything for an empty query", () => {
    const list = [memo("README.md"), memo("todo.txt")];
    expect(filterMemos(list, "readme")).toEqual([list[0]]);
    expect(filterMemos(list, "  ")).toEqual(list);
  });
});

describe("byRecent", () => {
  it("puts the newest first and breaks ties by name", () => {
    const files = [memo("b.md", 1), memo("c.md", 5), memo("a.md", 1)]
      .sort(byRecent)
      .map((m) => m.file);
    expect(files).toEqual(["c.md", "a.md", "b.md"]);
  });
});

describe("visibleRows", () => {
  it("renders the rows in view plus some to spare", () => {
    expect(visibleRows(0, 280, 10_000)).toEqual([0, 18]);
    expect(visibleRows(2800, 280, 10_000)).toEqual([92, 118]);
    expect(visibleRows(0, 280, 5)).toEqual([0, 5]);
  });
});
```

`tests/e2e/globals.d.ts` 의 `Window` 에 더한다(파일 위에 `import type { askUnsaved, promptText, workspacePicker } from "../../src/ui/dialogs";`).

```ts
askUnsaved: typeof askUnsaved;
promptText: typeof promptText;
workspacePicker: typeof workspacePicker;
result: unknown;
```

`tests/e2e/pages/dialogs.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>dialogs</title>
    <link rel="stylesheet" href="/src/styles.css" />
    <script type="module" src="./dialogs.ts"></script>
  </head>
  <body></body>
</html>
```

`tests/e2e/pages/dialogs.ts`:

```ts
import { askUnsaved, promptText, workspacePicker } from "../../../src/ui/dialogs";

Object.assign(window, { askUnsaved, promptText, workspacePicker });
```

`tests/e2e/dialogs.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/pages/dialogs.html");
});

test("the unsaved-changes question answers with the button pressed; Escape cancels", async ({
  page,
}) => {
  await page.evaluate(() => void window.askUnsaved("a.sh").then((r) => (window.result = r)));
  await page.getByRole("button", { name: "저장" }).click();
  await expect.poll(() => page.evaluate(() => window.result)).toBe("save");
  await page.evaluate(() => void window.askUnsaved("a.sh").then((r) => (window.result = r)));
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => window.result)).toBe("cancel");
  await expect(page.locator(".modal")).toHaveCount(0);
});

test("Enter that finishes a composition does not submit", async ({ page }) => {
  await page.evaluate(
    () => void window.promptText("새 파일 이름", "메모.md").then((r) => (window.result = r)),
  );
  const input = page.locator(".modal input");
  await expect(input).toBeFocused();
  await input.fill("회의록.md");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229 });
  await expect(page.locator(".modal")).toHaveCount(1);
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.result)).toBe("회의록.md");
});

test("the workspace picker shows why a name was refused", async ({ page }) => {
  await page.evaluate(
    () =>
      void window.workspacePicker([{ name: "메모", path: "/w/메모", open: true }], {
        open: () => {},
        create: async (name) => (name === "" ? "쓸 수 없는 이름입니다" : null),
      }),
  );
  await expect(page.locator(".picker-list li")).toHaveText(["메모 (열림)"]);
  await page.getByRole("button", { name: "만들기" }).click();
  await expect(page.locator(".modal-error")).toHaveText("쓸 수 없는 이름입니다");
  await page.locator(".modal input").fill("새 곳");
  await page.getByRole("button", { name: "만들기" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
pnpm test
pnpm test:e2e dialogs
```

Expected: Vitest 는 `Failed to resolve import "./memo-list"`, Playwright 는 대화상자 모듈이 없어 3개 실패.

- [ ] **Step 3: 구현**

`src/ui/dom.ts`:

```ts
type Child = Node | string | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], "className" | "dataset" | "style">
> & { class?: string; data?: Record<string, string> };

/** `document.createElement` with properties and children in one call. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const { class: className, data, ...rest } = props;
  const element = Object.assign(document.createElement(tag), rest);
  if (className) element.className = className;
  if (data) Object.assign(element.dataset, data);
  for (const child of children) if (child) element.append(child);
  return element;
}
```

`src/ui/memo-list.ts`:

```ts
import type { MemoInfo } from "../backend/types";
import { splitName } from "../core/names";
import { h } from "./dom";

export const ROW_HEIGHT = 28;
const OVERSCAN_ROWS = 8;

/** For matching only: Finder may hand over decomposed (NFD) Hangul while typed text is composed. */
const fold = (text: string) => text.normalize("NFC").toLocaleLowerCase();

export function filterMemos(memos: readonly MemoInfo[], query: string): MemoInfo[] {
  const wanted = fold(query.trim());
  return wanted ? memos.filter((memo) => fold(memo.file).includes(wanted)) : [...memos];
}

/** Most recently modified first, ties by name — the order the backend lists in. */
export function byRecent(a: MemoInfo, b: MemoInfo): number {
  return b.modifiedMs - a.modifiedMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}

/** Rows [start, end) worth rendering for a viewport, with some to spare on both sides. A
 * workspace may hold 10,000 memos; only these exist in the DOM. */
export function visibleRows(scrollTop: number, height: number, count: number): [number, number] {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const end = Math.min(count, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN_ROWS);
  return [start, end];
}

/** The sidebar: every memo, newest first, filtered by name (spec 「메모 목록」). */
export class MemoList {
  private readonly filter = h("input", {
    type: "search",
    placeholder: "제목 필터",
    class: "memo-filter",
  });
  private readonly rows = h("div", { class: "memo-rows" });
  private readonly scroller = h("div", { class: "memo-scroller" }, this.rows);
  readonly el = h("nav", { class: "sidebar" }, this.filter, this.scroller);
  private memos: MemoInfo[] = [];
  private shown: MemoInfo[] = [];
  private activeId: string | null = null;

  constructor(private readonly onOpen: (id: string) => void) {
    this.filter.spellcheck = false;
    this.filter.addEventListener("input", () => this.refilter());
    this.scroller.addEventListener("scroll", () => this.render(), { passive: true });
    new ResizeObserver(() => this.render()).observe(this.scroller);
  }

  get(id: string): MemoInfo | undefined {
    return this.memos.find((memo) => memo.id === id);
  }

  setMemos(memos: MemoInfo[]): void {
    this.memos = [...memos].sort(byRecent);
    this.refilter();
  }

  upsert(info: MemoInfo): void {
    this.memos = [...this.memos.filter((memo) => memo.id !== info.id), info].sort(byRecent);
    this.refilter();
  }

  remove(id: string): void {
    this.memos = this.memos.filter((memo) => memo.id !== id);
    this.refilter();
  }

  setActive(id: string | null): void {
    this.activeId = id;
    this.render();
  }

  private refilter(): void {
    this.shown = filterMemos(this.memos, this.filter.value);
    this.render();
  }

  private render(): void {
    this.rows.style.height = `${this.shown.length * ROW_HEIGHT}px`;
    const [start, end] = visibleRows(
      this.scroller.scrollTop,
      this.scroller.clientHeight,
      this.shown.length,
    );
    this.rows.replaceChildren(
      ...this.shown.slice(start, end).map((memo, i) => this.row(memo, start + i)),
    );
  }

  private row(memo: MemoInfo, index: number): HTMLElement {
    const { stem, ext } = splitName(memo.file);
    const active = memo.id === this.activeId ? " active" : "";
    const row = h(
      "div",
      { class: `memo-row kind-${memo.kind}${active}`, title: memo.file },
      h("span", { class: "memo-icon" }),
      h("span", { class: "memo-name", textContent: stem }),
      ext ? h("span", { class: "memo-ext", textContent: ext }) : null,
    );
    row.style.top = `${index * ROW_HEIGHT}px`;
    row.addEventListener("click", () => this.onOpen(memo.id));
    return row;
  }
}
```

`src/ui/tab-bar.ts`:

```ts
import { h } from "./dom";

export interface TabView {
  id: string;
  title: string;
  hint: string;
  dirty: boolean;
  external: boolean;
  active: boolean;
}

export class TabBar {
  readonly el = h("div", { class: "tabbar", role: "tablist" });

  constructor(private readonly actions: { select(id: string): void; close(id: string): void }) {}

  render(tabs: TabView[]): void {
    this.el.replaceChildren(...tabs.map((tab) => this.tab(tab)));
    this.el.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private tab(tab: TabView): HTMLElement {
    const close = h("button", {
      class: "tab-close",
      title: "탭 닫기",
      textContent: "×",
      tabIndex: -1,
    });
    close.addEventListener("click", () => this.actions.close(tab.id));
    const classes = [
      "tab",
      tab.active && "active",
      tab.dirty && "dirty",
      tab.external && "external",
    ]
      .filter(Boolean)
      .join(" ");
    const el = h(
      "div",
      { class: classes, role: "tab", title: tab.hint, data: { id: tab.id } },
      h("span", { class: "tab-title", textContent: tab.title }),
      close,
    );
    el.addEventListener("mousedown", (event) => {
      if (event.button === 0 && !(event.target as Element).closest(".tab-close"))
        this.actions.select(tab.id);
    });
    el.addEventListener("auxclick", (event) => {
      if (event.button === 1) this.actions.close(tab.id);
    });
    return el;
  }
}
```

`src/ui/status-bar.ts`:

```ts
import type { EditorState } from "@codemirror/state";

import { splitName } from "../core/names";
import { h } from "./dom";

/** Until the extension registry (a later plan) names languages, the extension stands in. */
export function languageLabel(fileName: string): string {
  const ext = splitName(fileName).ext.toLowerCase();
  if (ext === "md" || ext === "markdown") return "Markdown";
  return ext ? ext.toUpperCase() : "텍스트";
}

export class StatusBar {
  private readonly message = h("span", { class: "status-message" });
  private readonly position = h("span", { class: "status-position" });
  private readonly language = h("span", { class: "status-language" });
  readonly el = h("footer", { class: "statusbar" }, this.message, this.position, this.language);

  setMessage(text: string, tone: "normal" | "error" = "normal"): void {
    this.message.textContent = text;
    this.message.classList.toggle("error", tone === "error");
  }

  setPosition(state: EditorState | null): void {
    if (!state) {
      this.position.textContent = "";
      return;
    }
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const cursors = state.selection.ranges.length;
    this.position.textContent = `줄 ${line.number}, 열 ${head - line.from + 1}${cursors > 1 ? ` · 커서 ${cursors}개` : ""}`;
  }

  setLanguage(label: string): void {
    this.language.textContent = label;
  }
}
```

`src/ui/dialogs.ts`:

```ts
import type { WorkspaceListItem } from "../backend/types";
import { h } from "./dom";

/** A modal over the window. Resolves with what `build` passes to `close`, or `null` on Escape. */
function modal<T>(build: (close: (value: T | null) => void) => HTMLElement): Promise<T | null> {
  return new Promise((resolve) => {
    const backdrop = h("div", { class: "modal-backdrop" });
    const close = (value: T | null) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close(null);
    };
    backdrop.append(build(close));
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    backdrop.querySelector<HTMLElement>("input, button.primary")?.focus();
  });
}

/** An Enter that finishes a Korean syllable is not a submit: WebKit reports it while composing,
 * and taking it as one would submit the name without its last syllable. */
function isSubmitEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.isComposing && event.keyCode !== 229;
}

function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = h("button", { textContent: label, class: className });
  b.addEventListener("click", onClick);
  return b;
}

export type UnsavedChoice = "save" | "discard" | "cancel";

export async function askUnsaved(name: string): Promise<UnsavedChoice> {
  const choice = await modal<UnsavedChoice>((close) =>
    h(
      "div",
      { class: "modal", role: "dialog" },
      h("p", { textContent: `「${name}」의 바뀐 내용을 저장할까요?` }),
      h("p", { class: "modal-note", textContent: "저장하지 않으면 바뀐 내용이 사라집니다." }),
      h(
        "div",
        { class: "modal-buttons" },
        button("버리기", () => close("discard"), "danger"),
        button("취소", () => close("cancel")),
        button("저장", () => close("save"), "primary"),
      ),
    ),
  );
  return choice ?? "cancel";
}

export function promptText(message: string, initial: string): Promise<string | null> {
  return modal<string>((close) => {
    const input = h("input", { value: initial });
    input.spellcheck = false;
    input.addEventListener("keydown", (event) => {
      if (!isSubmitEnter(event)) return;
      event.preventDefault();
      close(input.value);
    });
    // Select the name without its extension, the part people usually change.
    queueMicrotask(() => {
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    });
    return h(
      "div",
      { class: "modal", role: "dialog" },
      h("p", { textContent: message }),
      input,
      h(
        "div",
        { class: "modal-buttons" },
        button("취소", () => close(null)),
        button("확인", () => close(input.value), "primary"),
      ),
    );
  });
}

export interface PickerActions {
  open(path: string): void;
  /** Resolves with the reason a name was refused, or `null` when the workspace was made. */
  create(name: string): Promise<string | null>;
}

export async function workspacePicker(
  items: WorkspaceListItem[],
  actions: PickerActions,
): Promise<void> {
  await modal<true>((close) => {
    const list = h(
      "ul",
      { class: "picker-list" },
      ...items.map((item) => {
        const li = h("li", {
          textContent: item.open ? `${item.name} (열림)` : item.name,
          title: item.path,
        });
        li.addEventListener("click", () => {
          actions.open(item.path);
          close(true);
        });
        return li;
      }),
    );
    const input = h("input", { placeholder: "새 워크스페이스 이름" });
    input.spellcheck = false;
    const error = h("p", { class: "modal-error" });
    const create = async () => {
      const problem = await actions.create(input.value.trim());
      if (problem) error.textContent = problem;
      else close(true);
    };
    input.addEventListener("keydown", (event) => {
      if (!isSubmitEnter(event)) return;
      event.preventDefault();
      void create();
    });
    return h(
      "div",
      { class: "modal picker", role: "dialog" },
      h("p", { textContent: "워크스페이스" }),
      list,
      h(
        "div",
        { class: "picker-create" },
        input,
        button("만들기", () => void create(), "primary"),
      ),
      error,
    );
  });
}
```

`src/styles.css` 를 아래로 바꾼다.

```css
/* Theme colours. A later plan fills these from the selected VS Code theme. */
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #6e7781;
  --border: #d8dee4;
  --accent: #0969da;
  --danger: #cf222e;
  --sidebar-bg: #f6f8fa;
  --active-bg: #dbeafe;
  --active-line: rgb(0 0 0 / 3%);
  --selection: #b6d6fd;
  --selection-match: rgb(255 200 0 / 25%);
  --editor-font: ui-monospace, "SF Mono", Menlo, "Apple SD Gothic Neo", monospace;
  --editor-size: 14px;
  font:
    13px/1.4 -apple-system,
    BlinkMacSystemFont,
    "Apple SD Gothic Neo",
    sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1f22;
    --fg: #dcdee3;
    --muted: #8b9099;
    --border: #34363c;
    --accent: #4c9aff;
    --danger: #ff7b72;
    --sidebar-bg: #191a1d;
    --active-bg: #263449;
    --active-line: rgb(255 255 255 / 4%);
    --selection: #2f4f7a;
    --selection-match: rgb(255 200 0 / 18%);
  }
}

/* Components set `display`; `hidden` has to win over them. */
[hidden] {
  display: none !important;
}

html,
body {
  height: 100%;
  margin: 0;
}

body {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  overflow: hidden;
  background: var(--bg);
  color: var(--fg);
}

.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
}

.memo-filter {
  margin: 8px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: inherit;
  font: inherit;
}

.memo-scroller {
  position: relative;
  flex: 1;
  overflow: auto;
}

.memo-rows {
  position: relative;
}

.memo-row {
  position: absolute;
  left: 0;
  right: 0;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  white-space: nowrap;
  cursor: default;
}

.memo-row:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.memo-row.active {
  background: var(--active-bg);
}

.memo-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.memo-ext {
  color: var(--muted);
  font-size: 11px;
}

.memo-icon {
  width: 14px;
  color: var(--muted);
  text-align: center;
}

.memo-icon::before {
  content: "✎";
}

.kind-image .memo-icon::before {
  content: "▣";
}

.kind-video .memo-icon::before {
  content: "▶";
}

.kind-audio .memo-icon::before {
  content: "♪";
}

.kind-document .memo-icon::before {
  content: "▤";
}

.main {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
}

.tabbar {
  display: flex;
  overflow-x: auto;
  background: var(--sidebar-bg);
  border-bottom: 1px solid var(--border);
}

.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 6px 6px 12px;
  border-right: 1px solid var(--border);
  color: var(--muted);
  white-space: nowrap;
  cursor: default;
}

.tab.active {
  background: var(--bg);
  color: var(--fg);
}

/* External files save only on ⌘S, so their tabs look different. */
.tab.external .tab-title {
  font-style: italic;
}

.tab.dirty .tab-title::after {
  content: " ●";
}

.tab-close {
  visibility: hidden;
  padding: 0 4px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.tab:hover .tab-close,
.tab.active .tab-close {
  visibility: visible;
}

.editor-area {
  position: relative;
  min-height: 0;
}

.editor-host {
  height: 100%;
}

.editor-placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--muted);
}

.statusbar {
  display: flex;
  gap: 16px;
  padding: 3px 12px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}

.status-message {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-message.error {
  color: var(--danger);
}

button {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: inherit;
  font: inherit;
}

button.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

button.danger {
  color: var(--danger);
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 25%);
}

.modal {
  min-width: 340px;
  max-width: 480px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  box-shadow: 0 10px 30px rgb(0 0 0 / 20%);
}

.modal p {
  margin: 0 0 8px;
}

.modal-note {
  color: var(--muted);
  font-size: 12px;
}

.modal-error {
  min-height: 1em;
  color: var(--danger);
  font-size: 12px;
}

.modal input {
  box-sizing: border-box;
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: inherit;
  font: inherit;
}

.modal-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.picker-list {
  max-height: 300px;
  margin: 8px 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}

.picker-list li {
  padding: 4px 8px;
  border-radius: 6px;
  cursor: default;
}

.picker-list li:hover {
  background: var(--active-bg);
}

.picker-create {
  display: flex;
  gap: 8px;
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
```

Expected: Vitest `Tests  40 passed (40)`, Playwright `8 passed`(editor 5, dialogs 3).

- [ ] **Step 5: 포맷·린트·커밋**

```bash
pnpm exec oxfmt src tests
pnpm exec oxlint --fix src tests
git add src/styles.css src/ui tests/e2e/globals.d.ts tests/e2e/pages/dialogs.html tests/e2e/pages/dialogs.ts tests/e2e/dialogs.spec.ts
git commit -m "feat(ui): memo list, tab bar, status bar and IME-safe dialogs"
```

---

### Task 13: 문서 모델 — 메모·외부 파일·가져오기, 그리고 가짜 백엔드

**Files:**

- Create: `src/backend/fake.ts`, `src/app/docs.ts`, `src/app/docs.test.ts`

**Interfaces:**

- Consumes: Task 9 `Backend`·`BackendError`·`errorCode`·코덱·제목, Task 10 `WriteScheduler`·`restoreSelection`, Task 1 `splitName`·`basename`.
- Produces (`src/backend/fake.ts`): `FAKE_STORAGE_KEY = "tote-fake"`, `FakeMemo { file, autoTitle, data(base64), modifiedMs }`, `FakeData`(아래 코드), `FakeStorage`, `memoryStorage(initial?)`, `defaultFakeData()`, `toBase64`, `fromBase64`, `fakeFile(text | bytes)`, `fakeMemo(file, text, { autoTitle?, modifiedMs? })`, `class FakeBackend implements Backend`(+ 테스트 조작: `menu(id)`, `requestFlush(id)`, `poke()`, `dropFiles(paths)`, `memoText(id)`, `memoTextByFile(file)`, `fileText(path)`, `static fromSessionStorage()`).
- Produces (`src/app/docs.ts`):
  - 상수 `MEMO_SAVE_DELAY_MS = 500`, `LARGE_MEMO_SAVE_DELAY_MS = 3000`, `LARGE_MEMO_CHARS = 1_000_000`, `DRAFT_DELAY_MS = 1000`, `MAX_EDITOR_BYTES = 100 MiB`, `WRAP_LIMIT = 20_000`, `RECOVERED_NOTICE`, `DRAFT_RESTORED_NOTICE`.
  - `type Problem = "binary" | "too-large" | "missing" | "unreadable"`, `type Change = "info" | "language" | "dirty" | "saved" | "deleted" | "notice" | "error"`, `type CloseAsk = () => Promise<"save" | "discard" | "cancel">`.
  - `interface DocHost { backend; writes; extensions(doc, { wrap }): Extension[]; changed(doc, change): void }`, `interface DocUpdate { state; startState; docChanged; selectionSet }`(CodeMirror `ViewUpdate` 가 그대로 맞는다).
  - `abstract class Doc` — `kind`, `tabId`, `state`, `problem`, `error`, `notice`, `scrollAnchor`, `restoreSelection`, `fileName`, `title`, `hint`, `dirty`, `selectionJSON`, `ensureLoaded()`, `update(u)`, `leave()`, `flush()`, `close(ask)`.
  - `class MemoDoc extends Doc` — `info: MemoInfo`, `startEmpty()`, `adopt(state, { eol, bom })`, `save()`, `saveNow()`, `retitle()`, `rename(file)`.
  - `class ExternalDoc extends Doc` — `path`, `modified`, `exists`, `save(): Promise<boolean>`, `discard()`, `currentBytes()`, `lineFormat`.
  - `importExternal(ext: ExternalDoc, host: DocHost): Promise<MemoDoc>`, `displayName(file)`, `isBlank(text)`, `leftTitleLine(update)`.

- [ ] **Step 1: 가짜 백엔드**

Rust 쪽과 UI 가 기대는 규칙(겹치는 이름, `autoTitle`, 수정분의 기준)을 똑같이 따르는 메모리 구현이다. 데이터 전체를 JSON 하나로 보관해서, 페이지를 다시 읽으면 앱을 다시 켠 것과 같다.

`src/backend/fake.ts`:

```ts
import { basename, splitName } from "../core/names";
import {
  BackendError,
  type Backend,
  type ExternalInfo,
  type FileKind,
  type MemoInfo,
  type PendingOpen,
  type WindowFrame,
  type WorkspaceInfo,
  type WorkspaceListItem,
} from "./types";

/** An in-memory `Backend` for the browser preview and the UI tests. It follows the Rust side's
 * rules where the UI depends on them — APFS-style name collisions, `autoTitle`, drafts that keep
 * their base — and keeps everything in one JSON blob, so reloading the page acts as a restart. */

export const FAKE_STORAGE_KEY = "tote-fake";

export interface FakeMemo {
  file: string;
  autoTitle: boolean;
  /** Contents, base64. */
  data: string;
  modifiedMs: number;
}

export interface FakeData {
  workspace: WorkspaceInfo;
  memos: Record<string, FakeMemo>;
  session: string | null;
  /** External files by absolute path, base64. */
  files: Record<string, string>;
  drafts: Record<string, { base: string | null; data: string }>;
  pending: PendingOpen[];
  workspaces: WorkspaceListItem[];
  /** What the next 「파일 열기」 dialog returns. */
  picks: string[];
  clock: number;
  /** `readMemo` calls per memo ID — lets tests check that a restore loads lazily. */
  reads: Record<string, number>;
  flushed: number[];
  windowClosed: boolean;
}

export interface FakeStorage {
  load(): string | null;
  save(text: string): void;
}

export function memoryStorage(initial: string | null = null): FakeStorage {
  let text = initial;
  return {
    load: () => text,
    save: (next) => {
      text = next;
    },
  };
}

export function defaultFakeData(): FakeData {
  return {
    workspace: { id: "workspace-1", name: "메모", path: "/fake/메모", deviceId: "device-1" },
    memos: {},
    session: null,
    files: {},
    drafts: {},
    pending: [],
    workspaces: [{ name: "메모", path: "/fake/메모", open: true }],
    picks: [],
    clock: 1000,
    reads: {},
    flushed: [],
    windowClosed: false,
  };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
}

/** Seed helpers for tests. */
export function fakeFile(contents: string | Uint8Array): string {
  return toBase64(typeof contents === "string" ? new TextEncoder().encode(contents) : contents);
}

export function fakeMemo(
  file: string,
  contents: string,
  options: { autoTitle?: boolean; modifiedMs?: number } = {},
): FakeMemo {
  return {
    file,
    autoTitle: options.autoTitle ?? false,
    data: fakeFile(contents),
    modifiedMs: options.modifiedMs ?? 1,
  };
}

// Mirrors kind_for in src-tauri/src/workspace/memo.rs.
const KINDS: Record<string, FileKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  avif: "image",
  mp4: "video",
  mov: "video",
  m4v: "video",
  webm: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  aac: "audio",
  flac: "audio",
  ogg: "audio",
  aiff: "audio",
  pdf: "document",
};
const kindOf = (name: string): FileKind => KINDS[splitName(name).ext.toLowerCase()] ?? "text";
/** APFS treats names equal after composition and case folding as one name. */
const sameName = (a: string, b: string) =>
  a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
const validName = (name: string) =>
  name !== "" && name.trim() === name && !name.startsWith(".") && !/[/\\:*?"<>|]/.test(name);
const decode = (data: string) => new TextDecoder().decode(fromBase64(data));

export class FakeBackend implements Backend {
  data: FakeData;
  /** The base of each opened external file, held in memory like the Rust side does. */
  private bases: Record<string, string | null> = {};
  private readonly handlers = {
    menu: [] as ((id: string) => void)[],
    flush: [] as ((id: number) => void)[],
    pending: [] as (() => void)[],
    drop: [] as ((paths: string[]) => void)[],
  };

  constructor(private readonly storage: FakeStorage = memoryStorage()) {
    const saved = storage.load();
    this.data = saved ? (JSON.parse(saved) as FakeData) : defaultFakeData();
  }

  static fromSessionStorage(): FakeBackend {
    return new FakeBackend({
      load: () => sessionStorage.getItem(FAKE_STORAGE_KEY),
      save: (text) => sessionStorage.setItem(FAKE_STORAGE_KEY, text),
    });
  }

  // What tests do as the native side.

  menu(id: string): void {
    for (const handler of this.handlers.menu) handler(id);
  }
  requestFlush(id: number): void {
    for (const handler of this.handlers.flush) handler(id);
  }
  poke(): void {
    for (const handler of this.handlers.pending) handler();
  }
  dropFiles(paths: string[]): void {
    for (const handler of this.handlers.drop) handler(paths);
  }
  memoText(id: string): string | null {
    const memo = this.data.memos[id];
    return memo ? decode(memo.data) : null;
  }
  memoTextByFile(file: string): string | null {
    const memo = Object.values(this.data.memos).find((m) => m.file === file);
    return memo ? decode(memo.data) : null;
  }
  fileText(path: string): string | null {
    const data = this.data.files[path];
    return data === undefined ? null : decode(data);
  }

  // Backend.

  async workspaceInfo() {
    return this.data.workspace;
  }

  async listMemos() {
    return Object.entries(this.data.memos)
      .map(([id, memo]) => this.info(id, memo))
      .sort(
        (a, b) => b.modifiedMs - a.modifiedMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
      );
  }

  async createMemo() {
    return this.add(this.freeName("untitled", "md"), true, new Uint8Array());
  }

  async readMemo(id: string) {
    const memo = this.memo(id);
    this.data.reads[id] = (this.data.reads[id] ?? 0) + 1;
    this.commit();
    return fromBase64(memo.data);
  }

  async writeMemo(id: string, bytes: Uint8Array) {
    const memo = this.memo(id);
    memo.data = toBase64(bytes);
    memo.modifiedMs = this.tick();
    this.commit();
    return this.info(id, memo);
  }

  async retitleMemo(id: string, stem: string) {
    const memo = this.memo(id);
    if (memo.autoTitle) {
      const { ext } = splitName(memo.file);
      if (!validName(ext ? `${stem}.${ext}` : stem)) throw new BackendError("invalid-name", stem);
      memo.file = this.freeName(stem, ext, id);
      this.commit();
    }
    return this.info(id, memo);
  }

  async renameMemo(id: string, file: string) {
    const memo = this.memo(id);
    if (!validName(file)) throw new BackendError("invalid-name", file);
    if (
      Object.entries(this.data.memos).some(([other, m]) => other !== id && sameName(m.file, file))
    ) {
      throw new BackendError("already-exists", file);
    }
    memo.file = file;
    memo.autoTitle = false;
    this.commit();
    return this.info(id, memo);
  }

  async deleteMemo(id: string) {
    this.memo(id);
    delete this.data.memos[id];
    this.commit();
  }

  async importMemo(fileName: string, bytes: Uint8Array) {
    if (!validName(fileName)) throw new BackendError("invalid-name", fileName);
    const { stem, ext } = splitName(fileName);
    return this.add(this.freeName(stem, ext), false, bytes);
  }

  async importFile(path: string) {
    const data = this.data.files[path];
    if (data === undefined) throw new BackendError("not-found", path);
    return this.importMemo(basename(path), fromBase64(data));
  }

  async readSession() {
    return this.data.session;
  }

  async writeSession(json: string) {
    this.data.session = json;
    this.commit();
  }

  async takePendingOpens() {
    const pending = this.data.pending;
    this.data.pending = [];
    this.commit();
    return pending;
  }

  async openExternal(path: string): Promise<ExternalInfo> {
    const data = this.data.files[path];
    const draft = this.data.drafts[path];
    this.bases[path] = draft ? draft.base : (data ?? null);
    return {
      path,
      exists: data !== undefined,
      size: data === undefined ? 0 : fromBase64(data).length,
      kind: kindOf(path),
      draft: draft ? { diskChanged: draft.base !== (data ?? null) } : null,
    };
  }

  async readExternal(path: string) {
    const data = this.data.files[path];
    return data === undefined ? new Uint8Array() : fromBase64(data);
  }

  async readExternalDraft(path: string) {
    const draft = this.data.drafts[path];
    if (!draft) throw new BackendError("not-found", path);
    return fromBase64(draft.data);
  }

  async keepExternalDraft(path: string, bytes: Uint8Array) {
    const base = path in this.bases ? this.bases[path] : (this.data.files[path] ?? null);
    this.data.drafts[path] = { base, data: toBase64(bytes) };
    this.commit();
  }

  async discardExternalDraft(path: string) {
    delete this.data.drafts[path];
    this.commit();
  }

  async saveExternal(path: string, bytes: Uint8Array) {
    const data = toBase64(bytes);
    this.data.files[path] = data;
    delete this.data.drafts[path];
    this.bases[path] = data;
    this.commit();
  }

  async listWorkspaces() {
    return this.data.workspaces;
  }

  async createWorkspace(name: string) {
    if (!validName(name)) throw new BackendError("invalid-name", name);
    if (this.data.workspaces.some((w) => sameName(w.name, name)))
      throw new BackendError("already-exists", name);
    this.data.workspaces.push({ name, path: `/fake/${name}`, open: true });
    this.commit();
  }

  async openWorkspace(path: string) {
    const workspace = this.data.workspaces.find((w) => w.path === path);
    if (workspace) workspace.open = true;
    this.commit();
  }

  async windowFrame(): Promise<WindowFrame | null> {
    return null;
  }

  async pickFiles() {
    const picks = this.data.picks;
    this.data.picks = [];
    this.commit();
    return picks;
  }

  async flushDone(id: number) {
    this.data.flushed.push(id);
    this.commit();
  }

  async closeWindow() {
    this.data.windowClosed = true;
    this.commit();
  }

  onMenu(handler: (id: string) => void) {
    this.handlers.menu.push(handler);
  }
  onFlush(handler: (id: number) => void) {
    this.handlers.flush.push(handler);
  }
  onPending(handler: () => void) {
    this.handlers.pending.push(handler);
  }
  onFileDrop(handler: (paths: string[]) => void) {
    this.handlers.drop.push(handler);
  }

  private memo(id: string): FakeMemo {
    const memo = this.data.memos[id];
    if (!memo) throw new BackendError("unknown-memo", `no memo with id ${id}`);
    return memo;
  }

  private add(file: string, autoTitle: boolean, bytes: Uint8Array): MemoInfo {
    const id = crypto.randomUUID();
    this.data.memos[id] = { file, autoTitle, data: toBase64(bytes), modifiedMs: this.tick() };
    this.commit();
    return this.info(id, this.data.memos[id]);
  }

  private info(id: string, memo: FakeMemo): MemoInfo {
    return {
      id,
      file: memo.file,
      autoTitle: memo.autoTitle,
      modifiedMs: memo.modifiedMs,
      size: fromBase64(memo.data).length,
      kind: kindOf(memo.file),
    };
  }

  /** Mirrors `unique_file_name`: `stem.ext`, `stem 2.ext`, … skipping names another memo has. */
  private freeName(stem: string, ext: string, own?: string): string {
    const join = (s: string) => (ext ? `${s}.${ext}` : s);
    const taken = (name: string) =>
      Object.entries(this.data.memos).some(([id, memo]) => id !== own && sameName(memo.file, name));
    let candidate = join(stem);
    for (let n = 2; taken(candidate); n++) candidate = join(`${stem} ${n}`);
    return candidate;
  }

  private tick(): number {
    this.data.clock += 1;
    return this.data.clock;
  }

  private commit(): void {
    this.storage.save(JSON.stringify(this.data));
  }
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/app/docs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultFakeData,
  FakeBackend,
  fakeFile,
  fakeMemo,
  fromBase64,
  memoryStorage,
  type FakeData,
} from "../backend/fake";
import { WriteScheduler } from "../core/scheduler";
import {
  DRAFT_RESTORED_NOTICE,
  ExternalDoc,
  importExternal,
  MemoDoc,
  RECOVERED_NOTICE,
  type Change,
  type Doc,
  type DocHost,
} from "./docs";

function setup(seed: Partial<FakeData> = {}) {
  const backend = new FakeBackend(memoryStorage(JSON.stringify({ ...defaultFakeData(), ...seed })));
  const changes: Change[] = [];
  const host: DocHost = {
    backend,
    writes: new WriteScheduler((_key, error) => {
      throw error;
    }),
    extensions: () => [],
    changed: (_doc, change) => void changes.push(change),
  };
  return { backend, host, changes };
}

/** Types `insert` at `at` (default: the end) and moves the cursor behind it, as the editor would. */
function type(doc: Doc, insert: string, at?: number) {
  const start = doc.state!;
  const from = at ?? start.doc.length;
  const tr = start.update({
    changes: { from, insert },
    selection: { anchor: from + insert.length },
  });
  doc.update({ state: tr.state, startState: start, docChanged: true, selectionSet: true });
}

const utf8 = (text: string) => new TextEncoder().encode(text);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("MemoDoc", () => {
  it("saves half a second after typing stops", async () => {
    const { backend, host } = setup();
    const doc = new MemoDoc(host, await backend.createMemo());
    doc.startEmpty();
    type(doc, "가");
    await vi.advanceTimersByTimeAsync(300);
    type(doc, "나");
    await vi.advanceTimersByTimeAsync(499);
    expect(backend.memoText(doc.info.id)).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.memoText(doc.info.id)).toBe("가나");
  });

  it("waits three seconds between saves of a large memo", async () => {
    const { backend, host } = setup({ memos: { big: fakeMemo("big.md", "x".repeat(1_000_001)) } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    type(doc, "!");
    await vi.advanceTimersByTimeAsync(2999);
    expect(backend.memoText("big")?.endsWith("!")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.memoText("big")?.endsWith("!")).toBe(true);
  });

  it("takes its title when the cursor leaves the first line", async () => {
    const { backend, host } = setup();
    const doc = new MemoDoc(host, await backend.createMemo());
    doc.startEmpty();
    type(doc, "# 회의 준비");
    await vi.runAllTimersAsync();
    expect(doc.info.file).toBe("untitled.md");
    type(doc, "\n");
    await vi.runAllTimersAsync();
    expect(doc.info.file).toBe("회의 준비.md");
  });

  it("closing an empty new memo removes its file; one the person named stays", async () => {
    const { backend, host, changes } = setup({ memos: { named: fakeMemo("내 메모.md", "") } });
    const fresh = new MemoDoc(host, await backend.createMemo());
    fresh.startEmpty();
    type(fresh, "  \n");
    expect(await fresh.close()).toBe(true);
    expect(backend.data.memos[fresh.info.id]).toBeUndefined();
    expect(changes).toContain("deleted");
    const named = new MemoDoc(
      host,
      (await backend.listMemos()).find((m) => m.id === "named")!,
    );
    await named.ensureLoaded();
    await named.close();
    expect(backend.data.memos.named).toBeDefined();
  });

  it("recovers a memo whose file vanished", async () => {
    const { backend, host } = setup({ memos: { a: fakeMemo("a.md", "원래") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    delete backend.data.memos.a; // renamed or deleted in Finder
    type(doc, " 추가");
    await vi.runAllTimersAsync();
    expect(doc.info.id).not.toBe("a");
    expect(backend.memoText(doc.info.id)).toBe("원래 추가");
    expect(doc.notice).toBe(RECOVERED_NOTICE);
  });

  it("loads once, lazily, and keeps CRLF and the BOM", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("a\r\nb")]);
    const { backend, host } = setup({
      memos: { w: { ...fakeMemo("win.txt", ""), data: fakeFile(bytes) } },
    });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    expect(backend.data.reads).toEqual({});
    await Promise.all([doc.ensureLoaded(), doc.ensureLoaded()]);
    expect(backend.data.reads).toEqual({ w: 1 });
    type(doc, "c");
    await vi.runAllTimersAsync();
    expect([...fromBase64(backend.data.memos.w.data)]).toEqual([
      0xef,
      0xbb,
      0xbf,
      ...utf8("a\r\nbc"),
    ]);
  });

  it("does not read files it cannot show", async () => {
    const { backend, host } = setup({ memos: { p: fakeMemo("사진.png", "") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    await doc.ensureLoaded();
    expect(doc.problem).toBe("binary");
    expect(backend.data.reads).toEqual({});
  });

  it("restores the session's selection, pulled into the text", async () => {
    const { backend, host } = setup({ memos: { a: fakeMemo("a.md", "abc") } });
    const doc = new MemoDoc(host, (await backend.listMemos())[0]);
    doc.restoreSelection = { ranges: [{ anchor: 2, head: 99 }], main: 0 };
    await doc.ensureLoaded();
    const { anchor, head } = doc.state!.selection.main;
    expect([anchor, head]).toEqual([2, 3]);
  });
});

describe("ExternalDoc", () => {
  it("keeps a draft a second after typing and finds it again after a restart", async () => {
    const { backend, host } = setup({ files: { "/x/a.sh": fakeFile("echo hi\n") } });
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    type(doc, "# 수정");
    expect(doc.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(backend.data.drafts["/x/a.sh"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.data.drafts["/x/a.sh"]).toBeDefined();

    const restarted = setup({ ...backend.data });
    const again = new ExternalDoc(restarted.host, "/x/a.sh");
    await again.ensureLoaded();
    expect(again.dirty).toBe(true);
    expect(again.state!.doc.toString()).toBe("echo hi\n# 수정");
    expect(again.notice).toBeNull();
  });

  it("says so when the file changed on disk after the draft", async () => {
    const { host } = setup({
      files: { "/x/a.sh": fakeFile("v1") },
      drafts: { "/x/a.sh": { base: fakeFile("v0"), data: fakeFile("mine") } },
    });
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    expect(doc.state!.doc.toString()).toBe("mine");
    expect(doc.notice).toBe(DRAFT_RESTORED_NOTICE);
  });

  it("⌘S writes the file, drops the draft and clears the mark", async () => {
    const { backend, host } = setup({ files: { "/x/a.sh": fakeFile("old") } });
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    type(doc, " new");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await doc.save()).toBe(true);
    expect(backend.fileText("/x/a.sh")).toBe("old new");
    expect(backend.data.drafts["/x/a.sh"]).toBeUndefined();
    expect(doc.dirty).toBe(false);
  });

  it("asks before closing with unsaved edits, and discarding leaves the file alone", async () => {
    const { backend, host } = setup({ files: { "/x/a.sh": fakeFile("old") } });
    const doc = new ExternalDoc(host, "/x/a.sh");
    await doc.ensureLoaded();
    const ask = vi.fn(async () => "cancel" as const);
    expect(await doc.close(ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    type(doc, "!");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await doc.close(async () => "cancel")).toBe(false);
    expect(await doc.close(async () => "discard")).toBe(true);
    expect(backend.data.drafts["/x/a.sh"]).toBeUndefined();
    expect(backend.fileText("/x/a.sh")).toBe("old");
  });

  it("opens a path that does not exist yet and creates it on ⌘S", async () => {
    const { backend, host } = setup();
    const doc = new ExternalDoc(host, "/x/new.txt");
    await doc.ensureLoaded();
    expect(doc.state!.doc.toString()).toBe("");
    type(doc, "처음");
    await doc.save();
    expect(backend.fileText("/x/new.txt")).toBe("처음");
  });
});

describe("importExternal", () => {
  it("copies the edited text into a memo that takes over the tab", async () => {
    const { backend, host } = setup({ files: { "/x/deploy.sh": fakeFile("echo hi\n") } });
    const ext = new ExternalDoc(host, "/x/deploy.sh");
    await ext.ensureLoaded();
    type(ext, "echo more\n");
    await vi.advanceTimersByTimeAsync(1000);
    const memo = await importExternal(ext, host);
    expect(memo.info).toMatchObject({ file: "deploy.sh", autoTitle: false });
    expect(memo.state!.doc.toString()).toBe("echo hi\necho more\n");
    expect(backend.memoText(memo.info.id)).toBe("echo hi\necho more\n");
    expect(backend.fileText("/x/deploy.sh")).toBe("echo hi\n");
    expect(backend.data.drafts["/x/deploy.sh"]).toBeUndefined();
  });
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

```bash
pnpm test
```

Expected: `Failed to resolve import "./docs"` 로 `docs.test.ts` 실패.

- [ ] **Step 4: 구현**

`src/app/docs.ts`:

```ts
import { EditorState, type EditorSelection, type Extension, type Text } from "@codemirror/state";

import { errorCode, type Backend, type MemoInfo } from "../backend/types";
import { decodeText, encodeText, longestLine, type Eol } from "../core/codec";
import { basename, splitName } from "../core/names";
import type { WriteScheduler } from "../core/scheduler";
import { restoreSelection, type SelectionJSON } from "../core/session";
import { memoTitle, titleLine } from "../core/title";

// Spec 「저장」·「크기별 단계」.
export const MEMO_SAVE_DELAY_MS = 500;
export const LARGE_MEMO_SAVE_DELAY_MS = 3000;
/** The spec's 1 MB, measured in UTF-16 units: counting UTF-8 bytes on every keystroke would cost
 * what the longer delay saves. */
export const LARGE_MEMO_CHARS = 1_000_000;
export const DRAFT_DELAY_MS = 1000;
/** Bigger files wait for the large text viewer (a later plan) instead of loading into the editor. */
export const MAX_EDITOR_BYTES = 100 * 1024 * 1024;
/** Soft wrap stays off above this line length (the same limit highlighting uses): wrapping one
 * huge line costs seconds. */
export const WRAP_LIMIT = 20_000;

export const RECOVERED_NOTICE = "원래 파일을 찾지 못해 새 메모로 저장했습니다";
export const DRAFT_RESTORED_NOTICE =
  "보관한 수정분을 복원했습니다 — 그사이 디스크의 파일이 바뀌었습니다";

export type Problem = "binary" | "too-large" | "missing" | "unreadable";
export type Change = "info" | "language" | "dirty" | "saved" | "deleted" | "notice" | "error";
export type CloseAsk = () => Promise<"save" | "discard" | "cancel">;

/** What a document needs from the window around it. */
export interface DocHost {
  backend: Backend;
  writes: WriteScheduler;
  /** Editor extensions for a state of `doc`, including the listener that calls `doc.update`. */
  extensions(doc: Doc, options: { wrap: boolean }): Extension[];
  /** Something the tab bar, memo list or status bar shows about `doc` changed. */
  changed(doc: Doc, change: Change): void;
}

/** The parts of a CodeMirror `ViewUpdate` a document reacts to. */
export interface DocUpdate {
  state: EditorState;
  startState: EditorState;
  docChanged: boolean;
  selectionSet: boolean;
}

/** A memo's tab title: Markdown memos drop `.md`; anything else keeps its extension. */
export function displayName(file: string): string {
  const { stem, ext } = splitName(file);
  return ext.toLowerCase() === "md" ? stem : file;
}

export function isBlank(text: Text): boolean {
  for (const iter = text.iter(); !iter.next().done;) {
    if (/\S/.test(iter.value)) return false;
  }
  return true;
}

/** The main cursor just left the title line (the first non-blank one): time for the title. */
export function leftTitleLine(update: DocUpdate): boolean {
  const lineOf = (state: EditorState) => state.doc.lineAt(state.selection.main.head).number;
  return (
    lineOf(update.startState) === titleLine(update.startState.doc).number &&
    lineOf(update.state) !== titleLine(update.state.doc).number
  );
}

/** One tab's document. The editor view shows the active one; every document keeps its own
 * `EditorState`, so switching tabs keeps undo history, selection and scroll. */
export abstract class Doc {
  abstract readonly kind: "memo" | "external";
  /** Names the tab. A memo tab keeps it when its memo changes (save recovery, import). */
  readonly tabId = crypto.randomUUID();
  state: EditorState | null = null;
  problem: Problem | null = null;
  error: unknown = null;
  notice: string | null = null;
  /** Document position at the top of the viewport, kept in the session. */
  scrollAnchor = 0;
  /** The session's selection, applied when the text first loads. */
  restoreSelection: SelectionJSON | undefined;
  protected eol: Eol = "\n";
  protected bom = false;
  private loading: Promise<void> | null = null;

  constructor(protected readonly host: DocHost) {}

  abstract get fileName(): string;
  abstract get title(): string;
  abstract get hint(): string;
  abstract get dirty(): boolean;
  /** The tab lost focus: write what is pending. */
  abstract leave(): Promise<void>;
  /** The window closes or the app quits: write everything, without asking. */
  abstract flush(): Promise<void>;
  /** The tab is closing; `false` keeps it open. */
  abstract close(ask: CloseAsk): Promise<boolean>;
  protected abstract read(): Promise<Uint8Array | Problem>;
  protected abstract edited(): void;
  protected loaded(): void {}

  get selectionJSON(): SelectionJSON | undefined {
    return this.state ? (this.state.selection.toJSON() as SelectionJSON) : this.restoreSelection;
  }

  /** Reads the file the first time the tab is shown (spec 「세션」 — lazy loading). */
  ensureLoaded(): Promise<void> {
    if (this.state || this.problem) return Promise.resolve();
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  update(update: DocUpdate): void {
    this.state = update.state;
    if (update.docChanged) this.edited();
  }

  protected encode(text: Text): Uint8Array {
    return encodeText(text.sliceString(0, text.length, this.eol), this.bom);
  }

  protected fail(error: unknown): void {
    this.error = error;
    this.host.changed(this, "error");
  }

  /** Builds the editor state for `text`, with `selection` or else the session's. */
  protected setText(text: string, selection?: EditorSelection): void {
    let state = EditorState.create({
      doc: text,
      extensions: this.host.extensions(this, { wrap: longestLine(text) <= WRAP_LIMIT }),
    });
    const wanted =
      selection ?? (this.restoreSelection && restoreSelection(this.restoreSelection, state.doc));
    if (wanted) state = state.update({ selection: wanted }).state;
    this.state = state;
  }

  private async load(): Promise<void> {
    let bytes: Uint8Array | Problem;
    try {
      bytes = await this.read();
    } catch (error) {
      const code = errorCode(error);
      this.problem = code === "not-found" || code === "unknown-memo" ? "missing" : "unreadable";
      this.error = error;
      return;
    }
    if (typeof bytes === "string") {
      this.problem = bytes;
      return;
    }
    const decoded = decodeText(bytes);
    if (!decoded) {
      this.problem = "binary";
      return;
    }
    this.eol = decoded.eol;
    this.bom = decoded.bom;
    this.setText(decoded.text);
    this.loaded();
  }
}

export class MemoDoc extends Doc {
  readonly kind = "memo" as const;
  private savedText: Text | null = null;
  private retitling: Promise<void> | null = null;

  constructor(
    host: DocHost,
    public info: MemoInfo,
  ) {
    super(host);
  }

  get fileName() {
    return this.info.file;
  }
  get title() {
    return displayName(this.info.file);
  }
  get hint() {
    return this.info.file;
  }
  /** Memos save themselves; their tab never carries the unsaved mark. */
  get dirty() {
    return false;
  }
  private get saveKey() {
    return `${this.tabId}:save`;
  }

  /** A memo created empty skips the read. */
  startEmpty(): void {
    this.setText("");
    this.loaded();
  }

  /** Takes over text, selection and line format from the tab it replaces (an import), whose text
   * is exactly what the import wrote. */
  adopt(from: EditorState, format: { eol: Eol; bom: boolean }): void {
    this.eol = format.eol;
    this.bom = format.bom;
    this.setText(from.doc.toString(), from.selection);
    this.loaded();
  }

  protected loaded(): void {
    this.savedText = this.state?.doc ?? null;
  }

  protected async read(): Promise<Uint8Array | Problem> {
    if (this.info.kind !== "text") return "binary";
    if (this.info.size > MAX_EDITOR_BYTES) return "too-large";
    return this.host.backend.readMemo(this.info.id);
  }

  protected edited(): void {
    const large = (this.state?.doc.length ?? 0) > LARGE_MEMO_CHARS;
    this.host.writes.schedule(
      this.saveKey,
      large ? LARGE_MEMO_SAVE_DELAY_MS : MEMO_SAVE_DELAY_MS,
      () => this.save(),
    );
  }

  update(update: DocUpdate): void {
    super.update(update);
    if ((update.docChanged || update.selectionSet) && leftTitleLine(update)) void this.retitle();
  }

  async save(): Promise<void> {
    const text = this.state?.doc;
    if (!text || text === this.savedText) return;
    try {
      this.setInfo(await this.host.backend.writeMemo(this.info.id, this.encode(text)));
    } catch (error) {
      if (errorCode(error) !== "unknown-memo") return this.fail(error);
      // The file went away under us (renamed or deleted in Finder). Typed text must survive, so
      // it becomes a new memo instead of failing every save from here on.
      try {
        const created = await this.host.backend.createMemo();
        this.setInfo(await this.host.backend.writeMemo(created.id, this.encode(text)));
      } catch (again) {
        return this.fail(again);
      }
      this.notice = RECOVERED_NOTICE;
      this.host.changed(this, "notice");
    }
    this.savedText = text;
    this.error = null;
    this.host.changed(this, "saved");
  }

  saveNow(): Promise<void> {
    return this.host.writes.flush(this.saveKey);
  }

  /** Applies the automatic title (spec 「제목 자동 생성」). Cheap to call often: the backend is
   * asked only when the title differs from the file name. */
  retitle(): Promise<void> {
    if (!this.info.autoTitle || !this.state) return Promise.resolve();
    const stem = memoTitle(this.state.doc);
    if (stem === splitName(this.info.file).stem) return Promise.resolve();
    this.retitling ??= this.host.backend
      .retitleMemo(this.info.id, stem)
      .then(
        (info) => this.setInfo(info),
        (error: unknown) => this.fail(error),
      )
      .finally(() => {
        this.retitling = null;
      });
    return this.retitling;
  }

  /** A name the person chose; automatic titles stop for this memo. */
  async rename(file: string): Promise<void> {
    await this.saveNow();
    this.setInfo(await this.host.backend.renameMemo(this.info.id, file));
  }

  async leave(): Promise<void> {
    await this.saveNow();
    await this.retitle();
  }

  flush(): Promise<void> {
    return this.leave();
  }

  async close(): Promise<boolean> {
    await this.saveNow();
    // An empty new memo leaves no file behind (spec 「세션」); "new" means tote still names it.
    if (this.info.autoTitle && this.state && isBlank(this.state.doc)) {
      try {
        await this.host.backend.deleteMemo(this.info.id);
        this.host.changed(this, "deleted");
      } catch (error) {
        this.fail(error);
      }
      return true;
    }
    await this.retitle();
    return true;
  }

  private setInfo(info: MemoInfo): void {
    const extensionChanged = splitName(info.file).ext !== splitName(this.info.file).ext;
    this.info = info;
    this.host.changed(this, extensionChanged ? "language" : "info");
  }
}

export class ExternalDoc extends Doc {
  readonly kind = "external" as const;
  /** Edited since the last ⌘S (or restored from a draft). */
  modified = false;
  exists = false;

  constructor(
    host: DocHost,
    readonly path: string,
  ) {
    super(host);
  }

  get fileName() {
    return basename(this.path);
  }
  get title() {
    return basename(this.path);
  }
  get hint() {
    return this.path;
  }
  get dirty() {
    return this.modified;
  }
  get lineFormat(): { eol: Eol; bom: boolean } {
    return { eol: this.eol, bom: this.bom };
  }
  private get draftKey() {
    return `${this.tabId}:draft`;
  }

  /** The bytes as they stand, for an import; `null` when the file is not open as text. */
  currentBytes(): Uint8Array | null {
    return this.state ? this.encode(this.state.doc) : null;
  }

  protected async read(): Promise<Uint8Array | Problem> {
    const info = await this.host.backend.openExternal(this.path);
    this.exists = info.exists;
    if (info.draft) {
      this.modified = true;
      if (info.draft.diskChanged) this.notice = DRAFT_RESTORED_NOTICE;
      return this.host.backend.readExternalDraft(this.path);
    }
    if (info.kind !== "text") return "binary";
    if (info.size > MAX_EDITOR_BYTES) return "too-large";
    return info.exists ? this.host.backend.readExternal(this.path) : new Uint8Array();
  }

  protected edited(): void {
    if (!this.modified) {
      this.modified = true;
      this.host.changed(this, "dirty");
    }
    this.host.writes.schedule(this.draftKey, DRAFT_DELAY_MS, () => this.keepDraft());
  }

  private async keepDraft(): Promise<void> {
    if (this.modified && this.state) {
      await this.host.backend.keepExternalDraft(this.path, this.encode(this.state.doc));
    }
  }

  /** ⌘S. Returns whether the file was written. */
  async save(): Promise<boolean> {
    if (!this.state) return true;
    await this.settleDraft();
    const text = this.state.doc;
    try {
      await this.host.backend.saveExternal(this.path, this.encode(text));
    } catch (error) {
      this.fail(error);
      return false;
    }
    this.exists = true;
    this.notice = null;
    this.error = null;
    if (this.state.doc === text) this.modified = false;
    // Typed while saving: those edits are still unsaved and need their draft.
    else this.host.writes.schedule(this.draftKey, DRAFT_DELAY_MS, () => this.keepDraft());
    this.host.changed(this, "saved");
    return true;
  }

  /** 「버리기」: the file stays as it is on disk and the draft goes. */
  async discard(): Promise<void> {
    await this.settleDraft();
    this.modified = false;
    await this.host.backend.discardExternalDraft(this.path);
    this.host.changed(this, "dirty");
  }

  leave(): Promise<void> {
    return this.host.writes.flush(this.draftKey);
  }

  flush(): Promise<void> {
    return this.leave();
  }

  async close(ask: CloseAsk): Promise<boolean> {
    if (!this.modified) return true;
    const choice = await ask();
    if (choice === "cancel") return false;
    if (choice === "save") return this.save();
    await this.discard();
    return true;
  }

  /** No draft write pending or running: one landing after a save or discard would bring the
   * draft back. */
  private async settleDraft(): Promise<void> {
    this.host.writes.cancel(this.draftKey);
    await this.host.writes.flush(this.draftKey);
  }
}

/** 「워크스페이스로 가져오기」 (spec 「가져오기」): copies the external file — with its unsaved edits —
 * into the workspace and returns the memo that takes over its tab. The original is left as it is. */
export async function importExternal(ext: ExternalDoc, host: DocHost): Promise<MemoDoc> {
  const bytes = ext.currentBytes();
  const info = bytes
    ? await host.backend.importMemo(ext.fileName, bytes)
    : await host.backend.importFile(ext.path);
  await ext.discard();
  const memo = new MemoDoc(host, info);
  memo.scrollAnchor = ext.scrollAnchor;
  if (ext.state) memo.adopt(ext.state, ext.lineFormat);
  return memo;
}
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
pnpm test
pnpm typecheck
```

Expected: `Tests  54 passed (54)`(이전 40 + MemoDoc 8, ExternalDoc 5, importExternal 1).

- [ ] **Step 6: 포맷·린트·커밋**

```bash
pnpm exec oxfmt src/backend/fake.ts src/app
pnpm exec oxlint --fix src/backend/fake.ts src/app
git add src/backend/fake.ts src/app/docs.ts src/app/docs.test.ts
git commit -m "feat(app): memo and external documents with autosave, titles, drafts and import"
```

---

### Task 14: 앱 컨트롤러 — 탭, 세션 복원, 메뉴, 쓰고 닫기

**Files:**

- Modify: `src/main.ts`, `tests/e2e/globals.d.ts`
- Create: `src/app/controller.ts`, `tests/e2e/helpers.ts`, `tests/e2e/memo.spec.ts`, `tests/e2e/external.spec.ts`

**Interfaces:**

- Consumes: Task 9–13 전부.
- Produces (`src/app/controller.ts`): `class AppController implements DocHost` — `constructor(root: HTMLElement, backend: Backend)`, `start(): Promise<void>`, `view: EditorView`, `writes`, `openMemo(id)`, `openExternal(path)`, `newMemo()`, `closeTab(tabId)`, `flushAll()`. 모듈 함수 `describeError(err): string`.
- Produces (`src/main.ts`): Tauri 안이면 `TauriBackend`, 밖이면 `FakeBackend.fromSessionStorage()`. 가짜 백엔드일 때만 `window.__tote = { app, backend, ready }` 를 둔다(UI 테스트가 쓴다).
- 메뉴 ID 처리(Task 8 의 목록): `new-memo`, `open-file`, `save`(외부 파일은 ⌘S, 메모는 바로 저장), `import`, `rename`, `close-tab`(탭이 없으면 창을 닫는다), `next-tab`, `prev-tab`, `open-workspace`·`new-workspace`(둘 다 워크스페이스 선택 대화상자).

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/e2e/globals.d.ts` 를 아래로 바꾼다.

```ts
import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { AppController } from "../../src/app/controller";
import type { FakeBackend } from "../../src/backend/fake";
import type { askUnsaved, promptText, workspacePicker } from "../../src/ui/dialogs";

declare global {
  interface Window {
    view: EditorView;
    EditorSelection: typeof EditorSelection;
    askUnsaved: typeof askUnsaved;
    promptText: typeof promptText;
    workspacePicker: typeof workspacePicker;
    result: unknown;
    /** Set by src/main.ts when it runs on the fake backend. */
    __tote: { app: AppController; backend: FakeBackend; ready: boolean };
  }
}

export {};
```

`tests/e2e/helpers.ts`:

```ts
import type { Page } from "@playwright/test";

import { defaultFakeData, FAKE_STORAGE_KEY, type FakeData } from "../../src/backend/fake";

/** Opens the app on the fake backend seeded with `patch`. The seed is written once per test, so
 * reloading keeps the fake's data — that is how these specs simulate a restart. */
export async function start(page: Page, patch: Partial<FakeData> = {}): Promise<void> {
  const seed = JSON.stringify({ ...defaultFakeData(), ...patch });
  await page.addInitScript(
    ([key, json]) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, json);
    },
    [FAKE_STORAGE_KEY, seed] as const,
  );
  await page.goto("/");
  await ready(page);
}

export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__tote?.ready === true);
}

/** What the native menu would send. */
export function menu(page: Page, id: string): Promise<void> {
  return page.evaluate((menuId) => window.__tote.backend.menu(menuId), id);
}
```

`tests/e2e/memo.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { fakeMemo } from "../../src/backend/fake";
import { menu, ready, start } from "./helpers";

test("a new memo is named after its first line once the cursor leaves it", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("# 회의 준비");
  await page.keyboard.press("Enter");
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["회의 준비"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("회의 준비");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("회의 준비.md")))
    .toBe("# 회의 준비\n");
});

test("closing an empty new memo leaves no file behind", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".tab")).toHaveCount(1);
  await menu(page, "close-tab");
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(window.__tote.backend.data.memos))).toEqual([]);
  await expect(page.locator(".editor-placeholder")).toHaveText("⌘N 으로 새 메모를 만드세요");
});

test("restoring a session reads only the active tab", async ({ page }) => {
  const session = {
    version: 1,
    activeTab: 1,
    tabs: [
      { kind: "memo", memoId: "a" },
      { kind: "memo", memoId: "b", selection: { ranges: [{ anchor: 1, head: 1 }], main: 0 } },
    ],
  };
  await start(page, {
    memos: { a: fakeMemo("가.md", "첫째"), b: fakeMemo("나.md", "둘째") },
    session: JSON.stringify(session),
  });
  await expect(page.locator(".tab .tab-title")).toHaveText(["가", "나"]);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("나");
  expect(await page.evaluate(() => window.__tote.backend.data.reads)).toEqual({ b: 1 });
  expect(await page.evaluate(() => window.__tote.app.view.state.selection.main.head)).toBe(1);
  await page.locator(".tab", { hasText: "가" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.reads))
    .toEqual({ a: 1, b: 1 });
});

test("tabs, the active tab and the cursor come back after a restart", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("가.md", "첫째 줄\n둘째 줄") } });
  await page.locator(".memo-row", { hasText: "가" }).click();
  await page.evaluate(() => window.__tote.app.view.dispatch({ selection: { anchor: 6 } }));
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"anchor":6');
  await page.reload();
  await ready(page);
  await expect(page.locator(".tab.active .tab-title")).toHaveText("가");
  expect(await page.evaluate(() => window.__tote.app.view.state.selection.main.head)).toBe(6);
});

test("a flush request writes pending edits and the title before answering", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("급히 끈다");
  await page.evaluate(() => window.__tote.backend.requestFlush(7));
  await expect.poll(() => page.evaluate(() => window.__tote.backend.data.flushed)).toEqual([7]);
  const files = await page.evaluate(() =>
    Object.values(window.__tote.backend.data.memos).map((m) => m.file),
  );
  expect(files).toEqual(["급히 끈다.md"]);
  expect(await page.evaluate(() => window.__tote.backend.memoTextByFile("급히 끈다.md"))).toBe(
    "급히 끈다",
  );
  expect(await page.evaluate(() => window.__tote.backend.data.session)).toContain('"kind":"memo"');
});

test("the memo list filters by name", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("회의록.md", ""), b: fakeMemo("장보기.md", "") } });
  await page.locator(".memo-filter").fill("회의");
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["회의록"]);
});

test("a memo the person renamed keeps that name", async ({ page }) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("첫 줄");
  await menu(page, "rename");
  const input = page.locator(".modal input");
  await input.fill("목록.txt");
  await input.press("Enter");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("목록.txt");
  // Leaving the title line is when an automatic title would apply.
  await page.keyboard.press("Enter");
  await page.keyboard.type("둘째 줄");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.memoTextByFile("목록.txt")))
    .toBe("첫 줄\n둘째 줄");
  const files = await page.evaluate(() =>
    Object.values(window.__tote.backend.data.memos).map((m) => m.file),
  );
  expect(files).toEqual(["목록.txt"]);
});
```

`tests/e2e/external.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { fakeFile } from "../../src/backend/fake";
import { menu, ready, start } from "./helpers";

test("an external file keeps a draft across a restart and is written only on ⌘S", async ({
  page,
}) => {
  await start(page, { files: { "/x/a.sh": fakeFile("echo hi\n") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("a.sh");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("echo more");
  await expect(page.locator(".tab.active")).toHaveClass(/dirty/);
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.drafts["/x/a.sh"] !== undefined))
    .toBe(true);
  expect(await page.evaluate(() => window.__tote.backend.fileText("/x/a.sh"))).toBe("echo hi\n");
  // The session is written a second after the last change; reload only once it lists the tab.
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"path":"/x/a.sh"');

  await page.reload();
  await ready(page);
  await expect(page.locator(".tab.active")).toHaveClass(/dirty/);
  await menu(page, "save");
  await expect(page.locator(".tab.active")).not.toHaveClass(/dirty/);
  expect(await page.evaluate(() => window.__tote.backend.fileText("/x/a.sh"))).toBe(
    "echo hi\necho more",
  );
  expect(await page.evaluate(() => window.__tote.backend.data.drafts)).toEqual({});
});

test("closing an edited external file asks first", async ({ page }) => {
  await start(page, { files: { "/x/a.sh": fakeFile("old") }, picks: ["/x/a.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("!");
  await menu(page, "close-tab");
  await page.getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".tab")).toHaveCount(1);
  await menu(page, "close-tab");
  await page.getByRole("button", { name: "버리기" }).click();
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(await page.evaluate(() => window.__tote.backend.fileText("/x/a.sh"))).toBe("old");
  expect(await page.evaluate(() => window.__tote.backend.data.drafts)).toEqual({});
});

test("importing turns the tab into a memo and leaves the original alone", async ({ page }) => {
  await start(page, { files: { "/x/deploy.sh": fakeFile("echo hi\n") }, picks: ["/x/deploy.sh"] });
  await menu(page, "open-file");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("deploy.sh");
  await menu(page, "import");
  await expect(page.locator(".memo-row .memo-name")).toHaveText(["deploy"]);
  await expect(page.locator(".tab.active")).not.toHaveClass(/external/);
  expect(await page.evaluate(() => window.__tote.backend.memoTextByFile("deploy.sh"))).toBe(
    "echo hi\n",
  );
  expect(await page.evaluate(() => window.__tote.backend.fileText("/x/deploy.sh"))).toBe(
    "echo hi\n",
  );
});

test("a file that is not text shows a placeholder", async ({ page }) => {
  await start(page, {
    files: { "/x/data.bin": fakeFile(new Uint8Array([1, 0, 2])) },
    picks: ["/x/data.bin"],
  });
  await menu(page, "open-file");
  await expect(page.locator(".editor-placeholder")).toHaveText("텍스트로 열 수 없음");
});

test("files sent by a tote command open in tabs", async ({ page }) => {
  await start(page, { files: { "/x/a.sh": fakeFile("a") } });
  await page.evaluate(() => {
    const backend = window.__tote.backend;
    backend.data.pending = [{ kind: "external", path: "/x/a.sh" }];
    backend.poke();
  });
  await expect(page.locator(".tab.active .tab-title")).toHaveText("a.sh");
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
pnpm test:e2e memo external
```

Expected: 12개 모두 실패 — 지금의 `src/main.ts` 는 Tauri 자리표시라 `__tote` 가 생기지 않아 `ready` 에서 시간이 다 된다.

- [ ] **Step 3: 구현**

`src/app/controller.ts`:

```ts
import { EditorView, type ViewUpdate } from "@codemirror/view";

import { errorCode, type Backend } from "../backend/types";
import { WriteScheduler } from "../core/scheduler";
import { parseSession, type SessionFile, type SessionTab } from "../core/session";
import { editorExtensions, languageEffect } from "../editor/setup";
import { askUnsaved, promptText, workspacePicker } from "../ui/dialogs";
import { h } from "../ui/dom";
import { MemoList } from "../ui/memo-list";
import { languageLabel, StatusBar } from "../ui/status-bar";
import { TabBar } from "../ui/tab-bar";
import {
  ExternalDoc,
  importExternal,
  MemoDoc,
  type Change,
  type Doc,
  type DocHost,
  type Problem,
} from "./docs";

const SESSION_DELAY_MS = 1000;

const PROBLEM_TEXT: Record<Problem, string> = {
  binary: "텍스트로 열 수 없음",
  "too-large": "100MB 가 넘는 파일은 아직 열 수 없습니다",
  missing: "파일을 찾을 수 없습니다",
  unreadable: "파일을 읽지 못했습니다",
};

const ERROR_TEXT: Record<string, string> = {
  "already-exists": "같은 이름이 이미 있습니다",
  "invalid-name": "쓸 수 없는 이름입니다",
  "not-found": "파일을 찾을 수 없습니다",
};

export function describeError(err: unknown): string {
  const code = errorCode(err);
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  return `오류: ${err instanceof Error ? err.message : String(err)}`;
}

/** One workspace window: its tabs, the editor, the sidebar, the session and the menu actions. */
export class AppController implements DocHost {
  readonly writes = new WriteScheduler((_key, error) => this.report(error));
  readonly view = new EditorView();
  private tabs: Doc[] = [];
  private active: Doc | null = null;
  private deviceId = "";
  /** Session writes wait until the restored tabs are in place. */
  private restoring = true;
  private readonly memoList = new MemoList((id) => void this.openMemo(id));
  private readonly tabBar = new TabBar({
    select: (id) => void this.activateTab(id),
    close: (id) => void this.closeTab(id),
  });
  private readonly statusBar = new StatusBar();
  // CodeMirror's own CSS sets `display` on .cm-editor with !important, so its host is what hides.
  private readonly editorHost = h("div", { class: "editor-host" }, this.view.dom);
  private readonly placeholder = h("div", { class: "editor-placeholder" });

  constructor(
    root: HTMLElement,
    readonly backend: Backend,
  ) {
    const editorArea = h("div", { class: "editor-area" }, this.editorHost, this.placeholder);
    root.replaceChildren(
      this.memoList.el,
      h("main", { class: "main" }, this.tabBar.el, editorArea, this.statusBar.el),
    );
    this.view.scrollDOM.addEventListener("scroll", () => this.saveSessionSoon(), { passive: true });
    this.showEmpty();
  }

  async start(): Promise<void> {
    const info = await this.backend.workspaceInfo();
    this.deviceId = info.deviceId;
    document.title = info.name;
    this.backend.onMenu((id) => void this.onMenu(id));
    this.backend.onFlush((id) => void this.onFlush(id));
    this.backend.onPending(() => void this.drainPending());
    this.backend.onFileDrop((paths) => void this.openExternals(paths));
    // A window losing focus is a tab losing focus (spec 「저장」), and hidden windows barely run
    // timers — so write now rather than when the timer fires.
    window.addEventListener("blur", () => void this.active?.leave());
    window.addEventListener("focus", () => void this.refreshMemos());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void this.flushAll();
    });
    await this.refreshMemos();
    await this.restoreSession();
    this.restoring = false;
    await this.drainPending();
  }

  extensions(doc: Doc, options: { wrap: boolean }) {
    return editorExtensions({
      fileName: doc.fileName,
      wrap: options.wrap,
      onUpdate: (update) => this.onUpdate(doc, update),
    });
  }

  changed(doc: Doc, change: Change): void {
    if (doc instanceof MemoDoc && (change === "info" || change === "language"))
      this.memoList.upsert(doc.info);
    if (doc instanceof MemoDoc && change === "deleted") this.memoList.remove(doc.info.id);
    if (change === "language") this.reconfigureLanguage(doc);
    if (doc === this.active && change === "notice") this.statusBar.setMessage(doc.notice ?? "");
    if (doc === this.active && change === "saved" && doc instanceof ExternalDoc)
      this.statusBar.setMessage("저장됨");
    if (change === "error") this.report(doc.error);
    this.renderTabs();
  }

  async openMemo(id: string): Promise<void> {
    let doc: Doc | undefined = this.findMemo(id);
    if (!doc) {
      let info = this.memoList.get(id);
      if (!info) {
        await this.refreshMemos();
        info = this.memoList.get(id);
      }
      if (!info) return this.report(new Error("메모를 찾을 수 없습니다"));
      doc = this.insertTab(new MemoDoc(this, info));
    }
    await this.activate(doc);
  }

  async openExternal(path: string): Promise<void> {
    await this.activate(this.findExternal(path) ?? this.insertTab(new ExternalDoc(this, path)));
  }

  async newMemo(): Promise<void> {
    const info = await this.backend.createMemo();
    this.memoList.upsert(info);
    const doc = this.insertTab(new MemoDoc(this, info));
    doc.startEmpty();
    await this.activate(doc);
  }

  async closeTab(tabId: string): Promise<void> {
    const doc = this.tabs.find((d) => d.tabId === tabId);
    if (!doc) return;
    this.capture(doc);
    if (!(await doc.close(() => askUnsaved(doc.title)))) {
      if (doc === this.active) this.view.focus();
      return;
    }
    const index = this.tabs.indexOf(doc);
    this.tabs.splice(index, 1);
    if (doc === this.active) {
      this.active = null;
      const next = this.tabs[index] ?? this.tabs[index - 1];
      if (next) await this.activate(next);
      else this.showEmpty();
    }
    this.renderTabs();
    this.saveSessionSoon();
  }

  /** Everything written now — tab edits, titles and the session (window close, quit, hiding). */
  async flushAll(): Promise<void> {
    await Promise.all(
      this.tabs.map((doc) => doc.flush().catch((error: unknown) => this.report(error))),
    );
    if (!this.restoring) await this.saveSessionNow();
  }

  private async onFlush(id: number): Promise<void> {
    try {
      await this.flushAll();
    } finally {
      await this.backend.flushDone(id);
    }
  }

  private onUpdate(doc: Doc, update: ViewUpdate): void {
    doc.update(update);
    if (doc !== this.active || !(update.docChanged || update.selectionSet)) return;
    this.statusBar.setPosition(update.state);
    this.saveSessionSoon();
  }

  private async restoreSession(): Promise<void> {
    const session = parseSession(await this.backend.readSession());
    let active: Doc | null = null;
    for (const [index, tab] of session.tabs.entries()) {
      const doc = this.docFor(tab);
      if (!doc) continue;
      doc.restoreSelection = tab.selection;
      doc.scrollAnchor = tab.scrollAnchor ?? 0;
      this.tabs.push(doc);
      if (index === session.activeTab) active = doc;
    }
    const first = active ?? this.tabs.at(-1);
    if (first) await this.activate(first);
    else this.renderTabs();
  }

  private docFor(tab: SessionTab): Doc | null {
    if (tab.kind === "memo") {
      const info = this.memoList.get(tab.memoId);
      return info && !this.findMemo(info.id) ? new MemoDoc(this, info) : null;
    }
    // Another device's external file has no contents here; how to show it is the sync spec's call.
    if (tab.deviceId !== this.deviceId || this.findExternal(tab.path)) return null;
    return new ExternalDoc(this, tab.path);
  }

  private findMemo(id: string): MemoDoc | undefined {
    return this.tabs.find((doc): doc is MemoDoc => doc instanceof MemoDoc && doc.info.id === id);
  }

  private findExternal(path: string): ExternalDoc | undefined {
    return this.tabs.find(
      (doc): doc is ExternalDoc => doc instanceof ExternalDoc && doc.path === path,
    );
  }

  /** New tabs open right after the active one. */
  private insertTab<D extends Doc>(doc: D): D {
    const at = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, doc);
    return doc;
  }

  private activateTab(tabId: string): Promise<void> {
    const doc = this.tabs.find((d) => d.tabId === tabId);
    return doc ? this.activate(doc) : Promise.resolve();
  }

  private async activate(doc: Doc): Promise<void> {
    const previous = this.active;
    if (previous === doc) return;
    if (previous) {
      this.capture(previous);
      void previous.leave();
    }
    this.active = doc;
    this.renderTabs();
    await doc.ensureLoaded();
    if (this.active !== doc) return; // another tab was picked while this one loaded
    this.show(doc);
    this.saveSessionSoon();
  }

  private show(doc: Doc): void {
    const state = doc.problem ? null : doc.state;
    this.editorHost.hidden = !state;
    this.placeholder.hidden = Boolean(state);
    this.memoList.setActive(doc instanceof MemoDoc ? doc.info.id : null);
    this.statusBar.setLanguage(languageLabel(doc.fileName));
    this.statusBar.setMessage(doc.notice ?? "");
    if (!state) {
      this.placeholder.textContent = PROBLEM_TEXT[doc.problem ?? "unreadable"];
      this.statusBar.setPosition(null);
      return;
    }
    this.view.setState(state);
    const anchor = Math.min(doc.scrollAnchor, state.doc.length);
    this.view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: "start" }) });
    this.view.requestMeasure();
    this.statusBar.setPosition(this.view.state);
    this.view.focus();
  }

  private showEmpty(): void {
    this.editorHost.hidden = true;
    this.placeholder.hidden = false;
    this.placeholder.textContent = "⌘N 으로 새 메모를 만드세요";
    this.memoList.setActive(null);
    this.statusBar.setPosition(null);
    this.statusBar.setLanguage("");
    this.statusBar.setMessage("");
  }

  /** The view holds the live state of the active tab; keep where it is scrolled to. */
  private capture(doc: Doc): void {
    if (doc !== this.active || !doc.state || this.view.state !== doc.state) return;
    doc.scrollAnchor = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop).from;
  }

  private renderTabs(): void {
    this.tabBar.render(
      this.tabs.map((doc) => ({
        id: doc.tabId,
        title: doc.title,
        hint: doc.hint,
        dirty: doc.dirty,
        external: doc.kind === "external",
        active: doc === this.active,
      })),
    );
  }

  private async openExternals(paths: string[]): Promise<void> {
    for (const path of paths) await this.openExternal(path);
  }

  private async cycleTab(step: number): Promise<void> {
    if (!this.active || this.tabs.length < 2) return;
    const index = this.tabs.indexOf(this.active);
    await this.activate(this.tabs[(index + step + this.tabs.length) % this.tabs.length]);
  }

  private saveSessionSoon(): void {
    if (!this.restoring)
      this.writes.schedule("session", SESSION_DELAY_MS, () => this.writeSession());
  }

  private async saveSessionNow(): Promise<void> {
    this.writes.schedule("session", 0, () => this.writeSession());
    await this.writes.flush("session");
  }

  private async writeSession(): Promise<void> {
    if (this.active) this.capture(this.active);
    const session: SessionFile = {
      version: 1,
      activeTab: this.active ? this.tabs.indexOf(this.active) : -1,
      tabs: this.tabs.map((doc) => this.sessionTab(doc)),
    };
    const frame = await this.backend.windowFrame();
    if (frame) session.window = frame;
    await this.backend.writeSession(JSON.stringify(session));
  }

  private sessionTab(doc: Doc): SessionTab {
    const place = { selection: doc.selectionJSON, scrollAnchor: doc.scrollAnchor };
    if (doc instanceof MemoDoc) return { kind: "memo", memoId: doc.info.id, ...place };
    // Spec 「동기화 대비」: external entries always carry the device they belong to.
    return { kind: "external", deviceId: this.deviceId, path: (doc as ExternalDoc).path, ...place };
  }

  private async drainPending(): Promise<void> {
    if (this.restoring) return;
    for (const open of await this.backend.takePendingOpens()) {
      if (open.kind === "memo") {
        await this.refreshMemos();
        await this.openMemo(open.id);
      } else {
        await this.openExternal(open.path);
      }
    }
  }

  private async onMenu(id: string): Promise<void> {
    try {
      switch (id) {
        case "new-memo":
          return await this.newMemo();
        case "open-file":
          return await this.openExternals(await this.backend.pickFiles());
        case "save":
          return await this.saveActive();
        case "import":
          return await this.importActive();
        case "rename":
          return await this.renameActive();
        case "close-tab":
          return this.active
            ? await this.closeTab(this.active.tabId)
            : await this.backend.closeWindow();
        case "next-tab":
          return await this.cycleTab(1);
        case "prev-tab":
          return await this.cycleTab(-1);
        case "open-workspace":
        case "new-workspace":
          return await this.showPicker();
      }
    } catch (error) {
      this.report(error);
    }
  }

  private async saveActive(): Promise<void> {
    const doc = this.active;
    if (doc instanceof ExternalDoc) await doc.save();
    else if (doc instanceof MemoDoc) await doc.saveNow();
  }

  private async importActive(): Promise<void> {
    const doc = this.active;
    if (!(doc instanceof ExternalDoc)) return;
    this.capture(doc);
    const memo = await importExternal(doc, this);
    this.tabs[this.tabs.indexOf(doc)] = memo;
    this.memoList.upsert(memo.info);
    this.active = null;
    await this.activate(memo);
    this.statusBar.setMessage("워크스페이스로 가져왔습니다");
  }

  private async renameActive(): Promise<void> {
    const doc = this.active;
    if (!(doc instanceof MemoDoc)) return;
    const name = await promptText("새 파일 이름", doc.info.file);
    this.view.focus();
    const file = name?.trim();
    if (!file || file === doc.info.file) return;
    await doc.rename(file);
  }

  private async showPicker(): Promise<void> {
    const items = await this.backend.listWorkspaces();
    await workspacePicker(items, {
      open: (path) =>
        void this.backend.openWorkspace(path).catch((error: unknown) => this.report(error)),
      create: async (name) => {
        try {
          await this.backend.createWorkspace(name);
          return null;
        } catch (error) {
          return describeError(error);
        }
      },
    });
    if (this.active) this.view.focus();
  }

  private reconfigureLanguage(doc: Doc): void {
    if (!doc.state) return;
    const effects = languageEffect(doc.fileName);
    if (doc === this.active && this.view.state === doc.state) this.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
    if (doc === this.active) this.statusBar.setLanguage(languageLabel(doc.fileName));
  }

  private async refreshMemos(): Promise<void> {
    try {
      this.memoList.setMemos(await this.backend.listMemos());
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    console.error(error);
    this.statusBar.setMessage(describeError(error), "error");
  }
}
```

`src/main.ts` 를 아래로 바꾼다.

```ts
import { AppController } from "./app/controller";
import type { Backend } from "./backend/types";

async function chooseBackend(): Promise<{ backend: Backend; fake: boolean }> {
  if ("__TAURI_INTERNALS__" in window) {
    const { TauriBackend } = await import("./backend/tauri");
    return { backend: new TauriBackend(), fake: false };
  }
  // Outside the app — a browser on the Vite dev server, the UI tests — an in-memory stand-in.
  const { FakeBackend } = await import("./backend/fake");
  return { backend: FakeBackend.fromSessionStorage(), fake: true };
}

void (async () => {
  const { backend, fake } = await chooseBackend();
  const app = new AppController(document.body, backend);
  const handle = { app, backend, ready: false };
  // The UI tests drive the fake backend and inspect the editor through this handle.
  if (fake) Object.assign(window, { __tote: handle });
  try {
    await app.start();
    handle.ready = true;
  } catch (error) {
    document.body.textContent = `tote 를 시작하지 못했습니다: ${String(error)}`;
  }
})();
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
```

Expected: Vitest `Tests  54 passed (54)`, Playwright `20 passed`(editor 5, dialogs 3, memo 7, external 5), tsc 오류 없음.

- [ ] **Step 5: 실제 앱 빌드 확인**

```bash
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json
```

Expected: 오류 없이 끝난다(`pnpm build` 의 tsc·Vite 빌드와 Rust 빌드를 함께 거친다). 화면 동작은 Task 15 에서 사람이 본다.

- [ ] **Step 6: 포맷·린트·커밋**

```bash
pnpm exec oxfmt src tests
pnpm exec oxlint --fix src tests
git add src/main.ts src/app/controller.ts tests/e2e/globals.d.ts tests/e2e/helpers.ts tests/e2e/memo.spec.ts tests/e2e/external.spec.ts
git commit -m "feat(app): workspace window controller with session restore, menus and flush on close"
```

---

### Task 15: 사람이 하는 스모크

WKWebView 의 한글 입력기, 실제 메뉴와 ⌘Q, 창 위치, 셸 명령처럼 자동화가 닿지 않는 것을 사람이 확인한다. 코디네이터가 앱을 빌드해 띄우고, **한 단계씩** 안내하고, 결과를 받아 적는다(한 번에 목록 전체를 넘기지 않는다).

**Files:**

- Create: `docs/superpowers/reports/<실행 날짜 YYYY-MM-DD>-tote-note-core-foundation-smoke.md`

- [ ] **Step 1: 빌드와 격리된 실행**

코디네이터가 돌린다. 디버그 번들을 쓰고, 데이터는 임시 폴더로, 식별자는 개발용으로 띄운다(설치된 tote 와 섞이지 않는다). 디버그 빌드라 `TOTE_DATA_DIR` 없이 잘못 떠도 사람의 `~/Tote` 가 아니라 `~/Tote-dev` 에 쓴다.

```bash
pnpm tauri build --debug --bundles app --config src-tauri/tauri.dev.conf.json
APP="$PWD/src-tauri/target/debug/bundle/macos/tote-dev.app"
export TOTE_DATA_DIR=/tmp/tote-smoke
rm -rf "$TOTE_DATA_DIR"
open --env TOTE_DATA_DIR="$TOTE_DATA_DIR" "$APP"
```

사람에게는 터미널에서 같은 `export TOTE_DATA_DIR=/tmp/tote-smoke` 를 해 두게 한다(CLI 확인 때 쓴다). 표의 「다시 연다」는 언제나 위의 `open --env …` 줄이다. 꺼진 앱을 Dock·Finder·`tote` 명령으로 띄우면 `TOTE_DATA_DIR` 이 빠지므로, `tote` 명령은 앱이 떠 있을 때만 쓴다.

- [ ] **Step 2: 항목별 확인**

| 항목                   | 할 일                                                                                                                               | 기대                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 첫 실행                | 앱을 본다                                                                                                                           | 창 제목 `메모`, 가운데 「⌘N 으로 새 메모를 만드세요」                                                                                                                                                                                                                                                                                           |
| 제목                   | ⌘N → `# 장보기` → Enter                                                                                                             | 사이드바와 탭이 `장보기`, `/tmp/tote-smoke/workspaces/메모/장보기.md` 가 있다                                                                                                                                                                                                                                                                   |
| 한글 + 커서 여럿       | 세 줄을 쓰고 ⌥클릭으로 커서 셋 → 한글 `가나` 입력                                                                                   | 마지막에 ⌥클릭한 자리에만 `가나`, 다른 커서는 사라지고 자모가 남지 않는다                                                                                                                                                                                                                                                                       |
| 한글 + 선택 여럿       | 같은 단어 둘을 ⌘D 로 고른 뒤 한글 입력                                                                                              | 주 선택만 바뀌고 다른 선택은 풀린다                                                                                                                                                                                                                                                                                                             |
| ⌥ 마우스               | ⌥드래그로 세 줄에 걸친 사각 선택 → 영문 입력 → Esc                                                                                  | 세 줄 모두에 들어가고, Esc 로 커서 하나                                                                                                                                                                                                                                                                                                         |
| ⌘Q 직후                | ⌘N 으로 새 메모를 열어 첫 줄 하나를 치고 바로 ⌘Q → 다시 연다                                                                        | 그 줄이 있고 제목도 바뀌어 있다                                                                                                                                                                                                                                                                                                                 |
| 강제 종료              | 치고 2초 뒤 `pkill -9 -f tote-dev.app` → 다시 연다                                                                                  | 친 글이 모두 있고, 탭·커서·스크롤 위치가 돌아온다(세션은 변화가 멈추고 1초 뒤에 쓴다)                                                                                                                                                                                                                                                           |
| 창 둘                  | ⇧⌘N 으로 `업무` 를 치고 Enter(조합 확정) → Enter(만들기) 로 만든 뒤 두 창을 옮기고 크기를 바꾸고 ⌘Q → 다시 연다                     | 두 창이 그 자리·그 크기로, 각자의 탭과 함께                                                                                                                                                                                                                                                                                                     |
| 워크스페이스 선택      | ⇧⌘O 로 목록을 띄우고 다른 창의 워크스페이스를 누른다                                                                                | 그 창이 앞으로 온다                                                                                                                                                                                                                                                                                                                             |
| 창 닫기                | 빨간 버튼으로 모두 닫고 Dock 아이콘을 누른다                                                                                        | 가장 최근 워크스페이스가 열린다                                                                                                                                                                                                                                                                                                                 |
| 셸 명령                | 메뉴 「셸 명령 설치…」 → 안내대로 PATH                                                                                              | `tote --help` 가 사용법을 찍는다                                                                                                                                                                                                                                                                                                                |
| CLI 열기               | `printf 'echo hi\n' > ~/x.sh; chmod +x ~/x.sh; tote ~/x.sh`                                                                         | 기울임 탭 `x.sh`, 앱이 앞으로 온다                                                                                                                                                                                                                                                                                                              |
| ⌘S                     | 그 탭을 고쳐 ●가 생긴 뒤 ⌘S                                                                                                         | ●가 사라지고 `ls -l ~/x.sh` 에 실행 권한(`x`)이 그대로                                                                                                                                                                                                                                                                                          |
| 수정분                 | 다시 고치고 2초 뒤 `pkill -9 -f tote-dev.app` → 다시 연다                                                                           | ●와 고친 내용이 돌아온다. 탭을 닫으려 하면 저장 / 버리기 / 취소를 묻는다(취소를 골라 탭을 남긴다)                                                                                                                                                                                                                                               |
| 표준 입력              | `echo "# 파이프" \| tote -`                                                                                                         | 새 탭이 열리고, 탭을 떠나면 이름이 `파이프` 가 된다                                                                                                                                                                                                                                                                                             |
| 거절                   | `tote /tmp; echo $?` 와 `tote -w 없는곳 a; echo $?`                                                                                 | 둘 다 stderr 한 줄과 `1`                                                                                                                                                                                                                                                                                                                        |
| 가져오기               | 외부 탭에서 「워크스페이스로 가져오기」                                                                                             | 사이드바에 생기고 탭이 기울임이 아닌 메모 탭이 된다. 원본은 그대로                                                                                                                                                                                                                                                                              |
| 탭                     | `printf a > /tmp/tote-smoke/a.txt; printf b > /tmp/tote-smoke/b.txt` 뒤 ⌘O 로 둘을 고르고, ⌘⇧] / ⌘⇧[ 로 오간 뒤 ⌘W 로 하나를 닫는다 | 기울임 탭 둘이 열리고 키로 오가며, 하나가 닫힌다                                                                                                                                                                                                                                                                                                |
| 이름 바꾸기            | 메모 탭에서 「파일 › 이름 바꾸기…」로 `목록.txt` → 첫 줄을 고치고 아래 줄로 내려간다                                                | 사이드바와 탭이 `목록.txt` 이고, 첫 줄을 고쳐도 이름이 그대로다                                                                                                                                                                                                                                                                                 |
| 대화상자 한글          | 이름 바꾸기 입력칸에 `메모장` 을 치고 Enter 한 번 → 한 번 더 Enter. 다시 열어 `메모장` 을 치고 조합 중 Esc                          | 첫 Enter 뒤에는 대화상자가 그대로 있고 이름 끝 글자 `장` 이 남아 있다. 한 번 더 Enter 로 `메모장.txt` 가 된다(확장자는 그대로 — 앞 행이 `목록.txt` 로 바꿔 두었다). 조합 중 Esc 에도 대화상자는 남는다(조합 중이던 글자가 남는지는 적기만 한다 — macOS 입력기가 정한다)                                                                         |
| Finder 이름 바꾸기     | 열린 메모를 Finder 에서 이름을 바꾸고 돌아와 한 글자 친다                                                                           | 상태 표시줄에 「원래 파일을 찾지 못해 새 메모로 저장했습니다」. 사이드바에 Finder 에서 붙인 이름의 메모(떠나기 전까지의 글)와 옛 이름의 메모(친 글 전부, 지금 탭)가 둘 다 있고 사이드바의 활성 표시는 없다 — 이름 바꾸기를 따라가는 것은 3번 계획(파일 감시). 문구가 없고 옛 이름 파일만 다시 생기면 「다름 — 창 focus 이벤트 없음」으로 적는다 |
| Dock 종료(알려진 한계) | 치자마자 Dock 아이콘 우클릭 → 종료 → 다시 연다                                                                                      | 잃은 글이 있는지 적는다(이 경로는 쓰고 닫기를 거치지 않는다)                                                                                                                                                                                                                                                                                    |

표의 CLI 행(셸 명령·CLI 열기·표준 입력·거절)에서 Dock 에 두 번째 tote-dev 아이콘이 잠깐 튈 수 있다 — 번들 안의 `tote` 가 `open -n` 으로 새 인스턴스를 띄워 single-instance 로 넘기고 끝나기 때문이다(결함 아님).

- [ ] **Step 3: 정리**

스모크가 만든 링크만 지운다 — 같은 자리에 사람이 둔 `tote` 가 있을 수 있다.

```bash
for link in /usr/local/bin/tote ~/.local/bin/tote; do
  case "$(readlink "$link" 2>/dev/null)" in *tote-dev.app/*) rm "$link" ;; esac
done
rm -f ~/x.sh
rm -rf /tmp/tote-smoke
```

`~/Tote-dev` 나 `~/Library/Application Support/tote-dev` 가 새로 생겼다면 `TOTE_DATA_DIR` 없이 뜬 적이 있다는 뜻이다. 사람에게 알리고 함께 지운다.

- [ ] **Step 4: 보고서와 커밋**

항목마다 결과(그대로 / 다름 — 무엇이 어떻게)와 사람이 남긴 말을 보고서에 적는다. 「다름」 은 고칠지·다음 계획으로 넘길지 판정과 함께 적는다. 실행 날짜를 파일 이름에 쓴다.

```bash
git add docs/superpowers/reports/<실행 날짜>-tote-note-core-foundation-smoke.md
git commit -m "docs: record the tote-note core foundation smoke check"
```
