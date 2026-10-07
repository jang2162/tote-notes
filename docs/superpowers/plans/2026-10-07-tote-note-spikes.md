# tote-note 검증 스파이크 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 코어 스펙이 기대는 미확인 가정 셋(샌드박스 뷰어의 파일 전달, 대용량 편집 성능, 한글 IME)을 실제 macOS WebView 에서 재고, 판정과 수치를 보고서로 남긴다.

**Architecture:** `spikes/lab/` 에 Tauri 2 실험 앱 하나를 만든다. 사람이 없어도 도는 측정은 환경 변수 `TOTE_LAB_AUTO` 로 자동 실행하고 결과를 `spikes/lab/results/*.json` 에 쓴 뒤 스스로 종료한다. 사람의 손이 필요한 측정(실제 타이핑 지연, 한글 IME)은 같은 앱의 `#latency`·`#ime` 화면에서 사람이 돌린다.

**Tech Stack:** Tauri 2 (Rust), Vite + TypeScript(vanilla), CodeMirror 6 (`codemirror`), Shiki 4 (`shiki/core`, `@shikijs/langs`, `@shikijs/themes`), Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-10-07-tote-note-core-design.md` — 특히 「구현 계획 맨 앞의 검증 스파이크」·「뷰어」·「성능」 절.

## 이 계획의 위치

코어는 이 스파이크 다음에 계획 셋으로 나눠 쓴다. 각 계획은 스파이크 보고서를 반영한 뒤에 쓴다.

1. **코어 기반** — 워크스페이스·색인·제목 자동 생성, 저장(자동·⌘S·원자적 쓰기), 세션 유지, 편집기(하이라이트 없이), 메모 목록, `tote` CLI.
2. **확장과 화면** — 확장 로더, TextMate 하이라이트(이 스파이크의 청크 토크나이저를 제품 코드로), 테마, 뷰어 샌드박스, 마크다운 미리보기, 미디어 뷰어, 대용량 텍스트 뷰어.
3. **안전망** — 백업, 워크스페이스 검색, 외부 변경·충돌, 오류 처리, 크기별 단계, 성능 계측.

## Global Constraints

- 실험 코드는 `spikes/lab/` 안에만 둔다. 제품 코드는 여기를 import 하지 않는다.
- Rust 버전은 `mise.toml` 이 정한다. Node `24.21.0`, pnpm `10.33.0` 은 이미 `mise.toml` 에 있다.
- 실험 앱의 창은 `"focus": false` 로 띄운다. 사람의 작업 화면을 빼앗지 않기 위해서다.
- 뷰어 iframe 은 `sandbox="allow-scripts"`(동일 출처 없음)이고, 그 안의 CSP 는 정확히 `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src tote-file:; img-src tote-file:; connect-src tote-file:` 이다.
- 파일 토큰 URL 형식은 `tote-file://localhost/<32자리 hex 토큰>` 이다. URL 에 파일 경로를 넣지 않는다.
- 하이라이트 상수: 한 줄 **20,000자** 넘으면 토큰화하지 않는다(`tokenizeMaxLineLength`), 청크는 **200줄**.
- 키 입력 지연 목표: **10MB 파일에서 키 입력 → 화면 반영 16ms 이하**.
- `spikes/lab/results/` 와 `spikes/lab/fixtures/` 는 커밋하지 않는다. 수치는 보고서에 재측정 명령과 함께 적는다.
- **측정 결과가 나쁘게 나와도 태스크 실패가 아니다.** 결과 파일이 기록되면 그 태스크는 끝난다. 판정은 Task 7 보고서가 한다.
- 커밋은 경로를 명시해 stage 한다(`git add -A` 금지). 커밋 전에 저장소 루트에서 `pnpm exec oxfmt spikes/lab` 과 `src-tauri` 에서 `cargo fmt` 를 돌린다.

## Review Focus

1. **Range 헤더 변형** — 끝이 열린 `bytes=0-`, 접미 `bytes=-N`, 파일 끝을 넘는 시작. 사람은 영상 탐색이 그냥 되길 기대한다. Task 2 의 `parse_range` 테스트가 고정한다.
2. **한글·공백이 든 파일 경로** — `테스트 영상.mp4` 같은 이름이 뷰어에서 열려야 한다. Task 2 의 `range_request_on_korean_filename_returns_206_slice` 와 Task 3 의 픽스처 이름이 고정한다.
3. **경로처럼 생긴 URL** — 토큰이 아닌 경로나 `..` 로 다른 파일을 읽으려 하면 404 여야 한다. Task 2 의 `path_like_uri_is_not_resolved_as_a_path` 가 고정한다.
4. **청크 경계를 넘는 여러 줄 구문** — 블록 주석이 청크 둘에 걸쳐도 색이 이어져야 하고, 여는 기호를 지우면 다음 청크 색이 돌아와야 한다. Task 4 의 `ChunkedTokenizer` 테스트 둘이 고정한다.
5. **20,000자를 넘는 한 줄** — minified 파일에서 멈추지 않아야 한다. Task 4 의 `does not tokenize lines longer than the limit` 이 고정한다.

---

### Task 1: Rust 툴체인 고정과 실험 앱 골격

**Files:**

- Modify: `mise.toml`
- Create: `spikes/lab/` (create-tauri-app 스캐폴드 전체)
- Modify: `spikes/lab/src-tauri/tauri.conf.json`
- Modify: `spikes/lab/.gitignore`
- Replace: `spikes/lab/index.html`, `spikes/lab/src/main.ts`, `spikes/lab/src-tauri/src/lib.rs`
- Create: `spikes/lab/src/lab-api.ts`, `spikes/lab/README.md`
- Delete: `spikes/lab/src/styles.css`, `spikes/lab/src/assets/` (스캐폴드에 있으면)

**Interfaces:**

- Produces (Rust 명령): `lab_env() -> LabEnv { auto, video, video2, image: Option<String> }`, `record_result(name: String, json: String) -> Result<(), String>`, `exit_app()`.
- Produces (TS, `src/lab-api.ts`): `labEnv(): Promise<LabEnv>`, `recordResult(name: string, data: unknown): Promise<void>`, `exitApp(): Promise<void>`, `interface LabEnv { auto: string | null; video: string | null; video2: string | null; image: string | null }`.
- 결과 파일 위치: `spikes/lab/results/<name>.json`. `name` 은 `[a-z0-9-]+` 만 허용한다.

- [ ] **Step 1: Rust 버전 고정**

최신 stable 을 확인한다.

```bash
mise ls-remote rust | grep -E '^1\.[0-9]+\.[0-9]+$' | tail -1
```

출력된 버전을 `mise.toml` 에 넣는다(아래 `1.xx.y` 자리에 그 출력을 그대로).

```toml
[tools]
node = "24.21.0"
"npm:pnpm" = "10.33.0"
rust = "1.xx.y"
```

```bash
mise trust && mise install
rustc --version && cargo --version
```

Expected: 두 명령 모두 `mise.toml` 의 버전을 출력한다. 다르면 `docs/guideline/mise/01-path.md` 를 따른다.

- [ ] **Step 2: 스캐폴드**

```bash
pnpm create tauri-app --help
```

Expected: 도움말에 `--template`, `--manager`, `--identifier`, `--yes` 가 있다. 이름이 다르면 그 이름으로 바꿔 쓴다.

```bash
mkdir -p spikes
(cd spikes && pnpm create tauri-app lab --template vanilla-ts --manager pnpm --identifier dev.tote.lab --yes)
(cd spikes/lab && pnpm install)
grep -n '^name' spikes/lab/src-tauri/Cargo.toml
grep -n 'serde' spikes/lab/src-tauri/Cargo.toml
```

Expected: 패키지 이름이 `lab` 이고, `serde`(derive 포함)와 `serde_json` 이 의존성에 있다. 패키지 이름이 다르면 이 계획의 `target/debug/lab` 을 그 이름으로 읽는다.

- [ ] **Step 3: 창 설정과 무시 목록**

`spikes/lab/src-tauri/tauri.conf.json` 에서 `productName` 을 `"tote-lab"` 로, `app.windows` 를 아래로 바꾼다. `app.security.csp` 는 스캐폴드 값(`null`) 그대로 둔다.

```json
"windows": [
  {
    "title": "tote lab",
    "width": 1100,
    "height": 800,
    "focus": false
  }
]
```

`spikes/lab/.gitignore` 끝에 추가한다.

```
fixtures/
results/
```

- [ ] **Step 4: 실패하는 테스트 작성**

`spikes/lab/src-tauri/src/lib.rs` 를 아래로 통째로 바꾼다(아직 `is_valid_result_name` 이 없어서 컴파일이 실패해야 한다).

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::is_valid_result_name;

    #[test]
    fn result_names_are_restricted_to_safe_characters() {
        assert!(is_valid_result_name("latency-code-10mb-javascript"));
        assert!(!is_valid_result_name(""));
        assert!(!is_valid_result_name("../escape"));
        assert!(!is_valid_result_name("Upper"));
        assert!(!is_valid_result_name("a/b"));
    }
}
```

- [ ] **Step 5: 실패 확인**

Run: `(cd spikes/lab/src-tauri && cargo test)`
Expected: FAIL — `cannot find function `is_valid_result_name``. (`dist` 가 없다는 오류가 먼저 나면 `(cd spikes/lab && pnpm build)` 를 돌리고 다시 실행한다.)

- [ ] **Step 6: 구현**

`spikes/lab/src-tauri/src/lib.rs`:

```rust
use std::path::PathBuf;

use serde::Serialize;

#[derive(Serialize)]
struct LabEnv {
    auto: Option<String>,
    video: Option<String>,
    video2: Option<String>,
    image: Option<String>,
}

#[tauri::command]
fn lab_env() -> LabEnv {
    let var = |key: &str| std::env::var(key).ok();
    LabEnv {
        auto: var("TOTE_LAB_AUTO"),
        video: var("TOTE_LAB_VIDEO"),
        video2: var("TOTE_LAB_VIDEO2"),
        image: var("TOTE_LAB_IMAGE"),
    }
}

fn is_valid_result_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[tauri::command]
fn record_result(name: String, json: String) -> Result<(), String> {
    if !is_valid_result_name(&name) {
        return Err(format!("invalid result name: {name}"));
    }
    // Results land next to the lab sources no matter which directory the binary was started from.
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../results");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{name}.json")), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![lab_env, record_result, exit_app])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::is_valid_result_name;

    #[test]
    fn result_names_are_restricted_to_safe_characters() {
        assert!(is_valid_result_name("latency-code-10mb-javascript"));
        assert!(!is_valid_result_name(""));
        assert!(!is_valid_result_name("../escape"));
        assert!(!is_valid_result_name("Upper"));
        assert!(!is_valid_result_name("a/b"));
    }
}
```

- [ ] **Step 7: 통과 확인**

Run: `(cd spikes/lab/src-tauri && cargo test)`
Expected: `test result: ok. 1 passed`. **실행 개수가 1 인지 확인한다.**

- [ ] **Step 8: 프론트엔드 골격**

스캐폴드의 데모 파일을 지운다.

```bash
rm -rf spikes/lab/src/styles.css spikes/lab/src/assets
```

`spikes/lab/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>tote lab</title>
    <script type="module" src="/src/main.ts" defer></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
```

`spikes/lab/src/lab-api.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export interface LabEnv {
  auto: string | null;
  video: string | null;
  video2: string | null;
  image: string | null;
}

export const labEnv = () => invoke<LabEnv>("lab_env");

export const recordResult = (name: string, data: unknown) =>
  invoke<void>("record_result", { name, json: JSON.stringify(data, null, 2) });

export const exitApp = () => invoke<void>("exit_app");
```

`spikes/lab/src/main.ts`:

```ts
import { exitApp, labEnv, recordResult } from "./lab-api";

const app = document.querySelector<HTMLDivElement>("#app")!;

async function main(): Promise<void> {
  const env = await labEnv();
  if (env.auto === "ping") {
    await recordResult("ping", { ok: true, userAgent: navigator.userAgent });
    return exitApp();
  }
  app.innerHTML = `<h1>tote lab</h1><p>측정용 실험 앱이다. 제품 코드가 아니다.</p>`;
}

main().catch((err) => {
  app.textContent = String(err);
  console.error(err);
});
```

`spikes/lab/README.md`:

````markdown
# tote lab

tote-note 코어 스펙의 검증 스파이크를 재는 실험 앱이다. 제품 코드가 아니며, 제품 코드는 이 디렉터리를 import 하지 않는다.

## 빌드

```bash
pnpm install
pnpm tauri build --debug --no-bundle   # 결과: src-tauri/target/debug/lab
```

## 자동 측정

`TOTE_LAB_AUTO` 로 모드를 고르면 측정한 뒤 `results/<이름>.json` 을 쓰고 스스로 종료한다. `perl -e 'alarm shift; exec @ARGV' <초>` 는 그 시간 안에 끝나지 않으면 강제로 끊는다.

| 모드         | 재는 것                                           | 결과 파일                                        |
| ------------ | ------------------------------------------------- | ------------------------------------------------ |
| `ping`       | IPC 와 결과 기록 경로                             | `results/ping.json`                              |
| `viewer`     | 샌드박스 iframe 의 토큰 URL 영상 탐색·이미지·격리 | `results/viewer.json`, `results/viewer-rust.log` |
| `throughput` | Worker TextMate 토큰화 처리량                     | `results/throughput.json`                        |
| `smoke`      | 편집기 + Worker 하이라이트 파이프라인 동작        | `results/smoke.json`                             |

```bash
mkdir -p results
TOTE_LAB_AUTO=ping perl -e 'alarm shift; exec @ARGV' 60 ./src-tauri/target/debug/lab
```

`viewer` 모드에 필요한 픽스처와 실행 명령은 아래 「픽스처」 절.

## 사람이 하는 측정

```bash
./src-tauri/target/debug/lab
```

- `#latency` — 실제 타이핑 지연과 스크롤 프레임. 결과: `results/latency-<픽스처>-<엔진>.json`.
- `#ime` — 한글 IME 조합 시나리오 7개. 결과: `results/ime.json`.

창을 다른 창으로 가리지 않은 상태에서 잰다. 가려진 창은 프레임이 줄어 수치가 틀어진다.
````

- [ ] **Step 9: 빌드와 ping 확인**

```bash
cd spikes/lab
pnpm build
pnpm tauri build --debug --no-bundle
ls -l src-tauri/target/debug/lab
mkdir -p results
TOTE_LAB_AUTO=ping perl -e 'alarm shift; exec @ARGV' 60 ./src-tauri/target/debug/lab; echo "exit=$?"
cat results/ping.json
```

Expected: `exit=0`, `ping.json` 에 `"ok": true` 와 `AppleWebKit` 이 든 `userAgent`. `exit=142` 면 60초 안에 끝나지 않은 것이다 — 창의 개발자 도구 콘솔에서 오류를 본다.

- [ ] **Step 10: 커밋**

```bash
pnpm exec oxfmt spikes/lab
(cd spikes/lab/src-tauri && cargo fmt)
git status --short
git add mise.toml spikes/lab
git status --short
git commit -m "chore(spikes): scaffold tote lab app and pin rust toolchain"
```

`git add spikes/lab` 전에 `git status --short` 에 `node_modules`·`target`·`dist`·`results`·`fixtures` 가 보이면 멈추고 `.gitignore` 를 고친다.

---

### Task 2: 파일 토큰 URL 스킴

**Files:**

- Create: `spikes/lab/src-tauri/src/file_scheme.rs`
- Modify: `spikes/lab/src-tauri/src/lib.rs`, `spikes/lab/src-tauri/Cargo.toml`
- Modify: `spikes/lab/src/lab-api.ts`

**Interfaces:**

- Consumes: Task 1 의 `lib.rs` 명령들.
- Produces (Rust): `TokenStore { issue(PathBuf) -> String, resolve(&str) -> Option<PathBuf> }`(Clone, 내부 `Arc<Mutex<HashMap>>`), `enum RangeSpec { Full, Partial { start: u64, end: u64 }, Unsatisfiable }`, `parse_range(Option<&str>, len: u64) -> RangeSpec`, `respond(&TokenStore, uri_path: &str, range: Option<&str>) -> Response<Vec<u8>>`.
- Produces (명령): `issue_file_token(path: String) -> String` — `tote-file://localhost/<token>` 을 돌려준다.
- Produces (TS): `issueFileToken(path: string): Promise<string>`.
- 스킴 핸들러는 요청마다 stderr 에 `[tote-file] /<token> range=<Some("…")|None>` 한 줄을 쓴다(Task 3 이 Range 요청 수를 센다).

- [ ] **Step 1: 의존성 추가**

```bash
cd spikes/lab/src-tauri
cargo add uuid --features v4
cargo add --dev tempfile
```

- [ ] **Step 2: 실패하는 테스트 작성**

`spikes/lab/src-tauri/src/file_scheme.rs` 를 테스트만 담아 만든다.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    use tauri::http::{header, StatusCode};

    #[test]
    fn no_header_means_full() {
        assert_eq!(parse_range(None, 1000), RangeSpec::Full);
    }

    #[test]
    fn open_ended_range_runs_to_eof() {
        assert_eq!(
            parse_range(Some("bytes=0-"), 1000),
            RangeSpec::Partial { start: 0, end: 999 }
        );
    }

    #[test]
    fn webkit_probe_range() {
        assert_eq!(
            parse_range(Some("bytes=0-1"), 1000),
            RangeSpec::Partial { start: 0, end: 1 }
        );
    }

    #[test]
    fn suffix_range_takes_last_bytes() {
        assert_eq!(
            parse_range(Some("bytes=-500"), 1000),
            RangeSpec::Partial { start: 500, end: 999 }
        );
        assert_eq!(
            parse_range(Some("bytes=-5000"), 1000),
            RangeSpec::Partial { start: 0, end: 999 }
        );
    }

    #[test]
    fn end_past_eof_is_clamped() {
        assert_eq!(
            parse_range(Some("bytes=10-99999"), 1000),
            RangeSpec::Partial { start: 10, end: 999 }
        );
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
        std::fs::File::create(&path).unwrap().write_all(bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn unknown_token_is_404() {
        let store = TokenStore::default();
        assert_eq!(respond(&store, "/deadbeef", None).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn path_like_uri_is_not_resolved_as_a_path() {
        let (_dir, path) = fixture("a.txt", b"secret");
        let store = TokenStore::default();
        let _token = store.issue(path.clone());
        let uri = format!("/{}", path.display());
        assert_eq!(respond(&store, &uri, None).status(), StatusCode::NOT_FOUND);
        assert_eq!(
            respond(&store, "/../../etc/passwd", None).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn range_request_on_korean_filename_returns_206_slice() {
        let (_dir, path) = fixture("영상 테스트.bin", b"0123456789");
        let store = TokenStore::default();
        let token = store.issue(path);
        let res = respond(&store, &format!("/{token}"), Some("bytes=2-5"));
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(res.body(), b"2345");
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(res.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }

    #[test]
    fn full_request_returns_200_whole_file() {
        let (_dir, path) = fixture("clip.mp4", b"abc");
        let store = TokenStore::default();
        let token = store.issue(path);
        let res = respond(&store, &format!("/{token}"), None);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"abc");
        assert_eq!(res.headers()[header::CONTENT_TYPE], "video/mp4");
    }

    #[test]
    fn unsatisfiable_range_is_416_with_size() {
        let (_dir, path) = fixture("a.bin", b"abc");
        let store = TokenStore::default();
        let token = store.issue(path);
        let res = respond(&store, &format!("/{token}"), Some("bytes=10-"));
        assert_eq!(res.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(res.headers()[header::CONTENT_RANGE], "bytes */3");
    }
}
```

`lib.rs` 맨 위에 `mod file_scheme;` 를 넣는다.

- [ ] **Step 3: 실패 확인**

Run: `(cd spikes/lab/src-tauri && cargo test file_scheme)`
Expected: FAIL — `cannot find function `parse_range``, `cannot find type `TokenStore`` 등.

- [ ] **Step 4: 구현**

`file_scheme.rs` 의 테스트 모듈 **위에** 넣는다.

```rust
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::http::{header, Response, StatusCode};

/// Maps one-time tokens to file paths so a viewer URL never carries a path it could rewrite.
#[derive(Clone, Default)]
pub struct TokenStore(Arc<Mutex<HashMap<String, PathBuf>>>);

impl TokenStore {
    pub fn issue(&self, path: PathBuf) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.0.lock().unwrap().insert(token.clone(), path);
        token
    }

    pub fn resolve(&self, token: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().get(token).cloned()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RangeSpec {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

/// Single byte ranges only; WebKit's media loader never asks for multipart ranges.
/// Malformed headers are ignored (full response), as HTTP allows.
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

fn read_slice(path: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0; (end - start + 1) as usize];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}
```

- [ ] **Step 5: 통과 확인**

Run: `(cd spikes/lab/src-tauri && cargo test)`
Expected: `test result: ok. 13 passed` (file_scheme 12 + 기존 1). **실행 개수를 확인한다.**

- [ ] **Step 6: 스킴과 명령 등록**

`lib.rs` 를 아래로 바꾼다(Task 1 의 내용에 스킴·토큰 명령을 더한 전체).

```rust
mod file_scheme;

use std::path::PathBuf;

use file_scheme::TokenStore;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
struct LabEnv {
    auto: Option<String>,
    video: Option<String>,
    video2: Option<String>,
    image: Option<String>,
}

#[tauri::command]
fn lab_env() -> LabEnv {
    let var = |key: &str| std::env::var(key).ok();
    LabEnv {
        auto: var("TOTE_LAB_AUTO"),
        video: var("TOTE_LAB_VIDEO"),
        video2: var("TOTE_LAB_VIDEO2"),
        image: var("TOTE_LAB_IMAGE"),
    }
}

fn is_valid_result_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[tauri::command]
fn record_result(name: String, json: String) -> Result<(), String> {
    if !is_valid_result_name(&name) {
        return Err(format!("invalid result name: {name}"));
    }
    // Results land next to the lab sources no matter which directory the binary was started from.
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../results");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{name}.json")), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn issue_file_token(store: State<'_, TokenStore>, path: String) -> String {
    format!("tote-file://localhost/{}", store.issue(PathBuf::from(path)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let store = TokenStore::default();
    let scheme_store = store.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(store)
        .register_asynchronous_uri_scheme_protocol("tote-file", move |_ctx, request, responder| {
            let store = scheme_store.clone();
            let path = request.uri().path().to_string();
            let range = request
                .headers()
                .get(tauri::http::header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            std::thread::spawn(move || {
                // Logged so the viewer spike can count how many Range requests WebKit actually sent.
                eprintln!("[tote-file] {path} range={range:?}");
                responder.respond(file_scheme::respond(&store, &path, range.as_deref()));
            });
        })
        .invoke_handler(tauri::generate_handler![
            lab_env,
            record_result,
            exit_app,
            issue_file_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::is_valid_result_name;

    #[test]
    fn result_names_are_restricted_to_safe_characters() {
        assert!(is_valid_result_name("latency-code-10mb-javascript"));
        assert!(!is_valid_result_name(""));
        assert!(!is_valid_result_name("../escape"));
        assert!(!is_valid_result_name("Upper"));
        assert!(!is_valid_result_name("a/b"));
    }
}
```

`spikes/lab/src/lab-api.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export interface LabEnv {
  auto: string | null;
  video: string | null;
  video2: string | null;
  image: string | null;
}

export const labEnv = () => invoke<LabEnv>("lab_env");

export const recordResult = (name: string, data: unknown) =>
  invoke<void>("record_result", { name, json: JSON.stringify(data, null, 2) });

export const exitApp = () => invoke<void>("exit_app");

export const issueFileToken = (path: string) => invoke<string>("issue_file_token", { path });
```

- [ ] **Step 7: 확인**

```bash
(cd spikes/lab/src-tauri && cargo test)
(cd spikes/lab && pnpm tauri build --debug --no-bundle)
```

Expected: `13 passed`, 빌드 성공.

- [ ] **Step 8: 커밋**

```bash
pnpm exec oxfmt spikes/lab
(cd spikes/lab/src-tauri && cargo fmt)
git add spikes/lab/src-tauri/src/file_scheme.rs spikes/lab/src-tauri/src/lib.rs spikes/lab/src-tauri/Cargo.toml spikes/lab/src-tauri/Cargo.lock spikes/lab/src/lab-api.ts
git status --short
git commit -m "feat(spikes): serve files to viewers through one-time token URLs with Range support"
```

---

### Task 3: 뷰어 샌드박스 실험 (자동)

**Files:**

- Create: `spikes/lab/public/viewer/sandbox.html`
- Create: `spikes/lab/src/viewer/host.ts`
- Replace: `spikes/lab/src/main.ts`

**Interfaces:**

- Consumes: `issueFileToken`, `recordResult`, `exitApp`, `labEnv` (`src/lab-api.ts`).
- Produces: `runViewerAuto(env: LabEnv): Promise<void>` — `results/viewer.json` 을 쓰고 종료한다.
- 메시지 프로토콜: iframe → 호스트 `{type:"ready"}`, `{type:"result", result}`. 호스트 → iframe `{type:"init", videoUrl, imageUrl}`.

- [ ] **Step 1: 샌드박스 뷰어 페이지**

`spikes/lab/public/viewer/sandbox.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src tote-file:; img-src tote-file:; connect-src tote-file:"
    />
  </head>
  <body>
    <video id="v" muted playsinline preload="auto" width="320"></video>
    <img id="i" alt="" />
    <script>
      const log = {};

      function wait(el, eventName, ms) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(eventName + " timeout")), ms);
          el.addEventListener(
            eventName,
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          el.addEventListener(
            "error",
            () => {
              clearTimeout(timer);
              reject(new Error(eventName + " error " + (el.error ? el.error.code : "")));
            },
            { once: true },
          );
        });
      }

      async function probeIsolation() {
        log.origin = String(self.origin);
        log.tauriInternalsInFrame = typeof window.__TAURI_INTERNALS__;
        if (window.__TAURI_INTERNALS__) {
          try {
            await window.__TAURI_INTERNALS__.invoke("lab_env");
            log.ipcInvoke = "reachable";
          } catch (e) {
            log.ipcInvoke = "blocked: " + e;
          }
        }
        try {
          log.parentAccess = typeof window.parent.document;
        } catch (e) {
          log.parentAccess = "blocked: " + e.name;
        }
        try {
          await fetch("ipc://localhost/lab_env", { method: "POST", body: "{}" });
          log.ipcFetch = "reachable";
        } catch (e) {
          log.ipcFetch = "blocked: " + e.name;
        }
        try {
          await fetch("https://example.com/");
          log.networkFetch = "reachable";
        } catch (e) {
          log.networkFetch = "blocked: " + e.name;
        }
      }

      async function run(videoUrl, imageUrl) {
        await probeIsolation();
        const v = document.getElementById("v");
        try {
          v.src = videoUrl;
          await wait(v, "loadedmetadata", 15000);
          log.videoDuration = v.duration;
          const target = v.duration * 0.8;
          v.currentTime = target;
          await wait(v, "seeked", 15000);
          log.videoSeekedTo = v.currentTime;
          log.videoSeekOk = Math.abs(v.currentTime - target) < 1;
          log.videoReadyState = v.readyState;
        } catch (e) {
          log.videoError = String(e.message || e);
        }
        if (imageUrl) {
          const i = document.getElementById("i");
          try {
            i.src = imageUrl;
            await wait(i, "load", 10000);
            log.imageSize = [i.naturalWidth, i.naturalHeight];
          } catch (e) {
            log.imageError = String(e.message || e);
          }
        }
        parent.postMessage({ type: "result", result: log }, "*");
      }

      addEventListener("message", (e) => {
        if (e.data && e.data.type === "init") run(e.data.videoUrl, e.data.imageUrl);
      });
      parent.postMessage({ type: "ready" }, "*");
    </script>
  </body>
</html>
```

- [ ] **Step 2: 호스트**

`spikes/lab/src/viewer/host.ts`:

```ts
import { exitApp, issueFileToken, type LabEnv, recordResult } from "../lab-api";

type ViewerLog = Record<string, unknown>;

async function runCase(videoPath: string, imagePath: string | null): Promise<ViewerLog> {
  const videoUrl = await issueFileToken(videoPath);
  const imageUrl = imagePath ? await issueFileToken(imagePath) : null;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.style.cssText = "width:640px;height:420px;border:1px solid #888";
  // The listener goes in before the iframe exists so its first "ready" cannot be missed.
  const result = new Promise<ViewerLog>((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: "no result within 40s" }), 40_000);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      if (e.data?.type === "ready") {
        iframe.contentWindow?.postMessage({ type: "init", videoUrl, imageUrl }, "*");
      }
      if (e.data?.type === "result") {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(e.data.result as ViewerLog);
      }
    };
    window.addEventListener("message", onMessage);
  });
  iframe.src = "/viewer/sandbox.html";
  document.body.append(iframe);
  const log = await result;
  iframe.remove();
  return log;
}

export async function runViewerAuto(env: LabEnv): Promise<void> {
  const cases: [string, string | null][] = [
    ["faststart", env.video],
    ["moov-at-end", env.video2],
  ];
  const results: Record<string, unknown> = { userAgent: navigator.userAgent };
  for (const [name, path] of cases) {
    results[name] = path ? await runCase(path, env.image) : { skipped: "env not set" };
  }
  await recordResult("viewer", results);
  await exitApp();
}
```

- [ ] **Step 3: 라우팅**

`spikes/lab/src/main.ts`:

```ts
import { exitApp, labEnv, recordResult } from "./lab-api";
import { runViewerAuto } from "./viewer/host";

const app = document.querySelector<HTMLDivElement>("#app")!;

async function main(): Promise<void> {
  const env = await labEnv();
  switch (env.auto) {
    case "ping":
      await recordResult("ping", { ok: true, userAgent: navigator.userAgent });
      return exitApp();
    case "viewer":
      return runViewerAuto(env);
  }
  app.innerHTML = `<h1>tote lab</h1><p>측정용 실험 앱이다. 제품 코드가 아니다.</p>`;
}

main().catch(async (err) => {
  app.textContent = String(err);
  console.error(err);
  // An auto run must never hang the caller; record the error and leave.
  const env = await labEnv().catch(() => null);
  if (env?.auto) {
    await recordResult(`error-${env.auto}`, { error: String(err) }).catch(() => undefined);
    await exitApp();
  }
});
```

- [ ] **Step 4: 픽스처 만들기**

```bash
command -v ffmpeg
```

없으면 **여기서 멈추고** 메인 세션에 「ffmpeg 가 없어 영상 픽스처를 못 만든다」고 보고한다(설치하지 않는다).

```bash
cd spikes/lab
mkdir -p fixtures results
ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=60:size=640x360:rate=30 -c:v libx264 -pix_fmt yuv420p -movflags +faststart "fixtures/테스트 영상.mp4"
ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=60:size=640x360:rate=30 -c:v libx264 -pix_fmt yuv420p "fixtures/테스트 영상 moov끝.mp4"
ffmpeg -y -loglevel error -f lavfi -i testsrc=size=320x240 -frames:v 1 "fixtures/테스트 이미지.png"
for f in "fixtures/테스트 영상.mp4" "fixtures/테스트 영상 moov끝.mp4"; do
  echo "$f"; ffprobe -v trace "$f" 2>&1 | grep -m2 -oE "type:'(moov|mdat)'"
done
```

Expected: 첫 파일은 `moov` 가 `mdat` 보다 먼저, 둘째 파일은 `mdat` 이 먼저. `libx264` 가 없다는 오류가 나면 `-c:v h264_videotoolbox` 로 바꿔 다시 만든다.

- [ ] **Step 5: 빌드와 자동 실행**

```bash
cd spikes/lab
pnpm tauri build --debug --no-bundle
TOTE_LAB_AUTO=viewer \
TOTE_LAB_VIDEO="$PWD/fixtures/테스트 영상.mp4" \
TOTE_LAB_VIDEO2="$PWD/fixtures/테스트 영상 moov끝.mp4" \
TOTE_LAB_IMAGE="$PWD/fixtures/테스트 이미지.png" \
perl -e 'alarm shift; exec @ARGV' 120 ./src-tauri/target/debug/lab 2> results/viewer-rust.log; echo "exit=$?"
cat results/viewer.json
grep -c 'range=Some' results/viewer-rust.log
```

Expected: `exit=0` 이고 `results/viewer.json` 이 있다. **값이 기대와 달라도 태스크는 끝난 것이다** — 판정은 Task 7 이 한다. `results/error-viewer.json` 이 생겼거나 `exit=142` 면, 실험 코드 오류인지 WebView 제약인지 가려서 보고한다(코드 오류면 고쳐 다시 돌린다).

참고로 Task 7 의 통과 기준은 두 영상 모두 `videoSeekOk: true` 이고 `videoError` 가 없는 것, `imageSize: [320, 240]`, `tauriInternalsInFrame: "undefined"`(또는 `ipcInvoke` 가 blocked), `networkFetch`·`ipcFetch` 가 blocked, Range 로그 1줄 이상이다.

- [ ] **Step 6: 커밋**

```bash
pnpm exec oxfmt spikes/lab
git add spikes/lab/public/viewer/sandbox.html spikes/lab/src/viewer/host.ts spikes/lab/src/main.ts
git status --short
git commit -m "feat(spikes): measure sandboxed viewer playback over token URLs"
```

---

### Task 4: 청크 토크나이저와 처리량 측정 (자동)

**Files:**

- Modify: `spikes/lab/package.json` (의존성, `test` 스크립트)
- Create: `spikes/lab/src/perf/fixtures.ts`, `spikes/lab/src/perf/fixtures.test.ts`
- Create: `spikes/lab/src/perf/chunked-tokenizer.ts`, `spikes/lab/src/perf/chunked-tokenizer.test.ts`
- Create: `spikes/lab/src/perf/worker-protocol.ts`, `spikes/lab/src/perf/highlight-worker.ts`, `spikes/lab/src/perf/throughput.ts`
- Replace: `spikes/lab/src/main.ts`

**Interfaces:**

- Consumes: `recordResult`, `exitApp`, `labEnv` (`src/lab-api.ts`), `runViewerAuto` (Task 3).
- Produces (`fixtures.ts`): `TS_SAMPLE: string`, `makeCodeFixture(targetChars: number): string`, `makeSingleLineJson(targetChars: number): string`, `makeLogFixture(lineCount: number): string`.
- Produces (`chunked-tokenizer.ts`): `DEFAULT_CHUNK_LINES = 200`, `MAX_TOKENIZED_LINE_LENGTH = 20_000`, `interface LineToken { content: string; offset: number; color?: string }`(offset 은 줄 시작 기준), `class ChunkedTokenizer(hl, text, { lang, theme, chunkLines?, maxLineLength? })` — `lineCount`, `edit(fromLine, toLine, insert: string[])`(줄 [fromLine, toLine) 교체), `tokens(from, to): LineToken[][]`(줄 [from, to)).
- Produces (`worker-protocol.ts`): `Engine = "javascript" | "oniguruma"`, `Lang = "typescript" | "json" | "log"`, `WorkerRequest`, `WorkerReply`, `ThroughputResult`.
- Produces (`highlight-worker.ts`): 메시지 `throughput` / `open` / `edit` / `tokens` 를 순서대로 처리하는 Worker. Task 5 가 `open`·`edit`·`tokens` 를 쓴다.
- Produces (`throughput.ts`): `runThroughputAuto(): Promise<void>` — `results/throughput.json` 을 쓰고 종료한다.

- [ ] **Step 1: 의존성**

```bash
cd spikes/lab
pnpm add shiki @shikijs/langs @shikijs/themes
pnpm add -D vitest
npm pkg set scripts.test="vitest run"
```

- [ ] **Step 2: 픽스처 — 실패하는 테스트**

`spikes/lab/src/perf/fixtures.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { TS_SAMPLE, makeCodeFixture, makeLogFixture, makeSingleLineJson } from "./fixtures";

describe("fixtures", () => {
  it("code fixture reaches the target size without overshooting by more than one sample", () => {
    const text = makeCodeFixture(100_000);
    expect(text.length).toBeGreaterThanOrEqual(100_000);
    expect(text.length).toBeLessThan(100_000 + TS_SAMPLE.length);
  });

  it("json fixture is one valid line", () => {
    const text = makeSingleLineJson(100_000);
    expect(text.length).toBeGreaterThanOrEqual(100_000);
    expect(text.includes("\n")).toBe(false);
    expect(Array.isArray(JSON.parse(text))).toBe(true);
  });

  it("log fixture has exactly the requested line count", () => {
    expect(makeLogFixture(1_000).split("\n")).toHaveLength(1_000);
  });
});
```

Run: `(cd spikes/lab && pnpm test)`
Expected: FAIL — `./fixtures` 를 찾을 수 없다.

- [ ] **Step 3: 픽스처 구현**

`spikes/lab/src/perf/fixtures.ts`:

```ts
export const TS_SAMPLE = `/**
 * Block comment that spans lines so chunk boundaries land inside it.
 */
export interface Memo<T extends string = string> {
  id: T;
  title: string;
  tags: readonly string[];
}

const template = \`multi-line
template \${1 + 2} string\`;

export class Store<T extends string> {
  private readonly items = new Map<T, Memo<T>>();

  add(memo: Memo<T>): void {
    if (this.items.has(memo.id)) throw new Error(\`duplicate \${memo.id}\`);
    this.items.set(memo.id, memo);
  }

  find(predicate: (m: Memo<T>) => boolean): Memo<T> | undefined {
    for (const m of this.items.values()) if (predicate(m)) return m;
    return undefined;
  }
}

// line comment with 한글 text
export const sizes = [1, 2, 3].map((n) => n * 1024 ** 2);
`;

/** Sizes are in UTF-16 code units, which match bytes for everything here except the Hangul comment. */
export function makeCodeFixture(targetChars: number): string {
  const parts: string[] = [];
  let length = 0;
  while (length < targetChars) {
    parts.push(TS_SAMPLE);
    length += TS_SAMPLE.length;
  }
  return parts.join("");
}

export function makeSingleLineJson(targetChars: number): string {
  const items: string[] = [];
  let length = 2;
  for (let i = 0; length < targetChars; i++) {
    const item = JSON.stringify({
      id: i,
      title: `memo ${i}`,
      tags: ["a", "b"],
      body: "lorem ipsum dolor sit amet",
    });
    items.push(item);
    length += item.length + 1;
  }
  return `[${items.join(",")}]`;
}

export function makeLogFixture(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const level = i % 10 === 0 ? "ERROR" : i % 3 === 0 ? "WARN" : "INFO";
    const second = String(i % 60).padStart(2, "0");
    lines.push(
      `2026-01-01T00:00:${second}.000Z ${level} worker-${i % 8} processed request id=${i} in ${i % 97}ms`,
    );
  }
  return lines.join("\n");
}
```

Run: `(cd spikes/lab && pnpm test)`
Expected: `3 passed`.

- [ ] **Step 4: 청크 토크나이저 — 실패하는 테스트**

`spikes/lab/src/perf/chunked-tokenizer.test.ts`:

```ts
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { beforeAll, describe, expect, it } from "vitest";

import { ChunkedTokenizer } from "./chunked-tokenizer";

let hl: HighlighterCore;

beforeAll(async () => {
  hl = await createHighlighterCore({
    themes: [import("@shikijs/themes/github-dark")],
    langs: [import("@shikijs/langs/typescript")],
    engine: createJavaScriptRegexEngine(),
  });
});

const OPTS = { lang: "typescript", theme: "github-dark", chunkLines: 2 };
// With chunkLines 2 the comment opens in chunk 0 (line 1) and continues into chunk 1 (lines 2-3).
const DOC = ["const a = 1;", "/* start", "still comment", "end */", "const b = 2;"].join("\n");

function firstColor(tk: ChunkedTokenizer, line: number): string | undefined {
  return tk.tokens(line, line + 1)[0][0].color;
}

describe("ChunkedTokenizer", () => {
  it("keeps a block comment's color across a chunk boundary", () => {
    const tk = new ChunkedTokenizer(hl, DOC, OPTS);
    const commentColor = firstColor(tk, 1);
    expect(firstColor(tk, 2)).toBe(commentColor);
    expect(firstColor(tk, 4)).not.toBe(commentColor);
  });

  it("recomputes later chunks after an edit removes the comment opener", () => {
    const tk = new ChunkedTokenizer(hl, DOC, OPTS);
    const commentColor = firstColor(tk, 1);
    expect(firstColor(tk, 2)).toBe(commentColor);
    tk.edit(1, 2, ["// line comment"]);
    expect(firstColor(tk, 2)).not.toBe(commentColor);
  });

  it("does not tokenize lines longer than the limit", () => {
    const tk = new ChunkedTokenizer(hl, "x".repeat(30_000), { ...OPTS, maxLineLength: 20_000 });
    const [line] = tk.tokens(0, 1);
    expect(line).toHaveLength(1);
    expect(line[0].content).toHaveLength(30_000);
  });

  it("reports offsets relative to the line start", () => {
    const tk = new ChunkedTokenizer(hl, "x\nconst value = 42;", OPTS);
    const [line] = tk.tokens(1, 2);
    let expected = 0;
    for (const t of line) {
      expect(t.offset).toBe(expected);
      expected += t.content.length;
    }
    expect(expected).toBe("const value = 42;".length);
  });
});
```

Run: `(cd spikes/lab && pnpm test)`
Expected: FAIL — `./chunked-tokenizer` 를 찾을 수 없다.

- [ ] **Step 5: 청크 토크나이저 구현**

`spikes/lab/src/perf/chunked-tokenizer.ts`:

```ts
import type { GrammarState, HighlighterCore, ThemedToken } from "shiki/core";

export const DEFAULT_CHUNK_LINES = 200;
export const MAX_TOKENIZED_LINE_LENGTH = 20_000;

export interface LineToken {
  content: string;
  /** Offset from the start of the line, not of the chunk Shiki tokenized. */
  offset: number;
  color?: string;
}

export interface ChunkedTokenizerOptions {
  lang: string;
  theme: string;
  chunkLines?: number;
  maxLineLength?: number;
}

/**
 * Tokenizes in fixed line chunks and caches the grammar state at each chunk start, so a request
 * deep in the file re-tokenizes only from the last valid chunk, and constructs opened in one chunk
 * (block comments, template strings) keep their color in the next.
 */
export class ChunkedTokenizer {
  private lines: string[];
  // states[k] is the grammar state at the start of chunk k; undefined is the initial state.
  private states: (GrammarState | undefined)[] = [undefined];
  private readonly chunkLines: number;
  private readonly maxLineLength: number;

  constructor(
    private readonly hl: HighlighterCore,
    text: string,
    private readonly opts: ChunkedTokenizerOptions,
  ) {
    this.lines = text.split("\n");
    this.chunkLines = opts.chunkLines ?? DEFAULT_CHUNK_LINES;
    this.maxLineLength = opts.maxLineLength ?? MAX_TOKENIZED_LINE_LENGTH;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** Replaces lines [fromLine, toLine) with `insert` and drops every cached state the edit can affect. */
  edit(fromLine: number, toLine: number, insert: string[]): void {
    this.lines = this.lines.slice(0, fromLine).concat(insert, this.lines.slice(toLine));
    this.states.length = Math.min(this.states.length, Math.floor(fromLine / this.chunkLines) + 1);
  }

  /** Tokens for lines [from, to). */
  tokens(from: number, to: number): LineToken[][] {
    const chunk = Math.floor(from / this.chunkLines);
    this.ensureStates(chunk);
    const start = chunk * this.chunkLines;
    const raw = this.tokenize(this.lines.slice(start, to).join("\n"), this.states[chunk]);
    return raw.slice(from - start).map(toLineTokens);
  }

  private ensureStates(chunk: number): void {
    while (this.states.length <= chunk) {
      const k = this.states.length - 1;
      const text = this.lines.slice(k * this.chunkLines, (k + 1) * this.chunkLines).join("\n");
      this.states.push(this.hl.getLastGrammarState(this.tokenize(text, this.states[k])));
    }
  }

  private tokenize(text: string, grammarState: GrammarState | undefined): ThemedToken[][] {
    return this.hl.codeToTokensBase(text, {
      lang: this.opts.lang,
      theme: this.opts.theme,
      grammarState,
      tokenizeMaxLineLength: this.maxLineLength,
    });
  }
}

function toLineTokens(line: ThemedToken[]): LineToken[] {
  let offset = 0;
  return line.map((t) => {
    const token = { content: t.content, offset, color: t.color };
    offset += t.content.length;
    return token;
  });
}
```

Run: `(cd spikes/lab && pnpm test)`
Expected: `7 passed` (fixtures 3 + tokenizer 4). **실행 개수를 확인한다.**

- [ ] **Step 6: Worker 프로토콜과 Worker**

`spikes/lab/src/perf/worker-protocol.ts`:

```ts
import type { LineToken } from "./chunked-tokenizer";

export type Engine = "javascript" | "oniguruma";
export type Lang = "typescript" | "json" | "log";

export type WorkerRequest =
  | {
      type: "throughput";
      id: number;
      label: string;
      engine: Engine;
      lang: Lang;
      text: string;
      maxLineLength: number;
    }
  | { type: "open"; engine: Engine; lang: Lang; text: string }
  | { type: "edit"; fromLine: number; toLine: number; insert: string[] }
  | { type: "tokens"; reqId: number; from: number; to: number };

export interface ThroughputResult {
  type: "throughput-result";
  id: number;
  label: string;
  engine: Engine;
  lang: Lang;
  lines: number;
  firstViewportMs: number;
  fullMs: number;
  linesPerSec: number;
  viewportTokens: number;
}

export type WorkerReply =
  | ThroughputResult
  | { type: "tokens-result"; reqId: number; from: number; lines: LineToken[][] }
  | { type: "error"; message: string };
```

`spikes/lab/src/perf/highlight-worker.ts`:

```ts
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

import { ChunkedTokenizer } from "./chunked-tokenizer";
import type { Engine, WorkerReply, WorkerRequest } from "./worker-protocol";

const THEME = "github-dark";
const highlighters = new Map<Engine, Promise<HighlighterCore>>();
let live: ChunkedTokenizer | null = null;

function highlighter(engine: Engine): Promise<HighlighterCore> {
  let hl = highlighters.get(engine);
  if (!hl) {
    hl = createHighlighterCore({
      themes: [import("@shikijs/themes/github-dark")],
      langs: [
        import("@shikijs/langs/typescript"),
        import("@shikijs/langs/json"),
        import("@shikijs/langs/log"),
      ],
      engine:
        engine === "javascript"
          ? createJavaScriptRegexEngine()
          : createOnigurumaEngine(import("shiki/wasm")),
    });
    highlighters.set(engine, hl);
  }
  return hl;
}

// The DOM lib types `self` as Window, whose postMessage wants a target origin; a worker's does not.
const reply = (msg: WorkerReply) =>
  (self as unknown as { postMessage(m: WorkerReply): void }).postMessage(msg);

// Handled strictly in order so an `edit` can never interleave with a `tokens` request.
let queue: Promise<void> = Promise.resolve();
self.addEventListener("message", (e: MessageEvent<WorkerRequest>) => {
  queue = queue
    .then(() => handle(e.data))
    .catch((err: unknown) => reply({ type: "error", message: String(err) }));
});

async function handle(req: WorkerRequest): Promise<void> {
  switch (req.type) {
    case "throughput": {
      const hl = await highlighter(req.engine);
      const t0 = performance.now();
      const tk = new ChunkedTokenizer(hl, req.text, {
        lang: req.lang,
        theme: THEME,
        maxLineLength: req.maxLineLength,
      });
      const viewport = tk.tokens(0, 100);
      const firstViewportMs = performance.now() - t0;
      // Asking for the last lines forces every chunk state, i.e. a jump to the end of the file.
      tk.tokens(Math.max(0, tk.lineCount - 100), tk.lineCount);
      const fullMs = performance.now() - t0;
      reply({
        type: "throughput-result",
        id: req.id,
        label: req.label,
        engine: req.engine,
        lang: req.lang,
        lines: tk.lineCount,
        firstViewportMs,
        fullMs,
        linesPerSec: tk.lineCount / (fullMs / 1000),
        viewportTokens: viewport.reduce((n, l) => n + l.length, 0),
      });
      return;
    }
    case "open":
      live = new ChunkedTokenizer(await highlighter(req.engine), req.text, {
        lang: req.lang,
        theme: THEME,
      });
      return;
    case "edit":
      live?.edit(req.fromLine, req.toLine, req.insert);
      return;
    case "tokens":
      if (live) {
        reply({
          type: "tokens-result",
          reqId: req.reqId,
          from: req.from,
          lines: live.tokens(req.from, req.to),
        });
      }
      return;
  }
}
```

- [ ] **Step 7: 처리량 측정과 라우팅**

`spikes/lab/src/perf/throughput.ts`:

```ts
import { exitApp, recordResult } from "../lab-api";
import { MAX_TOKENIZED_LINE_LENGTH } from "./chunked-tokenizer";
import { makeCodeFixture, makeLogFixture, makeSingleLineJson } from "./fixtures";
import type { Engine, Lang, ThroughputResult, WorkerReply, WorkerRequest } from "./worker-protocol";

interface Case {
  label: string;
  lang: Lang;
  text: () => string;
  maxLineLength: number;
}

const CASES: Case[] = [
  {
    label: "code-1mb",
    lang: "typescript",
    text: () => makeCodeFixture(1_000_000),
    maxLineLength: MAX_TOKENIZED_LINE_LENGTH,
  },
  {
    label: "code-10mb",
    lang: "typescript",
    text: () => makeCodeFixture(10_000_000),
    maxLineLength: MAX_TOKENIZED_LINE_LENGTH,
  },
  {
    label: "json-10mb-one-line",
    lang: "json",
    text: () => makeSingleLineJson(10_000_000),
    maxLineLength: MAX_TOKENIZED_LINE_LENGTH,
  },
  // Same file without the line-length guard, to show what the 20,000-char limit protects against.
  {
    label: "json-10mb-one-line-nolimit",
    lang: "json",
    text: () => makeSingleLineJson(10_000_000),
    maxLineLength: 0,
  },
  {
    label: "log-100k",
    lang: "log",
    text: () => makeLogFixture(100_000),
    maxLineLength: MAX_TOKENIZED_LINE_LENGTH,
  },
];

const ENGINES: Engine[] = ["javascript", "oniguruma"];

type ThroughputRequest = Extract<WorkerRequest, { type: "throughput" }>;

function call(worker: Worker, req: ThroughputRequest): Promise<ThroughputResult> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
    };
    const onMessage = (e: MessageEvent<WorkerReply>) => {
      if (e.data.type === "throughput-result" && e.data.id === req.id) {
        done();
        resolve(e.data);
      } else if (e.data.type === "error") {
        done();
        reject(new Error(e.data.message));
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("timeout after 120s"));
    }, 120_000);
    worker.addEventListener("message", onMessage);
    worker.postMessage(req);
  });
}

export async function runThroughputAuto(): Promise<void> {
  const worker = new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module" });
  const results: unknown[] = [];
  let id = 0;
  for (const engine of ENGINES) {
    for (const c of CASES) {
      const req: ThroughputRequest = {
        type: "throughput",
        id: ++id,
        label: c.label,
        engine,
        lang: c.lang,
        text: c.text(),
        maxLineLength: c.maxLineLength,
      };
      results.push(
        await call(worker, req).catch((err: unknown) => ({
          label: c.label,
          engine,
          error: String(err),
        })),
      );
    }
  }
  worker.terminate();
  await recordResult("throughput", { userAgent: navigator.userAgent, results });
  await exitApp();
}
```

`spikes/lab/src/main.ts`:

```ts
import { exitApp, labEnv, recordResult } from "./lab-api";
import { runThroughputAuto } from "./perf/throughput";
import { runViewerAuto } from "./viewer/host";

const app = document.querySelector<HTMLDivElement>("#app")!;

async function main(): Promise<void> {
  const env = await labEnv();
  switch (env.auto) {
    case "ping":
      await recordResult("ping", { ok: true, userAgent: navigator.userAgent });
      return exitApp();
    case "viewer":
      return runViewerAuto(env);
    case "throughput":
      return runThroughputAuto();
  }
  app.innerHTML = `<h1>tote lab</h1><p>측정용 실험 앱이다. 제품 코드가 아니다.</p>`;
}

main().catch(async (err) => {
  app.textContent = String(err);
  console.error(err);
  // An auto run must never hang the caller; record the error and leave.
  const env = await labEnv().catch(() => null);
  if (env?.auto) {
    await recordResult(`error-${env.auto}`, { error: String(err) }).catch(() => undefined);
    await exitApp();
  }
});
```

- [ ] **Step 8: 빌드와 자동 실행**

```bash
cd spikes/lab
pnpm test
pnpm build
pnpm tauri build --debug --no-bundle
TOTE_LAB_AUTO=throughput perl -e 'alarm shift; exec @ARGV' 1500 ./src-tauri/target/debug/lab; echo "exit=$?"
cat results/throughput.json
```

Expected: `pnpm test` 가 `7 passed`, `exit=0`, `results/throughput.json` 에 10건(엔진 2 × 케이스 5)이 있다. 일부가 `error` 여도 기록됐으면 태스크는 끝난 것이다. 어느 엔진이 어떤 문법에서 실패했는지는 Task 7 이 판정한다.

- [ ] **Step 9: 커밋**

```bash
pnpm exec oxfmt spikes/lab
git add spikes/lab/package.json spikes/lab/pnpm-lock.yaml spikes/lab/src/perf spikes/lab/src/main.ts
git status --short
git commit -m "feat(spikes): chunked TextMate tokenizer in a worker and throughput measurement"
```

---

### Task 5: 편집기 하이라이트 연결, 입력 지연 화면, IME 화면

**Files:**

- Modify: `spikes/lab/package.json` (의존성)
- Create: `spikes/lab/src/perf/stats.ts`, `spikes/lab/src/perf/stats.test.ts`
- Create: `spikes/lab/src/perf/shiki-decorations.ts`
- Create: `spikes/lab/src/perf/latency-page.ts`, `spikes/lab/src/perf/smoke.ts`
- Create: `spikes/lab/src/ime/ime-page.ts`
- Replace: `spikes/lab/src/main.ts`

**Interfaces:**

- Consumes: Worker 메시지 `open`·`edit`·`tokens`(Task 4), `Engine`·`Lang`·`WorkerReply`(`worker-protocol.ts`), 픽스처 함수(Task 4), `recordResult`·`exitApp`·`labEnv`.
- Produces (`stats.ts`): `percentile(sorted: number[], p: number): number`, `summarize(samples: number[]): { count: number; p50: number; p95: number; max: number }`.
- Produces (`shiki-decorations.ts`): `workerHighlighting(worker: Worker, engine: Engine, lang: Lang): Extension`, `highlightCount(view: EditorView): number`, `decorationsIn(view: EditorView, from: number, to: number): number`.
- Produces (`latency-page.ts`): `openEditor(parent, text, engine, lang): Promise<OpenedEditor>`, `mountLatencyPage(root: HTMLElement): void`.
- Produces (`smoke.ts`): `runSmokeAuto(parent: HTMLElement): Promise<void>` — `results/smoke.json`.
- Produces (`ime-page.ts`): `mountImePage(root: HTMLElement): void` — `results/ime.json`.

- [ ] **Step 1: 의존성**

```bash
cd spikes/lab
pnpm add codemirror @codemirror/state @codemirror/view
```

- [ ] **Step 2: 통계 — 실패하는 테스트**

`spikes/lab/src/perf/stats.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { percentile, summarize } from "./stats";

describe("stats", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("uses nearest-rank percentiles", () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 95)).toBe(95);
    expect(percentile(oneToHundred, 100)).toBe(100);
  });

  it("returns NaN for no samples instead of a misleading zero", () => {
    expect(percentile([], 50)).toBeNaN();
    expect(summarize([]).count).toBe(0);
  });

  it("summarize sorts unsorted samples", () => {
    expect(summarize([30, 10, 20])).toEqual({ count: 3, p50: 20, p95: 30, max: 30 });
  });
});
```

Run: `(cd spikes/lab && pnpm test)`
Expected: FAIL — `./stats` 를 찾을 수 없다.

- [ ] **Step 3: 통계 구현**

`spikes/lab/src/perf/stats.ts`:

```ts
/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function summarize(samples: number[]): {
  count: number;
  p50: number;
  p95: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : Number.NaN,
  };
}
```

Run: `(cd spikes/lab && pnpm test)`
Expected: `10 passed` (Task 4 의 7 + 3).

- [ ] **Step 4: CodeMirror ↔ Worker 하이라이트**

`spikes/lab/src/perf/shiki-decorations.ts`:

```ts
import { type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import type { Engine, Lang, WorkerReply } from "./worker-protocol";

const setHighlight = StateEffect.define<DecorationSet>();

// Decorations live in a field so the async worker reply can replace them with a plain dispatch,
// and edits in between just map the old ones instead of dropping all color.
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setHighlight)) return e.value;
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const highlightCount = (view: EditorView): number => view.state.field(highlightField).size;

export function decorationsIn(view: EditorView, from: number, to: number): number {
  let count = 0;
  view.state.field(highlightField).between(from, to, () => {
    count++;
  });
  return count;
}

type TokensReply = Extract<WorkerReply, { type: "tokens-result" }>;

export function workerHighlighting(worker: Worker, engine: Engine, lang: Lang): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private version = 0;
      private reqId = 0;
      private pending: { reqId: number; version: number } | null = null;
      private timer: ReturnType<typeof setTimeout> | null = null;

      constructor(private readonly view: EditorView) {
        worker.postMessage({ type: "open", engine, lang, text: view.state.doc.toString() });
        worker.addEventListener("message", this.onMessage);
        this.schedule();
      }

      update(u: ViewUpdate): void {
        if (u.docChanged) {
          this.version++;
          this.sendEdit(u);
        }
        if (u.docChanged || u.viewportChanged) this.schedule();
      }

      destroy(): void {
        worker.removeEventListener("message", this.onMessage);
        if (this.timer) clearTimeout(this.timer);
      }

      private onMessage = (e: MessageEvent<WorkerReply>): void => {
        const pending = this.pending;
        if (e.data.type !== "tokens-result" || !pending || e.data.reqId !== pending.reqId) return;
        const stale = pending.version !== this.version;
        this.pending = null;
        // Tokens for an older document would land on the wrong characters; ask again instead.
        if (stale) return this.schedule();
        this.view.dispatch({ effects: setHighlight.of(this.build(e.data)) });
      };

      // One edit message per transaction: replace the old line span covering every change
      // with the new line span, which also stays correct for multi-cursor edits.
      private sendEdit(u: ViewUpdate): void {
        let fromA = Infinity;
        let toA = -1;
        let fromB = Infinity;
        let toB = -1;
        u.changes.iterChangedRanges((fa, ta, fb, tb) => {
          fromA = Math.min(fromA, fa);
          toA = Math.max(toA, ta);
          fromB = Math.min(fromB, fb);
          toB = Math.max(toB, tb);
        });
        const oldDoc = u.startState.doc;
        const newDoc = u.state.doc;
        const firstLine = newDoc.lineAt(fromB).number;
        const lastLine = newDoc.lineAt(toB).number;
        worker.postMessage({
          type: "edit",
          fromLine: oldDoc.lineAt(fromA).number - 1,
          toLine: oldDoc.lineAt(toA).number,
          insert: newDoc
            .sliceString(newDoc.line(firstLine).from, newDoc.line(lastLine).to)
            .split("\n"),
        });
      }

      private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.request(), 30);
      }

      private request(): void {
        const doc = this.view.state.doc;
        const { from, to } = this.view.viewport;
        this.pending = { reqId: ++this.reqId, version: this.version };
        worker.postMessage({
          type: "tokens",
          reqId: this.reqId,
          from: doc.lineAt(from).number - 1,
          to: doc.lineAt(to).number,
        });
      }

      private build(reply: TokensReply): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = this.view.state.doc;
        reply.lines.forEach((tokens, i) => {
          const lineNo = reply.from + i + 1;
          if (lineNo > doc.lines) return;
          const line = doc.line(lineNo);
          for (const t of tokens) {
            if (!t.color || t.content.length === 0) continue;
            const from = line.from + t.offset;
            const to = Math.min(from + t.content.length, line.to);
            if (from < to)
              builder.add(from, to, Decoration.mark({ attributes: { style: `color:${t.color}` } }));
          }
        });
        return builder.finish();
      }
    },
  );
  return [highlightField, plugin];
}
```

- [ ] **Step 5: 입력 지연 화면과 스모크**

`spikes/lab/src/perf/latency-page.ts`:

```ts
import { EditorView, basicSetup } from "codemirror";

import { recordResult } from "../lab-api";
import { makeCodeFixture, makeLogFixture, makeSingleLineJson } from "./fixtures";
import { workerHighlighting } from "./shiki-decorations";
import { summarize } from "./stats";
import type { Engine, Lang } from "./worker-protocol";

export const LATENCY_FIXTURES: Record<string, { lang: Lang; make: () => string }> = {
  "code-10mb": { lang: "typescript", make: () => makeCodeFixture(10_000_000) },
  "json-10mb-one-line": { lang: "json", make: () => makeSingleLineJson(10_000_000) },
  "log-100k": { lang: "log", make: () => makeLogFixture(100_000) },
};

export interface OpenedEditor {
  view: EditorView;
  openMs: number;
  destroy(): void;
}

/** Resolves after the first frame following creation; falls back to 1s when frames are throttled. */
export function openEditor(
  parent: HTMLElement,
  text: string,
  engine: Engine,
  lang: Lang,
): Promise<OpenedEditor> {
  const worker = new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module" });
  const t0 = performance.now();
  const view = new EditorView({
    doc: text,
    parent,
    extensions: [basicSetup, workerHighlighting(worker, engine, lang)],
  });
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve({
        view,
        openMs: performance.now() - t0,
        destroy() {
          view.destroy();
          worker.terminate();
        },
      });
    };
    requestAnimationFrame(done);
    setTimeout(done, 1_000);
  });
}

interface Session {
  editor: OpenedEditor;
  fixture: string;
  engine: Engine;
  keys: number[];
  frames: number[];
  stop(): void;
}

export function mountLatencyPage(root: HTMLElement): void {
  root.innerHTML = `
    <h1>입력 지연 측정</h1>
    <p>파일과 엔진을 고르고 「열기」. 편집기를 눌러 20초 이상 타이핑(영문·한글 섞어서)하고, 위아래로 크게 스크롤한 뒤 「저장」. 창을 다른 창으로 가리지 않는다.</p>
    <select id="lat-fixture">${Object.keys(LATENCY_FIXTURES)
      .map((k) => `<option>${k}</option>`)
      .join("")}</select>
    <select id="lat-engine"><option>javascript</option><option>oniguruma</option></select>
    <button id="lat-open">열기</button> <button id="lat-save">저장</button>
    <pre id="lat-stats"></pre>
    <div id="lat-editor" style="height:65vh;border:1px solid #888;overflow:hidden"></div>`;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  let current: Session | null = null;

  const snapshot = (s: Session) => ({
    fixture: s.fixture,
    engine: s.engine,
    openMs: s.editor.openMs,
    keys: summarize(s.keys),
    scrollFrames: s.frames.length,
    scrollFramesOver25ms: s.frames.filter((f) => f > 25).length,
  });

  $("#lat-open").addEventListener("click", async () => {
    current?.stop();
    current = null;
    const fixture = $<HTMLSelectElement>("#lat-fixture").value;
    const engine = $<HTMLSelectElement>("#lat-engine").value as Engine;
    const { lang, make } = LATENCY_FIXTURES[fixture];
    $("#lat-stats").textContent = "여는 중…";
    const editor = await openEditor($("#lat-editor"), make(), engine, lang);
    const keys: number[] = [];
    const frames: number[] = [];
    const session: Session = { editor, fixture, engine, keys, frames, stop: () => undefined };
    const render = () => {
      $("#lat-stats").textContent = JSON.stringify(snapshot(session), null, 2);
    };
    editor.view.contentDOM.addEventListener("keydown", (e) => {
      const start = e.timeStamp;
      // rAF runs right before the paint; the timeout lands just after it.
      requestAnimationFrame(() =>
        setTimeout(() => {
          keys.push(performance.now() - start);
          render();
        }, 0),
      );
    });
    let lastScroll = -Infinity;
    editor.view.scrollDOM.addEventListener("scroll", () => {
      lastScroll = performance.now();
    });
    let prev = performance.now();
    let raf = 0;
    const loop = (t: number) => {
      if (t - lastScroll < 100) frames.push(t - prev);
      prev = t;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    session.stop = () => {
      cancelAnimationFrame(raf);
      editor.destroy();
    };
    current = session;
    render();
  });

  $("#lat-save").addEventListener("click", async () => {
    if (!current) return;
    await recordResult(`latency-${current.fixture}-${current.engine}`, {
      userAgent: navigator.userAgent,
      ...snapshot(current),
      keySamples: current.keys,
    });
    $("#lat-stats").textContent += "\n저장됨";
  });
}
```

`spikes/lab/src/perf/smoke.ts`:

```ts
import { exitApp, recordResult } from "../lab-api";
import { makeCodeFixture } from "./fixtures";
import { openEditor } from "./latency-page";
import { decorationsIn, highlightCount } from "./shiki-decorations";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (pred()) return true;
    await wait(50);
  }
  return pred();
}

const INSERT = "/* edit */\n";

/** Proves the editor ↔ worker pipeline end to end without a human: open, highlight, edit, re-highlight. */
export async function runSmokeAuto(parent: HTMLElement): Promise<void> {
  const editor = await openEditor(parent, makeCodeFixture(10_000_000), "javascript", "typescript");
  const highlightedOnOpen = await waitFor(() => highlightCount(editor.view) > 0, 15_000);
  const before = editor.view.state.doc.length;
  for (let i = 0; i < 20; i++) {
    editor.view.dispatch({ changes: { from: 0, insert: INSERT } });
  }
  // Mapped old marks never cover text inserted at their start, so color here must come from a fresh reply.
  const insertedTextHighlighted = await waitFor(
    () => decorationsIn(editor.view, 0, INSERT.length) > 0,
    15_000,
  );
  await recordResult("smoke", {
    userAgent: navigator.userAgent,
    openMs: editor.openMs,
    highlightedOnOpen,
    insertedTextHighlighted,
    docGrewBy: editor.view.state.doc.length - before,
    decorations: highlightCount(editor.view),
  });
  editor.destroy();
  await exitApp();
}
```

- [ ] **Step 6: IME 화면**

`spikes/lab/src/ime/ime-page.ts`:

```ts
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";

import { recordResult } from "../lab-api";

interface Scenario {
  id: string;
  title: string;
  instruction: string;
  doc: string;
  selection: EditorSelection;
  expected: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: "plain",
    title: "빈 문서 입력",
    instruction: "「안녕하세요 한글 입력 테스트」를 입력한다",
    doc: "",
    selection: EditorSelection.single(0),
    expected: "안녕하세요 한글 입력 테스트",
  },
  {
    id: "middle",
    title: "문장 중간 삽입",
    instruction: "커서 자리에 「가운데 」(끝 공백 포함)를 입력한다",
    doc: "앞 뒤",
    selection: EditorSelection.single(2),
    expected: "앞 가운데 뒤",
  },
  {
    id: "multicursor",
    title: "멀티커서 3개",
    instruction: "세 줄 끝에 커서가 있는 상태에서 「한글」을 입력한다",
    doc: "하나\n둘\n셋",
    selection: EditorSelection.create([
      EditorSelection.cursor(2),
      EditorSelection.cursor(4),
      EditorSelection.cursor(6),
    ]),
    expected: "하나한글\n둘한글\n셋한글",
  },
  {
    id: "arrow-commit",
    title: "조합 중 화살표",
    instruction: "「한」만 입력하고(조합 중) → 키를 누른 뒤 「글」을 입력한다",
    doc: "",
    selection: EditorSelection.single(0),
    expected: "한글",
  },
  {
    id: "brackets",
    title: "괄호 자동 닫기",
    instruction: "「(」를 입력하고 이어서 「한글」을 입력한다",
    doc: "",
    selection: EditorSelection.single(0),
    expected: "(한글)",
  },
  {
    id: "enter",
    title: "조합 직후 Enter",
    instruction: "「한글」을 입력하고 바로 Enter, 이어서 「끝」을 입력한다",
    doc: "",
    selection: EditorSelection.single(0),
    expected: "한글\n끝",
  },
  {
    id: "replace-selections",
    title: "다중 선택 덮어쓰기",
    instruction: "두 「foo」가 선택된 상태에서 「가」를 입력한다",
    doc: "foo bar foo",
    selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 11)]),
    expected: "가 bar 가",
  },
];

export function mountImePage(root: HTMLElement): void {
  root.innerHTML = `
    <h1>한글 IME 검사</h1>
    <p>각 항목의 「시작」 → 지시대로 입력 → 「확인」. 모두 끝나면 「결과 저장」.</p>
    <div id="ime-list"></div>
    <div id="ime-editor" style="border:1px solid #888;height:200px;margin:8px 0"></div>
    <button id="ime-save">결과 저장</button>
    <pre id="ime-out"></pre>`;
  const view = new EditorView({
    parent: root.querySelector<HTMLElement>("#ime-editor")!,
    extensions: [basicSetup],
  });
  const results: Record<string, { pass: boolean; actual: string; expected: string }> = {};
  const list = root.querySelector<HTMLElement>("#ime-list")!;

  for (const s of SCENARIOS) {
    const row = document.createElement("div");
    row.innerHTML = `<b>${s.title}</b>: ${s.instruction} <button data-act="start">시작</button> <button data-act="check">확인</button> <span data-role="status"></span>`;
    row.querySelector('[data-act="start"]')!.addEventListener("click", () => {
      view.setState(
        EditorState.create({ doc: s.doc, selection: s.selection, extensions: [basicSetup] }),
      );
      view.focus();
    });
    row.querySelector('[data-act="check"]')!.addEventListener("click", () => {
      const actual = view.state.doc.toString();
      results[s.id] = { pass: actual === s.expected, actual, expected: s.expected };
      row.querySelector('[data-role="status"]')!.textContent = results[s.id].pass
        ? "통과"
        : `실패: ${JSON.stringify(actual)}`;
    });
    list.append(row);
  }

  root.querySelector("#ime-save")!.addEventListener("click", async () => {
    await recordResult("ime", { userAgent: navigator.userAgent, results });
    root.querySelector("#ime-out")!.textContent = JSON.stringify(results, null, 2);
  });
}
```

- [ ] **Step 7: 라우팅**

`spikes/lab/src/main.ts`:

```ts
import { mountImePage } from "./ime/ime-page";
import { exitApp, labEnv, recordResult } from "./lab-api";
import { mountLatencyPage } from "./perf/latency-page";
import { runSmokeAuto } from "./perf/smoke";
import { runThroughputAuto } from "./perf/throughput";
import { runViewerAuto } from "./viewer/host";

const app = document.querySelector<HTMLDivElement>("#app")!;
window.addEventListener("hashchange", () => location.reload());

async function main(): Promise<void> {
  const env = await labEnv();
  switch (env.auto) {
    case "ping":
      await recordResult("ping", { ok: true, userAgent: navigator.userAgent });
      return exitApp();
    case "viewer":
      return runViewerAuto(env);
    case "throughput":
      return runThroughputAuto();
    case "smoke":
      return runSmokeAuto(app);
  }
  if (location.hash === "#latency") return mountLatencyPage(app);
  if (location.hash === "#ime") return mountImePage(app);
  app.innerHTML = `
    <h1>tote lab</h1>
    <p>측정용 실험 앱이다. 제품 코드가 아니다.</p>
    <ul>
      <li><a href="#latency">입력 지연 측정</a></li>
      <li><a href="#ime">한글 IME 검사</a></li>
    </ul>`;
}

main().catch(async (err) => {
  app.textContent = String(err);
  console.error(err);
  // An auto run must never hang the caller; record the error and leave.
  const env = await labEnv().catch(() => null);
  if (env?.auto) {
    await recordResult(`error-${env.auto}`, { error: String(err) }).catch(() => undefined);
    await exitApp();
  }
});
```

- [ ] **Step 8: 빌드와 스모크**

```bash
cd spikes/lab
pnpm test
pnpm build
pnpm tauri build --debug --no-bundle
TOTE_LAB_AUTO=smoke perl -e 'alarm shift; exec @ARGV' 180 ./src-tauri/target/debug/lab; echo "exit=$?"
cat results/smoke.json
```

Expected: `pnpm test` 가 `10 passed`, `exit=0`, `smoke.json` 에서 `highlightedOnOpen: true`, `insertedTextHighlighted: true`, `docGrewBy: 220`. **이 셋은 파이프라인이 동작한다는 증거라 측정값과 달리 통과 조건이다.** `false` 면 `shiki-decorations.ts` 나 Worker 를 고쳐 다시 돌린다.

- [ ] **Step 9: 커밋**

```bash
pnpm exec oxfmt spikes/lab
git add spikes/lab/package.json spikes/lab/pnpm-lock.yaml spikes/lab/src/perf spikes/lab/src/ime spikes/lab/src/main.ts
git status --short
git commit -m "feat(spikes): editor highlighting via worker, latency and IME pages"
```

---

### Task 6: 사람이 하는 측정

이 태스크는 **사람**이 한다. 메인 세션은 아래를 사람에게 그대로 전달하고, 끝났다는 답을 받은 뒤 Task 7 로 넘어간다. 약 10분 걸린다.

**Files:** 없음(결과 파일만 생긴다: `spikes/lab/results/latency-*.json`, `spikes/lab/results/ime.json`).

- [ ] **Step 1: 앱 실행**

워크트리의 `spikes/lab` 에서:

```bash
./src-tauri/target/debug/lab
```

창이 뜨면 앞으로 가져오고, 다른 창으로 가리지 않는다.

- [ ] **Step 2: 입력 지연 (「입력 지연 측정」 링크)**

아래 네 조합마다: 파일·엔진 선택 → 「열기」 → 편집기를 눌러 **20초 이상 타이핑(영문·한글 섞어서)** → 위아래로 크게 스크롤 → 「저장」.

1. `code-10mb` + `javascript`
2. `code-10mb` + `oniguruma`
3. `json-10mb-one-line` + `javascript`
4. `log-100k` + `javascript`

체감도 한 줄씩 메모해 둔다(끊김, 색이 늦게 칠해짐 등). Task 7 보고서에 들어간다.

- [ ] **Step 3: 한글 IME (메뉴로 돌아가 「한글 IME 검사」 링크)**

7개 항목 각각 「시작」 → 지시대로 입력 → 「확인」. 모두 끝나면 「결과 저장」. 실패 항목에서 화면에 보인 이상(글자 중복, 커서 튐 등)을 한 줄씩 메모한다.

- [ ] **Step 4: 확인**

```bash
ls spikes/lab/results/
```

Expected: `latency-code-10mb-javascript.json`, `latency-code-10mb-oniguruma.json`, `latency-json-10mb-one-line-javascript.json`, `latency-log-100k-javascript.json`, `ime.json`.

---

### Task 7: 보고서

**Files:**

- Create: `docs/superpowers/reports/<작성일 YYYY-MM-DD>-tote-note-spikes.md`

**Interfaces:**

- Consumes: `spikes/lab/results/*.json`, `spikes/lab/results/viewer-rust.log`, Task 6 에서 사람이 남긴 체감 메모.

- [ ] **Step 1: 판정 기준 적용**

판정은 **된다 / 조건부 / 안 된다** 셋 중 하나로 한다. 기준은 아래로 고정한다(결과를 본 뒤 기준을 바꾸지 않는다).

| 스파이크       | 된다                                                                                                                  | 조건부                                        | 안 된다                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| 뷰어 파일 전달 | 두 영상 모두 `videoSeekOk: true`, 이미지 `[320, 240]`, 격리 항목(IPC·네트워크·부모 접근) 모두 blocked, Range 로그 ≥ 1 | 영상 하나만 되거나, 격리는 되는데 탐색만 실패 | faststart 영상도 안 열리거나, iframe 에서 IPC 가 reachable |
| 편집 성능      | `latency-code-10mb-<빠른 엔진>` 의 `keys.p95` ≤ 16ms 이고 `smoke` 통과                                                | p95 ≤ 33ms                                    | p95 > 33ms                                                 |
| 한글 입력      | `ime.json` 7개 모두 통과                                                                                              | `multicursor`·`replace-selections` 만 실패    | 그 밖의 항목이 하나라도 실패                               |

엔진 선택: 두 엔진 모두 동작한 문법에서는 `throughput.json` 의 `fullMs` 가 작은 쪽을 고르고, 한쪽이 `error` 면 다른 쪽을 고른다.

- [ ] **Step 2: 보고서 작성**

아래 골격을 채운다. 수치는 결과 파일에서 그대로 옮기고, 각 절 끝에 재측정 명령을 적는다. 보고서는 그 시점 기록이라 날짜를 남겨도 된다.

```markdown
# tote-note 검증 스파이크 보고서

환경: (macOS 버전, 기기, `results/ping.json` 의 userAgent)

## 뷰어 파일 전달 — 판정: (된다/조건부/안 된다)

| 항목                                   | faststart | moov 끝 |
| -------------------------------------- | --------- | ------- |
| videoSeekOk                            |           |         |
| videoError                             |           |         |
| imageSize                              |           |         |
| tauriInternalsInFrame / ipcInvoke      |           |         |
| ipcFetch / networkFetch / parentAccess |           |         |

Range 요청 수: (grep 결과)

재측정: `spikes/lab/README.md` 「자동 측정」 의 viewer 명령.

## 편집 성능 — 판정: (…)

(throughput.json 10건 표: label, engine, firstViewportMs, fullMs, linesPerSec 또는 error)
(latency 4건 표: fixture, engine, openMs, keys p50/p95/max, scrollFramesOver25ms / scrollFrames)
(smoke.json 값)
고른 엔진과 이유:
사람의 체감 메모:

재측정: 자동은 `TOTE_LAB_AUTO=throughput`·`smoke`, 수동은 `#latency`.

## 한글 입력 — 판정: (…)

(ime.json 7건 표: id, pass, actual)
사람의 메모:

## 스펙에 반영할 것

각 항목을 「절 제목」 + 넣거나 바꿀 문장으로 적는다. 바꿀 것이 없으면 「없음」.

- 「뷰어」 절:
- 「크기별 단계」 절 (1MB·20MB/30만 줄·100MB 제안값, 엔진 선택):
- 「목표와 측정」 절 (나머지 목표치):
- 「편집기」 절 (IME 결과에 따른 제약):
```

- [ ] **Step 3: 커밋**

```bash
git add docs/superpowers/reports/
git status --short
git commit -m "docs: add tote-note spike report"
```
