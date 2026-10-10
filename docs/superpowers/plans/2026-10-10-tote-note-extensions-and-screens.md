# tote-note 확장과 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 코어 기반 위에 「테마, 문법, 다른 형식 뷰어를 확장으로 바꿔 끼울 수 있다」를 세운다 — 확장 로더(VS Code 매니페스트, .vsix 설치)와 번들 확장(기본 테마·언어 묶음·마크다운 미리보기·미디어 뷰어), Worker 에서 도는 TextMate 하이라이트(Oniguruma), OS 모양을 따르는 테마, 언어 바꾸기·자동 인식·언어 설정(⌘/·괄호·단어 경계), 토큰 URL 로 파일을 받는 샌드박스 뷰어와 CSP, 대용량 텍스트 뷰어, 최소 설정 화면.

**Architecture:** Rust 는 `extensions`(매니페스트·설치·레지스트리)와 `files`(토큰 URL·Range·대용량 텍스트 읽기·파일 안 검색) 모듈을 더하고, 두 커스텀 스킴 `tote-file`(토큰 → 파일 바이트)·`tote-ext`(번들 확장의 뷰어 파일)을 연다. 프론트엔드는 레지스트리를 받아 언어·테마·뷰어를 고르고, 하이라이트는 Web Worker 안의 `@shikijs/vscode-textmate` + Oniguruma 엔진이 줄 단위 상태 캐시로 토큰화해 CodeMirror 장식으로 돌려준다. 뷰어는 동일 출처 없는 `sandbox="allow-scripts"` iframe 에서 postMessage 로만 호스트와 말한다. 커진 `AppController` 는 탭 집합·세션 동기화·편집 영역(표면)으로 나눈다.

**Tech Stack:** Tauri 2(커스텀 URI 스킴, `zip`), TypeScript + Vite(Worker 번들), CodeMirror 6, `@shikijs/vscode-textmate` 10 + `@shikijs/engine-oniguruma` 4(WASM 인라인), `tm-grammars`·`tm-themes`(문법·테마 원본), `marked`(미리보기, 인라인 번들), Vitest, Playwright(WebKit), `cargo test`.

**Spec:** `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`. 스파이크 결과는 `docs/superpowers/reports/2026-10-07-tote-note-spikes.md`(「뷰어 파일 전달」·「편집 성능」·「검증하지 않은 것」 절). 첫 계획 `docs/superpowers/plans/2026-10-08-tote-note-core-foundation.md` 가 만든 코드 위에서 돈다. 실행자는 세 문서를 함께 읽는다.

## 이 계획의 위치

코어는 계획 셋으로 나눠 쓴다. 이 문서는 둘째다.

1. **코어 기반** — 워크스페이스·색인·제목 자동 생성, 저장, 세션 유지, 편집기(하이라이트 없이), 메모 목록, `tote` CLI. 끝났다(`docs/superpowers/reports/2026-10-09-tote-note-core-foundation-smoke.md`).
2. **확장과 화면(이 문서)** — 확장 로더, 번들 확장, TextMate 하이라이트(Oniguruma, Worker), 테마, 언어 바꾸기·자동 인식·언어 설정, 뷰어 샌드박스와 `files` 모듈(토큰 URL), CSP, 마크다운 미리보기(세션의 편집·미리보기 모드 포함), 미디어 뷰어, 대용량 텍스트 뷰어, 설정 화면. 첫 계획이 이월한 것 — 컨트롤러 분할과 세션 복원 테스트(스크롤 복원·세션에서 빠진 메모·`recover()` 의 셋째 시도), `ERROR_TEXT` 를 `Partial<Record<BackendErrorCode, string>>` 로 좁히기, 조합으로 친 한글을 ⌘Z 한 뒤 커서 여럿 되살리기.
3. **안전망** — 백업, 워크스페이스 검색, 파일 감시와 외부 변경·충돌·삭제 배너, 저장 실패 재시도와 종료 경고, 워크스페이스 위치 다시 지정, 성능 계측과 목표치, CLI 요청 실패의 알림, Dock 종료의 쓰고 닫기(`applicationShouldTerminate`), 그 밖에 첫 계획 「이 계획의 위치」 3번이 적은 것 전부.

## 스펙이 이 계획에 넘긴 것과 이 계획이 정한 것

- **문법의 출처와 라이선스(스펙 「번들 확장」 「문법마다 라이선스를 확인한다」).** 문법 JSON 은 npm `tm-grammars` 에서, 테마는 `tm-themes` 에서 복사한다. 두 패키지는 메타데이터(`index.js`)에 원본 저장소·커밋·SPDX 라이선스·라이선스 URL 을 문법마다 싣고, 복사 스크립트(Task 5)가 그것을 읽어 `LICENSES.md` 에 적고 허용 목록(MIT·BSD·Apache-2.0·ISC·textmate 번들 허가문) 밖이거나 비어 있으면 실패한다. 메타데이터에 라이선스가 없는 둘(yaml·toml — textmate 번들 출처)은 원본 README 의 허가문을 확인해 선택표에 손으로 적는다. 번들 테마는 VS Code 의 `Light+`·`Dark+`(MIT).
- **줄 상태 캐시의 단위는 줄이다.** 스파이크의 200줄 청크가 아니라 VS Code 와 같은 줄 단위다. `@shikijs/vscode-textmate` 의 `tokenizeLine2` 를 직접 불러 줄마다 `StateStack` 을 둔다(상태는 공유 연결 리스트라 줄 수만큼 참조만 든다). 시간 제한은 `0`(없음)이다.
- **긴 줄 경계(스펙 「크기별 단계」 「경계 길이는 구현 계획에서 실측으로 정한다」).** Task 14 가 사전에 적어 둔 규칙으로 잰다. 실측이 결론을 내지 못하면 잠정값 **1,000,000자**를 쓴다(10MB 한 줄이 +34ms 였고 20,000자는 하이라이트 가드다. 선형으로 보면 100만 자는 한 프레임의 1/4 안쪽이다).
- **토큰의 수명은 뷰(탭 안의 뷰어·대용량 텍스트 뷰어 인스턴스)다.** 토큰은 `(창 라벨, 소유자 ID)` 로 발급되고, 그 뷰를 닫거나 다른 뷰로 바꿀 때 소유자 단위로 회수한다. 창이 사라지면 그 창의 토큰 전부를 회수한다.
- **확장의 활성 상태는 `settings.json` 의 `extensions.disabled`(ID 목록)에 둔다.** 번들 확장은 끄거나 지울 수 없다(언어 묶음을 끄면 모든 파일이 일반 텍스트가 된다). 같은 확장자를 두 확장이 주장할 때의 우선은 `extensions.precedence`(`"user"` 기본, `"bundled"`)이고 설정 화면의 라디오로 바꾼다.
- **설정 화면의 워크스페이스 루트는 바로 적용된다.** `AppCore` 의 루트를 잠금 아래 두고, 워크스페이스 목록·만들기·`tote -w` 가 그 값을 읽는다. 이미 열린 창은 그대로다.
- **번들 뷰어 파일은 `tote-ext://localhost/<확장 ID>/<경로>` 로 iframe 에 싣는다.** 레지스트리에 있는 번들 확장의 폴더 안 파일만 낸다. 브라우저 미리보기와 UI 테스트는 Vite 개발 서버의 미들웨어가 같은 폴더를 `/extensions/<확장 ID>/<경로>` 로 낸다.
- **컨트롤러는 셋으로 나눈다.** `Tabs`(탭 순서·활성·찾기, 순수 로직), `SessionSync`(세션 읽기·쓰기·복원), `Surface`(편집 영역에 무엇을 보일지 — 편집기·자리표시·뷰어·대용량 텍스트 뷰어). `AppController` 는 메뉴·열기·닫기·오류 보고를 갖는다.
- **매니페스트 JSON 은 주석과 끝 쉼표를 허용한다.** VS Code 의 테마·언어 설정 파일이 JSONC 라서, Rust 와 TS 양쪽에 같은 규칙의 `strip_jsonc` 를 둔다.
- **뷰어 HTML 의 CSP 는 inline 스크립트의 SHA-256 해시로 잠근다.** 번들 뷰어는 생성 스크립트가 해시를 계산해 `<meta>` 에 넣는다. 마크다운이 끼워 넣은 HTML 의 `onerror=` 같은 핸들러는 해시 CSP 에 걸려 돌지 않는다.
- **PDF 는 이 계획에서 열리지 않는다.** 번들 확장 넷에 PDF 뷰어가 없으므로 「열 수 없음」 자리표시가 남는다.

## 이 계획이 다루지 않는 것

3번 계획(안전망)의 몫이다. 이 계획의 코드가 이것들을 흉내 내지 않는다.

- 백업(스냅샷·하드링크·보존·이전 버전).
- 워크스페이스 검색 패널. 이 계획의 검색은 대용량 텍스트 뷰어의 **파일 안** 검색뿐이다.
- 파일 감시와 외부 변경·충돌·삭제 배너.
- 저장 실패의 5초 재시도와 종료 경고.
- 워크스페이스 폴더가 사라졌을 때의 「찾을 수 없음」과 위치 다시 지정.
- 성능 계측 지점과 목표치(콜드 스타트·세션 복원·검색). 예외는 Task 14 의 긴 줄 경계 실측 하나다.
- CLI 요청 실패(inbox·가져오기·`-w`)의 알림.
- Dock 종료·로그아웃의 쓰고 닫기(`applicationShouldTerminate`), 시작 때 `listMemos` 실패 시 세션 쓰기 막기, 복구로 메모 ID 가 바뀔 때의 사이드바 활성 표시, 개발 번들의 「셸 명령 설치」 범위.
- 사용자 설치 확장의 뷰어(스펙 「뷰어」 — 마켓플레이스보다 먼저, 별도 webview 로 옮긴 뒤).
- 마크다운 미리보기의 원격 이미지, 분할 화면, PDF 뷰어.

## Global Constraints

모든 태스크의 요구 사항에 아래가 포함된다. 값은 스펙에서 그대로 옮겼다.

- 플랫폼은 macOS 먼저다. 경로·앱 데이터 위치처럼 OS 에 기대는 코드는 Rust 모듈 경계 안(`appdata`, `extensions`, `files`)에 가둔다.
- 앱 셸 Tauri 2, 프론트엔드 TypeScript, 백엔드 Rust, 편집기 CodeMirror 6. **하이라이트는 TextMate 문법 엔진(Shiki 계열)이고 정규식 엔진은 Oniguruma(WASM)다.** 테마는 VS Code 테마 형식.
- **파일 내용은 JSON 문자열이 아니라 Tauri 2 바이너리 IPC 로 주고받는다.** 확장 파일 읽기(`read_extension_file`)도 같다. 이름·경로는 퍼센트 인코딩한 헤더(`x-memo-id`, `x-path`, `x-file-name`)로 보낸다.
- **원자적 쓰기:** 같은 폴더의 임시 파일에 쓴 뒤 rename 한다. `settings.json` 도 `write_json` 으로 쓴다.
- **확장은 선언형 기여와 샌드박스 뷰어만 담는다.** 파일 시스템과 네트워크에 접근할 수 없고 앱 명령(IPC)을 실행할 수 없다. `main`·`browser`·`activationEvents` 는 무시한다.
- 매니페스트는 VS Code `package.json` 형식, ID 는 `publisher.name`. `contributes.languages`(id, extensions, filenames, firstLine, configuration), `contributes.grammars`(language, scopeName, path, embeddedLanguages), `contributes.themes`(label, uiTheme, path), 최상위 `tote.viewers`(id, kind `primary`|`preview`, extensions, entry).
- 설치 위치는 앱 번들 안(읽기 전용)과 `Application Support/tote/extensions/<id>@<버전>/`. 파일(.vsix, .zip)이나 폴더에서 설치하고, 같은 ID 가 있으면 확인 후 교체한다. 매니페스트가 잘못된 확장은 건너뛰고 목록에 오류로 표시하며 앱 시작은 막지 않는다. **문법은 그 언어의 파일을 처음 열 때만 불러온다.** 같은 확장자를 두 확장이 주장하면 사용자 설치가 번들보다 우선이고 설정에서 바꿀 수 있다. **1차에는 사용자 설치 확장의 뷰어를 레지스트리에 넣지 않는다.**
- **격리:** 뷰어는 `sandbox="allow-scripts"` iframe(동일 출처 없음)에서 돌고 CSP 로 네트워크를 막는다. 뷰어 iframe 에는 `__TAURI_INTERNALS__` 가 없고, 명령 실행을 막는 것은 Tauri 의 invoke key 검사 하나다 — 그래서 번들 확장의 뷰어만 돈다.
- **파일 전달:** 그 파일 하나만 가리키는 토큰 URL(커스텀 스킴). 경로를 드러내지 않고, 받은 화면이 열려 있는 동안 몇 번이든 쓰며, 닫을 때 회수한다. Range 요청을 지원한다. `resolveRelative` 는 열린 파일과 같은 폴더 안의 파일만 돌려준다. 미리보기 뷰어는 텍스트를 메시지로 받는다.
- 뷰어 API: 호스트 → 뷰어 `init`(파일 이름·확장자·크기·토큰 URL 또는 텍스트·테마 변수). 뷰어 → 호스트 `ready`, `error`, `resolveRelative(경로)`. 뷰어가 오류를 내거나 응답하지 않으면 「열 수 없음」과 「텍스트로 열기」.
- 테마: 라이트·다크를 따로 지정하고 OS 모양을 따른다. `colors` 중 tote UI 에 대응하는 키만 CSS 변수로, `tokenColors` 는 하이라이트에, 같은 CSS 변수를 뷰어에 넘긴다.
- 편집기: 언어는 확장자로 정한다. 언어 바꾸기는 상태 표시줄에서 — 메모면 확장자를 바꾸고 `index.json` 에 `language`, 외부 파일이면 표시만 바꾸고 세션에 기록. 자동 인식은 `.md` 이면서 `language` 가 없는 메모만, 첫 줄이 `firstLine` 에 맞거나 내용 전체가 `{`/`[` 로 시작하는 유효한 JSON 일 때만, `.md` 에서 올라가기만 한다. 마크다운 편집 보조는 `@codemirror/lang-markdown`, 색은 TextMate. ⌘/·괄호 자동 닫기·단어 경계는 `language-configuration.json`.
- 성능: 토큰화는 Web Worker 에서, 보이는 영역부터, 줄마다 문법 상태 캐시, 편집한 줄부터만 다시. **줄당 벽시계 시간 제한을 쓰지 않는다.** **한 줄 20,000자 초과면 그 줄은 하이라이트하지 않는다. 20MB 초과면 하이라이트·접기를 끄고 편집은 된다. 100MB 초과와 한 줄이 경계 길이를 넘는 파일은 읽기 전용 대용량 텍스트 뷰어로 연다.** 대용량 텍스트 뷰어는 코어 화면이고 뷰어와 같은 토큰 URL·Range 로 페이지 단위로 읽으며 파일 안 검색은 Rust 가 맡는다.
- 미디어 뷰어: 이미지는 창 맞춤 ↔ 실제 크기 전환만, 영상·오디오는 WebView 기본 컨트롤, 재생할 수 없으면 「지원하지 않는 포맷」. 마크다운 미리보기: 탭마다 편집 ↔ 미리보기(⇧⌘V), 전환하는 순간의 텍스트, 상대 경로 이미지는 토큰 URL, 원격 이미지는 표시하지 않는다.
- 설정 화면은 최소: 워크스페이스 루트, 라이트·다크 테마 선택, 확장 목록(설치·활성·제거). 설정은 `settings.json`.
- 테스트: Rust 매니페스트 파싱은 **실제 .vsix 를 픽스처로**, 언어 자동 인식·테마 색상 대응은 Vitest, UI 흐름은 `FakeBackend` 위 Playwright.
- 주석·문서 규칙: `docs/guideline/base/03-comments.md`. 코드 주석은 영어, 사용자에게 보이는 문구는 한국어. 문서 인용은 줄번호가 아니라 이름·절 제목으로(`docs/guideline/base/04-citation.md`).
- **커밋:** 경로를 명시해 stage 한다(`git add -A` 금지). 커밋 전에 `pnpm exec oxfmt <바꾼 파일>`, `pnpm exec oxlint --fix <바꾼 TS 파일>`, `cargo fmt --manifest-path src-tauri/Cargo.toml` 을 돌린다. 테스트 결과는 **실행된 개수**와 함께 보고한다(0개면 통과가 아니다).
- **포트:** Playwright 의 Vite 서버는 `TOTE_E2E_PORT`(기본 1430). 워크트리를 여럿 돌리면 워크트리마다 다른 값을 준다(`docs/guideline/base/08-shared-resources.md`). `tauri dev` 는 1420 고정이라 한 번에 한 워크트리에서만.
- **에이전트가 앱을 띄울 때는 `TOTE_BACKGROUND=1` 과 `TOTE_DATA_DIR=<임시 폴더>`** 를 준다(디버그 빌드만). 사람의 화면과 메모를 건드리지 않는다. Task 16 은 에이전트가 앱을 띄우지 않는다.
- 생성물(번들 확장의 문법·테마·뷰어 HTML, `src/backend/fake-registry.json`)은 손으로 고치지 않고 `pnpm sync:bundled` 로 다시 만든다. 소스를 고친 턴에 돌린다.

## Review Focus

스펙이 암시하지만 태스크의 기본 테스트가 놓치기 쉬운 입력이다. 사람이 쓰다가 가장 먼저 부딪힐 것부터 적었다. 줄마다 그것을 고정하는 테스트를 소유 태스크에 넣었다.

1. **마켓에서 받은 .vsix 안의 경로가 `../` 나 절대 경로다.** 설치가 확장 폴더 밖에 파일을 쓰면 안 된다. Task 4 의 `entries_that_escape_the_folder_are_refused` 가 고정한다.
2. **VS Code 테마 파일에 주석·끝 쉼표·`include` 가 있다.** 실제 테마 대부분이 그렇다. 파싱 실패로 색이 안 바뀌면 사람은 설치가 안 된 줄 안다. Task 7 의 `resolves an include and reads JSONC` 가 고정한다.
3. **문법을 불러오지 못한다(파일이 깨졌거나 include 한 스코프가 없다).** 일반 텍스트로 열려야 하고 편집은 계속돼야 한다. Task 8 의 `a grammar that fails to load leaves the text uncoloured` 와 `an include of a scope nobody provides is ignored` 가 고정한다.
4. **뷰어가 `ready` 를 보내지 않는다(스크립트 오류, CSP 차단).** 자리표시가 영원히 비면 안 된다 — 「열 수 없음」과 「텍스트로 열기」가 나와야 한다. Task 10 의 `a viewer that never answers shows the fallback` 이 고정한다.
5. **마크다운 안의 이미지가 `../비밀.png` 나 `/etc/…` 를 가리킨다.** 같은 폴더 밖은 돌려주지 않는다. Task 10 의 `resolve_relative_stays_inside_the_folder` 와 Task 12 의 `images outside the folder and remote images stay blank` 이 고정한다.

---

## 파일 구조

```
scripts/
  bundled-languages.ts           번들 언어 선택표(ID·확장자·firstLine·주석·괄호·tm-grammars 이름·라이선스 보강)
  sync-bundled.ts                tm-grammars·tm-themes·marked 에서 번들 확장을 다시 만든다(라이선스 검사 포함)
  measure-long-line.ts           긴 줄 경계 실측(Playwright WebKit)
src-tauri/resources/extensions/  번들 확장(생성물 + 손으로 쓴 매니페스트·뷰어 템플릿)
  tote.languages/                package.json, grammars/*.json, language-configuration/*.json, LICENSES.md
  tote.themes/                   package.json, themes/light-plus.json, themes/dark-plus.json, LICENSES.md
  tote.markdown-preview/         package.json, viewer.template.html, viewer.html(생성물), LICENSES.md
  tote.media-viewer/             package.json, viewer.template.html, viewer.html(생성물)
src-tauri/fixtures/              테스트 픽스처 — vsix-src/(소스), tote-test-theme-0.0.1.vsix
src-tauri/src/
  extensions/{mod,jsonc,manifest,install,registry,serve}.rs
  files/{mod,range,text}.rs
  app/{commands,mod}.rs          명령·AppCore 에 레지스트리·설정·토큰 저장소
  appdata.rs                     Settings 에 theme·extensions, save
  workspace/ops.rs               set_language
  lib.rs                         스킴 둘, 명령 등록
src/
  backend/types.ts               레지스트리·설정·토큰·대용량 텍스트 타입과 Backend 메서드
  backend/{tauri,fake}.ts, backend/fake-registry.json(생성물)
  core/jsonc.ts                  strip_jsonc 의 TS 판
  core/language.ts               언어 고르기·자동 인식
  extensions/registry.ts         레지스트리 조회(파일 → 언어·뷰어, 테마 목록)
  editor/language-config.ts      language-configuration.json → CodeMirror 언어 데이터
  editor/ime.ts                  ⌘Z 뒤 커서 복원
  editor/setup.ts                언어 데이터·하이라이트 확장 연결
  highlight/{protocol,tokenizer,theme,worker,client,extension}.ts
  theme/{vscode-theme,manager}.ts
  viewer/host.ts                 샌드박스 iframe 과 postMessage 프로토콜
  viewer/large-text.ts           대용량 텍스트 뷰어
  app/{tabs,session-sync,surface,errors,controller,docs}.ts
  ui/{status-bar,dialogs,settings,tab-bar}.ts
tests/e2e/                       viewer.spec.ts, markdown.spec.ts, media.spec.ts, large-text.spec.ts, language.spec.ts, settings.spec.ts, highlight.spec.ts
tests/e2e/pages/viewer.html, viewer.ts   뷰어 호스트 단독 페이지
docs/superpowers/reports/<날짜>-long-line-boundary.md     Task 14 의 실측 보고서
```

---

### Task 1: 컨트롤러 분할 — 탭 집합, 세션 동기화, 표면, 오류 문구

**Files:**

- Create: `src/app/tabs.ts`, `src/app/tabs.test.ts`, `src/app/session-sync.ts`, `src/app/session-sync.test.ts`, `src/app/surface.ts`, `src/app/errors.ts`, `src/app/errors.test.ts`
- Modify: `src/app/controller.ts`, `src/app/docs.test.ts`, `src/core/session.ts`, `src/core/session.test.ts`

**Interfaces:**

- Consumes: `AppController`, `Doc`·`MemoDoc`·`ExternalDoc`·`DocHost`(`src/app/docs.ts`), `SessionFile`·`SessionTab`·`parseSession`(`src/core/session.ts`), `BackendErrorCode`·`errorCode`(`src/backend/types.ts`).
- Produces (`src/app/tabs.ts`): `class Tabs { readonly list: Doc[]; active: Doc | null; insertAfterActive<D extends Doc>(doc: D): D; remove(doc: Doc): Doc | null /* the neighbour to show */; cycle(step: number): Doc | null; byId(tabId: string): Doc | undefined; memo(id: string): MemoDoc | undefined; external(path: string): ExternalDoc | undefined; indexOf(doc: Doc): number }`.
- Produces (`src/app/session-sync.ts`): `class SessionSync { constructor(backend: Backend, tabs: Tabs, deviceId: string, memoInfo: (id: string) => MemoInfo | undefined, makeMemo: (info: MemoInfo) => MemoDoc, makeExternal: (path: string) => ExternalDoc); restore(): Promise<Doc | null>; build(captureActive: () => void): Promise<SessionFile> }`, `sessionTab(doc: Doc, deviceId: string): SessionTab`.
- Produces (`src/app/surface.ts`): `class Surface { readonly el: HTMLElement; constructor(view: EditorView); showEditor(state: EditorState, scrollAnchor: number): void; showPlaceholder(text: string, action?: { label: string; run: () => void }): void; showPanel(el: HTMLElement): void /* a viewer or the large text viewer */; showEmpty(): void; get showsEditor(): boolean }`.
- Produces (`src/app/errors.ts`): `ERROR_TEXT: Partial<Record<BackendErrorCode, string>>`, `describeError(err: unknown): string`.
- `SessionTab` gains `mode?: "edit" | "preview"` and (외부 파일) `language?: string` — Task 9·12 가 채운다. `Doc` gains `mode: "edit" | "preview" = "edit"` and `language: string | null = null`.
- `AppController` keeps `constructor(root, backend)`, `start()`, `view`, `writes`, `openMemo`, `openExternal`, `newMemo`, `closeTab`, `flushAll` and gains `readonly tabs: Tabs`, `readonly surface: Surface`.

- [ ] **Step 1: 실패하는 테스트 — 탭 집합**

`src/app/tabs.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { defaultFakeData, FakeBackend, memoryStorage } from "../backend/fake";
import { WriteScheduler } from "../core/scheduler";
import { ExternalDoc, MemoDoc, type DocHost } from "./docs";
import { Tabs } from "./tabs";

function host(): DocHost {
  const backend = new FakeBackend(memoryStorage(JSON.stringify(defaultFakeData())));
  return { backend, writes: new WriteScheduler(() => {}), extensions: () => [], changed: () => {} };
}

const memo = (h: DocHost, id: string) =>
  new MemoDoc(h, { id, file: `${id}.md`, autoTitle: false, modifiedMs: 0, size: 0, kind: "text" });

describe("Tabs", () => {
  it("inserts after the active tab and finds by id, memo and path", () => {
    const h = host();
    const tabs = new Tabs();
    const a = tabs.insertAfterActive(memo(h, "a"));
    const c = tabs.insertAfterActive(memo(h, "c"));
    tabs.active = a;
    const b = tabs.insertAfterActive(new ExternalDoc(h, "/x/b.sh"));
    expect(tabs.list).toEqual([a, b, c]);
    expect(tabs.byId(b.tabId)).toBe(b);
    expect(tabs.memo("c")).toBe(c);
    expect(tabs.external("/x/b.sh")).toBe(b);
    expect(tabs.external("/none")).toBeUndefined();
  });

  it("removing the active tab names the neighbour to show", () => {
    const h = host();
    const tabs = new Tabs();
    const a = tabs.insertAfterActive(memo(h, "a"));
    const b = tabs.insertAfterActive(memo(h, "b"));
    const c = tabs.insertAfterActive(memo(h, "c"));
    tabs.active = c;
    expect(tabs.remove(c)).toBe(b); // the last tab: the one before it
    expect(tabs.active).toBeNull();
    tabs.active = a;
    expect(tabs.remove(a)).toBe(b); // a middle or first tab: the one after it
    tabs.active = b;
    expect(tabs.remove(b)).toBeNull();
    expect(tabs.list).toEqual([]);
  });

  it("removing an inactive tab keeps the active one", () => {
    const h = host();
    const tabs = new Tabs();
    const a = tabs.insertAfterActive(memo(h, "a"));
    const b = tabs.insertAfterActive(memo(h, "b"));
    tabs.active = b;
    expect(tabs.remove(a)).toBeNull();
    expect(tabs.active).toBe(b);
  });

  it("cycles with wrap-around and does nothing with fewer than two tabs", () => {
    const h = host();
    const tabs = new Tabs();
    const a = tabs.insertAfterActive(memo(h, "a"));
    tabs.active = a;
    expect(tabs.cycle(1)).toBeNull();
    const b = tabs.insertAfterActive(memo(h, "b"));
    expect(tabs.cycle(1)).toBe(b);
    expect(tabs.cycle(1)).toBe(a);
    expect(tabs.cycle(-1)).toBe(b);
  });
});
```

- [ ] **Step 2: 실패하는 테스트 — 세션 동기화(이월분 셋)**

`src/app/session-sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { defaultFakeData, FakeBackend, fakeMemo, memoryStorage } from "../backend/fake";
import type { MemoInfo } from "../backend/types";
import { WriteScheduler } from "../core/scheduler";
import { ExternalDoc, MemoDoc, type DocHost } from "./docs";
import { SessionSync, sessionTab } from "./session-sync";
import { Tabs } from "./tabs";

function setup(session: object | null, memos: Record<string, ReturnType<typeof fakeMemo>> = {}) {
  const backend = new FakeBackend(
    memoryStorage(
      JSON.stringify({
        ...defaultFakeData(),
        memos,
        session: session ? JSON.stringify(session) : null,
      }),
    ),
  );
  const host: DocHost = {
    backend,
    writes: new WriteScheduler(() => {}),
    extensions: () => [],
    changed: () => {},
  };
  const infos = new Map<string, MemoInfo>();
  for (const [id, memo] of Object.entries(memos)) {
    infos.set(id, {
      id,
      file: memo.file,
      autoTitle: memo.autoTitle,
      modifiedMs: 0,
      size: 0,
      kind: "text",
    });
  }
  const tabs = new Tabs();
  const sync = new SessionSync(
    backend,
    tabs,
    "device-1",
    (id) => infos.get(id),
    (info) => new MemoDoc(host, info),
    (path) => new ExternalDoc(host, path),
  );
  return { backend, tabs, sync };
}

describe("SessionSync.restore", () => {
  it("brings back the scroll anchor, selection, mode and language of each tab", async () => {
    const { tabs, sync } = setup(
      {
        version: 1,
        activeTab: 1,
        tabs: [
          { kind: "memo", memoId: "a", scrollAnchor: 40, mode: "preview" },
          {
            kind: "external",
            deviceId: "device-1",
            path: "/x/a.sh",
            selection: { ranges: [{ anchor: 2, head: 2 }], main: 0 },
            language: "python",
          },
        ],
      },
      { a: fakeMemo("가.md", "x".repeat(100)) },
    );
    const active = await sync.restore();
    expect(tabs.list.map((d) => d.kind)).toEqual(["memo", "external"]);
    expect(tabs.list[0].scrollAnchor).toBe(40);
    expect(tabs.list[0].mode).toBe("preview");
    expect(tabs.list[1].restoreSelection).toEqual({ ranges: [{ anchor: 2, head: 2 }], main: 0 });
    expect(tabs.list[1].language).toBe("python");
    expect(active).toBe(tabs.list[1]);
  });

  it("drops a memo the list no longer has and an external file of another device", async () => {
    const { tabs, sync } = setup(
      {
        version: 1,
        activeTab: 0,
        tabs: [
          { kind: "memo", memoId: "gone" },
          { kind: "external", deviceId: "other-device", path: "/x/a.sh" },
          { kind: "memo", memoId: "a" },
        ],
      },
      { a: fakeMemo("가.md", "") },
    );
    const active = await sync.restore();
    expect(tabs.list.map((d) => (d as MemoDoc).info?.id)).toEqual(["a"]);
    // The active tab was dropped: the last tab that is left is shown.
    expect(active).toBe(tabs.list[0]);
  });

  it("opens the same memo once even if the session lists it twice", async () => {
    const { tabs, sync } = setup(
      {
        version: 1,
        activeTab: 0,
        tabs: [
          { kind: "memo", memoId: "a" },
          { kind: "memo", memoId: "a" },
        ],
      },
      { a: fakeMemo("가.md", "") },
    );
    await sync.restore();
    expect(tabs.list).toHaveLength(1);
  });
});

describe("SessionSync.build and sessionTab", () => {
  it("writes mode and language only when they differ from the default", async () => {
    const { tabs, sync } = setup(null, { a: fakeMemo("가.md", "") });
    const memo = tabs.insertAfterActive(
      new MemoDoc(
        {
          backend: new FakeBackend(),
          writes: new WriteScheduler(() => {}),
          extensions: () => [],
          changed: () => {},
        },
        { id: "a", file: "가.md", autoTitle: false, modifiedMs: 0, size: 0, kind: "text" },
      ),
    );
    memo.mode = "preview";
    const ext = tabs.insertAfterActive(
      new ExternalDoc(
        {
          backend: new FakeBackend(),
          writes: new WriteScheduler(() => {}),
          extensions: () => [],
          changed: () => {},
        },
        "/x/a.sh",
      ),
    );
    ext.language = "python";
    tabs.active = ext;
    let captured = 0;
    const session = await sync.build(() => void captured++);
    expect(captured).toBe(1);
    expect(session.activeTab).toBe(1);
    expect(session.tabs[0]).toEqual({
      kind: "memo",
      memoId: "a",
      scrollAnchor: 0,
      mode: "preview",
    });
    expect(session.tabs[1]).toEqual({
      kind: "external",
      deviceId: "device-1",
      path: "/x/a.sh",
      scrollAnchor: 0,
      language: "python",
    });
    memo.mode = "edit";
    expect(sessionTab(memo, "device-1")).toEqual({ kind: "memo", memoId: "a", scrollAnchor: 0 });
  });
});
```

`src/app/docs.test.ts` 의 `describe("MemoDoc")` 안에 이월분(`recover()` 의 셋째 시도)을 더한다:

```ts
it("recovers under untitled.md when neither its own name nor untitled.<ext> can be made", async () => {
  // A file Finder named `a.b?` has the extension `b?`, which tote cannot write; the third
  // candidate is the only one left.
  const { backend, host } = setup({ memos: { a: fakeMemo("a.b?", "원래") } });
  const doc = new MemoDoc(host, (await backend.listMemos())[0]);
  await doc.ensureLoaded();
  delete backend.data.memos.a;
  type(doc, " 추가");
  await vi.runAllTimersAsync();
  expect(doc.info.file).toBe("untitled.md");
  expect(backend.memoText(doc.info.id)).toBe("원래 추가");
  expect(doc.notice).toBe(RECOVERED_NOTICE);
});
```

`src/app/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { BackendError } from "../backend/types";
import { describeError, ERROR_TEXT } from "./errors";

describe("describeError", () => {
  it("uses the Korean text for codes that have one and the message otherwise", () => {
    expect(describeError(new BackendError("already-exists", "x"))).toBe(
      ERROR_TEXT["already-exists"],
    );
    expect(describeError(new BackendError("io", "disk full"))).toBe("오류: disk full");
    expect(describeError(new Error("boom"))).toBe("오류: boom");
    expect(describeError("plain")).toBe("오류: plain");
  });
});
```

`src/core/session.test.ts` 의 `describe("parseSession")` 에 더한다:

```ts
it("reads mode and language and drops values it does not know", () => {
  const session = parseSession(
    JSON.stringify({
      version: 1,
      activeTab: 0,
      tabs: [
        { kind: "memo", memoId: "a", mode: "preview" },
        { kind: "memo", memoId: "b", mode: "split" },
        { kind: "external", deviceId: "d", path: "/x", language: "python" },
        { kind: "external", deviceId: "d", path: "/y", language: 3 },
      ],
    }),
  );
  expect(session.tabs[0]).toEqual({ kind: "memo", memoId: "a", mode: "preview" });
  expect(session.tabs[1]).toEqual({ kind: "memo", memoId: "b" });
  expect(session.tabs[2]).toEqual({
    kind: "external",
    deviceId: "d",
    path: "/x",
    language: "python",
  });
  expect(session.tabs[3]).toEqual({ kind: "external", deviceId: "d", path: "/y" });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm test -- src/app src/core/session.test.ts`
Expected: FAIL — `./tabs`, `./session-sync`, `./errors` 를 찾지 못하고, `mode`·`language` 가 없다.

- [ ] **Step 4: 세션 형식과 문서 필드**

`src/core/session.ts` — `TabPlace` 와 `parseTab` 을 바꾼다:

```ts
export type ViewMode = "edit" | "preview";

interface TabPlace {
  selection?: SelectionJSON;
  /** Document position at the top of the viewport. */
  scrollAnchor?: number;
  /** Edit or preview (spec 「세션」); left out when editing. */
  mode?: ViewMode;
}

export type SessionTab =
  | ({ kind: "memo"; memoId: string } & TabPlace)
  /** `language`: the language chosen in the status bar; a memo keeps it in index.json instead. */
  | ({ kind: "external"; deviceId: string; path: string; language?: string } & TabPlace);
```

```ts
function parseTab(value: unknown): SessionTab | null {
  if (!isObject(value)) return null;
  const place: TabPlace = {};
  const selection = parseSelection(value.selection);
  if (selection) place.selection = selection;
  if (isNumber(value.scrollAnchor)) place.scrollAnchor = value.scrollAnchor;
  if (value.mode === "preview") place.mode = "preview";
  if (value.kind === "memo" && typeof value.memoId === "string") {
    return { kind: "memo", memoId: value.memoId, ...place };
  }
  if (
    value.kind === "external" &&
    typeof value.deviceId === "string" &&
    typeof value.path === "string"
  ) {
    const tab: SessionTab = {
      kind: "external",
      deviceId: value.deviceId,
      path: value.path,
      ...place,
    };
    if (typeof value.language === "string") tab.language = value.language;
    return tab;
  }
  return null;
}
```

`src/app/docs.ts` 의 `abstract class Doc` 에 필드 둘을 더한다(`scrollAnchor` 아래):

```ts
  /** Edit or preview; only Markdown tabs ever leave "edit" (Task 12). */
  mode: ViewMode = "edit";
  /** The language the person picked in the status bar (`null`: decided by the file name). A memo
   * mirrors `info.language`; an external file keeps it in the session. */
  language: string | null = null;
```

`import type { ViewMode } from "../core/session"` 을 더하고, `MemoDoc` 의 `setInfo` 에서 `this.language = info.language ?? null;` 를 `this.info = info;` 다음 줄에 넣는다. `MemoDoc` 생성자에서도 `this.language = info.language ?? null;` 를 둔다.

- [ ] **Step 5: 구현 — `tabs.ts`, `errors.ts`, `session-sync.ts`, `surface.ts`**

`src/app/tabs.ts`:

```ts
import { ExternalDoc, MemoDoc, type Doc } from "./docs";

/** The ordered tabs of one window and which one is active. No DOM, no backend: the controller
 * asks it where things go and renders the answer. */
export class Tabs {
  readonly list: Doc[] = [];
  active: Doc | null = null;

  /** New tabs open right after the active one. */
  insertAfterActive<D extends Doc>(doc: D): D {
    const at = this.active ? this.list.indexOf(this.active) + 1 : this.list.length;
    this.list.splice(at, 0, doc);
    return doc;
  }

  /** Takes `doc` out. When it was active, `active` becomes null and the tab that should take its
   * place is returned: the next one, else the previous one, else null. */
  remove(doc: Doc): Doc | null {
    const index = this.list.indexOf(doc);
    if (index < 0) return null;
    this.list.splice(index, 1);
    if (doc !== this.active) return null;
    this.active = null;
    return this.list[index] ?? this.list[index - 1] ?? null;
  }

  cycle(step: number): Doc | null {
    if (!this.active || this.list.length < 2) return null;
    const index = this.list.indexOf(this.active);
    return this.list[(index + step + this.list.length) % this.list.length];
  }

  indexOf(doc: Doc): number {
    return this.list.indexOf(doc);
  }

  byId(tabId: string): Doc | undefined {
    return this.list.find((d) => d.tabId === tabId);
  }

  memo(id: string): MemoDoc | undefined {
    return this.list.find((d): d is MemoDoc => d instanceof MemoDoc && d.info.id === id);
  }

  external(path: string): ExternalDoc | undefined {
    return this.list.find((d): d is ExternalDoc => d instanceof ExternalDoc && d.path === path);
  }
}
```

`src/app/errors.ts`:

```ts
import { errorCode, type BackendErrorCode } from "../backend/types";

/** Codes with a sentence for the status bar; the rest show their message. */
export const ERROR_TEXT: Partial<Record<BackendErrorCode, string>> = {
  "already-exists": "같은 이름이 이미 있습니다",
  "invalid-name": "쓸 수 없는 이름입니다",
  "not-found": "파일을 찾을 수 없습니다",
  "already-installed": "같은 확장이 이미 설치돼 있습니다",
  "invalid-extension": "확장 패키지를 읽을 수 없습니다",
};

export function describeError(err: unknown): string {
  const code = errorCode(err);
  const text = code ? ERROR_TEXT[code] : undefined;
  if (text) return text;
  return `오류: ${err instanceof Error ? err.message : String(err)}`;
}
```

`src/backend/types.ts` 의 `BACKEND_ERROR_CODES` 에 `"already-installed"`, `"invalid-extension"` 을 더한다(Rust 쪽은 Task 4 가 낸다).

`src/app/session-sync.ts`:

```ts
import type { Backend, MemoInfo } from "../backend/types";
import { parseSession, type SessionFile, type SessionTab } from "../core/session";
import { ExternalDoc, MemoDoc, type Doc } from "./docs";
import type { Tabs } from "./tabs";

/** The session tab for `doc`. Defaults are left out so a session written by an older build and
 * one written now read the same. */
export function sessionTab(doc: Doc, deviceId: string): SessionTab {
  const place: { selection?: SessionTab["selection"]; scrollAnchor: number; mode?: "preview" } = {
    scrollAnchor: doc.scrollAnchor,
  };
  if (doc.selectionJSON) place.selection = doc.selectionJSON;
  if (doc.mode === "preview") place.mode = "preview";
  if (doc instanceof MemoDoc) return { kind: "memo", memoId: doc.info.id, ...place };
  const external = doc as ExternalDoc;
  // Spec 「동기화 대비」: external entries always carry the device they belong to.
  const tab: SessionTab = { kind: "external", deviceId, path: external.path, ...place };
  if (external.language) tab.language = external.language;
  return tab;
}

/** Reads the session into `tabs` and builds the session from them. */
export class SessionSync {
  constructor(
    private readonly backend: Backend,
    private readonly tabs: Tabs,
    private readonly deviceId: string,
    private readonly memoInfo: (id: string) => MemoInfo | undefined,
    private readonly makeMemo: (info: MemoInfo) => MemoDoc,
    private readonly makeExternal: (path: string) => ExternalDoc,
  ) {}

  /** Fills `tabs` (which must be empty) and returns the tab to activate: the session's active
   * tab, else the last one, else null. Nothing is read from disk here (spec 「세션」 — lazy). */
  async restore(): Promise<Doc | null> {
    const session = parseSession(await this.backend.readSession());
    let active: Doc | null = null;
    for (const [index, tab] of session.tabs.entries()) {
      const doc = this.docFor(tab);
      if (!doc) continue;
      doc.restoreSelection = tab.selection;
      doc.scrollAnchor = tab.scrollAnchor ?? 0;
      doc.mode = tab.mode ?? "edit";
      this.tabs.list.push(doc);
      if (index === session.activeTab) active = doc;
    }
    return active ?? this.tabs.list.at(-1) ?? null;
  }

  async build(captureActive: () => void): Promise<SessionFile> {
    captureActive();
    const session: SessionFile = {
      version: 1,
      activeTab: this.tabs.active ? this.tabs.indexOf(this.tabs.active) : -1,
      tabs: this.tabs.list.map((doc) => sessionTab(doc, this.deviceId)),
    };
    const frame = await this.backend.windowFrame();
    if (frame) session.window = frame;
    return session;
  }

  private docFor(tab: SessionTab): Doc | null {
    if (tab.kind === "memo") {
      const info = this.memoInfo(tab.memoId);
      return info && !this.tabs.memo(info.id) ? this.makeMemo(info) : null;
    }
    // Another device's external file has no contents here; how to show it is the sync spec's call.
    if (tab.deviceId !== this.deviceId || this.tabs.external(tab.path)) return null;
    const doc = this.makeExternal(tab.path);
    doc.language = tab.language ?? null;
    return doc;
  }
}
```

`src/app/surface.ts`:

```ts
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { h } from "../ui/dom";

/** The editor area: the editor, a placeholder sentence, or a panel (a viewer, the large text
 * viewer). One of them is visible at a time. */
export class Surface {
  // CodeMirror's own CSS sets `display` on .cm-editor with !important, so its host is what hides.
  private readonly editorHost: HTMLElement;
  private readonly placeholder = h("div", { class: "editor-placeholder" });
  private readonly panelHost = h("div", { class: "panel-host" });
  readonly el: HTMLElement;

  constructor(private readonly view: EditorView) {
    this.editorHost = h("div", { class: "editor-host" }, view.dom);
    this.el = h("div", { class: "editor-area" }, this.editorHost, this.placeholder, this.panelHost);
    this.showEmpty();
  }

  get showsEditor(): boolean {
    return !this.editorHost.hidden;
  }

  showEditor(state: EditorState, scrollAnchor: number): void {
    this.only(this.editorHost);
    this.view.setState(state);
    const anchor = Math.min(scrollAnchor, state.doc.length);
    this.view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: "start" }) });
    this.view.requestMeasure();
    this.view.focus();
  }

  showPlaceholder(text: string, action?: { label: string; run: () => void }): void {
    this.only(this.placeholder);
    const children: (Node | string)[] = [h("p", { textContent: text })];
    if (action) {
      const button = h("button", { textContent: action.label });
      button.addEventListener("click", action.run);
      children.push(button);
    }
    this.placeholder.replaceChildren(...children);
  }

  showPanel(el: HTMLElement): void {
    this.only(this.panelHost);
    this.panelHost.replaceChildren(el);
  }

  showEmpty(): void {
    this.showPlaceholder("⌘N 으로 새 메모를 만드세요");
  }

  private only(shown: HTMLElement): void {
    for (const part of [this.editorHost, this.placeholder, this.panelHost])
      part.hidden = part !== shown;
    if (shown !== this.panelHost) this.panelHost.replaceChildren();
  }
}
```

`src/styles.css` 에 더한다:

```css
.panel-host {
  position: absolute;
  inset: 0;
  min-height: 0;
}

.editor-placeholder p {
  margin: 0 0 12px;
}
```

- [ ] **Step 6: 컨트롤러를 셋에 얹는다**

`src/app/controller.ts` 를 아래로 바꾼다. 동작은 그대로이고 탭·세션·표면 코드가 세 클래스로 옮겨 갔다. `ERROR_TEXT`·`describeError` 는 `./errors` 에서 다시 export 해 기존 import 를 깨지 않는다.

```ts
import { EditorView, type ViewUpdate } from "@codemirror/view";

import type { Backend, MemoInfo } from "../backend/types";
import { WriteScheduler } from "../core/scheduler";
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
import { describeError } from "./errors";
import { SessionSync } from "./session-sync";
import { Surface } from "./surface";
import { Tabs } from "./tabs";

export { describeError, ERROR_TEXT } from "./errors";

const SESSION_DELAY_MS = 1000;

const PROBLEM_TEXT: Record<Problem, string> = {
  binary: "텍스트로 열 수 없음",
  "too-large": "100MB 가 넘는 파일은 아직 열 수 없습니다",
  missing: "파일을 찾을 수 없습니다",
  unreadable: "파일을 읽지 못했습니다",
};

/** One workspace window: menu actions, opening and closing, and what the status bar says. Tabs,
 * the session and the editor area live in `Tabs`, `SessionSync` and `Surface`. */
export class AppController implements DocHost {
  readonly writes = new WriteScheduler((_key, error) => this.report(error));
  readonly view = new EditorView();
  readonly tabs = new Tabs();
  readonly surface = new Surface(this.view);
  private session!: SessionSync;
  private deviceId = "";
  /** Session writes wait until the restored tabs are in place. */
  private restoring = true;
  private readonly memoList = new MemoList((id) => void this.openMemo(id));
  private readonly tabBar = new TabBar({
    select: (id) => void this.activateTab(id),
    close: (id) => void this.closeTab(id),
  });
  private readonly statusBar = new StatusBar();

  constructor(
    root: HTMLElement,
    readonly backend: Backend,
  ) {
    root.replaceChildren(
      this.memoList.el,
      h("main", { class: "main" }, this.tabBar.el, this.surface.el, this.statusBar.el),
    );
    this.view.scrollDOM.addEventListener("scroll", () => this.saveSessionSoon(), { passive: true });
  }

  async start(): Promise<void> {
    const info = await this.backend.workspaceInfo();
    this.deviceId = info.deviceId;
    document.title = info.name;
    this.session = new SessionSync(
      this.backend,
      this.tabs,
      this.deviceId,
      (id) => this.memoList.get(id),
      (memo) => new MemoDoc(this, memo),
      (path) => new ExternalDoc(this, path),
    );
    this.backend.onMenu((id) => void this.onMenu(id));
    this.backend.onFlush((id) => void this.onFlush(id));
    this.backend.onPending(() => void this.drainPending());
    this.backend.onFileDrop((paths) => void this.openExternals(paths));
    // A window losing focus is a tab losing focus (spec 「저장」), and hidden windows barely run
    // timers — so write now rather than when the timer fires.
    window.addEventListener("blur", () => void this.tabs.active?.leave());
    window.addEventListener("focus", () => void this.refreshMemos());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void this.flushAll();
    });
    await this.refreshMemos();
    const first = await this.session.restore();
    if (first) await this.activate(first);
    else this.renderTabs();
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
    const active = doc === this.tabs.active;
    if (doc instanceof MemoDoc && (change === "info" || change === "language"))
      this.memoList.upsert(doc.info);
    if (doc instanceof MemoDoc && change === "deleted") this.memoList.remove(doc.info.id);
    if (change === "language") this.reconfigureLanguage(doc);
    if (active && change === "notice") this.statusBar.setMessage(doc.notice ?? "");
    if (active && change === "saved" && doc instanceof ExternalDoc)
      this.statusBar.setMessage("저장됨");
    // A memo that saved after a failed save no longer has the error to show.
    if (active && change === "saved" && doc instanceof MemoDoc && this.statusBar.showsError)
      this.statusBar.setMessage("");
    if (change === "error") this.report(doc.error);
    this.renderTabs();
  }

  async openMemo(id: string): Promise<void> {
    let doc: Doc | undefined = this.tabs.memo(id);
    if (!doc) {
      let info: MemoInfo | undefined = this.memoList.get(id);
      if (!info) {
        await this.refreshMemos();
        info = this.memoList.get(id);
      }
      if (!info) return this.report(new Error("메모를 찾을 수 없습니다"));
      doc = this.tabs.insertAfterActive(new MemoDoc(this, info));
    }
    await this.activate(doc);
  }

  async openExternal(path: string): Promise<void> {
    await this.activate(
      this.tabs.external(path) ?? this.tabs.insertAfterActive(new ExternalDoc(this, path)),
    );
  }

  async newMemo(): Promise<void> {
    const info = await this.backend.createMemo();
    this.memoList.upsert(info);
    const doc = this.tabs.insertAfterActive(new MemoDoc(this, info));
    doc.startEmpty();
    await this.activate(doc);
  }

  async closeTab(tabId: string): Promise<void> {
    const doc = this.tabs.byId(tabId);
    if (!doc) return;
    this.capture(doc);
    if (!(await doc.close(() => askUnsaved(doc.title)))) {
      if (doc === this.tabs.active) this.view.focus();
      return;
    }
    const wasActive = doc === this.tabs.active;
    const next = this.tabs.remove(doc);
    if (wasActive) {
      if (next) await this.activate(next);
      else this.showEmpty();
    }
    this.renderTabs();
    this.saveSessionSoon();
  }

  /** Everything written now — tab edits, titles and the session (window close, quit, hiding). */
  async flushAll(): Promise<void> {
    await Promise.all(
      this.tabs.list.map((doc) => doc.flush().catch((error: unknown) => this.report(error))),
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
    if (doc !== this.tabs.active || !(update.docChanged || update.selectionSet)) return;
    this.statusBar.setPosition(update.state);
    this.saveSessionSoon();
  }

  private activateTab(tabId: string): Promise<void> {
    const doc = this.tabs.byId(tabId);
    return doc ? this.activate(doc) : Promise.resolve();
  }

  private async activate(doc: Doc): Promise<void> {
    const previous = this.tabs.active;
    if (previous === doc) return;
    if (previous) {
      this.capture(previous);
      void previous.leave();
    }
    this.tabs.active = doc;
    this.renderTabs();
    await doc.ensureLoaded();
    // Loading can mark the tab dirty (a restored draft), which the render above could not know.
    this.renderTabs();
    if (this.tabs.active !== doc) return; // another tab was picked while this one loaded
    this.show(doc);
    this.saveSessionSoon();
  }

  private show(doc: Doc): void {
    const state = doc.problem ? null : doc.state;
    this.memoList.setActive(doc instanceof MemoDoc ? doc.info.id : null);
    this.statusBar.setLanguage(languageLabel(doc.fileName));
    this.statusBar.setMessage(doc.notice ?? "");
    if (!state) {
      this.surface.showPlaceholder(PROBLEM_TEXT[doc.problem ?? "unreadable"]);
      this.statusBar.setPosition(null);
      return;
    }
    this.surface.showEditor(state, doc.scrollAnchor);
    this.statusBar.setPosition(this.view.state);
  }

  private showEmpty(): void {
    this.surface.showEmpty();
    this.memoList.setActive(null);
    this.statusBar.setPosition(null);
    this.statusBar.setLanguage("");
    this.statusBar.setMessage("");
  }

  /** The view holds the live state of the active tab; keep where it is scrolled to. */
  private capture(doc: Doc): void {
    if (doc !== this.tabs.active || !doc.state || this.view.state !== doc.state) return;
    if (!this.surface.showsEditor) return;
    doc.scrollAnchor = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop).from;
  }

  private renderTabs(): void {
    this.tabBar.render(
      this.tabs.list.map((doc) => ({
        id: doc.tabId,
        title: doc.title,
        hint: doc.hint,
        dirty: doc.dirty,
        external: doc.kind === "external",
        active: doc === this.tabs.active,
      })),
    );
  }

  private async openExternals(paths: string[]): Promise<void> {
    for (const path of paths) await this.openExternal(path);
  }

  private async cycleTab(step: number): Promise<void> {
    const next = this.tabs.cycle(step);
    if (next) await this.activate(next);
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
    const session = await this.session.build(() => {
      if (this.tabs.active) this.capture(this.tabs.active);
    });
    await this.backend.writeSession(JSON.stringify(session));
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
          return this.tabs.active
            ? await this.closeTab(this.tabs.active.tabId)
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
    const doc = this.tabs.active;
    if (doc instanceof ExternalDoc) await doc.save();
    else if (doc instanceof MemoDoc) await doc.saveNow();
  }

  private async importActive(): Promise<void> {
    const doc = this.tabs.active;
    if (!(doc instanceof ExternalDoc)) return;
    this.capture(doc);
    const memo = await importExternal(doc, this);
    this.tabs.list[this.tabs.indexOf(doc)] = memo;
    this.memoList.upsert(memo.info);
    this.tabs.active = null;
    await this.activate(memo);
    this.statusBar.setMessage("워크스페이스로 가져왔습니다");
  }

  private async renameActive(): Promise<void> {
    const doc = this.tabs.active;
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
    if (this.tabs.active) this.view.focus();
  }

  private reconfigureLanguage(doc: Doc): void {
    if (!doc.state) return;
    const effects = languageEffect(doc.fileName);
    if (doc === this.tabs.active && this.view.state === doc.state) this.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
    if (doc === this.tabs.active) this.statusBar.setLanguage(languageLabel(doc.fileName));
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

- [ ] **Step 7: 통과 확인**

Run: `pnpm test` 그리고 `pnpm test:e2e`
Expected: Vitest 가 새 테스트 10개를 포함해 모두 PASS(실행 개수를 적는다), E2E 의 기존 spec(`memo`·`external`·`editor`·`dialogs`)이 그대로 PASS. `pnpm typecheck` 도 깨끗하다.

- [ ] **Step 8: 커밋**

```bash
pnpm exec oxfmt src/app src/core/session.ts src/core/session.test.ts src/backend/types.ts src/styles.css
pnpm exec oxlint --fix src/app src/core src/backend
git add src/app/tabs.ts src/app/tabs.test.ts src/app/session-sync.ts src/app/session-sync.test.ts src/app/surface.ts src/app/errors.ts src/app/errors.test.ts src/app/controller.ts src/app/docs.ts src/app/docs.test.ts src/core/session.ts src/core/session.test.ts src/backend/types.ts src/styles.css
git commit -m "refactor(app): split the controller into tabs, session sync and surface; narrow ERROR_TEXT"
```

---

### Task 2: ⌘Z 가 조합으로 친 글을 되돌릴 때 커서 여럿을 되살린다

**Files:**

- Modify: `src/editor/ime.ts`, `src/editor/ime.test.ts`, `src/editor/setup.ts`, `tests/e2e/editor.spec.ts`

**Interfaces:**

- Consumes: `Composition`·`compositionCommit`·`multiRangeIme`(`src/editor/ime.ts`), `zedKeymap`(`src/editor/setup.ts`), `window.ime`(`tests/e2e/pages/editor.ts`).
- Produces (`src/editor/ime.ts`): `Composition` gains `before: EditorSelection` and `startDoc: Text`; `undoRestores: StateField<readonly UndoRestore[]>` where `interface UndoRestore { doc: Text; selection: EditorSelection }`; `undoWithCursors: Command`; `multiRangeIme` includes the field.
- Produces (`src/editor/setup.ts`): `zedKeymap` binds `Mod-z` to `undoWithCursors` ahead of `historyKeymap`.

CodeMirror 의 기록은 조합의 첫 변경을 `input.type.compose.start` 로 새 묶음에 넣고, 그 묶음의 `startSelection` 은 첫 변경 트랜잭션의 시작 선택이다. 우리는 compositionstart 에서 선택을 주 범위 하나로 줄여 두므로 ⌘Z 는 커서 하나를 되살린다. 되돌린 뒤의 문서가 조합 전 문서와 같으면 조합 전 선택을 다시 놓는다 — 기록 자체는 건드리지 않는다(`transactionFilter` 는 기록의 되돌리기 트랜잭션에 돌지 않고, `transactionExtender` 는 선택을 바꾸지 못한다).

- [ ] **Step 1: 실패하는 테스트**

`src/editor/ime.test.ts` 에 더한다(파일 머리의 import 에 `undoRestores` 와 `EditorView` 는 필요 없다 — 순수 상태로 검사한다):

```ts
describe("undoRestores", () => {
  it("remembers the document and selection a composition started from", () => {
    const start = state("사과\n배\n귤", cursors(2, 4, 6));
    const current: Composition = {
      from: 2,
      taken: "",
      others: [EditorSelection.cursor(4), EditorSelection.cursor(6)],
      before: start.selection,
      startDoc: start.doc,
    };
    // After composing 가 at the main range only.
    const composed = state("사과가\n배\n귤", cursors(3));
    const tr = composed.update(compositionCommit(composed, current));
    const records = tr.state.field(undoRestores);
    expect(records).toHaveLength(1);
    expect(records[0].doc.toString()).toBe("사과\n배\n귤");
    expect(records[0].selection.ranges.map((r) => r.head)).toEqual([2, 4, 6]);
  });
});
```

위 `state()` 헬퍼는 `multiRangeIme` 을 확장으로 더해야 필드가 있다. 파일 위쪽의 `state` 헬퍼를 바꾼다:

```ts
const state = (doc: string, selection: EditorSelection) =>
  EditorState.create({
    doc,
    selection,
    extensions: [EditorState.allowMultipleSelections.of(true), multiRangeIme],
  });
```

import 에 `multiRangeIme`, `undoRestores` 를 더한다.

`tests/e2e/editor.spec.ts` 에 더한다:

```ts
test("⌘Z after a composition at three cursors brings the three cursors back", async ({ page }) => {
  await open(page, "사과\n배\n귤");
  await select(page, THREE, 1);
  await page.evaluate(() => window.ime.start());
  await page.evaluate(() => window.ime.update("ㄱ"));
  await page.evaluate(() => window.ime.update("가"));
  await page.evaluate(() => window.ime.end("replace"));
  expect(await text(page)).toBe("사과가\n배가\n귤가");
  await page.keyboard.press("Meta+z");
  expect(await text(page)).toBe("사과\n배\n귤");
  expect(await ranges(page)).toEqual(THREE);
  // A second ⌘Z with nothing left to undo keeps the document and the cursors.
  await page.keyboard.press("Meta+z");
  expect(await text(page)).toBe("사과\n배\n귤");
  expect(await ranges(page)).toEqual(THREE);
});

test("⌘Z after two compositions walks back one syllable at a time with every cursor", async ({
  page,
}) => {
  await open(page, "사과\n배\n귤");
  await select(page, THREE, 1);
  for (const syllable of ["가", "나"]) {
    await page.evaluate(() => window.ime.start());
    await page.evaluate((s) => window.ime.update(s), syllable);
    await page.evaluate(() => window.ime.end("replace"));
  }
  expect(await text(page)).toBe("사과가나\n배가나\n귤가나");
  await page.keyboard.press("Meta+z");
  expect(await text(page)).toBe("사과가\n배가\n귤가");
  expect(await ranges(page)).toEqual([
    [3, 3],
    [6, 6],
    [9, 9],
  ]);
  await page.keyboard.press("Meta+z");
  expect(await text(page)).toBe("사과\n배\n귤");
  expect(await ranges(page)).toEqual(THREE);
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test -- src/editor/ime.test.ts` 와 `pnpm test:e2e -- tests/e2e/editor.spec.ts`
Expected: Vitest 는 `undoRestores` 를 찾지 못해 FAIL, E2E 둘은 ⌘Z 뒤 `ranges` 가 `[[2, 2]]` 하나라 FAIL.

- [ ] **Step 3: 구현**

`src/editor/ime.ts` — `Composition` 에 필드 둘을 더하고, 기록 필드와 명령을 더한다.

```ts
export interface Composition {
  from: number;
  taken: string;
  others: readonly SelectionRange[];
  /** The whole selection before the composition — what ⌘Z brings back. */
  before: EditorSelection;
  /** The document before the composition; ⌘Z restores `before` only when it lands on it. */
  startDoc: Text;
}
```

(`Text` 를 `@codemirror/state` import 에 더한다.) `composition` 필드의 `update` 에서 값을 다시 만드는 자리를 `before`·`startDoc` 을 그대로 넘기도록 바꾼다:

```ts
return {
  from: tr.changes.mapPos(from, -1),
  taken,
  others: value.others.map((range) => range.map(tr.changes)),
  before: value.before,
  startDoc: value.startDoc,
};
```

`compositionstart` 관찰자의 효과에 둘을 넣는다:

```ts
      effects: startComposition.of({
        from: main.from,
        taken: "",
        others: ranges.filter((range) => range !== main),
        before: state.selection,
        startDoc: state.doc,
      }),
```

기록 필드와 명령(파일 끝, `multiRangeIme` 앞):

```ts
export interface UndoRestore {
  doc: Text;
  selection: EditorSelection;
}

const rememberBefore = StateEffect.define<UndoRestore>();
const UNDO_RESTORE_DEPTH = 50;

/** What each finished composition started from, newest last. CodeMirror's undo restores the
 * selection of the first change of a group, which is the collapsed main range; this is where the
 * full selection waits. Stays through later edits — an undo that still lands on the recorded
 * document (adjacent typing joined the group) is restored too; one that does not is left alone. */
export const undoRestores = StateField.define<readonly UndoRestore[]>({
  create: () => [],
  update(records, tr) {
    for (const effect of tr.effects) {
      if (effect.is(rememberBefore))
        records = [...records, effect.value].slice(-UNDO_RESTORE_DEPTH);
    }
    if (tr.isUserEvent("undo") && records.length) {
      const i = records.findLastIndex(
        (r) => r.doc.length === tr.newDoc.length && r.doc.eq(tr.newDoc),
      );
      if (i >= 0) records = records.slice(0, i);
    }
    return records;
  },
});

/** ⌘Z. Runs CodeMirror's undo, then puts the pre-composition selection back when the undo
 * brought the document to where a composition started. Two dispatches, because neither a
 * transaction filter (history skips filters) nor an extender (cannot set the selection) can do
 * it inside the undo transaction. */
export const undoWithCursors: Command = (view) => {
  const records = view.state.field(undoRestores, false) ?? [];
  const record = records.at(-1);
  if (!undo(view)) return false;
  if (!record) return true;
  const doc = view.state.doc;
  const match = records.findLast((r) => r.doc.length === doc.length && r.doc.eq(doc));
  if (match && !match.selection.eq(view.state.selection)) {
    view.dispatch({
      selection: match.selection,
      annotations: Transaction.addToHistory.of(false),
      userEvent: "select",
    });
  }
  return true;
};
```

`compositionCommit` 의 반환에 효과를 더한다:

```ts
    effects: [endComposition.of(null), rememberBefore.of({ doc: current.startDoc, selection: current.before })],
```

import 에 `Transaction`, `type Command`(from `@codemirror/view`), `undo`(from `@codemirror/commands`) 를 더한다. `multiRangeIme` 배열에 `undoRestores` 를 넣는다.

`src/editor/setup.ts` 의 `zedKeymap` 에 `{ key: "Mod-z", run: undoWithCursors, preventDefault: true }` 를 더하고 `undoWithCursors` 를 `./ime` 에서 import 한다. `zedKeymap` 이 `historyKeymap` 보다 앞에 있으므로 이것이 이긴다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm test -- src/editor` 와 `pnpm test:e2e -- tests/e2e/editor.spec.ts`
Expected: PASS(개수를 적는다). 이미 있던 조합 E2E 들도 그대로 PASS 여야 한다.

- [ ] **Step 5: 커밋**

```bash
pnpm exec oxfmt src/editor tests/e2e/editor.spec.ts
pnpm exec oxlint --fix src/editor tests/e2e/editor.spec.ts
git add src/editor/ime.ts src/editor/ime.test.ts src/editor/setup.ts tests/e2e/editor.spec.ts
git commit -m "feat(editor): bring every cursor back when ⌘Z undoes a composition"
```

---

### Task 3: Rust `extensions` — JSONC, 매니페스트, 스캔, 레지스트리, 설정 필드

**Files:**

- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/appdata.rs`
- Create: `src-tauri/src/extensions/mod.rs`, `src-tauri/src/extensions/jsonc.rs`, `src-tauri/src/extensions/manifest.rs`, `src-tauri/src/extensions/registry.rs`
- Create (픽스처): `src-tauri/fixtures/vsix-src/extension.vsixmanifest`, `src-tauri/fixtures/vsix-src/[Content_Types].xml`, `src-tauri/fixtures/vsix-src/extension/package.json`, `src-tauri/fixtures/vsix-src/extension/themes/night-color-theme.json`, `src-tauri/fixtures/vsix-src/extension/syntaxes/tote.tmLanguage.json`, `src-tauri/fixtures/vsix-src/extension/language-configuration.json`, `src-tauri/fixtures/vsix-src/extension/viewer.html`, `src-tauri/fixtures/tote-test-theme-0.0.1.vsix`

**Interfaces:**

- Consumes: `read_json`·`write_json`(`crate::persist`), `Settings`(`crate::appdata`).
- Produces (`crate::extensions::jsonc`): `strip_jsonc(text: &str) -> String`.
- Produces (`crate::extensions::manifest`): `Manifest { publisher, name, version, display_name: String, languages: Vec<LanguageContribution>, grammars: Vec<GrammarContribution>, themes: Vec<ThemeContribution>, viewers: Vec<ViewerContribution> }`, `Manifest::parse(text: &str) -> Result<Manifest, ManifestError>`, `Manifest::id(&self) -> String`, `ManifestError { Json(String), Missing(&'static str), BadId(String), BadPath(String) }`, `ViewerKind { Primary, Preview }`, `relative_path(raw: &str) -> Result<String, ManifestError>`.
- Produces (`crate::extensions`): `ExtensionStore::new(bundled_dir: PathBuf, user_dir: PathBuf)`, `ExtensionStore::scan(&self) -> Scan { extensions: Vec<Installed>, problems: Vec<ExtensionProblem> }`, `Installed { manifest: Manifest, path: PathBuf, source: Source }`, `Source { Bundled, User }`, `ExtensionProblem { path: PathBuf, message: String }`, `file_inside(root: &Path, relative: &str) -> Option<PathBuf>`.
- Produces (`crate::extensions::registry`): `build(scan: &Scan, settings: &ExtensionSettings) -> Registry`, `Registry { extensions: Vec<ExtensionSummary>, languages: Vec<LanguageInfo>, grammars: Vec<GrammarRef>, themes: Vec<ThemeInfo>, viewers: Vec<ViewerInfo>, problems: Vec<ExtensionProblem> }`(전부 `Serialize + Clone`, camelCase), `LanguageInfo { id, extension, aliases, extensions, filenames, first_line, configuration, grammar: Option<GrammarInfo> }`, `GrammarInfo { scope_name, path, embedded_languages: BTreeMap<String, String> }`, `GrammarRef { extension, language: Option<String>, scope_name, path, embedded_languages }`(활성 확장의 모든 문법 — 언어가 없는 include 전용 문법 포함 — 우선순위 순), `ThemeInfo { extension, label, ui_theme, path }`, `ViewerInfo { extension, id, kind, extensions, entry }`, `ExtensionSummary { id, version, display_name, source, enabled, path }`.
- Produces (`crate::appdata`): `Settings` gains `theme: ThemeSettings { light: Option<ThemeRef>, dark: Option<ThemeRef> }`, `extensions: ExtensionSettings { disabled: Vec<String>, precedence: Precedence }`, `Precedence { User (기본), Bundled }`, `ThemeRef { extension: String, label: String }`, `Settings::save(&self, path: &Path) -> io::Result<()>`.

- [ ] **Step 1: 의존성과 픽스처**

`src-tauri/Cargo.toml` 의 `[dependencies]` 에 더한다(.vsix 는 deflate 로만 눌려 있다. 기본 기능의 AES·bzip2·lzma 는 쓸 일이 없다):

```toml
zip = { version = "9", default-features = false, features = ["deflate"] }
```

픽스처 소스. `src-tauri/fixtures/vsix-src/extension/package.json`(VS Code 확장의 꼴 그대로 — `main`·`activationEvents` 는 무시돼야 한다):

```json
{
  "name": "test-theme",
  "publisher": "tote-test",
  "version": "0.0.1",
  "displayName": "Tote Test Theme",
  "engines": { "vscode": "^1.80.0" },
  "main": "./out/extension.js",
  "activationEvents": ["*"],
  "contributes": {
    "themes": [
      { "label": "Tote Night", "uiTheme": "vs-dark", "path": "./themes/night-color-theme.json" }
    ],
    "languages": [
      {
        "id": "totelang",
        "aliases": ["Tote Lang"],
        "extensions": [".tote", ".TOTE"],
        "filenames": ["Totefile"],
        "firstLine": "^#!.*\\btote\\b",
        "configuration": "./language-configuration.json"
      }
    ],
    "grammars": [
      {
        "language": "totelang",
        "scopeName": "source.tote",
        "path": "./syntaxes/tote.tmLanguage.json",
        "embeddedLanguages": { "meta.embedded.block.json": "json" }
      }
    ]
  },
  "tote": {
    "viewers": [
      { "id": "tote-view", "kind": "primary", "extensions": ["tote"], "entry": "viewer.html" }
    ]
  }
}
```

`src-tauri/fixtures/vsix-src/extension/themes/night-color-theme.json`(주석과 끝 쉼표가 있는 JSONC — 실제 VS Code 테마가 그렇다):

```jsonc
{
  // A tiny theme for the tests. Comments and trailing commas are what real themes carry.
  "name": "Tote Night",
  "type": "dark",
  "colors": {
    "editor.background": "#101010",
    "editor.foreground": "#f0f0f0",
    "sideBar.background": "#181818",
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#808080", "fontStyle": "italic" } },
    { "scope": ["keyword", "storage"], "settings": { "foreground": "#ff9966" } },
  ],
}
```

`src-tauri/fixtures/vsix-src/extension/syntaxes/tote.tmLanguage.json`:

```json
{
  "name": "Tote Lang",
  "scopeName": "source.tote",
  "patterns": [{ "include": "#comment" }, { "include": "#keyword" }, { "include": "#string" }],
  "repository": {
    "comment": { "match": "#.*$", "name": "comment.line.number-sign.tote" },
    "keyword": { "match": "\\b(let|fn|return)\\b", "name": "keyword.control.tote" },
    "string": {
      "begin": "\"",
      "end": "\"",
      "name": "string.quoted.double.tote",
      "patterns": [{ "match": "\\\\.", "name": "constant.character.escape.tote" }]
    }
  }
}
```

`src-tauri/fixtures/vsix-src/extension/language-configuration.json`:

```jsonc
{
  "comments": { "lineComment": "#" },
  "brackets": [
    ["(", ")"],
    ["[", "]"],
  ],
  "autoClosingPairs": [
    { "open": "(", "close": ")" },
    { "open": "\"", "close": "\"", "notIn": ["string"] },
  ],
  "wordPattern": "[A-Za-z0-9_$-]+",
}
```

`src-tauri/fixtures/vsix-src/extension/viewer.html`: `<!doctype html><title>tote-view</title>`

`src-tauri/fixtures/vsix-src/extension.vsixmanifest`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="test-theme" Version="0.0.1" Publisher="tote-test" />
    <DisplayName>Tote Test Theme</DisplayName>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
```

`src-tauri/fixtures/vsix-src/[Content_Types].xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".html" ContentType="text/html" />
</Types>
```

.vsix 는 `vsce` 가 만드는 것과 같은 평범한 zip 이다(루트에 `extension.vsixmanifest`·`[Content_Types].xml`, 확장 본체는 `extension/` 아래). 만든다:

```bash
(cd src-tauri/fixtures/vsix-src && rm -f ../tote-test-theme-0.0.1.vsix && zip -X -r ../tote-test-theme-0.0.1.vsix 'extension.vsixmanifest' '[Content_Types].xml' extension)
unzip -l src-tauri/fixtures/tote-test-theme-0.0.1.vsix
```

Expected: 목록에 `extension/package.json`, `extension/themes/night-color-theme.json`, `extension/syntaxes/tote.tmLanguage.json`, `extension/language-configuration.json`, `extension/viewer.html` 가 있다. `-X` 는 확장 속성을 빼 플랫폼마다 같은 바이트를 만든다.

- [ ] **Step 2: 실패하는 테스트**

`src-tauri/src/extensions/jsonc.rs` 의 테스트:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_and_trailing_commas_go_and_strings_stay() {
        let text = r#"{
  // line comment with "quotes" and a trailing comma, inside
  "a": "// not a comment, /* nor this */",
  "b": [1, 2, /* in-line */ 3,],
  "c": "escaped \" quote, still a string", /* block
  comment */
}"#;
        let value: serde_json::Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(value["a"], "// not a comment, /* nor this */");
        assert_eq!(value["b"], serde_json::json!([1, 2, 3]));
        assert_eq!(value["c"], "escaped \" quote, still a string");
    }

    #[test]
    fn a_comma_before_a_comment_before_a_closing_bracket_is_trailing() {
        let value: serde_json::Value =
            serde_json::from_str(&strip_jsonc("[1, // last\n]")).unwrap();
        assert_eq!(value, serde_json::json!([1]));
    }

    #[test]
    fn plain_json_passes_through_unchanged() {
        let text = r#"{"a": [1, 2], "b": "x/y"}"#;
        assert_eq!(strip_jsonc(text), text);
    }

    #[test]
    fn korean_in_comments_and_strings_survives() {
        let value: serde_json::Value =
            serde_json::from_str(&strip_jsonc("{\"이름\": \"메모\" /* 주석 */}")).unwrap();
        assert_eq!(value["이름"], "메모");
    }
}
```

`src-tauri/src/extensions/manifest.rs` 의 테스트(.vsix 픽스처를 zip 으로 열어 매니페스트를 읽는다 — 스펙 「테스트」 의 「실제 .vsix 를 픽스처로」):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    pub(crate) fn fixture_vsix() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/tote-test-theme-0.0.1.vsix")
    }

    fn fixture_manifest() -> String {
        let file = std::fs::File::open(fixture_vsix()).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut entry = zip.by_name("extension/package.json").unwrap();
        let mut text = String::new();
        entry.read_to_string(&mut text).unwrap();
        text
    }

    #[test]
    fn parses_the_fixture_vsix_manifest() {
        let manifest = Manifest::parse(&fixture_manifest()).unwrap();
        assert_eq!(manifest.id(), "tote-test.test-theme");
        assert_eq!(manifest.version, "0.0.1");
        assert_eq!(manifest.display_name, "Tote Test Theme");
        assert_eq!(manifest.themes.len(), 1);
        assert_eq!(manifest.themes[0].label, "Tote Night");
        assert_eq!(manifest.themes[0].ui_theme, "vs-dark");
        assert_eq!(manifest.themes[0].path, "themes/night-color-theme.json");
        let lang = &manifest.languages[0];
        assert_eq!(lang.id, "totelang");
        assert_eq!(lang.extensions, vec!["tote"]); // dots dropped, lower-cased, deduplicated
        assert_eq!(lang.filenames, vec!["Totefile"]);
        assert_eq!(lang.first_line.as_deref(), Some("^#!.*\\btote\\b"));
        assert_eq!(lang.configuration.as_deref(), Some("language-configuration.json"));
        let grammar = &manifest.grammars[0];
        assert_eq!(grammar.language.as_deref(), Some("totelang"));
        assert_eq!(grammar.scope_name, "source.tote");
        assert_eq!(grammar.path, "syntaxes/tote.tmLanguage.json");
        assert_eq!(
            grammar.embedded_languages.get("meta.embedded.block.json").map(String::as_str),
            Some("json")
        );
        let viewer = &manifest.viewers[0];
        assert_eq!((viewer.id.as_str(), viewer.kind), ("tote-view", ViewerKind::Primary));
        assert_eq!(viewer.extensions, vec!["tote"]);
        assert_eq!(viewer.entry, "viewer.html");
    }

    #[test]
    fn a_manifest_without_contributions_is_still_an_extension() {
        let manifest =
            Manifest::parse(r#"{"name": "empty", "publisher": "p", "version": "1.0.0"}"#).unwrap();
        assert_eq!(manifest.id(), "p.empty");
        assert_eq!(manifest.display_name, "empty");
        assert!(manifest.languages.is_empty() && manifest.themes.is_empty());
    }

    #[test]
    fn missing_or_bad_identity_is_an_error() {
        assert!(matches!(
            Manifest::parse(r#"{"publisher": "p", "version": "1"}"#),
            Err(ManifestError::Missing("name"))
        ));
        assert!(matches!(
            Manifest::parse(r#"{"name": "x", "version": "1"}"#),
            Err(ManifestError::Missing("publisher"))
        ));
        assert!(matches!(
            Manifest::parse(r#"{"name": "x", "publisher": "p"}"#),
            Err(ManifestError::Missing("version"))
        ));
        assert!(matches!(
            Manifest::parse(r#"{"name": "a b", "publisher": "p", "version": "1"}"#),
            Err(ManifestError::BadId(_))
        ));
        assert!(matches!(Manifest::parse("{ nope"), Err(ManifestError::Json(_))));
    }

    #[test]
    fn contribution_paths_must_stay_inside_the_extension() {
        for bad in ["../x.json", "/etc/x.json", "a/../../x.json", "", "a\\b.json"] {
            let text = format!(
                r#"{{"name": "x", "publisher": "p", "version": "1",
                    "contributes": {{"themes": [{{"label": "t", "uiTheme": "vs", "path": "{bad}"}}]}}}}"#
            );
            assert!(matches!(Manifest::parse(&text), Err(ManifestError::BadPath(_))), "{bad:?}");
        }
        assert_eq!(relative_path("./a/./b.json").unwrap(), "a/b.json");
    }

    #[test]
    fn a_viewer_with_an_unknown_kind_is_an_error() {
        let text = r#"{"name": "x", "publisher": "p", "version": "1",
            "tote": {"viewers": [{"id": "v", "kind": "window", "extensions": ["a"], "entry": "v.html"}]}}"#;
        assert!(matches!(Manifest::parse(text), Err(ManifestError::Json(_))));
    }

    #[test]
    fn manifests_may_carry_comments() {
        let manifest = Manifest::parse(
            "{\n  // generated\n  \"name\": \"c\", \"publisher\": \"p\", \"version\": \"1\",\n}",
        )
        .unwrap();
        assert_eq!(manifest.id(), "p.c");
    }
}
```

`src-tauri/src/extensions/mod.rs` 의 테스트:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    pub(crate) fn write_extension(dir: &Path, folder: &str, manifest: &str) -> PathBuf {
        let path = dir.join(folder);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("package.json"), manifest).unwrap();
        path
    }

    const THEME_EXT: &str = r#"{"name": "night", "publisher": "someone", "version": "2.0.0",
        "contributes": {"themes": [{"label": "Night", "uiTheme": "vs-dark", "path": "t.json"}]}}"#;

    #[test]
    fn scan_lists_both_folders_and_reports_broken_manifests() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("bundled");
        let user = dir.path().join("user");
        write_extension(&bundled, "tote.themes", r#"{"name": "themes", "publisher": "tote", "version": "1.0.0"}"#);
        write_extension(&user, "someone.night@2.0.0", THEME_EXT);
        write_extension(&user, "broken@1", "{ not json");
        write_extension(&user, "nameless@1", r#"{"publisher": "p", "version": "1"}"#);
        fs::create_dir_all(user.join("no-manifest")).unwrap();
        fs::create_dir_all(user.join(".staging-123")).unwrap();
        fs::write(user.join("stray.txt"), "").unwrap();

        let scan = ExtensionStore::new(bundled, user.clone()).scan();
        let ids: Vec<(String, Source)> = scan
            .extensions
            .iter()
            .map(|e| (e.manifest.id(), e.source))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("tote.themes".to_string(), Source::Bundled),
                ("someone.night".to_string(), Source::User)
            ]
        );
        let mut problems: Vec<&Path> = scan.problems.iter().map(|p| p.path.as_path()).collect();
        problems.sort();
        assert_eq!(problems, vec![user.join("broken@1").as_path(), user.join("nameless@1").as_path()]);
        assert!(scan.problems.iter().all(|p| !p.message.is_empty()));
    }

    #[test]
    fn a_missing_folder_scans_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let scan = ExtensionStore::new(dir.path().join("none"), dir.path().join("none2")).scan();
        assert!(scan.extensions.is_empty() && scan.problems.is_empty());
    }

    #[test]
    fn two_user_copies_of_one_id_keep_the_first_and_report_the_other() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user");
        write_extension(&user, "someone.night@1.0.0", THEME_EXT);
        write_extension(&user, "someone.night@2.0.0", THEME_EXT);
        let scan = ExtensionStore::new(dir.path().join("bundled"), user.clone()).scan();
        assert_eq!(scan.extensions.len(), 1);
        assert_eq!(scan.extensions[0].path, user.join("someone.night@1.0.0"));
        assert_eq!(scan.problems.len(), 1);
        assert!(scan.problems[0].message.contains("someone.night"));
    }

    #[test]
    fn file_inside_refuses_escapes_and_links_out() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ext");
        fs::create_dir_all(root.join("themes")).unwrap();
        fs::write(root.join("themes/a.json"), "{}").unwrap();
        fs::write(dir.path().join("secret.json"), "{}").unwrap();
        assert_eq!(
            file_inside(&root, "themes/a.json"),
            Some(root.join("themes/a.json").canonicalize().unwrap())
        );
        assert_eq!(file_inside(&root, "./themes/a.json").is_some(), true);
        for bad in ["../secret.json", "/etc/passwd", "themes/../../secret.json", "", "missing.json"] {
            assert_eq!(file_inside(&root, bad), None, "{bad:?}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret.json"), root.join("link.json")).unwrap();
            assert_eq!(file_inside(&root, "link.json"), None);
        }
    }
}
```

`src-tauri/src/extensions/registry.rs` 의 테스트:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::appdata::Precedence;
    use crate::extensions::manifest::Manifest;
    use crate::extensions::{Installed, Scan, Source};

    fn installed(source: Source, json: &str) -> Installed {
        let manifest = Manifest::parse(json).unwrap();
        Installed {
            path: std::path::PathBuf::from(format!("/ext/{}", manifest.id())),
            manifest,
            source,
        }
    }

    const BUNDLED: &str = r#"{"name": "languages", "publisher": "tote", "version": "1.0.0",
        "contributes": {
          "languages": [{"id": "markdown", "extensions": [".md"]}, {"id": "python", "extensions": [".py"]}],
          "grammars": [{"language": "markdown", "scopeName": "text.html.markdown", "path": "g/md.json"}]
        },
        "tote": {"viewers": [{"id": "media", "kind": "primary", "extensions": ["png"], "entry": "v.html"}]}}"#;
    const USER: &str = r#"{"name": "better-md", "publisher": "someone", "version": "3.1.0",
        "contributes": {
          "languages": [{"id": "markdown", "extensions": [".md", ".mdx"]}],
          "grammars": [{"language": "markdown", "scopeName": "text.html.markdown.better", "path": "md.json"}],
          "themes": [{"label": "Night", "uiTheme": "vs-dark", "path": "night.json"}]
        },
        "tote": {"viewers": [{"id": "evil", "kind": "primary", "extensions": ["png"], "entry": "e.html"}]}}"#;

    fn scan() -> Scan {
        Scan {
            extensions: vec![installed(Source::Bundled, BUNDLED), installed(Source::User, USER)],
            problems: vec![],
        }
    }

    #[test]
    fn user_languages_come_first_unless_precedence_is_bundled() {
        let registry = build(&scan(), &ExtensionSettings::default());
        let order: Vec<&str> = registry.languages.iter().map(|l| l.extension.as_str()).collect();
        assert_eq!(order, vec!["someone.better-md", "tote.languages", "tote.languages"]);
        assert_eq!(registry.languages[0].grammar.as_ref().unwrap().scope_name, "text.html.markdown.better");
        let settings = ExtensionSettings {
            disabled: vec![],
            precedence: Precedence::Bundled,
        };
        let registry = build(&scan(), &settings);
        let order: Vec<&str> = registry.languages.iter().map(|l| l.extension.as_str()).collect();
        assert_eq!(order, vec!["tote.languages", "tote.languages", "someone.better-md"]);
    }

    #[test]
    fn a_disabled_user_extension_contributes_nothing_and_a_bundled_one_cannot_be_disabled() {
        let settings = ExtensionSettings {
            disabled: vec!["someone.better-md".into(), "tote.languages".into()],
            precedence: Precedence::User,
        };
        let registry = build(&scan(), &settings);
        assert_eq!(registry.languages.len(), 2);
        assert!(registry.themes.is_empty());
        let summary: Vec<(&str, bool)> = registry.extensions.iter().map(|e| (e.id.as_str(), e.enabled)).collect();
        assert_eq!(summary, vec![("tote.languages", true), ("someone.better-md", false)]);
    }

    #[test]
    fn viewers_come_from_bundled_extensions_only() {
        let registry = build(&scan(), &ExtensionSettings::default());
        let ids: Vec<&str> = registry.viewers.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, vec!["media"]);
        assert_eq!(registry.viewers[0].extension, "tote.languages");
        let scopes: Vec<&str> = registry.grammars.iter().map(|g| g.scope_name.as_str()).collect();
        assert_eq!(scopes, vec!["text.html.markdown.better", "text.html.markdown"]);
    }

    #[test]
    fn a_language_without_a_grammar_and_problems_are_carried() {
        let mut scan = scan();
        scan.problems.push(crate::extensions::ExtensionProblem {
            path: "/ext/broken".into(),
            message: "no name".into(),
        });
        let registry = build(&scan, &ExtensionSettings::default());
        let python = registry.languages.iter().find(|l| l.id == "python").unwrap();
        assert!(python.grammar.is_none());
        assert_eq!(registry.problems.len(), 1);
        let json = serde_json::to_value(&registry).unwrap();
        assert_eq!(json["languages"][0]["firstLine"], serde_json::Value::Null);
        assert_eq!(json["extensions"][0]["displayName"], "languages");
        assert_eq!(json["viewers"][0]["kind"], "primary");
    }
}
```

`src-tauri/src/appdata.rs` 의 테스트 — 기존 `settings_are_read_from_camel_case_json` 의 JSON 에서 `"theme": "later"` 를 `"unknown": "later"` 로 바꾸고(이제 `theme` 는 객체다), 더한다:

```rust
    #[test]
    fn settings_round_trip_theme_and_extension_fields() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let settings = Settings {
            workspace_root: None,
            theme: ThemeSettings {
                light: Some(ThemeRef {
                    extension: "tote.themes".into(),
                    label: "Light+".into(),
                }),
                dark: None,
            },
            extensions: ExtensionSettings {
                disabled: vec!["someone.ext".into()],
                precedence: Precedence::Bundled,
            },
        };
        settings.save(&file).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"precedence\": \"bundled\""));
        assert!(text.contains("\"dark\": null"));
        assert!(!text.contains("workspaceRoot"));
        assert_eq!(Settings::load(&file).unwrap(), settings);
        assert_eq!(Settings::load(&dir.path().join("none.json")).unwrap(), Settings::default());
        assert_eq!(Settings::default().extensions.precedence, Precedence::User);
    }
```

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml extensions` 와 `cargo test --manifest-path src-tauri/Cargo.toml appdata`
Expected: 컴파일 오류(모듈·타입 없음).

- [ ] **Step 4: 구현 — 설정 필드**

`src-tauri/src/appdata.rs` 의 `Settings` 를 바꾼다:

```rust
/// `settings.json`. Unknown fields are ignored on read, so a newer build's file still opens.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<PathBuf>,
    #[serde(default)]
    pub theme: ThemeSettings,
    #[serde(default)]
    pub extensions: ExtensionSettings,
}

/// Which theme to use under each OS appearance (spec 「테마」). `None` means the bundled default.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ThemeSettings {
    #[serde(default)]
    pub light: Option<ThemeRef>,
    #[serde(default)]
    pub dark: Option<ThemeRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThemeRef {
    pub extension: String,
    pub label: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSettings {
    /// IDs of user-installed extensions switched off; bundled ones cannot be.
    #[serde(default)]
    pub disabled: Vec<String>,
    /// Which side wins when two extensions claim one file extension (spec 「설치와 로딩」).
    #[serde(default)]
    pub precedence: Precedence,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Precedence {
    #[default]
    User,
    Bundled,
}

impl Settings {
    pub fn load(path: &Path) -> io::Result<Settings> {
        Ok(read_json(path)?.unwrap_or_default())
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        write_json(path, self)
    }
    // workspace_root / workspace_root_with_home stay as they are.
}
```

- [ ] **Step 5: 구현 — `jsonc.rs`**

`src-tauri/src/extensions/jsonc.rs`:

```rust
//! VS Code's manifests, themes and language configurations are JSONC: JSON with `//` and `/* */`
//! comments and trailing commas. `serde_json` takes neither, so they are removed first. The
//! frontend's src/core/jsonc.ts applies the same rules to the files it reads itself.

/// `text` with comments removed and trailing commas dropped; strings are left as they are. Only
/// ASCII bytes are ever removed, so the result is still UTF-8.
pub fn strip_jsonc(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                out.push(b'"');
                i += 1;
                while i < bytes.len() {
                    let c = bytes[i];
                    out.push(c);
                    i += 1;
                    if c == b'\\' && i < bytes.len() {
                        out.push(bytes[i]);
                        i += 1;
                    } else if c == b'"' {
                        break;
                    }
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => i = line_comment_end(bytes, i),
            b'/' if bytes.get(i + 1) == Some(&b'*') => i = block_comment_end(bytes, i),
            b',' => {
                let next = next_significant(bytes, i + 1);
                if matches!(bytes.get(next), Some(b'}') | Some(b']')) {
                    i += 1; // drop the comma; the loop still removes any comment after it
                } else {
                    out.push(b',');
                    i += 1;
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8(out).expect("only ASCII bytes were removed from valid UTF-8")
}

fn line_comment_end(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i] != b'\n' {
        i += 1;
    }
    i
}

fn block_comment_end(bytes: &[u8], mut i: usize) -> usize {
    i += 2;
    while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
        i += 1;
    }
    (i + 2).min(bytes.len())
}

/// The index of the next byte that is neither whitespace nor part of a comment.
fn next_significant(bytes: &[u8], mut i: usize) -> usize {
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes[i..].starts_with(b"//") {
            i = line_comment_end(bytes, i);
        } else if bytes[i..].starts_with(b"/*") {
            i = block_comment_end(bytes, i);
        } else {
            return i;
        }
    }
}
```

- [ ] **Step 6: 구현 — `manifest.rs`**

`src-tauri/src/extensions/manifest.rs`:

```rust
//! A VS Code `package.json` reduced to what tote uses (spec 「패키지 형식」): identity, the
//! declarative contributions, and tote's own `tote.viewers`. `main`, `browser` and
//! `activationEvents` are never read — extensions do not run code here.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::jsonc::strip_jsonc;

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("package.json is not JSON: {0}")]
    Json(String),
    #[error("package.json has no {0}")]
    Missing(&'static str),
    #[error("not a usable extension id: {0}")]
    BadId(String),
    #[error("a contribution path must stay inside the extension: {0}")]
    BadPath(String),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageContribution {
    pub id: String,
    pub aliases: Vec<String>,
    /// Lower-case, without the leading dot, deduplicated.
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
    pub first_line: Option<String>,
    pub configuration: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrammarContribution {
    pub language: Option<String>,
    pub scope_name: String,
    pub path: String,
    pub embedded_languages: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeContribution {
    pub label: String,
    pub ui_theme: String,
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewerKind {
    Primary,
    Preview,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerContribution {
    pub id: String,
    pub kind: ViewerKind,
    pub extensions: Vec<String>,
    pub entry: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub publisher: String,
    pub name: String,
    pub version: String,
    pub display_name: String,
    pub languages: Vec<LanguageContribution>,
    pub grammars: Vec<GrammarContribution>,
    pub themes: Vec<ThemeContribution>,
    pub viewers: Vec<ViewerContribution>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    publisher: Option<String>,
    name: Option<String>,
    version: Option<String>,
    display_name: Option<String>,
    #[serde(default)]
    contributes: RawContributes,
    #[serde(default)]
    tote: RawTote,
}

#[derive(Default, Deserialize)]
struct RawContributes {
    #[serde(default)]
    languages: Vec<RawLanguage>,
    #[serde(default)]
    grammars: Vec<RawGrammar>,
    #[serde(default)]
    themes: Vec<RawTheme>,
}

#[derive(Default, Deserialize)]
struct RawTote {
    #[serde(default)]
    viewers: Vec<RawViewer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLanguage {
    id: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    filenames: Vec<String>,
    first_line: Option<String>,
    configuration: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGrammar {
    language: Option<String>,
    scope_name: String,
    path: String,
    #[serde(default)]
    embedded_languages: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTheme {
    label: String,
    #[serde(default = "default_ui_theme")]
    ui_theme: String,
    path: String,
}

fn default_ui_theme() -> String {
    "vs-dark".into()
}

#[derive(Deserialize)]
struct RawViewer {
    id: String,
    kind: ViewerKind,
    #[serde(default)]
    extensions: Vec<String>,
    entry: String,
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Manifest, ManifestError> {
        let raw: Raw = serde_json::from_str(&strip_jsonc(text))
            .map_err(|err| ManifestError::Json(err.to_string()))?;
        let name = raw.name.ok_or(ManifestError::Missing("name"))?;
        let publisher = raw.publisher.ok_or(ManifestError::Missing("publisher"))?;
        let version = raw.version.ok_or(ManifestError::Missing("version"))?;
        for part in [&name, &publisher] {
            if !is_identifier(part) {
                return Err(ManifestError::BadId(part.clone()));
            }
        }
        if version.trim().is_empty() {
            return Err(ManifestError::Missing("version"));
        }
        let languages = raw
            .contributes
            .languages
            .into_iter()
            .map(|l| {
                Ok(LanguageContribution {
                    id: l.id,
                    aliases: l.aliases,
                    extensions: normalise_extensions(&l.extensions),
                    filenames: l.filenames,
                    first_line: l.first_line,
                    configuration: l.configuration.map(|p| relative_path(&p)).transpose()?,
                })
            })
            .collect::<Result<_, ManifestError>>()?;
        let grammars = raw
            .contributes
            .grammars
            .into_iter()
            .map(|g| {
                Ok(GrammarContribution {
                    language: g.language,
                    scope_name: g.scope_name,
                    path: relative_path(&g.path)?,
                    embedded_languages: g.embedded_languages,
                })
            })
            .collect::<Result<_, ManifestError>>()?;
        let themes = raw
            .contributes
            .themes
            .into_iter()
            .map(|t| {
                Ok(ThemeContribution {
                    label: t.label,
                    ui_theme: t.ui_theme,
                    path: relative_path(&t.path)?,
                })
            })
            .collect::<Result<_, ManifestError>>()?;
        let viewers = raw
            .tote
            .viewers
            .into_iter()
            .map(|v| {
                Ok(ViewerContribution {
                    id: v.id,
                    kind: v.kind,
                    extensions: normalise_extensions(&v.extensions),
                    entry: relative_path(&v.entry)?,
                })
            })
            .collect::<Result<_, ManifestError>>()?;
        Ok(Manifest {
            display_name: raw.display_name.unwrap_or_else(|| name.clone()),
            publisher,
            name,
            version,
            languages,
            grammars,
            themes,
            viewers,
        })
    }

    pub fn id(&self) -> String {
        format!("{}.{}", self.publisher, self.name)
    }
}

/// What VS Code accepts for `name` and `publisher`: letters, digits, `-` and `_`.
fn is_identifier(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn normalise_extensions(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for ext in raw {
        let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
        if !ext.is_empty() && !out.contains(&ext) {
            out.push(ext);
        }
    }
    out
}

/// A contribution path as a clean relative path: `./` dropped, `.` segments dropped; empty,
/// absolute, `..` and backslashes are refused — the path is joined under the extension folder
/// and must never leave it.
pub fn relative_path(raw: &str) -> Result<String, ManifestError> {
    if raw.contains('\\') || raw.starts_with('/') {
        return Err(ManifestError::BadPath(raw.to_string()));
    }
    let parts: Vec<&str> = raw.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.is_empty() || parts.iter().any(|p| *p == "..") {
        return Err(ManifestError::BadPath(raw.to_string()));
    }
    Ok(parts.join("/"))
}
```

- [ ] **Step 7: 구현 — `mod.rs`(스캔)와 `registry.rs`**

`src-tauri/src/extensions/mod.rs`:

```rust
//! Extensions as installed on disk (spec 「확장 구조」): the bundled ones inside the app bundle
//! (read-only) and the ones the person installed under the app data folder. Scanning reads
//! every manifest; a broken one is reported, never fatal — the app starts regardless.

pub mod install;
pub mod jsonc;
pub mod manifest;
pub mod registry;

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use manifest::Manifest;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Bundled,
    User,
}

#[derive(Clone, Debug)]
pub struct Installed {
    pub manifest: Manifest,
    pub path: PathBuf,
    pub source: Source,
}

/// A folder that could not be used as an extension, for the settings screen.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionProblem {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Clone, Debug, Default)]
pub struct Scan {
    pub extensions: Vec<Installed>,
    pub problems: Vec<ExtensionProblem>,
}

pub struct ExtensionStore {
    bundled_dir: PathBuf,
    user_dir: PathBuf,
}

impl ExtensionStore {
    pub fn new(bundled_dir: PathBuf, user_dir: PathBuf) -> ExtensionStore {
        ExtensionStore {
            bundled_dir,
            user_dir,
        }
    }

    pub fn user_dir(&self) -> &Path {
        &self.user_dir
    }

    /// Bundled extensions first, then user ones, each folder in name order. A user folder whose
    /// id a listed extension already has is reported and skipped: two copies would fight over
    /// the same file extensions.
    pub fn scan(&self) -> Scan {
        let mut scan = Scan::default();
        read_folder(&self.bundled_dir, Source::Bundled, &mut scan);
        read_folder(&self.user_dir, Source::User, &mut scan);
        scan
    }

    pub fn find(&self, id: &str) -> Option<Installed> {
        self.scan()
            .extensions
            .into_iter()
            .find(|e| e.manifest.id() == id)
    }
}

fn read_folder(dir: &Path, source: Source, scan: &mut Scan) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut folders: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| !n.starts_with('.'))
        })
        .collect();
    folders.sort();
    for path in folders {
        let file = path.join("package.json");
        if !file.is_file() {
            continue;
        }
        let parsed = fs::read_to_string(&file)
            .map_err(|err| err.to_string())
            .and_then(|text| Manifest::parse(&text).map_err(|err| err.to_string()));
        match parsed {
            Ok(manifest) => {
                let id = manifest.id();
                if scan.extensions.iter().any(|e| e.manifest.id() == id) {
                    scan.problems.push(ExtensionProblem {
                        path,
                        message: format!("{id} 는 이미 다른 폴더에 설치돼 있습니다"),
                    });
                } else {
                    scan.extensions.push(Installed {
                        manifest,
                        path,
                        source,
                    });
                }
            }
            Err(message) => scan.problems.push(ExtensionProblem { path, message }),
        }
    }
}

/// The file `relative` names inside `root`, or `None` when it does not exist, leaves `root`
/// (`..`, an absolute path, a symlink pointing out) or is not a regular file. Everything that
/// serves an extension's files goes through here.
pub fn file_inside(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = manifest::relative_path(relative).ok()?;
    let root = fs::canonicalize(root).ok()?;
    let file = fs::canonicalize(root.join(relative)).ok()?;
    (file.starts_with(&root) && file.is_file()).then_some(file)
}
```

`install.rs` 는 Task 4 가 만든다. 이 태스크에서는 컴파일이 되도록 빈 파일로 둔다:

```rust
//! Installing, replacing and removing user extensions (Task 4).
```

`src-tauri/src/extensions/registry.rs`:

```rust
//! What the frontend receives (spec 「설치와 로딩」): every language, theme and viewer of the
//! enabled extensions, ordered so the first match wins — user extensions before bundled ones
//! unless the precedence setting says otherwise. Viewers come from bundled extensions only.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;

use super::manifest::ViewerKind;
use super::{ExtensionProblem, Scan, Source};
use crate::appdata::{ExtensionSettings, Precedence};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub extensions: Vec<ExtensionSummary>,
    pub languages: Vec<LanguageInfo>,
    /// Every grammar of the enabled extensions, including ones no language names (they exist
    /// for `include`), in the same precedence order.
    pub grammars: Vec<GrammarRef>,
    pub themes: Vec<ThemeInfo>,
    pub viewers: Vec<ViewerInfo>,
    pub problems: Vec<ExtensionProblem>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrammarRef {
    pub extension: String,
    pub language: Option<String>,
    pub scope_name: String,
    pub path: String,
    pub embedded_languages: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSummary {
    pub id: String,
    pub version: String,
    pub display_name: String,
    pub source: Source,
    pub enabled: bool,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInfo {
    pub id: String,
    /// The id of the extension contributing it.
    pub extension: String,
    pub aliases: Vec<String>,
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
    pub first_line: Option<String>,
    pub configuration: Option<String>,
    pub grammar: Option<GrammarInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrammarInfo {
    pub scope_name: String,
    pub path: String,
    pub embedded_languages: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    pub extension: String,
    pub label: String,
    pub ui_theme: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerInfo {
    pub extension: String,
    pub id: String,
    pub kind: ViewerKind,
    pub extensions: Vec<String>,
    pub entry: String,
}

pub fn build(scan: &Scan, settings: &ExtensionSettings) -> Registry {
    let enabled = |e: &super::Installed| {
        e.source == Source::Bundled || !settings.disabled.contains(&e.manifest.id())
    };
    let extensions = scan
        .extensions
        .iter()
        .map(|e| ExtensionSummary {
            id: e.manifest.id(),
            version: e.manifest.version.clone(),
            display_name: e.manifest.display_name.clone(),
            source: e.source,
            enabled: enabled(e),
            path: e.path.clone(),
        })
        .collect();
    let first = match settings.precedence {
        Precedence::User => Source::User,
        Precedence::Bundled => Source::Bundled,
    };
    let mut ordered: Vec<&super::Installed> = scan.extensions.iter().filter(|e| enabled(e)).collect();
    // A stable sort: within one side the scan order (name order) stays.
    ordered.sort_by_key(|e| e.source != first);
    let mut languages = Vec::new();
    let mut grammars = Vec::new();
    let mut themes = Vec::new();
    let mut viewers = Vec::new();
    for e in ordered {
        let id = e.manifest.id();
        for g in &e.manifest.grammars {
            grammars.push(GrammarRef {
                extension: id.clone(),
                language: g.language.clone(),
                scope_name: g.scope_name.clone(),
                path: g.path.clone(),
                embedded_languages: g.embedded_languages.clone(),
            });
        }
        for lang in &e.manifest.languages {
            let grammar = e
                .manifest
                .grammars
                .iter()
                .find(|g| g.language.as_deref() == Some(lang.id.as_str()))
                .map(|g| GrammarInfo {
                    scope_name: g.scope_name.clone(),
                    path: g.path.clone(),
                    embedded_languages: g.embedded_languages.clone(),
                });
            languages.push(LanguageInfo {
                id: lang.id.clone(),
                extension: id.clone(),
                aliases: lang.aliases.clone(),
                extensions: lang.extensions.clone(),
                filenames: lang.filenames.clone(),
                first_line: lang.first_line.clone(),
                configuration: lang.configuration.clone(),
                grammar,
            });
        }
        for theme in &e.manifest.themes {
            themes.push(ThemeInfo {
                extension: id.clone(),
                label: theme.label.clone(),
                ui_theme: theme.ui_theme.clone(),
                path: theme.path.clone(),
            });
        }
        // Spec 「뷰어」: until viewers run in a webview without the IPC handler, only bundled ones.
        if e.source == Source::Bundled {
            for viewer in &e.manifest.viewers {
                viewers.push(ViewerInfo {
                    extension: id.clone(),
                    id: viewer.id.clone(),
                    kind: viewer.kind,
                    extensions: viewer.extensions.clone(),
                    entry: viewer.entry.clone(),
                });
            }
        }
    }
    Registry {
        extensions,
        languages,
        grammars,
        themes,
        viewers,
        problems: scan.problems.clone(),
    }
}
```

`src-tauri/src/lib.rs` 에 `pub mod extensions;` 를 더한다.

- [ ] **Step 8: 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml extensions appdata`
Expected: 새 테스트 17개가 PASS(개수를 적는다). `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 도 깨끗하다.

- [ ] **Step 9: 커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/appdata.rs src-tauri/src/extensions src-tauri/fixtures
git commit -m "feat(extensions): parse VS Code manifests, scan bundled and user extensions, build the registry"
```

---

### Task 4: Rust 확장 설치·제거·활성, 명령, AppCore 연결

**Files:**

- Modify: `src-tauri/src/extensions/install.rs`, `src-tauri/src/extensions/mod.rs`, `src-tauri/src/app/mod.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/app/windows.rs`, `src-tauri/src/app/requests.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/appdata.rs`

**Interfaces:**

- Consumes: Task 3 전부, `AppCore`·`lock`(`crate::app`), `write_json`.
- Produces (`crate::extensions::install`): `install(store: &ExtensionStore, source: &Path, replace: bool) -> Result<Installed, InstallError>`, `remove(store: &ExtensionStore, id: &str) -> Result<(), InstallError>`, `InstallError { AlreadyInstalled { id: String, version: String }, Invalid(String), NotInstalled(String), Io(io::Error) }`.
- Produces (`crate::appdata::AppPaths`): `extensions_dir(&self) -> PathBuf`(`<data>/extensions`).
- Produces (`crate::app::AppCore`): `load(bundled_dir: PathBuf)`, `new(paths, machine, settings: Settings, launch, bundled_dir: PathBuf)`, `workspace_root(&self) -> PathBuf`, `settings(&self) -> Settings`, `update_settings(&self, settings: Settings) -> io::Result<()>`, `registry(&self) -> Registry`, `rescan_extensions(&self)`, `extension_path(&self, id: &str) -> Option<PathBuf>`, `pub extensions: ExtensionStore`.
- Produces (명령, `src-tauri/src/app/commands.rs`): `extension_registry() -> Registry`, `read_extension_file(extension_id, path) -> Response`, `install_extension(path, replace) -> ExtensionSummary`(코드 `already-installed`·`invalid-extension`·`not-found`), `remove_extension(id)`, `set_extension_enabled(id, enabled)`, `get_settings() -> Settings`, `update_settings(settings)`. 설정·확장이 바뀌면 모든 창에 `tote://config` 이벤트.

- [ ] **Step 1: 실패하는 테스트 — 설치**

`src-tauri/src/extensions/install.rs` 의 테스트:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    use crate::extensions::manifest::tests::fixture_vsix;
    use crate::extensions::tests::write_extension;

    fn store(dir: &Path) -> ExtensionStore {
        ExtensionStore::new(dir.join("bundled"), dir.join("user"))
    }

    #[test]
    fn installs_the_fixture_vsix_under_id_and_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let installed = install(&store, &fixture_vsix(), false).unwrap();
        assert_eq!(installed.manifest.id(), "tote-test.test-theme");
        assert_eq!(installed.source, Source::User);
        assert_eq!(installed.path, dir.path().join("user/tote-test.test-theme@0.0.1"));
        assert!(installed.path.join("themes/night-color-theme.json").is_file());
        assert!(installed.path.join("syntaxes/tote.tmLanguage.json").is_file());
        // The vsix wrapper files stay out of the extension folder.
        assert!(!installed.path.join("extension.vsixmanifest").exists());
        assert!(!installed.path.join("extension").exists());
        // Nothing is left of the staging folder.
        let leftovers: Vec<String> = fs::read_dir(dir.path().join("user"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["tote-test.test-theme@0.0.1"]);
        assert_eq!(store.scan().extensions.len(), 1);
    }

    #[test]
    fn the_same_id_needs_replace_and_then_the_old_version_goes() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        write_extension(
            &dir.path().join("user"),
            "tote-test.test-theme@0.0.0",
            r#"{"name": "test-theme", "publisher": "tote-test", "version": "0.0.0"}"#,
        );
        let err = install(&store, &fixture_vsix(), false).unwrap_err();
        assert!(matches!(err, InstallError::AlreadyInstalled { ref version, .. } if version == "0.0.0"));
        assert!(dir.path().join("user/tote-test.test-theme@0.0.0").is_dir());
        let installed = install(&store, &fixture_vsix(), true).unwrap();
        assert_eq!(installed.manifest.version, "0.0.1");
        assert!(!dir.path().join("user/tote-test.test-theme@0.0.0").exists());
        assert!(dir.path().join("user/tote-test.test-theme@0.0.1").is_dir());
    }

    #[test]
    fn installs_a_plain_zip_and_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        // A zip with package.json at its root (not the vsix layout).
        let zip_path = dir.path().join("plain.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("package.json", options).unwrap();
            zip.write_all(br#"{"name": "plain", "publisher": "p", "version": "1.0.0"}"#).unwrap();
            zip.start_file("themes/a.json", options).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.finish().unwrap();
        }
        let plain = install(&store, &zip_path, false).unwrap();
        assert_eq!(plain.manifest.id(), "p.plain");
        assert!(plain.path.join("themes/a.json").is_file());

        let folder = write_extension(
            dir.path(),
            "somewhere/folder-ext",
            r#"{"name": "folder", "publisher": "p", "version": "2.0.0"}"#,
        );
        fs::create_dir_all(folder.join("sub")).unwrap();
        fs::write(folder.join("sub/x.json"), "{}").unwrap();
        let from_folder = install(&store, &folder, false).unwrap();
        assert_eq!(from_folder.path, dir.path().join("user/p.folder@2.0.0"));
        assert!(from_folder.path.join("sub/x.json").is_file());
        assert!(folder.join("package.json").is_file()); // the source folder is untouched
    }

    #[test]
    fn entries_that_escape_the_folder_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let zip_path = dir.path().join("evil.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("package.json", options).unwrap();
            zip.write_all(br#"{"name": "evil", "publisher": "p", "version": "1"}"#).unwrap();
            zip.start_file("../outside.txt", options).unwrap();
            zip.write_all(b"escaped").unwrap();
            zip.finish().unwrap();
        }
        let err = install(&store, &zip_path, false).unwrap_err();
        assert!(matches!(err, InstallError::Invalid(_)));
        assert!(!dir.path().join("outside.txt").exists());
        assert!(!dir.path().join("user/outside.txt").exists());
        assert!(fs::read_dir(dir.path().join("user")).map(|d| d.count() == 0).unwrap_or(true));
    }

    #[test]
    fn a_package_without_a_manifest_or_with_a_broken_one_installs_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let zip_path = dir.path().join("none.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(b"hi").unwrap();
            zip.finish().unwrap();
        }
        assert!(matches!(install(&store, &zip_path, false), Err(InstallError::Invalid(_))));
        let broken = write_extension(dir.path(), "broken", "{ nope");
        assert!(matches!(install(&store, &broken, false), Err(InstallError::Invalid(_))));
        assert!(matches!(
            install(&store, &dir.path().join("missing.vsix"), false),
            Err(InstallError::Io(_))
        ));
        assert!(fs::read_dir(dir.path().join("user")).map(|d| d.count() == 0).unwrap_or(true));
    }

    #[test]
    fn remove_deletes_every_folder_of_the_id_and_refuses_bundled_ones() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        install(&store, &fixture_vsix(), false).unwrap();
        remove(&store, "tote-test.test-theme").unwrap();
        assert!(store.scan().extensions.is_empty());
        assert!(matches!(
            remove(&store, "tote-test.test-theme"),
            Err(InstallError::NotInstalled(_))
        ));
        write_extension(
            &dir.path().join("bundled"),
            "tote.themes",
            r#"{"name": "themes", "publisher": "tote", "version": "1"}"#,
        );
        assert!(matches!(remove(&store, "tote.themes"), Err(InstallError::NotInstalled(_))));
        assert!(dir.path().join("bundled/tote.themes").is_dir());
    }
}
```

`zip::ZipWriter` 를 테스트에서 쓰므로 `Cargo.toml` 의 `zip` 은 쓰기도 포함한다(기본 기능 없이도 `ZipWriter` 는 있다. `deflate` 기능이 압축을 준다).

`src-tauri/src/app/mod.rs` 의 테스트에 더한다(기존 `core()` 헬퍼는 Step 4 의 새 시그니처로 바꾼다):

```rust
    #[test]
    fn settings_changes_move_the_workspace_root_and_rebuild_the_registry() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        assert_eq!(core.workspace_root(), core.paths.default_workspace_root);
        let mut settings = core.settings();
        settings.workspace_root = Some(dir.path().join("elsewhere"));
        settings.extensions.disabled = vec!["someone.ext".into()];
        core.update_settings(settings.clone()).unwrap();
        assert_eq!(core.workspace_root(), dir.path().join("elsewhere"));
        assert_eq!(Settings::load(&core.paths.settings_file()).unwrap(), settings);
        crate::extensions::tests::write_extension(
            &core.paths.extensions_dir(),
            "someone.ext@1",
            r#"{"name": "ext", "publisher": "someone", "version": "1",
                "contributes": {"themes": [{"label": "T", "uiTheme": "vs", "path": "t.json"}]}}"#,
        );
        core.rescan_extensions();
        let registry = core.registry();
        assert_eq!(registry.extensions.len(), 1);
        assert!(!registry.extensions[0].enabled);
        assert!(registry.themes.is_empty());
        assert_eq!(core.extension_path("someone.ext"), Some(core.paths.extensions_dir().join("someone.ext@1")));
        assert_eq!(core.extension_path("nobody.ext"), None);
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml install app::tests`
Expected: 컴파일 오류.

- [ ] **Step 3: 구현 — `install.rs`**

```rust
//! Installing, replacing and removing user extensions (spec 「설치와 로딩」). A package is a
//! .vsix or .zip, or a folder. It is unpacked into a staging folder under the user extensions
//! folder, its manifest read, and only then moved to `<id>@<version>` — so a broken package
//! never leaves a half-installed folder, and a rename is what makes it visible.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use super::manifest::{Manifest, ManifestError};
use super::{ExtensionStore, Installed, Source};

/// The vsix layout keeps the extension under this folder; a plain zip may not.
const VSIX_PREFIX: &str = "extension/";
/// Unpacked size above which an archive is refused: no theme or grammar pack comes near it, and
/// a zip bomb would otherwise fill the disk.
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("{id} {version} is already installed")]
    AlreadyInstalled { id: String, version: String },
    #[error("not a usable extension package: {0}")]
    Invalid(String),
    #[error("not an installed extension: {0}")]
    NotInstalled(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl From<ManifestError> for InstallError {
    fn from(err: ManifestError) -> InstallError {
        InstallError::Invalid(err.to_string())
    }
}

pub fn install(
    store: &ExtensionStore,
    source: &Path,
    replace: bool,
) -> Result<Installed, InstallError> {
    fs::create_dir_all(store.user_dir())?;
    let staging = store
        .user_dir()
        .join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    let result = stage_and_place(store, source, replace, &staging);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn stage_and_place(
    store: &ExtensionStore,
    source: &Path,
    replace: bool,
    staging: &Path,
) -> Result<Installed, InstallError> {
    if source.is_dir() {
        copy_folder(source, staging)?;
    } else {
        unpack(source, staging)?;
    }
    let text = fs::read_to_string(staging.join("package.json"))
        .map_err(|_| InstallError::Invalid("package.json 이 없습니다".into()))?;
    let manifest = Manifest::parse(&text)?;
    let id = manifest.id();
    let existing = installed_folders(store.user_dir(), &id)?;
    if let Some((_, version)) = existing.first() {
        if !replace {
            return Err(InstallError::AlreadyInstalled {
                id,
                version: version.clone(),
            });
        }
    }
    let target = store
        .user_dir()
        .join(format!("{id}@{}", manifest.version));
    for (folder, _) in &existing {
        fs::remove_dir_all(folder)?;
    }
    fs::rename(staging, &target)?;
    Ok(Installed {
        manifest,
        path: target,
        source: Source::User,
    })
}

pub fn remove(store: &ExtensionStore, id: &str) -> Result<(), InstallError> {
    let folders = installed_folders(store.user_dir(), id)?;
    if folders.is_empty() {
        return Err(InstallError::NotInstalled(id.to_string()));
    }
    for (folder, _) in folders {
        fs::remove_dir_all(folder)?;
    }
    Ok(())
}

/// The user folders of `id` with their versions, by name. Only folders named `<id>@<version>`
/// count: the id of a folder named otherwise is not known without reading its manifest, and
/// such folders were not made by this installer.
fn installed_folders(user_dir: &Path, id: &str) -> io::Result<Vec<(PathBuf, String)>> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(user_dir) else {
        return Ok(found);
    };
    let prefix = format!("{id}@");
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(version) = name.strip_prefix(&prefix) {
            if entry.path().is_dir() {
                found.push((entry.path(), version.to_string()));
            }
        }
    }
    found.sort();
    Ok(found)
}

/// Unpacks an archive into `into`. Entries are placed by `enclosed_name` (the zip crate's
/// traversal-safe name); any other entry fails the whole install. The `extension/` prefix of a
/// vsix is dropped; a zip whose only top-level folder holds package.json is unwrapped likewise.
fn unpack(archive: &Path, into: &Path) -> Result<(), InstallError> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|err| InstallError::Invalid(format!("zip 을 열지 못했습니다: {err}")))?;
    let names: Vec<String> = (0..zip.len())
        .map(|i| {
            zip.by_index(i)
                .map_err(|err| InstallError::Invalid(err.to_string()))
                .and_then(|entry| {
                    entry
                        .enclosed_name()
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                        .ok_or_else(|| InstallError::Invalid(format!("안전하지 않은 항목: {}", entry.name().map(|n| n.into_owned()).unwrap_or_default())))
                })
        })
        .collect::<Result<_, _>>()?;
    let prefix = archive_prefix(&names)?;
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|err| InstallError::Invalid(err.to_string()))?;
        if entry.is_dir() {
            continue;
        }
        let Some(rest) = names[i].strip_prefix(&prefix) else {
            continue; // a vsix's wrapper files outside extension/
        };
        total += entry.size();
        if total > MAX_UNPACKED_BYTES {
            return Err(InstallError::Invalid("압축을 풀면 너무 큽니다".into()));
        }
        let target = into.join(rest);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes)?;
        fs::write(&target, bytes)?;
    }
    Ok(())
}

/// Where package.json sits in the archive: at the root (`""`), under `extension/` (a vsix), or
/// under the single top-level folder a hand-made zip tends to have.
fn archive_prefix(names: &[String]) -> Result<String, InstallError> {
    if names.iter().any(|n| n == "package.json") {
        return Ok(String::new());
    }
    if names.iter().any(|n| n == "extension/package.json") {
        return Ok(VSIX_PREFIX.to_string());
    }
    let mut tops: Vec<&str> = names
        .iter()
        .filter_map(|n| n.split_once('/').map(|(top, _)| top))
        .collect();
    tops.sort_unstable();
    tops.dedup();
    if let [only] = tops.as_slice() {
        let prefix = format!("{only}/");
        if names.iter().any(|n| *n == format!("{prefix}package.json")) {
            return Ok(prefix);
        }
    }
    Err(InstallError::Invalid("package.json 이 없습니다".into()))
}

/// Copies `from` into `to`, files and folders only; symlinks are skipped so a link to somewhere
/// else never ends up served as part of the extension.
fn copy_folder(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_folder(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
```

`src-tauri/src/extensions/mod.rs` 의 `#[cfg(test)] mod tests` 를 `pub(crate)` 로 열고(`pub(crate) mod tests`) `write_extension` 을 그대로 둔다. `manifest.rs` 의 테스트 모듈도 `pub(crate) mod tests` 로 바꿔 `fixture_vsix` 를 나눠 쓴다.

- [ ] **Step 4: 구현 — `AppCore` 와 명령**

`src-tauri/src/appdata.rs` 의 `AppPaths` 에 더한다:

```rust
    /// Extensions the person installed, one folder per `<id>@<version>` (spec 「설치와 로딩」).
    pub fn extensions_dir(&self) -> PathBuf {
        self.data_dir.join("extensions")
    }
```

(테스트 `an_override_dir_holds_everything` 에 `assert_eq!(paths.extensions_dir(), PathBuf::from("/tmp/t/extensions"));` 를 더한다.)

`src-tauri/src/app/mod.rs` — `AppCore` 를 바꾼다:

```rust
use crate::appdata::{device_name, AppPaths, LaunchState, Machine, Settings};
use crate::extensions::registry::{self, Registry};
use crate::extensions::ExtensionStore;

pub struct AppCore {
    pub paths: AppPaths,
    pub machine: Machine,
    pub external: ExternalFiles,
    pub extensions: ExtensionStore,
    workspace_root: Mutex<PathBuf>,
    settings: Mutex<Settings>,
    registry: Mutex<Registry>,
    inner: Mutex<Inner>,
}

impl AppCore {
    /// `bundled_dir`: the extensions folder inside the app bundle's resources.
    pub fn load(bundled_dir: PathBuf) -> Result<AppCore, String> {
        let paths = AppPaths::resolve().ok_or("could not find the app data folder")?;
        let machine = Machine::load_or_create(&paths.machine_file(), device_name)
            .map_err(|err| format!("machine.json: {err}"))?;
        let settings = Settings::load(&paths.settings_file())
            .map_err(|err| format!("settings.json: {err}"))?;
        let launch =
            LaunchState::load(&paths.launch_file()).map_err(|err| format!("state.json: {err}"))?;
        Ok(AppCore::new(paths, machine, settings, launch, bundled_dir))
    }

    pub fn new(
        paths: AppPaths,
        machine: Machine,
        settings: Settings,
        launch: LaunchState,
        bundled_dir: PathBuf,
    ) -> AppCore {
        let workspace_root = settings.workspace_root(&paths);
        let external = ExternalFiles::new(DraftStore::new(paths.buffers_dir()));
        let extensions = ExtensionStore::new(bundled_dir, paths.extensions_dir());
        let registry = registry::build(&extensions.scan(), &settings.extensions);
        AppCore {
            paths,
            machine,
            external,
            extensions,
            workspace_root: Mutex::new(workspace_root),
            settings: Mutex::new(settings),
            registry: Mutex::new(registry),
            inner: Mutex::new(Inner { /* as before */ }),
        }
    }

    pub fn workspace_root(&self) -> PathBuf {
        lock(&self.workspace_root).clone()
    }

    pub fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    /// Saves and applies: the workspace root moves at once (open windows stay), the registry is
    /// rebuilt with the new switches.
    pub fn update_settings(&self, settings: Settings) -> io::Result<()> {
        settings.save(&self.paths.settings_file())?;
        *lock(&self.workspace_root) = settings.workspace_root(&self.paths);
        *lock(&self.settings) = settings;
        self.rescan_extensions();
        Ok(())
    }

    pub fn registry(&self) -> Registry {
        lock(&self.registry).clone()
    }

    pub fn rescan_extensions(&self) {
        let settings = lock(&self.settings);
        *lock(&self.registry) = registry::build(&self.extensions.scan(), &settings.extensions);
    }

    /// The folder of an installed extension, enabled or not.
    pub fn extension_path(&self, id: &str) -> Option<PathBuf> {
        lock(&self.registry)
            .extensions
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.path.clone())
    }
    // everything else as before
}
```

`use std::io;` 를 더한다. 모듈 안에서 `self.workspace_root` 를 읽던 자리(`fallback_workspace`)는 `self.workspace_root()` 로, 테스트 헬퍼 `core()` 는

```rust
    fn core(dir: &Path) -> AppCore {
        let paths = AppPaths::from_parts(Some(dir.join("data")), None, None, false).unwrap();
        let machine = Machine { version: 1, device_id: "device".into(), device_name: "맥".into() };
        AppCore::new(paths, machine, Settings::default(), LaunchState::default(), dir.join("bundled"))
    }
```

로 바꾸고, 기존 테스트 `open()` 의 `Workspace::create(&core.workspace_root, name)` 은 `Workspace::create(&core.workspace_root(), name)` 로. `src-tauri/src/app/commands.rs`(`list_workspaces`·`create_workspace`), `src-tauri/src/app/requests.rs`(`workspace_dir(&core.workspace_root, name)`), `src-tauri/src/app/windows.rs`(`open_latest` 의 `Workspace::create(&core.workspace_root, …)`)도 `core.workspace_root()` 로 바꾼다.

`src-tauri/src/app/commands.rs` 에 더한다:

```rust
use tauri::Emitter;

use crate::appdata::Settings;
use crate::extensions::install::{self, InstallError};
use crate::extensions::registry::{ExtensionSummary, Registry};
use crate::extensions::file_inside;

impl From<InstallError> for CommandError {
    fn from(err: InstallError) -> CommandError {
        let code = match &err {
            InstallError::AlreadyInstalled { .. } => "already-installed",
            InstallError::Invalid(_) => "invalid-extension",
            InstallError::NotInstalled(_) => "not-found",
            InstallError::Io(io) => io_code(io),
        };
        CommandError::new(code, err.to_string())
    }
}

/// Settings or the extension set changed: every window re-reads both.
fn broadcast_config(app: &AppHandle) {
    let _ = app.emit("tote://config", ());
}

#[tauri::command]
pub fn extension_registry(core: State<'_, AppCore>) -> Registry {
    core.registry()
}

#[tauri::command]
pub async fn read_extension_file(
    core: State<'_, AppCore>,
    extension_id: String,
    path: String,
) -> CmdResult<Response> {
    let root = core
        .extension_path(&extension_id)
        .ok_or_else(|| CommandError::new("not-found", format!("no extension {extension_id}")))?;
    let file = file_inside(&root, &path)
        .ok_or_else(|| CommandError::new("not-found", format!("{extension_id}: {path}")))?;
    Ok(Response::new(std::fs::read(file)?))
}

#[tauri::command]
pub async fn install_extension(
    app: AppHandle,
    core: State<'_, AppCore>,
    path: String,
    replace: bool,
) -> CmdResult<ExtensionSummary> {
    let installed = install::install(&core.extensions, &absolute_path(&path)?, replace)?;
    core.rescan_extensions();
    broadcast_config(&app);
    let id = installed.manifest.id();
    core.registry()
        .extensions
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| CommandError::new("app", "installed extension did not register"))
}

#[tauri::command]
pub async fn remove_extension(app: AppHandle, core: State<'_, AppCore>, id: String) -> CmdResult<()> {
    install::remove(&core.extensions, &id)?;
    let mut settings = core.settings();
    settings.extensions.disabled.retain(|d| *d != id);
    core.update_settings(settings)?;
    broadcast_config(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_extension_enabled(
    app: AppHandle,
    core: State<'_, AppCore>,
    id: String,
    enabled: bool,
) -> CmdResult<()> {
    let mut settings = core.settings();
    settings.extensions.disabled.retain(|d| *d != id);
    if !enabled {
        settings.extensions.disabled.push(id);
    }
    core.update_settings(settings)?;
    broadcast_config(&app);
    Ok(())
}

#[tauri::command]
pub fn get_settings(core: State<'_, AppCore>) -> Settings {
    core.settings()
}

#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    core: State<'_, AppCore>,
    settings: Settings,
) -> CmdResult<()> {
    core.update_settings(settings)?;
    broadcast_config(&app);
    Ok(())
}
```

`src-tauri/src/lib.rs` 의 `setup` 에서 `AppCore::load(app.path().resource_dir()?.join("extensions"))` 로 바꾸고(`use tauri::Manager` 는 이미 있다), `generate_handler!` 에 `commands::extension_registry, commands::read_extension_file, commands::install_extension, commands::remove_extension, commands::set_extension_enabled, commands::get_settings, commands::update_settings` 를 더한다. 개발 실행(`tauri dev`)에서 `resource_dir()` 는 `target/debug/` 를 가리키고 `tauri-build` 가 `bundle.resources` 를 그리로 복사한다(Task 5 가 `resources/extensions` 를 등록한다). 그 폴더가 아직 없으면 스캔이 비어 있을 뿐 시작은 막히지 않는다.

- [ ] **Step 5: 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` 그리고 `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: 전부 PASS(개수를 적는다 — 이전 개수 + 7). clippy 깨끗.

- [ ] **Step 6: 커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/extensions src-tauri/src/app src-tauri/src/lib.rs src-tauri/src/appdata.rs
git commit -m "feat(extensions): install, replace and remove user extensions; settings and registry commands"
```

---

### Task 5: 번들 확장 — 언어 묶음·기본 테마 생성기, 라이선스 검사, 서빙 경로

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vite.config.ts`, `src-tauri/tauri.conf.json`, `.gitignore`
- Create: `scripts/bundled-languages.ts`, `scripts/sync-bundled.ts`, `scripts/sync-bundled.test.ts`
- Create (생성물, 커밋한다): `src-tauri/resources/extensions/tote.languages/**`, `src-tauri/resources/extensions/tote.themes/**`, `src/backend/fake-registry.json`

**Interfaces:**

- Consumes: Task 3 의 매니페스트 형식, npm `tm-grammars`(문법 JSON + 메타데이터), `tm-themes`, `marked`(Task 12 가 쓴다).
- Produces (`scripts/bundled-languages.ts`): `LANGUAGES: BundledLanguage[]`, `EXTRA_GRAMMARS: string[]`, `THEMES: { name, label, uiTheme }[]`, `ALLOWED_LICENSES: string[]`, `BundledLanguage { id, aliases, grammar: string | null, extensions, filenames?, firstLine?, comments?: { line?: string; block?: [string, string] }, license?: { spdx, url, note } }`.
- Produces (`scripts/sync-bundled.ts`): `pnpm sync:bundled` — 번들 확장 셋(`tote.languages`, `tote.themes`)과 뷰어 템플릿이 있는 확장의 `viewer.html`, 그리고 `src/backend/fake-registry.json` 을 다시 만든다. 순수 함수 `languageConfiguration(lang): object`, `manifestFor(...)`, `inlineViewer(template: string, vendor: Record<string, string>): string`, `checkLicense(name, info, override): LicenseRow`, `fakeRegistry(manifests): ExtensionRegistry` 를 export 해 Vitest 가 본다.
- Produces (경로): 앱 안에서 번들 확장은 `<resource_dir>/extensions/<id>/`, 개발 서버에서는 `/extensions/<id>/<path>`(`vite.config.ts` 의 `serveExtensions()`).
- Produces (`src/backend/fake-registry.json`): `ExtensionRegistry`(Task 6 의 타입) — `FakeBackend.extensionRegistry()` 가 돌려준다.

- [ ] **Step 1: 의존성과 스크립트**

```bash
pnpm add -D tm-grammars@^1.32 tm-themes@^1.12 marked@^18
```

`package.json` 의 `scripts` 에 `"sync:bundled": "node scripts/sync-bundled.ts"` 를 더한다(Node 24 는 `.ts` 를 타입만 벗겨 바로 돈다 — `enum`·`namespace` 를 쓰지 않는다). `tsconfig.json` 의 `include` 에 `"scripts"` 를 더한다.

- [ ] **Step 2: 실패하는 테스트**

`scripts/sync-bundled.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ALLOWED_LICENSES, EXTRA_GRAMMARS, LANGUAGES, THEMES } from "./bundled-languages.ts";
import {
  checkLicense,
  fakeRegistry,
  inlineViewer,
  languageConfiguration,
  manifestFor,
} from "./sync-bundled.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the selection table", () => {
  it("covers the spec's language list and names a grammar tm-grammars has", async () => {
    const { grammars } = await import("tm-grammars");
    const names = new Set(grammars.map((g) => g.name));
    const ids = LANGUAGES.map((l) => l.id);
    for (const wanted of [
      "markdown",
      "plaintext",
      "shellscript",
      "json",
      "jsonc",
      "yaml",
      "toml",
      "ini",
      "dotenv",
      "javascript",
      "typescript",
      "python",
      "html",
      "css",
      "xml",
      "sql",
      "go",
      "rust",
      "java",
      "c",
      "cpp",
      "diff",
      "dockerfile",
      "makefile",
    ]) {
      expect(ids).toContain(wanted);
    }
    for (const lang of LANGUAGES) if (lang.grammar) expect(names.has(lang.grammar)).toBe(true);
    for (const extra of EXTRA_GRAMMARS) expect(names.has(extra)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("checkLicense", () => {
  it("takes the metadata's license when it is allowed and the table's note when it is missing", () => {
    expect(
      checkLicense("json", { license: "MIT", licenseUrl: "https://x/LICENSE" }, undefined),
    ).toEqual({
      name: "json",
      spdx: "MIT",
      url: "https://x/LICENSE",
      note: "",
    });
    expect(
      checkLicense(
        "yaml",
        {},
        { spdx: "textmate-bundle", url: "https://y", note: "Permission to copy…" },
      ),
    ).toEqual({
      name: "yaml",
      spdx: "textmate-bundle",
      url: "https://y",
      note: "Permission to copy…",
    });
  });

  it("refuses a missing or disallowed license", () => {
    expect(() =>
      checkLicense("ada", { license: "GPL-3.0", licenseUrl: "https://g" }, undefined),
    ).toThrow(/GPL-3.0/);
    expect(() => checkLicense("mystery", {}, undefined)).toThrow(/mystery/);
    expect(ALLOWED_LICENSES).toContain("MIT");
  });
});

describe("languageConfiguration and manifestFor", () => {
  it("turns the table row into VS Code's language-configuration shape", () => {
    const config = languageConfiguration({
      id: "sql",
      aliases: ["SQL"],
      grammar: "sql",
      extensions: ["sql"],
      comments: { line: "--", block: ["/*", "*/"] },
    });
    expect(config).toEqual({
      comments: { lineComment: "--", blockComment: ["/*", "*/"] },
      brackets: [
        ["(", ")"],
        ["[", "]"],
        ["{", "}"],
      ],
      autoClosingPairs: [
        { open: "(", close: ")" },
        { open: "[", close: "]" },
        { open: "{", close: "}" },
        { open: '"', close: '"', notIn: ["string"] },
        { open: "'", close: "'", notIn: ["string", "comment"] },
      ],
    });
  });

  it("writes one language and one grammar contribution per row, extras without a language", () => {
    const manifest = manifestFor(
      [
        { id: "plaintext", aliases: ["Plain Text"], grammar: null, extensions: ["txt"] },
        { id: "c", aliases: ["C"], grammar: "c", extensions: ["c", "h"], firstLine: "^#!" },
      ],
      ["cpp-macro"],
      { c: "source.c", "cpp-macro": "source.cpp.embedded.macro" },
    );
    expect(manifest.name).toBe("languages");
    expect(manifest.publisher).toBe("tote");
    expect(manifest.contributes.languages).toEqual([
      {
        id: "plaintext",
        aliases: ["Plain Text"],
        extensions: [".txt"],
        filenames: [],
        configuration: "./language-configuration/plaintext.json",
      },
      {
        id: "c",
        aliases: ["C"],
        extensions: [".c", ".h"],
        filenames: [],
        firstLine: "^#!",
        configuration: "./language-configuration/c.json",
      },
    ]);
    expect(manifest.contributes.grammars).toEqual([
      { language: "c", scopeName: "source.c", path: "./grammars/c.json" },
      { scopeName: "source.cpp.embedded.macro", path: "./grammars/cpp-macro.json" },
    ]);
  });
});

describe("inlineViewer", () => {
  it("inlines vendor scripts and locks the CSP to the hashes of every inline script", () => {
    const template = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src __SCRIPT_HASHES__"><script>__INLINE:lib__</script><script>main()</script>`;
    const html = inlineViewer(template, { lib: "var lib = 1;" });
    expect(html).toContain("<script>var lib = 1;</script>");
    expect(html).not.toContain("__INLINE");
    const hashes = html.match(/'sha256-[A-Za-z0-9+/=]+'/g) ?? [];
    expect(hashes).toHaveLength(2);
    expect(html).not.toContain("__SCRIPT_HASHES__");
  });

  it("refuses a template that names a vendor it was not given", () => {
    expect(() => inlineViewer("<script>__INLINE:nope__</script>", {})).toThrow(/nope/);
  });
});

describe("the generated files", () => {
  it("are what the generator makes now (run pnpm sync:bundled when this fails)", () => {
    const manifest = JSON.parse(read("src-tauri/resources/extensions/tote.languages/package.json"));
    expect(manifest.contributes.languages).toHaveLength(LANGUAGES.length);
    expect(manifest.contributes.grammars).toHaveLength(
      LANGUAGES.filter((l) => l.grammar).length + EXTRA_GRAMMARS.length,
    );
    for (const lang of LANGUAGES) {
      expect(() =>
        read(
          `src-tauri/resources/extensions/tote.languages/language-configuration/${lang.id}.json`,
        ),
      ).not.toThrow();
      if (lang.grammar) {
        const grammar = JSON.parse(
          read(`src-tauri/resources/extensions/tote.languages/grammars/${lang.grammar}.json`),
        );
        expect(typeof grammar.scopeName).toBe("string");
      }
    }
    const licenses = read("src-tauri/resources/extensions/tote.languages/LICENSES.md");
    for (const lang of LANGUAGES)
      if (lang.grammar) expect(licenses).toContain(`| ${lang.grammar} |`);
    const themes = JSON.parse(read("src-tauri/resources/extensions/tote.themes/package.json"));
    expect(themes.contributes.themes.map((t: { label: string }) => t.label)).toEqual(
      THEMES.map((t) => t.label),
    );
    for (const theme of THEMES) {
      const json = JSON.parse(
        read(`src-tauri/resources/extensions/tote.themes/themes/${theme.name}.json`),
      );
      expect(json.colors["editor.background"]).toMatch(/^#/);
      expect(Array.isArray(json.tokenColors)).toBe(true);
    }
    const fake = JSON.parse(read("src/backend/fake-registry.json"));
    expect(fake.extensions.map((e: { id: string }) => e.id)).toContain("tote.languages");
    expect(fake.languages.find((l: { id: string }) => l.id === "markdown").grammar.scopeName).toBe(
      "text.html.markdown",
    );
    expect(fake.themes).toHaveLength(THEMES.length);
    expect(
      fake.grammars.some((g: { scopeName: string }) => g.scopeName === "source.cpp.embedded.macro"),
    ).toBe(true);
    expect(fake.problems).toEqual([]);
  });

  it("match the fake registry a Rust scan of the same folders would make", () => {
    const fake = JSON.parse(read("src/backend/fake-registry.json"));
    const manifests = fake.extensions.map((e: { id: string }) =>
      JSON.parse(read(`src-tauri/resources/extensions/${e.id}/package.json`)),
    );
    expect(fakeRegistry(manifests)).toEqual(fake);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm test -- scripts`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 4: 선택표**

`scripts/bundled-languages.ts`:

```ts
/** The bundled language pack (spec 「번들 확장」 2). Grammars are copied from npm `tm-grammars`
 * by sync-bundled.ts, which also checks each grammar's license against ALLOWED_LICENSES. */

export interface BundledLanguage {
  id: string;
  aliases: string[];
  /** The tm-grammars name; null for languages without a grammar. */
  grammar: string | null;
  /** Without the dot. */
  extensions: string[];
  filenames?: string[];
  /** A JavaScript regular expression tried against the first line (spec 「편집기」). */
  firstLine?: string;
  comments?: { line?: string; block?: [string, string] };
  /** Only for grammars whose tm-grammars metadata carries no license: the license as read from
   * the source's README, with where it was read. */
  license?: { spdx: string; url: string; note: string };
}

/** SPDX ids the pack may ship. `textmate-bundle` is the permission sentence of the TextMate
 * bundles ("Permission to copy, use, modify, sell and distribute this software is granted"),
 * which has no SPDX id. */
export const ALLOWED_LICENSES = [
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "ISC",
  "textmate-bundle",
];

const TEXTMATE_BUNDLE_NOTE =
  'Permission to copy, use, modify, sell and distribute this software is granted. This software is provided "as is" without express or implied warranty, and with no claim as to its suitability for any purpose.';

const C_COMMENTS = { line: "//", block: ["/*", "*/"] as [string, string] };
const HASH = { line: "#" };

export const LANGUAGES: BundledLanguage[] = [
  { id: "plaintext", aliases: ["Plain Text"], grammar: null, extensions: ["txt", "text"] },
  {
    id: "markdown",
    aliases: ["Markdown"],
    grammar: "markdown",
    extensions: ["md", "markdown"],
    comments: { block: ["<!--", "-->"] },
  },
  {
    id: "shellscript",
    aliases: ["Shell Script"],
    grammar: "shellscript",
    extensions: ["sh", "bash", "zsh", "command"],
    filenames: [".bashrc", ".zshrc", ".profile", ".bash_profile"],
    firstLine: "^#!.*\\b(bash|zsh|sh|ksh|dash)\\b",
    comments: HASH,
  },
  { id: "json", aliases: ["JSON"], grammar: "json", extensions: ["json"] },
  {
    id: "jsonc",
    aliases: ["JSON with Comments"],
    grammar: "jsonc",
    extensions: ["jsonc", "json5"],
    filenames: ["tsconfig.json", "jsconfig.json", ".eslintrc", "settings.json"],
    comments: C_COMMENTS,
  },
  {
    id: "yaml",
    aliases: ["YAML"],
    grammar: "yaml",
    extensions: ["yaml", "yml"],
    comments: HASH,
    license: {
      spdx: "textmate-bundle",
      url: "https://github.com/textmate/yaml.tmbundle/blob/master/README.mdown",
      note: TEXTMATE_BUNDLE_NOTE,
    },
  },
  {
    id: "toml",
    aliases: ["TOML"],
    grammar: "toml",
    extensions: ["toml"],
    comments: HASH,
    license: {
      spdx: "textmate-bundle",
      url: "https://github.com/textmate/toml.tmbundle/blob/master/README.mdown",
      note: TEXTMATE_BUNDLE_NOTE,
    },
  },
  {
    id: "ini",
    aliases: ["INI"],
    grammar: "ini",
    extensions: ["ini", "cfg", "conf"],
    filenames: [".editorconfig", ".gitconfig"],
    comments: { line: ";" },
  },
  {
    id: "dotenv",
    aliases: ["Dotenv"],
    grammar: "dotenv",
    extensions: ["env"],
    filenames: [".env", ".env.local", ".env.example"],
    comments: HASH,
  },
  {
    id: "javascript",
    aliases: ["JavaScript"],
    grammar: "javascript",
    extensions: ["js", "mjs", "cjs", "jsx"],
    firstLine: "^#!.*\\bnode\\b",
    comments: C_COMMENTS,
  },
  {
    id: "typescript",
    aliases: ["TypeScript"],
    grammar: "typescript",
    extensions: ["ts", "mts", "cts"],
    comments: C_COMMENTS,
  },
  {
    id: "python",
    aliases: ["Python"],
    grammar: "python",
    extensions: ["py", "pyi"],
    firstLine: "^#!.*\\bpython[0-9.]*\\b",
    comments: HASH,
  },
  {
    id: "html",
    aliases: ["HTML"],
    grammar: "html",
    extensions: ["html", "htm"],
    firstLine: "^\\s*<!doctype html",
    comments: { block: ["<!--", "-->"] },
  },
  {
    id: "css",
    aliases: ["CSS"],
    grammar: "css",
    extensions: ["css"],
    comments: { block: ["/*", "*/"] },
  },
  {
    id: "xml",
    aliases: ["XML"],
    grammar: "xml",
    extensions: ["xml", "svg", "plist", "xsl", "xslt"],
    firstLine: "^\\s*<\\?xml",
    comments: { block: ["<!--", "-->"] },
  },
  {
    id: "sql",
    aliases: ["SQL"],
    grammar: "sql",
    extensions: ["sql"],
    comments: { line: "--", block: ["/*", "*/"] },
  },
  { id: "go", aliases: ["Go"], grammar: "go", extensions: ["go"], comments: C_COMMENTS },
  { id: "rust", aliases: ["Rust"], grammar: "rust", extensions: ["rs"], comments: C_COMMENTS },
  { id: "java", aliases: ["Java"], grammar: "java", extensions: ["java"], comments: C_COMMENTS },
  { id: "c", aliases: ["C"], grammar: "c", extensions: ["c", "h"], comments: C_COMMENTS },
  {
    id: "cpp",
    aliases: ["C++"],
    grammar: "cpp",
    extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
    comments: C_COMMENTS,
  },
  { id: "diff", aliases: ["Diff"], grammar: "diff", extensions: ["diff", "patch"] },
  {
    id: "dockerfile",
    aliases: ["Dockerfile"],
    grammar: "docker",
    extensions: ["dockerfile"],
    filenames: ["Dockerfile", "Containerfile"],
    comments: HASH,
  },
  {
    id: "makefile",
    aliases: ["Makefile"],
    grammar: "make",
    extensions: ["mk", "mak"],
    filenames: ["Makefile", "makefile", "GNUmakefile"],
    comments: HASH,
  },
];

/** Grammars shipped for `include` only (no language of their own): cpp includes its macro grammar. */
export const EXTRA_GRAMMARS = ["cpp-macro"];

/** VS Code's own defaults (MIT), from tm-themes. */
export const THEMES = [
  { name: "light-plus", label: "Light+", uiTheme: "vs" },
  { name: "dark-plus", label: "Dark+", uiTheme: "vs-dark" },
];
```

- [ ] **Step 5: 생성기**

`scripts/sync-bundled.ts`:

```ts
/** Rebuilds the bundled extensions from their npm sources. Run it whenever bundled-languages.ts,
 * a viewer template or a vendor version changes: `pnpm sync:bundled`. The outputs are committed
 * so that cargo tests, the browser preview and the app see one and the same set. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_LICENSES,
  EXTRA_GRAMMARS,
  LANGUAGES,
  THEMES,
  type BundledLanguage,
} from "./bundled-languages.ts";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS_DIR = join(ROOT, "src-tauri/resources/extensions");
const FAKE_REGISTRY = join(ROOT, "src/backend/fake-registry.json");

interface LicenseMeta {
  license?: string;
  licenseUrl?: string;
}

export interface LicenseRow {
  name: string;
  spdx: string;
  url: string;
  note: string;
}

export function checkLicense(
  name: string,
  meta: LicenseMeta,
  override: BundledLanguage["license"],
): LicenseRow {
  const spdx = meta.license ?? override?.spdx;
  const url = meta.licenseUrl ?? override?.url;
  if (!spdx || !url)
    throw new Error(
      `${name}: no license recorded — add one to bundled-languages.ts after reading the source`,
    );
  if (!ALLOWED_LICENSES.includes(spdx))
    throw new Error(`${name}: license ${spdx} is not in the allowed list`);
  return { name, spdx, url, note: meta.license ? "" : (override?.note ?? "") };
}

export function languageConfiguration(lang: BundledLanguage): object {
  const comments: Record<string, unknown> = {};
  if (lang.comments?.line) comments.lineComment = lang.comments.line;
  if (lang.comments?.block) comments.blockComment = lang.comments.block;
  return {
    comments,
    brackets: [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string", "comment"] },
    ],
  };
}

export function manifestFor(
  languages: BundledLanguage[],
  extras: string[],
  scopes: Record<string, string>,
) {
  return {
    name: "languages",
    publisher: "tote",
    version: "1.0.0",
    displayName: "tote 기본 언어 묶음",
    contributes: {
      languages: languages.map((lang) => ({
        id: lang.id,
        aliases: lang.aliases,
        extensions: lang.extensions.map((e) => `.${e}`),
        filenames: lang.filenames ?? [],
        ...(lang.firstLine ? { firstLine: lang.firstLine } : {}),
        configuration: `./language-configuration/${lang.id}.json`,
      })),
      grammars: [
        ...languages
          .filter((lang) => lang.grammar)
          .map((lang) => ({
            language: lang.id,
            scopeName: scopes[lang.grammar!],
            path: `./grammars/${lang.grammar}.json`,
          })),
        ...extras.map((name) => ({ scopeName: scopes[name], path: `./grammars/${name}.json` })),
      ],
    },
  };
}

/** Fills `__INLINE:<name>__` with the vendor file's text and `__SCRIPT_HASHES__` with the
 * sha256 CSP sources of every inline script — the page then runs exactly those scripts. */
export function inlineViewer(template: string, vendor: Record<string, string>): string {
  let html = template.replace(/__INLINE:([\w-]+)__/g, (_m, name: string) => {
    const text = vendor[name];
    if (text === undefined)
      throw new Error(`viewer template asks for a vendor file it was not given: ${name}`);
    return text;
  });
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    hashes.push(`'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  }
  html = html.replace("__SCRIPT_HASHES__", hashes.join(" "));
  return html;
}

type Manifest = {
  name: string;
  publisher: string;
  version: string;
  displayName?: string;
  contributes?: {
    languages?: {
      id: string;
      aliases?: string[];
      extensions?: string[];
      filenames?: string[];
      firstLine?: string;
      configuration?: string;
    }[];
    grammars?: {
      language?: string;
      scopeName: string;
      path: string;
      embeddedLanguages?: Record<string, string>;
    }[];
    themes?: { label: string; uiTheme?: string; path: string }[];
  };
  tote?: {
    viewers?: { id: string; kind: "primary" | "preview"; extensions?: string[]; entry: string }[];
  };
};

const rel = (path: string) => path.replace(/^\.\//, "");

/** The registry Rust builds for these manifests as bundled extensions (extensions/registry.rs):
 * the fake backend serves it so the browser preview sees the same languages and viewers. */
export function fakeRegistry(manifests: Manifest[]) {
  const id = (m: Manifest) => `${m.publisher}.${m.name}`;
  return {
    extensions: manifests.map((m) => ({
      id: id(m),
      version: m.version,
      displayName: m.displayName ?? m.name,
      source: "bundled",
      enabled: true,
      path: `/bundled/${id(m)}`,
    })),
    languages: manifests.flatMap((m) =>
      (m.contributes?.languages ?? []).map((lang) => {
        const grammar = (m.contributes?.grammars ?? []).find((g) => g.language === lang.id);
        return {
          id: lang.id,
          extension: id(m),
          aliases: lang.aliases ?? [],
          extensions: lang.extensions?.map((e) => e.replace(/^\./, "").toLowerCase()) ?? [],
          filenames: lang.filenames ?? [],
          firstLine: lang.firstLine ?? null,
          configuration: lang.configuration ? rel(lang.configuration) : null,
          grammar: grammar
            ? {
                scopeName: grammar.scopeName,
                path: rel(grammar.path),
                embeddedLanguages: grammar.embeddedLanguages ?? {},
              }
            : null,
        };
      }),
    ),
    grammars: manifests.flatMap((m) =>
      (m.contributes?.grammars ?? []).map((g) => ({
        extension: id(m),
        language: g.language ?? null,
        scopeName: g.scopeName,
        path: rel(g.path),
        embeddedLanguages: g.embeddedLanguages ?? {},
      })),
    ),
    themes: manifests.flatMap((m) =>
      (m.contributes?.themes ?? []).map((t) => ({
        extension: id(m),
        label: t.label,
        uiTheme: t.uiTheme ?? "vs-dark",
        path: rel(t.path),
      })),
    ),
    viewers: manifests.flatMap((m) =>
      (m.tote?.viewers ?? []).map((v) => ({
        extension: id(m),
        id: v.id,
        kind: v.kind,
        extensions: v.extensions ?? [],
        entry: rel(v.entry),
      })),
    ),
    problems: [],
  };
}

function licensesMarkdown(title: string, rows: LicenseRow[]): string {
  const lines = [
    `# ${title}`,
    "",
    "| 이름 | 라이선스 | 원문 | 비고 |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) lines.push(`| ${row.name} | ${row.spdx} | ${row.url} | ${row.note} |`);
  return lines.join("\n") + "\n";
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

async function syncLanguages() {
  const { grammars } = await import("tm-grammars");
  const dir = join(EXTENSIONS_DIR, "tote.languages");
  rmSync(join(dir, "grammars"), { recursive: true, force: true });
  rmSync(join(dir, "language-configuration"), { recursive: true, force: true });
  const scopes: Record<string, string> = {};
  const rows: LicenseRow[] = [];
  const names = [...LANGUAGES.filter((l) => l.grammar).map((l) => l.grammar!), ...EXTRA_GRAMMARS];
  for (const name of names) {
    const info = grammars.find((g) => g.name === name);
    if (!info) throw new Error(`tm-grammars has no grammar named ${name}`);
    const override = LANGUAGES.find((l) => l.grammar === name)?.license;
    rows.push(checkLicense(name, info, override));
    scopes[name] = info.scopeName;
    const text = readFileSync(require.resolve(`tm-grammars/grammars/${name}.json`), "utf8");
    mkdirSync(join(dir, "grammars"), { recursive: true });
    writeFileSync(join(dir, "grammars", `${name}.json`), text);
  }
  for (const lang of LANGUAGES)
    writeJson(join(dir, "language-configuration", `${lang.id}.json`), languageConfiguration(lang));
  writeJson(join(dir, "package.json"), manifestFor(LANGUAGES, EXTRA_GRAMMARS, scopes));
  writeFileSync(join(dir, "LICENSES.md"), licensesMarkdown("tote.languages — 문법 라이선스", rows));
}

async function syncThemes() {
  const { themes } = await import("tm-themes");
  const dir = join(EXTENSIONS_DIR, "tote.themes");
  rmSync(join(dir, "themes"), { recursive: true, force: true });
  const rows: LicenseRow[] = [];
  for (const theme of THEMES) {
    const info = themes.find((t) => t.name === theme.name);
    if (!info) throw new Error(`tm-themes has no theme named ${theme.name}`);
    rows.push(checkLicense(theme.name, info, undefined));
    mkdirSync(join(dir, "themes"), { recursive: true });
    writeFileSync(
      join(dir, "themes", `${theme.name}.json`),
      readFileSync(require.resolve(`tm-themes/themes/${theme.name}.json`), "utf8"),
    );
  }
  writeJson(join(dir, "package.json"), {
    name: "themes",
    publisher: "tote",
    version: "1.0.0",
    displayName: "tote 기본 테마",
    contributes: {
      themes: THEMES.map((t) => ({
        label: t.label,
        uiTheme: t.uiTheme,
        path: `./themes/${t.name}.json`,
      })),
    },
  });
  writeFileSync(join(dir, "LICENSES.md"), licensesMarkdown("tote.themes — 테마 라이선스", rows));
}

/** Vendor files a viewer template may inline, by the name used in `__INLINE:<name>__`. */
function vendorFiles(): Record<string, string> {
  const marked = join(dirname(require.resolve("marked/package.json")), "lib/marked.umd.js");
  return { marked: readFileSync(marked, "utf8") };
}

function syncViewers() {
  const vendor = vendorFiles();
  for (const id of readdirSync(EXTENSIONS_DIR)) {
    const template = join(EXTENSIONS_DIR, id, "viewer.template.html");
    if (!existsSync(template)) continue;
    writeFileSync(
      join(EXTENSIONS_DIR, id, "viewer.html"),
      inlineViewer(readFileSync(template, "utf8"), vendor),
    );
  }
}

function syncFakeRegistry() {
  const manifests = readdirSync(EXTENSIONS_DIR)
    .sort()
    .filter((id) => existsSync(join(EXTENSIONS_DIR, id, "package.json")))
    .map(
      (id) =>
        JSON.parse(readFileSync(join(EXTENSIONS_DIR, id, "package.json"), "utf8")) as Manifest,
    );
  writeJson(FAKE_REGISTRY, fakeRegistry(manifests));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await syncLanguages();
  await syncThemes();
  syncViewers();
  syncFakeRegistry();
  console.log("bundled extensions are up to date");
}
```

`tm-grammars` 의 `index.d.ts` 는 `grammars: GrammarInfo[]` 를 선언하고 `tm-themes` 는 `themes: ThemeInfo[]` 다(둘 다 `license?`·`licenseUrl?`·`scopeName`/`name` 필드). `checkLicense` 의 `meta` 에 그대로 넘긴다.

```bash
pnpm sync:bundled
ls src-tauri/resources/extensions/tote.languages/grammars | wc -l   # 24 (23 languages with a grammar + cpp-macro)
cat src-tauri/resources/extensions/tote.languages/LICENSES.md
```

Expected: 스크립트가 실패하지 않고(`yaml`·`toml` 은 선택표의 `license` 로 통과) `LICENSES.md` 에 문법 24줄, `tote.themes/LICENSES.md` 에 2줄(MIT, VS Code). 실패하면 그 문법의 라이선스를 **먼저 확인하고** 선택표에 적거나 목록에서 빼고 보고에 남긴다.

- [ ] **Step 6: 서빙 경로 — Vite 미들웨어와 Tauri 리소스**

`vite.config.ts` 를 바꾼다:

```ts
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

import { defineConfig, type Plugin } from "vitest/config";

const EXTENSIONS_DIR = resolve(__dirname, "src-tauri/resources/extensions");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Serves the bundled extensions at /extensions/<id>/<path> on the dev server only — the same
 * files the app serves at tote-ext://localhost/<id>/<path> — so the browser preview and the UI
 * tests load the real viewer pages. Not part of the build: the app reads them as resources. */
function serveExtensions(): Plugin {
  return {
    name: "tote-serve-extensions",
    configureServer(server) {
      server.middlewares.use("/extensions", (req, res, next) => {
        const relative = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
        const file = join(EXTENSIONS_DIR, relative);
        if (!file.startsWith(EXTENSIONS_DIR + "/") || !existsSync(file) || !statSync(file).isFile())
          return next();
        const ext = file.slice(file.lastIndexOf("."));
        res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // Tauri prints Rust errors to the same terminal; keep them on screen.
  clearScreen: false,
  plugins: [serveExtensions()],
  server: {
    // `tauri dev` loads exactly this port (devUrl in src-tauri/tauri.conf.json).
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },
});
```

`src-tauri/tauri.conf.json` 의 `bundle.resources` 를 바꾼다:

```json
    "resources": { "resources/tote": "bin/tote", "resources/extensions": "extensions" },
```

`.gitignore` 에는 아무것도 더하지 않는다 — 생성물은 커밋한다(Rust 테스트·브라우저 미리보기·앱이 같은 파일을 봐야 한다). 생성물이 소스와 어긋나면 Step 2 의 `the generated files` 테스트가 잡는다.

- [ ] **Step 7: 통과 확인**

Run: `pnpm test -- scripts` 와 `pnpm typecheck`
Expected: scripts 테스트 9개 PASS. `pnpm dev` 를 띄운 뒤 `curl -s http://localhost:1420/extensions/tote.languages/package.json | head -3` 이 매니페스트를 돌려주고, `curl -s -o /dev/null -w '%{http_code}' http://localhost:1420/extensions/../package.json` 이 404 다(브라우저가 `..` 을 정규화하기 전의 경로도 미들웨어가 거른다). `cargo build --manifest-path src-tauri/Cargo.toml` 뒤 `ls src-tauri/target/debug/extensions` 에 세 폴더가 있다(tauri-build 의 리소스 복사).

- [ ] **Step 8: 커밋**

```bash
pnpm exec oxfmt scripts vite.config.ts src-tauri/resources/extensions/tote.languages/package.json src-tauri/resources/extensions/tote.themes/package.json src/backend/fake-registry.json
pnpm exec oxlint --fix scripts vite.config.ts
git add package.json pnpm-lock.yaml tsconfig.json vite.config.ts src-tauri/tauri.conf.json scripts/bundled-languages.ts scripts/sync-bundled.ts scripts/sync-bundled.test.ts src-tauri/resources/extensions src/backend/fake-registry.json
git commit -m "feat(extensions): bundle the language pack and default themes from tm-grammars and tm-themes with a license check"
```

---

### Task 6: 프론트 레지스트리 — Backend 확장 메서드, 조회, JSONC, 언어 설정 → CodeMirror

**Files:**

- Modify: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/tauri.test.ts`, `src/backend/fake.ts`, `src/editor/setup.ts`, `tests/e2e/pages/editor.ts`, `tests/e2e/editor.spec.ts`
- Create: `src/core/jsonc.ts`, `src/core/jsonc.test.ts`, `src/extensions/registry.ts`, `src/extensions/registry.test.ts`, `src/editor/language-config.ts`, `src/editor/language-config.test.ts`

**Interfaces:**

- Consumes: Task 4 의 명령, Task 5 의 `fake-registry.json`.
- Produces (`src/backend/types.ts`): `ExtensionRegistry { extensions: ExtensionSummary[]; languages: LanguageInfo[]; grammars: GrammarRef[]; themes: ThemeInfo[]; viewers: ViewerInfo[]; problems: ExtensionProblem[] }`, `GrammarRef { extension; language: string | null; scopeName; path; embeddedLanguages }`, `ExtensionSummary { id; version; displayName; source: "bundled" | "user"; enabled: boolean; path: string }`, `LanguageInfo { id; extension; aliases: string[]; extensions: string[]; filenames: string[]; firstLine: string | null; configuration: string | null; grammar: GrammarInfo | null }`, `GrammarInfo { scopeName; path; embeddedLanguages: Record<string, string> }`, `ThemeInfo { extension; label; uiTheme: string; path }`, `ViewerKind = "primary" | "preview"`, `ViewerInfo { extension; id; kind: ViewerKind; extensions: string[]; entry }`, `ExtensionProblem { path; message }`, `ThemeRef { extension; label }`, `Settings { workspaceRoot: string | null; theme: { light: ThemeRef | null; dark: ThemeRef | null }; extensions: { disabled: string[]; precedence: "user" | "bundled" } }`, `FileSource = { kind: "memo"; id: string } | { kind: "external"; path: string }`.
- Produces (`Backend`): `extensionRegistry(): Promise<ExtensionRegistry>`, `readExtensionFile(extensionId: string, path: string): Promise<Uint8Array>`, `installExtension(path: string, replace: boolean): Promise<ExtensionSummary>`, `removeExtension(id: string): Promise<void>`, `setExtensionEnabled(id: string, enabled: boolean): Promise<void>`, `settings(): Promise<Settings>`, `updateSettings(settings: Settings): Promise<void>`, `viewerUrl(extensionId: string, entry: string): string`, `pickExtensionPackage(): Promise<string | null>`, `pickFolder(): Promise<string | null>`, `onConfigChanged(handler: () => void): void`.
- Produces (`FakeBackend`): `FakeData` gains `settings: Settings`, `userExtensions: ExtensionSummary[]`, `packages: Record<string, { manifest: { name; publisher; version; displayName? } }>`(설치 소스 흉내), `extensionFiles: Record<string, string>`(`"<id>/<path>"` → 텍스트, 브라우저에서는 없으면 `/extensions/<id>/<path>` 를 fetch), `picks` 를 그대로 쓰고 `pickExtensionPackage`/`pickFolder` 도 `picks` 의 첫 항목을 꺼낸다; `config()` 로 `onConfigChanged` 핸들러를 부른다.
- Produces (`src/core/jsonc.ts`): `stripJsonc(text: string): string`, `parseJsonc<T = unknown>(text: string): T`.
- Produces (`src/extensions/registry.ts`): `class Registry { constructor(readonly data: ExtensionRegistry); languageForFile(fileName: string): LanguageInfo | undefined; language(id: string): LanguageInfo | undefined; get languages(): LanguageInfo[] /* one per id, alias order */; viewerFor(fileName: string, kind: ViewerKind): ViewerInfo | undefined; grammarForScope(scopeName: string): GrammarRef | undefined; get themes(): ThemeInfo[]; themeFor(ref: ThemeRef | null, appearance: "light" | "dark"): ThemeInfo | undefined }`, `languageLabelFor(lang: LanguageInfo | undefined, fileName: string): string`, `EMPTY_REGISTRY: ExtensionRegistry`.
- Produces (`src/editor/language-config.ts`): `LanguageConfiguration` 타입, `parseLanguageConfiguration(text: string): LanguageConfiguration`, `languageData(config: LanguageConfiguration): LanguageData`(`{ commentTokens?, closeBrackets?, wordChars? }`), `wordCharsFor(pattern: RegExp): string`, `DEFAULT_LANGUAGE_DATA: LanguageData`.
- Produces (`src/editor/setup.ts`): `EditorOptions` gains `languageData?: LanguageData`; `languageDataEffect(data: LanguageData): StateEffect<unknown>`.

- [ ] **Step 1: 실패하는 테스트**

`src/core/jsonc.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseJsonc, stripJsonc } from "./jsonc";

describe("parseJsonc", () => {
  it("drops comments and trailing commas but keeps strings whole", () => {
    const text = `{
  // comment with "quotes"
  "a": "// not a comment, /* nor this */",
  "b": [1, 2, /* in-line */ 3,],
  "c": "escaped \\" quote", /* block
  comment */
}`;
    expect(parseJsonc(text)).toEqual({
      a: "// not a comment, /* nor this */",
      b: [1, 2, 3],
      c: 'escaped " quote',
    });
    expect(parseJsonc("[1, // last\n]")).toEqual([1]);
    expect(parseJsonc('{"이름": "메모" /* 주석 */}')).toEqual({ 이름: "메모" });
  });

  it("leaves plain JSON untouched", () => {
    expect(stripJsonc('{"a": [1, 2], "b": "x/y"}')).toBe('{"a": [1, 2], "b": "x/y"}');
  });
});
```

`src/extensions/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import fake from "../backend/fake-registry.json";
import type { ExtensionRegistry, LanguageInfo } from "../backend/types";
import { languageLabelFor, Registry } from "./registry";

const bundled = new Registry(fake as ExtensionRegistry);

const lang = (id: string, extension: string, patch: Partial<LanguageInfo> = {}): LanguageInfo => ({
  id,
  extension,
  aliases: [id],
  extensions: [],
  filenames: [],
  firstLine: null,
  configuration: null,
  grammar: null,
  ...patch,
});

describe("Registry.languageForFile", () => {
  it("matches a file name exactly before an extension, case-insensitively for extensions", () => {
    expect(bundled.languageForFile("Makefile")?.id).toBe("makefile");
    expect(bundled.languageForFile("회의.MD")?.id).toBe("markdown");
    expect(bundled.languageForFile("tsconfig.json")?.id).toBe("jsonc");
    expect(bundled.languageForFile("data.json")?.id).toBe("json");
    expect(bundled.languageForFile("Dockerfile")?.id).toBe("dockerfile");
    expect(bundled.languageForFile("noext")).toBeUndefined();
    expect(bundled.languageForFile("x.unknown")).toBeUndefined();
  });

  it("takes the first language that claims the extension — the registry's order is precedence", () => {
    const registry = new Registry({
      extensions: [],
      languages: [
        lang("better-md", "someone.ext", { extensions: ["md"] }),
        lang("markdown", "tote.languages", { extensions: ["md"] }),
      ],
      grammars: [],
      themes: [],
      viewers: [],
      problems: [],
    });
    expect(registry.languageForFile("a.md")?.id).toBe("better-md");
    expect(registry.language("markdown")?.extension).toBe("tote.languages");
  });

  it("lists each id once, sorted by its first alias", () => {
    const registry = new Registry({
      extensions: [],
      languages: [
        lang("markdown", "user.ext", { aliases: ["Markdown"] }),
        lang("markdown", "tote.languages", { aliases: ["Markdown"] }),
        lang("c", "tote.languages", { aliases: ["C"] }),
      ],
      grammars: [],
      themes: [],
      viewers: [],
      problems: [],
    });
    expect(registry.languages.map((l) => [l.id, l.extension])).toEqual([
      ["c", "tote.languages"],
      ["markdown", "user.ext"],
    ]);
  });
});

describe("Registry.viewerFor and themeFor", () => {
  it("finds the bundled viewers by extension and kind", () => {
    expect(bundled.viewerFor("a.md", "preview")?.id).toBe("markdown");
    expect(bundled.viewerFor("a.md", "primary")).toBeUndefined();
    expect(bundled.viewerFor("photo.JPG", "primary")?.id).toBe("media");
    expect(bundled.viewerFor("doc.pdf", "primary")).toBeUndefined();
  });

  it("resolves a theme reference, else the first theme of the appearance", () => {
    expect(bundled.themeFor({ extension: "tote.themes", label: "Dark+" }, "light")?.label).toBe(
      "Dark+",
    );
    expect(bundled.themeFor(null, "light")?.label).toBe("Light+");
    expect(bundled.themeFor(null, "dark")?.label).toBe("Dark+");
    expect(bundled.themeFor({ extension: "gone.ext", label: "Night" }, "dark")?.label).toBe(
      "Dark+",
    );
  });
});

describe("languageLabelFor", () => {
  it("prefers the alias, then the id, then the upper-cased extension, then 텍스트", () => {
    expect(languageLabelFor(lang("python", "e", { aliases: ["Python", "py"] }), "a.py")).toBe(
      "Python",
    );
    expect(languageLabelFor(lang("python", "e", { aliases: [] }), "a.py")).toBe("python");
    expect(languageLabelFor(undefined, "a.xyz")).toBe("XYZ");
    expect(languageLabelFor(undefined, "noext")).toBe("텍스트");
  });
});
```

`src/editor/language-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { languageData, parseLanguageConfiguration, wordCharsFor } from "./language-config";

describe("parseLanguageConfiguration", () => {
  it("reads VS Code's JSONC shape with both pair notations", () => {
    const config = parseLanguageConfiguration(`{
      // generated
      "comments": { "lineComment": "#", "blockComment": ["/*", "*/"] },
      "brackets": [["(", ")"], ["{", "}"]],
      "autoClosingPairs": [{ "open": "(", "close": ")" }, ["{", "}"], { "open": "\\"", "close": "\\"", "notIn": ["string"] }],
      "wordPattern": "[A-Za-z0-9_$-]+",
    }`);
    expect(languageData(config)).toEqual({
      commentTokens: { line: "#", block: { open: "/*", close: "*/" } },
      closeBrackets: { brackets: ["(", "{", '"'] },
      wordChars: "$-",
    });
  });

  it("takes a wordPattern object and leaves out what the file does not say", () => {
    const config = parseLanguageConfiguration(
      `{ "wordPattern": { "pattern": "[\\\\w-]+", "flags": "u" } }`,
    );
    expect(languageData(config)).toEqual({ wordChars: "-" });
    expect(languageData(parseLanguageConfiguration("{}"))).toEqual({});
  });

  it("ignores a wordPattern that is not a valid expression", () => {
    expect(languageData(parseLanguageConfiguration(`{ "wordPattern": "[" }`))).toEqual({});
  });
});

describe("wordCharsFor", () => {
  it("names the ASCII punctuation the pattern counts as part of a word", () => {
    expect(wordCharsFor(/[\w-]+/)).toBe("-");
    expect(wordCharsFor(/(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/)).toBe("$");
    expect(wordCharsFor(/\w+/)).toBe("");
  });
});
```

`src/backend/tauri.test.ts` 의 명령 표에 더한다:

```ts
      [() => backend.extensionRegistry(), "extension_registry", undefined],
      [() => backend.installExtension("/x.vsix", true), "install_extension", { path: "/x.vsix", replace: true }],
      [() => backend.removeExtension("p.x"), "remove_extension", { id: "p.x" }],
      [() => backend.setExtensionEnabled("p.x", false), "set_extension_enabled", { id: "p.x", enabled: false }],
      [() => backend.settings(), "get_settings", undefined],
      [
        () => backend.updateSettings({ workspaceRoot: null, theme: { light: null, dark: null }, extensions: { disabled: [], precedence: "user" } }),
        "update_settings",
        { settings: { workspaceRoot: null, theme: { light: null, dark: null }, extensions: { disabled: [], precedence: "user" } } },
      ],
      [() => backend.readExtensionFile("p.x", "t.json"), "read_extension_file", { extensionId: "p.x", path: "t.json" }],
```

그리고 새 `it`:

```ts
it("names bundled viewer pages by the tote-ext scheme", () => {
  expect(backend.viewerUrl("tote.markdown-preview", "viewer.html")).toBe(
    "tote-ext://localhost/tote.markdown-preview/viewer.html",
  );
});
```

`tests/e2e/editor.spec.ts` 에 더한다(언어 설정이 편집기에 닿는지 — 편집기 페이지는 `?lang=<id>` 로 번들 설정 파일을 불러온다, Step 6):

```ts
test("⌘/ toggles the line comment of the language and brackets close as configured", async ({
  page,
}) => {
  await open(page, "echo hi", "run.sh");
  await page.keyboard.press("Meta+/");
  expect(await text(page)).toBe("# echo hi");
  await page.keyboard.press("Meta+/");
  expect(await text(page)).toBe("echo hi");
  await page.keyboard.press("End");
  await page.keyboard.type(" (");
  expect(await text(page)).toBe("echo hi ()");
});

test("a language with only a block comment uses it for ⌘/", async ({ page }) => {
  await open(page, "<p>hi</p>", "a.html");
  await page.keyboard.press("Meta+/");
  expect(await text(page)).toBe("<!-- <p>hi</p> -->");
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test -- src/core/jsonc src/extensions src/editor/language-config src/backend` 와 `pnpm test:e2e -- tests/e2e/editor.spec.ts`
Expected: 모듈 없음으로 FAIL, 명령 표의 새 줄이 FAIL, E2E 둘이 FAIL(⌘/ 가 아무것도 하지 않는다 — 주석 토큰이 없다).

- [ ] **Step 3: 타입과 백엔드**

`src/backend/types.ts` 에 더한다(`PendingOpen` 아래):

```ts
/** A file a viewer or the large text viewer reads, named the way the tabs name them. */
export type FileSource = { kind: "memo"; id: string } | { kind: "external"; path: string };

// --- Extensions (src-tauri/src/extensions/registry.rs) ---------------------------------------

export interface ExtensionSummary {
  id: string;
  version: string;
  displayName: string;
  source: "bundled" | "user";
  enabled: boolean;
  path: string;
}

export interface GrammarInfo {
  scopeName: string;
  path: string;
  embeddedLanguages: Record<string, string>;
}

export interface LanguageInfo {
  id: string;
  /** The id of the extension contributing it. */
  extension: string;
  aliases: string[];
  /** Lower-case, without the dot. */
  extensions: string[];
  filenames: string[];
  firstLine: string | null;
  configuration: string | null;
  grammar: GrammarInfo | null;
}

export interface ThemeInfo {
  extension: string;
  label: string;
  /** VS Code's `uiTheme`: `vs` (light), `vs-dark`, `hc-black`, `hc-light`. */
  uiTheme: string;
  path: string;
}

export type ViewerKind = "primary" | "preview";

export interface ViewerInfo {
  extension: string;
  id: string;
  kind: ViewerKind;
  extensions: string[];
  entry: string;
}

export interface ExtensionProblem {
  path: string;
  message: string;
}

export interface GrammarRef {
  extension: string;
  language: string | null;
  scopeName: string;
  path: string;
  embeddedLanguages: Record<string, string>;
}

export interface ExtensionRegistry {
  extensions: ExtensionSummary[];
  /** In precedence order: the first language claiming a file wins. */
  languages: LanguageInfo[];
  /** Every grammar, for `include` lookups by scope name. */
  grammars: GrammarRef[];
  themes: ThemeInfo[];
  viewers: ViewerInfo[];
  problems: ExtensionProblem[];
}

export interface ThemeRef {
  extension: string;
  label: string;
}

/** `settings.json` (src-tauri/src/appdata.rs). */
export interface Settings {
  workspaceRoot: string | null;
  theme: { light: ThemeRef | null; dark: ThemeRef | null };
  extensions: { disabled: string[]; precedence: "user" | "bundled" };
}
```

`Backend` 인터페이스에 더한다(`closeWindow` 아래):

```ts
  extensionRegistry(): Promise<ExtensionRegistry>;
  /** A file inside an installed extension, by the path its manifest uses. */
  readExtensionFile(extensionId: string, path: string): Promise<Uint8Array>;
  /** `already-installed` when the id exists and `replace` is false. */
  installExtension(path: string, replace: boolean): Promise<ExtensionSummary>;
  removeExtension(id: string): Promise<void>;
  setExtensionEnabled(id: string, enabled: boolean): Promise<void>;
  settings(): Promise<Settings>;
  updateSettings(settings: Settings): Promise<void>;
  /** Where a bundled viewer page loads from. */
  viewerUrl(extensionId: string, entry: string): string;
  /** The 「확장 설치」 dialog (.vsix / .zip); null when cancelled. */
  pickExtensionPackage(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  /** Settings or the extension set changed somewhere (this window included). */
  onConfigChanged(handler: () => void): void;
```

`src/backend/tauri.ts` 에 더한다:

```ts
  extensionRegistry() {
    return call<ExtensionRegistry>("extension_registry");
  }
  async readExtensionFile(extensionId: string, path: string) {
    return bytesOf(await call<ArrayBuffer>("read_extension_file", { extensionId, path }));
  }
  installExtension(path: string, replace: boolean) {
    return call<ExtensionSummary>("install_extension", { path, replace });
  }
  removeExtension(id: string) {
    return call<void>("remove_extension", { id });
  }
  setExtensionEnabled(id: string, enabled: boolean) {
    return call<void>("set_extension_enabled", { id, enabled });
  }
  settings() {
    return call<Settings>("get_settings");
  }
  updateSettings(settings: Settings) {
    return call<void>("update_settings", { settings });
  }
  viewerUrl(extensionId: string, entry: string) {
    return `tote-ext://localhost/${encodeURIComponent(extensionId)}/${entry.split("/").map(encodeURIComponent).join("/")}`;
  }
  async pickExtensionPackage() {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "확장 패키지", extensions: ["vsix", "zip"] }],
    });
    return typeof picked === "string" ? picked : null;
  }
  async pickFolder() {
    const picked = await open({ multiple: false, directory: true });
    return typeof picked === "string" ? picked : null;
  }
  onConfigChanged(handler: () => void) {
    void this.window.listen("tote://config", () => handler());
  }
```

(`ExtensionRegistry`, `ExtensionSummary`, `Settings` 를 import 에 더한다.)

`src/backend/fake.ts`:

```ts
import fakeRegistry from "./fake-registry.json";

export interface FakeData {
  // ... existing fields ...
  settings: Settings;
  /** Extensions the fake "installed"; they contribute nothing but a row in the list. */
  userExtensions: ExtensionSummary[];
  /** What `installExtension(path)` finds at a path: the manifest identity of the package. */
  packages: Record<
    string,
    { name: string; publisher: string; version: string; displayName?: string }
  >;
  /** `"<extension id>/<path>"` → file text. Missing entries are fetched from the dev server. */
  extensionFiles: Record<string, string>;
}
```

`defaultFakeData()` 에 더한다:

```ts
    settings: { workspaceRoot: null, theme: { light: null, dark: null }, extensions: { disabled: [], precedence: "user" } },
    userExtensions: [],
    packages: {},
    extensionFiles: {},
```

`handlers` 에 `config: [] as (() => void)[]` 를 더하고, 테스트용 `config(): void { for (const h of this.handlers.config) h(); }` 를 `menu()` 옆에 둔다. `Backend` 구현:

```ts
  async extensionRegistry(): Promise<ExtensionRegistry> {
    const bundled = fakeRegistry as ExtensionRegistry;
    const user = this.data.userExtensions.map((e) => ({
      ...e,
      enabled: !this.data.settings.extensions.disabled.includes(e.id),
    }));
    return { ...bundled, extensions: [...bundled.extensions, ...user] };
  }

  async readExtensionFile(extensionId: string, path: string) {
    const text = this.data.extensionFiles[`${extensionId}/${path}`];
    if (text !== undefined) return new TextEncoder().encode(text);
    if (typeof fetch !== "function" || typeof location === "undefined")
      throw new BackendError("not-found", `${extensionId}/${path}`);
    const response = await fetch(this.viewerUrl(extensionId, path));
    if (!response.ok) throw new BackendError("not-found", `${extensionId}/${path}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async installExtension(path: string, replace: boolean) {
    const pkg = this.data.packages[path];
    if (!pkg) throw new BackendError("invalid-extension", path);
    const id = `${pkg.publisher}.${pkg.name}`;
    const existing = this.data.userExtensions.find((e) => e.id === id);
    if (existing && !replace) throw new BackendError("already-installed", `${id} ${existing.version}`);
    this.data.userExtensions = this.data.userExtensions.filter((e) => e.id !== id);
    const summary: ExtensionSummary = {
      id,
      version: pkg.version,
      displayName: pkg.displayName ?? pkg.name,
      source: "user",
      enabled: true,
      path: `/fake/extensions/${id}@${pkg.version}`,
    };
    this.data.userExtensions.push(summary);
    this.commit();
    this.config();
    return summary;
  }

  async removeExtension(id: string) {
    if (!this.data.userExtensions.some((e) => e.id === id)) throw new BackendError("not-found", id);
    this.data.userExtensions = this.data.userExtensions.filter((e) => e.id !== id);
    this.data.settings.extensions.disabled = this.data.settings.extensions.disabled.filter((d) => d !== id);
    this.commit();
    this.config();
  }

  async setExtensionEnabled(id: string, enabled: boolean) {
    const disabled = this.data.settings.extensions.disabled.filter((d) => d !== id);
    if (!enabled) disabled.push(id);
    this.data.settings.extensions.disabled = disabled;
    this.commit();
    this.config();
  }

  async settings() {
    return this.data.settings;
  }

  async updateSettings(settings: Settings) {
    this.data.settings = settings;
    this.commit();
    this.config();
  }

  viewerUrl(extensionId: string, entry: string) {
    return `/extensions/${encodeURIComponent(extensionId)}/${entry}`;
  }

  async pickExtensionPackage() {
    return this.data.picks.shift() ?? null;
  }

  async pickFolder() {
    const picked = this.data.picks.shift() ?? null;
    this.commit();
    return picked;
  }

  onConfigChanged(handler: () => void) {
    this.handlers.config.push(handler);
  }
```

(`pickExtensionPackage` 도 `this.commit()` 을 부른다. import 에 `ExtensionRegistry`, `ExtensionSummary`, `Settings` 를 더한다. `tsconfig.json` 은 이미 `resolveJsonModule` 이다.)

- [ ] **Step 4: JSONC 와 레지스트리**

`src/core/jsonc.ts`(규칙은 `src-tauri/src/extensions/jsonc.rs` 와 같다):

```ts
/** VS Code's theme and language-configuration files are JSONC. Same rules as
 * src-tauri/src/extensions/jsonc.rs: comments go, a comma before `}`/`]` goes, strings stay. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const lineEnd = (from: number) => {
    const end = text.indexOf("\n", from);
    return end === -1 ? text.length : end;
  };
  const blockEnd = (from: number) => {
    const end = text.indexOf("*/", from + 2);
    return end === -1 ? text.length : end + 2;
  };
  const nextSignificant = (from: number) => {
    let j = from;
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text.startsWith("//", j)) j = lineEnd(j);
      else if (text.startsWith("/*", j)) j = blockEnd(j);
      else return j;
    }
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === '"') {
          j++;
          break;
        } else j++;
      }
      out += text.slice(i, j);
      i = j;
    } else if (text.startsWith("//", i)) {
      i = lineEnd(i);
    } else if (text.startsWith("/*", i)) {
      i = blockEnd(i);
    } else if (ch === ",") {
      const next = text[nextSignificant(i + 1)];
      if (next !== "}" && next !== "]") out += ",";
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonc(text)) as T;
}
```

`src/extensions/registry.ts`:

```ts
import type {
  ExtensionRegistry,
  GrammarRef,
  LanguageInfo,
  ThemeInfo,
  ThemeRef,
  ViewerInfo,
  ViewerKind,
} from "../backend/types";
import { splitName } from "../core/names";

export const EMPTY_REGISTRY: ExtensionRegistry = {
  extensions: [],
  languages: [],
  grammars: [],
  themes: [],
  viewers: [],
  problems: [],
};

/** Read-side of the extension registry (spec 「설치와 로딩」): which language, viewer and theme
 * a file or setting maps to. The backend already ordered `languages` by precedence. */
export class Registry {
  constructor(readonly data: ExtensionRegistry) {}

  /** The first language claiming the exact file name, else the first claiming its extension. */
  languageForFile(fileName: string): LanguageInfo | undefined {
    const byName = this.data.languages.find((l) => l.filenames.includes(fileName));
    if (byName) return byName;
    const ext = splitName(fileName).ext.toLowerCase();
    return ext ? this.data.languages.find((l) => l.extensions.includes(ext)) : undefined;
  }

  language(id: string): LanguageInfo | undefined {
    return this.data.languages.find((l) => l.id === id);
  }

  /** For the picker: one entry per id (the winning one), by display name. */
  get languages(): LanguageInfo[] {
    const seen = new Set<string>();
    const unique = this.data.languages.filter((l) => !seen.has(l.id) && seen.add(l.id));
    return unique.sort((a, b) => label(a).localeCompare(label(b), "en"));
  }

  viewerFor(fileName: string, kind: ViewerKind): ViewerInfo | undefined {
    const ext = splitName(fileName).ext.toLowerCase();
    return ext
      ? this.data.viewers.find((v) => v.kind === kind && v.extensions.includes(ext))
      : undefined;
  }

  grammarForScope(scopeName: string): GrammarRef | undefined {
    return this.data.grammars.find((g) => g.scopeName === scopeName);
  }

  get themes(): ThemeInfo[] {
    return this.data.themes;
  }

  /** The referenced theme when it is installed, else the first theme of the appearance. */
  themeFor(ref: ThemeRef | null, appearance: "light" | "dark"): ThemeInfo | undefined {
    const wanted =
      ref && this.data.themes.find((t) => t.extension === ref.extension && t.label === ref.label);
    if (wanted) return wanted;
    const dark = (t: ThemeInfo) => t.uiTheme === "vs-dark" || t.uiTheme === "hc-black";
    return this.data.themes.find((t) => dark(t) === (appearance === "dark")) ?? this.data.themes[0];
  }
}

const label = (lang: LanguageInfo) => lang.aliases[0] ?? lang.id;

/** What the status bar shows for a file. */
export function languageLabelFor(lang: LanguageInfo | undefined, fileName: string): string {
  if (lang) return label(lang);
  const ext = splitName(fileName).ext;
  return ext ? ext.toUpperCase() : "텍스트";
}
```

- [ ] **Step 5: 언어 설정 → CodeMirror 언어 데이터**

`src/editor/language-config.ts`:

```ts
import type { CloseBracketConfig } from "@codemirror/autocomplete";
import type { CommentTokens } from "@codemirror/commands";

import { parseJsonc } from "../core/jsonc";

/** The parts of VS Code's language-configuration.json tote uses (spec 「편집기」: ⌘/, bracket
 * closing, word boundaries). */
export interface LanguageConfiguration {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: ({ open: string; close: string; notIn?: string[] } | [string, string])[];
  wordPattern?: string | { pattern: string; flags?: string };
}

/** CodeMirror's language data, the keys `toggleComment`, `closeBrackets` and the word
 * categorizer read. */
export interface LanguageData {
  commentTokens?: CommentTokens;
  closeBrackets?: CloseBracketConfig;
  wordChars?: string;
}

export const DEFAULT_LANGUAGE_DATA: LanguageData = {};

export function parseLanguageConfiguration(text: string): LanguageConfiguration {
  const raw = parseJsonc<unknown>(text);
  return raw && typeof raw === "object" ? (raw as LanguageConfiguration) : {};
}

export function languageData(config: LanguageConfiguration): LanguageData {
  const data: LanguageData = {};
  const comments: CommentTokens = {};
  if (typeof config.comments?.lineComment === "string") comments.line = config.comments.lineComment;
  const block = config.comments?.blockComment;
  if (Array.isArray(block) && block.length === 2)
    comments.block = { open: block[0], close: block[1] };
  if (comments.line || comments.block) data.commentTokens = comments;
  const pairs = (config.autoClosingPairs ?? config.brackets ?? [])
    .map((pair) => (Array.isArray(pair) ? pair[0] : pair.open))
    .filter((open): open is string => typeof open === "string" && open.length > 0);
  if (pairs.length) data.closeBrackets = { brackets: [...new Set(pairs)] };
  const pattern = wordPattern(config.wordPattern);
  if (pattern) {
    const chars = wordCharsFor(pattern);
    if (chars) data.wordChars = chars;
  }
  return data;
}

function wordPattern(raw: LanguageConfiguration["wordPattern"]): RegExp | null {
  const source = typeof raw === "string" ? raw : raw?.pattern;
  if (typeof source !== "string") return null;
  try {
    return new RegExp(source, typeof raw === "object" ? (raw.flags ?? "") : "");
  } catch {
    return null;
  }
}

/** CodeMirror takes word characters as a string of extra characters, VS Code as a pattern.
 * The ASCII punctuation the pattern accepts as a whole word is what counts as extra here. */
export function wordCharsFor(pattern: RegExp): string {
  const whole = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gy]/g, ""));
  let chars = "";
  for (let code = 0x21; code <= 0x7e; code++) {
    const ch = String.fromCharCode(code);
    if (/[A-Za-z0-9_]/.test(ch)) continue;
    if (whole.test(ch)) chars += ch;
  }
  return chars;
}
```

`src/editor/setup.ts` — 언어 데이터용 Compartment 를 더한다:

```ts
import { DEFAULT_LANGUAGE_DATA, type LanguageData } from "./language-config";

const configuration = new Compartment();

function languageDataExtension(data: LanguageData): Extension {
  return EditorState.languageData.of(() => [data]);
}

/** Swaps the language-configuration data of a state built by `editorExtensions`. */
export function languageDataEffect(data: LanguageData) {
  return configuration.reconfigure(languageDataExtension(data));
}
```

`EditorOptions` 에 `languageData?: LanguageData` 를 더하고, `editorExtensions` 의 배열에서 `language.of(languageFor(options.fileName))` 다음에 `configuration.of(languageDataExtension(options.languageData ?? DEFAULT_LANGUAGE_DATA))` 를 넣는다. `defaultKeymap` 의 `Mod-/` 가 `toggleComment` 이고 `closeBrackets()` 가 `closeBrackets` 언어 데이터를 읽으므로 그 밖은 바꿀 것이 없다.

- [ ] **Step 6: 편집기 테스트 페이지가 번들 언어 설정을 쓴다**

`tests/e2e/pages/editor.ts` 의 뷰 생성 앞에 넣는다(개발 서버가 `/extensions/` 를 내므로 가짜 백엔드 없이 fetch 한다):

```ts
import fakeRegistry from "../../../src/backend/fake-registry.json";
import type { ExtensionRegistry } from "../../../src/backend/types";
import { languageData, parseLanguageConfiguration } from "../../../src/editor/language-config";
import { Registry } from "../../../src/extensions/registry";

const params = new URLSearchParams(location.search);
const fileName = params.get("file") ?? "note.md";
const lang = new Registry(fakeRegistry as ExtensionRegistry).languageForFile(fileName);
const config =
  lang?.configuration && (await fetch(`/extensions/${lang.extension}/${lang.configuration}`)).ok
    ? parseLanguageConfiguration(
        await (await fetch(`/extensions/${lang.extension}/${lang.configuration}`)).text(),
      )
    : {};
```

`editorExtensions({ fileName, wrap: true, onUpdate: () => {}, languageData: languageData(config) })` 로 바꾼다(`await` 는 모듈 최상위에서 된다 — `<script type="module">`).

- [ ] **Step 7: 통과 확인**

Run: `pnpm test` 와 `pnpm test:e2e -- tests/e2e/editor.spec.ts`
Expected: Vitest 새 테스트 12개 포함 PASS(개수), E2E 둘 PASS. `pnpm typecheck` 깨끗.

- [ ] **Step 8: 커밋**

```bash
pnpm exec oxfmt src/backend src/core src/extensions src/editor tests/e2e
pnpm exec oxlint --fix src/backend src/core src/extensions src/editor tests/e2e
git add src/backend/types.ts src/backend/tauri.ts src/backend/tauri.test.ts src/backend/fake.ts src/core/jsonc.ts src/core/jsonc.test.ts src/extensions/registry.ts src/extensions/registry.test.ts src/editor/language-config.ts src/editor/language-config.test.ts src/editor/setup.ts tests/e2e/pages/editor.ts tests/e2e/editor.spec.ts
git commit -m "feat(frontend): extension registry lookups, JSONC, and language configuration in the editor"
```

---

### Task 7: 테마 — VS Code `colors` → CSS 변수, `tokenColors` → TextMate 테마, OS 모양 따르기

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`, `src/styles.css`, `src/editor/setup.ts`, `src/app/controller.ts`, `src/main.ts`
- Create: `src/theme/vscode-theme.ts`, `src/theme/vscode-theme.test.ts`, `src/theme/manager.ts`, `src/theme/manager.test.ts`

**Interfaces:**

- Consumes: Task 6 의 `Registry`·`Backend.readExtensionFile`·`Backend.settings`·`onConfigChanged`, `parseJsonc`.
- Produces (`src/theme/vscode-theme.ts`): `VsCodeTheme { name?: string; type?: string; colors: Record<string, string>; tokenColors: TokenColor[] }`, `TokenColor { name?; scope?: string | string[]; settings: { foreground?; background?; fontStyle? } }`, `Appearance = "light" | "dark"`, `CSS_VARIABLES: { variable: string; keys: string[] }[]`, `DEFAULT_VARIABLES: Record<Appearance, Record<string, string>>`, `themeVariables(theme: Pick<VsCodeTheme, "colors">, appearance: Appearance): Record<string, string>`, `loadTheme(read: (path: string) => Promise<string>, path: string): Promise<VsCodeTheme>`(JSONC, `include` 를 최대 5단계 따라간다), `tokenTheme(theme: VsCodeTheme): IRawTheme`(`@shikijs/vscode-textmate` 의 형식 — `settings[0]` 이 기본 전경·배경).
- Produces (`src/theme/manager.ts`): `ActiveTheme { info: ThemeInfo | null; theme: VsCodeTheme | null; appearance: Appearance; variables: Record<string, string> }`, `class ThemeManager { constructor(backend: Backend, registry: () => Registry, options?: { media?: Pick<MediaQueryList, "matches" | "addEventListener">; apply?: (active: ActiveTheme) => void }); start(): Promise<void>; refresh(): Promise<void>; readonly active: ActiveTheme; onChange(listener: (active: ActiveTheme) => void): void }`, `applyToDocument(active: ActiveTheme): void`.
- `AppController` gains `readonly registry: Registry`(시작 때 `extensionRegistry()` 로 채우고 `onConfigChanged` 마다 다시 받는다)와 `readonly theme: ThemeManager`.

- [ ] **Step 1: 의존성**

```bash
pnpm add @shikijs/vscode-textmate@^10.0.2 @shikijs/engine-oniguruma@^4.5.0
```

`@shikijs/vscode-textmate` 는 `IRawTheme` 타입과 Task 8 의 `Registry`·`INITIAL`·`EncodedTokenMetadata`, `@shikijs/engine-oniguruma` 는 Oniguruma WASM 엔진이다(둘 다 shiki 가 내는 패키지 — 스파이크의 `shiki/engine/oniguruma`·`shiki/wasm` 이 이것을 다시 export 한 것이다).

- [ ] **Step 2: 실패하는 테스트**

`src/theme/vscode-theme.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { DEFAULT_VARIABLES, loadTheme, themeVariables, tokenTheme } from "./vscode-theme";

describe("themeVariables", () => {
  it("maps the colour keys tote uses and falls back per key to the appearance's default", () => {
    const vars = themeVariables(
      {
        colors: {
          "editor.background": "#1E1E1E",
          "editor.foreground": "#D4D4D4",
          "sideBar.background": "#252526",
          "editor.selectionBackground": "#264F78",
          focusBorder: "#007FD4",
          "editor.lineHighlightBackground": "#ffffff0A",
        },
      },
      "dark",
    );
    expect(vars["--bg"]).toBe("#1E1E1E");
    expect(vars["--fg"]).toBe("#D4D4D4");
    expect(vars["--sidebar-bg"]).toBe("#252526");
    expect(vars["--selection"]).toBe("#264F78");
    expect(vars["--accent"]).toBe("#007FD4");
    expect(vars["--active-line"]).toBe("#ffffff0A");
    // Not in the theme: the dark default, not the light one and not undefined.
    expect(vars["--danger"]).toBe(DEFAULT_VARIABLES.dark["--danger"]);
    expect(vars["--cursor"]).toBe("#D4D4D4"); // falls through editorCursor.foreground to the foreground
    expect(Object.keys(vars).sort()).toEqual(Object.keys(DEFAULT_VARIABLES.light).sort());
  });

  it("takes the first key present in a key list", () => {
    const vars = themeVariables(
      { colors: { "textLink.foreground": "#3794FF", "button.background": "#0E639C" } },
      "light",
    );
    expect(vars["--accent"]).toBe("#0E639C");
  });
});

describe("loadTheme", () => {
  it("resolves an include and reads JSONC", async () => {
    const files: Record<string, string> = {
      "themes/dark.json": `{
        // the real Dark Modern does exactly this
        "include": "./dark_vs.json",
        "colors": { "editor.background": "#1F1F1F", },
        "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#569CD6" } },],
      }`,
      "themes/dark_vs.json": `{
        "colors": { "editor.background": "#1E1E1E", "editor.foreground": "#D4D4D4" },
        "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#6A9955" } }]
      }`,
    };
    const theme = await loadTheme(
      async (path) => files[path] ?? Promise.reject(new Error(path)),
      "themes/dark.json",
    );
    expect(theme.colors).toEqual({
      "editor.background": "#1F1F1F",
      "editor.foreground": "#D4D4D4",
    });
    expect(theme.tokenColors.map((t) => t.scope)).toEqual(["comment", "keyword"]);
  });

  it("stops following includes that loop", async () => {
    const files: Record<string, string> = {
      "a.json": `{ "include": "./b.json" }`,
      "b.json": `{ "include": "./a.json", "colors": {} }`,
    };
    const theme = await loadTheme(async (path) => files[path], "a.json");
    expect(theme.colors).toEqual({});
  });

  it("tolerates a theme without colors or tokenColors", async () => {
    const theme = await loadTheme(async () => `{ "name": "bare" }`, "bare.json");
    expect(theme).toEqual({ name: "bare", colors: {}, tokenColors: [] });
  });
});

describe("tokenTheme", () => {
  it("puts the editor colours first and keeps the token rules in order", () => {
    const raw = tokenTheme({
      name: "t",
      colors: { "editor.foreground": "#ccc", "editor.background": "#111" },
      tokenColors: [
        { scope: "comment", settings: { foreground: "#888", fontStyle: "italic" } },
        { settings: { foreground: "#eee" } }, // a global rule without scope: VS Code themes start with these
        { scope: ["keyword", "storage"], settings: {} },
      ],
    });
    expect(raw.name).toBe("t");
    expect(raw.settings[0]).toEqual({ settings: { foreground: "#ccc", background: "#111" } });
    expect(raw.settings.slice(1)).toEqual([
      { scope: "comment", settings: { foreground: "#888", fontStyle: "italic" } },
      { settings: { foreground: "#eee" } },
      { scope: ["keyword", "storage"], settings: {} },
    ]);
  });
});
```

`src/theme/manager.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { defaultFakeData, FakeBackend, memoryStorage } from "../backend/fake";
import type { ExtensionRegistry } from "../backend/types";
import { Registry } from "../extensions/registry";
import { ThemeManager, type ActiveTheme } from "./manager";

const registry = new Registry({
  extensions: [],
  languages: [],
  grammars: [],
  themes: [
    { extension: "tote.themes", label: "Light+", uiTheme: "vs", path: "themes/light.json" },
    { extension: "tote.themes", label: "Dark+", uiTheme: "vs-dark", path: "themes/dark.json" },
    { extension: "someone.night", label: "Night", uiTheme: "vs-dark", path: "night.json" },
  ],
  viewers: [],
  problems: [],
} as ExtensionRegistry);

function media(dark: boolean) {
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  return {
    query: {
      matches: dark,
      addEventListener: (_: "change", fn: (e: { matches: boolean }) => void) =>
        void listeners.push(fn),
    },
    flip(toDark: boolean) {
      this.query.matches = toDark;
      for (const fn of listeners) fn({ matches: toDark });
    },
  };
}

function setup(dark: boolean) {
  const backend = new FakeBackend(
    memoryStorage(
      JSON.stringify({
        ...defaultFakeData(),
        extensionFiles: {
          "tote.themes/themes/light.json": `{ "colors": { "editor.background": "#ffffff" }, "tokenColors": [] }`,
          "tote.themes/themes/dark.json": `{ "colors": { "editor.background": "#1e1e1e" }, "tokenColors": [] }`,
          "someone.night/night.json": `{ "colors": { "editor.background": "#000000" } }`,
        },
      }),
    ),
  );
  const applied: ActiveTheme[] = [];
  const m = media(dark);
  const manager = new ThemeManager(backend, () => registry, {
    media: m.query,
    apply: (a) => void applied.push(a),
  });
  return { backend, manager, applied, media: m };
}

describe("ThemeManager", () => {
  it("picks the theme for the OS appearance and follows a change", async () => {
    const { manager, applied, media } = setup(false);
    await manager.start();
    expect(manager.active.info?.label).toBe("Light+");
    expect(manager.active.variables["--bg"]).toBe("#ffffff");
    expect(applied).toHaveLength(1);
    media.flip(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.active.info?.label).toBe("Dark+");
    expect(manager.active.variables["--bg"]).toBe("#1e1e1e");
    expect(manager.active.appearance).toBe("dark");
  });

  it("uses the configured theme and re-reads it when the settings change", async () => {
    const { backend, manager, media } = setup(true);
    await manager.start();
    expect(manager.active.info?.label).toBe("Dark+");
    const changes: string[] = [];
    manager.onChange((a) => void changes.push(a.info?.label ?? "none"));
    backend.data.settings.theme.dark = { extension: "someone.night", label: "Night" };
    await manager.refresh();
    expect(manager.active.info?.label).toBe("Night");
    expect(manager.active.variables["--bg"]).toBe("#000000");
    expect(changes).toEqual(["Night"]);
    media.flip(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(changes).toEqual(["Night", "Light+"]);
  });

  it("falls back to the defaults when the theme file cannot be read", async () => {
    const { backend, manager } = setup(true);
    delete backend.data.extensionFiles["tote.themes/themes/dark.json"];
    await manager.start();
    expect(manager.active.theme).toBeNull();
    expect(manager.active.variables["--bg"]).toBe("#1e1f22");
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm test -- src/theme`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현 — `vscode-theme.ts`**

```ts
import type { IRawTheme } from "@shikijs/vscode-textmate";

import { parseJsonc } from "../core/jsonc";

export type Appearance = "light" | "dark";

export interface TokenColor {
  name?: string;
  scope?: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

/** A VS Code colour theme (`contributes.themes[].path`), with any `include` already folded in. */
export interface VsCodeTheme {
  name?: string;
  type?: string;
  colors: Record<string, string>;
  tokenColors: TokenColor[];
}

/** The CSS variables styles.css uses and the VS Code colour keys that fill them, first present
 * key wins (spec 「테마」: only the keys tote's UI has a use for). */
export const CSS_VARIABLES: { variable: string; keys: string[] }[] = [
  { variable: "--bg", keys: ["editor.background"] },
  { variable: "--fg", keys: ["editor.foreground", "foreground"] },
  {
    variable: "--muted",
    keys: ["descriptionForeground", "disabledForeground", "tab.inactiveForeground"],
  },
  {
    variable: "--border",
    keys: ["editorGroup.border", "panel.border", "sideBar.border", "contrastBorder"],
  },
  { variable: "--accent", keys: ["button.background", "focusBorder", "textLink.foreground"] },
  { variable: "--danger", keys: ["errorForeground", "editorError.foreground"] },
  { variable: "--sidebar-bg", keys: ["sideBar.background", "editorGroupHeader.tabsBackground"] },
  {
    variable: "--active-bg",
    keys: ["list.activeSelectionBackground", "list.inactiveSelectionBackground"],
  },
  { variable: "--active-line", keys: ["editor.lineHighlightBackground"] },
  { variable: "--selection", keys: ["editor.selectionBackground"] },
  { variable: "--selection-match", keys: ["editor.selectionHighlightBackground"] },
  { variable: "--cursor", keys: ["editorCursor.foreground", "editor.foreground", "foreground"] },
  { variable: "--panel-bg", keys: ["editorWidget.background", "sideBar.background"] },
];

/** The values styles.css carries for each appearance; the theme overrides key by key. */
export const DEFAULT_VARIABLES: Record<Appearance, Record<string, string>> = {
  light: {
    "--bg": "#ffffff",
    "--fg": "#1f2328",
    "--muted": "#6e7781",
    "--border": "#d8dee4",
    "--accent": "#0969da",
    "--danger": "#cf222e",
    "--sidebar-bg": "#f6f8fa",
    "--active-bg": "#dbeafe",
    "--active-line": "rgb(0 0 0 / 3%)",
    "--selection": "#b6d6fd",
    "--selection-match": "rgb(255 200 0 / 25%)",
    "--cursor": "#1f2328",
    "--panel-bg": "#f6f8fa",
  },
  dark: {
    "--bg": "#1e1f22",
    "--fg": "#dcdee3",
    "--muted": "#8b9099",
    "--border": "#34363c",
    "--accent": "#4c9aff",
    "--danger": "#ff7b72",
    "--sidebar-bg": "#191a1d",
    "--active-bg": "#263449",
    "--active-line": "rgb(255 255 255 / 4%)",
    "--selection": "#2f4f7a",
    "--selection-match": "rgb(255 200 0 / 18%)",
    "--cursor": "#dcdee3",
    "--panel-bg": "#191a1d",
  },
};

export function themeVariables(
  theme: Pick<VsCodeTheme, "colors">,
  appearance: Appearance,
): Record<string, string> {
  const vars = { ...DEFAULT_VARIABLES[appearance] };
  for (const { variable, keys } of CSS_VARIABLES) {
    const key = keys.find((k) => typeof theme.colors[k] === "string" && theme.colors[k] !== "");
    if (key) vars[variable] = theme.colors[key];
  }
  return vars;
}

const INCLUDE_DEPTH = 5;

/** Reads a theme file with `read` (paths relative to the extension folder). An `include` is
 * read first and this file's colours and rules go over it, as VS Code does. */
export async function loadTheme(
  read: (path: string) => Promise<string>,
  path: string,
): Promise<VsCodeTheme> {
  return loadThemeAt(read, path, new Set());
}

async function loadThemeAt(
  read: (path: string) => Promise<string>,
  path: string,
  seen: Set<string>,
): Promise<VsCodeTheme> {
  const raw = parseJsonc<Partial<VsCodeTheme> & { include?: string }>(await read(path)) ?? {};
  let base: VsCodeTheme = { colors: {}, tokenColors: [] };
  if (typeof raw.include === "string" && seen.size < INCLUDE_DEPTH && !seen.has(path)) {
    seen.add(path);
    const included = resolveRelative(path, raw.include);
    if (!seen.has(included)) base = await loadThemeAt(read, included, seen);
  }
  const theme: VsCodeTheme = {
    colors: { ...base.colors, ...(isRecord(raw.colors) ? raw.colors : {}) },
    tokenColors: [
      ...base.tokenColors,
      ...(Array.isArray(raw.tokenColors) ? raw.tokenColors.filter(isTokenColor) : []),
    ],
  };
  const name = raw.name ?? base.name;
  if (name) theme.name = name;
  const type = raw.type ?? base.type;
  if (type) theme.type = type;
  return theme;
}

function resolveRelative(from: string, include: string): string {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  const parts: string[] = [];
  for (const part of (dir + include).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

const isRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isTokenColor = (v: unknown): v is TokenColor =>
  isRecord(v) && isRecord((v as { settings?: unknown }).settings);

/** The theme as the TextMate registry takes it: the editor's own colours as the first,
 * scope-less rule, then the token rules. */
export function tokenTheme(theme: VsCodeTheme): IRawTheme {
  const base: TokenColor["settings"] = {};
  if (theme.colors["editor.foreground"]) base.foreground = theme.colors["editor.foreground"];
  if (theme.colors["editor.background"]) base.background = theme.colors["editor.background"];
  return { name: theme.name, settings: [{ settings: base }, ...theme.tokenColors] };
}
```

- [ ] **Step 5: 구현 — `manager.ts`**

```ts
import type { Backend, ThemeInfo, ThemeRef } from "../backend/types";
import type { Registry } from "../extensions/registry";
import {
  DEFAULT_VARIABLES,
  loadTheme,
  themeVariables,
  type Appearance,
  type VsCodeTheme,
} from "./vscode-theme";

export interface ActiveTheme {
  info: ThemeInfo | null;
  /** null when no theme could be read: the defaults of `appearance` apply. */
  theme: VsCodeTheme | null;
  appearance: Appearance;
  variables: Record<string, string>;
}

type Media = Pick<MediaQueryList, "matches" | "addEventListener">;

/** Which theme is on (spec 「테마」): the configured one for the OS appearance, re-read when the
 * appearance or the settings change. `apply` puts the variables on the page; viewers and the
 * highlighter follow through `onChange`. */
export class ThemeManager {
  active: ActiveTheme = {
    info: null,
    theme: null,
    appearance: "light",
    variables: DEFAULT_VARIABLES.light,
  };
  private readonly listeners: ((active: ActiveTheme) => void)[] = [];
  private readonly media: Media;
  private readonly apply: (active: ActiveTheme) => void;
  private generation = 0;

  constructor(
    private readonly backend: Backend,
    private readonly registry: () => Registry,
    options: { media?: Media; apply?: (active: ActiveTheme) => void } = {},
  ) {
    this.media = options.media ?? window.matchMedia("(prefers-color-scheme: dark)");
    this.apply = options.apply ?? applyToDocument;
  }

  async start(): Promise<void> {
    this.media.addEventListener("change", () => void this.refresh());
    await this.refresh();
  }

  onChange(listener: (active: ActiveTheme) => void): void {
    this.listeners.push(listener);
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const appearance: Appearance = this.media.matches ? "dark" : "light";
    const settings = await this.backend.settings();
    const ref: ThemeRef | null = settings.theme[appearance];
    const info = this.registry().themeFor(ref, appearance) ?? null;
    let theme: VsCodeTheme | null = null;
    if (info) {
      try {
        theme = await loadTheme(
          async (path) =>
            new TextDecoder().decode(await this.backend.readExtensionFile(info.extension, path)),
          info.path,
        );
      } catch (error) {
        console.error(`theme ${info.label} could not be read`, error);
      }
    }
    // A slower refresh must not land over a newer one.
    if (generation !== this.generation) return;
    const variables = theme
      ? themeVariables(theme, appearance)
      : { ...DEFAULT_VARIABLES[appearance] };
    this.active = { info: theme ? info : null, theme, appearance, variables };
    this.apply(this.active);
    for (const listener of this.listeners) listener(this.active);
  }
}

export function applyToDocument(active: ActiveTheme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(active.variables)) root.style.setProperty(name, value);
  root.dataset.appearance = active.appearance;
  root.style.colorScheme = active.appearance;
}
```

- [ ] **Step 6: 연결**

`src/styles.css` 의 `:root` 와 다크 블록에 `--cursor` 와 `--panel-bg` 를 더한다(`DEFAULT_VARIABLES` 와 같은 값). `src/editor/setup.ts` 의 `appTheme` 에서 캐럿 색을 `var(--cursor)` 로, `.cm-panels` 의 배경을 `var(--panel-bg)` 로 바꾼다.

`src/app/controller.ts`:

```ts
import { EMPTY_REGISTRY, Registry } from "../extensions/registry";
import { ThemeManager } from "../theme/manager";
```

필드:

```ts
  registry = new Registry(EMPTY_REGISTRY);
  readonly theme = new ThemeManager(this.backend, () => this.registry);
```

`start()` 에서 `workspaceInfo()` 다음에:

```ts
await this.loadRegistry();
this.backend.onConfigChanged(() => void this.onConfigChanged());
await this.theme.start();
```

메서드:

```ts
  private async loadRegistry(): Promise<void> {
    try {
      this.registry = new Registry(await this.backend.extensionRegistry());
    } catch (error) {
      this.report(error);
    }
  }

  /** Settings or extensions changed (this window's settings screen or another's). */
  private async onConfigChanged(): Promise<void> {
    await this.loadRegistry();
    await this.theme.refresh();
  }
```

(`readonly backend` 가 생성자 매개변수 프로퍼티라 필드 초기화에서 쓸 수 있다.)

- [ ] **Step 7: 통과 확인**

Run: `pnpm test -- src/theme` 와 `pnpm test:e2e`
Expected: Vitest 10개 PASS(개수), 기존 E2E 전부 PASS. `pnpm dev` 로 브라우저에서 열어 OS 모양을 바꾸면 배경·글자색이 Light+/Dark+ 값으로 바뀐다(가짜 백엔드는 `/extensions/tote.themes/themes/*.json` 을 fetch 한다).

- [ ] **Step 8: 커밋**

```bash
pnpm exec oxfmt src/theme src/styles.css src/editor/setup.ts src/app/controller.ts
pnpm exec oxlint --fix src/theme src/editor src/app
git add package.json pnpm-lock.yaml src/theme src/styles.css src/editor/setup.ts src/app/controller.ts
git commit -m "feat(theme): map VS Code themes to CSS variables and follow the OS appearance"
```

---

### Task 8: 하이라이트 — Worker 안의 TextMate 토큰화(Oniguruma), 줄 상태 캐시, CodeMirror 장식

**Files:**

- Modify: `src/editor/setup.ts`, `src/app/controller.ts`, `src/app/docs.ts`, `src/app/docs.test.ts`, `src/styles.css`, `tests/e2e/pages/editor.ts`, `tests/e2e/globals.d.ts`
- Create: `src/highlight/protocol.ts`, `src/highlight/tokenizer.ts`, `src/highlight/tokenizer.test.ts`, `src/highlight/grammars.ts`, `src/highlight/grammars.test.ts`, `src/highlight/worker.ts`, `src/highlight/client.ts`, `src/highlight/extension.ts`, `tests/e2e/highlight.spec.ts`

**Interfaces:**

- Consumes: `Registry.grammarForScope`·`languageForFile`, `Backend.readExtensionFile`, `ThemeManager.onChange`·`tokenTheme`, `LanguageInfo`.
- Produces (`src/highlight/protocol.ts`): `GrammarSource { scopeName: string; grammar: IRawGrammar }`, `WorkerRequest = { type: "theme"; theme: IRawTheme } | { type: "grammars"; grammars: GrammarSource[] } | { type: "open"; doc: number; scopeName: string; text: string } | { type: "edit"; doc: number; fromLine: number; toLine: number; insert: string[] } | { type: "tokens"; doc: number; req: number; from: number; to: number } | { type: "close"; doc: number }`, `WorkerReply = { type: "theme-ready"; colorMap: string[] } | { type: "opened"; doc: number; ok: boolean; message?: string } | { type: "tokens"; doc: number; req: number; from: number; lines: Uint32Array[] } | { type: "error"; doc?: number; req?: number; message: string }`. 줄 하나의 토큰은 `[start, foreground, fontStyle]` 셋씩의 `Uint32Array`.
- Produces (`src/highlight/tokenizer.ts`): `MAX_TOKENIZED_LINE_LENGTH = 20_000`, `class LineTokenizer { constructor(grammar: IGrammar, text: string); get lineCount(): number; get cachedLines(): number; edit(fromLine: number, toLine: number, insert: string[]): void; tokens(from: number, to: number): Uint32Array[]; advance(budgetMs: number): boolean; reset(): void }`, `encodeLine(tokens: Uint32Array): Uint32Array`.
- Produces (`src/highlight/grammars.ts`): `collectIncludes(grammar: unknown): string[]`, `collectGrammars(registry: Registry, lang: LanguageInfo, read: (extensionId: string, path: string) => Promise<Uint8Array>): Promise<GrammarSource[]>`.
- Produces (`src/highlight/client.ts`): `class HighlightClient { constructor(worker: Worker, registry: () => Registry, read: (extensionId: string, path: string) => Promise<Uint8Array>); colorMap: string[]; setTheme(theme: IRawTheme): Promise<void>; open(doc: number, lang: LanguageInfo, text: string): Promise<boolean>; edit(doc: number, fromLine: number, toLine: number, insert: string[]): void; tokens(doc: number, from: number, to: number): Promise<Uint32Array[] | null>; close(doc: number): void; nextDocId(): number }`, `installColorStyles(colorMap: string[]): void`.
- Produces (`src/highlight/extension.ts`): `workerHighlighting(client: HighlightClient, lang: LanguageInfo): Extension`, `HIGHLIGHT_LIMIT_CHARS = 20_000_000`.
- Produces (`src/editor/setup.ts`): `EditorOptions` gains `highlight?: Extension`.
- `AppController` gains `readonly highlight: HighlightClient`; `DocHost.extensions` 가 하이라이트를 결정한다.

- [ ] **Step 1: 실패하는 테스트 — 토크나이저(Vitest, Node 에서 실제 Oniguruma)**

`src/highlight/tokenizer.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import { Registry, type IGrammar, type IOnigLib, type IRawGrammar } from "@shikijs/vscode-textmate";
import { beforeAll, describe, expect, it } from "vitest";

import { LineTokenizer, MAX_TOKENIZED_LINE_LENGTH } from "./tokenizer";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/fixtures/vsix-src/extension/syntaxes/tote.tmLanguage.json",
);

let grammar: IGrammar;
let colorMap: string[];
const COMMENT = "#808080";
const KEYWORD = "#ff9966";
const STRING = "#ce9178";
const BASE = "#f0f0f0";

beforeAll(async () => {
  const engine = await createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined"));
  const onigLib: IOnigLib = {
    createOnigScanner: (sources) => engine.createScanner(sources),
    createOnigString: (s) => engine.createString(s),
  };
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as IRawGrammar;
  const registry = new Registry({
    onigLib,
    loadGrammar: (scope) => (scope === "source.tote" ? raw : null),
    theme: {
      settings: [
        { settings: { foreground: BASE } },
        { scope: "comment", settings: { foreground: COMMENT, fontStyle: "italic" } },
        { scope: "keyword", settings: { foreground: KEYWORD } },
        { scope: "string", settings: { foreground: STRING } },
      ],
    },
  });
  grammar = registry.loadGrammar("source.tote")!;
  colorMap = registry.getColorMap();
});

/** `[start, colour, italic?]` per token, colours resolved through the colour map. */
function decode(line: Uint32Array): [number, string, boolean][] {
  const out: [number, string, boolean][] = [];
  for (let i = 0; i < line.length; i += 3)
    out.push([line[i], colorMap[line[i + 1]], (line[i + 2] & 1) === 1]);
  return out;
}

describe("LineTokenizer", () => {
  it("colours keywords and comments and carries a string across lines", () => {
    const t = new LineTokenizer(grammar, 'let x = "multi\nline" # note\nfn');
    const lines = t.tokens(0, 3);
    expect(decode(lines[0])).toEqual([
      [0, KEYWORD, false],
      [3, BASE, false],
      [8, STRING, false],
    ]);
    // Line 2 starts inside the string the first line opened.
    expect(decode(lines[1])[0]).toEqual([0, STRING, false]);
    expect(decode(lines[1]).at(-1)).toEqual([6, COMMENT, true]);
    expect(decode(lines[2])).toEqual([[0, KEYWORD, false]]);
    expect(t.cachedLines).toBe(3);
  });

  it("tokenizes forward only as far as asked and keeps what it did", () => {
    const t = new LineTokenizer(
      grammar,
      Array.from({ length: 10 }, (_, i) => `fn f${i}`).join("\n"),
    );
    expect(t.cachedLines).toBe(0);
    t.tokens(4, 6);
    expect(t.cachedLines).toBe(6);
    t.tokens(2, 3); // already cached: nothing new
    expect(t.cachedLines).toBe(6);
  });

  it("an edit drops the cache from the edited line on, and only from there", () => {
    const t = new LineTokenizer(grammar, "let a\nlet b\nlet c\nlet d");
    t.tokens(0, 4);
    t.edit(2, 3, ["# now a comment", "let e"]);
    expect(t.lineCount).toBe(5);
    expect(t.cachedLines).toBe(2);
    const lines = t.tokens(0, 5);
    expect(decode(lines[2])[0][1]).toBe(COMMENT);
    expect(decode(lines[3])[0][1]).toBe(KEYWORD);
    expect(decode(lines[4])[0][1]).toBe(KEYWORD);
  });

  it("leaves a line over the limit without tokens and carries the state past it", () => {
    const long = "x".repeat(MAX_TOKENIZED_LINE_LENGTH + 1);
    const t = new LineTokenizer(grammar, `"open\n${long}\nstill string" fn`);
    const lines = t.tokens(0, 3);
    expect(lines[1].length).toBe(0);
    expect(decode(lines[2])[0][1]).toBe(STRING);
    expect(t.cachedLines).toBe(3);
  });

  it("advance works ahead in slices until the whole document is cached", () => {
    const t = new LineTokenizer(
      grammar,
      Array.from({ length: 300 }, () => "let x = 1 # c").join("\n"),
    );
    let done = false;
    let rounds = 0;
    while (!done && rounds < 1000) {
      done = t.advance(1);
      rounds++;
    }
    expect(done).toBe(true);
    expect(t.cachedLines).toBe(300);
    expect(t.advance(1)).toBe(true);
    t.reset();
    expect(t.cachedLines).toBe(0);
  });

  it("an empty document has one empty line", () => {
    const t = new LineTokenizer(grammar, "");
    expect(t.lineCount).toBe(1);
    expect(t.tokens(0, 1)).toEqual([new Uint32Array()]);
  });
});
```

`src/highlight/grammars.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { ExtensionRegistry, LanguageInfo } from "../backend/types";
import { Registry } from "../extensions/registry";
import { collectGrammars, collectIncludes } from "./grammars";

describe("collectIncludes", () => {
  it("finds external scopes anywhere in the grammar and skips local references", () => {
    const grammar = {
      scopeName: "source.a",
      patterns: [
        { include: "#x" },
        { include: "$self" },
        { include: "source.b" },
        { include: "text.c#frag" },
      ],
      repository: {
        x: {
          patterns: [
            { include: "source.b" },
            { begin: "a", end: "b", patterns: [{ include: "source.d" }] },
          ],
        },
      },
    };
    expect(collectIncludes(grammar)).toEqual(["source.b", "text.c", "source.d"]);
  });
});

describe("collectGrammars", () => {
  const registry = new Registry({
    extensions: [],
    languages: [],
    grammars: [
      {
        extension: "e",
        language: "a",
        scopeName: "source.a",
        path: "a.json",
        embeddedLanguages: {},
      },
      {
        extension: "e",
        language: null,
        scopeName: "source.b",
        path: "b.json",
        embeddedLanguages: {},
      },
      {
        extension: "e",
        language: "c",
        scopeName: "source.c",
        path: "c.json",
        embeddedLanguages: {},
      },
    ],
    themes: [],
    viewers: [],
    problems: [],
  } as ExtensionRegistry);
  const lang: LanguageInfo = {
    id: "a",
    extension: "e",
    aliases: ["A"],
    extensions: ["a"],
    filenames: [],
    firstLine: null,
    configuration: null,
    grammar: { scopeName: "source.a", path: "a.json", embeddedLanguages: {} },
  };
  const files: Record<string, string> = {
    "e/a.json": JSON.stringify({
      scopeName: "source.a",
      patterns: [{ include: "source.b" }, { include: "source.nobody" }],
    }),
    "e/b.json": JSON.stringify({ scopeName: "source.b", patterns: [{ include: "source.c" }] }),
    "e/c.json": JSON.stringify({ scopeName: "source.c", patterns: [{ include: "source.a" }] }),
  };
  const read = async (ext: string, path: string) => {
    const text = files[`${ext}/${path}`];
    if (text === undefined) throw new Error(`${ext}/${path}`);
    return new TextEncoder().encode(text);
  };

  it("loads the grammar and, transitively, the included ones the registry knows", async () => {
    const sources = await collectGrammars(registry, lang, read);
    expect(sources.map((s) => s.scopeName)).toEqual(["source.a", "source.b", "source.c"]);
  });

  it("an include of a scope nobody provides is ignored", async () => {
    const sources = await collectGrammars(registry, lang, read);
    expect(sources.some((s) => s.scopeName === "source.nobody")).toBe(false);
  });

  it("fails when the language's own grammar cannot be read, not when an included one cannot", async () => {
    await expect(
      collectGrammars(registry, lang, async () => Promise.reject(new Error("io"))),
    ).rejects.toThrow();
    const partial = async (ext: string, path: string) =>
      path === "c.json" ? Promise.reject(new Error("io")) : read(ext, path);
    const sources = await collectGrammars(registry, lang, partial);
    expect(sources.map((s) => s.scopeName)).toEqual(["source.a", "source.b"]);
  });

  it("a language without a grammar gives nothing", async () => {
    expect(await collectGrammars(registry, { ...lang, grammar: null }, read)).toEqual([]);
  });
});
```

`tests/e2e/highlight.spec.ts`(편집기 페이지가 `?highlight=1` 일 때 Worker 를 띄운다 — Step 7):

```ts
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, doc: string, file: string, extra = "") {
  await page.goto(
    `/tests/e2e/pages/editor.html?highlight=1&file=${encodeURIComponent(file)}&doc=${encodeURIComponent(doc)}${extra}`,
  );
  await expect(page.locator(".cm-content")).toBeFocused();
}

const coloured = (page: Page) => page.locator(".cm-line span[class*='tm-c']");

test("a shell script gets TextMate colours from the worker", async ({ page }) => {
  await open(page, "# comment\necho hi", "run.sh");
  await expect(coloured(page).first()).toBeVisible();
  const classes = await page
    .locator(".cm-line")
    .first()
    .locator("span")
    .first()
    .getAttribute("class");
  expect(classes).toMatch(/tm-c\d+/);
  expect(await page.evaluate(() => document.getElementById("tm-colors")?.textContent)).toContain(
    ".tm-c",
  );
});

test("typed text is coloured and an edit recolours from its line", async ({ page }) => {
  await open(page, "echo one\necho two", "run.sh");
  await expect(coloured(page).first()).toBeVisible();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# a comment");
  const lastLine = page.locator(".cm-line").last();
  await expect(lastLine.locator("span[class*='tm-c']").first()).toBeVisible();
});

test("a line over 20,000 characters stays plain while the others are coloured", async ({
  page,
}) => {
  const long = "x".repeat(20_001);
  await open(page, `echo hi\n${long}\necho bye`, "run.sh");
  await expect(
    page.locator(".cm-line").last().locator("span[class*='tm-c']").first(),
  ).toBeVisible();
  expect(await page.locator(".cm-line").nth(1).locator("span[class*='tm-c']").count()).toBe(0);
});

test("a grammar that fails to load leaves the text uncoloured and editable", async ({ page }) => {
  await open(page, "echo hi", "run.sh", "&badgrammar=1");
  await page.waitForTimeout(500);
  expect(await coloured(page).count()).toBe(0);
  await page.keyboard.press("End");
  await page.keyboard.type(" there");
  expect(await page.evaluate(() => window.view.state.doc.toString())).toBe("echo hi there");
});

test("a file without a grammar and plain text stay uncoloured", async ({ page }) => {
  await open(page, "just text", "notes.txt");
  await page.waitForTimeout(300);
  expect(await coloured(page).count()).toBe(0);
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test -- src/highlight` 와 `pnpm test:e2e -- tests/e2e/highlight.spec.ts`
Expected: 모듈 없음으로 FAIL.

- [ ] **Step 3: 구현 — 프로토콜과 토크나이저**

`src/highlight/protocol.ts`:

```ts
import type { IRawGrammar, IRawTheme } from "@shikijs/vscode-textmate";

export interface GrammarSource {
  scopeName: string;
  grammar: IRawGrammar;
}

/** Main thread → worker. Documents are numbered by the main thread. */
export type WorkerRequest =
  | { type: "theme"; theme: IRawTheme }
  | { type: "grammars"; grammars: GrammarSource[] }
  | { type: "open"; doc: number; scopeName: string; text: string }
  | { type: "edit"; doc: number; fromLine: number; toLine: number; insert: string[] }
  | { type: "tokens"; doc: number; req: number; from: number; to: number }
  | { type: "close"; doc: number };

/** Worker → main thread. A line's tokens are `[start, foregroundId, fontStyle]` triples;
 * `foregroundId` indexes the colour map sent with `theme-ready`. */
export type WorkerReply =
  | { type: "theme-ready"; colorMap: string[] }
  | { type: "opened"; doc: number; ok: boolean; message?: string }
  | { type: "tokens"; doc: number; req: number; from: number; lines: Uint32Array[] }
  | { type: "error"; doc?: number; req?: number; message: string };
```

`src/highlight/tokenizer.ts`:

```ts
import {
  EncodedTokenMetadata,
  INITIAL,
  type IGrammar,
  type StateStack,
} from "@shikijs/vscode-textmate";

/** A line longer than this is not tokenized (spec 「크기별 단계」 — VS Code's default). */
export const MAX_TOKENIZED_LINE_LENGTH = 20_000;

/** `[start, foreground, fontStyle]` per token, decoded from the binary metadata. */
export function encodeLine(binary: Uint32Array): Uint32Array {
  const count = binary.length / 2;
  const out = new Uint32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const meta = binary[i * 2 + 1];
    out[i * 3] = binary[i * 2];
    out[i * 3 + 1] = EncodedTokenMetadata.getForeground(meta);
    out[i * 3 + 2] = EncodedTokenMetadata.getFontStyle(meta);
  }
  return out;
}

/** Tokenizes one document line by line, keeping the grammar state at the start of every line
 * it has seen (spec 「성능」). An edit drops the states from its first line on, so what comes
 * before it is never redone. No wall-clock limit inside a line: a line cut short would leave a
 * wrong state in the cache and colour every line after it wrongly. */
export class LineTokenizer {
  private lines: string[];
  /** states[i] is the state at the start of line i; states[0] is INITIAL. */
  private states: StateStack[] = [INITIAL];

  constructor(
    private readonly grammar: IGrammar,
    text: string,
  ) {
    this.lines = text.split("\n");
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** How many lines from the top have a known end state. */
  get cachedLines(): number {
    return this.states.length - 1;
  }

  edit(fromLine: number, toLine: number, insert: string[]): void {
    this.lines = this.lines.slice(0, fromLine).concat(insert, this.lines.slice(toLine));
    this.states.length = Math.min(this.states.length, fromLine + 1);
  }

  /** Forgets every state (the theme changed: old states carry old colour ids). */
  reset(): void {
    this.states.length = 1;
  }

  /** Tokens of lines [from, to). Lines before `from` that have no state yet are tokenized on
   * the way (their tokens are dropped, their states kept). */
  tokens(from: number, to: number): Uint32Array[] {
    const end = Math.min(to, this.lines.length);
    for (let i = this.cachedLines; i < from && i < end; i++) this.tokenizeLine(i);
    const out: Uint32Array[] = [];
    for (let i = from; i < end; i++) out.push(this.tokenizeLine(i));
    return out;
  }

  /** Tokenizes ahead for about `budgetMs`, whole lines only. True once every line is cached. */
  advance(budgetMs: number): boolean {
    const until = performance.now() + budgetMs;
    while (this.cachedLines < this.lines.length) {
      this.tokenizeLine(this.cachedLines);
      if (performance.now() >= until) break;
    }
    return this.cachedLines >= this.lines.length;
  }

  private tokenizeLine(i: number): Uint32Array {
    const text = this.lines[i];
    const state = this.states[i];
    if (text.length > MAX_TOKENIZED_LINE_LENGTH) {
      this.states[i + 1] = state;
      return new Uint32Array();
    }
    const result = this.grammar.tokenizeLine2(text, state, 0);
    this.states[i + 1] = result.ruleStack;
    return encodeLine(result.tokens);
  }
}
```

(`tokenizeLine2` 의 셋째 인자 `0` 이 「시간 제한 없음」이다 — `@shikijs/vscode-textmate` 의 `_tokenizeString` 은 `timeLimit !== 0` 일 때만 시계를 본다.)

- [ ] **Step 4: 구현 — 문법 수집과 Worker**

`src/highlight/grammars.ts`:

```ts
import type { IRawGrammar } from "@shikijs/vscode-textmate";

import type { LanguageInfo } from "../backend/types";
import { parseJsonc } from "../core/jsonc";
import type { Registry } from "../extensions/registry";
import type { GrammarSource } from "./protocol";

/** Scope names a grammar includes from other grammars (`source.js`, `text.html.basic#tag`),
 * in order of first appearance. `#local` and `$self`/`$base` are not includes of other files. */
export function collectIncludes(grammar: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (
        key === "include" &&
        typeof value === "string" &&
        !value.startsWith("#") &&
        !value.startsWith("$")
      ) {
        const scope = value.split("#")[0];
        if (scope && !found.includes(scope)) found.push(scope);
      } else {
        walk(value);
      }
    }
  };
  walk(grammar);
  return found;
}

/** The grammar of `lang` and every grammar it includes that some extension provides, read
 * through `read`. The registry's own grammar must load; an included one that cannot be read or
 * that nobody provides is left out, and the text inside it simply stays uncoloured (spec
 * 「오류 처리」 — a grammar that cannot be loaded means plain text, never a blocked file). */
export async function collectGrammars(
  registry: Registry,
  lang: LanguageInfo,
  read: (extensionId: string, path: string) => Promise<Uint8Array>,
): Promise<GrammarSource[]> {
  if (!lang.grammar) return [];
  const sources: GrammarSource[] = [];
  const seen = new Set<string>();
  const load = async (extensionId: string, path: string) =>
    parseJsonc<IRawGrammar>(new TextDecoder().decode(await read(extensionId, path)));
  const main = await load(lang.extension, lang.grammar.path);
  sources.push({ scopeName: lang.grammar.scopeName, grammar: main });
  seen.add(lang.grammar.scopeName);
  const queue = collectIncludes(main);
  while (queue.length) {
    const scope = queue.shift()!;
    if (seen.has(scope)) continue;
    seen.add(scope);
    const ref = registry.grammarForScope(scope);
    if (!ref) continue;
    try {
      const grammar = await load(ref.extension, ref.path);
      sources.push({ scopeName: scope, grammar });
      queue.push(...collectIncludes(grammar));
    } catch (error) {
      console.warn(`grammar ${scope} could not be read`, error);
    }
  }
  return sources;
}
```

`src/highlight/worker.ts`:

```ts
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import {
  Registry,
  type IGrammar,
  type IOnigLib,
  type IRawGrammar,
  type IRawTheme,
} from "@shikijs/vscode-textmate";

import type { WorkerReply, WorkerRequest } from "./protocol";
import { LineTokenizer } from "./tokenizer";

/** Tokenization off the input path (spec 「성능」): grammars, theme and documents live here;
 * the main thread asks for the tokens of the lines it shows. Requests are handled in order so
 * an edit can never interleave with the tokens of the document it changes. */

// The inlined WASM needs no fetch, so the worker works the same from the dev server, the app's
// protocol and a test runner.
const engine = await createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined"));
const onigLib: IOnigLib = {
  createOnigScanner: (sources) => engine.createScanner(sources),
  createOnigString: (s) => engine.createString(s),
};

const grammars = new Map<string, IRawGrammar>();
const registry = new Registry({ onigLib, loadGrammar: (scope) => grammars.get(scope) ?? null });
const loaded = new Map<string, IGrammar | null>();
const docs = new Map<number, LineTokenizer>();
let theme: IRawTheme | null = null;
let advancing = false;

const reply = (message: WorkerReply) =>
  (self as unknown as { postMessage(m: WorkerReply): void }).postMessage(message);

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    handle(request);
  } catch (error) {
    reply({
      type: "error",
      doc: "doc" in request ? request.doc : undefined,
      req: request.type === "tokens" ? request.req : undefined,
      message: String(error),
    });
  }
});

function handle(request: WorkerRequest): void {
  switch (request.type) {
    case "theme":
      theme = request.theme;
      registry.setTheme(theme);
      // Colour ids changed with the theme: every cached state is stale.
      for (const doc of docs.values()) doc.reset();
      reply({ type: "theme-ready", colorMap: registry.getColorMap() });
      return;
    case "grammars":
      for (const source of request.grammars) {
        grammars.set(source.scopeName, source.grammar);
        loaded.delete(source.scopeName);
      }
      return;
    case "open": {
      const grammar = grammarFor(request.scopeName);
      if (!grammar) {
        reply({
          type: "opened",
          doc: request.doc,
          ok: false,
          message: `no grammar for ${request.scopeName}`,
        });
        return;
      }
      docs.set(request.doc, new LineTokenizer(grammar, request.text));
      reply({ type: "opened", doc: request.doc, ok: true });
      scheduleAdvance();
      return;
    }
    case "edit":
      docs.get(request.doc)?.edit(request.fromLine, request.toLine, request.insert);
      scheduleAdvance();
      return;
    case "tokens": {
      const doc = docs.get(request.doc);
      if (!doc) throw new Error("tokens requested for a document that is not open");
      reply({
        type: "tokens",
        doc: request.doc,
        req: request.req,
        from: request.from,
        lines: doc.tokens(request.from, request.to),
      });
      return;
    }
    case "close":
      docs.delete(request.doc);
      return;
  }
}

function grammarFor(scopeName: string): IGrammar | null {
  if (!loaded.has(scopeName)) {
    try {
      loaded.set(scopeName, registry.loadGrammar(scopeName));
    } catch (error) {
      console.warn(`grammar ${scopeName} failed to load`, error);
      loaded.set(scopeName, null);
    }
  }
  return loaded.get(scopeName) ?? null;
}

/** Background tokenization (spec 「크기별 단계」: files up to the highlight limit are tokenized
 * from the top in slices, so a far jump finds its states ready). Each slice yields to the
 * message queue, which keeps edits and viewport requests prompt. */
function scheduleAdvance(): void {
  if (advancing) return;
  advancing = true;
  setTimeout(advanceSlice, 0);
}

function advanceSlice(): void {
  let pending = false;
  for (const doc of docs.values()) {
    if (!doc.advance(15)) pending = true;
  }
  if (pending) setTimeout(advanceSlice, 0);
  else advancing = false;
}
```

- [ ] **Step 5: 구현 — 클라이언트와 CodeMirror 확장**

`src/highlight/client.ts`:

```ts
import type { IRawTheme } from "@shikijs/vscode-textmate";

import type { LanguageInfo } from "../backend/types";
import type { Registry } from "../extensions/registry";
import { collectGrammars } from "./grammars";
import type { WorkerReply, WorkerRequest } from "./protocol";

/** Puts the theme's colours on the page as classes: tokens carry colour ids, not colours, so
 * a decoration is one class name and a theme change is one stylesheet. */
export function installColorStyles(colorMap: string[]): void {
  let style = document.getElementById("tm-colors") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "tm-colors";
    document.head.append(style);
  }
  const rules = colorMap.map((color, i) => `.tm-c${i}{color:${color}}`);
  rules.push(
    ".tm-i{font-style:italic}",
    ".tm-b{font-weight:bold}",
    ".tm-u{text-decoration:underline}",
    ".tm-s{text-decoration:line-through}",
  );
  style.textContent = rules.join("\n");
}

/** The main-thread side of the worker (one per window). Grammars go to the worker the first
 * time a language is opened (spec 「설치와 로딩」); the theme whenever it changes. */
export class HighlightClient {
  colorMap: string[] = [];
  private nextDoc = 1;
  private nextReq = 1;
  private readonly waiting = new Map<number, (lines: Uint32Array[] | null) => void>();
  private readonly opening = new Map<number, (ok: boolean) => void>();
  private themeReady: (() => void) | null = null;
  private readonly sent = new Set<string>();
  private readonly loading = new Map<string, Promise<boolean>>();

  constructor(
    private readonly worker: Worker,
    private readonly registry: () => Registry,
    private readonly read: (extensionId: string, path: string) => Promise<Uint8Array>,
  ) {
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) =>
      this.onReply(event.data),
    );
    worker.addEventListener("error", (event) => console.error("highlight worker", event.message));
  }

  nextDocId(): number {
    return this.nextDoc++;
  }

  setTheme(theme: IRawTheme): Promise<void> {
    return new Promise((resolve) => {
      this.themeReady = resolve;
      this.send({ type: "theme", theme });
    });
  }

  /** Sends the language's grammars (once per language) and opens the document. False when the
   * grammar is missing or broken: the text then stays plain. */
  async open(doc: number, lang: LanguageInfo, text: string): Promise<boolean> {
    if (!lang.grammar || !(await this.ensureGrammar(lang))) return false;
    return new Promise((resolve) => {
      this.opening.set(doc, resolve);
      this.send({ type: "open", doc, scopeName: lang.grammar!.scopeName, text });
    });
  }

  edit(doc: number, fromLine: number, toLine: number, insert: string[]): void {
    this.send({ type: "edit", doc, fromLine, toLine, insert });
  }

  /** Null when the worker failed the request. */
  tokens(doc: number, from: number, to: number): Promise<Uint32Array[] | null> {
    const req = this.nextReq++;
    return new Promise((resolve) => {
      this.waiting.set(req, resolve);
      this.send({ type: "tokens", doc, req, from, to });
    });
  }

  close(doc: number): void {
    this.opening.delete(doc);
    this.send({ type: "close", doc });
  }

  private ensureGrammar(lang: LanguageInfo): Promise<boolean> {
    const key = `${lang.extension}:${lang.id}`;
    if (this.sent.has(key)) return Promise.resolve(true);
    let pending = this.loading.get(key);
    if (!pending) {
      pending = collectGrammars(this.registry(), lang, this.read)
        .then((grammars) => {
          if (grammars.length === 0) return false;
          this.send({ type: "grammars", grammars });
          this.sent.add(key);
          return true;
        })
        .catch((error: unknown) => {
          console.warn(`grammar for ${lang.id} could not be loaded`, error);
          return false;
        })
        .finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  private send(request: WorkerRequest): void {
    this.worker.postMessage(request);
  }

  private onReply(reply: WorkerReply): void {
    switch (reply.type) {
      case "theme-ready":
        this.colorMap = reply.colorMap;
        installColorStyles(reply.colorMap);
        this.themeReady?.();
        this.themeReady = null;
        return;
      case "opened":
        this.opening.get(reply.doc)?.(reply.ok);
        this.opening.delete(reply.doc);
        if (!reply.ok) console.warn(reply.message);
        return;
      case "tokens":
        this.waiting.get(reply.req)?.(reply.lines);
        this.waiting.delete(reply.req);
        return;
      case "error":
        console.error("highlight worker:", reply.message);
        if (reply.req !== undefined) {
          this.waiting.get(reply.req)?.(null);
          this.waiting.delete(reply.req);
        }
        if (reply.doc !== undefined) {
          this.opening.get(reply.doc)?.(false);
          this.opening.delete(reply.doc);
        }
        return;
    }
  }
}
```

`src/highlight/extension.ts`:

```ts
import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import type { LanguageInfo } from "../backend/types";
import type { HighlightClient } from "./client";

/** Above this (UTF-16 units, the way the memo size is measured) highlighting is off and the
 * document is never sent to the worker (spec 「크기별 단계」 — 20MB). */
export const HIGHLIGHT_LIMIT_CHARS = 20_000_000;
/** Viewport and edit requests settle for this long before the worker is asked. */
const REQUEST_DELAY_MS = 30;

const setHighlight = StateEffect.define<DecorationSet>();

// Decorations live in a field so the async worker reply can replace them with a plain dispatch,
// and edits in between map the old ones instead of dropping all colour.
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setHighlight)) return e.value;
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const marks = new Map<string, Decoration>();
function mark(foreground: number, fontStyle: number): Decoration {
  const classes = [`tm-c${foreground}`];
  if (fontStyle & 1) classes.push("tm-i");
  if (fontStyle & 2) classes.push("tm-b");
  if (fontStyle & 4) classes.push("tm-u");
  if (fontStyle & 8) classes.push("tm-s");
  const key = classes.join(" ");
  let deco = marks.get(key);
  if (!deco) {
    deco = Decoration.mark({ class: key });
    marks.set(key, deco);
  }
  return deco;
}

/** TextMate colours for one editor state. The worker gets the text on creation, every change
 * as a line replacement, and a request for the visible lines after each change or scroll. */
export function workerHighlighting(client: HighlightClient, lang: LanguageInfo): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private readonly doc = client.nextDocId();
      private version = 0;
      private open: Promise<boolean>;
      private timer: ReturnType<typeof setTimeout> | null = null;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.open = client.open(this.doc, lang, view.state.doc.toString());
        void this.open.then((ok) => ok && this.schedule());
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.version++;
          this.sendEdit(update);
        }
        if (update.docChanged || update.viewportChanged) this.schedule();
      }

      destroy(): void {
        this.destroyed = true;
        if (this.timer) clearTimeout(this.timer);
        client.close(this.doc);
      }

      // One edit message per update: the old line span covering every change becomes the new
      // line span, which stays right for multi-cursor edits too.
      private sendEdit(update: ViewUpdate): void {
        let fromA = Infinity;
        let toA = -1;
        let fromB = Infinity;
        let toB = -1;
        update.changes.iterChangedRanges((fa, ta, fb, tb) => {
          fromA = Math.min(fromA, fa);
          toA = Math.max(toA, ta);
          fromB = Math.min(fromB, fb);
          toB = Math.max(toB, tb);
        });
        const oldDoc = update.startState.doc;
        const newDoc = update.state.doc;
        const firstLine = newDoc.lineAt(fromB).number;
        const lastLine = newDoc.lineAt(toB).number;
        client.edit(
          this.doc,
          oldDoc.lineAt(fromA).number - 1,
          oldDoc.lineAt(toA).number,
          newDoc.sliceString(newDoc.line(firstLine).from, newDoc.line(lastLine).to).split("\n"),
        );
      }

      private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.request(), REQUEST_DELAY_MS);
      }

      private async request(): Promise<void> {
        if (!(await this.open) || this.destroyed) return;
        const version = this.version;
        const { from, to } = this.view.viewport;
        const doc = this.view.state.doc;
        const first = doc.lineAt(from).number - 1;
        const lines = await client.tokens(this.doc, first, doc.lineAt(to).number);
        if (!lines || this.destroyed) return;
        // Tokens for an older document would land on the wrong characters; ask again instead.
        if (version !== this.version) return this.schedule();
        this.view.dispatch({ effects: setHighlight.of(this.build(first, lines)) });
      }

      private build(first: number, lines: Uint32Array[]): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = this.view.state.doc;
        lines.forEach((tokens, i) => {
          const lineNo = first + i + 1;
          if (lineNo > doc.lines) return;
          const line = doc.line(lineNo);
          for (let t = 0; t < tokens.length; t += 3) {
            const start = line.from + tokens[t];
            const end = t + 3 < tokens.length ? line.from + tokens[t + 3] : line.to;
            if (start < end && end <= line.to)
              builder.add(start, end, mark(tokens[t + 1], tokens[t + 2]));
          }
        });
        return builder.finish();
      }
    },
  );
  return [highlightField, plugin];
}
```

`src/editor/setup.ts` — `EditorOptions` 에 `highlight?: Extension` 을 더하고 `editorExtensions` 배열의 `appTheme` 앞에 `options.highlight ?? []` 를 넣는다.

- [ ] **Step 6: 컨트롤러·문서 연결**

`src/app/controller.ts`:

```ts
import { HighlightClient } from "../highlight/client";
import { HIGHLIGHT_LIMIT_CHARS, workerHighlighting } from "../highlight/extension";
import { tokenTheme } from "../theme/vscode-theme";
import {
  languageData,
  parseLanguageConfiguration,
  type LanguageData,
} from "../editor/language-config";
import { languageLabelFor } from "../extensions/registry";
```

필드:

```ts
  readonly highlight = new HighlightClient(
    new Worker(new URL("../highlight/worker.ts", import.meta.url), { type: "module" }),
    () => this.registry,
    (ext, path) => this.backend.readExtensionFile(ext, path),
  );
  private readonly languageConfigs = new Map<string, Promise<LanguageData>>();
```

`start()` 의 `await this.theme.start();` 앞에 테마 → Worker 연결을 둔다:

```ts
this.theme.onChange((active) => {
  if (active.theme) void this.highlight.setTheme(tokenTheme(active.theme));
});
```

`extensions(doc, options)` 를 바꾼다 — 언어와 언어 설정을 함께 결정한다:

```ts
  extensions(doc: Doc, options: { wrap: boolean; text: string }) {
    const lang = this.languageOf(doc);
    const highlight =
      lang?.grammar && options.text.length <= HIGHLIGHT_LIMIT_CHARS ? workerHighlighting(this.highlight, lang) : undefined;
    return editorExtensions({
      fileName: doc.fileName,
      wrap: options.wrap,
      languageData: doc.languageData,
      highlight,
      onUpdate: (update) => this.onUpdate(doc, update),
    });
  }

  /** The language of a tab: the chosen one, else the file name's (spec 「편집기」). */
  languageOf(doc: Doc): LanguageInfo | undefined {
    return (doc.language && this.registry.language(doc.language)) || this.registry.languageForFile(doc.fileName);
  }

  /** language-configuration.json of `lang`, read once per language. */
  languageConfig(lang: LanguageInfo | undefined): Promise<LanguageData> {
    if (!lang?.configuration) return Promise.resolve({});
    const key = `${lang.extension}/${lang.configuration}`;
    let pending = this.languageConfigs.get(key);
    if (!pending) {
      pending = this.backend
        .readExtensionFile(lang.extension, lang.configuration)
        .then((bytes) => languageData(parseLanguageConfiguration(new TextDecoder().decode(bytes))))
        .catch((error: unknown) => {
          console.warn(`language configuration of ${lang.id} could not be read`, error);
          return {};
        });
      this.languageConfigs.set(key, pending);
    }
    return pending;
  }
```

`DocHost` (`src/app/docs.ts`) 의 시그니처를 맞춘다:

```ts
  /** Editor extensions for a state of `doc` holding `text`, including the listener that calls
   * `doc.update`. */
  extensions(doc: Doc, options: { wrap: boolean; text: string }): Extension[];
  /** The language-configuration data of `doc`'s language (`{}` when it has none). */
  languageConfig(lang: LanguageInfo | undefined): Promise<LanguageData>;
  languageOf(doc: Doc): LanguageInfo | undefined;
```

`Doc` 에 `languageData: LanguageData = {}` 필드를 더하고, `setText` 를 `options: { wrap, text }` 로 부른다. `load()` 에서 `setText` 직전에 `this.languageData = await this.host.languageConfig(this.host.languageOf(this));` 를 넣는다(`startEmpty`·`adopt` 도 같은 줄을 앞세운다 — `startEmpty` 는 비동기가 아니므로 `void this.host.languageConfig(...).then((data) => { this.languageData = data; this.host.changed(this, "language"); })` 로 두고, `reconfigureLanguage` 가 `languageDataEffect(doc.languageData)` 도 함께 dispatch 하게 한다 — Step 6 의 아래 코드).

`reconfigureLanguage` 를 바꾼다(언어 효과 둘을 함께):

```ts
  private reconfigureLanguage(doc: Doc): void {
    if (!doc.state) return;
    const effects = [languageEffect(doc.fileName), languageDataEffect(doc.languageData)];
    if (doc === this.tabs.active && this.view.state === doc.state) this.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
    if (doc === this.tabs.active) this.statusBar.setLanguage(languageLabelFor(this.languageOf(doc), doc.fileName));
  }
```

`show()` 의 `this.statusBar.setLanguage(languageLabel(doc.fileName))` 도 `languageLabelFor(this.languageOf(doc), doc.fileName)` 로 바꾸고 `src/ui/status-bar.ts` 의 `languageLabel` 은 지운다(쓰는 곳이 없어진다). `src/app/docs.test.ts` 의 `setup()` 헬퍼에 `languageConfig: async () => ({})`, `languageOf: () => undefined` 를 더하고 `extensions: () => []` 는 그대로 둔다. `src/app/tabs.test.ts`·`session-sync.test.ts` 의 `DocHost` 리터럴에도 같은 두 메서드를 더한다.

`src/styles.css` 에 폰트 스타일 클래스는 Worker 가 만든 `<style id="tm-colors">` 가 갖는다. 아무것도 더하지 않는다.

- [ ] **Step 7: 편집기 테스트 페이지에 Worker**

`tests/e2e/pages/editor.ts` — `?highlight=1` 이면 가짜 백엔드 없이 레지스트리와 개발 서버의 `/extensions/` 로 Worker 를 띄운다. 레지스트리·언어 설정 코드(Task 6) 아래에 더한다:

```ts
import { HighlightClient } from "../../../src/highlight/client";
import { workerHighlighting } from "../../../src/highlight/extension";
import { loadTheme, tokenTheme } from "../../../src/theme/vscode-theme";

const registry = new Registry(fakeRegistry as ExtensionRegistry);
const readFile = async (ext: string, path: string) => {
  if (params.get("badgrammar")) return new TextEncoder().encode("{ not a grammar");
  const response = await fetch(`/extensions/${ext}/${path}`);
  if (!response.ok) throw new Error(`${ext}/${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};
let highlight: Extension | undefined;
if (params.get("highlight")) {
  const client = new HighlightClient(
    new Worker(new URL("../../../src/highlight/worker.ts", import.meta.url), { type: "module" }),
    () => registry,
    readFile,
  );
  const theme = await loadTheme(
    async (p) => new TextDecoder().decode(await readFile("tote.themes", p)),
    "themes/dark-plus.json",
  );
  await client.setTheme(tokenTheme(theme));
  if (lang?.grammar) highlight = workerHighlighting(client, lang);
}
```

(`lang` 은 Task 6 에서 만든 변수. `editorExtensions({ ..., highlight })`. `type Extension` 을 `@codemirror/state` 에서 import.) `tests/e2e/globals.d.ts` 는 바꿀 것이 없다.

- [ ] **Step 8: 통과 확인**

Run: `pnpm test` 와 `pnpm test:e2e`
Expected: Vitest 새 테스트 10개 포함 PASS(개수), E2E `highlight.spec.ts` 5개 PASS, 나머지 spec 그대로. `pnpm typecheck` 깨끗. `pnpm build` 가 Worker 청크(`assets/worker-*.js`)를 낸다.

- [ ] **Step 9: 커밋**

```bash
pnpm exec oxfmt src/highlight src/editor src/app src/ui tests/e2e
pnpm exec oxlint --fix src/highlight src/editor src/app src/ui tests/e2e
git add src/highlight src/editor/setup.ts src/app/controller.ts src/app/docs.ts src/app/docs.test.ts src/app/tabs.test.ts src/app/session-sync.test.ts src/ui/status-bar.ts tests/e2e/pages/editor.ts tests/e2e/highlight.spec.ts
git commit -m "feat(highlight): TextMate tokenization in a worker with Oniguruma and a per-line state cache"
```

---

### Task 9: 언어 바꾸기와 자동 인식 — 상태 표시줄 선택, 메모 확장자·`language`, 외부 파일 세션

**Files:**

- Modify: `src-tauri/src/workspace/ops.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/lib.rs`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/tauri.test.ts`, `src/backend/fake.ts`, `src/app/docs.ts`, `src/app/docs.test.ts`, `src/app/controller.ts`, `src/editor/setup.ts`, `src/ui/status-bar.ts`, `src/ui/dialogs.ts`, `src/styles.css`, `tests/e2e/globals.d.ts`
- Create: `src/core/language.ts`, `src/core/language.test.ts`, `tests/e2e/language.spec.ts`

**Interfaces:**

- Consumes: `Registry.languages`·`language`·`languageForFile`, `HighlightClient`, `workerHighlighting`, `languageDataEffect`.
- Produces (Rust): `Workspace::set_language(&mut self, id: &str, language: &str, ext: &str) -> Result<MemoInfo, WorkspaceError>`; 명령 `set_memo_language(id, language, ext) -> MemoInfo`.
- Produces (`Backend`): `setMemoLanguage(id: string, language: string, ext: string): Promise<MemoInfo>`. `FakeMemo` gains `language?: string`.
- Produces (`src/core/language.ts`): `firstLineOf(text: string): string`, `detectLanguage(text: string, languages: readonly LanguageInfo[]): LanguageInfo | null`.
- Produces (`src/app/docs.ts`): `DocHost.languages(): LanguageInfo[]`; `Doc.changeLanguage(lang: LanguageInfo): Promise<void>`, `Doc.refreshLanguage(): Promise<void>`; `MemoDoc` runs detection at the title moments.
- Produces (`src/editor/setup.ts`): `highlightEffect(extension: Extension): StateEffect<unknown>`.
- Produces (`src/ui/status-bar.ts`): `setLanguage(label: string, onPick?: () => void)`; (`src/ui/dialogs.ts`): `pickLanguage(languages: LanguageInfo[], currentId: string | null): Promise<LanguageInfo | null>`.

- [ ] **Step 0: 제목 규칙 — 첫 줄의 shebang 은 건너뛴다**

스펙 「제목 자동 생성」 이 이 계획을 쓴 뒤에 바뀌었다(사람의 결정, 2026-10-10): **문서의 첫 줄이 `#!` 로 시작하면 그 줄은 건너뛰고 다음 줄부터 첫 번째 비어 있지 않은 줄을 찾는다.** 건너뛴 뒤 비어 있지 않은 줄이 없으면 `untitled` 다. `#!` 가 둘째 줄 이후에 있으면 건너뛰지 않는다.

`src/core/title.test.ts` 에 더한다:

```ts
describe("titleLine skips a shebang on the first line", () => {
  const doc = (s: string) => Text.of(s.split("\n"));
  it("takes the next non-blank line", () => {
    expect(titleLine(doc("#!/bin/sh\n\necho hi"))).toEqual({ text: "echo hi", number: 3 });
    expect(memoTitle(doc("#!/bin/sh\n\necho hi"))).toBe("echo hi");
  });
  it("is untitled when only the shebang is there", () => {
    expect(memoTitle(doc("#!/usr/bin/env python3"))).toBe("untitled");
    expect(titleLine(doc("#!/usr/bin/env python3")).number).toBe(1);
  });
  it("does not skip a #! further down or a Markdown heading", () => {
    expect(memoTitle(doc("\n#!/bin/sh"))).toBe("! bin sh");
    expect(memoTitle(doc("# 제목"))).toBe("제목");
  });
});
```

(`Text` 는 `@codemirror/state` 에서, `titleLine`·`memoTitle` 은 `./title` 에서 import 한다 — 파일에 이미 있으면 그대로 쓴다.) 실패를 본 뒤 `src/core/title.ts` 의 `titleLine` 을 바꾼다:

```ts
/** The first non-blank line and its number (line 1 for a blank memo). A shebang on line 1 is
 * skipped so a script memo is not titled "! bin sh". */
export function titleLine(doc: Text): { text: string; number: number } {
  const last = Math.min(doc.lines, TITLE_SCAN_LINES);
  const first = doc.line(1).text.startsWith("#!") ? 2 : 1;
  for (let n = first; n <= last; n++) {
    const line = doc.line(n);
    if (line.text.trim() !== "") return { text: line.text, number: n };
  }
  return { text: "", number: 1 };
}
```

**이 태스크의 나머지 테스트 기대값을 이 규칙에 맞춘다.** 아래 Step 1 에 적힌 `"! bin sh.sh"`·`"! bin bash.sh"` 는 옛 규칙의 값이다. 새 규칙으로 실제 값(예: `#!/bin/bash` 한 줄 뒤 Enter 는 `untitled.sh`, `#!/bin/sh` + `echo hi` 는 커서가 첫 줄을 떠난 시점의 내용으로 정해진 이름)을 따져 고치고, 고친 기대값과 그 이유를 보고서에 적는다. 언어 자동 인식은 그대로 첫 줄의 shebang 을 본다(제목과 언어 인식은 다른 규칙이다).

- [ ] **Step 1: 실패하는 테스트**

`src-tauri/src/workspace/ops.rs` 의 테스트에 더한다:

```rust
    #[test]
    fn set_language_renames_the_extension_and_records_the_language() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"#!/bin/sh\necho").unwrap();
        ws.retitle_memo(&memo.id, "deploy").unwrap();
        let info = ws.set_language(&memo.id, "shellscript", "sh").unwrap();
        assert_eq!(info.file, "deploy.sh");
        assert_eq!(info.language.as_deref(), Some("shellscript"));
        assert!(info.auto_title); // a language is not a name the person chose
        assert_eq!(listed(&ws), vec!["deploy.sh"]);
        // The same extension only records the language; a taken name gets a number.
        let info = ws.set_language(&memo.id, "bash", "sh").unwrap();
        assert_eq!((info.file.as_str(), info.language.as_deref()), ("deploy.sh", Some("bash")));
        ws.import_memo("deploy.py", b"").unwrap();
        let info = ws.set_language(&memo.id, "python", "py").unwrap();
        assert_eq!(info.file, "deploy 2.py");
        assert!(matches!(ws.set_language("nope", "x", "x"), Err(WorkspaceError::UnknownMemo(_))));
        assert!(matches!(ws.set_language(&memo.id, "x", "a/b"), Err(WorkspaceError::InvalidName(_))));
    }
```

`src/core/language.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import fake from "../backend/fake-registry.json";
import type { ExtensionRegistry } from "../backend/types";
import { detectLanguage, firstLineOf } from "./language";

const languages = (fake as ExtensionRegistry).languages;

describe("detectLanguage", () => {
  it("recognises a shebang through a language's firstLine pattern", () => {
    expect(detectLanguage("#!/bin/bash\necho hi", languages)?.id).toBe("shellscript");
    expect(detectLanguage("#!/usr/bin/env python3\nprint(1)", languages)?.id).toBe("python");
    expect(detectLanguage('<?xml version="1.0"?>\n<a/>', languages)?.id).toBe("xml");
  });

  it("recognises whole-document JSON starting with { or [", () => {
    expect(detectLanguage('{"a": [1, 2]}', languages)?.id).toBe("json");
    expect(detectLanguage("  [1, 2, 3]\n", languages)?.id).toBe("json");
    expect(detectLanguage("{ not json", languages)).toBeNull();
    expect(detectLanguage("1", languages)).toBeNull();
  });

  it("guesses nothing else", () => {
    expect(detectLanguage("# 회의 준비\n- 안건", languages)).toBeNull();
    expect(detectLanguage("", languages)).toBeNull();
    expect(detectLanguage("echo hi", languages)).toBeNull();
  });

  it("skips a firstLine pattern that is not a valid expression", () => {
    const broken = [{ ...languages[0], id: "broken", firstLine: "[" }];
    expect(detectLanguage("[1]", broken)).toBeNull();
  });

  it("firstLineOf stops at the first line break of either kind", () => {
    expect(firstLineOf("a\r\nb")).toBe("a");
    expect(firstLineOf("a")).toBe("a");
  });
});
```

`src/app/docs.test.ts` 의 `describe("MemoDoc")` 에 더한다(`setup()` 의 `host` 에 `languages: () => fakeLanguages` 를 두고, `fakeLanguages` 는 `fake-registry.json` 의 `languages`):

```ts
it("moves a .md memo without a language to the language its first line names, once", async () => {
  const { backend, host } = setup();
  const doc = new MemoDoc(host, await backend.createMemo());
  doc.startEmpty();
  type(doc, "#!/bin/sh");
  await vi.runAllTimersAsync();
  expect(doc.info.file).toBe("untitled.md");
  type(doc, "\necho hi");
  await vi.runAllTimersAsync();
  expect(doc.info.file).toBe("! bin sh.sh");
  expect(doc.info.language).toBe("shellscript");
  expect(backend.data.memos[doc.info.id].language).toBe("shellscript");
  // Never back: the first line changes, the language stays.
  type(doc, "# just a note", 0);
  await doc.leave();
  expect(doc.info.file).toBe("! bin sh.sh");
  expect(doc.info.language).toBe("shellscript");
});

it("does not detect for a memo that already has a language or is not .md", async () => {
  const { backend, host } = setup({
    memos: {
      a: fakeMemo("a.md", "#!/bin/sh"),
      b: fakeMemo("b.txt", "#!/bin/sh"),
    },
  });
  backend.data.memos.a.language = "markdown";
  const a = new MemoDoc(
    host,
    (await backend.listMemos()).find((m) => m.id === "a")!,
  );
  const b = new MemoDoc(
    host,
    (await backend.listMemos()).find((m) => m.id === "b")!,
  );
  await a.ensureLoaded();
  await b.ensureLoaded();
  await a.leave();
  await b.leave();
  expect(a.info.file).toBe("a.md");
  expect(b.info.file).toBe("b.txt");
});

it("changeLanguage renames a memo and records the language; an external file only remembers it", async () => {
  const { backend, host, changes } = setup({ files: { "/x/a.txt": fakeFile("x") } });
  const memo = new MemoDoc(host, await backend.createMemo());
  memo.startEmpty();
  await memo.changeLanguage(fakeLanguages.find((l) => l.id === "python")!);
  expect(memo.info.file).toBe("untitled.py");
  expect(memo.language).toBe("python");
  expect(changes).toContain("language");
  const ext = new ExternalDoc(host, "/x/a.txt");
  await ext.ensureLoaded();
  await ext.changeLanguage(fakeLanguages.find((l) => l.id === "python")!);
  expect(ext.language).toBe("python");
  expect(backend.data.files["/x/a.txt"]).toBe(fakeFile("x"));
});
```

`src/backend/tauri.test.ts` 의 표에 `[() => backend.setMemoLanguage("m", "python", "py"), "set_memo_language", { id: "m", language: "python", ext: "py" }],` 를 더한다.

`tests/e2e/language.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, start } from "./helpers";

test("the status bar names the language of the file and opens a picker", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("script.sh", "echo hi") } });
  await page.locator(".memo-row", { hasText: "script" }).click();
  await expect(page.locator(".status-language")).toHaveText("Shell Script");
  await page.locator(".status-language").click();
  const picker = page.locator(".modal.picker");
  await picker.locator("input").fill("pyth");
  await picker.locator("li", { hasText: "Python" }).click();
  await expect(page.locator(".status-language")).toHaveText("Python");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("script.py");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.memos.a))
    .toMatchObject({ file: "script.py", language: "python", autoTitle: false });
});

test("a shebang on the first line of a new memo moves it off Markdown once the cursor leaves", async ({
  page,
}) => {
  await start(page);
  await menu(page, "new-memo");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("#!/bin/bash");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab.active .tab-title")).toHaveText("! bin bash.sh");
  await expect(page.locator(".status-language")).toHaveText("Shell Script");
});

test("an external file keeps its chosen language in the session", async ({ page }) => {
  await start(page, { files: { "/x/notes": fakeFile("select 1") }, picks: ["/x/notes"] });
  await menu(page, "open-file");
  await expect(page.locator(".status-language")).toHaveText("텍스트");
  await page.locator(".status-language").click();
  await page.locator(".modal.picker li", { hasText: "SQL" }).click();
  await expect(page.locator(".status-language")).toHaveText("SQL");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"language":"sql"');
  await page.reload();
  await page.waitForFunction(() => window.__tote?.ready === true);
  await expect(page.locator(".status-language")).toHaveText("SQL");
});
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml set_language`, `pnpm test -- src/core/language src/app/docs src/backend`, `pnpm test:e2e -- tests/e2e/language.spec.ts`
Expected: 모두 FAIL(없는 함수·메서드).

- [ ] **Step 3: Rust**

`src-tauri/src/workspace/ops.rs` 의 `impl Workspace` 에 더한다:

```rust
    /// The language chosen in the status bar (spec 「편집기」): the file takes the language's
    /// extension and the index remembers the id. Automatic titles go on as before — a language
    /// is not a name the person typed.
    pub fn set_language(
        &mut self,
        id: &str,
        language: &str,
        ext: &str,
    ) -> Result<MemoInfo, WorkspaceError> {
        let entry = self.entry(id)?.clone();
        let (stem, current) = split_name(&entry.file);
        let file = if current.eq_ignore_ascii_case(ext) {
            entry.file.clone()
        } else {
            if !is_valid_file_name(&join_name(stem, ext)) {
                return Err(WorkspaceError::InvalidName(ext.to_string()));
            }
            self.free_name(stem, ext, Some(&entry.file))
        };
        if file != entry.file {
            fs::rename(self.root.join(&entry.file), self.root.join(&file))?;
        }
        if let Some(entry) = self.index.get_mut(id) {
            entry.file = file;
            entry.language = Some(language.to_string());
        }
        self.index.save()?;
        self.memo_info(id)
    }
```

`src-tauri/src/app/commands.rs`:

```rust
#[tauri::command]
pub async fn set_memo_language(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    id: String,
    language: String,
    ext: String,
) -> CmdResult<MemoInfo> {
    let workspace = workspace_of(&core, &window)?;
    let info = lock(&workspace).set_language(&id, &language, &ext)?;
    Ok(info)
}
```

`lib.rs` 의 `generate_handler!` 에 `commands::set_memo_language` 를 더한다.

- [ ] **Step 4: 백엔드 인터페이스와 가짜**

`src/backend/types.ts` 의 `Backend` 에 `setMemoLanguage(id: string, language: string, ext: string): Promise<MemoInfo>;` 를 `renameMemo` 아래에 더한다. `src/backend/tauri.ts`:

```ts
  setMemoLanguage(id: string, language: string, ext: string) {
    return call<MemoInfo>("set_memo_language", { id, language, ext });
  }
```

`src/backend/fake.ts` — `FakeMemo` 에 `language?: string` 을, `info()` 에 `...(memo.language ? { language: memo.language } : {})` 를 더하고:

```ts
  async setMemoLanguage(id: string, language: string, ext: string) {
    const memo = this.memo(id);
    const { stem, ext: current } = splitName(memo.file);
    if (current.toLowerCase() !== ext.toLowerCase()) {
      if (!validName(`${stem}.${ext}`)) throw new BackendError("invalid-name", ext);
      memo.file = this.freeName(stem, ext, id);
    }
    memo.language = language;
    this.commit();
    return this.info(id, memo);
  }
```

- [ ] **Step 5: 자동 인식 규칙**

`src/core/language.ts`:

```ts
import type { LanguageInfo } from "../backend/types";

export function firstLineOf(text: string): string {
  const end = text.search(/\r?\n/);
  return end === -1 ? text : text.slice(0, end);
}

/** Spec 「편집기」: only the sure cases — the first line matches a language's `firstLine`
 * (a shebang, an XML declaration), or the whole text is JSON that starts with `{` or `[`.
 * Anything else is `null`; nothing is guessed from content shape. */
export function detectLanguage(
  text: string,
  languages: readonly LanguageInfo[],
): LanguageInfo | null {
  const first = firstLineOf(text);
  if (first.trim() !== "") {
    for (const lang of languages) {
      if (!lang.firstLine) continue;
      let pattern: RegExp;
      try {
        pattern = new RegExp(lang.firstLine);
      } catch {
        continue;
      }
      if (pattern.test(first)) return lang;
    }
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(text);
      return languages.find((l) => l.id === "json") ?? null;
    } catch {
      return null;
    }
  }
  return null;
}
```

- [ ] **Step 6: 문서와 컨트롤러**

`src/app/docs.ts`:

```ts
import { detectLanguage } from "../core/language";
```

`DocHost` 에 `languages(): LanguageInfo[];` 를 더한다. `Doc`:

```ts
  /** Reloads the language-configuration data for the current language and tells the host, which
   * reconfigures the editor (comment tokens, brackets, highlighting). */
  async refreshLanguage(): Promise<void> {
    this.languageData = await this.host.languageConfig(this.host.languageOf(this));
    this.host.changed(this, "language");
  }

  abstract changeLanguage(lang: LanguageInfo): Promise<void>;
```

`MemoDoc`:

```ts
  /** Spec 「편집기」: the file takes the language's first extension, the index keeps the id. */
  async changeLanguage(lang: LanguageInfo): Promise<void> {
    await this.saveNow();
    const ext = lang.extensions[0] ?? splitName(this.info.file).ext;
    this.info = await this.host.backend.setMemoLanguage(this.info.id, lang.id, ext);
    this.language = lang.id;
    this.host.changed(this, "info");
    await this.refreshLanguage();
  }

  /** Automatic detection (spec 「편집기」): only a `.md` memo without a language, only up and
   * away from Markdown, only at the moments a title would be taken. */
  private async detect(): Promise<void> {
    if (this.info.language || splitName(this.info.file).ext.toLowerCase() !== "md" || !this.state) return;
    const found = detectLanguage(this.state.doc.toString(), this.host.languages());
    if (found && found.id !== "markdown") await this.changeLanguage(found);
  }
```

`MemoDoc.update` 의 `leftTitleLine` 분기를 `void this.retitle().then(() => this.detect())` 로, `leave()` 를 `await this.saveNow(); await this.retitle(); await this.detect();` 로 바꾼다. `detect` 가 `changeLanguage` 안에서 `saveNow` 를 부르므로 제목 rename 과 겹치지 않는다(`retitling` 이 끝난 뒤다).

`ExternalDoc`:

```ts
  /** The choice lives in the session only; the file on disk is not touched. */
  async changeLanguage(lang: LanguageInfo): Promise<void> {
    this.language = lang.id;
    await this.refreshLanguage();
  }
```

`src/editor/setup.ts` — 하이라이트도 Compartment 로:

```ts
const highlightSlot = new Compartment();

export function highlightEffect(extension: Extension) {
  return highlightSlot.reconfigure(extension);
}
```

`editorExtensions` 의 `options.highlight ?? []` 를 `highlightSlot.of(options.highlight ?? [])` 로 바꾼다.

`src/app/controller.ts`:

- `DocHost.languages` 구현: `languages() { return this.registry.languages; }`.
- `extensions()` 안의 하이라이트 계산을 `highlightFor(doc, text)` 로 뽑는다:

```ts
  private highlightFor(doc: Doc, text: string): Extension {
    const lang = this.languageOf(doc);
    return lang?.grammar && text.length <= HIGHLIGHT_LIMIT_CHARS ? workerHighlighting(this.highlight, lang) : [];
  }
```

- `reconfigureLanguage` 의 `effects` 에 `highlightEffect(this.highlightFor(doc, doc.state.doc.length))` — `highlightFor` 는 길이만 쓰므로 시그니처를 `(doc, length: number)` 로 두고 `extensions()` 는 `options.text.length` 를 넘긴다.
- 상태 표시줄: `show()` 와 `reconfigureLanguage` 의 `setLanguage(label)` 를 `setLanguage(label, () => void this.pickLanguageFor(doc))` 로:

```ts
  private async pickLanguageFor(doc: Doc): Promise<void> {
    const current = this.languageOf(doc)?.id ?? null;
    const picked = await pickLanguage(this.registry.languages, current);
    this.view.focus();
    if (!picked || picked.id === current) return;
    try {
      await doc.changeLanguage(picked);
    } catch (error) {
      this.report(error);
    }
  }
```

(`pickLanguage` 를 `../ui/dialogs` 에서 import.) `changed()` 에서 `change === "language"` 일 때 `reconfigureLanguage` 가 이미 불리고, `MemoDoc.changeLanguage` 의 `"info"` 가 메모 목록을 갱신한다. `saveSessionSoon()` 도 `change === "language"` 에서 부른다(외부 파일의 언어가 세션에 남아야 한다).

`src/ui/status-bar.ts`:

```ts
  setLanguage(label: string, onPick?: () => void): void {
    this.language.textContent = label;
    this.language.onclick = onPick ?? null;
    this.language.classList.toggle("clickable", Boolean(onPick));
    this.language.title = onPick ? "언어 바꾸기" : "";
  }
```

`src/ui/dialogs.ts` 에 더한다(워크스페이스 선택기와 같은 `modal` 위에, 필터 입력칸 + 목록):

```ts
export function pickLanguage(
  languages: LanguageInfo[],
  currentId: string | null,
): Promise<LanguageInfo | null> {
  return modal<LanguageInfo>((close) => {
    const input = h("input", { placeholder: "언어 이름" });
    input.spellcheck = false;
    const list = h("ul", { class: "picker-list" });
    const render = () => {
      const query = input.value.trim().toLocaleLowerCase();
      const shown = languages.filter(
        (l) => !query || [l.id, ...l.aliases].some((n) => n.toLocaleLowerCase().includes(query)),
      );
      list.replaceChildren(
        ...shown.map((lang) => {
          const li = h("li", {
            textContent: lang.aliases[0] ?? lang.id,
            class: lang.id === currentId ? "current" : "",
          });
          li.addEventListener("click", () => close(lang));
          return li;
        }),
      );
    };
    input.addEventListener("input", render);
    input.addEventListener("keydown", (event) => {
      if (!isSubmitEnter(event)) return;
      event.preventDefault();
      const first = list.querySelector("li");
      const query = input.value.trim().toLocaleLowerCase();
      const picked = languages.find(
        (l) => !query || [l.id, ...l.aliases].some((n) => n.toLocaleLowerCase().includes(query)),
      );
      if (first && picked) close(picked);
    });
    render();
    return h(
      "div",
      { class: "modal picker", role: "dialog" },
      h("p", { textContent: "언어" }),
      input,
      list,
    );
  });
}
```

(`LanguageInfo` 를 `../backend/types` 에서 import.) `src/styles.css`:

```css
.status-language.clickable {
  cursor: pointer;
}

.status-language.clickable:hover {
  color: var(--fg);
}

.picker-list li.current {
  font-weight: 600;
}
```

`tests/e2e/globals.d.ts` 의 `Window` 에 `pickLanguage: typeof pickLanguage;` 를 더한다(dialogs 페이지가 노출할 수 있게 — `tests/e2e/pages/dialogs.ts` 의 `Object.assign` 에도 `pickLanguage` 를 더한다).

- [ ] **Step 7: 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`, `pnpm test`, `pnpm test:e2e`
Expected: Rust +1, Vitest +8, E2E `language.spec.ts` 3개 PASS, 나머지 그대로(개수를 적는다).

- [ ] **Step 8: 커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
pnpm exec oxfmt src tests/e2e
pnpm exec oxlint --fix src tests/e2e
git add src-tauri/src/workspace/ops.rs src-tauri/src/app/commands.rs src-tauri/src/lib.rs src/backend src/core/language.ts src/core/language.test.ts src/app src/editor/setup.ts src/ui/status-bar.ts src/ui/dialogs.ts src/styles.css tests/e2e/globals.d.ts tests/e2e/pages/dialogs.ts tests/e2e/language.spec.ts
git commit -m "feat(editor): change a tab's language from the status bar and detect shebangs and JSON"
```

---

### Task 10: `files` 모듈, 뷰어 샌드박스, CSP — 토큰 URL, Range, `tote-file`·`tote-ext` 스킴, 호스트 ↔ 뷰어 API

**Files:**

- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/app/mod.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/workspace/ops.rs`, `src-tauri/tauri.conf.json`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/tauri.test.ts`, `src/backend/fake.ts`, `src/app/docs.ts`, `src/app/controller.ts`, `src/styles.css`, `tests/e2e/globals.d.ts`
- Create: `src-tauri/src/files/mod.rs`, `src-tauri/src/files/range.rs`, `src-tauri/src/extensions/serve.rs`, `src/viewer/host.ts`, `src/viewer/protocol.ts`, `tests/e2e/pages/viewer.html`, `tests/e2e/pages/viewer.ts`, `tests/e2e/pages/viewers/echo.html`, `tests/e2e/pages/viewers/silent.html`, `tests/e2e/pages/viewers/failing.html`, `tests/e2e/viewer.spec.ts`

**Interfaces:**

- Consumes: `AppCore`, `Workspace`, `file_inside`, `Registry`(Rust), `Surface.showPanel`·`showPlaceholder`, `ThemeManager.active`·`onChange`, `Registry.viewerFor`(TS).
- Produces (`crate::files`): `FileSource { Memo { id }, External { path } }`(Deserialize, tag `kind`), `TokenStore::issue(&self, window: &str, owner: &str, path: PathBuf) -> String`, `resolve(&self, token: &str) -> Option<PathBuf>`, `revoke(&self, window: &str, owner: &str)`, `revoke_window(&self, window: &str)`, `token_url(token: &str) -> String`(`tote-file://localhost/<token>`), `resolve_relative(dir: &Path, relative: &str) -> Option<PathBuf>`.
- Produces (`crate::files::range`): `RangeSpec`, `parse_range(value: Option<&str>, len: u64) -> RangeSpec`, `respond(store: &TokenStore, uri_path: &str, range: Option<&str>) -> Response<Vec<u8>>`.
- Produces (`crate::extensions::serve`): `respond(registry: &Registry, uri_path: &str) -> Response<Vec<u8>>`.
- Produces (Rust, `Workspace`): `memo_path(&self, id: &str) -> Result<PathBuf, WorkspaceError>`.
- Produces (명령): `issue_file_token(source, owner) -> String`, `revoke_file_tokens(owner)`, `resolve_relative(source, relative, owner) -> Option<String>`.
- Produces (`Backend`): `issueFileToken(source: FileSource, owner: string): Promise<string>`, `revokeFileTokens(owner: string): Promise<void>`, `resolveRelative(source: FileSource, relative: string, owner: string): Promise<string | null>`.
- Produces (`src/viewer/protocol.ts`): `ViewerInit { fileName: string; extension: string; size: number; url?: string; text?: string; theme: Record<string, string> }`, `HostMessage = { type: "init" } & ViewerInit | { type: "theme"; theme: Record<string, string> } | { type: "resolved"; id: number; url: string | null }`, `ViewerMessage = { type: "ready" } | { type: "error"; message: string } | { type: "resolveRelative"; id: number; path: string }`.
- Produces (`src/viewer/host.ts`): `class ViewerHost { readonly el: HTMLElement; constructor(options: ViewerHostOptions); start(init: ViewerInit): void; setTheme(theme: Record<string, string>): void; destroy(): void }`, `ViewerHostOptions { url: string; readyTimeoutMs?: number; resolveRelative: (path: string) => Promise<string | null>; onError: (message: string) => void }`, `READY_TIMEOUT_MS = 5000`, `VIEWER_SANDBOX = "allow-scripts"`.
- Produces (`src/app/docs.ts`): `Doc.source: FileSource`, `Doc.forceText: boolean`, `Doc.openAsText(): Promise<void>`.
- `AppController` shows a primary viewer for a non-text file that has one; otherwise the placeholder. `NOT_OPENABLE = "열 수 없음"`, `OPEN_AS_TEXT = "텍스트로 열기"`.

- [ ] **Step 1: 실패하는 테스트 — Rust**

`src-tauri/src/files/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn tokens_resolve_until_their_owner_or_window_is_revoked() {
        let store = TokenStore::default();
        let a = store.issue("ws-1", "tab-1:primary", "/a.png".into());
        let b = store.issue("ws-1", "tab-2:primary", "/b.png".into());
        let c = store.issue("ws-2", "tab-1:primary", "/c.png".into());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert_eq!(store.resolve(&a), Some(PathBuf::from("/a.png")));
        store.revoke("ws-1", "tab-1:primary");
        assert_eq!(store.resolve(&a), None);
        assert_eq!(store.resolve(&b), Some(PathBuf::from("/b.png")));
        assert_eq!(store.resolve(&c), Some(PathBuf::from("/c.png")));
        store.revoke_window("ws-1");
        assert_eq!(store.resolve(&b), None);
        assert_eq!(store.resolve(&c), Some(PathBuf::from("/c.png")));
        assert_eq!(token_url(&c), format!("tote-file://localhost/{c}"));
    }

    #[test]
    fn resolve_relative_stays_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("그림.png"), [1u8]).unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/inner.png"), [1u8]).unwrap();
        let parent = dir.path().parent().unwrap();
        let outside = parent.join("outside-for-tote-test.png");
        fs::write(&outside, [1u8]).unwrap();
        assert_eq!(resolve_relative(dir.path(), "그림.png"), Some(dir.path().join("그림.png")));
        assert_eq!(resolve_relative(dir.path(), "./그림.png"), Some(dir.path().join("그림.png")));
        for bad in ["sub/inner.png", "../outside-for-tote-test.png", "/etc/passwd", "", "없음.png", "sub", ".."] {
            assert_eq!(resolve_relative(dir.path(), bad), None, "{bad:?}");
        }
        fs::remove_file(outside).unwrap();
    }

    #[test]
    fn file_sources_deserialise_from_the_frontend_shape() {
        let memo: FileSource = serde_json::from_str(r#"{"kind":"memo","id":"m1"}"#).unwrap();
        assert_eq!(memo, FileSource::Memo { id: "m1".into() });
        let ext: FileSource = serde_json::from_str(r#"{"kind":"external","path":"/x/a.mp4"}"#).unwrap();
        assert_eq!(ext, FileSource::External { path: "/x/a.mp4".into() });
    }
}
```

`src-tauri/src/files/range.rs` 의 테스트:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    use tauri::http::{header, StatusCode};

    #[test]
    fn no_header_means_full() {
        assert_eq!(parse_range(None, 1000), RangeSpec::Full);
    }

    #[test]
    fn open_ended_range_runs_to_eof() {
        assert_eq!(parse_range(Some("bytes=0-"), 1000), RangeSpec::Partial { start: 0, end: 999 });
    }

    #[test]
    fn webkit_probe_range() {
        assert_eq!(parse_range(Some("bytes=0-1"), 1000), RangeSpec::Partial { start: 0, end: 1 });
    }

    #[test]
    fn suffix_range_takes_last_bytes() {
        assert_eq!(parse_range(Some("bytes=-500"), 1000), RangeSpec::Partial { start: 500, end: 999 });
        assert_eq!(parse_range(Some("bytes=-5000"), 1000), RangeSpec::Partial { start: 0, end: 999 });
    }

    #[test]
    fn end_past_eof_is_clamped() {
        assert_eq!(parse_range(Some("bytes=10-99999"), 1000), RangeSpec::Partial { start: 10, end: 999 });
    }

    #[test]
    fn start_at_or_past_eof_is_unsatisfiable() {
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=5-2"), 1000), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), 1000), RangeSpec::Unsatisfiable);
    }

    #[test]
    fn malformed_or_multi_range_falls_back_to_full() {
        assert_eq!(parse_range(Some("items=0-1"), 1000), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 1000), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=abc-"), 1000), RangeSpec::Full);
    }

    fn fixture(name: &str, bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        fs::write(&path, bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn unknown_tokens_and_path_like_uris_are_404() {
        let (_dir, path) = fixture("a.txt", b"secret");
        let store = TokenStore::default();
        let _token = store.issue("w", "o", path.clone());
        assert_eq!(respond(&store, "/deadbeef", None).status(), StatusCode::NOT_FOUND);
        assert_eq!(respond(&store, &format!("/{}", path.display()), None).status(), StatusCode::NOT_FOUND);
        assert_eq!(respond(&store, "/../../etc/passwd", None).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn a_range_request_on_a_korean_file_name_returns_a_206_slice_with_readable_headers() {
        let (_dir, path) = fixture("영상 테스트.bin", b"0123456789");
        let store = TokenStore::default();
        let token = store.issue("w", "o", path);
        let res = respond(&store, &format!("/{token}"), Some("bytes=2-5"));
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(res.body(), b"2345");
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(res.headers()[header::CONTENT_LENGTH], "4");
        assert_eq!(res.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        // Without this a script's fetch() cannot read Content-Range (spike 「검증하지 않은 것」).
        assert_eq!(res.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS], "Content-Range, Content-Length, Accept-Ranges");
    }

    #[test]
    fn a_full_request_returns_the_whole_file_with_its_type() {
        let (_dir, path) = fixture("clip.mp4", b"abc");
        let store = TokenStore::default();
        let token = store.issue("w", "o", path);
        let res = respond(&store, &format!("/{token}"), None);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"abc");
        assert_eq!(res.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(res.headers()[header::CONTENT_LENGTH], "3");
    }

    #[test]
    fn an_unsatisfiable_range_is_416_and_a_vanished_file_404() {
        let (dir, path) = fixture("a.bin", b"abc");
        let store = TokenStore::default();
        let token = store.issue("w", "o", path.clone());
        let res = respond(&store, &format!("/{token}"), Some("bytes=10-"));
        assert_eq!(res.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes */3");
        fs::remove_file(&path).unwrap();
        assert_eq!(respond(&store, &format!("/{token}"), None).status(), StatusCode::NOT_FOUND);
        drop(dir);
    }

    #[test]
    fn a_revoked_token_is_404_even_while_the_file_exists() {
        let (_dir, path) = fixture("a.bin", b"abc");
        let store = TokenStore::default();
        let token = store.issue("w", "o", path);
        store.revoke("w", "o");
        assert_eq!(respond(&store, &format!("/{token}"), Some("bytes=0-1")).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn content_types_cover_what_the_media_viewer_plays() {
        for (name, ty) in [
            ("a.png", "image/png"), ("a.JPG", "image/jpeg"), ("a.gif", "image/gif"), ("a.webp", "image/webp"),
            ("a.heic", "image/heic"), ("a.svg", "image/svg+xml"), ("a.mp4", "video/mp4"), ("a.mov", "video/quicktime"),
            ("a.m4v", "video/x-m4v"), ("a.webm", "video/webm"), ("a.mp3", "audio/mpeg"), ("a.m4a", "audio/mp4"),
            ("a.wav", "audio/wav"), ("a.aac", "audio/aac"), ("a.flac", "audio/flac"), ("a.ogg", "audio/ogg"),
            ("a.aiff", "audio/aiff"), ("a.txt", "text/plain; charset=utf-8"), ("a.md", "text/plain; charset=utf-8"),
            ("a.bin", "application/octet-stream"),
        ] {
            assert_eq!(content_type(Path::new(name)), ty, "{name}");
        }
    }
}
```

`src-tauri/src/extensions/serve.rs` 의 테스트:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::appdata::ExtensionSettings;
    use crate::extensions::registry::build;
    use crate::extensions::tests::write_extension;
    use crate::extensions::ExtensionStore;

    fn registry(dir: &Path) -> Registry {
        let bundled = dir.join("bundled");
        let user = dir.join("user");
        let md = write_extension(&bundled, "tote.markdown-preview", r#"{"name": "markdown-preview", "publisher": "tote", "version": "1"}"#);
        fs::write(md.join("viewer.html"), "<!doctype html><title>md</title>").unwrap();
        fs::create_dir_all(md.join("vendor")).unwrap();
        fs::write(md.join("vendor/marked.js"), "var marked;").unwrap();
        let evil = write_extension(&user, "someone.evil@1", r#"{"name": "evil", "publisher": "someone", "version": "1"}"#);
        fs::write(evil.join("viewer.html"), "<script>steal()</script>").unwrap();
        fs::write(dir.join("secret.txt"), "secret").unwrap();
        build(&ExtensionStore::new(bundled, user).scan(), &ExtensionSettings::default())
    }

    #[test]
    fn serves_files_of_bundled_extensions_with_their_type() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());
        let res = respond(&registry, "/tote.markdown-preview/viewer.html");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(res.body(), b"<!doctype html><title>md</title>");
        let js = respond(&registry, "/tote.markdown-preview/vendor/marked.js");
        assert_eq!(js.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
        // Percent-encoded ids and paths arrive decoded.
        assert_eq!(respond(&registry, "/tote.markdown-preview/vendor%2Fmarked.js").status(), StatusCode::OK);
    }

    #[test]
    fn user_extensions_escapes_and_missing_files_are_404() {
        let dir = tempfile::tempdir().unwrap();
        let registry = registry(dir.path());
        for uri in [
            "/someone.evil/viewer.html",
            "/tote.markdown-preview/../../secret.txt",
            "/tote.markdown-preview/missing.html",
            "/tote.markdown-preview/",
            "/",
            "/nobody.ext/viewer.html",
            "/tote.markdown-preview/package.json/..",
        ] {
            assert_eq!(respond(&registry, uri).status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }
}
```

`src-tauri/src/app/mod.rs` 테스트에 더한다:

```rust
    #[test]
    fn closing_a_window_revokes_its_file_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let a = open(&core, "가");
        let token = core.files.issue(&a, "tab:primary", "/x.png".into());
        core.closed(&a);
        assert_eq!(core.files.resolve(&token), None);
    }
```

`src-tauri/src/workspace/ops.rs` 테스트에 더한다:

```rust
    #[test]
    fn memo_path_is_the_file_under_the_root() {
        let (_root, mut ws) = workspace();
        let memo = ws.create_memo("md", b"").unwrap();
        assert_eq!(ws.memo_path(&memo.id).unwrap(), ws.root().join("untitled.md"));
        assert!(matches!(ws.memo_path("nope"), Err(WorkspaceError::UnknownMemo(_))));
    }
```

- [ ] **Step 2: 실패하는 테스트 — 뷰어 호스트(E2E)**

`tests/e2e/pages/viewers/echo.html`(테스트용 뷰어 — 받은 것을 그대로 호스트에 돌려주고 `resolveRelative` 를 한 번 부른다):

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: tote-file:; connect-src tote-file:"
    />
  </head>
  <body>
    <script>
      const probes = { origin: String(self.origin), tauri: typeof window.__TAURI_INTERNALS__ };
      try {
        probes.parent = typeof window.parent.document;
      } catch (e) {
        probes.parent = "blocked: " + e.name;
      }
      addEventListener("securitypolicyviolation", (e) => {
        parent.postMessage({ type: "error", message: "csp:" + e.blockedURI }, "*");
      });
      addEventListener("message", async (e) => {
        if (e.data?.type === "init") {
          document.body.dataset.file = e.data.fileName;
          document.body.style.background = e.data.theme["--bg"];
          parent.postMessage(
            {
              type: "resolveRelative",
              id: 1,
              path: new URLSearchParams(location.search).get("rel") ?? "pic.png",
            },
            "*",
          );
          fetch("https://example.com/", { mode: "no-cors" }).catch(() => {});
          // Echo back what a test reads: the init and the probes.
          document.body.dataset.echo = JSON.stringify({ init: e.data, probes });
        }
        if (e.data?.type === "resolved") document.body.dataset.resolved = JSON.stringify(e.data);
        if (e.data?.type === "theme") document.body.style.background = e.data.theme["--bg"];
      });
      parent.postMessage({ type: "ready" }, "*");
    </script>
  </body>
</html>
```

`tests/e2e/pages/viewers/silent.html`: `<!doctype html><title>silent</title>`(아무 메시지도 보내지 않는다). `tests/e2e/pages/viewers/failing.html`:

```html
<!doctype html>
<script>
  parent.postMessage({ type: "ready" }, "*");
  addEventListener("message", () => parent.postMessage({ type: "error", message: "boom" }, "*"));
</script>
```

`tests/e2e/pages/viewer.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>viewer host</title>
    <script type="module" src="./viewer.ts"></script>
  </head>
  <body style="margin: 0">
    <div id="host" style="height: 400px"></div>
    <pre id="log"></pre>
  </body>
</html>
```

`tests/e2e/pages/viewer.ts`:

```ts
import { ViewerHost } from "../../../src/viewer/host";

const params = new URLSearchParams(location.search);
const log = document.getElementById("log")!;
const host = new ViewerHost({
  url: params.get("viewer") ?? "/tests/e2e/pages/viewers/echo.html",
  readyTimeoutMs: Number(params.get("timeout") ?? 5000),
  resolveRelative: async (path) => (path === "pic.png" ? "data:image/png;base64,AAAA" : null),
  onError: (message) => {
    log.textContent = `error: ${message}`;
  },
});
document.getElementById("host")!.append(host.el);
host.start({
  fileName: "사진.png",
  extension: "png",
  size: 3,
  url: "data:image/png;base64,AAAA",
  theme: { "--bg": "rgb(1, 2, 3)" },
});
Object.assign(window, { viewerHost: host });
```

`tests/e2e/viewer.spec.ts`:

```ts
import { expect, test, type FrameLocator, type Page } from "@playwright/test";

const frame = (page: Page): FrameLocator => page.frameLocator("iframe.viewer-frame");

test("the host sends init after ready, answers resolveRelative and passes the theme", async ({
  page,
}) => {
  await page.goto("/tests/e2e/pages/viewer.html");
  const body = frame(page).locator("body");
  await expect(body).toHaveAttribute("data-file", "사진.png");
  const echo = JSON.parse((await body.getAttribute("data-echo"))!);
  expect(echo.init).toMatchObject({
    type: "init",
    extension: "png",
    size: 3,
    url: "data:image/png;base64,AAAA",
  });
  expect(echo.probes.origin).toBe("null");
  expect(echo.probes.tauri).toBe("undefined");
  expect(echo.probes.parent).toMatch(/^blocked: SecurityError/);
  await expect(body).toHaveAttribute(
    "data-resolved",
    JSON.stringify({ type: "resolved", id: 1, url: "data:image/png;base64,AAAA" }),
  );
  await expect(body).toHaveCSS("background-color", "rgb(1, 2, 3)");
  await page.evaluate(() => window.viewerHost.setTheme({ "--bg": "rgb(4, 5, 6)" }));
  await expect(body).toHaveCSS("background-color", "rgb(4, 5, 6)");
  // The viewer's own CSP stopped its fetch before it left the page.
  await expect(page.locator("#log")).toHaveText("error: csp:https://example.com");
});

test("the iframe is sandboxed without same-origin, popups, forms or navigation", async ({
  page,
}) => {
  await page.goto("/tests/e2e/pages/viewer.html");
  expect(await page.locator("iframe.viewer-frame").getAttribute("sandbox")).toBe("allow-scripts");
});

test("a viewer that never answers shows the fallback", async ({ page }) => {
  await page.goto(
    "/tests/e2e/pages/viewer.html?viewer=/tests/e2e/pages/viewers/silent.html&timeout=300",
  );
  await expect(page.locator("#log")).toHaveText("error: 뷰어가 응답하지 않습니다");
});

test("a viewer that reports an error shows the fallback with its message", async ({ page }) => {
  await page.goto("/tests/e2e/pages/viewer.html?viewer=/tests/e2e/pages/viewers/failing.html");
  await expect(page.locator("#log")).toHaveText("error: boom");
});

test("a resolveRelative for a file outside the folder answers null", async ({ page }) => {
  await page.goto(
    "/tests/e2e/pages/viewer.html?viewer=/tests/e2e/pages/viewers/echo.html%3Frel%3D..%2Fsecret.png",
  );
  const body = frame(page).locator("body");
  await expect(body).toHaveAttribute(
    "data-resolved",
    JSON.stringify({ type: "resolved", id: 1, url: null }),
  );
});
```

그리고 앱 흐름(`tests/e2e/external.spec.ts` 에 더한다):

```ts
test("a non-text file with a viewer opens it; 텍스트로 열기 falls back to the editor path", async ({
  page,
}) => {
  await start(page, {
    files: {
      "/x/사진.png": fakeFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      "/x/doc.pdf": fakeFile(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    },
    picks: ["/x/사진.png", "/x/doc.pdf"],
  });
  await menu(page, "open-file");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  await expect(page.locator(".editor-placeholder")).toBeHidden();
  await menu(page, "open-file");
  // PDF has no bundled viewer: the placeholder stays, with the text fallback.
  await expect(page.locator(".editor-placeholder p")).toHaveText("열 수 없음");
  await page.getByRole("button", { name: "텍스트로 열기" }).click();
  await expect(page.locator(".editor-placeholder p")).toHaveText("텍스트로 열 수 없음");
  // Leaving the image tab takes its viewer down with its token; coming back brings a new one.
  await page.locator(".tab", { hasText: "사진.png" }).click();
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(1);
  await page.locator(".tab", { hasText: "doc.pdf" }).click();
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  expect(await page.evaluate(() => window.__tote.backend.data.tokens)).toEqual({});
});
```

`tests/e2e/globals.d.ts` 의 `Window` 에 `viewerHost: ViewerHost;` 를 더한다(`import type { ViewerHost } from "../../src/viewer/host";`).

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml files serve`, `pnpm test:e2e -- tests/e2e/viewer.spec.ts tests/e2e/external.spec.ts`
Expected: 컴파일 오류 / 모듈 없음.

- [ ] **Step 4: Rust — `files`**

`src-tauri/src/files/mod.rs`:

```rust
//! Files for viewers and the large text viewer (spec 「뷰어」 「파일 전달」): a token stands for
//! one file, carries no path, and serves any number of requests — a video seek alone sends
//! dozens of Range requests — until the view that got it closes. Tokens are keyed by window and
//! owner so a closing view, or a closing window, revokes exactly its own.

pub mod range;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;

/// What a view wants to read, as the frontend names its tabs.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileSource {
    Memo { id: String },
    External { path: PathBuf },
}

struct Token {
    path: PathBuf,
    window: String,
    owner: String,
}

#[derive(Default)]
pub struct TokenStore {
    tokens: Mutex<HashMap<String, Token>>,
}

impl TokenStore {
    pub fn issue(&self, window: &str, owner: &str, path: PathBuf) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.lock().insert(
            token.clone(),
            Token {
                path,
                window: window.to_string(),
                owner: owner.to_string(),
            },
        );
        token
    }

    pub fn resolve(&self, token: &str) -> Option<PathBuf> {
        self.lock().get(token).map(|t| t.path.clone())
    }

    pub fn revoke(&self, window: &str, owner: &str) {
        self.lock()
            .retain(|_, t| !(t.window == window && t.owner == owner));
    }

    pub fn revoke_window(&self, window: &str) {
        self.lock().retain(|_, t| t.window != window);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Token>> {
        self.tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub fn token_url(token: &str) -> String {
    format!("tote-file://localhost/{token}")
}

/// `relative` as a file directly inside `dir` — one plain name, no folders, no `..`, and it
/// must exist as a regular file (spec 「뷰어 API」: `resolveRelative` answers for the open
/// file's own folder only).
pub fn resolve_relative(dir: &Path, relative: &str) -> Option<PathBuf> {
    let name = relative.strip_prefix("./").unwrap_or(relative);
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return None;
    }
    let path = dir.join(name);
    fs::metadata(&path).ok()?.is_file().then_some(path)
}
```

`src-tauri/src/files/range.rs`(`RangeSpec`·`parse_range`·`read_slice` 는 스파이크 `spikes/lab/src-tauri/src/file_scheme.rs` 와 같은 코드다):

```rust
//! The `tote-file` scheme: `/<token>` → the file's bytes, whole or as one byte range. Single
//! ranges only — WebKit's media loader never asks for multipart ranges.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{header, Response, StatusCode};

use super::TokenStore;

#[derive(Debug, PartialEq, Eq)]
pub enum RangeSpec {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

/// Single byte ranges only; WebKit's media loader never asks for multipart ranges. Malformed
/// headers are ignored (full response), as HTTP allows.
pub fn parse_range(value: Option<&str>, len: u64) -> RangeSpec {
    let Some(spec) = value.and_then(|v| v.trim().strip_prefix("bytes=")) else {
        return RangeSpec::Full;
    };
    if spec.contains(',') {
        return RangeSpec::Full;
    }
    let Some((a, b)) = spec.split_once('-') else {
        return RangeSpec::Full;
    };
    let (a, b) = (a.trim(), b.trim());
    let (start, end) = if a.is_empty() {
        let Ok(suffix) = b.parse::<u64>() else {
            return RangeSpec::Full;
        };
        if suffix == 0 || len == 0 {
            return RangeSpec::Unsatisfiable;
        }
        (len.saturating_sub(suffix), len - 1)
    } else {
        let Ok(start) = a.parse::<u64>() else {
            return RangeSpec::Full;
        };
        let end = if b.is_empty() {
            len.saturating_sub(1)
        } else {
            let Ok(end) = b.parse::<u64>() else {
                return RangeSpec::Full;
            };
            end.min(len.saturating_sub(1))
        };
        (start, end)
    };
    if len == 0 || start >= len || start > end {
        return RangeSpec::Unsatisfiable;
    }
    RangeSpec::Partial { start, end }
}

fn read_slice(path: &Path, start: u64, end: u64) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0; (end - start + 1) as usize];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

pub fn respond(store: &TokenStore, uri_path: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let token = uri_path.trim_start_matches('/');
    let Some(path) = store.resolve(token) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let Ok(len) = std::fs::metadata(&path).map(|m| m.len()) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let builder = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        // fetch() in the large text viewer reads these; without the list a script sees none.
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, content_type(&path));
    let result = match parse_range(range, len) {
        RangeSpec::Full => std::fs::read(&path).map(|body| {
            builder
                .status(StatusCode::OK)
                .header(header::CONTENT_LENGTH, len)
                .body(body)
        }),
        RangeSpec::Partial { start, end } => read_slice(&path, start, end).map(|body| {
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_LENGTH, end - start + 1)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .body(body)
        }),
        RangeSpec::Unsatisfiable => Ok(builder
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new())),
    };
    match result {
        Ok(Ok(res)) => res,
        Err(err) if err.kind() == io::ErrorKind::NotFound => status_only(StatusCode::NOT_FOUND),
        _ => status_only(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn status_only(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .expect("static response is valid")
}

/// Media types for what the media viewer plays (spec 「번들 확장」 4) and text for the large
/// text viewer; everything else is opaque bytes.
pub fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic") => "image/heic",
        Some("bmp") => "image/bmp",
        Some("tif" | "tiff") => "image/tiff",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("aac") => "audio/aac",
        Some("flac") => "audio/flac",
        Some("ogg") => "audio/ogg",
        Some("aiff") => "audio/aiff",
        Some("txt" | "md" | "markdown" | "log" | "json" | "csv") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
```

`src-tauri/src/extensions/serve.rs`:

```rust
//! The `tote-ext` scheme: `/<extension id>/<path>` → a file of a bundled extension, for the
//! viewer iframes (spec 「뷰어」). Only bundled, enabled extensions are served, and only files
//! inside their folder.

use std::path::Path;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Response, StatusCode};

use super::file_inside;
use super::registry::Registry;
use super::Source;

pub fn respond(registry: &Registry, uri_path: &str) -> Response<Vec<u8>> {
    let Ok(decoded) = percent_decode_str(uri_path).decode_utf8() else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let Some((id, relative)) = decoded.trim_start_matches('/').split_once('/') else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let Some(extension) = registry
        .extensions
        .iter()
        .find(|e| e.id == id && e.source == Source::Bundled && e.enabled)
    else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let Some(file) = file_inside(&extension.path, relative) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    match std::fs::read(&file) {
        Ok(body) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&file))
            .header(header::CONTENT_LENGTH, body.len())
            .body(body)
            .expect("static headers are valid"),
        Err(_) => status_only(StatusCode::NOT_FOUND),
    }
}

fn status_only(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("static response is valid")
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}
```

`src-tauri/src/extensions/mod.rs` 에 `pub mod serve;` 를 더한다. `src-tauri/src/workspace/ops.rs` 의 `impl Workspace` 에:

```rust
    pub fn memo_path(&self, id: &str) -> Result<PathBuf, WorkspaceError> {
        Ok(self.root.join(&self.entry(id)?.file))
    }
```

(`use std::path::{Path, PathBuf};`.)

`src-tauri/src/app/mod.rs`: `AppCore` 에 `pub files: TokenStore`(`TokenStore::default()`)를 더하고 `closed()` 의 첫 줄에 `self.files.revoke_window(label);` 를 둔다. `src-tauri/src/lib.rs` 에 `pub mod files;` 와 스킴 둘:

```rust
        .register_asynchronous_uri_scheme_protocol("tote-file", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            let range = request
                .headers()
                .get(tauri::http::header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            // Off the main thread: a 206 for a video seek reads from disk.
            std::thread::spawn(move || {
                let core = app.state::<AppCore>();
                responder.respond(files::range::respond(&core.files, &path, range.as_deref()));
            });
        })
        .register_uri_scheme_protocol("tote-ext", |ctx, request| {
            let registry = ctx.app_handle().state::<AppCore>().registry();
            extensions::serve::respond(&registry, request.uri().path())
        })
```

`src-tauri/src/app/commands.rs`:

```rust
use crate::files::{self, FileSource};

/// The path a source names, for this window's workspace.
fn source_path(core: &AppCore, window: &WebviewWindow, source: &FileSource) -> CmdResult<PathBuf> {
    match source {
        FileSource::Memo { id } => {
            let workspace = workspace_of(core, window)?;
            let path = lock(&workspace).memo_path(id)?;
            Ok(path)
        }
        FileSource::External { path } => absolute_path(&path.to_string_lossy()),
    }
}

#[tauri::command]
pub fn issue_file_token(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    source: FileSource,
    owner: String,
) -> CmdResult<String> {
    let path = source_path(&core, &window, &source)?;
    Ok(files::token_url(&core.files.issue(window.label(), &owner, path)))
}

#[tauri::command]
pub fn revoke_file_tokens(core: State<'_, AppCore>, window: WebviewWindow, owner: String) {
    core.files.revoke(window.label(), &owner);
}

#[tauri::command]
pub fn resolve_relative(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    source: FileSource,
    relative: String,
    owner: String,
) -> CmdResult<Option<String>> {
    let path = source_path(&core, &window, &source)?;
    let Some(dir) = path.parent() else {
        return Ok(None);
    };
    Ok(files::resolve_relative(dir, &relative)
        .map(|file| files::token_url(&core.files.issue(window.label(), &owner, file))))
}
```

`generate_handler!` 에 셋을 더한다.

- [ ] **Step 5: CSP**

`src-tauri/tauri.conf.json` 의 `app.security` 를 바꾼다. Tauri 가 `index.html` 의 인라인 스크립트·스타일에 nonce 를 붙인다. `'wasm-unsafe-eval'` 은 Worker 의 Oniguruma WASM, `worker-src` 는 Vite 가 낸 Worker 청크, `connect-src` 의 `tote-file:` 은 대용량 텍스트 뷰어의 `fetch`, `frame-src` 의 `tote-ext:` 는 뷰어 iframe 이다. 개발 실행(`http://localhost:1420`)에는 Tauri 가 CSP 를 넣지 않으므로 이 값은 번들에서만 산다 — 뷰어 페이지의 자체 `<meta>` CSP 는 어디서나 산다.

```json
    "security": {
      "csp": {
        "default-src": "'self'",
        "script-src": "'self' 'wasm-unsafe-eval'",
        "style-src": "'self' 'unsafe-inline'",
        "img-src": "'self' data:",
        "media-src": "'none'",
        "font-src": "'self'",
        "connect-src": "ipc: http://ipc.localhost tote-file:",
        "frame-src": "tote-ext:",
        "worker-src": "'self' blob:",
        "object-src": "'none'",
        "base-uri": "'none'",
        "form-action": "'none'"
      }
    }
```

- [ ] **Step 6: 프론트 — 백엔드, 프로토콜, 호스트**

`src/backend/types.ts` 의 `Backend` 에:

```ts
  /** A URL only this view may use for the file; revoked with `revokeFileTokens(owner)`. */
  issueFileToken(source: FileSource, owner: string): Promise<string>;
  revokeFileTokens(owner: string): Promise<void>;
  /** A token URL for a file in the same folder as `source`, or null (spec 「뷰어 API」). */
  resolveRelative(source: FileSource, relative: string, owner: string): Promise<string | null>;
```

`src/backend/tauri.ts`:

```ts
  issueFileToken(source: FileSource, owner: string) {
    return call<string>("issue_file_token", { source, owner });
  }
  revokeFileTokens(owner: string) {
    return call<void>("revoke_file_tokens", { owner });
  }
  resolveRelative(source: FileSource, relative: string, owner: string) {
    return call<string | null>("resolve_relative", { source, relative, owner });
  }
```

`src/backend/tauri.test.ts` 표에 더한다:

```ts
      [() => backend.issueFileToken({ kind: "memo", id: "m" }, "o"), "issue_file_token", { source: { kind: "memo", id: "m" }, owner: "o" }],
      [() => backend.revokeFileTokens("o"), "revoke_file_tokens", { owner: "o" }],
      [
        () => backend.resolveRelative({ kind: "external", path: "/x/a.md" }, "p.png", "o"),
        "resolve_relative",
        { source: { kind: "external", path: "/x/a.md" }, relative: "p.png", owner: "o" },
      ],
```

`src/backend/fake.ts` — `FakeData` 에 `tokens: Record<string, string[]>`(소유자 → 발급한 URL 들; 테스트가 회수를 본다)를 더하고 `defaultFakeData` 에 `tokens: {}`:

```ts
// What the tote-file scheme would send as Content-Type; the fake hands the bytes over as data: URLs.
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
};
const dataUrl = (name: string, data: string) => `data:${MIME[splitName(name).ext.toLowerCase()] ?? "application/octet-stream"};base64,${data}`;

  private sourceBytes(source: FileSource): { name: string; data: string; folder: Record<string, string>; dirKey: (n: string) => string } | null {
    if (source.kind === "memo") {
      const memo = this.data.memos[source.id];
      if (!memo) return null;
      const folder: Record<string, string> = {};
      for (const m of Object.values(this.data.memos)) folder[m.file] = m.data;
      return { name: memo.file, data: memo.data, folder, dirKey: (n) => n };
    }
    const data = this.data.files[source.path];
    if (data === undefined) return null;
    const dir = source.path.slice(0, source.path.lastIndexOf("/") + 1);
    return { name: basename(source.path), data, folder: this.data.files, dirKey: (n) => dir + n };
  }

  async issueFileToken(source: FileSource, owner: string) {
    const found = this.sourceBytes(source);
    if (!found) throw new BackendError("not-found", JSON.stringify(source));
    const url = dataUrl(found.name, found.data);
    (this.data.tokens[owner] ??= []).push(url);
    this.commit();
    return url;
  }

  async revokeFileTokens(owner: string) {
    delete this.data.tokens[owner];
    this.commit();
  }

  async resolveRelative(source: FileSource, relative: string, owner: string) {
    const name = relative.startsWith("./") ? relative.slice(2) : relative;
    if (!name || name.includes("/") || name === "..") return null;
    const found = this.sourceBytes(source);
    const data = found?.folder[found.dirKey(name)];
    if (data === undefined) return null;
    const url = dataUrl(name, data);
    (this.data.tokens[owner] ??= []).push(url);
    this.commit();
    return url;
  }
```

`src/viewer/protocol.ts`:

```ts
/** The postMessage API between the host page and a viewer iframe (spec 「뷰어 API」). The
 * viewer has an opaque origin, so every message goes to `"*"` and the host checks the source
 * window instead. */

export interface ViewerInit {
  fileName: string;
  extension: string;
  size: number;
  /** A token URL — a primary viewer reads the file through it. */
  url?: string;
  /** The text of a preview viewer's file, as it was when the preview opened. */
  text?: string;
  /** The CSS variables of the current theme (`--bg`, `--fg`, …). */
  theme: Record<string, string>;
}

export type HostMessage =
  | ({ type: "init" } & ViewerInit)
  | { type: "theme"; theme: Record<string, string> }
  | { type: "resolved"; id: number; url: string | null };

export type ViewerMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "resolveRelative"; id: number; path: string };
```

`src/viewer/host.ts`:

```ts
import { h } from "../ui/dom";
import type { HostMessage, ViewerInit, ViewerMessage } from "./protocol";

/** No `allow-same-origin`: the frame gets an opaque origin and cannot reach the host page, its
 * storage or its Tauri API. No popups, forms or top navigation either. */
export const VIEWER_SANDBOX = "allow-scripts";
export const READY_TIMEOUT_MS = 5000;
export const NO_ANSWER = "뷰어가 응답하지 않습니다";

export interface ViewerHostOptions {
  url: string;
  readyTimeoutMs?: number;
  resolveRelative: (path: string) => Promise<string | null>;
  /** The viewer failed or never answered: show 「열 수 없음」 (spec 「뷰어」). */
  onError: (message: string) => void;
}

/** One viewer iframe and its side of the protocol. `start` queues `init` until `ready`. */
export class ViewerHost {
  readonly el: HTMLElement;
  private readonly frame: HTMLIFrameElement;
  private init: ViewerInit | null = null;
  private ready = false;
  private failed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onMessage = (event: MessageEvent<ViewerMessage>) => this.receive(event);

  constructor(private readonly options: ViewerHostOptions) {
    this.frame = h("iframe", { class: "viewer-frame", title: "뷰어" });
    this.frame.setAttribute("sandbox", VIEWER_SANDBOX);
    this.el = h("div", { class: "viewer-host" }, this.frame);
    window.addEventListener("message", this.onMessage);
    this.frame.src = options.url;
    this.timer = setTimeout(() => this.fail(NO_ANSWER), options.readyTimeoutMs ?? READY_TIMEOUT_MS);
  }

  start(init: ViewerInit): void {
    this.init = init;
    if (this.ready) this.send({ type: "init", ...init });
  }

  setTheme(theme: Record<string, string>): void {
    if (this.init) this.init = { ...this.init, theme };
    if (this.ready) this.send({ type: "theme", theme });
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    if (this.timer) clearTimeout(this.timer);
    this.frame.src = "about:blank";
    this.el.remove();
  }

  private receive(event: MessageEvent<ViewerMessage>): void {
    if (event.source !== this.frame.contentWindow || this.failed) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "ready":
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.ready = true;
        if (this.init) this.send({ type: "init", ...this.init });
        return;
      case "error":
        this.fail(typeof message.message === "string" ? message.message : "뷰어 오류");
        return;
      case "resolveRelative":
        if (typeof message.path !== "string" || typeof message.id !== "number") return;
        void this.options
          .resolveRelative(message.path)
          .catch(() => null)
          .then((url) => this.send({ type: "resolved", id: message.id, url }));
        return;
    }
  }

  private send(message: HostMessage): void {
    this.frame.contentWindow?.postMessage(message, "*");
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    if (this.timer) clearTimeout(this.timer);
    this.options.onError(message);
  }
}
```

`src/styles.css`:

```css
.viewer-host,
.viewer-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: var(--bg);
}
```

- [ ] **Step 7: 문서와 컨트롤러 — 주 뷰어 열기, 「열 수 없음」/「텍스트로 열기」**

`src/app/docs.ts` 의 `Doc`:

```ts
  /** 「텍스트로 열기」: read the bytes as text no matter what the kind says. */
  forceText = false;

  abstract get source(): FileSource;

  async openAsText(): Promise<void> {
    this.forceText = true;
    this.problem = null;
    this.state = null;
    await this.ensureLoaded();
  }
```

`MemoDoc.read` 와 `ExternalDoc.read` 의 `kind !== "text"` 검사를 `!this.forceText && info.kind !== "text"` 로 바꾸고, `MemoDoc` 에 `get source(): FileSource { return { kind: "memo", id: this.info.id }; }`, `ExternalDoc` 에 `get source(): FileSource { return { kind: "external", path: this.path }; }` 를 둔다. `ExternalDoc.read` 는 `forceText` 면 `readExternal` 로 간다(초안 분기 뒤, 크기 검사 앞).

`src/app/controller.ts`:

```ts
import { ViewerHost } from "../viewer/host";

export const NOT_OPENABLE = "열 수 없음";
export const OPEN_AS_TEXT = "텍스트로 열기";
```

필드 `private viewer: { doc: Doc; host: ViewerHost; owner: string } | null = null;`. `show(doc)` 를 바꾼다:

```ts
  private show(doc: Doc): void {
    this.closeViewer();
    const state = doc.problem ? null : doc.state;
    this.memoList.setActive(doc instanceof MemoDoc ? doc.info.id : null);
    this.statusBar.setLanguage(languageLabelFor(this.languageOf(doc), doc.fileName), () => void this.pickLanguageFor(doc));
    this.statusBar.setMessage(doc.notice ?? "");
    if (state) {
      this.surface.showEditor(state, doc.scrollAnchor);
      this.statusBar.setPosition(this.view.state);
      return;
    }
    this.statusBar.setPosition(null);
    const viewer = doc.problem === "binary" && !doc.forceText ? this.registry.viewerFor(doc.fileName, "primary") : undefined;
    if (viewer) this.openViewer(doc, viewer);
    else this.showProblem(doc);
  }

  private showProblem(doc: Doc): void {
    const text = doc.forceText || doc.problem !== "binary" ? PROBLEM_TEXT[doc.problem ?? "unreadable"] : NOT_OPENABLE;
    const fallback = !doc.forceText ? { label: OPEN_AS_TEXT, run: () => void this.openAsText(doc) } : undefined;
    this.surface.showPlaceholder(text, fallback);
  }

  private async openAsText(doc: Doc): Promise<void> {
    await doc.openAsText();
    if (doc === this.tabs.active) this.show(doc);
  }

  /** A primary viewer for a file the editor cannot show (spec 「뷰어」). The token lives as long
   * as this view: leaving the tab, closing it or a viewer failure revokes it. */
  private openViewer(doc: Doc, viewer: ViewerInfo): void {
    const owner = `${doc.tabId}:${viewer.id}`;
    const host = new ViewerHost({
      url: this.backend.viewerUrl(viewer.extension, viewer.entry),
      resolveRelative: (path) => this.backend.resolveRelative(doc.source, path, owner),
      onError: (message) => {
        console.warn(`viewer ${viewer.id}: ${message}`);
        this.closeViewer();
        if (doc === this.tabs.active) this.showProblem(doc);
      },
    });
    this.viewer = { doc, host, owner };
    this.surface.showPanel(host.el);
    void this.backend
      .issueFileToken(doc.source, owner)
      .then((url) => {
        if (this.viewer?.host !== host) return;
        host.start({
          fileName: doc.fileName,
          extension: splitName(doc.fileName).ext.toLowerCase(),
          size: doc instanceof MemoDoc ? doc.info.size : (doc as ExternalDoc).size,
          url,
          theme: this.theme.active.variables,
        });
      })
      .catch((error: unknown) => {
        this.report(error);
        this.closeViewer();
        if (doc === this.tabs.active) this.showProblem(doc);
      });
  }

  private closeViewer(): void {
    const open = this.viewer;
    if (!open) return;
    this.viewer = null;
    open.host.destroy();
    void this.backend.revokeFileTokens(open.owner).catch((error: unknown) => console.warn(error));
  }
```

`ExternalDoc` 에 `size = 0` 필드를 두고 `read()` 에서 `this.size = info.size` 로 채운다. `splitName` 과 `ViewerInfo` 를 import 한다. `closeTab` 에서 `this.tabs.remove(doc)` 앞에 `if (this.viewer?.doc === doc) this.closeViewer();`, `showEmpty` 의 첫 줄에 `this.closeViewer();`, `start()` 의 `this.theme.onChange` 에 `this.viewer?.host.setTheme(active.variables);` 를 더한다.

- [ ] **Step 8: 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`, `pnpm test`, `pnpm test:e2e`
Expected: Rust +17(범위 8 + 응답 6 + 토큰 3 + serve 2 + mod 1 + ops 1 중 이 태스크 분), Vitest 표의 새 줄 PASS, E2E `viewer.spec.ts` 5개와 `external.spec.ts` 의 새 1개 PASS(개수). 그 뒤 실제 앱으로 확인한다 — `pnpm tauri build --debug --bundles app --config src-tauri/tauri.dev.conf.json` 후:

```bash
TOTE_DATA_DIR=$(mktemp -d /tmp/tote-viewer-XXXX)
mkdir -p "$TOTE_DATA_DIR/workspaces/메모/.tote"
printf '{"version":1,"id":"check"}' > "$TOTE_DATA_DIR/workspaces/메모/.tote/workspace.json"
ffmpeg -y -loglevel error -f lavfi -i testsrc=size=320x240 -frames:v 1 "$TOTE_DATA_DIR/workspaces/메모/그림.png"
open --env TOTE_BACKGROUND=1 --env TOTE_DATA_DIR="$TOTE_DATA_DIR" src-tauri/target/debug/bundle/macos/tote-dev.app
```

사이드바의 `그림` 을 눌렀을 때(에이전트는 `orca-cli`·`computer-use` 가 아니라 `TOTE_DATA_DIR` 아래 세션 파일에 탭을 적어 두고 띄우는 식으로 확인한다 — `.tote/sessions/<기기 ID>.json` 에 `{"version":1,"activeTab":0,"tabs":[{"kind":"memo","memoId":"<index.json 의 ID>"}]}`) 창 안에 iframe 이 뜨고 Rust 의 stderr 에 `tote-ext` 요청이 찍히는지는 Task 11 의 미디어 뷰어가 있어야 보인다. 이 태스크에서는 `tote-dev.app` 이 뜨고 `Console.app` 에 CSP 위반 로그가 없음을 확인하는 데서 멈춘다. 확인 뒤 `osascript -e 'quit app "tote-dev"'`, `rm -rf "$TOTE_DATA_DIR"`.

- [ ] **Step 9: 커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
pnpm exec oxfmt src tests/e2e
pnpm exec oxlint --fix src tests/e2e
git add src-tauri/src/files src-tauri/src/extensions/serve.rs src-tauri/src/extensions/mod.rs src-tauri/src/lib.rs src-tauri/src/app src-tauri/src/workspace/ops.rs src-tauri/tauri.conf.json src/backend src/viewer src/app/docs.ts src/app/controller.ts src/styles.css tests/e2e/globals.d.ts tests/e2e/pages/viewer.html tests/e2e/pages/viewer.ts tests/e2e/pages/viewers tests/e2e/viewer.spec.ts tests/e2e/external.spec.ts
git commit -m "feat(files): token URLs with Range, the tote-file and tote-ext schemes, sandboxed viewer host and CSP"
```

---

### Task 11: 미디어 뷰어 — 번들 확장 `tote.media-viewer`

**Files:**

- Create: `src-tauri/resources/extensions/tote.media-viewer/package.json`, `src-tauri/resources/extensions/tote.media-viewer/viewer.template.html`, `src-tauri/resources/extensions/tote.media-viewer/viewer.html`(생성물), `tests/e2e/media.spec.ts`
- Modify: `src/backend/fake-registry.json`(생성물)

**Interfaces:**

- Consumes: Task 10 의 뷰어 프로토콜(`init` 의 `url`·`extension`·`theme`, `theme`), Task 5 의 `pnpm sync:bundled`(해시 CSP).
- Produces: 레지스트리의 뷰어 `{ extension: "tote.media-viewer", id: "media", kind: "primary", extensions: [png, jpg, jpeg, gif, webp, heic, bmp, tif, tiff, avif, svg, mp4, mov, m4v, webm, mp3, m4a, wav, aac, flac, ogg, aiff], entry: "viewer.html" }`. 화면: 이미지는 창 맞춤(기본) ↔ 실제 크기(클릭 전환), 영상·오디오는 `controls`, 재생 실패 시 「지원하지 않는 포맷」.

- [ ] **Step 1: 실패하는 테스트**

`tests/e2e/media.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

import { fakeFile } from "../../src/backend/fake";
import { menu, start } from "./helpers";

// A 1×1 PNG; the data: URL the fake issues carries exactly these bytes.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const frame = (page: Page) => page.frameLocator("iframe.viewer-frame");

test("an image opens fitted and a click shows it at its real size", async ({ page }) => {
  await start(page, { files: { "/x/점.png": fakeFile(PNG) }, picks: ["/x/점.png"] });
  await menu(page, "open-file");
  const img = frame(page).locator("img.media");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(frame(page).locator("body")).toHaveClass(/fit/);
  await img.click();
  await expect(frame(page).locator("body")).toHaveClass(/actual/);
  await expect(frame(page).locator(".media-caption")).toHaveText("점.png · 1×1");
});

test("a video and an audio file get the native player; a file that cannot play says so", async ({
  page,
}) => {
  await start(page, {
    files: {
      "/x/clip.mp4": fakeFile(new Uint8Array([1, 2, 3, 4])),
      "/x/voice.m4a": fakeFile(new Uint8Array([1, 2, 3, 4])),
    },
    picks: ["/x/clip.mp4", "/x/voice.m4a"],
  });
  await menu(page, "open-file");
  await expect(frame(page).locator("video.media[controls]")).toHaveCount(1);
  // Four bytes are not an MP4: the element errors and the viewer says the format is unsupported.
  await expect(frame(page).locator(".media-error")).toHaveText("지원하지 않는 포맷");
  await menu(page, "open-file");
  await expect(frame(page).locator("audio.media[controls]")).toHaveCount(1);
});

test("the viewer takes the theme's colours and follows a theme change", async ({ page }) => {
  await start(page, { files: { "/x/점.png": fakeFile(PNG) }, picks: ["/x/점.png"] });
  await menu(page, "open-file");
  const body = frame(page).locator("body");
  const before = await body.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.evaluate(() => window.__tote.app.theme.refresh());
  expect(await body.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(before);
  expect(before).not.toBe("rgba(0, 0, 0, 0)");
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test:e2e -- tests/e2e/media.spec.ts`
Expected: FAIL — 뷰어가 없어 「열 수 없음」 자리표시가 보인다.

- [ ] **Step 3: 확장**

`src-tauri/resources/extensions/tote.media-viewer/package.json`:

```json
{
  "name": "media-viewer",
  "publisher": "tote",
  "version": "1.0.0",
  "displayName": "tote 미디어 뷰어",
  "tote": {
    "viewers": [
      {
        "id": "media",
        "kind": "primary",
        "extensions": [
          "png",
          "jpg",
          "jpeg",
          "gif",
          "webp",
          "heic",
          "bmp",
          "tif",
          "tiff",
          "avif",
          "svg",
          "mp4",
          "mov",
          "m4v",
          "webm",
          "mp3",
          "m4a",
          "wav",
          "aac",
          "flac",
          "ogg",
          "aiff"
        ],
        "entry": "viewer.html"
      }
    ]
  }
}
```

`src-tauri/resources/extensions/tote.media-viewer/viewer.template.html`(스크립트는 하나, 해시는 생성기가 채운다):

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src tote-file: data:; media-src tote-file: data:; style-src 'unsafe-inline'; script-src __SCRIPT_HASHES__"
    />
    <title>미디어</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      html,
      body {
        height: 100%;
        margin: 0;
      }
      body {
        display: grid;
        grid-template-rows: minmax(0, 1fr) auto;
        background: var(--bg, #fff);
        color: var(--fg, #000);
        font:
          13px -apple-system,
          "Apple SD Gothic Neo",
          sans-serif;
      }
      .stage {
        overflow: auto;
        display: grid;
        place-items: center;
      }
      body.fit img.media {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        cursor: zoom-in;
      }
      body.actual .stage {
        place-items: start;
      }
      body.actual img.media {
        max-width: none;
        cursor: zoom-out;
      }
      video.media {
        max-width: 100%;
        max-height: 100%;
      }
      audio.media {
        width: min(480px, 90%);
      }
      .media-caption {
        padding: 4px 12px;
        color: var(--muted, #777);
        border-top: 1px solid var(--border, #ddd);
      }
      .media-error {
        color: var(--danger, #c00);
      }
    </style>
  </head>
  <body class="fit">
    <div class="stage" id="stage"></div>
    <div class="media-caption" id="caption"></div>
    <script>
      // Spec 「번들 확장」 4: images fit the window or show at their real size, nothing more;
      // video and audio use the WebView's own controls; what it cannot play is said so.
      const IMAGE = new Set([
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "heic",
        "bmp",
        "tif",
        "tiff",
        "avif",
        "svg",
      ]);
      const VIDEO = new Set(["mp4", "mov", "m4v", "webm"]);
      const stage = document.getElementById("stage");
      const caption = document.getElementById("caption");

      function applyTheme(theme) {
        for (const [name, value] of Object.entries(theme || {}))
          document.documentElement.style.setProperty(name, value);
      }

      function unsupported() {
        stage.replaceChildren();
        const p = document.createElement("p");
        p.className = "media-error";
        p.textContent = "지원하지 않는 포맷";
        stage.append(p);
      }

      function show(init) {
        applyTheme(init.theme);
        caption.textContent = init.fileName;
        const ext = (init.extension || "").toLowerCase();
        let el;
        if (IMAGE.has(ext)) {
          el = document.createElement("img");
          el.alt = init.fileName;
          el.addEventListener("load", () => {
            caption.textContent = `${init.fileName} · ${el.naturalWidth}×${el.naturalHeight}`;
          });
          el.addEventListener("click", () => {
            document.body.classList.toggle("fit");
            document.body.classList.toggle("actual");
          });
        } else {
          el = document.createElement(VIDEO.has(ext) ? "video" : "audio");
          el.controls = true;
          el.preload = "metadata";
        }
        el.className = "media";
        el.addEventListener("error", unsupported);
        el.src = init.url;
        stage.replaceChildren(el);
      }

      addEventListener("message", (event) => {
        const data = event.data;
        if (!data || typeof data !== "object") return;
        if (data.type === "init") show(data);
        if (data.type === "theme") applyTheme(data.theme);
      });
      parent.postMessage({ type: "ready" }, "*");
    </script>
  </body>
</html>
```

```bash
pnpm sync:bundled
grep -o "script-src 'sha256-[^']*'" src-tauri/resources/extensions/tote.media-viewer/viewer.html
```

Expected: `viewer.html` 이 생기고 CSP 에 해시 하나가 들어 있다. `src/backend/fake-registry.json` 의 `viewers` 에 `media` 가 들어간다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm test -- scripts` 와 `pnpm test:e2e -- tests/e2e/media.spec.ts tests/e2e/external.spec.ts`
Expected: 생성물 테스트 PASS, `media.spec.ts` 3개 PASS, `external.spec.ts` 그대로(개수).

- [ ] **Step 5: 커밋**

```bash
pnpm exec oxfmt src-tauri/resources/extensions/tote.media-viewer/package.json tests/e2e/media.spec.ts
git add src-tauri/resources/extensions/tote.media-viewer src/backend/fake-registry.json tests/e2e/media.spec.ts
git commit -m "feat(extensions): bundled media viewer for images, video and audio"
```

---

### Task 12: 마크다운 미리보기 — 번들 확장 `tote.markdown-preview`, ⇧⌘V 전환, 세션의 모드, 상대 경로 이미지

**Files:**

- Create: `src-tauri/resources/extensions/tote.markdown-preview/package.json`, `src-tauri/resources/extensions/tote.markdown-preview/viewer.template.html`, `src-tauri/resources/extensions/tote.markdown-preview/LICENSES.md`, `src-tauri/resources/extensions/tote.markdown-preview/viewer.html`(생성물), `tests/e2e/markdown.spec.ts`
- Modify: `src-tauri/src/app/menu.rs`, `src/app/controller.ts`, `src/backend/fake-registry.json`(생성물), `src/styles.css`

**Interfaces:**

- Consumes: `ViewerHost`·`ViewerInit.text`, `Doc.mode`(Task 1), `Registry.viewerFor(name, "preview")`, `Backend.resolveRelative`.
- Produces: 메뉴 `toggle-preview`(보기 › 미리보기 전환, `CmdOrCtrl+Shift+V`); `AppController.togglePreview(): Promise<void>`; 레지스트리의 뷰어 `{ extension: "tote.markdown-preview", id: "markdown", kind: "preview", extensions: ["md", "markdown"], entry: "viewer.html" }`.

- [ ] **Step 1: 실패하는 테스트**

`tests/e2e/markdown.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

import { fakeFile, fakeMemo } from "../../src/backend/fake";
import { menu, ready, start } from "./helpers";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const frame = (page: Page) => page.frameLocator("iframe.viewer-frame");

const DOC = [
  "# 회의 준비",
  "",
  "- 안건 **하나**",
  "",
  "![그림](pic.png)",
  "![원격](https://example.com/x.png)",
  "![밖](../secret.png)",
  "",
  '<img src="pic.png" onerror="document.body.dataset.pwned=1">',
  "<script>document.body.dataset.pwned = 2</script>",
  "",
  "[링크](https://example.com)",
].join("\n");

test("⇧⌘V shows the rendered Markdown and ⇧⌘V again the editor; the mode is in the session", async ({
  page,
}) => {
  await start(page, {
    memos: {
      a: fakeMemo("회의.md", DOC),
      pic: { file: "pic.png", autoTitle: false, data: fakeFile(PNG), modifiedMs: 1 },
    },
  });
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await menu(page, "toggle-preview");
  const body = frame(page).locator("body");
  await expect(body.locator("h1")).toHaveText("회의 준비");
  await expect(body.locator("li strong")).toHaveText("하나");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"mode":"preview"');
  await menu(page, "toggle-preview");
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .not.toContain('"mode"');
});

test("images in the same folder load through resolveRelative; outside the folder and remote images stay blank", async ({
  page,
}) => {
  await start(page, {
    memos: {
      a: fakeMemo("회의.md", DOC),
      pic: { file: "pic.png", autoTitle: false, data: fakeFile(PNG), modifiedMs: 1 },
    },
  });
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await menu(page, "toggle-preview");
  const body = frame(page).locator("body");
  await expect(body.locator("img[alt='그림']")).toHaveAttribute("src", /^data:image\/png/);
  await expect(body.locator("img[alt='원격']")).toHaveCount(0);
  await expect(body.locator(".blocked-image", { hasText: "원격" })).toHaveCount(1);
  await expect(body.locator("img[alt='밖']")).toHaveCount(0);
  await expect(body.locator(".blocked-image", { hasText: "밖" })).toHaveCount(1);
});

test("HTML in the Markdown cannot run scripts or handlers, and links do not navigate the frame", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("회의.md", DOC) } });
  await page.locator(".memo-row", { hasText: "회의" }).click();
  await menu(page, "toggle-preview");
  const body = frame(page).locator("body");
  await expect(body.locator("a", { hasText: "링크" })).toBeVisible();
  await body.locator("a", { hasText: "링크" }).click();
  await page.waitForTimeout(300);
  expect(await body.getAttribute("data-pwned")).toBeNull();
  await expect(body.locator("h1")).toHaveText("회의 준비"); // still our page, not example.com
});

test("the preview shows the text as it is when it opens, and the mode comes back after a restart", async ({
  page,
}) => {
  await start(page, { memos: { a: fakeMemo("a.md", "# 처음") } });
  await page.locator(".memo-row", { hasText: "a" }).click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\n둘째");
  await menu(page, "toggle-preview");
  await expect(frame(page).locator("body p")).toHaveText("둘째");
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.session))
    .toContain('"mode":"preview"');
  await page.reload();
  await ready(page);
  await expect(frame(page).locator("body h1")).toHaveText("처음");
});

test("a file without a preview viewer ignores ⇧⌘V", async ({ page }) => {
  await start(page, { memos: { a: fakeMemo("a.txt", "plain") } });
  await page.locator(".memo-row", { hasText: "a" }).click();
  await menu(page, "toggle-preview");
  await page.waitForTimeout(200);
  await expect(page.locator("iframe.viewer-frame")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test:e2e -- tests/e2e/markdown.spec.ts`
Expected: FAIL — `toggle-preview` 가 아무것도 하지 않는다.

- [ ] **Step 3: 확장**

`src-tauri/resources/extensions/tote.markdown-preview/package.json`:

```json
{
  "name": "markdown-preview",
  "publisher": "tote",
  "version": "1.0.0",
  "displayName": "tote 마크다운 미리보기",
  "tote": {
    "viewers": [
      {
        "id": "markdown",
        "kind": "preview",
        "extensions": ["md", "markdown"],
        "entry": "viewer.html"
      }
    ]
  }
}
```

`src-tauri/resources/extensions/tote.markdown-preview/LICENSES.md`:

```markdown
# tote.markdown-preview — 포함한 라이브러리

| 이름   | 라이선스 | 원문                                                      | 비고                                                                          |
| ------ | -------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| marked | MIT      | https://github.com/markedjs/marked/blob/master/LICENSE.md | `viewer.html` 에 `lib/marked.umd.js` 가 그대로 들어 있다(`pnpm sync:bundled`) |
```

`src-tauri/resources/extensions/tote.markdown-preview/viewer.template.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src tote-file: data:; style-src 'unsafe-inline'; script-src __SCRIPT_HASHES__"
    />
    <title>미리보기</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        padding: 16px 24px;
        background: var(--bg, #fff);
        color: var(--fg, #000);
        font:
          15px/1.6 -apple-system,
          "Apple SD Gothic Neo",
          sans-serif;
      }
      main {
        max-width: 760px;
        margin: 0 auto;
      }
      pre,
      code {
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 0.92em;
      }
      pre {
        padding: 12px;
        overflow: auto;
        background: color-mix(in srgb, var(--fg, #000) 6%, transparent);
        border-radius: 6px;
      }
      img {
        max-width: 100%;
      }
      a {
        color: var(--accent, #06c);
      }
      blockquote {
        margin: 0;
        padding-left: 12px;
        border-left: 3px solid var(--border, #ddd);
        color: var(--muted, #666);
      }
      table {
        border-collapse: collapse;
      }
      th,
      td {
        padding: 4px 8px;
        border: 1px solid var(--border, #ddd);
      }
      .blocked-image {
        display: inline-block;
        padding: 2px 6px;
        border: 1px dashed var(--border, #999);
        color: var(--muted, #666);
        font-size: 0.85em;
      }
    </style>
  </head>
  <body>
    <main id="main"></main>
    <script>
      __INLINE: marked__;
    </script>
    <script>
      // Spec 「마크다운 미리보기」: the text arrives by message, relative images come back as token
      // URLs from the host, remote images are not shown. Markdown may carry raw HTML; the CSP has
      // no 'unsafe-inline' for scripts and the sandbox has no navigation, so what remains is kept
      // from running by stripping the elements that could still act (script, meta refresh, frames,
      // forms) before the HTML enters the document.
      const DROP =
        "script, meta, link, base, iframe, frame, object, embed, form, input, button, textarea, select, style";
      const main = document.getElementById("main");
      let nextId = 1;
      const waiting = new Map();

      function applyTheme(theme) {
        for (const [name, value] of Object.entries(theme || {}))
          document.documentElement.style.setProperty(name, value);
      }

      function resolve(path) {
        return new Promise((resolve) => {
          const id = nextId++;
          waiting.set(id, resolve);
          parent.postMessage({ type: "resolveRelative", id, path }, "*");
        });
      }

      function blocked(img, label) {
        const span = document.createElement("span");
        span.className = "blocked-image";
        span.textContent = `${label}: ${img.getAttribute("alt") || img.getAttribute("src") || ""}`;
        img.replaceWith(span);
      }

      async function placeImage(img) {
        const src = img.getAttribute("src") || "";
        if (/^data:/i.test(src)) return;
        if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/") || src.startsWith("//"))
          return blocked(img, "원격 이미지");
        const url = await resolve(src);
        if (url) img.src = url;
        else blocked(img, "찾을 수 없음");
      }

      function render(text) {
        const html = marked.parse(text, { async: false, gfm: true });
        const template = document.createElement("template");
        template.innerHTML = html;
        for (const el of template.content.querySelectorAll(DROP)) el.remove();
        for (const el of template.content.querySelectorAll("*")) {
          for (const attr of [...el.attributes]) {
            if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value))
              el.removeAttribute(attr.name);
          }
        }
        main.replaceChildren(template.content);
        for (const img of main.querySelectorAll("img")) placeImage(img);
      }

      addEventListener("click", (event) => {
        const link = event.target instanceof Element ? event.target.closest("a") : null;
        if (link) event.preventDefault();
      });

      addEventListener("message", (event) => {
        const data = event.data;
        if (!data || typeof data !== "object") return;
        if (data.type === "init") {
          applyTheme(data.theme);
          try {
            render(data.text || "");
          } catch (error) {
            parent.postMessage({ type: "error", message: String(error) }, "*");
          }
        }
        if (data.type === "theme") applyTheme(data.theme);
        if (data.type === "resolved") {
          const resolve = waiting.get(data.id);
          waiting.delete(data.id);
          if (resolve) resolve(data.url);
        }
      });
      parent.postMessage({ type: "ready" }, "*");
    </script>
  </body>
</html>
```

```bash
pnpm sync:bundled
grep -c "sha256-" src-tauri/resources/extensions/tote.markdown-preview/viewer.html   # 1 line with two hashes
ls -la src-tauri/resources/extensions/tote.markdown-preview/viewer.html             # ~50KB: marked is inlined
```

- [ ] **Step 4: 메뉴와 컨트롤러**

`src-tauri/src/app/menu.rs` 의 `view` 서브메뉴에, `prev-tab` 다음 `separator()` 앞에:

```rust
        .separator()
        .item(&item(
            app,
            "toggle-preview",
            "미리보기 전환",
            Some("CmdOrCtrl+Shift+V"),
        )?)
```

`src/app/controller.ts`:

- `onMenu` 에 `case "toggle-preview": return await this.togglePreview();`
- `openViewer(doc, viewer, text?: string)` — `text` 가 있으면 토큰 대신 그 텍스트로 `init` 한다:

```ts
  /** A viewer for `doc` (spec 「뷰어」): a primary viewer gets a token URL, a preview viewer
   * gets `text`. The token lives as long as this view: leaving the tab, closing it or a viewer
   * failure revokes it. */
  private openViewer(doc: Doc, viewer: ViewerInfo, text?: string): void {
    const owner = `${doc.tabId}:${viewer.id}`;
    const host = new ViewerHost({
      url: this.backend.viewerUrl(viewer.extension, viewer.entry),
      resolveRelative: (path) => this.backend.resolveRelative(doc.source, path, owner),
      onError: (message) => {
        console.warn(`viewer ${viewer.id}: ${message}`);
        this.closeViewer();
        if (doc === this.tabs.active) this.showProblem(doc);
      },
    });
    this.viewer = { doc, host, owner };
    this.surface.showPanel(host.el);
    const base = {
      fileName: doc.fileName,
      extension: splitName(doc.fileName).ext.toLowerCase(),
      theme: this.theme.active.variables,
    };
    if (text !== undefined) {
      host.start({ ...base, size: text.length, text });
      return;
    }
    void this.backend
      .issueFileToken(doc.source, owner)
      .then((url) => {
        if (this.viewer?.host !== host) return;
        host.start({
          ...base,
          size: doc instanceof MemoDoc ? doc.info.size : (doc as ExternalDoc).size,
          url,
        });
      })
      .catch((error: unknown) => {
        this.report(error);
        this.closeViewer();
        if (doc === this.tabs.active) this.showProblem(doc);
      });
  }
```

- `show(doc)` 에서 편집기를 보이기 전에 미리보기를 본다:

```ts
if (state) {
  const preview =
    doc.mode === "preview" ? this.registry.viewerFor(doc.fileName, "preview") : undefined;
  if (preview) {
    this.openViewer(doc, preview, state.doc.toString());
    this.statusBar.setPosition(null);
    this.statusBar.setMessage("미리보기 · ⇧⌘V 로 편집");
    return;
  }
  this.surface.showEditor(state, doc.scrollAnchor);
  this.statusBar.setPosition(this.view.state);
  return;
}
```

- 전환:

```ts
  /** ⇧⌘V (spec 「마크다운 미리보기」): per tab, with the text as it is right now. */
  async togglePreview(): Promise<void> {
    const doc = this.tabs.active;
    if (!doc || !doc.state || doc.problem) return;
    if (!this.registry.viewerFor(doc.fileName, "preview")) return;
    this.capture(doc);
    await doc.leave();
    doc.mode = doc.mode === "preview" ? "edit" : "preview";
    this.show(doc);
    this.saveSessionSoon();
  }
```

`capture(doc)` 은 편집기가 보일 때만 스크롤을 읽으므로(Task 1) 미리보기 중에는 건드리지 않는다. 미리보기 iframe 의 `onError` 는 Task 10 의 것 그대로 — 실패하면 `showProblem(doc)` 이 「열 수 없음」과 「텍스트로 열기」를 보이고, `openAsText` 가 `doc.mode = "edit"` 로 되돌린다(`Doc.openAsText` 의 첫 줄에 `this.mode = "edit";` 를 더한다).

- [ ] **Step 5: 통과 확인**

Run: `pnpm test -- scripts` 와 `pnpm test:e2e`
Expected: 생성물 테스트 PASS, `markdown.spec.ts` 5개 PASS, 나머지 그대로(개수). `cargo build --manifest-path src-tauri/Cargo.toml` 통과.

- [ ] **Step 6: 커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
pnpm exec oxfmt src/app/controller.ts src/app/docs.ts src-tauri/resources/extensions/tote.markdown-preview/package.json tests/e2e/markdown.spec.ts
pnpm exec oxlint --fix src/app tests/e2e
git add src-tauri/resources/extensions/tote.markdown-preview src-tauri/src/app/menu.rs src/app/controller.ts src/app/docs.ts src/backend/fake-registry.json tests/e2e/markdown.spec.ts
git commit -m "feat(extensions): bundled Markdown preview with ⇧⌘V and relative images through resolveRelative"
```

---

### Task 13: 대용량 텍스트 뷰어 — 100MB 초과·긴 줄 파일의 읽기 전용 화면, Range 페이지 읽기, Rust 파일 안 검색

**Files:**

- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/files/mod.rs`, `src-tauri/src/app/mod.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/lib.rs`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/tauri.test.ts`, `src/backend/fake.ts`, `src/app/docs.ts`, `src/app/docs.test.ts`, `src/app/controller.ts`, `src/styles.css`, `tests/e2e/globals.d.ts`
- Create: `src-tauri/src/files/text.rs`, `src/viewer/large-text.ts`, `src/viewer/large-text.test.ts`, `tests/e2e/large-text.spec.ts`

**Interfaces:**

- Consumes: `TokenStore`·`token_url`·`FileSource`, `source_path`(Task 10), `Surface.showPanel`, `longestLine`(`src/core/codec.ts`).
- Produces (`crate::files::text`): `CHECKPOINT_LINES: u64 = 1000`, `TextScan { size: u64, line_count: u64, checkpoints: Vec<u64>, longest_line: u64 }`, `scan(path: &Path) -> io::Result<TextScan>`, `TextQuery { query: String, case_sensitive: bool, regex: bool }`, `TextMatch { line: u64, column: u64 }`, `TextSearch { matches: Vec<TextMatch>, done: bool, cancelled: bool }`, `search(path: &Path, query: &TextQuery, from_line: u64, limit: usize, cancelled: &dyn Fn() -> bool) -> Result<TextSearch, SearchError>`, `SearchError { BadPattern(String), Io(io::Error) }`, `SEARCH_PAGE: usize = 200`.
- Produces (명령): `scan_text(source) -> TextScan`, `search_text(source, query, from_line, request_id) -> TextSearch`(코드 `bad-request` 는 깨진 정규식). `AppCore` gains `searches: Mutex<HashMap<String, u64>>`(창 라벨 → 최신 요청 번호).
- Produces (`Backend`): `scanText(source: FileSource): Promise<TextScan>`, `searchText(source: FileSource, query: TextQuery, fromLine: number, requestId: number): Promise<TextSearch>`. 타입 `TextScan`, `TextQuery`, `TextMatch`, `TextSearch` 는 Rust 와 같은 이름(camelCase).
- Produces (`src/viewer/large-text.ts`): `LINE_HEIGHT = 20`, `DISPLAY_LINE_LIMIT = 20_000`, `CHECKPOINT_LINES = 1000`, `scanBytes(bytes: Uint8Array): TextScan`(가짜 백엔드와 테스트용, Rust 와 같은 규칙), `pageOf(line: number): number`, `pageRange(scan: TextScan, page: number): [number, number]`, `visibleLines(scrollTop: number, height: number, lineCount: number): [number, number]`, `displayLine(text: string): string`, `class LargeTextViewer { readonly el: HTMLElement; constructor(options: { url: string; scan: TextScan; fileName: string; search: (query: TextQuery, fromLine: number) => Promise<TextSearch> }); goToLine(line: number): void; destroy(): void }`.
- Produces (`src/app/docs.ts`): `Problem` gains `"long-line"`; `LONG_LINE_LIMIT = 1_000_000`(잠정값 — Task 14 가 실측으로 바꾼다); `ExternalDoc.size`·`MemoDoc.info.size`.
- `AppController` opens the large text viewer for `too-large` and `long-line`.

- [ ] **Step 1: 실패하는 테스트 — Rust**

`src-tauri/src/files/text.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn file(lines: &[&str]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.log");
        fs::write(&path, lines.join("\n")).unwrap();
        (dir, path)
    }

    #[test]
    fn scan_counts_lines_checkpoints_and_the_longest_line() {
        let lines: Vec<String> = (0..2500).map(|i| format!("line {i}")).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let (_dir, path) = file(&refs);
        let scan = scan(&path).unwrap();
        assert_eq!(scan.line_count, 2500);
        assert_eq!(scan.size, fs::metadata(&path).unwrap().len());
        // Checkpoints at lines 0, 1000, 2000 — byte offsets of their first byte.
        assert_eq!(scan.checkpoints.len(), 3);
        assert_eq!(scan.checkpoints[0], 0);
        let text = fs::read_to_string(&path).unwrap();
        let offset_of_line = |n: usize| text.split_inclusive('\n').take(n).map(str::len).sum::<usize>() as u64;
        assert_eq!(scan.checkpoints[1], offset_of_line(1000));
        assert_eq!(scan.checkpoints[2], offset_of_line(2000));
        assert_eq!(scan.longest_line, "line 2499".len() as u64);
    }

    #[test]
    fn scan_handles_a_trailing_newline_an_empty_file_and_crlf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "a\nbb\n").unwrap();
        let s = scan(&path).unwrap();
        assert_eq!((s.line_count, s.longest_line), (3, 2)); // the empty line after the last \n counts, as the editor counts it
        fs::write(&path, "").unwrap();
        let s = scan(&path).unwrap();
        assert_eq!((s.line_count, s.checkpoints.len()), (1, 1));
        fs::write(&path, "a\r\nbbb\r\n").unwrap();
        assert_eq!(scan(&path).unwrap().longest_line, 4); // \r stays in the line; the viewer strips it
    }

    #[test]
    fn search_finds_literal_and_regex_matches_with_case_options_and_pages() {
        let (_dir, path) = file(&["Error one", "fine", "error two", "ERROR three", "x"]);
        let q = |query: &str, case_sensitive: bool, regex: bool| TextQuery { query: query.into(), case_sensitive, regex };
        let all = search(&path, &q("error", false, false), 0, 10, &|| false).unwrap();
        assert_eq!(all.matches.iter().map(|m| (m.line, m.column)).collect::<Vec<_>>(), vec![(0, 0), (2, 0), (3, 0)]);
        assert!(all.done && !all.cancelled);
        let sensitive = search(&path, &q("error", true, false), 0, 10, &|| false).unwrap();
        assert_eq!(sensitive.matches.len(), 1);
        let regex = search(&path, &q("e.r", true, true), 0, 10, &|| false).unwrap();
        assert_eq!(regex.matches.len(), 1); // "error two" only (e·r·r)
        let paged = search(&path, &q("e", false, false), 0, 2, &|| false).unwrap();
        assert_eq!(paged.matches.len(), 2);
        assert!(!paged.done);
        let next = search(&path, &q("e", false, false), paged.matches.last().unwrap().line + 1, 10, &|| false).unwrap();
        assert!(next.done);
        // A literal that looks like a regex is still a literal.
        let literal = search(&path, &q("e.r", false, false), 0, 10, &|| false).unwrap();
        assert!(literal.matches.is_empty());
        assert!(matches!(search(&path, &q("(", false, true), 0, 10, &|| false), Err(SearchError::BadPattern(_))));
    }

    #[test]
    fn search_stops_when_cancelled_and_says_so() {
        let lines: Vec<String> = (0..5000).map(|i| format!("row {i}")).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let (_dir, path) = file(&refs);
        let q = TextQuery { query: "row".into(), case_sensitive: false, regex: false };
        let result = search(&path, &q, 0, 10_000, &|| true).unwrap();
        assert!(result.cancelled && !result.done);
        assert!(result.matches.len() < 5000);
    }
}
```

`src-tauri/src/app/mod.rs` 테스트에 더한다:

```rust
    #[test]
    fn only_the_latest_search_of_a_window_is_live() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.begin_search("ws-1", 1);
        assert!(core.search_is_live("ws-1", 1));
        core.begin_search("ws-1", 2);
        assert!(!core.search_is_live("ws-1", 1));
        assert!(core.search_is_live("ws-1", 2));
        core.begin_search("ws-2", 1);
        assert!(core.search_is_live("ws-2", 1) && core.search_is_live("ws-1", 2));
    }
```

- [ ] **Step 2: 실패하는 테스트 — 프론트**

`src/viewer/large-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  displayLine,
  DISPLAY_LINE_LIMIT,
  pageOf,
  pageRange,
  scanBytes,
  visibleLines,
} from "./large-text";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("scanBytes", () => {
  it("matches the Rust scan: lines, checkpoints every 1000 lines, longest line in bytes", () => {
    const text = Array.from({ length: 2500 }, (_, i) => `줄 ${i}`).join("\n");
    const scan = scanBytes(utf8(text));
    expect(scan.lineCount).toBe(2500);
    expect(scan.size).toBe(utf8(text).length);
    expect(scan.checkpoints).toHaveLength(3);
    expect(scan.checkpoints[0]).toBe(0);
    expect(scan.checkpoints[1]).toBe(
      utf8(text.split("\n").slice(0, 1000).join("\n") + "\n").length,
    );
    expect(scan.longestLine).toBe(utf8("줄 2499").length);
    expect(scanBytes(utf8(""))).toEqual({
      size: 0,
      lineCount: 1,
      checkpoints: [0],
      longestLine: 0,
    });
    expect(scanBytes(utf8("a\nbb\n")).lineCount).toBe(3);
  });
});

describe("paging", () => {
  const scan = { size: 100, lineCount: 2500, checkpoints: [0, 40, 80], longestLine: 5 };
  it("maps lines to pages and pages to byte ranges ending at the next checkpoint or the file end", () => {
    expect(pageOf(0)).toBe(0);
    expect(pageOf(999)).toBe(0);
    expect(pageOf(1000)).toBe(1);
    expect(pageRange(scan, 0)).toEqual([0, 40]);
    expect(pageRange(scan, 1)).toEqual([40, 80]);
    expect(pageRange(scan, 2)).toEqual([80, 100]);
  });

  it("visibleLines covers the viewport with a margin and stays inside the file", () => {
    expect(visibleLines(0, 200, 2500)).toEqual([0, 30]);
    expect(visibleLines(49_900, 200, 2500)).toEqual([2475, 2500]);
    expect(visibleLines(0, 200, 3)).toEqual([0, 3]);
  });
});

describe("displayLine", () => {
  it("strips a trailing CR and cuts a line past the display limit with its length", () => {
    expect(displayLine("abc\r")).toBe("abc");
    const long = "y".repeat(DISPLAY_LINE_LIMIT + 5);
    expect(displayLine(long)).toBe(
      `${"y".repeat(DISPLAY_LINE_LIMIT)} … (${DISPLAY_LINE_LIMIT + 5}자)`,
    );
  });
});
```

`src/app/docs.test.ts` 에 더한다:

```ts
it("a text file with a line over the long-line limit does not load into the editor", async () => {
  const { backend, host } = setup({
    memos: { a: fakeMemo("one-line.json", "x".repeat(LONG_LINE_LIMIT + 1)) },
  });
  const doc = new MemoDoc(host, (await backend.listMemos())[0]);
  await doc.ensureLoaded();
  expect(doc.problem).toBe("long-line");
  expect(doc.state).toBeNull();
});
```

(`LONG_LINE_LIMIT` 를 `./docs` 에서 import.)

`src/backend/tauri.test.ts` 표에 `[() => backend.scanText({ kind: "memo", id: "m" }), "scan_text", { source: { kind: "memo", id: "m" } }],` 와 `[() => backend.searchText({ kind: "external", path: "/x" }, { query: "q", caseSensitive: false, regex: false }, 10, 3), "search_text", { source: { kind: "external", path: "/x" }, query: { query: "q", caseSensitive: false, regex: false }, fromLine: 10, requestId: 3 }],` 를 더한다.

`tests/e2e/large-text.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { fakeFile } from "../../src/backend/fake";
import { LONG_LINE_LIMIT } from "../../src/app/docs";
import { menu, start } from "./helpers";

// 3,000 short lines with one line past the long-line limit in the middle: paged reads and the
// long-line cut both come into play.
const lines = Array.from({ length: 3000 }, (_, i) =>
  i === 1500 ? "L".repeat(LONG_LINE_LIMIT + 1) : `row ${i} needle${i % 700 === 0 ? " hit" : ""}`,
);
const TEXT = lines.join("\n");

test("a file with a line over the limit opens read-only in the large text viewer and pages through the file", async ({
  page,
}) => {
  await start(page, { files: { "/x/huge.log": fakeFile(TEXT) }, picks: ["/x/huge.log"] });
  await menu(page, "open-file");
  const viewer = page.locator(".large-text");
  await expect(viewer).toBeVisible();
  await expect(page.locator(".status-message")).toHaveText("읽기 전용 · 대용량 텍스트 뷰어");
  await expect(viewer.locator(".large-text-info")).toHaveText("3,000줄");
  await expect(viewer.locator(".large-text-line").first()).toHaveText("row 0 needle hit");
  await page.evaluate(() => window.__tote.app.largeText!.goToLine(1500));
  await expect(viewer.locator(".large-text-line.current")).toContainText("… (1000001자)");
  await page.evaluate(() => window.__tote.app.largeText!.goToLine(2999));
  await expect(viewer.locator(".large-text-line.current")).toHaveText("row 2999 needle");
});

test("search runs in the backend and walks the matches", async ({ page }) => {
  await start(page, { files: { "/x/huge.log": fakeFile(TEXT) }, picks: ["/x/huge.log"] });
  await menu(page, "open-file");
  const viewer = page.locator(".large-text");
  await viewer.locator(".large-text-search input").fill("HIT");
  await viewer.locator(".large-text-search input").press("Enter");
  await expect(viewer.locator(".large-text-count")).toHaveText("1 / 5");
  await expect(viewer.locator(".large-text-line.current")).toHaveText("row 0 needle hit");
  await viewer.locator("button", { hasText: "다음" }).click();
  await expect(viewer.locator(".large-text-count")).toHaveText("2 / 5");
  await expect(viewer.locator(".large-text-line.current")).toHaveText("row 700 needle hit");
  await viewer.locator("label", { hasText: "대소문자" }).click();
  await viewer.locator(".large-text-search input").press("Enter");
  await expect(viewer.locator(".large-text-count")).toHaveText("0");
  await viewer.locator("label", { hasText: "대소문자" }).click();
  await viewer.locator("label", { hasText: "정규식" }).click();
  await viewer.locator(".large-text-search input").fill("row 2[0-9]00 ");
  await viewer.locator(".large-text-search input").press("Enter");
  await expect(viewer.locator(".large-text-count")).toHaveText("1 / 10");
});

test("closing the tab takes the viewer and its token down", async ({ page }) => {
  await start(page, { files: { "/x/huge.log": fakeFile(TEXT) }, picks: ["/x/huge.log"] });
  await menu(page, "open-file");
  await expect(page.locator(".large-text")).toBeVisible();
  expect(Object.keys(await page.evaluate(() => window.__tote.backend.data.tokens))).toHaveLength(1);
  await menu(page, "close-tab");
  await expect(page.locator(".large-text")).toHaveCount(0);
  expect(await page.evaluate(() => window.__tote.backend.data.tokens)).toEqual({});
});
```

`tests/e2e/globals.d.ts` 는 `AppController` 타입을 쓰므로 `largeText` 가 public 이면 더할 것이 없다.

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml text`, `pnpm test -- src/viewer src/app/docs src/backend`, `pnpm test:e2e -- tests/e2e/large-text.spec.ts`
Expected: 컴파일 오류 / 모듈 없음 / FAIL.

- [ ] **Step 4: Rust**

`src-tauri/Cargo.toml` 에 `regex = "1"` 과 `memchr = "2"` 를 더한다.

`src-tauri/src/files/text.rs`:

```rust
//! The large text viewer's backend (spec 「크기별 단계」): a scan that gives the line count and
//! a byte offset every CHECKPOINT_LINES lines, so the viewer fetches whole pages of lines by
//! Range and splits them itself, and a search that streams the file and returns a page of
//! matches at a time.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const CHECKPOINT_LINES: u64 = 1000;
pub const SEARCH_PAGE: usize = 200;
const READ_CHUNK: usize = 1 << 20;
const CANCEL_CHECK_LINES: u64 = 1000;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextScan {
    pub size: u64,
    /// As the editor counts: the text after the last `\n` is a line, even when empty.
    pub line_count: u64,
    /// Byte offset of the first byte of line 0, CHECKPOINT_LINES, 2·CHECKPOINT_LINES, …
    pub checkpoints: Vec<u64>,
    /// In bytes (`\r` included).
    pub longest_line: u64,
}

pub fn scan(path: &Path) -> io::Result<TextScan> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut buf = vec![0u8; READ_CHUNK];
    let mut offset: u64 = 0;
    let mut line: u64 = 0;
    let mut line_start: u64 = 0;
    let mut longest: u64 = 0;
    let mut checkpoints = vec![0u64];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let mut from = 0;
        while let Some(i) = memchr::memchr(b'\n', &buf[from..n]) {
            let end = offset + (from + i) as u64;
            longest = longest.max(end - line_start);
            line += 1;
            line_start = end + 1;
            if line % CHECKPOINT_LINES == 0 {
                checkpoints.push(line_start);
            }
            from += i + 1;
        }
        offset += n as u64;
    }
    longest = longest.max(size - line_start);
    Ok(TextScan {
        size,
        line_count: line + 1,
        checkpoints,
        longest_line: longest,
    })
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextQuery {
    pub query: String,
    pub case_sensitive: bool,
    pub regex: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TextMatch {
    pub line: u64,
    /// Byte offset inside the line.
    pub column: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TextSearch {
    pub matches: Vec<TextMatch>,
    /// The whole file was searched; `false` with `cancelled == false` means the page filled up —
    /// ask again from the line after the last match.
    pub done: bool,
    pub cancelled: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("not a valid pattern: {0}")]
    BadPattern(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Matches from `from_line` on, at most `limit`, line by line through the file. `cancelled` is
/// asked every CANCEL_CHECK_LINES lines; a newer search from the same window answers true.
pub fn search(
    path: &Path,
    query: &TextQuery,
    from_line: u64,
    limit: usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<TextSearch, SearchError> {
    let pattern = if query.regex {
        query.query.clone()
    } else {
        regex::escape(&query.query)
    };
    let re = regex::bytes::RegexBuilder::new(&pattern)
        .case_insensitive(!query.case_sensitive)
        .build()
        .map_err(|err| SearchError::BadPattern(err.to_string()))?;
    let mut reader = BufReader::with_capacity(READ_CHUNK, File::open(path)?);
    let mut line_buf = Vec::new();
    let mut line: u64 = 0;
    let mut matches = Vec::new();
    loop {
        line_buf.clear();
        let n = reader.read_until(b'\n', &mut line_buf)?;
        if n == 0 {
            return Ok(TextSearch { matches, done: true, cancelled: false });
        }
        if line >= from_line && !query.query.is_empty() {
            let text = line_buf.strip_suffix(b"\n").unwrap_or(&line_buf);
            for found in re.find_iter(text) {
                matches.push(TextMatch { line, column: found.start() as u64 });
                if matches.len() >= limit {
                    return Ok(TextSearch { matches, done: false, cancelled: false });
                }
            }
        }
        line += 1;
        if line % CANCEL_CHECK_LINES == 0 && cancelled() {
            return Ok(TextSearch { matches, done: false, cancelled: true });
        }
    }
}
```

`src-tauri/src/files/mod.rs` 에 `pub mod text;` 를 더한다. `src-tauri/src/app/mod.rs` 의 `AppCore` 에 `searches: Mutex<HashMap<String, u64>>` 와:

```rust
    /// A new search from `window`: earlier ones of that window stop at their next check.
    pub fn begin_search(&self, window: &str, request_id: u64) {
        lock(&self.searches).insert(window.to_string(), request_id);
    }

    pub fn search_is_live(&self, window: &str, request_id: u64) -> bool {
        lock(&self.searches).get(window) == Some(&request_id)
    }
```

`src-tauri/src/app/commands.rs`:

```rust
use crate::files::text::{self, SearchError, TextQuery, TextScan, TextSearch};

impl From<SearchError> for CommandError {
    fn from(err: SearchError) -> CommandError {
        match err {
            SearchError::BadPattern(message) => CommandError::new("bad-request", message),
            SearchError::Io(io) => io.into(),
        }
    }
}

#[tauri::command]
pub async fn scan_text(core: State<'_, AppCore>, window: WebviewWindow, source: FileSource) -> CmdResult<TextScan> {
    let path = source_path(&core, &window, &source)?;
    Ok(text::scan(&path)?)
}

#[tauri::command]
pub async fn search_text(
    core: State<'_, AppCore>,
    window: WebviewWindow,
    source: FileSource,
    query: TextQuery,
    from_line: u64,
    request_id: u64,
) -> CmdResult<TextSearch> {
    let path = source_path(&core, &window, &source)?;
    let label = window.label().to_string();
    core.begin_search(&label, request_id);
    let live = || core.search_is_live(&label, request_id);
    Ok(text::search(&path, &query, from_line, text::SEARCH_PAGE, &|| !live())?)
}
```

`generate_handler!` 에 둘을 더한다.

- [ ] **Step 5: 프론트 — 백엔드와 뷰어**

`src/backend/types.ts`:

```ts
export interface TextScan {
  size: number;
  lineCount: number;
  checkpoints: number[];
  longestLine: number;
}

export interface TextQuery {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
}

export interface TextMatch {
  line: number;
  column: number;
}

export interface TextSearch {
  matches: TextMatch[];
  done: boolean;
  cancelled: boolean;
}
```

`Backend` 에 `scanText(source: FileSource): Promise<TextScan>;` 과 `searchText(source: FileSource, query: TextQuery, fromLine: number, requestId: number): Promise<TextSearch>;`. `src/backend/tauri.ts`:

```ts
  scanText(source: FileSource) {
    return call<TextScan>("scan_text", { source });
  }
  searchText(source: FileSource, query: TextQuery, fromLine: number, requestId: number) {
    return call<TextSearch>("search_text", { source, query, fromLine, requestId });
  }
```

`src/backend/fake.ts`(`scanBytes` 를 `../viewer/large-text` 에서 import):

```ts
  async scanText(source: FileSource) {
    const found = this.sourceBytes(source);
    if (!found) throw new BackendError("not-found", JSON.stringify(source));
    return scanBytes(fromBase64(found.data));
  }

  async searchText(source: FileSource, query: TextQuery, fromLine: number, _requestId: number) {
    const found = this.sourceBytes(source);
    if (!found) throw new BackendError("not-found", JSON.stringify(source));
    const lines = new TextDecoder().decode(fromBase64(found.data)).split("\n");
    let pattern: RegExp;
    try {
      pattern = new RegExp(query.regex ? query.query : query.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), query.caseSensitive ? "g" : "gi");
    } catch (error) {
      throw new BackendError("bad-request", String(error));
    }
    const matches: TextMatch[] = [];
    if (query.query) {
      for (let line = fromLine; line < lines.length; line++) {
        for (const m of lines[line].replace(/\r$/, "").matchAll(pattern)) {
          matches.push({ line, column: new TextEncoder().encode(lines[line].slice(0, m.index)).length });
          if (matches.length >= 200) return { matches, done: false, cancelled: false };
        }
      }
    }
    return { matches, done: true, cancelled: false };
  }
```

`src/viewer/large-text.ts`:

```ts
import type { TextQuery, TextScan, TextSearch } from "../backend/types";
import { h } from "../ui/dom";

export const LINE_HEIGHT = 20;
/** Characters of a line that are put in the DOM; the rest is summarised. */
export const DISPLAY_LINE_LIMIT = 20_000;
/** Same as CHECKPOINT_LINES in src-tauri/src/files/text.rs. */
export const CHECKPOINT_LINES = 1000;
const OVERSCAN_LINES = 10;

/** The scan the Rust side makes, for the fake backend and the tests. */
export function scanBytes(bytes: Uint8Array): TextScan {
  const checkpoints = [0];
  let lines = 0;
  let lineStart = 0;
  let longest = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 10) continue;
    longest = Math.max(longest, i - lineStart);
    lines++;
    lineStart = i + 1;
    if (lines % CHECKPOINT_LINES === 0) checkpoints.push(lineStart);
  }
  longest = Math.max(longest, bytes.length - lineStart);
  return { size: bytes.length, lineCount: lines + 1, checkpoints, longestLine: longest };
}

export const pageOf = (line: number): number => Math.floor(line / CHECKPOINT_LINES);

/** Byte range [start, end) of the lines of `page`. */
export function pageRange(scan: TextScan, page: number): [number, number] {
  return [scan.checkpoints[page], scan.checkpoints[page + 1] ?? scan.size];
}

export function visibleLines(
  scrollTop: number,
  height: number,
  lineCount: number,
): [number, number] {
  const start = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN_LINES);
  const end = Math.min(lineCount, Math.ceil((scrollTop + height) / LINE_HEIGHT) + OVERSCAN_LINES);
  return [start, end];
}

export function displayLine(text: string): string {
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  if (line.length <= DISPLAY_LINE_LIMIT) return line;
  return `${line.slice(0, DISPLAY_LINE_LIMIT)} … (${line.length}자)`;
}

interface Options {
  url: string;
  scan: TextScan;
  fileName: string;
  search: (query: TextQuery, fromLine: number) => Promise<TextSearch>;
}

/** The read-only screen for files the editor must not load (spec 「크기별 단계」): lines come in
 * pages of CHECKPOINT_LINES through Range requests on the token URL, only the visible ones are
 * in the DOM, and search runs in the backend a page of matches at a time. */
export class LargeTextViewer {
  readonly el: HTMLElement;
  private readonly rows = h("div", { class: "large-text-rows" });
  private readonly scroller = h("div", { class: "large-text-scroller" }, this.rows);
  private readonly count = h("span", { class: "large-text-count" });
  private readonly input = h("input", { type: "search", placeholder: "파일 안 찾기" });
  private readonly caseBox = h("input", { type: "checkbox" });
  private readonly regexBox = h("input", { type: "checkbox" });
  private readonly pages = new Map<number, Promise<string[]>>();
  private current = -1;
  private matches: { line: number; column: number }[] = [];
  private matchIndex = -1;
  private searchDone = true;
  private destroyed = false;

  constructor(private readonly options: Options) {
    this.input.spellcheck = false;
    const next = h("button", { textContent: "다음" });
    const prev = h("button", { textContent: "이전" });
    next.addEventListener("click", () => void this.step(1));
    prev.addEventListener("click", () => void this.step(-1));
    this.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      void this.startSearch();
    });
    const search = h(
      "div",
      { class: "large-text-search" },
      this.input,
      h("label", {}, this.caseBox, "대소문자"),
      h("label", {}, this.regexBox, "정규식"),
      prev,
      next,
      this.count,
    );
    const info = h("span", {
      class: "large-text-info",
      textContent: `${options.scan.lineCount.toLocaleString("ko-KR")}줄`,
    });
    this.el = h(
      "div",
      { class: "large-text" },
      h("div", { class: "large-text-bar" }, search, info),
      this.scroller,
    );
    this.rows.style.height = `${options.scan.lineCount * LINE_HEIGHT}px`;
    this.scroller.addEventListener("scroll", () => void this.render(), { passive: true });
    new ResizeObserver(() => void this.render()).observe(this.scroller);
  }

  goToLine(line: number): void {
    this.current = line;
    this.scroller.scrollTop = Math.max(0, line * LINE_HEIGHT - this.scroller.clientHeight / 2);
    void this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.el.remove();
  }

  private page(index: number): Promise<string[]> {
    let pending = this.pages.get(index);
    if (!pending) {
      const [start, end] = pageRange(this.options.scan, index);
      pending = fetch(this.options.url, { headers: { Range: `bytes=${start}-${end - 1}` } })
        .then(async (response) => {
          if (!response.ok) throw new Error(`${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          // A server without Range support (the fake's data: URL) answers 200 with everything.
          const slice = response.status === 206 ? bytes : bytes.subarray(start, end);
          const text = new TextDecoder().decode(slice);
          const lines = text.split("\n");
          // The page ends at the next checkpoint, right after a newline — except the last page.
          if (end < this.options.scan.size || text.endsWith("\n")) lines.pop();
          return lines;
        })
        .catch((error: unknown) => {
          this.pages.delete(index);
          throw error;
        });
      this.pages.set(index, pending);
    }
    return pending;
  }

  private async render(): Promise<void> {
    const [from, to] = visibleLines(
      this.scroller.scrollTop,
      this.scroller.clientHeight,
      this.options.scan.lineCount,
    );
    const needed = new Set<number>();
    for (let line = from; line < to; line++) needed.add(pageOf(line));
    const pages = new Map<number, string[]>();
    for (const index of needed) {
      try {
        pages.set(index, await this.page(index));
      } catch {
        pages.set(index, []);
      }
    }
    if (this.destroyed) return;
    const rows: HTMLElement[] = [];
    for (let line = from; line < to; line++) {
      const text = pages.get(pageOf(line))?.[line % CHECKPOINT_LINES] ?? "";
      const row = h("div", {
        class: `large-text-line${line === this.current ? " current" : ""}`,
        textContent: displayLine(text),
      });
      row.style.top = `${line * LINE_HEIGHT}px`;
      rows.push(row);
    }
    this.rows.replaceChildren(...rows);
  }

  private query(): TextQuery {
    return {
      query: this.input.value,
      caseSensitive: this.caseBox.checked,
      regex: this.regexBox.checked,
    };
  }

  private async startSearch(): Promise<void> {
    this.matches = [];
    this.matchIndex = -1;
    this.searchDone = false;
    await this.more(0);
    if (this.matches.length) this.show(0);
    else this.count.textContent = "0";
  }

  /** Fetches the next page of matches from `fromLine`; a page that fills up is continued later. */
  private async more(fromLine: number): Promise<void> {
    if (this.searchDone) return;
    try {
      const result = await this.options.search(this.query(), fromLine);
      if (this.destroyed) return;
      this.matches.push(...result.matches);
      this.searchDone = result.done || result.cancelled;
    } catch (error) {
      this.searchDone = true;
      this.count.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  private async step(delta: number): Promise<void> {
    if (!this.matches.length) return this.startSearch();
    let index = this.matchIndex + delta;
    if (index >= this.matches.length && !this.searchDone) {
      await this.more(this.matches[this.matches.length - 1].line + 1);
    }
    index = (index + this.matches.length) % this.matches.length;
    this.show(index);
  }

  private show(index: number): void {
    this.matchIndex = index;
    this.count.textContent = `${index + 1} / ${this.matches.length}${this.searchDone ? "" : "+"}`;
    this.goToLine(this.matches[index].line);
  }
}
```

`src/styles.css`:

```css
.large-text {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
}

.large-text-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar-bg);
  font-size: 12px;
}

.large-text-search {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
}

.large-text-search input[type="search"] {
  flex: 1;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: inherit;
  font: inherit;
}

.large-text-scroller {
  position: relative;
  overflow: auto;
  font-family: var(--editor-font);
  font-size: var(--editor-size);
}

.large-text-rows {
  position: relative;
}

.large-text-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 20px;
  padding: 0 16px;
  white-space: pre;
  line-height: 20px;
}

.large-text-line.current {
  background: var(--active-bg);
}
```

- [ ] **Step 6: 문서와 컨트롤러**

`src/app/docs.ts`:

```ts
/** A line longer than this sends the file to the large text viewer (spec 「크기별 단계」). This
 * value is provisional; Task 14 of the extensions-and-screens plan measures the boundary. */
export const LONG_LINE_LIMIT = 1_000_000;

export type Problem = "binary" | "too-large" | "long-line" | "missing" | "unreadable";
```

`Doc.load()` 의 `decodeText` 뒤:

```ts
if (longestLine(decoded.text) > LONG_LINE_LIMIT) {
  this.problem = "long-line";
  return;
}
```

(`longestLine` 은 이미 import 돼 있다 — `setText` 의 `wrap` 판단에도 쓰므로, 한 번만 재서 두 곳에 넘긴다: `const longest = longestLine(decoded.text)` 를 두고 `setText(decoded.text, undefined, longest)` 로 넘기는 선택 인자를 더한다.)

`src/app/controller.ts`:

```ts
import { LargeTextViewer } from "../viewer/large-text";
```

`PROBLEM_TEXT` 에 `"long-line": "한 줄이 너무 길어 편집기로 열 수 없습니다"` 를, `"too-large"` 의 문구를 `"100MB 가 넘어 편집기로 열 수 없습니다"` 로. 필드 `largeText: { doc: Doc; viewer: LargeTextViewer; owner: string } | null = null;`(public — UI 테스트가 `goToLine` 을 부른다). `show(doc)` 의 뷰어 분기 앞에:

```ts
if (doc.problem === "too-large" || doc.problem === "long-line") {
  void this.openLargeText(doc);
  return;
}
```

메서드:

```ts
  /** The read-only large text viewer (spec 「크기별 단계」). Its token lives as long as the view. */
  private async openLargeText(doc: Doc): Promise<void> {
    this.closeLargeText();
    const owner = `${doc.tabId}:large-text`;
    try {
      const [url, scan] = await Promise.all([this.backend.issueFileToken(doc.source, owner), this.backend.scanText(doc.source)]);
      if (this.tabs.active !== doc) {
        await this.backend.revokeFileTokens(owner);
        return;
      }
      let requestId = 0;
      const viewer = new LargeTextViewer({
        url,
        scan,
        fileName: doc.fileName,
        search: (query, fromLine) => this.backend.searchText(doc.source, query, fromLine, ++requestId),
      });
      this.largeText = { doc, viewer, owner };
      this.surface.showPanel(viewer.el);
      this.statusBar.setMessage("읽기 전용 · 대용량 텍스트 뷰어");
    } catch (error) {
      this.report(error);
      this.showProblem(doc);
    }
  }

  private closeLargeText(): void {
    const open = this.largeText;
    if (!open) return;
    this.largeText = null;
    open.viewer.destroy();
    void this.backend.revokeFileTokens(open.owner).catch((error: unknown) => console.warn(error));
  }
```

`show()` 의 첫 줄 `this.closeViewer()` 옆에 `this.closeLargeText()`, `showEmpty()` 와 `closeTab()`(`if (this.largeText?.doc === doc) this.closeLargeText();`)도 같이. `showProblem` 의 「텍스트로 열기」는 `too-large`·`long-line` 에서는 두지 않는다(`fallback` 조건에 `doc.problem === "binary"` 를 더한다).

- [ ] **Step 7: 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`, `pnpm test`, `pnpm test:e2e`
Expected: Rust +5, Vitest +5(scan·paging·display 3 + docs 1 + 표 1), E2E `large-text.spec.ts` 3개 PASS(개수). 실제 앱 확인(에이전트, 백그라운드): 110MB 로그 파일을 만들어 외부 탭으로 연다 —

```bash
TOTE_DATA_DIR=$(mktemp -d /tmp/tote-large-XXXX)
seq 1 6000000 | sed 's/$/ lorem ipsum dolor sit amet/' > "$TOTE_DATA_DIR/big.log"   # ≈ 190MB
ls -la "$TOTE_DATA_DIR/big.log"
pnpm tauri build --debug --bundles app --config src-tauri/tauri.dev.conf.json
open --env TOTE_BACKGROUND=1 --env TOTE_DATA_DIR="$TOTE_DATA_DIR" src-tauri/target/debug/bundle/macos/tote-dev.app
sleep 5
"$(pwd)/src-tauri/target/debug/bundle/macos/tote-dev.app/Contents/Resources/bin/tote" "$TOTE_DATA_DIR/big.log"
```

창에 대용량 텍스트 뷰어가 뜨고 `.tote` 폴더 밖의 `big.log` 가 그대로인지(수정 시각 불변), 종료 뒤 메모리가 수백 MB 를 넘지 않았는지를 Activity Monitor 대신 `ps -o rss= -p $(pgrep -f tote-dev.app | head -1)` 로 본다(목표치는 3번 계획이 정한다 — 여기서는 숫자만 보고에 적는다). `osascript -e 'quit app "tote-dev"'`; `rm -rf "$TOTE_DATA_DIR"`.

- [ ] **Step 8: 커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
pnpm exec oxfmt src tests/e2e
pnpm exec oxlint --fix src tests/e2e
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/files src-tauri/src/app src-tauri/src/lib.rs src/backend src/viewer/large-text.ts src/viewer/large-text.test.ts src/app/docs.ts src/app/docs.test.ts src/app/controller.ts src/styles.css tests/e2e/large-text.spec.ts
git commit -m "feat(viewer): read-only large text viewer with paged Range reads and backend search"
```

---

### Task 14: 긴 줄 경계 실측 — 사전 등록한 규칙으로 재고 `LONG_LINE_LIMIT` 를 정한다

**Files:**

- Create: `playwright.measure.config.ts`, `tests/measure/long-line.spec.ts`, `docs/superpowers/reports/<실행 날짜 YYYY-MM-DD>-long-line-boundary.md`
- Modify: `package.json`, `tests/e2e/pages/editor.ts`, `src/app/docs.ts`(`LONG_LINE_LIMIT` 값과 주석)

**Interfaces:**

- Consumes: `tests/e2e/pages/editor.html`(Task 6·8 의 편집기 단독 페이지 — 하이라이트 없이 잰다. 긴 줄은 20,000자 가드로 어차피 색이 없고, 스파이크도 색 없이 쟀다).
- Produces (스크립트): `pnpm measure:long-line` — `TOTE_E2E_PORT` 를 쓰는 Vite 서버 위에서 WebKit(headless)으로 잰다. 결과는 `tests/measure/results/long-line.json`(gitignore)과 stdout 의 표.
- Produces: `LONG_LINE_LIMIT` 확정값과 보고서.

**사전 등록 규칙(데이터를 보기 전에 고정한다 — 스파이크 보고서 「측정 과정에서 달라진 것」 의 방식).**

- **사다리:** 20,000 · 50,000 · 100,000 · 200,000 · 500,000 · 1,000,000 · 2,000,000 · 5,000,000 자(한 줄). 기준선은 253줄 짜리 코드(`code-small` 과 같은 크기, 각 줄 `const v<i> = f(<i>) + "text";`).
- **지표:** 키 입력 지연 = keydown 부터 다음 `requestAnimationFrame` 까지(ms). 조합마다 영문 60타를 치고, 문서가 바뀐 키만 센다. p95 를 쓴다. T = 같은 실행에서 잰 rAF 간격 중앙값(120 프레임).
- **판정:** 조합의 p95 − 기준선 p95 ≤ T 면 「된다」. **경계 = 두 실행 모두에서 「된다」인 가장 큰 사다리 값.** 사다리 값 사이는 보간하지 않는다(다음 값이 안 되면 그 아래 값이 경계다).
- **유효성:** 기준선 p95 가 T 의 3배를 넘거나 T 가 8–20ms 밖이면 그 실행은 무효(가려진 창·스로틀·이상한 주사율). 무효가 둘 연속이면 headed 로 한 번 더 돌린다(`TOTE_MEASURE_HEADED=1` — 창이 뜬다. 사람에게 먼저 알린다). 그래도 무효면 **실측 불가**로 적고 잠정값 1,000,000 을 유지한다.
- **적용:** 경계가 나오면 `LONG_LINE_LIMIT` 를 그 값으로 바꾼다. 20,000 조차 안 되면(기준선과 구별되지 않는 값이 없으면) 20,000 으로 둔다 — 하이라이트 가드와 같은 값이라 편집기가 긴 줄을 한 번도 보지 않게 된다.

- [ ] **Step 1: 측정 페이지와 설정**

`tests/e2e/pages/editor.ts` 의 `doc` 계산을 바꾼다 — URL 에 5MB 를 실을 수 없으므로 길이만 받는다:

```ts
const longLine = Number(params.get("longline") ?? 0);
const lines = Number(params.get("lines") ?? 0);
const doc = longLine
  ? "x".repeat(longLine)
  : lines
    ? Array.from({ length: lines }, (_, i) => `const v${i} = f(${i}) + "text";`).join("\n")
    : (params.get("doc") ?? "");
```

`playwright.measure.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.TOTE_E2E_PORT ?? 1430);

/** The long-line measurement (Task 14 of the extensions-and-screens plan): one worker, no
 * retries, a long timeout — the point is the numbers, not a pass. */
export default defineConfig({
  testDir: "tests/measure",
  timeout: 20 * 60 * 1000,
  retries: 0,
  workers: 1,
  reporter: "list",
  projects: [
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], headless: !process.env.TOTE_MEASURE_HEADED },
    },
  ],
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
```

`package.json` 의 `scripts` 에 `"measure:long-line": "playwright test --config playwright.measure.config.ts"` 를 더하고, `.gitignore` 에 `tests/measure/results/` 를 더한다.

- [ ] **Step 2: 측정 스크립트**

`tests/measure/long-line.spec.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));

// The pre-registered rule of Task 14: the ladder, the metric, the pass line and the validity
// bounds. Nothing here changes after a run is looked at.
const LADDER = [20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
const BASELINE_LINES = 253;
const KEYS = 60;
const FRAME_SAMPLES = 120;
const RUNS = 2;
const VALID_FRAME_MS: [number, number] = [8, 20];

interface Sample {
  label: string;
  keys: number;
  p50: number;
  p95: number;
  frameMs: number;
}

const p = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

async function frameInterval(page: Page): Promise<number> {
  const gaps = await page.evaluate(
    (n) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        let last = performance.now();
        const tick = (now: number) => {
          out.push(now - last);
          last = now;
          if (out.length >= n) resolve(out.slice(1));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    FRAME_SAMPLES,
  );
  return p(gaps, 0.5);
}

async function measure(page: Page, label: string, query: string): Promise<Sample> {
  await page.goto(`/tests/e2e/pages/editor.html?file=code.ts&${query}`);
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.evaluate(() => {
    const samples: number[] = [];
    const view = window.view;
    window.addEventListener(
      "keydown",
      () => {
        const t0 = performance.now();
        const before = view.state.doc;
        requestAnimationFrame(() => {
          if (view.state.doc !== before) samples.push(performance.now() - t0);
        });
      },
      true,
    );
    Object.assign(window, { __samples: samples });
  });
  const frameMs = await frameInterval(page);
  await page.keyboard.press("End");
  for (let i = 0; i < KEYS; i++) {
    await page.keyboard.type("abcdefghij"[i % 10]);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(200);
  const samples = await page.evaluate(
    () => (window as unknown as { __samples: number[] }).__samples,
  );
  return { label, keys: samples.length, p50: p(samples, 0.5), p95: p(samples, 0.95), frameMs };
}

test("long-line boundary", async ({ page }) => {
  const runs: Sample[][] = [];
  for (let run = 0; run < RUNS; run++) {
    const samples: Sample[] = [await measure(page, "baseline", `lines=${BASELINE_LINES}`)];
    for (const length of LADDER)
      samples.push(await measure(page, String(length), `longline=${length}`));
    runs.push(samples);
  }
  const verdicts = runs.map((samples) => {
    const baseline = samples[0];
    const T = baseline.frameMs;
    const valid = T >= VALID_FRAME_MS[0] && T <= VALID_FRAME_MS[1] && baseline.p95 <= 3 * T;
    const passes = samples.slice(1).map((s) => ({
      length: Number(s.label),
      delta: s.p95 - baseline.p95,
      ok: s.p95 - baseline.p95 <= T,
    }));
    return { valid, T, baseline, passes };
  });
  let boundary: number | null = null;
  if (verdicts.every((v) => v.valid)) {
    for (const length of LADDER) {
      if (verdicts.every((v) => v.passes.find((x) => x.length === length)?.ok)) boundary = length;
      else break;
    }
  }
  const lines = [
    "| run | label | keys | p50 | p95 | p95 − baseline | frame | verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  runs.forEach((samples, run) => {
    const v = verdicts[run];
    for (const s of samples) {
      const pass = v.passes.find((x) => x.length === Number(s.label));
      lines.push(
        `| ${run + 1}${v.valid ? "" : " (invalid)"} | ${s.label} | ${s.keys} | ${s.p50.toFixed(1)} | ${s.p95.toFixed(1)} | ${pass ? pass.delta.toFixed(1) : "—"} | ${s.frameMs.toFixed(1)} | ${pass ? (pass.ok ? "된다" : "안 된다") : "기준선"} |`,
      );
    }
  });
  const summary =
    boundary === null
      ? "실측 불가 — 잠정값 1,000,000 유지"
      : `경계 ${boundary.toLocaleString("ko-KR")}자`;
  const table = lines.join("\n");
  console.log(`\n${table}\n\n${summary}\n`);
  mkdirSync(join(HERE, "results"), { recursive: true });
  writeFileSync(
    join(HERE, "results/long-line.json"),
    JSON.stringify({ runs, verdicts, boundary, table }, null, 2),
  );
});
```

- [ ] **Step 3: 재고 적용한다**

```bash
pnpm measure:long-line
cat tests/measure/results/long-line.json | head -40
```

규칙대로 판정한다. 무효 실행이면 규칙의 headed 재실행 조항을 따른다(사람에게 알린 뒤 `TOTE_MEASURE_HEADED=1 pnpm measure:long-line`). 결과에 따라 `src/app/docs.ts` 의 `LONG_LINE_LIMIT` 를 바꾸고 주석을 「실측값」으로 고친다 — 값 옆에 **무엇을 어떤 명령으로 쟀는지**를 적고 날짜는 적지 않는다(`docs/guideline/base/03-comments.md`):

```ts
/** A line longer than this sends the file to the large text viewer (spec 「크기별 단계」).
 * Measured with `pnpm measure:long-line` (keydown → next frame, p95 against a 253-line
 * baseline, headless WebKit): the largest ladder step within one frame of the baseline in two
 * runs. Re-measure after changing the editor's extensions. */
export const LONG_LINE_LIMIT = <경계값>;
```

실측 불가면 값은 그대로 두고 주석에 「잠정값 — `pnpm measure:long-line` 이 무효 실행만 냈다(보고서 참조)」 라고 적는다. `tests/e2e/large-text.spec.ts` 는 `LONG_LINE_LIMIT` 를 import 하므로 값이 바뀌어도 그대로 돈다(5,000,000 이면 픽스처가 5MB 가 되어 sessionStorage 상한을 넘을 수 있다 — 그때는 그 테스트의 긴 줄 길이를 `Math.min(LONG_LINE_LIMIT + 1, 2_000_001)` 로 두지 말고, 가짜 백엔드의 `files` 를 `addInitScript` 가 아니라 `page.evaluate` 로 심는 쪽으로 바꾼다. 어느 쪽이든 테스트가 통과하는 상태로 커밋한다).

- [ ] **Step 4: 보고서**

`docs/superpowers/reports/<실행 날짜>-long-line-boundary.md` — 이 문서는 그 시점의 기록이다(연대기 예외). 환경(macOS 버전, 기기, headless/headed, 디스플레이), 규칙(위 사전 등록 규칙을 그대로), 두 실행의 표(스크립트가 찍은 것), 판정, 무효·재실행이 있었으면 그 경위, 그리고 「검증하지 않은 것」(headless WebKit 과 WKWebView 의 차이, 영문만 쳤다는 것, 하이라이트 Worker 없이 쟀다는 것)을 적는다.

- [ ] **Step 5: 확인과 커밋**

Run: `pnpm test:e2e -- tests/e2e/large-text.spec.ts tests/e2e/editor.spec.ts` 와 `pnpm test -- src/app/docs`
Expected: PASS(개수).

```bash
pnpm exec oxfmt tests/measure playwright.measure.config.ts tests/e2e/pages/editor.ts src/app/docs.ts docs/superpowers/reports/<실행 날짜>-long-line-boundary.md
git add package.json .gitignore playwright.measure.config.ts tests/measure/long-line.spec.ts tests/e2e/pages/editor.ts src/app/docs.ts docs/superpowers/reports/<실행 날짜>-long-line-boundary.md
git commit -m "test(editor): measure the long-line boundary and set LONG_LINE_LIMIT from it"
```

---

### Task 15: 설정 화면 — 워크스페이스 루트, 라이트·다크 테마, 확장 목록(설치·활성·제거·우선순위)

**Files:**

- Modify: `src-tauri/src/app/menu.rs`, `src/app/controller.ts`, `src/styles.css`, `tests/e2e/globals.d.ts`
- Create: `src/ui/settings.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**

- Consumes: `Backend.settings`·`updateSettings`·`extensionRegistry`·`installExtension`·`removeExtension`·`setExtensionEnabled`·`pickExtensionPackage`·`pickFolder`·`onConfigChanged`, `Registry.themes`, `describeError`, `modal`(dialogs.ts — export 한다).
- Produces: 메뉴 `settings`(tote › 설정…, `CmdOrCtrl+,`); `openSettings(options: { backend: Backend; registry: () => Registry; onConfigChanged: (handler: () => void) => () => void }): Promise<void>`(`src/ui/settings.ts`); `AppController.onMenu("settings")`.
- `src/ui/dialogs.ts` exports `modal` and adds `confirm(message: string, okLabel: string): Promise<boolean>`.

- [ ] **Step 1: 실패하는 테스트**

`tests/e2e/settings.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { menu, start } from "./helpers";

const PKG = { name: "night", publisher: "someone", version: "1.0.0", displayName: "Night Theme" };

test("the settings screen shows the root, the themes and the extensions, and saves changes", async ({
  page,
}) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await expect(panel.locator("h2")).toHaveText(["워크스페이스", "테마", "확장"]);
  await expect(panel.locator("input[name=workspaceRoot]")).toHaveValue("");
  await panel.locator("input[name=workspaceRoot]").fill("~/노트");
  await panel.locator("button", { hasText: "루트 저장" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.workspaceRoot))
    .toBe("~/노트");
  await expect(panel.locator(".settings-note")).toContainText("새로 여는 창부터");
  await panel.locator("select[name=dark]").selectOption({ label: "Light+ (tote.themes)" });
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.theme.dark))
    .toEqual({ extension: "tote.themes", label: "Light+" });
  await expect(panel.locator(".extension-row")).toHaveText([
    /tote 기본 언어 묶음/,
    /tote 마크다운 미리보기/,
    /tote 미디어 뷰어/,
    /tote 기본 테마/,
  ]);
  await expect(panel.locator(".extension-row input[type=checkbox]")).toHaveCount(0); // bundled: no switch
});

test("installing, replacing, disabling and removing a user extension", async ({ page }) => {
  await start(page, {
    packages: { "/pkg/night.vsix": PKG, "/pkg/night2.vsix": { ...PKG, version: "2.0.0" } },
    picks: ["/pkg/night.vsix", "/pkg/night2.vsix"],
  });
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  const row = panel.locator(".extension-row", { hasText: "Night Theme" });
  await expect(row).toContainText("someone.night@1.0.0");
  await panel.locator("button", { hasText: "파일에서 설치…" }).click();
  await expect(page.locator(".modal.confirm")).toContainText(
    "someone.night 1.0.0 이(가) 이미 설치돼 있습니다",
  );
  await page.locator(".modal.confirm button", { hasText: "교체" }).click();
  await expect(row).toContainText("someone.night@2.0.0");
  await row.locator("input[type=checkbox]").uncheck();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.extensions.disabled))
    .toEqual(["someone.night"]);
  await row.locator("input[type=checkbox]").check();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.extensions.disabled))
    .toEqual([]);
  await row.locator("button", { hasText: "제거" }).click();
  await page.locator(".modal.confirm button", { hasText: "제거" }).click();
  await expect(panel.locator(".extension-row", { hasText: "Night Theme" })).toHaveCount(0);
});

test("precedence is a radio and problems are listed", async ({ page }) => {
  await start(page);
  await menu(page, "settings");
  const panel = page.locator(".modal.settings");
  await panel.locator("input[name=precedence][value=bundled]").check();
  await expect
    .poll(() => page.evaluate(() => window.__tote.backend.data.settings.extensions.precedence))
    .toBe("bundled");
  await expect(panel.locator(".extension-problems")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test:e2e -- tests/e2e/settings.spec.ts`
Expected: FAIL — `settings` 메뉴가 아무것도 열지 않는다.

- [ ] **Step 3: 메뉴**

`src-tauri/src/app/menu.rs` 의 `tote` 서브메뉴, `install-cli` 앞에:

```rust
        .item(&item(app, "settings", "설정…", Some("CmdOrCtrl+,"))?)
        .separator()
```

(`settings` 는 `on_event` 의 기본 분기로 최신 창의 프론트엔드에 간다.)

- [ ] **Step 4: 대화상자 조각**

`src/ui/dialogs.ts` 의 `modal` 을 `export` 하고 더한다:

```ts
/** A yes/no question; Escape and 「취소」 answer false. */
export async function confirm(message: string, okLabel: string): Promise<boolean> {
  const answer = await modal<boolean>((close) =>
    h(
      "div",
      { class: "modal confirm", role: "dialog" },
      h("p", { textContent: message }),
      h(
        "div",
        { class: "modal-buttons" },
        button("취소", () => close(false)),
        button(okLabel, () => close(true), "primary"),
      ),
    ),
  );
  return answer ?? false;
}
```

- [ ] **Step 5: 설정 화면**

`src/ui/settings.ts`:

```ts
import type { Backend, ExtensionRegistry, Settings, ThemeRef } from "../backend/types";
import { describeError } from "../app/errors";
import { errorCode } from "../backend/types";
import type { Registry } from "../extensions/registry";
import { confirm, modal } from "./dialogs";
import { h } from "./dom";

export interface SettingsOptions {
  backend: Backend;
  registry: () => Registry;
  /** Subscribes to config changes; returns the unsubscribe. */
  onConfigChanged: (handler: () => void) => () => void;
}

const themeValue = (ref: ThemeRef | null) =>
  ref ? JSON.stringify([ref.extension, ref.label]) : "";
const themeRef = (value: string): ThemeRef | null => {
  if (!value) return null;
  const [extension, label] = JSON.parse(value) as [string, string];
  return { extension, label };
};

/** The minimal settings screen (spec 「프론트엔드」): workspace root, light and dark theme, the
 * extension list with install, enable and remove. Every change is saved as it is made. */
export function openSettings(options: SettingsOptions): Promise<void> {
  return modal<true>((close) => {
    const { backend } = options;
    const panel = h("div", { class: "modal settings", role: "dialog" });
    const status = h("p", { class: "modal-error" });
    let settings: Settings | null = null;

    const fail = (error: unknown) => {
      status.textContent = describeError(error);
    };
    const save = async (patch: (s: Settings) => void) => {
      if (!settings) return;
      const next = structuredClone(settings);
      patch(next);
      try {
        await backend.updateSettings(next);
        settings = next;
        status.textContent = "";
      } catch (error) {
        fail(error);
      }
    };

    const rootInput = h("input", { name: "workspaceRoot", placeholder: "~/Tote" });
    const rootSection = () => {
      const pick = h("button", { textContent: "폴더 선택…" });
      pick.addEventListener("click", async () => {
        const folder = await backend.pickFolder();
        if (folder) rootInput.value = folder;
      });
      const saveRoot = h("button", { textContent: "루트 저장", class: "primary" });
      saveRoot.addEventListener(
        "click",
        () => void save((s) => (s.workspaceRoot = rootInput.value.trim() || null)),
      );
      return h(
        "section",
        {},
        h("h2", { textContent: "워크스페이스" }),
        h("div", { class: "settings-row" }, rootInput, pick, saveRoot),
        h("p", {
          class: "settings-note",
          textContent: "루트는 새로 여는 창부터 적용됩니다. 열린 창은 그대로입니다.",
        }),
      );
    };

    const themeSelect = (name: "light" | "dark") => {
      const select = h("select", { name });
      select.append(h("option", { value: "", textContent: "기본" }));
      for (const theme of options.registry().themes) {
        select.append(
          h("option", {
            value: themeValue(theme),
            textContent: `${theme.label} (${theme.extension})`,
          }),
        );
      }
      select.addEventListener(
        "change",
        () => void save((s) => (s.theme[name] = themeRef(select.value))),
      );
      return select;
    };
    const lightSelect = themeSelect("light");
    const darkSelect = themeSelect("dark");
    const themeSection = h(
      "section",
      {},
      h("h2", { textContent: "테마" }),
      h(
        "div",
        { class: "settings-row" },
        h("label", {}, "라이트 ", lightSelect),
        h("label", {}, "다크 ", darkSelect),
      ),
    );

    const list = h("div", { class: "extension-list" });
    const problems = h("ul", { class: "extension-problems" });
    const precedence = (value: "user" | "bundled", label: string) => {
      const radio = h("input", { type: "radio", name: "precedence", value });
      radio.addEventListener("change", () => void save((s) => (s.extensions.precedence = value)));
      return h("label", {}, radio, label);
    };
    const installFile = h("button", { textContent: "파일에서 설치…" });
    const installFolder = h("button", { textContent: "폴더에서 설치…" });
    const install = async (path: string | null) => {
      if (!path) return;
      try {
        await backend.installExtension(path, false);
      } catch (error) {
        if (errorCode(error) !== "already-installed") return fail(error);
        const message = error instanceof Error ? error.message : String(error);
        const [id, version] = message.split(" ");
        if (!(await confirm(`${id} ${version} 이(가) 이미 설치돼 있습니다. 교체할까요?`, "교체")))
          return;
        try {
          await backend.installExtension(path, true);
        } catch (again) {
          fail(again);
        }
      }
    };
    installFile.addEventListener("click", async () =>
      install(await backend.pickExtensionPackage()),
    );
    installFolder.addEventListener("click", async () => install(await backend.pickFolder()));
    const extensionSection = h(
      "section",
      {},
      h("h2", { textContent: "확장" }),
      h(
        "div",
        { class: "settings-row" },
        installFile,
        installFolder,
        h("span", {
          class: "settings-note",
          textContent: "사용자 설치 확장의 뷰어는 아직 실리지 않습니다.",
        }),
      ),
      list,
      problems,
      h(
        "div",
        { class: "settings-row" },
        "같은 확장자를 두 확장이 주장하면: ",
        precedence("user", "사용자 설치 우선"),
        precedence("bundled", "번들 우선"),
      ),
    );

    const renderExtensions = (registry: ExtensionRegistry) => {
      list.replaceChildren(
        ...registry.extensions.map((ext) => {
          const row = h("div", { class: `extension-row ${ext.source}` });
          row.append(
            h("span", { class: "extension-name", textContent: ext.displayName }),
            h("span", { class: "extension-id", textContent: `${ext.id}@${ext.version}` }),
            h("span", {
              class: "extension-source",
              textContent: ext.source === "bundled" ? "번들" : "사용자",
            }),
          );
          if (ext.source === "user") {
            const enabled = h("input", { type: "checkbox", checked: ext.enabled, title: "활성" });
            enabled.addEventListener(
              "change",
              () => void backend.setExtensionEnabled(ext.id, enabled.checked).catch(fail),
            );
            const remove = h("button", { textContent: "제거" });
            remove.addEventListener("click", async () => {
              if (await confirm(`${ext.displayName} 을(를) 제거할까요?`, "제거"))
                await backend.removeExtension(ext.id).catch(fail);
            });
            row.append(enabled, remove);
          }
          return row;
        }),
      );
      problems.replaceChildren(
        ...registry.problems.map((p) => h("li", { textContent: `${p.path}: ${p.message}` })),
      );
      problems.hidden = registry.problems.length === 0;
    };

    const refresh = async () => {
      try {
        const [current, registry] = await Promise.all([
          backend.settings(),
          backend.extensionRegistry(),
        ]);
        settings = current;
        rootInput.value = current.workspaceRoot ?? "";
        lightSelect.value = themeValue(current.theme.light);
        darkSelect.value = themeValue(current.theme.dark);
        panel.querySelector<HTMLInputElement>(
          `input[name=precedence][value=${current.extensions.precedence}]`,
        )!.checked = true;
        renderExtensions(registry);
      } catch (error) {
        fail(error);
      }
    };
    const unsubscribe = options.onConfigChanged(() => void refresh());
    const done = h("button", { textContent: "닫기", class: "primary" });
    done.addEventListener("click", () => {
      unsubscribe();
      close(true);
    });
    panel.append(
      h("h1", { textContent: "설정" }),
      rootSection(),
      themeSection,
      extensionSection,
      status,
      h("div", { class: "modal-buttons" }, done),
    );
    void refresh();
    return panel;
  }).then(() => undefined);
}
```

`onConfigChanged` 의 구독 해제: `Backend.onConfigChanged` 는 해제를 돌려주지 않으므로 컨트롤러가 핸들러 집합을 갖고 포워딩한다(아래). Escape 로 닫히면 `unsubscribe` 가 불리지 않지만 `refresh` 는 떼어진 패널에 그릴 뿐이다 — 그래도 새지 않게 컨트롤러 쪽 집합에서 `openSettings` 가 끝난 뒤 지운다.

`src/app/controller.ts`:

```ts
import { openSettings } from "../ui/settings";

  private readonly configListeners = new Set<() => void>();
```

`onConfigChanged()` 의 끝에 `for (const listener of this.configListeners) listener();` 를 더하고, `onMenu` 에:

```ts
        case "settings":
          return await this.showSettings();
```

```ts
  private async showSettings(): Promise<void> {
    const subscribers = new Set<() => void>();
    await openSettings({
      backend: this.backend,
      registry: () => this.registry,
      onConfigChanged: (handler) => {
        subscribers.add(handler);
        this.configListeners.add(handler);
        return () => {
          subscribers.delete(handler);
          this.configListeners.delete(handler);
        };
      },
    });
    for (const handler of subscribers) this.configListeners.delete(handler);
    if (this.tabs.active) this.view.focus();
  }
```

`src/styles.css`:

```css
.modal.settings {
  width: min(720px, 90vw);
  max-width: none;
  max-height: 85vh;
  overflow: auto;
}

.modal.settings h1 {
  margin: 0 0 12px;
  font-size: 16px;
}

.modal.settings h2 {
  margin: 16px 0 8px;
  font-size: 13px;
  color: var(--muted);
}

.settings-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.settings-row input[name="workspaceRoot"] {
  flex: 1;
  width: auto;
}

.settings-note {
  margin: 4px 0;
  color: var(--muted);
  font-size: 12px;
}

.extension-list {
  margin: 8px 0;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.extension-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}

.extension-row:last-child {
  border-bottom: 0;
}

.extension-name {
  flex: 1;
}

.extension-id,
.extension-source {
  color: var(--muted);
  font-size: 12px;
}

.extension-problems {
  margin: 4px 0;
  padding-left: 18px;
  color: var(--danger);
  font-size: 12px;
}

select {
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: inherit;
  font: inherit;
}
```

- [ ] **Step 6: 통과 확인**

Run: `pnpm test:e2e` 와 `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: `settings.spec.ts` 3개 PASS, 나머지 그대로(개수). `pnpm typecheck` 깨끗.

- [ ] **Step 7: 커밋**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
pnpm exec oxfmt src tests/e2e
pnpm exec oxlint --fix src tests/e2e
git add src-tauri/src/app/menu.rs src/ui/settings.ts src/ui/dialogs.ts src/app/controller.ts src/styles.css tests/e2e/globals.d.ts tests/e2e/settings.spec.ts
git commit -m "feat(ui): settings screen for the workspace root, themes and extensions"
```

---

### Task 16: 사람이 하는 스모크

OS 모양 전환, 실제 입력기, 실제 .vsix, 영상 재생, 메뉴 단축키처럼 자동화가 닿지 않는 것을 사람이 확인한다. 코디네이터가 앱을 빌드해 띄우고, **한 단계씩** 안내하고, 결과를 받아 적는다(한 번에 목록 전체를 넘기지 않는다). **에이전트는 이 태스크에서 앱을 띄우지 않는다** — 사람의 화면에서 사람이 띄운다.

**Files:**

- Create: `docs/superpowers/reports/<실행 날짜 YYYY-MM-DD>-tote-note-extensions-smoke.md`

- [ ] **Step 1: 빌드와 격리된 실행(사람이 터미널에서)**

```bash
pnpm sync:bundled
pnpm tauri build --debug --bundles app --config src-tauri/tauri.dev.conf.json
APP="$PWD/src-tauri/target/debug/bundle/macos/tote-dev.app"
export TOTE_DATA_DIR=/tmp/tote-smoke
rm -rf "$TOTE_DATA_DIR"
open --env TOTE_DATA_DIR="$TOTE_DATA_DIR" "$APP"
```

표의 「다시 연다」는 언제나 위의 `open --env …` 줄이다. Dock·Finder 로 띄우면 `TOTE_DATA_DIR` 이 빠져 `~/Tote-dev` 에 쓴다(첫 계획의 스모크에서 실제로 그렇게 됐다).

사전 준비(사람):

```bash
mkdir -p ~/tote-smoke-files && cd ~/tote-smoke-files
ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=20:size=640x360:rate=30 -c:v libx264 -pix_fmt yuv420p -movflags +faststart clip.mp4
ffmpeg -y -loglevel error -f lavfi -i sine=frequency=440:duration=5 -c:a aac voice.m4a
ffmpeg -y -loglevel error -f lavfi -i testsrc=size=320x240 -frames:v 1 pic.png
printf 'not a real image' > broken.png
seq 1 6000000 | sed 's/$/ lorem ipsum dolor sit amet/' > big.log     # ≈ 190MB
python3 -c "print('x' * 3_000_000)" > oneline.txt
```

마켓플레이스에서 테마 .vsix 하나를 내려받는다(예: `https://marketplace.visualstudio.com/items?itemName=dracula-theme.theme-dracula` 의 「Download Extension」) → `~/tote-smoke-files/theme.vsix`.

- [ ] **Step 2: 항목별 확인**

| 항목               | 할 일                                                                                                                                                       | 기대                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 첫 실행과 테마     | 앱을 본다. 시스템 설정 › 화면 모드를 다크 ↔ 라이트로 바꾼다                                                                                                 | 창이 Light+/Dark+ 색으로 바뀐다(배경·사이드바·선택 색). 설정 ⌘, 의 테마 선택에 `Light+ (tote.themes)`·`Dark+ (tote.themes)` 가 있다                                                                           |
| 하이라이트         | ⌘N 으로 메모를 만들고 ` ```ts ` 블록 안에 `const a = "x"; // c` 를 친다. 그 메모의 언어를 상태 표시줄에서 TypeScript 로 바꾼다                              | 마크다운 안의 코드 펜스에도, TypeScript 로 바꾼 뒤에도 키워드·문자열·주석이 다른 색이다. 바꾼 뒤 탭 이름이 `.ts` 로 끝난다                                                                                    |
| ⌘/ 와 괄호         | TypeScript 탭에서 한 줄을 고르고 ⌘/, 다시 ⌘/. `(` 를 친다                                                                                                   | `// ` 가 붙었다 떨어진다. `()` 가 된다                                                                                                                                                                        |
| 자동 인식          | ⌘N → 첫 줄 `#!/bin/zsh` → Enter                                                                                                                             | 탭 이름이 `! bin zsh.sh`(제목 규칙은 `#` 만 걷고 `!` 는 남긴다), 상태 표시줄 `Shell Script`. 첫 줄을 `# 메모` 로 고쳐도 `.sh` 그대로                                                                          |
| 외부 파일 언어     | ⌘O 로 `~/tote-smoke-files/big.log` 가 아닌 아무 `.txt` 를 연다. 상태 표시줄 → SQL. ⌘Q → 다시 연다                                                           | 언어가 SQL 로 돌아온다. 파일은 그대로 `.txt`                                                                                                                                                                  |
| 마크다운 미리보기  | 메모에 `# 제목`, `![](pic.png)`, `![](https://example.com/x.png)` 를 쓰고 `pic.png` 를 워크스페이스로 가져온 뒤(⌘O 로 열고 「워크스페이스로 가져오기」) ⇧⌘V | 제목이 렌더링되고 `pic.png` 가 보이며 원격 이미지는 「원격 이미지」 자리표시다. ⇧⌘V 로 편집기 복귀. 미리보기 중 ⌘Q → 다시 연다 → 그 탭이 미리보기로 돌아온다                                                  |
| 이미지             | ⌘O 로 `pic.png` 를 연다. 클릭                                                                                                                               | 창 맞춤 ↔ 실제 크기가 번갈아 바뀌고 캡션에 `320×240`                                                                                                                                                          |
| 영상               | ⌘O 로 `clip.mp4` 를 연다. 재생, 탐색 막대로 15초 지점으로                                                                                                   | 기본 컨트롤로 재생·탐색된다. 탭을 떠났다 돌아와도 다시 열린다(위치는 처음부터 — 알려진 동작)                                                                                                                  |
| 오디오             | ⌘O 로 `voice.m4a`                                                                                                                                           | 기본 오디오 컨트롤, 재생된다                                                                                                                                                                                  |
| 깨진 파일          | ⌘O 로 `broken.png`                                                                                                                                          | 뷰어 안에 「지원하지 않는 포맷」                                                                                                                                                                              |
| PDF                | 아무 PDF 를 ⌘O                                                                                                                                              | 「열 수 없음」과 「텍스트로 열기」. 누르면 「텍스트로 열 수 없음」                                                                                                                                            |
| 100MB 초과         | ⌘O 로 `big.log`                                                                                                                                             | 대용량 텍스트 뷰어(읽기 전용, 상태 표시줄 「읽기 전용 · 대용량 텍스트 뷰어」), 「6,000,001줄」. 스크롤 끝까지 가면 마지막 줄이 보인다. 찾기에 `5999990` → `1 / 1` 로 그 줄로 간다. 정규식 `^1000+ ` → 여러 개 |
| 긴 줄              | ⌘O 로 `oneline.txt`                                                                                                                                         | 대용량 텍스트 뷰어로 열리고 첫 줄이 `… (3000000자)` 로 끝난다                                                                                                                                                 |
| 설정 — 루트        | ⌘, → 루트에 `~/tote-smoke-root` → 「루트 저장」 → ⇧⌘N 으로 `업무` 만들기                                                                                    | `~/tote-smoke-root/업무` 가 생긴다. `/tmp/tote-smoke/settings.json` 에 `workspaceRoot`                                                                                                                        |
| 설정 — .vsix 설치  | ⌘, → 「파일에서 설치…」 → `theme.vsix` → 다크 테마를 그 테마로 → 다시 「파일에서 설치…」 같은 파일                                                          | 목록에 확장이 생기고(사용자), 다크 모드의 색이 그 테마로 바뀐다. 두 번째 설치는 「이미 설치돼 있습니다 … 교체」 를 묻는다. `/tmp/tote-smoke/extensions/<id>@<버전>/` 이 있다                                  |
| 설정 — 비활성·제거 | 체크를 끄고, 다시 켜고, 「제거」                                                                                                                            | 끄면 테마 선택에서 사라지고 다크가 기본(Dark+)으로 돌아온다. 제거하면 폴더가 없어진다                                                                                                                         |
| 한글 ⌘Z            | 세 줄 끝에 ⌥클릭으로 커서 셋 → `가나` → ⌘Z 두 번                                                                                                            | 한 번에 한 음절씩 세 줄에서 같이 사라지고 커서 셋이 남는다                                                                                                                                                    |
| 한글 + 미리보기    | 마크다운 메모에 한글 제목을 조합 중인 채로 ⇧⌘V                                                                                                              | 조합이 확정되고 미리보기에 그 제목이 보인다(입력기가 포커스 이동을 확정으로 처리한다)                                                                                                                         |
| 강제 종료          | 미리보기 탭·뷰어 탭·대용량 탭을 연 채 `pkill -9 -f tote-dev.app` → 다시 연다                                                                                | 세 탭이 돌아오고 각자의 화면으로 열린다                                                                                                                                                                       |

- [ ] **Step 3: 정리**

```bash
osascript -e 'quit app "tote-dev"'
rm -rf /tmp/tote-smoke ~/tote-smoke-files ~/tote-smoke-root
```

`~/Tote-dev` 나 `~/Library/Application Support/tote-dev` 가 새로 생겼다면 `TOTE_DATA_DIR` 없이 뜬 적이 있다는 뜻이다. 사람에게 알리고 함께 지운다.

- [ ] **Step 4: 보고서와 커밋**

항목마다 결과(그대로 / 다름 — 무엇이 어떻게)와 사람이 남긴 말을 보고서에 적는다. 「다름」 은 고칠지·다음 계획으로 넘길지 판정과 함께 적는다. 실행 날짜를 파일 이름에 쓴다.

```bash
git add docs/superpowers/reports/<실행 날짜>-tote-note-extensions-smoke.md
git commit -m "docs: record the tote-note extensions and screens smoke check"
```
