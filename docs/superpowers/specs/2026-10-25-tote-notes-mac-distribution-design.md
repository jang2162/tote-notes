# tote-notes macOS 앱 배포 — 설계

2026-10-25. 사용자 요청: 「keyring-notes 참고해서 GitHub 에 macOS 앱 배포할 수 있도록」. 업데이트 방식도 「keyring-notes 처럼」 이라고 했다. 아래 「정한 것 (사용자)」 말고는 **설계자 판단**으로 표시한다. 사용자는 설계 요약을 보고 「빠진 거 없어」 라고 했고, 검증용 푸시는 (a) 「병합 뒤 main 을 푸시하고 수동 실행까지 확인」 을 골랐다.

## 왜

tote 는 지금 개발자의 맥에서 디버그 번들로만 돈다. 서명·공증·배포 경로·앱 안 업데이트가 모두 없다. 처음 보는 사람도 내려받아 경고 없이 설치하고, 이후 새 버전은 앱 안에서 받게 하려 한다.

같은 사용자의 다른 앱 keyring-notes(`/Users/jang2162/IdeaProjects/keyring-notes`)가 이 흐름을 이미 갖고 있고 실제 릴리스까지 돌았다. **그 구성을 본으로 삼는다.** 읽을 것:

- `.github/workflows/release-macos.yml` — 태그 → 빌드·서명·공증 → 검사 → 드래프트 → 공개
- `docs/guides/release-macos.md` — 사람이 할 일(인증서·API 키·업데이트 키·비밀 등록·버전·태그)과 실패 표
- `scripts/version.mjs`, `scripts/updater-json.mjs`, `scripts/verify-updater-sig.mjs`
- `web/src/update.tsx` — 앱 안 업데이트 확인 화면
- `docs/superpowers/specs/2026-10-18-mac-distribution-design.md` — 그 앱의 설계(「실패로 보는 것」 은 여기에도 그대로 적용한다)

## 정한 것 (사용자)

- **keyring-notes 와 같은 방식이다.** `v*` 태그를 올리면 GitHub Actions 가 유니버설(Apple Silicon + Intel) 앱을 빌드하고, Developer ID 로 서명(hardened runtime)하고, Apple 공증·스테이플을 받은 DMG 를 GitHub 릴리스에 올린다. 사람이 맥에서 손으로 빌드하지 않는다.
- **앱 안 업데이트도 keyring-notes 처럼.** 설치된 앱이 실행 때 새 버전을 찾고, 「업데이트할까요?」 에 승낙하면 받아서 바꾸고 다시 시작한다. 업데이트 파일은 업데이트 서명 키로 검증한다.
- **실행 때 찾은 새 버전은 대화상자로 묻지 않고 창 좌측 하단의 버튼으로 알린다.** 버튼은 모든 창에 보이고 나중에 여는 창에도 보인다. 누르면 「업데이트할까요?」 대화상자가 열린다. 메뉴 「업데이트 확인…」 으로 찾은 것은 그 창에 대화상자를 곧바로 연다.
- **「업데이트 자동 확인」 을 끌 수 있다**(기본 켜짐). tote 는 밖으로 요청을 보내지 않는 로컬 앱인데 업데이트 확인이 실행마다 github.com 에 요청을 보내게 되기 때문이다. 끄면 실행 때 확인하지 않는다.
- **저장소 `jang2162/tote-notes` 는 공개다.** 설치된 앱이 로그인 없이 `releases/latest/download/latest.json` 을 읽어야 하므로 공개로 바꿨다(완료). 릴리스도 이 저장소에 올린다.
- **워크플로가 병합되면 로컬 `main` 을 `origin/main` 에 푸시하고, 서명 없는 수동 실행(`workflow_dispatch`)이 실제로 도는 것까지 확인한다.** GitHub 는 기본 브랜치에 있는 워크플로만 수동 실행할 수 있고, 릴리스 태그를 붙이려면 어차피 이 커밋들이 원격에 있어야 한다. 푸시는 병합을 하는 쪽(메인 세션)이 한다. 태그 푸시는 여전히 사람의 일이다.

## 설계자 판단 (사용자에게 말했고 이의 없음)

- **Apple 자격은 keyring-notes 것을 다시 쓴다.** 같은 개발자 계정이므로 Developer ID 인증서(.p12)와 공증용 App Store Connect API 키를 tote-notes 저장소의 GitHub 비밀로 한 번 더 등록하면 된다. 비밀 이름은 keyring-notes 와 같게 둔다(가이드를 그대로 옮겨 쓸 수 있다).
- **업데이트 서명 키는 tote 전용으로 새로 만든다.** 한 키가 새거나 잃으면 두 앱이 함께 업데이트를 잃기 때문이다.
- **앱 식별자를 `dev.tote.note` 에서 `com.develma.totenotes` 로 바꾼다.** 첫 배포 뒤에는 바꿀 수 없으므로(업데이트가 다른 앱으로 보인다) 지금 keyring-notes(`com.develma.keyringnotes`)와 맞춘다. 개발용 식별자(`src-tauri/tauri.dev.conf.json` 의 `dev.tote.note.dev`)도 같은 꼴(`com.develma.totenotes.dev`)로 맞춘다 — 둘이 다르게 남아야 디버그 앱과 설치본이 서로를 단일 인스턴스로 잡지 않는다(`src-tauri/src/lib.rs` 의 단일 인스턴스 주석).
  - 메모 데이터·settings.json·machine.json 은 식별자와 무관한 `dirs::data_dir()/tote`(`src-tauri/src/appdata.rs`)에 있어 옮겨지지 않는다. 앱은 실서비스에서 WebView 저장소(localStorage)를 쓰지 않는다(`src/backend/fake*.ts` 만 쓴다). 빌더는 식별자에 묶인 다른 상태가 없는지 확인한다.
- **첫 릴리스는 `v0.1.0`**(지금 `tauri.conf.json`·`Cargo.toml` 의 버전). 앱 이름(`productName`)은 지금처럼 `tote`. (2026-10-26 에 `Tote Notes` 로 바꿨다. 실행 파일 이름은 `mainBinaryName` 으로 `tote` 에 고정 — `docs/guides/release-macos.md` 「바꾸면 안 되는 것」.)
- **설치 파일은 DMG, 빌드는 유니버설.** 지금 `bundle.targets` 는 `["app"]` 뿐이라 DMG 를 만들지 않는다.
- **공증까지 성공하면 릴리스를 바로 공개한다.** keyring-notes 처럼 드래프트로 전부 올리고, 올라간 목록을 확인한 뒤에만 공개한다. 공개되는 릴리스에는 항상 `latest.json` 이 있어야 한다(없는 릴리스가 `releases/latest` 가 되면 업데이트가 조용히 멈춘다).

## 목표

1. `v*` 태그 푸시 → macOS 러너에서 유니버설 `.app`·`.dmg` 빌드 → Developer ID 서명(hardened runtime) → 앱·DMG 공증·스테이플 → GitHub 릴리스에 DMG 와 업데이트 파일(`.app.tar.gz`, `.sig`, `latest.json`)을 올리고 공개한다.
2. 받은 DMG 를 처음 보는 맥에서 열어도 Gatekeeper 경고 없이 설치·실행된다. 설치본에서도 앱의 기능(파일 열기·저장, 확장, `tote` 셸 명령 설치, 메뉴 단축키)이 디버그 번들과 똑같이 돈다.
3. 설치된 앱이 실행 때 새 릴리스를 찾아 버튼으로 알리고, 버튼을 눌러 승낙하면 받아 설치하고 다시 시작한다. 사용자가 수동으로 「업데이트 확인」 을 할 길도 있다.
4. 사람이 할 일을 처음부터 끝까지 따라 할 수 있는 가이드 `docs/guides/release-macos.md` 를 둔다. keyring-notes 가이드에서 tote 에 맞게 옮기되, 이미 keyring-notes 용으로 만든 인증서·API 키를 다시 쓰는 길을 먼저 적는다.
5. 수동 실행(`workflow_dispatch`)은 비밀 없이 서명 안 된 유니버설 DMG 를 산출물로 올린다 — 비밀을 등록하기 전에 흐름을 시험하는 길이다.

## 하지 않는 것

- Mac App Store, Windows·Linux, 베타·채널 분리, 자체 업데이트 서버.
- 앱 기능 변경. 배포에 필요한 것(업데이트 확인 UI·메뉴, 「업데이트 자동 확인」 설정, 식별자, 버전 맞추기, 번들 설정) 말고는 손대지 않는다.
- LICENSE 추가. 사용자가 정하지 않았다(공개 저장소지만 지금은 저작권 전부 보유).
- 비밀 등록·태그 푸시·첫 릴리스 실행. 사람이 한다(가이드). 빌더는 수동 실행으로 서명 없는 흐름까지만 검증한다.
- 검증용 임시 트리거나 검증용 브랜치 푸시. 수동 실행은 기본 브랜치에 올린 워크플로로 한다(「정한 것」 의 푸시).

## 실패로 보는 것 (기술적으로 돌아가도)

- 비밀 값(인증서·키·비밀번호)이 저장소·로그·릴리스 산출물에 한 번이라도 남는다.
- 업데이트 서명 키를 잃으면 기존 사용자가 업데이트를 못 받는다는 사실과 보관 방법이 가이드에 없다.
- 공증되지 않은 빌드가 공개 릴리스에 올라간다(서명·공증·스테이플 실패가 릴리스 실패로 이어지지 않음).
- 업데이트 확인이 사용자 동의 없이 설치를 시작한다.
- **업데이트 뒤 다시 시작하면서 저장하지 않은 메모를 잃는다.** tote 는 창을 닫을 때 열린 메모부터 저장하는 흐름이 있다(칸·창 설계). 업데이트 재시작은 그 흐름을 거치거나, 저장되지 않은 것이 있으면 재시작 전에 사용자에게 맡긴다. `app.restart()` 로 그 흐름을 건너뛰면 실패다.
- 「업데이트 자동 확인」 을 끈 사용자의 앱이 실행 때 github.com 에 요청을 보낸다.
- 설치본에서 `tote` 셸 명령·확장·`tote-file:`/`tote-ext:` 프로토콜 중 하나라도 디버그 번들과 다르게 동작한다(hardened runtime 아래에서 막히는 것 포함).

## 제약

- 패키지 매니저는 pnpm, 런타임은 mise(`mise.toml`). CI 도 같은 버전을 쓴다(keyring-notes 처럼 `jdx/mise-action`).
- 버전이 적힌 곳: 루트 `package.json`(지금 `0.0.0`), `src-tauri/tauri.conf.json`·`src-tauri/Cargo.toml`·`src-tauri/Cargo.lock`(지금 `0.1.0`). 하나의 원천에서 맞추고, 태그와 다르면 CI 가 실패한다. 화면에 버전을 보이는 곳이 생기면 그것도 같은 원천을 따른다.
- 번들 리소스: `src-tauri/resources/tote`(셸 스크립트 — Mach-O 가 아니다)와 `src-tauri/resources/extensions/`(번들 확장). 둘이 서명된 번들 안에서도 그대로 동작해야 한다. 스크립트가 심볼릭 링크로 설치된 뒤 업데이트로 앱이 바뀌어도 링크가 계속 맞는지 본다.
- 업데이트 확인 요청은 Rust 쪽(`tauri-plugin-updater`)에서 나간다. WebView 의 CSP(`connect-src` 는 ipc·`tote-file:` 만)를 github.com 에 열지 않는다.
- `bundle.macOS.minimumSystemVersion` 은 `13.0` 으로 정해져 있다(바꾸지 않는다).
- 창은 여럿일 수 있다(`app.windows` 가 비어 있고 코드가 만든다). 업데이트 버튼은 사이드바 맨 아래 줄, 늘 있는 설정 버튼의 오른쪽에 그 줄의 남은 폭을 채워 모든 창이 띄운다(설정 버튼은 `docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md` 「3. 설정 화면」) — 찾은 뒤에 연 창도, 워크스페이스를 바꿔 페이지가 다시 뜬 창도. 대화상자가 저절로 뜨는 것은 메뉴의 확인으로 찾았을 때뿐이고, 그 확인을 고른 창 하나에만 뜬다(`AppCore::found_update`).
- 버튼은 누를 때의 상태(받을 수 있음 / 다른 창에서 받는 중 / 이번 실행에서 설치됨)로 대화상자를 연다(`current_update`). 버튼이 뜰 때의 상태로 열면 다른 창이 받는 중인 업데이트를 또 받으려 하고, 설치된 것을 다시 묻는다. 「나중에」 를 눌러도 버튼은 남는다 — 대화상자를 다시 여는 길이다.
- 화면 글·메뉴 이름은 이 앱의 기존 관례(한국어, 설정 화면 구역 구조 — `docs/superpowers/specs/2026-10-20-tote-notes-settings-and-shortcuts-design.md`)를 따른다. 새 메뉴 항목이 생기면 단축키 설정 목록과의 관계(바꿀 수 있는가, 고정인가)도 그 설계에 맞춘다.
- 저장소에 `.github/` 가 없다. GitHub 저장소는 공개이고 릴리스·태그는 0개다. 로컬 `main` 은 `origin/main` 보다 앞서 있다 — 워크플로 병합 뒤 푸시한다(「정한 것」).
- 계획의 완료 조건에 「푸시 뒤 수동 실행이 성공하고, 산출물 DMG 의 앱이 유니버설(`lipo`)이며 버전 검사를 통과한다」 를 넣는다. 수동 실행이 실패하면 고쳐서 다시 푸시한다.
- 테스트·디버그 앱 띄우기·워크트리 훅은 `docs/guides/development.md` 를 따른다.

## 빌더에게 맡기는 것

- keyring-notes 구성에서 그대로 가져올 것과 tote 에 맞게 바꿀 것(경로 `app/` → 루트, 산출물 이름, 버전 자리 등). 가져온 스크립트는 tote 저장소의 관례(oxfmt·oxlint, 시험)를 따른다.
- 업데이트 확인 UI 의 모양(기존 대화상자 재사용 권장)과 수동 「업데이트 확인…」 의 자리(macOS 관례상 앱 메뉴).
- 「업데이트 자동 확인」 설정의 자리(설정 화면의 어느 구역)와 저장 위치(settings.json 의 키).
- 업데이트 재시작이 저장 흐름을 거치게 하는 방법.
- 필요한 entitlements(최소로). 번들 확장·셸 스크립트가 서명·hardened runtime 아래에서 도는지 확인하는 방법.
- 서명·공증 없이 CI 흐름을 검증하는 방법과, 업데이트 흐름을 로컬에서 시험하는 방법(예: 낮은 버전 빌드 + 로컬 `latest.json`).
- 버전의 단일 원천을 어디에 둘지와 맞추는 방법(keyring-notes 는 루트 `package.json` + `version:set`/`version:check`).

## 열린 것

없음.
