# 개발 메모 — 테스트, 훅, 툴체인

## E2E 전에 WebKit 을 설치한다

`pnpm test:e2e` 전에 `pnpm exec playwright install webkit` 을 한 번 돌린다(약 300MB, `~/Library/Caches/ms-playwright`).

- **Why:** 설치가 없으면 브라우저를 찾지 못해 테스트가 시작도 못 한다. 캐시는 사용자 단위라 워크트리마다 다시 받지 않는다.
- E2E 의 Vite 서버 포트는 `TOTE_E2E_PORT` 다(기본 1430, `strictPort`). 포트가 잡혀 있으면 다른 서버에 붙지 않고 실패한다. 워크트리를 여럿 동시에 돌리면 워크트리마다 다른 값을 준다.

## NFD 를 뜻하는 한글 리터럴은 `.normalize("NFD")` 로 쓴다

Finder 이름처럼 분해형(NFD)이어야 하는 테스트 입력은 `"한글 메모.md".normalize("NFD")` 로 쓴다.

- **Why:** NFD 한글을 소스에 그대로 적으면 복사·붙여넣기·편집기를 거치며 조용히 NFC 로 바뀌고, 테스트는 오류 없이 NFC 를 검사해 구분력을 잃는다.

## pre-push 는 느리다

pre-push 는 rustfmt, `cargo clippy --all-targets`, `tsc` 를 돈다. 문서만 고친 브랜치도 마찬가지다.

- **Why:** 워크트리마다 `src-tauri/target` 이 따로라서, 워크트리의 첫 push 는 처음부터 빌드해 몇 분 걸린다. 멈춘 것이 아니다.

## `mise.toml` 의 rust `components` 를 바꾸면 따로 설치한다

바꾼 뒤에는 이미 설치된 툴체인에 `rustup component add <컴포넌트> --toolchain <버전>` 을 따로 돌린다.

- **Why:** `mise install` 은 이미 설치된 버전을 건너뛰어 새 컴포넌트를 더하지 않는다. 그러면 pre-push 가 clippy 를 찾지 못해 실패한다.
