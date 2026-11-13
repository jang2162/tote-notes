# Tote Notes

아무 때나 막 적고, 앱을 닫아도 그대로 남는 가벼운 macOS 메모 앱이다. 코드 편집기의 편집 감각(멀티커서, 신택스 하이라이트)은 가져오고, 코드 도구(터미널, git, 파일 트리, LSP)는 뺐다.

- **언제 꺼도 다시 켜면 그대로다.** 메모는 자동으로 저장되고, 창·칸·탭·커서·스크롤이 되살아난다. 강제 종료 때 잃는 것은 마지막 저장 간격만큼의 입력뿐이다.
- **가볍고 빠르다.** 메모는 워크스페이스 폴더 안의 평범한 텍스트 파일이다.
- **테마·문법·뷰어는 확장으로 들어 있다.** 기본 테마, 언어 묶음, 마크다운 미리보기, 미디어 뷰어 넷이 번들 확장이다. 사람이 더 설치할 수 있는 것은 언어·문법 확장이다.

## 기능

- **워크스페이스:** 폴더 하나가 워크스페이스 하나다(기본 자리 `~/.tote`). 사이드바의 고르개나 ⌃1 – ⌃9 로 바꾸고, 설정에서 순서를 정하거나 숨긴다.
- **편집기:** 멀티커서(한글 입력 포함), 언어별 하이라이트(마크다운, 셸, JSON, YAML, JavaScript, Python, Rust 등), 마크다운 미리보기.
- **칸과 창:** 칸을 가로·세로로 나누고, 탭을 끌어 다른 칸이나 새 창으로 옮긴다.
- **메모 목록:** 제목·내용 필터, 정렬 여섯 가지, 맨 위 고정, 내용 미리보기. 워크스페이스 전체 검색은 따로 있다.
- **안전망:** 바뀐 것이 있으면 10분마다 스냅샷을 남기고 메모마다 「이전 버전」 으로 되돌린다. 지운 메모는 휴지통에 남고, 기한(기본 60일)이 지나면 비워진다.
- **그 밖에:** 이미지·영상·소리 뷰어, 테마(자동·라이트·다크)와 글꼴·단축키 설정, 언어·문법 확장 설치, 앱 안 업데이트.

## 설치

macOS 13 이상. [GitHub 릴리스](https://github.com/jang2162/tote-notes/releases/latest)에서 `Tote-Notes_<버전>_universal.dmg` 를 받아 앱을 응용 프로그램 폴더로 옮긴다. Apple Silicon 과 Intel 에서 모두 돈다.

## `tote` 명령

앱 메뉴 「Tote Notes › 셸 명령 설치…」 가 `tote` 를 `/usr/local/bin` 에 건다(쓸 수 없으면 `~/.local/bin`).

```
tote                  앱을 앞으로 가져온다
tote a.sh b.md        가장 최근 창에 외부 탭으로 연다
tote -w 업무 a.sh     그 워크스페이스에 연다
tote --import a.sh    워크스페이스로 복사해 메모로 연다
echo 내용 | tote -    표준 입력으로 새 메모를 만든다
```

## 개발

런타임 버전은 `mise.toml` 이 정한다(Node, pnpm, Rust). 앱 셸은 Tauri 2, 프런트엔드는 TypeScript 와 CodeMirror 6, 백엔드는 Rust 다.

```
mise install          # mise.toml 의 런타임
pnpm install
pnpm app:dev          # 개발 앱 (데이터는 배포 앱과 다른 개발용 폴더)

pnpm test             # vitest
cargo test --manifest-path src-tauri/Cargo.toml
pnpm exec playwright install webkit   # 처음 한 번
pnpm test:e2e
```

시험을 돌리는 법, 디버그 앱을 띄울 때 지킬 것, 훅과 CI 는 [docs/guides/development.md](docs/guides/development.md) 에, 릴리스 절차는 [docs/guides/release-macos.md](docs/guides/release-macos.md) 에 있다.

## 문서

- `docs/guides/` — 개발·릴리스 가이드.
- `docs/superpowers/` — 설계(`specs/`), 구현 계획(`plans/`), 확인 기록(`reports/`). 그때의 판단을 남긴 기록이다.
- `docs/guideline/` — 에이전트 작업 지침의 사본.
