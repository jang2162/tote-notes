# tote macOS 릴리스하기

tote 를 Developer ID 로 서명하고 Apple 공증을 받아 GitHub 릴리스(`jang2162/tote-notes`)로 내보내는 방법이다. **태그 하나를 올리면 나머지는 GitHub Actions(`.github/workflows/release-macos.yml`)가 한다.** 사람이 할 일은 처음 한 번의 준비와 릴리스마다의 버전·태그다.

| 한 번만                                                                 | 릴리스마다                     |
| ----------------------------------------------------------------------- | ------------------------------ |
| Apple 자격(Developer ID 인증서 `.p12`, 공증용 App Store Connect API 키) | 버전 올리기 → 커밋 → 태그 푸시 |
| tote 전용 업데이트 서명 키 → 공개 키를 커밋                             | 결과 확인                      |
| GitHub 비밀 7개 등록                                                    |                                |

> ⚠ 비밀 파일(`.p12`, `.p8`, 업데이트 키)과 비밀번호를 저장소 폴더 안에 두지 않는다. 아래 명령은 모두 저장소 밖 `~/tote-release/` 에서 한다.
>
> ```bash
> mkdir -p ~/tote-release && chmod 700 ~/tote-release && cd ~/tote-release
> ```

## Apple 자격 — keyring-notes 것을 다시 쓴다

tote 와 keyring-notes 는 같은 Apple 개발자 계정의 앱이다. **Developer ID 인증서와 App Store Connect API 키는 keyring-notes 에 쓰는 것을 그대로 쓴다.** 할 일은 그 값을 tote-notes 저장소의 GitHub 비밀로 한 번 더 넣는 것뿐이다. 비밀 이름도 keyring-notes 와 같다.

GitHub 비밀은 다시 읽을 수 없다. keyring-notes 저장소의 비밀을 옮길 수는 없으니 **원본 파일에서 다시 만든다.**

1. **Developer ID 인증서(`.p12`)**
   - `.p12` 보관본이 있으면 그것을 쓴다. 내보내기 비밀번호가 `APPLE_CERTIFICATE_PASSWORD` 다.
   - 없으면 그 인증서가 든 맥에서 다시 내보낸다: 키체인 접근 → 로그인 → 「내 인증서」 탭 → `Developer ID Application: …` 오른쪽 클릭 → 「내보내기」 → 형식 `.p12`, 이름 `DeveloperID.p12`, `~/tote-release/` 에 저장 → 내보내기 비밀번호를 정한다. 「내 인증서」 탭에서 내보내야 개인 키가 함께 들어간다.
   - 인증서가 키체인에 있는지는 `security find-identity -v -p codesigning` 에 `"Developer ID Application: 이름 (TEAMID1234)"` 줄이 있는지로 본다.
   - 한 줄 base64 로 바꾼다. 이 파일 내용이 `APPLE_CERTIFICATE` 다.
     ```bash
     openssl base64 -A -in DeveloperID.p12 -out DeveloperID.p12.base64.txt
     ```
2. **공증용 App Store Connect API 키(`.p8`)**
   - `AuthKey_<키ID>.p8` 보관본이 있으면 그것을 쓴다. 키 ID 가 `APPLE_API_KEY`, 키 목록 위의 Issuer ID 가 `APPLE_API_ISSUER` 다.
   - `.p8` 은 **만들 때 한 번만 받을 수 있다.** 보관본이 없으면 키를 새로 만든다(아래 「처음부터 만드는 길」 의 API 키 단계, 이름 `tote-notes-notary`, 액세스 Developer). 한 팀에 키를 여럿 둬도 된다 — keyring-notes 의 키는 그대로 둔다.
   - 한 줄 base64 로 바꾼다. 이 파일 내용이 `APPLE_API_PRIVATE_KEY_BASE64` 다.
     ```bash
     openssl base64 -A -in AuthKey_<키ID>.p8 -out AuthKey.p8.base64.txt
     ```
   - 자격이 맞는지 맥에서 먼저 본다 — 오류 없이 공증 기록 목록이 나오면 된다:
     ```bash
     xcrun notarytool history --key AuthKey_<키ID>.p8 --key-id <키ID> --issuer <Issuer ID>
     ```

## 처음부터 만드는 길

keyring-notes 의 자격을 쓸 수 없을 때(다른 계정, 인증서 폐기 등)만 한다.

### Developer ID 인증서

Apple Developer Program 의 **Account Holder** 만 만들 수 있다.

1. **인증서 요청 파일(CSR)** — 키체인 접근 → 메뉴 「키체인 접근 → 인증서 지원 → 인증 기관에서 인증서 요청」 → 이메일·이름을 넣고 「디스크에 저장됨」 → `CertificateSigningRequest.certSigningRequest` 저장.
2. **인증서 만들기** — <https://developer.apple.com/account/resources/certificates/add> → **Developer ID Application**(「Apple Development」·「Apple Distribution」 이 아니다) → 프로필 종류는 기본값(G2 Sub-CA) → CSR 올리기 → `.cer` 내려받기.
3. **설치** — `.cer` 를 두 번 눌러 로그인 키체인에 넣고 `security find-identity -v -p codesigning` 으로 확인한다.
4. **`.p12` 내보내기와 base64** — 위 「Apple 자격 — keyring-notes 것을 다시 쓴다」 의 1과 같다.

### App Store Connect API 키

Apple ID 비밀번호 대신 API 키로 공증한다(2단계 인증·앱 암호에 묶이지 않는다).

1. <https://appstoreconnect.apple.com/access/integrations/api> (사용자 및 액세스 → 통합 → App Store Connect API → **팀 키**). 처음이면 Account Holder 가 「액세스 요청」 을 한 번 한다.
2. 「API 키 생성」(+) → 이름 `tote-notes-notary`, 액세스 **Developer** → 생성.
3. 표의 **키 ID** → `APPLE_API_KEY`. 표 위의 **Issuer ID** → `APPLE_API_ISSUER`.
4. **「API 키 다운로드」** → `AuthKey_<키ID>.p8`. **한 번만 받을 수 있다** — 바로 `~/tote-release/` 로 옮긴다. 잃으면 그 키를 폐기하고 새로 만든다.
5. base64 와 자격 확인은 위 「Apple 자격 — keyring-notes 것을 다시 쓴다」 의 2와 같다.

## 업데이트 서명 키 — tote 전용으로 새로 만든다

설치된 tote 는 새 버전 파일이 이 키로 서명됐는지 확인하고 나서야 설치한다(Tauri 업데이터). **keyring-notes 의 업데이트 키를 쓰지 않는다** — 한 키가 새거나 사라지면 두 앱이 함께 업데이트를 잃는다.

> ⚠ **이 비밀 키(또는 그 비밀번호)를 잃으면, 이미 설치된 모든 tote 가 다시는 업데이트를 받지 못한다.** 새 키로 서명한 업데이트는 옛 공개 키를 가진 앱이 거절한다. 그때는 사람들이 새 DMG 를 직접 받아 다시 설치하는 수밖에 없다. 첫 릴리스 뒤에는 **키를 새로 만들지 않는다.**

1. 키 만들기(비밀번호를 묻는다 — 반드시 정한다):
   ```bash
   cd /path/to/tote-notes
   pnpm tauri signer generate -w ~/tote-release/tote-notes-updater.key
   ```
   `tote-notes-updater.key`(비밀 키, 한 줄)와 `tote-notes-updater.key.pub`(공개 키)가 생긴다.
2. **보관** — 아래 둘을 **모두** 한다. GitHub 비밀은 다시 읽을 수 없으므로 보관처가 아니다.
   - 비밀번호 관리자(1Password·Bitwarden 등)에 「tote-notes 업데이트 서명 키」 항목을 만들고 `tote-notes-updater.key` 파일 내용과 비밀번호를 함께 넣는다.
   - 오프라인 사본: 암호화한 USB·외장 디스크(디스크 유틸리티에서 「APFS(암호화)」)에 `.key`·`.key.pub` 파일을 둔다. 비밀번호는 같은 곳에 적지 않는다.
   - 저장소·클라우드 드라이브 일반 폴더·메신저·메일에 두지 않는다.
3. **공개 키를 앱에 넣고 커밋** — `src-tauri/tauri.conf.json` 의 `plugins.updater.pubkey` 를 `.pub` 파일 내용(한 줄)으로 바꾼다. 자리 표시 값은 `REPLACE_WITH_UPDATER_PUBLIC_KEY` 다. 공개 키는 비밀이 아니다. 키를 처음 만들 때만 한다.
   ```bash
   cat ~/tote-release/tote-notes-updater.key.pub   # 이 한 줄을 pubkey 값으로
   git add src-tauri/tauri.conf.json && git commit -m "build: the update signing public key" && git push
   ```
   자리 표시 값이 남아 있거나 비밀 키와 짝이 안 맞으면 릴리스 워크플로가 실패한다(짝이 안 맞는 릴리스는 기존 사용자의 업데이트를 조용히 깨기 때문이다).

## GitHub 비밀 등록

저장소 → Settings → Secrets and variables → Actions → **New repository secret**. 또는 `gh` 로 파일에서 바로 넣는다(값이 셸 기록에 남지 않는다). 값은 전부 **한 줄**이어야 한다 — 여러 줄 값은 로그 가림이 줄 단위로 어긋날 수 있다. 명령은 `~/tote-release/` 에서 돌린다.

| 이름                                 | 값                                | `gh` 로 넣기                                                                                |
| ------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`                  | `DeveloperID.p12.base64.txt` 내용 | `gh secret set APPLE_CERTIFICATE -R jang2162/tote-notes < DeveloperID.p12.base64.txt`       |
| `APPLE_CERTIFICATE_PASSWORD`         | `.p12` 내보내기 비밀번호          | `gh secret set APPLE_CERTIFICATE_PASSWORD -R jang2162/tote-notes` (입력을 묻는다)           |
| `APPLE_API_ISSUER`                   | Issuer ID                         | `gh secret set APPLE_API_ISSUER -R jang2162/tote-notes`                                     |
| `APPLE_API_KEY`                      | 키 ID                             | `gh secret set APPLE_API_KEY -R jang2162/tote-notes`                                        |
| `APPLE_API_PRIVATE_KEY_BASE64`       | `AuthKey.p8.base64.txt` 내용      | `gh secret set APPLE_API_PRIVATE_KEY_BASE64 -R jang2162/tote-notes < AuthKey.p8.base64.txt` |
| `TAURI_SIGNING_PRIVATE_KEY`          | `tote-notes-updater.key` 내용     | `gh secret set TAURI_SIGNING_PRIVATE_KEY -R jang2162/tote-notes < tote-notes-updater.key`   |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 업데이트 키의 비밀번호            | `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R jang2162/tote-notes`                   |

등록이 끝나면 `~/tote-release/` 의 `*.base64.txt` 는 지워도 된다. 원본 `.p12`·`.p8` 와 업데이트 키는 보관처에 둔다.

## 버전 올리고 릴리스하기

버전의 원천은 **루트 `package.json`** 이고, 아래 명령이 나머지 세 곳(`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`)을 맞춘다(`scripts/version.ts`). 손으로 고치지 않는다. 앱의 「tote에 관하여」 가 보이는 버전은 `tauri.conf.json` 의 것이다.

```bash
pnpm version:set <버전>       # 앞에 v 없이. 예: 0.2.0
pnpm version:check            # 네 곳이 같은지
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build: release <버전>"
git push
git tag v<버전>               # 태그는 v + 버전과 정확히 같아야 한다
git push origin v<버전>
```

첫 릴리스는 `v0.1.0` 이다(지금 버전이 `0.1.0` 이므로 `version:set` 없이 태그만 붙인다).

태그가 올라가면 Actions 의 **release-macos** 가 돈다(20~40분, 공증 대기 포함). 순서와 각 단계에서 멈추는 조건은 워크플로 파일 맨 위 주석에 있다. 성공하면 릴리스가 **바로 공개**되고 파일 넷이 붙는다: `tote_<버전>_universal.dmg`, `tote_<버전>_universal.app.tar.gz`, `tote_<버전>_universal.app.tar.gz.sig`, `latest.json`.

## 결과 확인

- 릴리스 페이지에 위 파일 넷이 있고 「Latest」 표시가 붙었는지.
- 다른 맥(또는 다른 사용자 계정)에서 DMG 를 브라우저로 받아 열고 tote 를 「응용 프로그램」 으로 끌어 실행 — **경고 없이** 열려야 한다. 터미널로도 본다:
  ```bash
  spctl --assess --type open --context context:primary-signature -v ~/Downloads/tote_<버전>_universal.dmg
  # … accepted  source=Notarized Developer ID
  ```
- 옛 버전이 설치된 맥에서 tote 를 실행하면 몇 초 뒤 「새 버전 tote <버전> 이 있습니다…」 를 묻는다. 「업데이트하고 다시 시작」 → 열린 메모를 저장하고 새 버전으로 다시 뜬다. 메뉴 「tote → 업데이트 확인…」 으로 바로 볼 수도 있다.

## 비밀 없이 흐름만 시험하기

- **Actions 수동 실행** — Actions → release-macos → **Run workflow**. 서명·공증·릴리스 없이 universal DMG 를 만들어 실행 결과의 Artifacts(`tote-<버전>-universal-unsigned`)에 올린다. 「산출물 찾기」 단계가 유니버설·버전·식별자를 검사한다. 서명이 없으므로 받은 DMG 는 Gatekeeper 가 경고한다 — 빌드가 되는지만 보는 용도다. 워크플로가 기본 브랜치(`main`)에 있어야 수동 실행할 수 있다.
- **로컬 빌드(서명 없음)**:
  ```bash
  rustup target add --toolchain "$(mise current rust)" x86_64-apple-darwin   # 한 번만
  pnpm build:mac
  # src-tauri/target/universal-apple-darwin/release/bundle/dmg/tote_<버전>_universal.dmg
  ```
  `build:mac` 은 `CI=true` 로 돌아 DMG 창 꾸미기(Finder AppleScript)를 건너뛴다. 그 단계를 돌리는 빌드는 Finder 자동화가 막힌 셸(에이전트 샌드박스 등)에서 `bundle_dmg.sh` 가 `Failed running AppleScript`(exit 64)로 실패하고 `bundle/macos/rw.*.dmg` 중간 파일이 남는다.
- **앱 안 업데이트 흐름** — `scripts/update-local-test.sh` 가 낮은 버전과 지금 버전의 시험 번들, 임시 키, 로컬 `latest.json` 서버를 만든다. 쓰는 법은 `docs/guides/development.md` 「업데이트 흐름은 로컬 서버로 시험한다」 절.

## 실패했을 때

먼저 Actions 의 실패한 실행 → 빨간 단계를 연다. 단계 이름으로 찾는다.

| 단계 / 메시지                                                                              | 원인과 할 일                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 버전 확인(태그와 네 곳이 같아야 한다) / `버전이 맞지 않는다`                               | 태그와 `package.json` 이 다르거나 네 곳이 어긋났다. `pnpm version:set <버전>` → 커밋·푸시 → 태그를 지우고 다시 붙인다: `git tag -d v<버전> && git push origin :refs/tags/v<버전> && git tag v<버전> && git push origin v<버전>`              |
| 비밀·공개 키 확인 / `GitHub 비밀이 없다: …`                                                | 적힌 이름의 비밀을 「GitHub 비밀 등록」 대로 넣고 실행 화면에서 「Re-run all jobs」.                                                                                                                                                         |
| 비밀·공개 키 확인 / `pubkey 가 자리 표시 값이다`                                           | 「업데이트 서명 키」 의 3(공개 키 커밋)을 한다. 코드가 바뀌었으므로 태그를 다시 붙인다.                                                                                                                                                      |
| Rust 타깃 / `rustup` 실패                                                                  | rustup 이 mise 가 고정한 판의 툴체인이나 두 타깃을 받지 못했다(이 단계 로그의 rustup 오류), 또는 `mise current rust` 가 비었다(그 앞의 `jdx/mise-action` 단계 실패). 받기 실패면 「Re-run all jobs」, mise 단계가 실패했으면 그 로그를 본다. |
| Apple 중간 인증서(Developer ID G2) / 내려받기·`shasum` 실패                                | Apple 서버에서 받지 못했거나 Apple 이 인증서를 바꿨다. 「Re-run all jobs」 로 다시 해 보고, 해시가 계속 다르면 <https://www.apple.com/certificateauthority/> 의 G2 인증서 SHA-256 을 확인해 워크플로의 값을 고친다.                          |
| 빌드·서명·앱 공증 (universal) / `failed to import keychain certificate` 류                 | `.p12` base64 나 비밀번호가 틀렸다. `.p12` 를 다시 내보내 두 비밀을 다시 넣는다.                                                                                                                                                             |
| 산출물 찾기 / `유니버설이 아니다`                                                          | 두 타깃 중 하나로 빌드되지 않았다. 「Rust 타깃」 단계가 두 타깃을 더했는지 본다.                                                                                                                                                             |
| 산출물 찾기 / `앱의 버전 … 이 … 이 아니다` · `식별자 … 가 com.develma.totenotes 가 아니다` | `tauri.conf.json` 이 버전·식별자를 바꿨다. 버전은 `pnpm version:set`, 식별자는 아래 「바꾸면 안 되는 것」.                                                                                                                                   |
| 서명·공증 검사(앱) / `Developer ID 로 서명되지 않았다`                                     | 인증서가 Developer ID Application 이 아니다(Apple Development 등). 인증서를 「처음부터 만드는 길」 대로 다시 만든다.                                                                                                                         |
| 서명·공증 검사(앱) / `공증되지 않았다`                                                     | 빌드 로그에서 `skipping app notarization` 을 찾는다 — 공증 자격(`APPLE_API_*`)이 빠졌거나 틀렸다. `xcrun notarytool history …` 로 맥에서 자격을 확인한다.                                                                                    |
| 업데이트 묶음 검사 / `키 ID 가 다르다`                                                     | `TAURI_SIGNING_PRIVATE_KEY` 와 `tauri.conf.json` 의 `pubkey` 가 짝이 아니다. 보관해 둔 짝을 쓴다. **이미 릴리스한 적이 있으면 공개 키를 바꾸지 않는다**(「업데이트 서명 키」 의 경고).                                                       |
| DMG 공증·스테이플 / `DMG 공증 결과: Invalid`                                               | 바로 위에 Apple 의 공증 로그(JSON)가 찍힌다. `issues` 의 `message` 를 본다.                                                                                                                                                                  |
| 릴리스 공개 / `올라간 파일이 다르다` · 업로드 오류                                         | 릴리스는 **드래프트로 남는다**(공개되지 않음). 릴리스 페이지에서 그 드래프트를 지우고 「Re-run all jobs」. 같은 태그의 릴리스가 있으면 만들기 단계가 실패하므로 지우는 것이 먼저다.                                                          |
| 앱 / `업데이트하지 못했습니다: … Read-only file system`                                    | tote 를 DMG 안이나 「다운로드」 폴더에서(격리된 채) 실행했다. 업데이터가 앱 자리를 바꿀 수 없다. tote 를 「응용 프로그램」 폴더로 옮겨 실행한다.                                                                                             |
| 앱 / 「업데이트 확인」 이 아무 말이 없다                                                   | 설정 → 일반 「실행할 때 업데이트 확인」 이 꺼져 있거나, 최신 릴리스에 `latest.json` 이 없다(드래프트는 `releases/latest` 가 아니다). 메뉴 「tote → 업데이트 확인…」 은 설정과 상관없이 확인하고 결과를 말한다.                               |

공개되기 전에 실패한 실행은 사용자에게 아무 영향이 없다 — 드래프트는 `releases/latest` 가 아니라서 앱이 보지 않는다.

## 바꾸면 안 되는 것

- **앱 식별자 `com.develma.totenotes`**(`tauri.conf.json` 의 `identifier`). 바꾸면 업데이트가 다른 앱으로 보이고, macOS 가 식별자에 준 것 — 폴더 접근 허락(문서·데스크톱 등), `~/Library/WebKit`·`~/Library/Caches` 의 캐시, `~/Library/Preferences` 의 환경 설정(파일 대화상자의 마지막 폴더 등) — 이 새 앱으로 이어지지 않는다(폴더 접근은 처음 한 번 다시 묻는다). 메모·설정은 식별자와 무관한 `~/Library/Application Support/tote` 에 있어 그대로다.
- **업데이트 서명 키**(「업데이트 서명 키」).
- **릴리스 파일 이름 모양과 `latest.json` 위치**. 설치된 앱은 `https://github.com/jang2162/tote-notes/releases/latest/download/latest.json` 을 본다(`tauri.conf.json` 의 `plugins.updater.endpoints`). 저장소 이름·소유자를 바꾸면 이 주소도 함께 바뀌어야 하고, 옛 앱은 옛 주소를 계속 본다.
- **entitlements 를 두지 않는다**(`tauri.conf.json` 의 `bundle.macOS.entitlements` 없음, `scripts/release-config.test.ts` 가 지킨다). hardened runtime 아래에서 tote 는 entitlement 없이 뜨고 `tote` 셸 명령을 받는다 — 샌드박스 앱이 아니고, 페이지의 JavaScript·WebAssembly 는 WebKit 의 별도 프로세스가 돌린다. 서명된 앱에서 막히는 동작이 생기면 그 거절(`log show --last 5m --predicate 'process == "tote"'`)을 푸는 것 하나만 더한다.
- **`productName` `tote`**. 앱 번들 이름(`tote.app`)과 `tote` 셸 명령의 링크가 이 이름에 묶인다.

## 참고

- Tauri: [macOS 코드 서명](https://v2.tauri.app/distribute/sign/macos/), [업데이터](https://v2.tauri.app/plugin/updater/)
- Apple: [Developer ID](https://developer.apple.com/developer-id/), [공증](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
