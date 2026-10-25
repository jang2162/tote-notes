# tote-notes macOS 배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task — 구현은 이 워크트리에 붙은 Orca 워커가 직접 한다(서브에이전트·포크를 띄우지 않는다). 태스크 묶음마다의 리뷰는 코디네이터가 별도 리뷰어 워커로 띄운다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `v*` 태그 하나로 서명·공증된 유니버설 DMG 와 업데이트 파일이 GitHub 릴리스에 올라가고, 설치된 tote 가 실행 때 새 버전을 묻고, 승낙하면 받아서 **열린 메모를 저장한 뒤** 다시 시작한다.

**Architecture:** 릴리스는 keyring-notes 의 구성(태그 → Tauri CLI 빌드·서명·앱 공증 → 검사 → DMG 공증 → 드래프트 → 목록 확인 → 공개)을 tote 경로로 옮긴다. 앱 안 업데이트는 **Rust 가 전부 쥔다**: 확인·받기·설치는 `tauri-plugin-updater` 의 Rust API 로 하고, 찾은 업데이트는 `PendingOpen::Update` 로 **한 창에만** 넘긴다. 다시 시작은 새 저장 라운드 `FlushGoal::Restart` 로 한다 — 종료 라운드와 같은 창들이 쓰고, 끝에 `exit(0)` 대신 `AppHandle::request_restart()` 를 부른다. 화면은 그 창의 기존 `modal()` 대화상자와 설정 「일반」 구역의 스위치 하나다.

**Tech Stack:** Tauri 2.12(Rust), `tauri-plugin-updater` 2(로컬 레지스트리 2.14.0), TypeScript, vitest, Playwright(WebKit, 가짜 백엔드), GitHub Actions(macos-latest, `jdx/mise-action`), `gh`, `xcrun notarytool`/`stapler`, `actionlint`.

**Spec:** `docs/superpowers/specs/2026-10-25-tote-notes-mac-distribution-design.md`(정본). 저장 흐름은 `docs/superpowers/specs/2026-10-16-tote-notes-panes-and-windows-design.md`, 화면·메뉴 관례는 `docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md`. 본: `/Users/jang2162/IdeaProjects/keyring-notes` 의 `.github/workflows/release-macos.yml`, `docs/guides/release-macos.md`, `scripts/{version,updater-json,verify-updater-sig}.mjs`, `web/src/update.tsx`·`updateCheck.ts`(읽기만 한다).

## Global Constraints

- 설계 「정한 것 (사용자)」·「설계자 판단」 그대로: 식별자 `com.develma.totenotes`, 개발용 `com.develma.totenotes.dev`, 앱 이름 `tote`, 첫 릴리스 `v0.1.0`, DMG + 유니버설, `bundle.macOS.minimumSystemVersion` `13.0`(바꾸지 않는다), 저장소 `jang2162/tote-notes`, 업데이트 정보 주소 `https://github.com/jang2162/tote-notes/releases/latest/download/latest.json`.
- WebView CSP 의 `connect-src` 는 `ipc: http://ipc.localhost tote-file:` 그대로다. 업데이트 요청은 Rust 에서만 나간다. 프런트에 updater·process 플러그인 권한을 주지 않는다(`capabilities/default.json` 그대로).
- 「업데이트 자동 확인」 이 꺼져 있으면 실행 때 어떤 요청도 나가지 않는다. 설치는 사람이 대화상자에서 고른 뒤에만 시작한다.
- 업데이트 재시작은 `app.restart()` 를 직접 부르지 않는다. 언제나 `lifecycle::begin_restart` → 저장 라운드 → `finish(FlushGoal::Restart)` 를 거친다.
- 비밀 값은 저장소·로그·산출물에 남기지 않는다. 비밀은 필요한 단계의 `env` 에만, 값은 한 줄(base64), `set -x` 금지, 빠진 비밀은 **이름만** 찍는다.
- 화면 글은 한국어이고 이 계획이 적은 문구를 그대로 쓴다. 새 메뉴 항목 「업데이트 확인…」 은 앱 명령(단축키를 바꿀 수 있고 기본값 없음)이다.
- 디버그 빌드(`cfg!(debug_assertions)`, `perf` 프로필 포함)는 `TOTE_UPDATE_CHECK=1` 이 없으면 업데이트를 확인하지 않는다(계획자 판단 1).
- 앱을 띄우는 모든 단계는 `docs/guides/development.md` 「디버그 앱은 언제나 `TOTE_DATA_DIR` 을 주고 띄운다」 를 따른다. 릴리스 빌드도 `TOTE_DATA_DIR` 을 준다(없으면 사람의 실제 `~/Library/Application Support/tote` 를 쓴다). 화면이 필요한 확인은 하지 않고 「화면 확인 후보」 로 보고에 남긴다(코디네이터가 별도 워커로 돌린다).
- `shortcuts::COMMANDS` 를 바꾸면 같은 커밋에서 `UPDATE_FIXTURES=1 cargo test`(src-tauri)로 `src-tauri/tests/fixtures/shortcut-table.json` 을 재생성하고 `src/backend/fake-shortcuts.ts` 사본을 맞춘다.
- 스크립트는 저장소 관례대로 `scripts/*.ts`(node 24 가 그대로 돌린다)와 `scripts/*.test.ts`(vitest 가 집는다)로 쓴다. keyring-notes 의 `.mjs` 를 그대로 복사하지 않는다.
- 커밋 전: `pnpm fmt`, `pnpm lint`, `pnpm typecheck`, Rust 를 고쳤으면 `cargo fmt --all`·`cargo clippy --all-targets -- -D warnings`(src-tauri). 시험 보고는 **실행 개수**와 함께. 고친 동작마다 그 수정을 되돌리면 실패하는 시험을 두고 변이 결과를 보고에 적는다.
- `git add -A` 금지. 커밋할 파일을 경로로 적는다. `docs/guideline/` 은 지침 서버 사본이라 고치지 않는다.
- 하지 않는 것(설계 「하지 않는 것」): 비밀 등록, 태그 푸시, 첫 릴리스 실행, LICENSE, 검증용 임시 트리거·브랜치 푸시.

## 계획자 판단

1. **디버그 빌드는 업데이트를 확인하지 않는다.** `tote-dev.app` 이 릴리스 업데이트를 받으면 개발 번들 자리에 배포 앱이 풀리고, 에이전트 스모크마다 github.com 에 요청이 나간다. 디버그·`perf` 빌드는 `TOTE_UPDATE_CHECK=1` 일 때만 확인한다(로컬 업데이트 시험이 이것을 쓴다). 메뉴 「업데이트 확인…」 은 그때 「개발 빌드는 업데이트를 확인하지 않습니다」 를 보인다.
2. **확인·받기·설치는 Rust 가 하고 프런트에는 결과만 준다.** 창이 여럿이어도 확인 요청은 한 번이고(설계 「제약」 「업데이트 질문은 한 번만, 한 창에만」), 프런트에 updater 권한을 열 필요가 없다. 찾은 `Update` 는 Rust 상태에 두고, 설치는 tote 명령 `install_update` 가 한다.
3. **질문은 가장 최근에 포커스된 창(`AppCore::latest_window`) 하나에 간다.** 창이 하나도 없으면 다음에 처음 등록되는 창이 받는다. 받은 창이 답하지 않고 닫히면 이번 실행에서는 다시 묻지 않는다(수동 「업데이트 확인…」 은 다시 묻는다).
4. **다시 시작은 새 저장 라운드 `FlushGoal::Restart` 다.** 종료 라운드와 같은 창들이 같은 방식(`tote://flush` 의 `goal: "quit"` — 페이지는 칸을 놓지 않는다)으로 쓴다. 다른 라운드(닫기·바꾸기·종료)가 열려 있으면 시작하지 않고 `busy` 로 거절한다 — 닫기 라운드에 끼어드는 종료 규칙(`Ack::DoneThenQuit`)을 재시작에 넓히지 않기 위해서다. 재시작 라운드가 도는 중의 ⌘Q·Dock 종료·창 닫기는 종료 라운드처럼 흡수된다.
5. **저장 실패·취소.** 저장 못 한 메모가 있으면 기존 질문(「저장하지 못한 메모가 있습니다」)을 버튼 「그래도 다시 시작」/「취소」 로 띄운다. 「취소」 면 다시 시작하지 않고 모든 창에 `tote://restart-off` 를 보낸다. 업데이트는 이미 설치됐으므로 대화상자는 「업데이트는 설치됐습니다. 다음에 tote 를 열면 새 버전으로 시작합니다.」 와 「닫기」·「다시 시작」 을 보인다. 저장 라운드가 시간 제한(`FLUSH_TIMEOUT` 3초)으로 끝나면 종료와 똑같이 그대로 다시 시작한다.
6. **설치 뒤에 저장하고 다시 시작한다**(설치 전에 저장하지 않는다). 받는 동안에도 사람이 계속 쓸 수 있으므로 저장은 다시 시작하기 직전이어야 한다. 설치는 실행 중인 앱 자리의 번들을 바꿔 끼울 뿐 실행 중인 프로세스는 그대로라서(`tauri-plugin-updater` 2.14.0 `updater.rs` macOS `install_inner`: `swap_bundle`/`replace_bundle`) 그 사이 저장 경로는 영향이 없다.
7. **`request_restart()` 를 쓴다(`restart()` 가 아니다).** `restart()` 는 메인 스레드에서 부르면 `RunEvent::Exit` 없이 바로 새 프로세스를 띄운다. 그러면 단일 인스턴스 플러그인이 소켓을 치우기 전에 새 프로세스가 옛 프로세스의 소켓에 붙어 요청만 넘기고 끝날 수 있다. `request_restart()` 는 `Exit` 를 거쳐(플러그인 `on_event` 의 `destroy` 가 소켓을 지운 뒤) 다시 띄운다. 근거: `tauri` 2.12.1 `src/app.rs` `AppHandle::restart`·`request_restart` 와 `App::run` 의 `RuntimeRunEvent::Exit` 분기, `tauri-plugin-single-instance` 2.5.2 `src/platform_impl/macos.rs`.
8. **macOS 가 종료를 기다리는 중이면 다시 시작하지 않고 종료한다.** 재시작 라운드에 Dock 종료·로그아웃이 흡수돼 `system_quit` 이 답을 기다리면 `finish(Restart)` 는 그 답(종료)을 주고 끝난다. 업데이트는 설치됐으므로 다음 실행이 새 버전이다.
9. **수동 확인의 자리는 앱 메뉴 「tote」 의 「tote에 관하여」 바로 아래**(macOS 관례). 결과가 「없음」·「실패」 면 Rust 네이티브 메시지 상자(「셸 명령 설치」 와 같은 방식), 「찾음」 이면 그 메뉴를 고른 창에 대화상자. 설정 화면에는 확인 단추를 두지 않는다.
10. **「업데이트 자동 확인」 은 설정 「일반」 구역, settings.json `updates.autoCheck`(기본 `true`).** 패치 키 `updatesAutoCheck`. 새 구역을 만들지 않는다(설정 설계의 구역 다섯 그대로).
11. **실행 때 확인은 창이 뜨고 5초 뒤, 시간 제한 15초**(keyring-notes `STARTUP_DELAY_MS`·`CHECK_TIMEOUT_MS` 와 같다. 플러그인은 기본으로 시간 제한이 없다 — `updater.rs` `UpdaterBuilder::timeout`). 설정은 **확인하는 순간에** 다시 읽는다(그 사이 끈 것도 지킨다). 실패는 조용히 넘긴다.
12. **버전의 단일 원천은 루트 `package.json`**, 맞추는 곳은 넷: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` `[package]`, `src-tauri/Cargo.lock` 의 `tote` 항목. 화면의 버전(「tote에 관하여」)은 번들 Info.plist 라서 `tauri.conf.json` 을 따른다 — 다섯째 자리는 없다.
13. **CI 의 Rust 는 mise 의 것이다.** `jdx/mise-action` 이 `mise.toml` 의 rust 1.99.0 을 깔고 `RUSTUP_TOOLCHAIN` 을 그 버전으로 둔다(로컬 실측: `mise exec -- sh -c 'echo $RUSTUP_TOOLCHAIN'` → `1.99.0`). 유니버설 빌드에 필요한 두 타깃은 그 툴체인에 `rustup target add` 로 더한다. `mise.toml` 은 바꾸지 않는다(모든 개발 머신이 x86_64 타깃을 받게 된다).
14. **릴리스 파일 이름**은 `tote_<버전>_universal.dmg`, `tote_<버전>_universal.app.tar.gz`, `….app.tar.gz.sig`, `latest.json`. 공백이 없으니 GitHub 가 이름을 바꾸지 않는다.
15. **entitlements 는 Task 9 의 실측으로 정한다.** 출발점은 「없음」(keyring-notes 와 같다: 샌드박스가 아닌 앱의 파일 접근은 entitlement 가 필요 없고, WebKit 의 JS·WASM 은 WebContent 프로세스가 돌린다). 막히는 것이 나오면 그 하나만 더한다.
16. **로컬 업데이트 시험은 별도 식별자(`com.develma.totenotes.updatetest`, 이름 `tote-updatetest`)의 `perf` 프로필 번들 두 벌**로 한다. 사람의 설치본·개발 앱과 단일 인스턴스·데이터가 섞이지 않고, `perf` 는 `TOTE_BACKGROUND` 가 먹는다. 업데이트 정보 파일은 `http://127.0.0.1` 로 낸다(`dangerousInsecureTransportProtocol` 은 시험 설정에만).

## 코드로 확인한 사실 (계획의 근거)

- **저장 흐름.** 창 닫기·워크스페이스 바꾸기·종료는 모두 `src-tauri/src/app/lifecycle.rs` `begin(app, goal)` → `AppCore::begin_flush` → `FlushCoordinator::begin`(`src-tauri/src/app/flush.rs`) → 창마다 `tote://flush {id, goal}` → 페이지가 탭을 쓰고 `flush_done` → `lifecycle::ack` → `settle` → `steps_for_ack` → `finish(goal)`. 종료는 `finish(FlushGoal::Quit)` 가 `AppCore::start_quit()`(세션·launch 파일을 쓰고 `quitting = true`) 뒤 macOS 가 기다리면 `system_quit::answer`, 아니면 `app.exit(0)`. 저장 실패는 `Ack::Blocked` → `ask_blocked`(네이티브 질문, 버튼은 `blocked_labels`) → `resolve_blocked` → `steps_for_answer`. 시간 제한은 `FLUSH_TIMEOUT`(3초). 메뉴 「tote 종료」 는 `menu::run_command` 의 `"quit"`, Dock·로그아웃은 `system_quit::should_terminate`.
- `FlushGoal` 을 match 하는 곳: `flush.rs`(`kind`, `window`, `begin`), `mod.rs` `begin_flush`(종료 라운드의 창 고르기)·`expire_flush`, `lifecycle.rs` `steps_for_answer`·`blocked_labels`·`finish` 와 그 시험들. 프런트는 `src/backend/types.ts` `FlushGoal = "close" | "switch" | "quit"` 이고 `src/app/controller.ts` 가 `goal !== "quit"` 일 때만 칸을 놓는다.
- **식별자에 묶인 것.** ① 단일 인스턴스 소켓 `/tmp/<식별자의 . - 를 _ 로>_si.sock`(`tauri-plugin-single-instance` 2.5.2 macOS `socket_path`): 배포 `/tmp/com_develma_totenotes_si.sock`, 개발 `/tmp/com_develma_totenotes_dev_si.sock`. ② `scripts/measure-perf.sh` 가 옛 개발 식별자와 그 소켓 이름을 네 자리에서 쓴다(주석 2, `socket_owners` 의 awk 패턴, `launch` 의 오류 문구). ③ `src-tauri/tauri.conf.json`·`src-tauri/tauri.dev.conf.json`. ④ `src-tauri/src/lib.rs` 의 단일 인스턴스 주석은 식별자 값을 적지 않아 그대로 맞다.
- **식별자에 묶이지 않는 것.** 메모·settings.json·machine.json 은 `src-tauri/src/appdata.rs` `AppPaths::resolve`(`dirs::data_dir()/tote`, 디버그는 `tote-dev`, `TOTE_DATA_DIR` 우선) — 빌드 종류로 갈리고 식별자와 무관하다. 앱은 WebView 저장소를 쓰지 않는다(`localStorage`·`sessionStorage` 는 `src/backend/fake*.ts` 와 e2e 만). `tote` 셸 명령은 번들 안 스크립트로의 심볼릭 링크라 경로에 묶이고(`src-tauri/src/cli/install.rs`), 같은 이름 `.app` 끼리만 링크를 넘겨받는다(`is_tote_link`). CLI 는 번들을 `open -n` 으로 띄워 단일 인스턴스로 넘긴다(`src-tauri/src/cli/front.rs` `launch`).
- **식별자가 바뀌면 사람에게 생기는 일(데이터 손실 없음):** macOS 가 옛 식별자에 준 것 — 폴더 접근 허락(TCC: 문서·데스크톱 등), `~/Library/WebKit/dev.tote.note`·`~/Library/Caches/dev.tote.note`, `~/Library/Preferences/dev.tote.note.plist`(파일 대화상자의 마지막 폴더 등) — 은 새 앱이 이어받지 않는다. 폴더 접근은 처음 한 번 다시 묻는다. 가이드 「바꾸면 안 되는 것」 에 적는다.
- **업데이트 뒤 셸 명령.** macOS 설치는 앱 경로 자체를 새 번들과 바꿔 끼운다(`tauri-plugin-updater` 2.14.0 `updater.rs` macOS `install_inner` 의 `swap_bundle`) — `/Applications/tote.app/Contents/Resources/bin/tote` 로의 링크는 계속 맞다. Task 10 이 실측한다.
- **`requireSignedVersion`.** `@tauri-apps/cli` 2.12.1 은 `tauri build` 가 업데이트 서명의 신뢰 주석에 버전을 적는다(`node_modules/@tauri-apps/cli/CHANGELOG.md`). 그래서 `plugins.updater.requireSignedVersion: true` 를 켠다(`tauri-plugin-updater` `config.rs` `require_signed_version` 설명: 끄면 옛 서명본에 높은 버전 번호를 붙인 응답으로 되돌림이 된다).
- **서명·공증 환경 변수.** 번들러는 `APPLE_CERTIFICATE`·`APPLE_CERTIFICATE_PASSWORD`(임시 키체인), 공증은 `APPLE_API_ISSUER`·`APPLE_API_KEY`·`APPLE_API_KEY_PATH`, 업데이트 서명은 `TAURI_SIGNING_PRIVATE_KEY`·`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`(Tauri 문서 `reference/environment-variables`, `distribute/sign/macos` 「Notarization」). 공증 자격이 빠지면 번들러는 경고만 남기고 건너뛰고, DMG 는 서명만 한다 — 그래서 검사·DMG 공증 단계가 따로 있다(keyring-notes `docs/superpowers/plans/2026-10-18-mac-distribution.md` 「릴리스는 tauri-action 대신…」 의 번들러 소스 확인). `CI=true` 면 DMG 의 Finder 꾸미기(AppleScript)를 건너뛴다(같은 문서 「DMG 실패」 — 에이전트 셸에서 `exit 64` 로 실패한 곳). Developer ID 중간 인증서(G2)는 러너에 있다는 보장이 없어 keyring-notes 워크플로가 받아 넣는다(첫 실릴리스에서 막혀 더한 단계다).
- `tauri build --config` 는 여러 번 줄 수 있고 순서대로 덮어쓴다(`pnpm tauri build --help`).

## Review Focus

1. **설정을 끈 사용자가 실행 직후 5초 안에 끈다** — 확인은 그 순간의 설정을 다시 읽어 요청을 보내지 않는다. Task 4 Rust `the_startup_check_reads_the_setting_when_it_runs`, Task 10 의 실제 빌드 요청 기록.
2. **재시작 라운드 중 Dock 종료·⌘Q·창 닫기** — 흡수되고, Dock 종료면 종료로 끝난다(재시작하지 않는다). Task 3 Rust `a_restart_absorbs_a_quit_and_a_close`.
3. **질문을 받은 창이 답하기 전에 닫힌다 / 창이 하나도 없을 때 찾았다** — 한 번만 묻고, 창이 없으면 다음 창이 받는다. Task 4 Rust `an_update_offer_goes_to_one_window`·`an_offer_with_no_window_waits_for_the_first_one`.
4. **응용 프로그램 폴더 밖(DMG 안·다운로드 폴더의 격리 실행)에서 설치가 실패한다** — 대화상자가 오류를 보이고 「다시 시도」 를 둔다, 앱은 그대로 돈다. Task 6 e2e `an install that fails says why and can be retried`, 가이드 실패 표.
5. **설정 화면이 열린 창에 질문이 온다** — 대화상자가 위에 뜨고 Escape 는 위의 것만 닫는다. Task 6 e2e `an update offer opens over the settings screen and Escape closes only it`.

---

### Task 1: 버전의 단일 원천

**Files:**

- Create: `scripts/version.ts`, `scripts/version.test.ts`
- Modify: `package.json`(`version` → `0.1.0`, 스크립트 `version:set`·`version:check`)

**Interfaces:**

- Produces: `export const PLACES: readonly Place[]`(file·get·put), `export function versions(root: string): { file: string; version: string | null }[]`, `export function versionProblems(root: string, tag?: string): string[]`(빈 배열이면 맞다), `export function setVersion(root: string, version: string): void`(정규식이 자리를 못 찾으면 throw). CLI: `node scripts/version.ts set <버전>` / `check [태그]` — 다르면 exit 1, 고치는 명령(`pnpm version:set <버전>`)을 함께 찍는다. 태그는 `refs/tags/` 앞붙이를 떼고 `v<버전>` 과 비교.
- 자리 넷: `package.json` 과 `src-tauri/tauri.conf.json` 의 최상위 `"version"`(두 칸 들여쓰기 줄), `src-tauri/Cargo.toml` 첫 `[package]` 표의 `version`, `src-tauri/Cargo.lock` 의 `name = "tote"\nversion = "…"`.

- [ ] **Step 1: 실패하는 시험** — 임시 폴더에 네 파일의 최소 사본을 만들어:
  - `versionProblems` 가 넷이 같으면 `[]`, 하나가 다르면 그 파일 이름이 든 문제 하나, `package.json` 이 SemVer 가 아니면 문제, 태그 `v0.1.0`·`refs/tags/v0.1.0` 은 통과하고 `v0.1.1` 은 「태그 v0.1.1 가 버전 v0.1.0 와 다르다」.
  - `setVersion(root, "0.2.0")` 뒤 넷 다 `0.2.0`, Cargo.toml 의 의존성 `version = "2"` 줄과 Cargo.lock 의 다른 패키지 버전은 그대로.
  - `setVersion(root, "v0.2.0")` 은 throw(앞의 v 금지), 자리를 못 찾는 파일 모양이면 throw.
- [ ] **Step 2:** `pnpm test scripts/version.test.ts` 가 실패하는 것을 본다.
- [ ] **Step 3:** 구현. keyring-notes `scripts/version.mjs` 의 구조를 따르되 다섯째 자리(`i18n.ts`)는 없다. `package.json` 에 `"version:set": "node scripts/version.ts set"`, `"version:check": "node scripts/version.ts check"`.
- [ ] **Step 4:** `pnpm version:set 0.1.0` → `pnpm version:check` 가 `모두 0.1.0`. `pnpm version:check v0.1.1` 은 exit 1(보고에 출력).
- [ ] **Step 5:** 시험(개수), fmt·lint·typecheck.
- [ ] **Step 6: 커밋** `build: keep the version in package.json and match the other three`
  ```bash
  git add scripts/version.ts scripts/version.test.ts package.json
  ```

### Task 2: 식별자·번들 설정과 그 파급

**Files:**

- Modify: `src-tauri/tauri.conf.json`(`identifier`, `bundle.targets`, `bundle.macOS.hardenedRuntime`), `src-tauri/tauri.dev.conf.json`(`identifier`), `package.json`(스크립트 `build:mac`), `scripts/measure-perf.sh`(식별자·소켓 네 자리), `docs/guides/development.md`(디버그 번들 절에 두 식별자)
- Create: `scripts/release-config.test.ts`

**Interfaces:**

- Produces: 배포 식별자 `com.develma.totenotes`, 개발 식별자 `com.develma.totenotes.dev`, `bundle.targets: ["app", "dmg"]`, `bundle.macOS: { "minimumSystemVersion": "13.0", "hardenedRuntime": true }`, 루트 스크립트 `"build:mac": "CI=true tauri build --target universal-apple-darwin"`(Task 8 의 CI 가 이 이름으로 부른다). `createUpdaterArtifacts` 는 설정 파일에 두지 않는다(업데이트 키가 없는 로컬 빌드가 실패하므로 CI 가 `--config` 로 켠다).
- Produces: `scripts/release-config.test.ts` — 배포 설정의 지켜야 할 값을 한 곳에서 지킨다. Task 4·9 가 여기에 단언을 더한다.

- [ ] **Step 1: 실패하는 시험** `scripts/release-config.test.ts`(두 설정 파일을 읽는다):
  - `identifier` 가 `com.develma.totenotes`, 개발 설정이 `com.develma.totenotes.dev`·`tote-dev`, `productName` 이 `tote`.
  - `bundle.targets` 가 `app`·`dmg` 를 담고, `hardenedRuntime === true`, `minimumSystemVersion === "13.0"`, `createUpdaterArtifacts` 가 `true` 가 아니다.
  - CSP `connect-src` 가 정확히 `"ipc: http://ipc.localhost tote-file:"`.
  - 저장소에 옛 식별자가 남지 않았다: `git grep -nE 'dev\.tote\.note|dev_tote_note' -- . ':!docs/superpowers'` 의 결과가 비었다(시험 안에서 `execFileSync("git", …)`; 날짜 붙은 계획·스펙·보고는 이력 문서라 제외 — `docs/guideline/base/04-citation.md` 「이력 문서는 연대기 금지의 예외다」).
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 설정 두 파일, `build:mac`, `measure-perf.sh`(주석의 식별자, 소켓 `/tmp/com_develma_totenotes_dev_si.sock`, awk 패턴 `^\/tmp\/com_develma_totenotes_dev.*_si\.sock$`, `launch` 의 문구), `development.md` 디버그 번들 문단에 「디버그 번들의 식별자는 `com.develma.totenotes.dev`(접근성 도구의 `--app` 값), 배포 앱은 `com.develma.totenotes` 다」 한 문장.
- [ ] **Step 4:** `bash -n scripts/measure-perf.sh`, 시험 통과.
- [ ] **Step 5: 서명 없는 유니버설 빌드.** 먼저 `rustup target add --toolchain 1.99.0 x86_64-apple-darwin`(이 머신에 없다). `pnpm build:mac` 뒤(앱을 띄우지 않는다) 보고에 적는다:
  - `B=src-tauri/target/universal-apple-darwin/release/bundle`; `lipo -archs "$B/macos/tote.app/Contents/MacOS/tote"` 가 `x86_64 arm64`.
  - `$B/dmg/tote_0.1.0_universal.dmg` 가 있고 크기.
  - `plutil -extract CFBundleIdentifier raw "$B/macos/tote.app/Contents/Info.plist"` 이 `com.develma.totenotes`, `CFBundleShortVersionString` 이 `0.1.0`, `LSMinimumSystemVersion` 이 `13.0`.
  - `bundle/macos/rw.*.dmg` 중간 파일이 남지 않았다(Finder 꾸미기를 건너뛴 증거).
- [ ] **Step 6:** fmt·lint·typecheck, 시험 개수.
- [ ] **Step 7: 커밋** `build: com.develma.totenotes, DMG and hardened runtime`
  ```bash
  git add src-tauri/tauri.conf.json src-tauri/tauri.dev.conf.json package.json scripts/measure-perf.sh scripts/release-config.test.ts docs/guides/development.md
  ```

### Task 3: 업데이트 재시작이 저장 흐름을 거친다

**Files:**

- Modify: `src-tauri/src/app/flush.rs`, `src-tauri/src/app/lifecycle.rs`, `src-tauri/src/app/mod.rs`(`begin_flush`, `expire_flush`, 새 `begin_restart`)
- Test: 위 세 파일의 `#[cfg(test)]`

**Interfaces:**

- Produces(flush.rs): `FlushGoal::Restart` — `kind()` 는 `"quit"`, `window()` 는 `None`. `pub fn is_quit(&self) -> bool`(Quit·Restart). `FlushCoordinator::begin` 의 「종료 라운드가 돈다」 판정(`quit_running`)은 `is_quit()` 로 본다 — 그래서 재시작 라운드가 ⌘Q·Dock 종료·창 닫기를 흡수한다. 닫기·바꾸기 라운드에 끼어드는 규칙(`quit_waiting`)은 `FlushGoal::Quit` 에만 그대로 둔다. `pub fn is_idle(&self) -> bool`(열린 라운드가 없다).
- Produces(mod.rs): `pub fn begin_restart(&self) -> Result<Begin, RestartBusy>` — **한 잠금 안에서** `flush.is_idle()` 가 아니면 `Err(RestartBusy)`, 맞으면 종료 라운드와 같은 창 목록으로 `flush.begin(FlushGoal::Restart, …)`. 종료 라운드의 창 고르기를 함수 하나로 떼어 둘이 같이 쓴다. `expire_flush` 의 match 는 `Quit | Restart => {}`. `pub struct RestartBusy;`
- Produces(lifecycle.rs): `pub fn begin_restart(app: &AppHandle) -> Result<(), RestartBusy>`(시작한 라운드를 `run(app, round, "quit")`). `Step::RestartOff`(모든 창에 `tote://restart-off`). `steps_for_answer`: `(Restart, true)` → `[Finish(Restart)]`, `(Restart, false)` → `[RefuseSystemQuit, RestartOff]`. `blocked_labels(Restart)` → `("그래도 다시 시작", "그래도 다시 시작하면")`. `finish(Restart)`: `start_quit()` → (macOS) `system_quit::answer(app, true)` 가 참이면 끝(계획자 판단 8) → 아니면 `app.request_restart()`(계획자 판단 7). `keeps_window(Restart, _)` 는 거짓.
- 이 태스크는 명령을 만들지 않는다. 프런트가 부르는 `restart_for_update` 는 설치 여부를 쥔 Task 4 가 만들고 `lifecycle::begin_restart` 를 부른다.

- [ ] **Step 1: 실패하는 시험**
  - flush.rs `a_restart_waits_for_every_window_like_a_quit`: `begin(Restart, ["a","b"])` 이 `Started`, `ack a` → `Pending`, `ack b` → `Done(Restart)`. `FlushGoal::Restart.kind() == "quit"`, `window() == None`.
  - flush.rs `a_restart_absorbs_a_quit_and_a_close`(Review Focus 2): 재시작 라운드가 도는 동안 `begin(Quit, …)`·`begin(CloseWindow("a"), …)` 가 `AlreadyRunning`, 그 뒤 `ack` 들이 `Done(Restart)` 로 끝난다(`DoneThenQuit` 이 아니다).
  - flush.rs `is_idle_only_without_rounds`: 처음 참, 닫기 라운드 중 거짓, 질문 중(`Blocked`) 거짓, `cancel` 뒤 참.
  - mod.rs `a_restart_never_starts_beside_another_round`: 닫기 라운드가 열린 `AppCore` 에서 `begin_restart()` 가 `Err(RestartBusy)`, 닫기 라운드가 끝나면 `Ok(Started{..})`.
  - mod.rs `a_restart_waits_on_the_windows_a_quit_would`: 페이지가 뜬 창·뜨지 않은 창·닫히는 창이 섞인 상태에서 `begin_restart()` 의 창 목록이 같은 상태의 `begin_flush(Quit)` 목록과 같다(기존 종료 시험의 상태 만들기를 재사용).
  - lifecycle.rs 기존 표 시험에 행을 더한다: `steps_for_ack(Ack::Done(Restart))` → `[Finish(Restart)]`, `steps_for_answer(Restart, true, _)` → `[Finish(Restart)]`, `(Restart, false, _)` → `[RefuseSystemQuit, RestartOff]`, `blocked_labels`·`blocked_message` 가 「그래도 다시 시작」·「그래도 다시 시작하면 저장하지 못한 글은 사라집니다.」, `keeps_window(&Restart, exit)` 가 모든 `Exit` 에 거짓.
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml` 실패 확인.
- [ ] **Step 3:** 구현(Interfaces 대로). match 가 빠진 곳은 컴파일러가 알린다 — 위 「코드로 확인한 사실」 의 목록과 맞는지 보고에 적는다.
- [ ] **Step 4:** 시험 통과(개수). 변이: `quit_running` 을 `== FlushGoal::Quit` 로 되돌리면 `a_restart_absorbs_a_quit_and_a_close` 가, `begin_restart` 의 `is_idle` 검사를 빼면 `a_restart_never_starts_beside_another_round` 가 실패하는 것을 보고에 적는다.
- [ ] **Step 5:** `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`.
- [ ] **Step 6: 커밋** `feat: restart for an update through the write-then-quit round`
  ```bash
  git add src-tauri/src/app/flush.rs src-tauri/src/app/lifecycle.rs src-tauri/src/app/mod.rs
  ```

### Task 4: 업데이트 확인(Rust)과 「업데이트 자동 확인」 설정

**Files:**

- Create: `src-tauri/src/app/update.rs`
- Modify: `src-tauri/Cargo.toml`(`tauri-plugin-updater = "2"`), `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`(`plugins.updater`), `src-tauri/src/lib.rs`(플러그인 등록, `update::start`, 명령), `src-tauri/src/app/mod.rs`(`PendingOpen::Update`, 창 등록 때 기다리던 질문 넘기기), `src-tauri/src/app/commands.rs`(`install_update`), `src-tauri/src/appdata.rs`(`Settings.updates`, `SettingsPatch.updates_auto_check`), `scripts/release-config.test.ts`, `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`(settings.json 설명 줄에 `updates`)
- Test: `update.rs`·`mod.rs`·`appdata.rs` 의 시험

**Interfaces:**

- Consumes: Task 3 `lifecycle::begin_restart(app) -> Result<(), RestartBusy>`.
- Produces(settings): `pub struct UpdateSettings { pub auto_check: bool }`(기본 `true`, `lenient_on`), `Settings.updates`(JSON `"updates": {"autoCheck": true}`), `SettingsPatch.updates_auto_check: Option<bool>`(JSON `updatesAutoCheck`).
- Produces(config): `plugins.updater = { "pubkey": "REPLACE_WITH_UPDATER_PUBLIC_KEY", "endpoints": ["https://github.com/jang2162/tote-notes/releases/latest/download/latest.json"], "requireSignedVersion": true }`. 자리 표시 값은 사람이 키를 만들어 바꾼다(가이드). 릴리스 워크플로가 자리 표시 값이면 실패한다(Task 8).
- Produces(update.rs):
  - `pub const STARTUP_DELAY: Duration = 5s`, `pub const CHECK_TIMEOUT: Duration = 15s`.
  - `pub fn checks_allowed(debug: bool, test_override: bool) -> bool` = `!debug || test_override`(`test_override` 는 `TOTE_UPDATE_CHECK=1`).
  - `pub async fn startup_check<C, Fut, U>(wanted: impl Fn() -> bool, check: C) -> StartupCheck<U>` where `C: FnOnce() -> Fut`, `Fut: Future<Output = Result<Option<U>, String>>` — `wanted()` 가 거짓이면 `check` 를 부르지 않고 `Off`, 아니면 `Found(U)` / `None` / `Failed(String)`. 지연은 부르는 쪽(`start`)이 이 함수 **전에** 잠든다 — 그래야 `wanted` 가 확인 순간의 설정을 읽는다.
  - `pub struct UpdateOffer { version: String, current: String, notes: Option<String> }`(serde camelCase).
  - `pub struct Updates`(manage 한다): 찾은 `tauri_plugin_updater::Update` 한 개, `installing`, `installed`. `pub fn installed(&self) -> bool`.
  - `pub fn start(app: &AppHandle)`: `setup` 에서 부른다. `checks_allowed` 가 거짓이면 아무것도 하지 않는다. 아니면 비동기로 `STARTUP_DELAY` 잔 뒤 `startup_check(|| core.settings().updates.auto_check, …)`. 찾으면 `Updates` 에 두고 `AppCore::offer_update(offer, None)`. 실패는 `eprintln!` 만.
  - `pub fn check_now(app: &AppHandle, window: Option<String>)`(Task 5 의 메뉴가 부른다): 설정과 상관없이 확인한다(사람이 고른 것). 결과는 Task 5 가 정한 대로 보인다.
  - 확인은 `app.updater_builder().timeout(CHECK_TIMEOUT).build()?.check().await`.
- Produces(mod.rs): `PendingOpen::Update(UpdateOffer)`(프런트 `{ kind: "update", version, current, notes }`). `pub fn offer_update(&self, offer: UpdateOffer, prefer: Option<&str>) -> Option<String>` — `prefer` 가 등록된 창이면 그 창, 아니면 `latest_window()`, 그것도 없으면 `Inner` 에 맡겨 두고 `None`. 고른 창의 `pending` 에 넣고 그 라벨을 돌려준다(부르는 쪽이 `tote://pending` 을 보낸다). 맡겨 둔 질문은 다음에 등록되는 창(`register_window`)이 받는다. 한 번 넘긴 질문은 다시 넘기지 않는다.
- Produces(commands.rs): `#[tauri::command] async fn install_update(app, on_progress: tauri::ipc::Channel<UpdateProgress>) -> Result<(), CommandError>` — `UpdateProgress` 는 `{ kind: "progress", done: u64, total: Option<u64> }` 또는 `{ kind: "installing" }`. 찾은 것이 없으면 `"no-update"`, 이미 받는 중이면 `"busy"`. `download_and_install` 이 끝나면 `installed` 를 세운다. 실패하면 찾은 것을 그대로 두어 다시 시도할 수 있다.
- Produces(commands.rs): `#[tauri::command] fn restart_for_update(app) -> Result<(), CommandError>` — 이번 실행에서 설치하지 않았으면 `CommandError::new("not-installed", …)`(페이지 결함이 앱을 그냥 다시 띄우지 못하게), `RestartBusy` 면 `CommandError::new("busy", "다른 창이 저장하는 중입니다")`, 아니면 `lifecycle::begin_restart`. 두 명령을 `lib.rs` 의 `generate_handler!` 에 더한다.

- [ ] **Step 1: 실패하는 시험**
  - update.rs `checks_are_off_in_debug_builds_unless_asked`: `(false,false)` 참, `(true,false)` 거짓, `(true,true)` 참.
  - update.rs `the_startup_check_reads_the_setting_when_it_runs`(Review Focus 1): `wanted` 가 거짓을 주면 결과 `Off` 이고 `check` 가 한 번도 불리지 않는다(부른 횟수를 세는 클로저). 참이면 한 번 불리고 `Found`/`None`, `Err("offline")` 이면 `Failed`.
  - mod.rs `an_update_offer_goes_to_one_window`(Review Focus 3): 창 둘에서 `offer_update(offer, None)` 이 최근 포커스 창 하나에만 `PendingOpen::Update` 를 넣는다. 같은 질문이 다른 창에 다시 가지 않는다. `prefer: Some("b")` 면 b.
  - mod.rs `an_offer_with_no_window_waits_for_the_first_one`: 창이 없을 때 `None`, 이어서 등록된 첫 창의 `take_pending` 에 질문이 있고, 둘째 창에는 없다.
  - update.rs `a_restart_needs_an_installed_update`: 설치 전 `restart_for_update` 의 판정 함수가 `not-installed`, 설치 뒤 다른 라운드가 열려 있으면 `busy`(판정은 `fn restart_refusal(installed: bool, busy: bool) -> Option<&'static str>` 로 떼어 시험한다).
  - appdata.rs `updates_auto_check_is_on_by_default_and_survives_a_bad_value`: `{}` → 참, `{"updates":{"autoCheck":false}}` → 거짓, `{"updates":{"autoCheck":"no"}}` → 참(그리고 `workspaceRoot` 등 다른 필드는 살아남는다). 패치 `{"updatesAutoCheck": false}` 가 그것만 바꾸고 파일에 `"autoCheck": false` 로 쓴다.
  - `scripts/release-config.test.ts`: `plugins.updater.endpoints` 가 위 주소 하나, `requireSignedVersion === true`, `pubkey` 가 비어 있지 않다. `capabilities/default.json` 의 `permissions` 가 `["core:default", "dialog:allow-open"]` 그대로(업데이터·프로세스 권한이 프런트에 없다).
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 구현. 플러그인은 `tauri_plugin_updater::Builder::new().build()` 로 등록한다(`tauri-plugin-updater` `lib.rs` `UpdaterExt`). 코어 스펙의 settings.json 줄에 「업데이트 자동 확인(`updates.autoCheck`)」 을 더한다.
- [ ] **Step 4:** `cargo test`(개수), `pnpm test`(개수). 변이: `start` 가 지연 **뒤가 아니라 앞에서** 설정을 읽게 바꾸면 Review Focus 1 의 시험이 실패하도록 시험을 짰는지 보고에 적는다(실패하지 않으면 시험을 고친다).
- [ ] **Step 5:** `cargo fmt`·`clippy`, fmt·lint·typecheck.
- [ ] **Step 6: 커밋** `feat: check for updates at launch from Rust, unless turned off`
  ```bash
  git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/src/app/update.rs src-tauri/src/app/mod.rs src-tauri/src/app/commands.rs src-tauri/src/appdata.rs src-tauri/src/lib.rs scripts/release-config.test.ts docs/superpowers/specs/2026-10-07-tote-note-core-design.md
  ```

### Task 5: 메뉴 「업데이트 확인…」

**Files:**

- Modify: `src-tauri/src/shortcuts.rs`(`COMMANDS` 맨 앞), `src-tauri/src/app/menu.rs`(`MENUS` 의 「tote」, `run_command`), `src-tauri/tests/fixtures/shortcut-table.json`(재생성), `src/backend/fake-shortcuts.ts`, `docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md`(「무엇을 바꿀 수 있나」 의 앱 명령 목록에 「업데이트 확인」)
- Test: `shortcuts.rs`·`menu.rs` 시험, `src/backend/fake-shortcuts.test.ts`

**Interfaces:**

- Consumes: Task 4 `update::check_now(app, window: Option<String>)`, `checks_allowed`.
- Produces: 명령 `command("check-updates", "업데이트 확인…", "tote", None)` — `COMMANDS` 는 메뉴 순서라 `install-cli` 앞. 메뉴 「tote」: `About`, `Command("check-updates")`, `Separator`, `설정…`, …(나머지 그대로). `run_command` 의 `"check-updates"` → `update::check_now(app, Some(window.label()))`.
- 결과 문구(네이티브 메시지 상자, 제목 「업데이트 확인」):
  - 디버그 빌드: 「개발 빌드는 업데이트를 확인하지 않습니다.」
  - 새 버전 없음: 「tote {현재 버전} 이 최신 버전입니다.」
  - 실패: 「업데이트를 확인하지 못했습니다: {오류}」
  - 찾음: 상자 없이 그 창에 질문(`offer_update(offer, Some(label))`).

- [ ] **Step 1: 실패하는 시험** — `effective_matches_todays_menu` 기대 표 맨 앞에 `("check-updates", None)`. 메뉴 시험 `the_app_menu_offers_the_update_check_under_about`: 「tote」 메뉴 항목 순서가 `about, check-updates, separator, settings, …`. e2e `shortcuts.spec.ts` `the update check command takes a shortcut`: 단축키 구역의 앱 명령 목록에 「업데이트 확인…」 줄이 단축키 없이 있고, 녹음한 키가 저장된다.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 구현, `UPDATE_FIXTURES=1 cargo test`(src-tauri) 로 fixture 재생성, `fake-shortcuts.ts` 를 맞춘다.
- [ ] **Step 4:** `cargo test`, `pnpm test`, `tests/e2e/shortcuts.spec.ts`(명령 줄 개수 단언이 있으면 하나 는다 — 개수 보고).
- [ ] **Step 5: 커밋** `feat: 업데이트 확인… in the app menu`
  ```bash
  git add src-tauri/src/shortcuts.rs src-tauri/src/app/menu.rs src-tauri/tests/fixtures/shortcut-table.json src/backend/fake-shortcuts.ts docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md
  ```

### Task 6: 업데이트 대화상자와 설정 스위치

**Files:**

- Create: `src/ui/update-dialog.ts`, `tests/e2e/update.spec.ts`
- Modify: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src/app/controller.ts`(pending `update` 처리), `src/ui/settings.ts`(「일반」), `tests/e2e/settings.spec.ts`, `docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md`(「설정 화면」 의 구역 목록: 「일반: 워크스페이스 루트, 업데이트 자동 확인」)

**Interfaces:**

- Consumes: Task 3 `tote://restart-off`; Task 4 `restart_for_update`(오류 코드 `busy`·`not-installed`), `install_update`(채널), `PendingOpen::Update`, `updatesAutoCheck`.
- Produces(types.ts): `PendingOpen` 에 `{ kind: "update"; version: string; current: string; notes: string | null }`. `type UpdateProgress = { kind: "progress"; done: number; total: number | null } | { kind: "installing" }`. `Backend.installUpdate(onProgress: (p: UpdateProgress) => void): Promise<void>`, `Backend.restartForUpdate(): Promise<void>`, `Backend.onRestartOff(handler: () => void): () => void`. `Settings.updates: { autoCheck: boolean }`, `SettingsPatch.updatesAutoCheck?: boolean`.
- Produces(fake.ts, e2e 용 손잡이): `offerUpdate(offer)`(pending 에 넣고 알린다), 설치 결과를 고르는 `failNextInstall(message)`, 기록 `installCalls`·`restarted`. `restartForUpdate` 는 지금 열린 페이지에 `requestFlush(id, "quit")` 를 보내 `flush_done` 을 받은 뒤 `restarted = true` — 저장이 재시작보다 먼저인지 시험이 본다. `refuseNextRestart()` 는 `restart-off` 를 낸다.
- Produces(update-dialog.ts): `openUpdateDialog(backend: Backend, offer: UpdateOffer): Promise<void>`. `modal()` 하나로, 상태와 문구는 아래 그대로:
  - 묻기: 「새 버전 tote {version} 이 있습니다. 지금 버전은 {current} 입니다.」, 바뀐 점이 있으면 `<details><summary>바뀐 점</summary><pre>`, 버튼 「나중에」·「업데이트하고 다시 시작」(primary, `data-autofocus`).
  - 받는 중: 「받는 중… {n}%」(전체 크기를 모르면 「받는 중… {x.x} MB」), 설치 중: 「설치하는 중…」, 다시 시작: 「저장하고 다시 시작하는 중…」 — 셋 다 `role="status"`, 버튼은 막히고 Escape 도 닫지 않는다.
  - 실패: 「업데이트하지 못했습니다: {describeError}」, primary 「다시 시도」.
  - `busy`: 「다른 창이 저장하는 중입니다. 잠시 뒤 다시 눌러 주세요.」, primary 「다시 시작」.
  - `restart-off`: 「업데이트는 설치됐습니다. 다음에 tote 를 열면 새 버전으로 시작합니다.」, 「닫기」·「다시 시작」(primary).
- Produces(settings.ts): 「일반」 구역에 체크 상자 「실행할 때 업데이트 확인」, 그 아래 설명 「끄면 tote 는 실행할 때 github.com 에 새 버전을 묻지 않습니다. 메뉴 tote → 업데이트 확인… 으로 직접 확인할 수 있습니다.」. 바꾸는 즉시 `patchSettings({ updatesAutoCheck })`.

- [ ] **Step 1: 실패하는 e2e** `tests/e2e/update.spec.ts`:
  - `an update offer asks once and installs nothing until accepted`: `offerUpdate` → 대화상자 문구, `installCalls === 0`. 「나중에」 → 닫히고 여전히 0, 같은 질문이 다시 뜨지 않는다. (어느 창이 받는가는 Rust 의 몫이라 Task 4 의 시험이 본다.)
  - `accepting writes every open memo before the restart`: 메모에 글을 치고(저장 지연 안에) 질문 → 「업데이트하고 다시 시작」 → 진행 문구 → `restarted` 가 참이 됐을 때 가짜 저장소의 그 메모 내용이 친 글이고, 쓰기 기록이 재시작 기록보다 앞이다.
  - `a cancelled restart leaves the update installed and says so`: `refuseNextRestart` → 설치됨 문구와 「다시 시작」, 누르면 다시 재시작을 청한다.
  - `an install that fails says why and can be retried`(Review Focus 4): `failNextInstall("Read-only file system")` → 「업데이트하지 못했습니다: Read-only file system」 → 「다시 시도」 → 성공 흐름.
  - `an update offer opens over the settings screen and Escape closes only it`(Review Focus 5).
  - `settings.spec.ts` `the update check switch saves updates.autoCheck`: 「일반」 에 스위치가 켜져 보이고, 끄면 저장된 설정의 `updates.autoCheck` 가 거짓, 다시 열어도 꺼져 있다.
- [ ] **Step 2:** 실패 확인(`pnpm exec playwright test tests/e2e/update.spec.ts tests/e2e/settings.spec.ts`).
- [ ] **Step 3:** 구현. `tauri.ts` 의 `installUpdate` 는 `new Channel<UpdateProgress>()` 를 `install_update` 에 넘긴다(`@tauri-apps/api/core`). 고정 지연을 쓰지 않는다(시간은 `page.clock`).
- [ ] **Step 4:** e2e(개수), `pnpm test`(개수). 변이: `restartForUpdate` 를 저장 라운드 없이 바로 `restarted` 로 바꾸면 「accepting writes…」 가 실패하는지 본다(가짜 쪽 변이로 시험의 구분력을 확인하는 것이다 — 진짜 경로의 보장은 Task 3 의 Rust 시험과 Task 10 이다).
- [ ] **Step 5:** fmt·lint·typecheck.
- [ ] **Step 6: 커밋** `feat: ask before updating, then write and restart`
  ```bash
  git add src/ui/update-dialog.ts src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src/app/controller.ts src/ui/settings.ts tests/e2e/update.spec.ts tests/e2e/settings.spec.ts docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md
  ```

### Task 7: 업데이트 정보 파일과 서명 검증 스크립트

**Files:**

- Create: `scripts/updater-json.ts`, `scripts/updater-json.test.ts`, `scripts/verify-updater-sig.ts`, `scripts/verify-updater-sig.test.ts`

**Interfaces:**

- Produces: `export function updaterJson(opts: { version: string; url: string; signature: string; notes?: string; pubDate?: string; allowLocalHttp?: boolean }): UpdaterJson` — 키 `darwin-aarch64`·`darwin-x86_64` 둘에 같은 항목(플러그인 `get_urls` 가 `{os}-{arch}` 를 찾는다 — `tauri-plugin-updater` 2.14.0 `updater.rs`). `https://` 가 아니면 throw, 단 `allowLocalHttp` 이면 `http://127.0.0.1:` 과 `http://localhost:` 만 허용(Task 10 전용). CLI `--version --url --sig --out [--notes] [--pub-date] [--allow-local-http]`.
- Produces: `export function verifyUpdaterSignature(data: Buffer, sigB64: string, pubkeyB64: string): { trusted: string; version: string | null }` — 맞지 않으면 throw(이유: 키 ID 다름 / 파일 서명 틀림 / 신뢰 주석 서명 틀림 / 형식 아님). CLI `<파일> <파일.sig> [--pubkey <b64> | --config <tauri.conf.json>] [--version <버전>]`, 기본 설정은 `src-tauri/tauri.conf.json`. `--version` 이 주어지고 신뢰 주석의 버전과 다르면 실패. keyring-notes `scripts/verify-updater-sig.mjs` 의 검증(minisign: `ED` 면 BLAKE2b-512 로 줄인 뒤 Ed25519, 신뢰 주석 전체 서명, 키 ID)을 그대로 옮긴다.

- [ ] **Step 1: 실패하는 시험.**
  - `updater-json`: 두 키에 같은 url·signature, 버전 앞 `v` 를 뗀다, `http://` 는 throw, `allowLocalHttp` 여도 `http://example.com` 은 throw, 빈 서명·날짜 아닌 `pubDate` 는 throw.
  - `verify-updater-sig`: 시험 안에서 `pnpm tauri signer generate --ci -p test -w <임시>/k` 로 키를 만들고 `pnpm tauri signer sign -k <임시>/k -p test --app-version 0.1.0 <파일>` 로 서명한 픽스처(시험이 만들고 지운다; CLI 가 느리면 한 번 만들어 `beforeAll`) — 같은 키 통과·`version === "0.1.0"`, 다른 키는 「키 ID 가 다르다」, 파일 한 바이트를 바꾸면 「파일 서명이 맞지 않는다」, 자리 표시 공개 키 `REPLACE_WITH_UPDATER_PUBLIC_KEY` 는 「공개 키 형식이 아니다」.
- [ ] **Step 2:** 실패 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `pnpm test scripts`(개수), fmt·lint·typecheck.
- [ ] **Step 5: 커밋** `build: write latest.json and verify the update signature before release`
  ```bash
  git add scripts/updater-json.ts scripts/updater-json.test.ts scripts/verify-updater-sig.ts scripts/verify-updater-sig.test.ts
  ```

### Task 8: 릴리스 워크플로

**Files:**

- Create: `.github/workflows/release-macos.yml`

**Interfaces:**

- Consumes: `pnpm build:mac`(Task 2), `pnpm -s version:check [태그]`(Task 1), `node scripts/updater-json.ts`·`node scripts/verify-updater-sig.ts`(Task 7), 자리 표시 값 `REPLACE_WITH_UPDATER_PUBLIC_KEY`(Task 4).
- Produces: keyring-notes `.github/workflows/release-macos.yml` 과 같은 단계·같은 비밀 이름 일곱(`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY_BASE64`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). tote 에 맞게 바꾸는 것:
  - 작업 디렉터리는 루트(`working-directory: app` 없음), `BUNDLE: src-tauri/target/universal-apple-darwin/release/bundle`, 앱 `$BUNDLE/macos/tote.app`, DMG `$BUNDLE/dmg/tote_${VERSION}_universal.dmg`, 업데이트 묶음 `$BUNDLE/macos/tote.app.tar.gz`, 실행 파일 `Contents/MacOS/tote`.
  - Rust: `dtolnay/rust-toolchain` 을 쓰지 않는다. `jdx/mise-action` 뒤 `rustup target add --toolchain "$(mise current rust)" aarch64-apple-darwin x86_64-apple-darwin`(계획자 판단 13). `Swatinem/rust-cache` 의 `workspaces: src-tauri -> target`.
  - 「산출물 찾기」 는 두 모드 모두에서 **검사로** 한다(설계 「제약」 의 완료 조건): `lipo -archs` 결과에 `arm64` 와 `x86_64` 가 둘 다 없으면 실패, `CFBundleShortVersionString` 이 `$VERSION` 이 아니면 실패, `CFBundleIdentifier` 가 `com.develma.totenotes` 가 아니면 실패.
  - 릴리스 파일 이름(계획자 판단 14), 릴리스 제목 `tote $VERSION`, 수동 실행 산출물 이름 `tote-${VERSION}-universal-unsigned`.
  - 맨 위 주석에 순서와 「어느 단계든 실패하면 공개까지 가지 않는다」, 가이드 경로 `docs/guides/release-macos.md`.
  - 액션 판본은 keyring-notes 가 실제 릴리스에 쓴 것과 같게 둔다(`actions/checkout@v7`, `jdx/mise-action@v5`, `Swatinem/rust-cache@v2`, `actions/upload-artifact@v7`).

- [ ] **Step 1: 정적 검사.** `mise exec actionlint@latest shellcheck@latest -- actionlint .github/workflows/release-macos.yml` 이 아무것도 찍지 않는다(쓴 판본을 보고에 적는다. `mise.toml` 은 바꾸지 않는다).
- [ ] **Step 2: 비밀 노출 검사(손으로, 보고에 표로).** 비밀 일곱 각각이 어느 단계의 `env` 에 들어가는지, `run:` 에 `${{ secrets.` 가 직접 들어간 곳이 없는지(`grep -n 'secrets\.' .github/workflows/release-macos.yml` 의 줄이 전부 `env:` 블록 안), `set -x`·`echo "$TAURI_`·`echo "$APPLE_` 가 없는지.
- [ ] **Step 3: 로컬로 재현할 수 있는 단계를 돌린다.**
  - 버전 단계: `pnpm -s version:check`, `pnpm -s version:check v0.1.0` 통과, `v0.1.1` 실패.
  - 「산출물 찾기」 의 셸 조각을 Task 2 의 빌드 결과에 그대로 돌려 통과.
  - 업데이트 묶음: 임시 키(`pnpm tauri signer generate --ci -p test -w "$S/k"`)로 `TAURI_SIGNING_PRIVATE_KEY="$(cat "$S/k")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test pnpm build:mac --config '{"bundle":{"createUpdaterArtifacts":true}}' --config "{\"plugins\":{\"updater\":{\"pubkey\":\"$(cat "$S/k.pub")\"}}}"` → `tote.app.tar.gz`·`.sig` 가 생기고, 「업데이트 묶음 검사」 의 `verify-updater-sig` 를 `--pubkey "$(cat "$S/k.pub")" --version 0.1.0` 으로 통과, 다른 임시 키의 공개 키로는 실패. 「릴리스 파일 준비」 조각으로 `latest.json` 을 만들어 내용을 보고에 적는다. 임시 키는 `$S`(스크래치) 밖에 두지 않고 끝나면 지운다.
- [ ] **Step 4: 커밋** `build: release tote for macOS from a v* tag`
  ```bash
  git add .github/workflows/release-macos.yml
  ```
  워커는 푸시하지 않는다. 수동 실행은 병합 뒤 코디네이터가 한다(아래 「코디네이터가 할 일」).

### Task 9: hardened runtime·서명 아래 동작 확인과 entitlements

**Files:**

- Modify(필요할 때만): `src-tauri/tauri.conf.json`(`bundle.macOS.entitlements`), `src-tauri/Entitlements.plist`(새로), `scripts/release-config.test.ts`
- Report: 워커 보고에 「hardened runtime 확인」 절

**Interfaces:**

- Consumes: Task 2~6 이 다 들어간 트리.
- Produces: entitlements 결정(계획자 판단 15)과 그 근거 — 무엇을 돌려 무엇이 됐는가.

- [ ] **Step 1: 임시 서명 번들.** `S=<스크래치>`. 사람의 앱과 섞이지 않게 별도 식별자로 만든다:
  ```bash
  pnpm tauri build --bundles app --config src-tauri/tauri.dev.conf.json \
    --config '{"identifier":"com.develma.totenotes.hrtest","productName":"tote-hrtest","bundle":{"macOS":{"signingIdentity":"-"}}}' \
    -- --profile perf
  ```
  `signingIdentity: "-"` 는 번들러의 임시 서명이다(Tauri 문서 `distribute/sign/macos` 「Ad-Hoc Signing」). `codesign -dv --verbose=4 <번들>` 의 `flags=` 에 `adhoc` 와 `runtime` 이 둘 다 있어야 한다. `runtime` 이 없으면 `codesign --force --deep --sign - --options runtime <번들>` 로 다시 서명하고 그 사실을 보고에 적는다. `codesign --verify --deep --strict` 통과. 비교용으로 같은 빌드를 서명 없이 한 벌 더 둔다.
- [ ] **Step 2: 실행과 셸 명령(화면 없이).** `open --env TOTE_DATA_DIR="$S/data" --env TOTE_BACKGROUND=1 --stderr "$S/app.log" <번들>` → 10초 뒤 프로세스가 살아 있다(`pgrep -f 'tote-hrtest.app/Contents/MacOS/tote'`). `ln -s <번들>/Contents/Resources/bin/tote "$S/bin/tote"` 뒤 `TOTE_DATA_DIR="$S/data" "$S/bin/tote" "$S/sample.txt"` → 몇 초 안에 `grep -rl "$S/sample.txt" "$S/data"` 가 세션 파일을 찾는다(요청이 단일 인스턴스로 넘어가 탭이 열렸다는 증거). `app.log` 에 `tote:` 오류 줄이 없다. 끝나면 그 pid 만 끝내고(`kill <pid>`, 이름으로 죽이지 않는다), `development.md` 의 기준 파일로 `~/Tote-dev`·`tote-dev` 폴더가 새로 생기지 않았는지 본다.
- [ ] **Step 3: 화면 확인 후보로 적는다**(이 단계는 돌리지 않는다). 임시 서명 번들과 서명 없는 번들 각각에서 같은 결과여야 한다:
  1. 코드 메모(`.ts`)를 열어 하이라이트가 보인다 — 번들 확장 `tote.languages`(`tote-ext:`) + 오니구루마 WASM(`'wasm-unsafe-eval'`).
  2. 그림이 든 마크다운 미리보기에서 그림이 보이고, 동영상 파일이 재생·되감기 된다 — `tote-file:`(Range 응답).
  3. 번들 뷰어 확장으로 여는 파일이 뷰어로 열린다(`frame-src tote-ext:`).
  4. 메뉴 「셸 명령 설치…」 → `~/.local/bin/tote` 또는 `/usr/local/bin/tote` 링크가 생긴다(사람의 기존 링크가 있으면 하지 않는다 — `is_tote_link` 는 같은 번들 이름만 넘겨받으므로 `tote-hrtest.app` 은 사람의 `tote.app` 링크를 건드리지 않지만, 확인은 사람에게 알린 뒤 한다).
     각 후보에 띄우는 명령(위 `open` 에서 `TOTE_BACKGROUND` 를 뺀 것)과 성공 판정을 함께 적는다.
- [ ] **Step 4: entitlements 결정.** Step 2 가 통과하고 Step 1 의 서명 검사가 깨끗하면 entitlements 없음으로 두고, `scripts/release-config.test.ts` 에 `bundle.macOS.entitlements` 가 없다는 단언과 그 까닭 주석(이 태스크의 실측)을 더한다. 막힌 것이 있으면 막힌 동작·오류(`log show --last 5m --predicate 'process == "tote"'` 의 거절 줄)를 적고 그것을 푸는 entitlement **하나**만 `src-tauri/Entitlements.plist` 에 넣고 Step 1~2 를 다시 돈다.
- [ ] **Step 5: 남는 위험을 적는다.** 응용 프로그램 폴더에 쓸 권한이 없는 사용자는 업데이터가 관리자 권한 AppleScript(`do shell script … with administrator privileges`)로 설치한다(`updater.rs` macOS `install_inner` 의 `need_authorization`). 이것이 hardened runtime 아래에서 도는지는 비밀번호 입력이 필요해 사람 확인 후보다.
- [ ] **Step 6: 커밋**(바꾼 것이 있을 때만) `build: entitlements tote needs under the hardened runtime` 또는 `test: pin no entitlements for the hardened runtime`
  ```bash
  git add scripts/release-config.test.ts   # 그리고 바꿨다면 src-tauri/tauri.conf.json src-tauri/Entitlements.plist
  ```

### Task 10: 로컬 업데이트 흐름 시험

**Files:**

- Create: `scripts/update-local-test.sh`
- Modify: `docs/guides/development.md`(새 절 「업데이트 흐름은 로컬 서버로 시험한다」: 스크립트 이름·무엇을 만드는지·화면 단계는 사람이나 화면 워커가 한다는 것)

**Interfaces:**

- Consumes: Task 3~7.
- Produces: `bash scripts/update-local-test.sh <작업 폴더>` — 아래를 하고 마지막에 화면 단계용 명령을 찍는다. 사람의 앱과 섞이지 않게 계획자 판단 16 의 식별자를 쓴다. 시작 전에 `lsof -U` 로 `/tmp/com_develma_totenotes_updatetest.*_si\.sock` 를 쥔 프로세스가 있으면 멈춘다(`measure-perf.sh` 의 `socket_owners` 와 같은 방식).
  1. 임시 업데이트 키(`pnpm tauri signer generate --ci -p update-test -w "$W/key"`).
  2. 시험 설정 `$W/update-test.conf.json`: `identifier` `com.develma.totenotes.updatetest`, `productName` `tote-updatetest`, `plugins.updater` = `{ pubkey: <key.pub>, endpoints: ["http://127.0.0.1:$PORT/latest.json"], dangerousInsecureTransportProtocol: true, requireSignedVersion: true }`. 포트 기본 `18765`(`PORT` 로 바꿀 수 있다).
  3. 옛 판: `--config src-tauri/tauri.dev.conf.json --config "$W/update-test.conf.json" --config '{"version":"0.0.1"}'`, `--bundles app -- --profile perf` → `$W/Applications/tote-updatetest.app` 로 복사.
  4. 새 판(지금 버전): 같은 설정 + `{"bundle":{"createUpdaterArtifacts":true}}`, `TAURI_SIGNING_PRIVATE_KEY`·`…_PASSWORD` 를 그 명령에만 준다 → `tote-updatetest.app.tar.gz`·`.sig` 를 `$W/serve/` 로. `node scripts/verify-updater-sig.ts … --pubkey "$(cat "$W/key.pub")" --version <지금 버전>` 통과.
  5. `node scripts/updater-json.ts --version <지금 버전> --url "http://127.0.0.1:$PORT/tote-updatetest.app.tar.gz" --sig … --allow-local-http --out "$W/serve/latest.json"`.
  6. `python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$W/serve" 2>"$W/server.log" &` — pid 를 `$W/server.pid` 에.
  7. `ln -s "$W/Applications/tote-updatetest.app/Contents/Resources/bin/tote" "$W/bin/tote"`.
  8. 찍는 것: 화면 단계의 실행 명령 `open --env TOTE_DATA_DIR="$W/data" --env TOTE_UPDATE_CHECK=1 "$W/Applications/tote-updatetest.app"`, 정리 명령(서버 pid 끝내기, `$W` 지우기).

- [ ] **Step 1:** `bash -n`, 그리고 스크립트를 실제로 돌려 1~7 이 끝나는 것을 본다(빌드 두 번 — 시간을 보고에 적는다).
- [ ] **Step 2: 화면 없이 볼 수 있는 것을 본다.**
  - **켜져 있으면 요청이 한 번 나간다:** `open --env TOTE_DATA_DIR="$W/data" --env TOTE_UPDATE_CHECK=1 --env TOTE_BACKGROUND=1 <옛 판>` → 20초 안에 `server.log` 에 `GET /latest.json` 이 정확히 한 줄.
  - **끄면 요청이 없다(설계 「실패로 보는 것」):** 앱을 끝내고 `$W/data` 의 settings.json 에 `"updates": {"autoCheck": false}` 를 넣어 다시 띄운다 → 30초 동안 `server.log` 에 새 `GET` 이 없다.
  - 앱은 그 pid 로만 끝낸다. 띄우기 전후 `development.md` 의 기준 파일 판정.
- [ ] **Step 3: 화면 확인 후보로 적는다**(돌리지 않는다). 각 항목에 실행 명령·누를 것·성공 판정:
  1. 창 둘을 연 옛 판에서 5초쯤 뒤 **한 창에만** 「새 버전 tote <지금 버전> 이 있습니다…」.
  2. 메모에 글을 치자마자 「업데이트하고 다시 시작」 → 진행 문구 → 앱이 다시 뜬다. 판정: `plutil -extract CFBundleShortVersionString raw "$W/Applications/tote-updatetest.app/Contents/Info.plist"` 이 지금 버전, 앱 pid 가 바뀌었다, 친 글이 `$W/data` 아래 메모 파일에 있다, 다시 뜬 앱도 `$W/data` 를 쓴다(`~/Tote-dev` 등이 새로 생기지 않았다).
  3. 저장이 실패하는 상태(메모 파일이 든 폴더를 `chmod a-w`)에서 「업데이트하고 다시 시작」 → 「저장하지 못한 메모가 있습니다」 의 「그래도 다시 시작」/「취소」. 「취소」 → 대화상자가 「업데이트는 설치됐습니다…」 와 「다시 시작」 을 보인다, 앱은 그대로 돈다. (질문 창은 `UserNotificationCenter` 의 것일 수 있다 — `development.md` 의 그 절.)
  4. 업데이트 뒤 `"$W/bin/tote" <파일>` 이 새 판 앱에 탭을 연다(링크가 계속 맞다).
  5. 메뉴 「tote → 업데이트 확인…」 이 새 판에서 「tote <지금 버전> 이 최신 버전입니다.」.
- [ ] **Step 4:** fmt(셸은 포매터 밖), 커밋 `test: try the update flow against a local server`
  ```bash
  git add scripts/update-local-test.sh docs/guides/development.md
  ```

### Task 11: 릴리스 가이드

**Files:**

- Create: `docs/guides/release-macos.md`

**Interfaces:**

- Consumes: 워크플로 단계 이름(Task 8), 스크립트 이름(Task 1·7), 설정 자리(Task 2·4), Task 9 의 entitlements 결정.
- Produces: keyring-notes `docs/guides/release-macos.md` 를 tote 에 맞게 옮긴 가이드. 절과 꼭 들어갈 것:
  1. **머리말과 표**(한 번만 / 릴리스마다), 비밀 파일은 저장소 밖 `~/tote-release/`(`chmod 700`).
  2. **Apple 자격 — keyring-notes 것을 다시 쓴다(먼저 이 길).** 같은 개발자 계정의 Developer ID 인증서와 App Store Connect API 키를 tote-notes 저장소 비밀로 한 번 더 넣는다. GitHub 비밀은 다시 읽을 수 없으므로 원본에서 다시 만든다: `.p12` 가 보관돼 있으면 그것을 한 줄 base64 로(`openssl base64 -A -in …`), 없으면 그 인증서가 있는 맥의 키체인 「내 인증서」 에서 다시 내보낸다. `.p8` 은 한 번만 받을 수 있다 — 보관본이 없으면 키를 새로 만든다(이름 `tote-notes-notary`, 액세스 Developer — 여러 키를 둬도 된다). `xcrun notarytool history …` 로 자격을 맞춰 본다.
  3. **처음부터 만드는 길**(keyring-notes 가이드의 인증서·API 키 절을 그대로 옮기되 이름만 tote 로).
  4. **업데이트 서명 키 — tote 전용으로 새로 만든다.** keyring-notes 의 키를 쓰지 않는 까닭(한 키를 잃으면 두 앱이 함께 업데이트를 잃는다). `pnpm tauri signer generate -w ~/tote-release/tote-notes-updater.key`(비밀번호 필수). ⚠ 경고 상자: 이 키나 비밀번호를 잃으면 이미 설치된 모든 tote 가 다시는 업데이트를 받지 못하고, 사람들이 새 DMG 를 직접 받아야 한다. 첫 릴리스 뒤에는 키를 새로 만들지 않는다. 보관: 비밀번호 관리자 항목(키 파일 내용 + 비밀번호)과 암호화한 오프라인 사본 둘 다, 저장소·일반 클라우드 폴더·메신저 금지. 공개 키를 `src-tauri/tauri.conf.json` `plugins.updater.pubkey` 에 넣어 커밋(자리 표시 값이 남아 있거나 짝이 안 맞으면 워크플로가 실패한다).
  5. **GitHub 비밀 등록** — 일곱 이름의 표, 명령마다 `-R jang2162/tote-notes`(예: `gh secret set APPLE_CERTIFICATE -R jang2162/tote-notes < DeveloperID.p12.base64.txt`), 값은 한 줄.
  6. **버전 올리고 태그** — `pnpm version:set <버전>` → `pnpm version:check` → `git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock` → 커밋·푸시 → `git tag v<버전>` → `git push origin v<버전>`. 첫 릴리스는 `v0.1.0`.
  7. **결과 확인** — 릴리스의 파일 넷과 「Latest」, 다른 맥(계정)에서 받은 DMG 를 열어 경고 없이 실행, `spctl --assess --type open --context context:primary-signature -v <dmg>` 가 `source=Notarized Developer ID`, 옛 버전에서 몇 초 뒤 질문, 메뉴 「tote → 업데이트 확인…」.
  8. **비밀 없이 흐름만 시험하기** — Actions 수동 실행(산출물 `tote-<버전>-universal-unsigned`), 로컬 `pnpm build:mac`(`CI=true` 라 Finder 꾸미기를 건너뛴다), 업데이트 흐름은 `scripts/update-local-test.sh`(`development.md` 그 절).
  9. **실패했을 때** 표 — keyring-notes 의 행을 tote 이름으로 옮기고 더한다: 「산출물 찾기 / 유니버설이 아니다·버전이 다르다」, 「업데이트하지 못했습니다: … Read-only file system」(DMG 안이나 다운로드 폴더에서 실행 — 앱을 응용 프로그램 폴더로 옮겨 실행), 「업데이트 확인이 아무 말이 없다」(설정 「실행할 때 업데이트 확인」 이 꺼졌거나 릴리스에 `latest.json` 이 없다 — 드래프트는 `releases/latest` 가 아니다).
  10. **바꾸면 안 되는 것** — 식별자 `com.develma.totenotes`(바꾸면 업데이트가 다른 앱으로 보이고, macOS 가 식별자에 준 폴더 접근 허락·WebKit 캐시·환경 설정이 이어지지 않는다), 업데이트 서명 키, 릴리스 파일 이름 모양과 `latest.json` 주소(저장소 이름·소유자를 바꾸면 옛 앱은 옛 주소를 계속 본다), `productName` `tote`.
  11. **참고** — Tauri 서명·업데이터 문서, Apple Developer ID·공증 문서 링크.
  - 문서는 지금을 말한다(`docs/guideline/base/04-citation.md` 「문서는 지금을 말한다」): 날짜·커밋 해시·「keyring-notes 에서 이렇게 막혔다」 이력을 쓰지 않는다. 다른 문서는 절 제목으로 가리킨다.

- [ ] **Step 1:** 가이드를 쓴다.
- [ ] **Step 2: 맞춰 본다** — 가이드에 적힌 단계 이름이 `.github/workflows/release-macos.yml` 의 `name:` 과 하나하나 같은지, 비밀 이름 일곱이 워크플로와 같은지, 명령에 나온 스크립트·파일 경로가 다 있는지(`grep` 두 방법으로 세어 보고에 수와 함께), `-R jang2162/tote-notes` 가 모든 `gh secret set` 에 붙었는지.
- [ ] **Step 3: 커밋** `docs: how to release tote for macOS`
  ```bash
  git add docs/guides/release-macos.md
  ```

---

## 리뷰 묶음

| 묶음 | 태스크  | 리뷰어가 특히 볼 것                                                               |
| ---- | ------- | --------------------------------------------------------------------------------- |
| A    | 1, 2    | 버전 자리 넷의 정규식, 옛 식별자가 남은 곳, 유니버설 빌드 결과                    |
| B    | 3       | 재시작이 종료와 같은 창을 기다리는지, `request_restart` 인지, 취소·시간 제한 갈래 |
| C    | 4, 5, 6 | 꺼짐이면 요청 0, 한 창에만 질문, 설치는 동의 뒤, 화면 문구                        |
| D    | 7, 8    | 비밀 노출, 공개 전 검사, actionlint                                               |
| E    | 9, 10   | 임시 서명 결과, 로컬 업데이트 요청 기록, 화면 확인 후보 목록                      |
| F    | 11      | 가이드와 워크플로·스크립트의 이름 일치, 키 보관 경고                              |

## 코디네이터가 할 일

- 화면 확인 후보(Task 9 Step 3, Task 10 Step 3)를 별도 화면 워커로 돌린다. 관리자 비밀번호가 드는 것(Task 9 Step 5)은 사람에게 넘긴다.
- 병합 때 AGENTS 색인 소스(`.ruler/90-reference.md` 의 표)에 두 줄을 더하고 `pnpm exec ruler apply` → `git status` 로 추적 파일 변경이 그 소스뿐인지 본다:
  - 「macOS 앱을 릴리스하거나 릴리스 워크플로·업데이트 키·서명 비밀을 다룰 때 | `docs/guides/release-macos.md`」
  - 「tote-notes macOS 배포 계획을 실행할 때 | `docs/superpowers/plans/2026-10-25-tote-notes-mac-distribution.md`」
- **마지막 완료 조건(설계 「제약」).** 병합 뒤 로컬 `main` 을 `origin/main` 에 푸시하고(`git push origin main`), `gh workflow run release-macos.yml -R jang2162/tote-notes --ref main` 로 수동 실행한다. 다음이 모두 참이면 끝이다:
  - 실행이 성공했다(`gh run watch` 또는 `gh run view --exit-status`), 「버전 확인」 단계가 통과했다.
  - 산출물 `tote-0.1.0-universal-unsigned` 를 받아(`gh run download`) DMG 를 붙이면(`hdiutil attach -nobrowse -readonly`) 그 안 `tote.app/Contents/MacOS/tote` 의 `lipo -archs` 가 `x86_64 arm64`, `CFBundleShortVersionString` 이 루트 `package.json` 의 버전과 같다. 붙인 DMG 는 `hdiutil detach` 한다.
  - 실패하면 고쳐서 다시 병합·푸시하고 다시 돌린다. 검증용 임시 트리거·브랜치는 만들지 않는다.
- 태그 푸시·비밀 등록·첫 릴리스는 사람의 일이다(가이드).
