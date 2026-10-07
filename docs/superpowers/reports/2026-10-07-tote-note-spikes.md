# tote-note 검증 스파이크 보고서

2026-10-07 에 실험 앱 `spikes/lab`(브랜치 `spike-lab`, 바이너리는 `16fd8ae` 빌드)으로 잰 결과와 판정이다. 이 문서는 그 시점의 기록이다.

환경: macOS 27.0.1(26A434), Apple M5 Pro(Mac17,9, 15코어), 내장 디스플레이 한 대(3024×1964). userAgent `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)`(`results/ping.json`). `#latency` 에서 잰 rAF 간격 중앙값은 13ms 다.

결과 파일은 `spikes/lab/results/` 에 있다. 이 디렉터리는 gitignore 대상이라 이 기기에만 있다. 아래 수치는 그 파일에서 옮긴 것이다.

## 판정 요약

| 스파이크       | 판정       | 근거                                                                                                                    |
| -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| 뷰어 파일 전달 | **된다**   | 두 영상 탐색·이미지·격리 항목이 기준을 모두 충족. 단 iframe 의 IPC 차단은 Tauri 의 invoke key 검사 하나에 기댄다        |
| 편집 성능      | **된다**   | `code-10mb` p95 17 − `code-small` 18 = −1ms ≤ T(13ms), `smoke` 조건 6개 모두 참. 단 10MB 한 줄 JSON 은 +34ms 로 안 된다 |
| 한글 입력      | **조건부** | 7개 중 6개 통과(`enter` 재실행 포함). 실패는 `multicursor`·`replace-selections` 둘뿐                                    |
| 엔진           | Oniguruma  | `code-10mb` 행에서 두 엔진이 모두 valid 인 두 실행(R1d·run3)에서 모두 Oniguruma 가 빠르다                               |

## 뷰어 파일 전달 — 판정: 된다

**기준.** 계획의 표: 「된다 — 두 영상 모두 `videoSeekOk: true`, 이미지 `[320, 240]`, 격리 항목(IPC·네트워크·부모 접근) 모두 blocked, Range 로그 ≥ 1」, 「조건부 — 영상 하나만 되거나, 격리는 되는데 탐색만 실패」, 「안 된다 — faststart 영상도 안 열리거나, iframe 에서 IPC 가 reachable」. 여기에 `spikes/lab/README.md` 「자동 측정」 의 viewer 절이 더한 기준을 함께 적용했다.

- 토큰별 Range 요청 ≥ 1, `[ipc-probe] reached source=frame` 0, `source=host` ≥ 1.
- `but received wrong-key` 가 케이스 수(2)만큼 있어야 한다. 프레임의 네이티브 메시지가 키 검사까지 갔다는 양성 대조다.
- 본 실행의 `cspViolations` 에 `ipc://localhost/ipc_probe` 와 `https://example.com/` 가 둘 다 있어야 한다.
- 음성 대조(CSP meta 를 뺀 페이지)에서는 `cspViolations` 가 비고 `networkFetch` 가 `reachable` 이어야 한다. `diff sandbox.html sandbox-nocsp.html` 은 CSP meta 만 달라야 한다.

**본 실행** (`results/viewer.json`):

| 항목                                   | faststart                                                                | moov 끝 |
| -------------------------------------- | ------------------------------------------------------------------------ | ------- |
| videoSeekOk                            | `true`                                                                   | `true`  |
| videoError                             | 없음                                                                     | 없음    |
| imageSize                              | `[320, 240]`                                                             | 같음    |
| tauriInternalsInFrame / ipcInvoke      | `"undefined"` / 기록 없음                                                | 같음    |
| ipcFetch / networkFetch / parentAccess | `blocked: TypeError` / `blocked: TypeError` / `blocked: SecurityError`   | 같음    |
| webkitIpcHandler                       | `"object"`                                                               | 같음    |
| cspViolations 의 blockedURI            | `ipc://localhost/ipc_probe`, `https://example.com/`(둘 다 `connect-src`) | 같음    |
| origin                                 | `"null"`                                                                 | 같음    |

- 영상은 두 케이스 모두 `videoDuration` 60, `videoSeekedTo` 48, `videoReadyState` 4, 탐색 전 `buffered` `[]`, `seekable` `[[0, 60]]`, 탐색 뒤 `buffered` `[[0, 60]]` 이다.
- `ipcInvoke` 는 프레임에 `__TAURI_INTERNALS__` 가 있을 때만 시도한다. 없었으므로 기록되지 않았다.

**Rust 로그** (`results/viewer-rust.log`, `results/viewer-nocsp-rust.log`):

| 검사                     | 기준 | 본 실행 | 음성 대조 |
| ------------------------ | ---- | ------- | --------- |
| 토큰별 Range 요청 수     | ≥ 1  | 78 / 74 | 77 / 75   |
| `source=frame`           | 0    | 0       | 0         |
| `source=host`            | ≥ 1  | 1       | 1         |
| `but received wrong-key` | 2    | 2       | 2         |

토큰은 실행마다 넷이다(케이스마다 영상 하나, 이미지 하나). Range 없는 요청은 이미지 토큰마다 1번씩, 두 로그 모두 2줄이다.

**음성 대조** (`results/viewer-nocsp.json`): 두 케이스 모두 `cspViolations` `[]`, `networkFetch` `reachable`, `ipcFetch` `reachable` 이다. `parentAccess` 는 그대로 `blocked: SecurityError`, `tauriInternalsInFrame` 은 `"undefined"` 다. 영상·이미지 값은 본 실행과 같다. `diff` 는 CSP `<meta>` 4줄만 다르다.

**판정 근거.** 위 기준을 모두 충족하므로 **된다**다. 다만 「IPC blocked」의 범위가 스펙 문장보다 좁다.

- iframe 에도 WKWebView 의 네이티브 IPC 핸들러(`window.webkit.messageHandlers.ipc`)가 `object` 로 열려 있다. 틀린 키로 보낸 메시지는 Tauri 의 키 검사까지 도달했다(`wrong-key` 2줄). 명령 실행을 막은 것은 **invoke key 검사 하나**다(`source=frame` 0).
- `ipcFetch`·`networkFetch` 의 차단은 CSP 덕이다. 대조에서 둘 다 `reachable` 로 바뀌었다.
- `parentAccess` 의 차단은 `sandbox`(동일 출처 없음) 덕이다. 대조에서도 그대로다.

**이전 측정과 비교.** 본 실행 `viewer.json` 은 이전 빌드로 잰 결과(`results/viewer-prev.json`)와 바이트 단위로 같다. 그 사이 뷰어 페이지·호스트 코드·파일 서버는 바뀌지 않았다(바뀐 것은 `main.ts` 의 다른 모드 분기와 자동 모드의 macOS 활동 설정). Range 수는 77/74 에서 78/74 로 바뀌었다. 대조는 Task 3 보고서의 전사본과 비교해 no-cors fetch 탐침의 라벨만 다르다(「wrong Tauri-Invoke-Key」 → 「Tauri headers stripped」, 동작은 같고 라벨만 바꾼 수정). Range 수는 76/72 에서 77/75 로 바뀌었다. 나머지 로그 검사 값은 같다.

재측정: `spikes/lab/README.md` 「자동 측정」 의 viewer 본 실행 블록, 이어서 음성 대조 블록(이 순서로. 본 실행 블록이 대조 결과를 지운다 — 「측정 과정에서 달라진 것」).

## 편집 성능 — 판정: 된다

**기준.** 계획의 「p95 ≤ 16ms」 대신 코디네이터가 Task 6 데이터 전에 다시 고정한 기준을 쓴다(이유는 「측정 과정에서 달라진 것」). 「T 는 `code-small` 의 `frameIntervalMs` 다. `keys.p95(code-10mb) − keys.p95(code-small)` 이 T 이하면 된다, 2T 이하면 조건부, 그보다 크면 안 된다. `smoke.json` 의 통과 조건 6개가 모두 참이어야 한다.」 나머지 두 조합(`json-10mb-one-line`, `log-100k`)도 같은 차이와 판정을 적는다.

### 처리량 (`throughput.json`)

Worker 안에서 Shiki TextMate 토큰화를 처음부터 끝까지 돌린 시간이다. 엔진 2 × 케이스 5 로 10건이고, 한 프로세스에서 JavaScript 5건을 먼저, Oniguruma 5건을 나중에 돈다. 케이스마다 Worker 를 새로 만든다.

| 케이스                       | 입력                                                     |
| ---------------------------- | -------------------------------------------------------- |
| `code-1mb`                   | TypeScript 1,000,000자, 38,585줄                         |
| `code-10mb`                  | TypeScript 10,000,000자, 385,701줄                       |
| `json-10mb-one-line`         | 한 줄 JSON 10,000,000자, 20,000자 넘는 줄은 토큰화 안 함 |
| `json-10mb-one-line-nolimit` | 같은 입력, 줄 길이 제한 0·줄당 시간 제한 0               |
| `log-100k`                   | 로그 100,000줄(약 7.4MB)                                 |

세 실행을 모두 싣는다. 행의 `valid` 가 `false` 면 그 케이스 도중 페이지가 `hidden` 이었던 것이라 판정에 쓰지 않는다. `valid: true` 는 가려진 적이 없다는 뜻일 뿐 스로틀이 없었다는 보증은 아니다.

| 실행 | 시각              | 파일                           | 결과                                                                                                   |
| ---- | ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| R1d  | 14:54–14:57       | `results/throughput-prev.json` | 10행 모두 valid. 단 id 7 은 진단 스크립트 실행과 겹쳐 상한값이다                                       |
| run2 | 18:46:33–18:49:00 | `results/throughput-run2.json` | id 7 invalid — 앱 시작 기준 126,917–127,386ms, 127,755–128,600ms 에 hidden(id 7 구간 87,063–130,784ms) |
| run3 | 22:30:56–22:33:30 | `results/throughput.json`      | id 1 invalid — 앱 시작 기준 330–614ms 에 hidden(id 1 구간 54–5,730ms)                                  |

세 실행 모두 종료 코드 0 이다. run3 의 load average(1분)는 시작 10.76, 끝 4.90 이다(15코어).

**run3 전체** (`results/throughput.json`, `linesPerSec` 는 반올림):

| id  | label                      | engine     | valid     | firstViewportMs | fullMs | linesPerSec | warmupMs | viewportTokens |
| --- | -------------------------- | ---------- | --------- | --------------- | ------ | ----------- | -------- | -------------- |
| 1   | code-1mb                   | javascript | **false** | 17              | 4,471  | 8,630       | 1,152    | 721            |
| 2   | code-10mb                  | javascript | true      | 20              | 76,273 | 5,057       | 1,080    | 721            |
| 3   | json-10mb-one-line         | javascript | true      | 1               | 2      | —           | 15       | 1              |
| 4   | json-10mb-one-line-nolimit | javascript | true      | 2,457           | 4,739  | —           | 19       | 2,067,427      |
| 5   | log-100k                   | javascript | true      | 10              | 4,009  | 24,944      | 25       | 800            |
| 6   | code-1mb                   | oniguruma  | true      | 21              | 4,034  | 9,565       | 960      | 721            |
| 7   | code-10mb                  | oniguruma  | true      | 39              | 39,540 | 9,755       | 330      | 721            |
| 8   | json-10mb-one-line         | oniguruma  | true      | 1               | 2      | —           | 12       | 1              |
| 9   | json-10mb-one-line-nolimit | oniguruma  | true      | 4,117           | 8,108  | —           | 15       | 2,067,427      |
| 10  | log-100k                   | oniguruma  | true      | 14              | 7,359  | 13,589      | 15       | 800            |

`error` 가 난 행은 없다. 한 줄 JSON 은 줄 수가 1이라 `linesPerSec` 가 `null` 이다.

**세 실행의 `fullMs`(ms)**, invalid 는 괄호 안에 두고 쓰지 않는다:

| id  | label                      | engine     | R1d           | run2             | run3            | valid 값의 최대/최소 |
| --- | -------------------------- | ---------- | ------------- | ---------------- | --------------- | -------------------- |
| 1   | code-1mb                   | javascript | 7,991         | 4,597            | (4,471 invalid) | 1.74                 |
| 2   | code-10mb                  | javascript | 102,956       | 63,573           | 76,273          | 1.62                 |
| 3   | json-10mb-one-line         | javascript | 3             | 3                | 2               | —                    |
| 4   | json-10mb-one-line-nolimit | javascript | 5,055         | 5,831            | 4,739           | 1.23                 |
| 5   | log-100k                   | javascript | 7,067         | 4,432            | 4,009           | 1.76                 |
| 6   | code-1mb                   | oniguruma  | 4,726         | 4,911            | 4,034           | 1.22                 |
| 7   | code-10mb                  | oniguruma  | 35,232 (상한) | (43,140 invalid) | 39,540          | 1.12                 |
| 8   | json-10mb-one-line         | oniguruma  | 1             | 3                | 2               | —                    |
| 9   | json-10mb-one-line-nolimit | oniguruma  | 4,293         | 7,585            | 8,108           | 1.89                 |
| 10  | log-100k                   | oniguruma  | 3,395         | 7,042            | 7,359           | 2.17                 |

**id 7 은 얼마나 바뀌었나.** 진단과 겹쳤던 R1d 의 35,232ms(`wallMs` 36,742)가 상한이었는데, 겹침 없이 잰 run3 은 39,540ms 로 오히려 12% 느리다. Oniguruma `log-100k` 가 실행에 따라 3,395–7,359ms 로 2.17배 갈리는 것처럼, 실행 간 흔들림이 겹침의 영향보다 컸다.

**세 실행의 `firstViewportMs`(ms)** — 파일 전체를 줄로 나누는 시간이 들어 있으므로 「열기 + 첫 화면」 으로 읽는다:

| label                      | JavaScript (R1d / run2 / run3) | Oniguruma (R1d / run2 / run3) |
| -------------------------- | ------------------------------ | ----------------------------- |
| code-1mb                   | 20 / 14 / (17 invalid)         | 17 / 23 / 21                  |
| code-10mb                  | 31 / 22 / 20                   | 28 / (49 invalid) / 39        |
| json-10mb-one-line         | 2 / 2 / 1                      | 1 / 2 / 1                     |
| json-10mb-one-line-nolimit | 2,427 / 3,244 / 2,457          | 1,970 / 3,800 / 4,117         |
| log-100k                   | 7 / 14 / 10                    | 11 / 28 / 14                  |

**행마다 빠른 엔진** (두 엔진이 모두 valid 인 실행만):

| label                      | R1d       | run2       | run3       | 판정          |
| -------------------------- | --------- | ---------- | ---------- | ------------- |
| code-10mb                  | Oniguruma | 비교 불가  | Oniguruma  | **Oniguruma** |
| code-1mb                   | Oniguruma | JavaScript | 비교 불가  | 구분 안 됨    |
| json-10mb-one-line         | Oniguruma | 같음       | 같음       | 구분 안 됨    |
| json-10mb-one-line-nolimit | Oniguruma | JavaScript | JavaScript | 구분 안 됨    |
| log-100k                   | Oniguruma | JavaScript | JavaScript | 구분 안 됨    |

`json-10mb-one-line` 은 두 엔진 모두 1–3ms 로 20,000자 가드가 줄 하나를 건너뛴 시간뿐이라 차이가 없다.

### 지연 (`latency-*-oniguruma.json`, 사람 측정)

사람이 `#latency` 에서 네 조합을 하나씩 열고 20초 이상 타이핑하고 스크롤한 뒤 저장했다. 엔진은 모두 Oniguruma 다. `keys` 는 keydown 뒤 첫 그리기 전에 문서가 바뀐 키만 센다(한글 조합 키는 들어가지 않는다 — 아래). T = `code-small` 의 `frameIntervalMs` = **13ms**, 2T = 26ms.

| fixture            | openMs | keys count | p50 | p95 | max | p95 − code-small | 판정        | scrollFramesOver25ms / scrollFrames |
| ------------------ | ------ | ---------- | --- | --- | --- | ---------------- | ----------- | ----------------------------------- |
| code-small         | 4      | 99         | 10  | 18  | 25  | (기준선)         | —           | 0 / 81                              |
| code-10mb          | 31     | 166        | 10  | 17  | 35  | **−1**           | **된다**    | 0 / 255                             |
| json-10mb-one-line | 117    | 99         | 28  | 52  | 68  | **+34**          | **안 된다** | 1 / 11                              |
| log-100k           | 13     | 130        | 11  | 16  | 25  | **−2**           | 된다        | 0 / 233                             |

| fixture            | keyEvents | composingKeys / Changed | frameIntervalMs (표본 수) | highlightDecorations | workerErrors | 저장 시각 |
| ------------------ | --------- | ----------------------- | ------------------------- | -------------------- | ------------ | --------- |
| code-small         | 130       | 0 / 0                   | 13 (1,607)                | 362                  | 0            | 18:17:00  |
| code-10mb          | 236       | 10 / 0                  | 13 (4,119)                | 538                  | 0            | 18:36:03  |
| json-10mb-one-line | 104       | 3 / 0                   | 13 (1,492)                | 0                    | 0            | 18:14:40  |
| log-100k           | 160       | 1 / 0                   | 13 (2,526)                | 268                  | 0            | 18:15:57  |

- 네 조합 모두 `frameIntervalMs` 가 13 으로 같다. 결과 파일에 세션 식별자가 없어 「같은 세션」은 저장 시각으로 판단했다.
- `json-10mb-one-line` 의 `highlightDecorations` 0 은 설계대로다(20,000자 넘는 줄은 하이라이트하지 않는다). 그런데도 p95 가 52ms 다. 지연은 하이라이트가 아니라 10MB 한 줄 자체에서 온다. 가로 스크롤은 `scrollFrames` 11 로 거의 재지 못했다.
- Task 5 의 headless Chrome 근사도 이 조합이 기준을 넘을 수 있다고 보였다(p95 124ms, 기준선 18.5ms). 측정 페이지의 결함이 아니라 측정값이다.

**첫 측정(한글 혼합)** — 처음에는 영어와 한글을 섞어 쳤다. `json`·`log` 는 최종과 같은 파일이고 `code-small`·`code-10mb` 만 다르다:

| fixture            | openMs | keys count | p50 | p95 | max | keyEvents | composingKeys / Changed | p95 − code-small | 판정(이 기준선으로) |
| ------------------ | ------ | ---------- | --- | --- | --- | --------- | ----------------------- | ---------------- | ------------------- |
| code-small         | 18     | 31         | 15  | 30  | 31  | 68        | 28 / 0                  | (기준선)         | —                   |
| code-10mb          | 37     | 143        | 16  | 29  | 41  | 266       | 110 / 0                 | −1               | 된다                |
| json-10mb-one-line | 117    | 99         | 28  | 52  | 68  | 104       | 3 / 0                   | +22              | 조건부              |
| log-100k           | 13     | 130        | 11  | 16  | 25  | 160       | 1 / 0                   | −14              | 된다                |

다시 잰 이유: 한글 조합 키는 `keys` 에 하나도 잡히지 않아(`composingKeysChanged` 0) 첫 기준선의 표본이 31개뿐이었다. 또 한글을 섞은 `code-10mb` 의 p95 가 29ms 로, 영어만 친 재측정의 17ms 보다 높았다. 한글이 섞이면 센 키의 지연도 오르므로 기준선과 대상을 같은 입력 조건으로 맞추려고 `code-small`·`code-10mb` 를 영어만으로 다시 쟀다.

**경계.** `json-10mb-one-line` 의 판정은 기준선에 따라 갈린다. 첫 기준선(p95 30)이면 +22 로 조건부, 최종 기준선(p95 18)이면 +34 로 안 된다. 판정은 최종 기준선으로 했다. 이 json 측정 자체는 첫 회차에 친 것이라 조합 키가 3개 섞여 있다(104 이벤트 중). 한글 혼합이 이 조합의 p95 를 얼마나 올렸는지는 재지 않았다.

### smoke (`smoke.json`)

| 통과 조건                 | 값     |
| ------------------------- | ------ |
| `highlightedOnOpen`       | `true` |
| `insertedTextHighlighted` | `true` |
| `workerErrorReqIdMatches` | `true` |
| `editedLinesKeepColors`   | `true` |
| `staleReplyDiscarded`     | `true` |
| `docGrewBy`               | `220`  |

`valid: true`, `hiddenDuringRun: false`, `workerErrors` 0, `decorations` 267. `openMs` 72 는 README 대로 판정에 쓰지 않는다. smoke 는 Worker 의 열기·편집·토큰·오류 경로를 앱 안에서 끝까지 돌린 첫 확인이다.

**판정 근거.** `code-10mb` 의 차이 −1ms 가 T(13ms) 이하이고 smoke 조건 6개가 모두 참이므로 **된다**다. 10MB 코드에서 키 입력 지연은 약 200줄 기준선과 구별되지 않는다. 같은 기준으로 `log-100k` 는 된다, `json-10mb-one-line` 은 **안 된다**다. 이 둘은 「크기별 단계」 의 근거로 「스펙에 반영할 것」 에 쓴다.

**고른 엔진과 이유: Oniguruma.** 엔진은 `code-10mb` 행으로 정한다는 규칙(「측정 과정에서 달라진 것」)에 따랐다. 이 행에서 두 엔진이 모두 valid 인 실행은 R1d 와 run3 이고, 둘 다 Oniguruma 가 빠르다(R1d 35,232 대 102,956ms, run3 39,540 대 76,273ms — JavaScript 가 2.92배·1.93배 느림). run2 는 Oniguruma 행이 invalid 라 비교에서 빠진다. R1d 의 Oniguruma 값은 진단과 겹친 상한이라 Oniguruma 에 불리한 쪽으로만 틀어지므로 포함했다. 다른 네 행은 실행마다 승자가 뒤집히거나 차이가 없어 「구분 안 됨」이다.

사람의 체감 메모: 없음. 절차: 코디네이터가 띄운 lab 앱에서 사람이 한 단계씩 안내를 받아 `#latency` 네 조합을 각각 열고 타이핑·스크롤한 뒤 저장했다.

재측정: 자동은 `spikes/lab/README.md` 「자동 측정」 의 `TOTE_LAB_AUTO=throughput`·`smoke` 블록, 수동은 같은 README 「사람이 하는 측정」 의 `#latency`(영어만 친다). 여러 처리량 실행을 비교할 때는 README 명령의 `rm -f` 가 `results/throughput.json` 을 지우므로 매번 사본을 떠 둔다.

## 한글 입력 — 판정: 조건부

**기준.** 계획의 표: 「된다 — `ime.json` 7개 모두 통과」, 「조건부 — `multicursor`·`replace-selections` 만 실패」, 「안 된다 — 그 밖의 항목이 하나라도 실패」.

| id                 | 내용                                      | 기대                          | 첫 실행                             | `enter` 재실행      |
| ------------------ | ----------------------------------------- | ----------------------------- | ----------------------------------- | ------------------- |
| plain              | 빈 문서에 「안녕하세요 한글 입력 테스트」 | `안녕하세요 한글 입력 테스트` | 통과                                | —                   |
| middle             | 「앞 뒤」 가운데에 「가운데 」            | `앞 가운데 뒤`                | 통과                                | —                   |
| multicursor        | 세 줄 끝 커서 3개에서 「한글」            | `하나한글\n둘한글\n셋한글`    | **실패** `하나한글\n둘ㅎㄱ\n셋ㅎㄱ` | —                   |
| arrow-commit       | 「한」 조합 중 → 키, 이어서 「글」        | `한글`                        | 통과                                | —                   |
| brackets           | 「(」 뒤에 「한글」(괄호 자동 닫기)       | `(한글)`                      | 통과                                | —                   |
| enter              | 「한글」 직후 Enter, 이어서 「끝」        | `한글\n끝`                    | **실패** `한글\n끝\n`               | **통과** `한글\n끝` |
| replace-selections | 두 「foo」 를 선택한 채 「가」            | `가 bar 가`                   | **실패** `가 bar foo`               | —                   |

- `multicursor`: 조합은 주 커서에만 들어가고, 나머지 커서에는 자모(ㅎ, ㄱ)만 따로 들어갔다.
- `replace-selections`: 주 선택만 바뀌고 다른 선택은 그대로다.
- `enter` 첫 실행의 끝 줄바꿈은 「끝」을 확정하려고 Enter 를 한 번 더 누른 절차 때문이었다. 「끝」 을 페이지의 「확인」 버튼으로 확정한 재실행은 통과했다.

**판정 근거.** 재실행 값을 쓰면 실패는 `multicursor`·`replace-selections` 둘뿐이라 **조건부**다. 경계: 첫 실행 값을 그대로 쓰면 `enter` 도 실패라 안 된다가 된다. 그 실패가 절차 때문이라는 근거는 확정 방법만 바꾼 재실행이 통과했다는 것이다.

사람의 메모: 없음. 절차: `#ime` 에서 항목마다 「시작」 → 지시대로 입력 → 「확인」, 끝나면 「결과 저장」. `enter` 만 따로 한 번 더 쟀다(`results/ime.json` 에는 지금 그 재실행 한 항목만 있다).

재측정: `spikes/lab/README.md` 「사람이 하는 측정」 의 `#ime`.

## 스펙에 반영할 것

대상은 `docs/superpowers/specs/2026-10-07-tote-note-core-design.md` 다.

- **「뷰어」 절:**
  - 「격리」 항목의 「IPC 에 닿지 않는다」 를 바꾼다: 「뷰어 iframe 에는 `__TAURI_INTERNALS__` 가 없어 앱 명령을 부를 수 없다. 단 WKWebView 의 네이티브 IPC 핸들러(`window.webkit.messageHandlers.ipc`)는 iframe 에도 열려 있어 메시지가 Tauri 까지 가고, 명령 실행을 막는 것은 Tauri 의 invoke key 검사 하나다.」 이어서 결정이 필요하다고 적는다: 이 한 겹에 기댈지, IPC 핸들러가 없는 별도 webview·격리 패턴 같은 다른 격리를 둘지.
  - 「파일 전달」 항목의 「그 파일 하나만 가리키는 1회용 토큰 URL」 을 바꾼다: 「그 파일 하나만 가리키는 토큰 URL(커스텀 URL 스킴). 뷰어를 열 때 발급하고, 파일 경로를 드러내지 않으며, 뷰어를 닫을 때 회수한다. 영상 탐색은 같은 URL 로 Range 요청을 수십 번 보내므로 첫 사용에 소모되는 토큰으로는 안 된다.」(측정에서 영상 하나에 72–78번.)
  - 「CSP 로 네트워크를 막는다」 는 그대로 둔다. CSP 를 뺀 대조에서 네트워크가 열려 CSP 가 막는 것을 확인했다.
- **「크기별 단계」 절 (1MB·20MB/30만 줄·100MB 제안값, 엔진 선택):**
  - 엔진 선택을 더한다: 「TextMate 토큰화는 Oniguruma(WASM) 엔진으로 한다. 10MB 코드 전체 토큰화가 JavaScript 정규식 엔진보다 2–3배 빠르다.」
  - 「20MB 또는 30만 줄 초과」 행에 근거를 적는다: 10MB·385,701줄 코드는 하이라이트를 켜도 키 입력 지연이 기준선과 구별되지 않는다(차이 −1ms). 하이라이트를 끄는 기준을 정하는 것은 입력 지연이 아니라 **전체 토큰화 시간**이다 — 10MB 코드는 Oniguruma 로 35–40초다. 앞 줄의 문법 상태를 이어 가는 방식이라 문서 끝으로 점프하면 그 자리 색이 그만큼 늦을 수 있다. 결정이 필요하다: 기준 크기를 넘으면 보이는 영역 근처만 토큰화할지, 하이라이트를 끄는 기준을 낮출지. 20MB 이상과 30만 줄 경계 자체는 재지 않았다.
  - 「한 줄이 20,000자 초과」 행에 더한다: 「그 줄을 하이라이트하지 않아도 편집은 무겁다. 10MB 한 줄 JSON 은 하이라이트 없이도 키 입력 p95 가 기준선보다 34ms 늦다(52 대 18ms).」 결정이 필요하다: 한 줄이 아주 긴 파일을 편집기로 열지, 대용량 텍스트 뷰어나 읽기 전용으로 보낼지. 경계 길이는 재지 않았다(잰 것은 10MB 한 줄 하나). 20,000자 가드 자체는 유지할 근거가 있다 — 가드 없이 10MB 한 줄을 토큰화하면 첫 화면까지 2–4초, 전체 4–8초가 걸린다.
  - 「하이라이트를 입력 경로에서 뗀다」 항목(「성능」 절)에 더한다: 「줄 상태 캐시에 들어가는 토큰화에는 벽시계 기준의 줄당 시간 제한을 쓰지 않는다. Shiki 의 줄당 시간 제한은 벽시계라, 창이 가려져 WebView 가 스로틀되면 잘린 토큰이 캐시에 남아 이후 줄 색이 틀린다.」
  - 1MB 저장 간격과 100MB 경계는 이 스파이크가 재지 않았다. 제안값을 그대로 둔다.
- **「목표와 측정」 절 (나머지 목표치):**
  - 「10MB 파일에서도 키 입력 → 화면 반영 16ms 이하(한 프레임)」 를 바꾼다: 「10MB 파일의 키 입력 지연(keydown → 다음 프레임) p95 가 같은 측정의 작은 파일 기준선보다 한 프레임 이상 늘지 않는다.」 이 측정 방식은 프레임 대기가 바닥으로 들어가 약 200줄 파일도 p95 가 18ms 라서 16ms 절댓값은 쓸 수 없다.
  - 「한계」 또는 「측정 방법」 에 더한다: 「한글 조합 키의 지연은 keydown → 다음 프레임 방식으로 잡히지 않는다(WKWebView 에서 조합 갱신이 그 프레임 뒤에 들어온다). 따로 재는 방법이 필요하다.」
  - 파일 열기 → 첫 화면의 출발점: Worker 안의 「줄 나누기 + 첫 화면 토큰화」 가 10MB 코드에서 20–39ms(Oniguruma 28·39ms), 편집기 `openMs` 31ms 다. 목표치는 구현 계획에서 정한다.
  - 콜드 스타트·메모리·세션 복원·검색 목표치는 이 스파이크가 재지 않았다. 바꿀 것 없음.
- **「편집기」 절 (IME 결과에 따른 제약):**
  - 「멀티커서」 항목에 제약을 더한다: 「⚠ WKWebView 의 CodeMirror 6 에서 한글 조합은 주 선택에만 들어간다. 커서 여럿에서 한글을 치면 나머지 커서에는 자모만 들어가고, 여러 선택을 덮어쓰면 주 선택만 바뀐다.」 멀티커서는 핵심 기능이므로 결정이 필요하다: 조합 결과를 나머지 선택에 복제하는 우회를 만들지, 제약으로 받아들이고 알릴지.
- **「세션」·「저장」 절:**
  - 「창을 닫거나 앱을 끌 때는 즉시 쓴다」 와 「탭이 포커스를 잃거나 앱을 끌 때는 즉시 저장한다」 옆에 이유를 적는다: 「가려진 창에서는 macOS 가 WebView 프로세스를 거의 멈춰 프론트엔드의 저장 타이머(0.5초·1초)도 멈춘다. 즉시 쓰기가 손실 상한을 지키는 장치이므로 빼지 않는다.」

## 측정 과정에서 달라진 것

계획과 다르게 간 것과 그 이유다. 판정 기준은 모두 해당 데이터를 보기 전에 정했다.

- **지연 기준.** 계획은 「`keys.p95` ≤ 16ms 된다, ≤ 33ms 조건부」 였다. Task 5 리뷰에서 이 방식(keydown → 다음 rAF)의 바닥이 한 프레임 대기라 작은 파일도 16ms 를 넘는다는 지적이 나왔고(실측 `code-small` p95 18ms), Task 6 데이터가 생기기 전에 「같은 세션의 작은 기준선(`code-small`) 대비 p95 증가가 T 이하면 된다, 2T 이하면 조건부」 로 다시 고정했다. 스펙의 「한 프레임」 의도는 「한 프레임 넘게 늘지 않는다」 로 남는다.
- **측정 조합.** 지연은 Oniguruma 한 엔진으로만 쟀다. Task 4 의 처리량에서 Oniguruma 가 전체 토큰화가 2–3배 빠르고 준비 시간이 짧아 기본값이 됐기 때문이다. 기준선 `code-small`(약 200줄)을 더했다. 첫 측정에서 한글을 섞어 `code-small` 의 표본이 31개뿐이어서 `code-small`·`code-10mb` 를 영어만으로 다시 쟀다(위 「첫 측정(한글 혼합)」).
- **엔진 선택 규칙.** 계획은 「두 엔진 모두 동작한 문법에서 `fullMs` 가 작은 쪽」 이었다. 재측정 run2 에서 실행 간 흔들림이 0.58–2.07배로 엔진 차이만큼 커서 행마다 승자가 갈렸다. 그래서 run3 을 보기 전에 규칙을 고정했다: 엔진은 `code-10mb` 행으로 정하고, 그 행이 valid 인 모든 실행에서 같은 엔진이 이겨야 한다. 실행마다 갈리면 「구분 안 됨」 이고 기본값(Oniguruma)을 유지한다. 세 실행을 모두 싣고 행마다 valid 값만 쓴다. 다른 행은 표에만 싣는다.
- **처리량 재측정.** R1d 의 Oniguruma `code-10mb`(id 7)가 진단 스크립트 실행과 겹쳐 상한으로만 읽혀서 한 번 깨끗하게 다시 재기로 했다.
  - run2 는 id 7 이 invalid 로 나왔다.
  - 그다음 실행(18:51:36–18:52:40)은 64초 만에 종료 코드 0 으로 끝나며 결과 파일도 오류 파일도 쓰지 않았다. alarm(142)·SIGTERM(143)이 아니므로 창이 닫히거나 앱에 종료 요청이 들어간 정상 종료로 보이지만 관찰하지 못했다. 결과가 없어 실행으로 세지 않았다.
  - 사람에게 오른쪽 아래 측정 창을 가리지 말아 달라고 알린 뒤 run3 을 돌렸다. run3 은 id 1 이 앱 시작 직후 284ms 동안 가려져 invalid 다. 「invalid 행이 또 나와도 더 돌리지 않는다」 는 규칙대로 더 돌리지 않았다.
- **뷰어 재측정.** 판정에 쓸 `results/viewer-nocsp.json` 이 없었다. README 본 실행 블록의 `rm -f results/viewer.json results/viewer-nocsp.json results/error-viewer.json` 이 이전 본 실행 재측정 때 대조 결과를 지운 것이다. 그래서 같은 바이너리로 본 실행 → 음성 대조를 다시 쟀다. 이 `rm -f` 는 고치지 않았다 — 두 블록을 순서대로 돌리면 문제없지만 본 실행만 다시 돌리면 대조 결과가 사라진다. 대조 블록의 `rm -f results/error-viewer.json` 도 같은 이름을 쓰는 본 실행 오류 파일을 지울 수 있다.
- **한글 `enter` 재실행.** 첫 실행의 `enter` 실패가 확정용 Enter 를 더 누른 절차 때문으로 보여 그 항목만 「확인」 으로 확정해 다시 쟀다. 판정에는 재실행 값을 쓰고 두 값을 모두 실었다.
- **사본 파일.** 덮어쓰기 전 결과를 `results/` 에 사본으로 남겼다: `throughput-prev.json`(R1d), `throughput-run2.json`, `throughput-run3.json`(= `throughput.json`), `viewer-prev.json`·`viewer-rust-prev.log`·`viewer-nocsp-rust-prev.log`(재측정 전 뷰어 결과).

## 검증하지 않은 것

판정은 아래를 재지 않은 채로 내려졌다. 스펙이나 구현 계획이 이 중 하나에 기대면 따로 재야 한다.

**파일 전달**

- **토큰 수명.** 스파이크의 토큰은 열 때마다 새로 발급되고 몇 번이든 다시 쓸 수 있으며 만료되지 않는다. 「닫을 때 회수」는 구현도 측정도 하지 않았다.
- **큰 파일의 메모리.** `Range` 없는 요청과 끝이 열린 `bytes=0-` 요청은 그 범위 전체를 메모리로 읽는다. 대용량 텍스트 뷰어(100MB 초과)처럼 큰 파일을 같은 경로로 읽는 경우는 재지 않았다. 요청마다 스레드 하나를 쓰는 것도 그대로다.
- **JS `fetch` 로 Range 를 읽는 경우.** `Access-Control-Expose-Headers` 가 없어 뷰어 스크립트는 `Content-Range` 를 읽지 못한다. 측정은 `<video>`·`<img>` 요소만 썼다.
- `206` 응답의 `Content-Length` 를 확인하는 테스트가 없다. 파일 읽기 실패의 원인(권한 거부 등)이 404 로 뭉개진다.
- **키를 아는 프레임.** 유효한 invoke key 를 가진 프레임이 명령에 닿는지는 재지 않았다. 키 없는 네이티브 메시지가 버려지는 것은 로그 줄이 없어 추정이다. `no-cors` fetch 경로는 브라우저가 `Tauri-*` 헤더를 지우므로, 그 경로에서 「키가 막는다」 는 증거는 약하다(대조에서도 Rust 로그에 흔적이 없다). 네이티브 `postMessage` 경로의 증거만 확실하다.
- 영상은 ffmpeg 합성 영상(640×360, 60초) 하나의 두 배치(moov 앞·끝)뿐이다. 실제 촬영 영상·큰 파일·다른 코덱은 재지 않았다.

**편집 성능**

- **한글 조합 키의 입력 지연.** `keys` 는 「keydown 뒤 첫 그리기 전에 문서가 바뀐 키」만 센다. WKWebView 에서 한글 조합 갱신은 그 그리기 뒤에 들어와 모든 조합에서 `composingKeysChanged` 가 0 이다. 한글 타이핑의 지연은 재지 않았다.
- **한글을 섞어 치면 센 키의 지연도 오른다.** 한글 혼합 `code-10mb` 의 p95 는 29ms, 영어만 친 재측정은 17ms 다. 원인은 재지 않았다.
- **Worker 하이라이트와 한글 조합의 상호작용.** `#ime` 페이지는 Worker 하이라이트 없이 CodeMirror 기본 설정만 쓴다. 조합 중에 비동기 장식이 바뀌는 경우는 `#latency` 에서 사람이 치며 눈으로 본 것뿐이다.
- **같은 세션 판단.** 결과 파일에 시각·세션 식별자가 없다. 「같은 세션」은 파일 수정 시각으로 판단했다.
- **`keys` 집계의 경계.** Chrome 식 한글 IME 는 확정 Enter 하나에 keydown 둘을 보내 표본이 둘 생길 수 있고, `keySamples` 에 시각이 없어 걸러낼 수 없다(이번 결과는 조합 키가 `keys` 에 하나도 들어가지 않아 영향이 없다). 글자 키와 같은 프레임 안에 누른 Shift 는 문서를 바꾼 키로 셀 수 있다.
- `json-10mb-one-line` 의 가로 스크롤은 `scrollFrames` 11 로 거의 재지 않았다.
- **JavaScript 엔진의 입력 지연.** 지연은 Oniguruma 로만 쟀다.
- **먼 위치로 점프할 때의 하이라이트.** 10MB 코드 전체 토큰화는 수십 초다. 문서 끝으로 점프했을 때 색이 얼마나 늦게 오는지는 재지 않았다.
- **줄당 시간 제한 「0 = 제한 없음」.** 단위 테스트는 0 과 기본값 500ms 를 구분하지 못한다. 0 이 제한을 푼다는 증거는 처리량 `json-10mb-one-line-nolimit` 행(id 4·9)의 토큰 2,067,427 개뿐이다.
- **스로틀 없음의 보증.** 결과 행의 `valid: true` 는 측정 중 페이지가 한 번도 가려지지 않았다는 뜻일 뿐이다. 보이는 상태에서 macOS 가 WebContent 우선순위를 낮춘 경우는 잡지 못한다.
- **가려짐의 원인.** run2 의 id 7(앱 시작 기준 약 127–129초)과 run3 의 id 1(330–614ms)에서 페이지가 가려진 원인, 결과 없이 끝난 실행의 종료 원인은 관찰하지 못했다.
- **엔진 비교의 순서 교란.** 처리량 실행은 한 프로세스에서 JavaScript 5건을 항상 Oniguruma 5건보다 먼저 돌린다. 실행 중 배경 부하가 바뀌면 엔진 차이와 섞인다. 순서를 바꾼 실행은 하지 않았다. 실행 간 흔들림(같은 행의 valid 값 최대/최소 1.12–2.17배, 1–3ms 인 가드 행 제외)도 그대로 남아 있다.
- `smoke` 의 `docGrewBy 220` 은 주 스레드 편집만 확인한다.
- **스펙 「목표와 측정」 의 나머지 지표.** 콜드 스타트, 메모리, 탭 50개 세션 복원, 검색 시간, 1MB·100MB 코드 파일의 키 입력 지연, 메모 1만 개 워크스페이스, 자동 저장 간격(0.5초·3초)의 비용은 재지 않았다. Zed·Sublime 과의 수동 비교도 하지 않았다.

**한글 입력**

- 다중 커서·다중 선택 실패의 우회(조합 결과를 나머지 선택에 복제하는 등)는 시도하지 않았다.
- 한 사람이 한 입력기로 친 결과 하나씩이다. 입력기 종류는 기록하지 않았다. 다른 입력기(3벌식, 서드파티)·다른 macOS 버전은 재지 않았다.

**공통**

- 한 기기(위 「환경」)·한 모니터에서만 쟀다.
