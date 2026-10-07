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
