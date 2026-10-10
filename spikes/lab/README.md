# tote lab

tote-notes 코어 스펙의 검증 스파이크를 재는 실험 앱이다. 제품 코드가 아니며, 제품 코드는 이 디렉터리를 import 하지 않는다.

이 코드는 측정 하네스이지 제품 설계의 참고 구현이 아니다. 옮겨 쓰기 전에 보고서 「검증하지 않은 것」과 다음을 먼저 본다. 토큰은 회수·만료가 없고, 모든 응답이 `Access-Control-Allow-Origin: *` 다(`file_scheme.rs`). Range 없는 요청은 파일 전체를 메모리로 읽는다. 메인 창에 CSP 가 없다(`tauri.conf.json` 의 `csp: null`). 줄 상태 캐시가 Shiki 의 벽시계 줄당 시간 제한과 함께 돈다(`chunked-tokenizer.ts`, 보고서 「스펙에 반영할 것」 의 「성능」). 쓰지 않는 opener 플러그인·권한이 남아 있다(`capabilities/default.json`). 자동 모드의 창·App Nap 처리(`lib.rs`)는 측정용이다.

## 빌드

명령은 모두 이 디렉터리(`spikes/lab`)에서 돌린다. `results/`·`fixtures/` 는 이 디렉터리의 `.gitignore` 만 막는다.

```bash
pnpm install
pnpm tauri build --debug --no-bundle   # 결과: src-tauri/target/debug/lab
```

## 자동 측정

`TOTE_LAB_AUTO` 로 모드를 고르면 측정한 뒤 `results/<이름>.json` 을 쓰고 스스로 종료한다. `perl -e 'alarm shift; exec @ARGV' <초>` 는 그 시간 안에 끝나지 않으면 강제로 끊는다.

자동 모드는 오류가 나도 `results/error-<모드>.json` 을 쓰고 종료 코드 0 으로 끝난다. 0 이 아닌 값은 alarm(142) 같은 바깥 종료나 Rust 쪽 패닉에서만 나온다. 성공은 결과 파일이 새로 생겼고 `error-<모드>.json` 이 없는 것으로 본다.

자동 모드는 작은 창(480×320)을 주 모니터 오른쪽 아래에 항상 위로 띄운다(키보드 포커스는 가져가지 않는다). 창이 가려지면 macOS 가 WebView 를 스로틀해 측정이 무효가 된다. 주 모니터에 다른 앱이 전체 화면으로 떠 있어도 그 위에 보이도록, 자동 모드는 Dock 아이콘 없는 액세서리 앱으로 돌고 창을 모든 Space 에 둔다.

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

`viewer` 모드는 환경 변수 셋으로 픽스처 경로를 받는다(픽스처 만들기는 아래 「픽스처」 절). stderr 의 Range 요청 로그가 `results/viewer-rust.log` 로 남는다.

```bash
rm -f results/viewer.json results/error-viewer.json
TOTE_LAB_AUTO=viewer \
TOTE_LAB_VIDEO="$PWD/fixtures/테스트 영상.mp4" \
TOTE_LAB_VIDEO2="$PWD/fixtures/테스트 영상 moov끝.mp4" \
TOTE_LAB_IMAGE="$PWD/fixtures/테스트 이미지.png" \
perl -e 'alarm shift; exec @ARGV' 240 ./src-tauri/target/debug/lab 2> results/viewer-rust.log
echo "exit=$?"
cat results/error-viewer.json 2>/dev/null   # 있으면 이 실행이 실패한 것이다 — 다음 블록이 지우기 전에 본다
grep -oE '/[0-9a-f]{32} range=Some' results/viewer-rust.log | sort | uniq -c   # 토큰별 Range 수
grep -c '\[ipc-probe\] reached source=frame' results/viewer-rust.log   # 0 이어야 한다
grep -c '\[ipc-probe\] reached source=host' results/viewer-rust.log    # 1 이상이어야 한다 — ipc_probe 가 실행되면 찍힌다는 확인(메인 프레임은 fetch 채널)
grep -c 'but received wrong-key' results/viewer-rust.log   # 2(케이스 수)여야 한다 — 프레임의 네이티브 메시지가 키 검사까지 갔다는 증거
```

음성 대조 — CSP meta 를 뺀 페이지로 같은 측정을 한다. 본 실행은 `cspViolations` 에 `ipc://localhost/ipc_probe` 와 `https://example.com/` 가 둘 다 있어야 하고, 그 `blocked` 가 CSP 덕이라면 여기서 `networkFetch` 가 `reachable` 로 바뀌고 `cspViolations` 가 비어야 한다.

```bash
rm -f results/viewer-nocsp.json results/error-viewer.json
diff public/viewer/sandbox.html public/viewer/sandbox-nocsp.html   # CSP meta 만 달라야 한다
TOTE_LAB_AUTO=viewer TOTE_LAB_VIEWER_PAGE=nocsp \
TOTE_LAB_VIDEO="$PWD/fixtures/테스트 영상.mp4" \
TOTE_LAB_VIDEO2="$PWD/fixtures/테스트 영상 moov끝.mp4" \
TOTE_LAB_IMAGE="$PWD/fixtures/테스트 이미지.png" \
perl -e 'alarm shift; exec @ARGV' 240 ./src-tauri/target/debug/lab 2> results/viewer-nocsp-rust.log
echo "exit=$?"
cat results/error-viewer.json 2>/dev/null   # 있으면 이 실행이 실패한 것이다 — 다음 블록이 지우기 전에 본다
grep -oE '/[0-9a-f]{32} range=Some' results/viewer-nocsp-rust.log | sort | uniq -c   # 토큰별 Range 수
grep -c '\[ipc-probe\] reached source=frame' results/viewer-nocsp-rust.log   # 0 이어야 한다
grep -c '\[ipc-probe\] reached source=host' results/viewer-nocsp-rust.log    # 1 이상이어야 한다
grep -c 'but received wrong-key' results/viewer-nocsp-rust.log   # 2(케이스 수)여야 한다
```

`throughput` 모드는 픽스처 파일이 필요 없다(입력을 코드로 만든다). 엔진 2 × 케이스 5 로 10건을 재고, 케이스마다 120초 타임아웃이 걸려 10건이 전부 시간 초과해도 1200초이므로 alarm 은 1500초다. 결과 행의 `valid` 가 `false` 면 그 케이스 도중에 페이지가 `hidden` 이었던 것이라 수치를 쓸 수 없다. `valid: true` 는 측정 중에 페이지가 한 번도 가려지지 않았다는 뜻일 뿐, 스로틀이 없었다는 보증은 아니다.

```bash
rm -f results/throughput.json results/error-throughput.json
TOTE_LAB_AUTO=throughput perl -e 'alarm shift; exec @ARGV' 1500 ./src-tauri/target/debug/lab
echo "exit=$?"
```

`smoke` 모드는 편집기 + Worker 하이라이트 파이프라인이 끝까지 도는지 확인한다(10MB 코드 픽스처, Oniguruma). `highlightedOnOpen`·`insertedTextHighlighted`·`workerErrorReqIdMatches`·`editedLinesKeepColors`·`staleReplyDiscarded` 가 `true`, `docGrewBy` 가 `220` 이어야 한다 — 이 여섯은 측정값이 아니라 통과 조건이다. `openMs` 는 가려진 창에서 rAF 가 멈추면 1초 fallback 값이라 판정에 쓰지 않는다. `valid` 는 `throughput` 과 같은 뜻이다(위 설명). 시작·끝·중간의 `document.visibilityState` 가 `visibilityAtStart`·`visibilityAtEnd`·`hiddenDuringRun` 으로 남는다.

```bash
rm -f results/smoke.json results/error-smoke.json
TOTE_LAB_AUTO=smoke perl -e 'alarm shift; exec @ARGV' 180 ./src-tauri/target/debug/lab
echo "exit=$?"
cat results/smoke.json
```

모르는 `TOTE_LAB_AUTO` 값(빈 값 포함)은 `results/error-unknown-auto.json` 을 쓰고 곧바로 종료한다.

## 픽스처

`fixtures/` 는 gitignore 되어 있어 클론마다 직접 만든다. 이름에 한글과 공백이 들어 있는 것은 의도다(경로 처리 검증).

```bash
mkdir -p fixtures results
ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=60:size=640x360:rate=30 -c:v libx264 -pix_fmt yuv420p -movflags +faststart "fixtures/테스트 영상.mp4"
ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=60:size=640x360:rate=30 -c:v libx264 -pix_fmt yuv420p "fixtures/테스트 영상 moov끝.mp4"
ffmpeg -y -loglevel error -f lavfi -i testsrc=size=320x240 -frames:v 1 "fixtures/테스트 이미지.png"
```

`libx264` 가 없으면 `-c:v h264_videotoolbox` 로 바꿔 만든다.

moov 위치 확인 — 첫 파일은 `moov` 가 `mdat` 보다 먼저, 둘째 파일은 `mdat` 이 먼저여야 한다.

```bash
for f in "fixtures/테스트 영상.mp4" "fixtures/테스트 영상 moov끝.mp4"; do
  echo "$f"; ffprobe -v trace "$f" 2>&1 | grep -m2 -oE "type:'(moov|mdat)'"
done
```

## 사람이 하는 측정

```bash
./src-tauri/target/debug/lab
```

- `#latency` — 픽스처를 고르고 「열기」(여는 동안 버튼이 잠긴다), 편집기를 눌러 20초 이상 **영문으로만** 타이핑하고 위아래로 크게 스크롤한 뒤(`json-10mb-one-line` 은 가로로) 「저장」한다. 한글 조합 키는 `keys` 에 잡히지 않고, 섞어 치면 센 키의 지연도 올라 기준선과 비교할 수 없다. 조합 중 색이 바뀔 때 글자가 깨지는지는 「저장」한 **뒤에** 한글을 몇 줄 쳐서 눈으로 본다(결과 파일에는 들어가지 않는다. 그 뒤 다시 「저장」하지 않는다). 화면 위쪽의 `← 메뉴` 로 돌아간다. 저장 결과는 버튼 아래 줄에 남고 다음 입력이 지우지 않는다. 엔진은 모두 `oniguruma`(기본값)다. 네 조합을 각각 열어 저장한다:

  | 픽스처               | 용도          | 기대 결과 파일                                      |
  | -------------------- | ------------- | --------------------------------------------------- |
  | `code-small`         | 기준선(253줄) | `results/latency-code-small-oniguruma.json`         |
  | `code-10mb`          | 큰 코드       | `results/latency-code-10mb-oniguruma.json`          |
  | `json-10mb-one-line` | 한 줄 10MB    | `results/latency-json-10mb-one-line-oniguruma.json` |
  | `log-100k`           | 로그 10만 줄  | `results/latency-log-100k-oniguruma.json`           |

  「저장」은 같은 조합의 이전 결과를 덮어쓴다. 다시 잴 조합은 먼저 사본을 떠 둔다.

  판정은 **같은 세션의 `code-small` 대비 늘어난 `keys.p95`** 로 한다. 차이가 한 프레임(`frameIntervalMs`) 이하면 된다, 두 프레임 이하면 조건부다. `keys` 는 문서를 바꾼 키만 센다(Enter·Backspace·Delete 도 센다. `keyEvents` 는 누른 키 전부의 수다. 문서를 바꾸지 않는 Shift·화살표·PageDown 은 `keyEvents` 에만 들어가고 `keys` 에는 들어가지 않는다). `composingKeys` 는 한글 조합 키 수, `composingKeysChanged` 는 그중 문서를 바꿔 `keys` 에 들어간 수다. `keySamples` 에 `{ key, isComposing, docChanged, ms }` 원본이 남는다. `code-small`·`code-10mb`·`log-100k` 에서 `highlightDecorations` 가 0 이거나 `workerErrors` 가 0 이 아니면 색 없는 편집기를 잰 것이니 결과를 쓰지 않는다.

  **`json-10mb-one-line` 은 예외다.** 한 줄이 20,000자 한도(`MAX_TOKENIZED_LINE_LENGTH`)를 넘으므로 설계상 색이 없다. 이 조합만은 `highlightDecorations: 0` 이 정상이고 `workerErrors` 만 본다. 세로로 스크롤할 것이 없으니 가로로 크게 스크롤한다(가로 스크롤도 같은 `scroll` 이벤트라 `scrollFrames` 에 잡힌다. 포인터를 편집기 위에 두고 트랙패드 좌우 또는 Shift+휠로 민다).

  **같은 조건으로 잰다.** 네 조합을 같은 모니터에서 잰다. 한 프레임은 `code-small` 의 `frameIntervalMs` 다. 대상의 `frameIntervalMs` 가 그것과 ±10% 넘게 다르면 그 조합을 다시 잰다. 다시 재도 다르면 창이 있는 모니터를 확인하고, `code-small` 부터 네 조합을 그 모니터에서 다시 잰다.

- `#ime` — 한글 IME 조합 시나리오 7개. 「시작」을 누른 뒤 편집기를 클릭하지 말고 바로 입력하고, 마지막 글자는 Enter 로 확정하지 말고 바로 「확인」을 누른다(Enter 를 더 누르면 줄바꿈이 남아 거짓 실패가 된다 — 보고서 「한글 입력」 의 `enter`). 「결과 저장」은 이 화면을 연 뒤 「확인」한 항목만 `results/ime.json` 에 쓰고 이전 파일을 덮어쓴다.

창을 다른 창으로 가리지 않은 상태에서 잰다. 가려진 창은 프레임이 줄어 수치가 틀어진다.
