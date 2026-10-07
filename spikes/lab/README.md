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

`viewer` 모드는 환경 변수 셋으로 픽스처 경로를 받는다(픽스처 만들기는 아래 「픽스처」 절). stderr 의 Range 요청 로그가 `results/viewer-rust.log` 로 남는다.

```bash
rm -f results/viewer.json results/viewer-nocsp.json results/error-viewer.json
TOTE_LAB_AUTO=viewer \
TOTE_LAB_VIDEO="$PWD/fixtures/테스트 영상.mp4" \
TOTE_LAB_VIDEO2="$PWD/fixtures/테스트 영상 moov끝.mp4" \
TOTE_LAB_IMAGE="$PWD/fixtures/테스트 이미지.png" \
perl -e 'alarm shift; exec @ARGV' 120 ./src-tauri/target/debug/lab 2> results/viewer-rust.log
echo "exit=$?"
grep -oE '/[0-9a-f]{32} range=Some' results/viewer-rust.log | sort | uniq -c   # 토큰별 Range 수
grep -c '\[ipc-probe\] reached source=frame' results/viewer-rust.log   # 0 이어야 한다
grep -c '\[ipc-probe\] reached source=host' results/viewer-rust.log    # 1 이상이어야 한다(탐침이 동작한다는 양성 대조)
```

음성 대조 — CSP meta 를 뺀 페이지로 같은 측정을 한다. 본 실행의 `blocked` 가 CSP 덕이라면 여기서 `networkFetch` 가 `reachable` 로 바뀌고 `cspViolations` 가 비어야 한다.

```bash
TOTE_LAB_AUTO=viewer TOTE_LAB_VIEWER_PAGE=nocsp \
TOTE_LAB_VIDEO="$PWD/fixtures/테스트 영상.mp4" \
TOTE_LAB_VIDEO2="$PWD/fixtures/테스트 영상 moov끝.mp4" \
TOTE_LAB_IMAGE="$PWD/fixtures/테스트 이미지.png" \
perl -e 'alarm shift; exec @ARGV' 120 ./src-tauri/target/debug/lab 2> results/viewer-nocsp-rust.log
echo "exit=$?"
```

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

- `#latency` — 실제 타이핑 지연과 스크롤 프레임. 결과: `results/latency-<픽스처>-<엔진>.json`.
- `#ime` — 한글 IME 조합 시나리오 7개. 결과: `results/ime.json`.

창을 다른 창으로 가리지 않은 상태에서 잰다. 가려진 창은 프레임이 줄어 수치가 틀어진다.
