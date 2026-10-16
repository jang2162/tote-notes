# tote-notes 칸·창·전환 스파이크 보고서

날짜: 2026-10-17. 칸·창·전환 계획 Task 4. 제품 코드는 바꾸지 않았다(`spikes/` 만).

## 판정

| 판정                            | 결과                                      | 근거                                                   |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| (a1) 탭 바 사이 HTML5 끌어 놓기 | **확인 못 함 — 사람 화면 대기**           | 끌기에 사람의 화면이 필요해 이번에는 재지 않았다.      |
| (a2) 창 밖 놓기                 | **확인 못 함 — 사람 화면 대기**           | 위와 같다.                                             |
| (b) 여러 창 시험                | **허브 됨** — e2e 끌기는 `locator.dragTo` | Playwright WebKit 6/6 통과(아래).                      |
| (c) 새로 고침 전환              | **새로 고침 됨**                          | 3회 모두 `pings: 1`, 창 위치·크기 불변, 23–37ms(아래). |

## (b) 여러 창 시험 — Playwright WebKit

명령(저장소 루트): `TOTE_E2E_PORT=${TOTE_E2E_PORT:-1430} pnpm exec playwright test --config spikes/windows/playwright.config.ts`. 결과: **6개 실행, 6 통과**(2.8초).

| 항목                                                                    | 결과                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ① `BroadcastChannel` 로 같은 컨텍스트의 두 페이지가 주고받는다          | 통과. 보낸 페이지에는 오지 않는다.                                          |
| ② `localStorage` 를 함께 본다                                           | 통과.                                                                       |
| ③ `window.open("/?window=ws-2")` 가 같은 컨텍스트의 `popup` 으로 잡힌다 | 통과. URL 쿼리 `?window=ws-2`, 같은 `BrowserContext`, 허브 메시지도 받는다. |
| ④ 두 페이지가 번갈아 같은 JSON 을 읽고 고쳐 쓴다(각 100번)              | 통과. 200번 모두 직전까지의 쓰기를 보았고 잃은 쓰기 없음.                   |
| ⑤a `locator.dragTo` 가 HTML5 끌기를 일으킨다                            | 통과. `dragstart`·`drop`·`dragend` 가 온다.                                 |
| ⑤b `DataTransfer` 핸들을 넣은 `dispatchEvent`                           | 통과. `dragstart`→`dragenter`→`drop`→`dragend`, `getData` 가 이어진다.      |

구분력: ② 를 컨텍스트 둘로 바꾸면 `Expected "from-a" / Received null` 로 실패하는 것을 확인했고 되돌렸다.

**e2e 끌기 방법:** `locator.dragTo` 가 되므로 그것을 쓴다(`dispatchEvent` 도 되는 예비). 둘 다 안 되는 갈래는 생기지 않았다(사전 점검 P11).

**한계:** 이것은 Playwright WebKit 이지 실제 앱의 WKWebView 가 아니다. Tauri 창끼리 `BroadcastChannel`·`localStorage` 를 공유하는지(창마다 웹뷰 프로세스, 데이터 저장소 공유)는 재지 않았다. ④ 는 테스트처럼 차례로 움직이는 경우만 덮는다. 동시에 쓰는 경합은 재지 않았다.

## (c) 새로 고침 전환 — 실제 WKWebView

lab `reload` 모드를 3번 돌렸다(`cd spikes/lab && TOTE_LAB_AUTO=reload perl -e 'alarm shift; exec @ARGV' 60 ./src-tauri/target/debug/lab`). 세 번 모두 `error-reload.json` 없음, 종료 코드 0.

| 회차 | `pings` | 전·후·1.5초 뒤 창                | `elapsedMs` | `ok` |
| ---- | ------- | -------------------------------- | ----------- | ---- |
| 1    | 1       | (2032,1292) 960×640 로 모두 같음 | 37.1        | true |
| 2    | 1       | 같음                             | 23.1        | true |
| 3    | 1       | 같음                             | 23.2        | true |

`elapsedMs` 는 `reload()` 호출부터 새 페이지의 리스너가 서서 `reload_ready` 가 불리기까지다(앱의 복원 시간이 아니다). 창 좌표는 물리 픽셀. 자동 모드는 작은 창 크기를 따로 주므로 제품 창 크기는 아니다. 다시 재기: README 「자동 측정」의 `reload` 블록.

## (a1)·(a2) — 사람이 나중에 재는 절차

lab `drag` 모드를 만들어 두었다. 같은 절차로 다시 잴 수 있다.

```bash
cd spikes/lab && pnpm install && pnpm tauri build --debug --no-bundle
rm -f results/drag.json
TOTE_LAB_MANUAL=drag ./src-tauri/target/debug/lab
```

세 가지를 각각 세 번: ① 탭을 다른 탭 바에 놓기 ② 탭을 창 밖(바탕 화면)에 놓기 ③ 끌다가 창 안에서 Esc. 포인터 변형 바도 같은 세 가지를 한다. 읽는 법은 `spikes/lab/README.md` 「사람이 하는 측정」의 `drag` 항목. 판정 기준:

- (a1) 됨: ① 에서 `dragstart`·`dragover`·`drop`·`dragend` 가 모두 오고 `drop` 의 `target` 이 다른 바.
- (a2) 구별함: ② 의 `dragend` 가 `dropEffect === "none"` 이고 `insideWindow === false`, ③ 은 `insideWindow === true` 로 갈린다. 포인터 변형은 창 밖 `pointerup` 이 `setPointerCapture` 뒤에 오는지.

`drag` 모드는 **빌드·타입 검사만 했고 창을 띄워 실행하지 않았다**(사람 화면을 빼앗지 않으려고). 첫 실행에서 페이지 오류가 날 수 있다.

## 뒤 태스크에 주는 것

- **(a1) 확인 못 함 → Task 10 은 포인터 이벤트 끌기**(4px 넘게 움직이면 시작).
- **(a2) 확인 못 함 → Task 11 은 메뉴만 둔다.** Task 13 이 코어 스펙에 「끌기로는 떼어 내지 않는다」를 적는다. Task 15 「떼어 내기」는 메뉴·오른쪽 클릭만.
- **(b) 허브 됨 → Task 11 이 `FakeHub` 를 만들고 Task 11·12 가 여러 창 e2e 를 쓴다.** Task 10 e2e 끌기는 `locator.dragTo`. (사전 점검 P11) (a1) 과 관계없이, (b)⑤ 가 둘 다 안 되면 포인터 이벤트 끌기로 구현하고 `page.mouse` 로 e2e 를 쓴다 — 이번에는 해당 없음.
- **(c) 됨 → Task 12 는 `WebviewWindow::reload()`.** 전환 시간 측정(Task 15)은 `switch-click` → 새 페이지 `restore-done`.
- 사람 화면 측정이 끝나면 (a1)(a2) 줄만 위 갈래대로 바꾼다.

## 도구의 한계

- Playwright WebKit 는 앱의 WKWebView 가 아니다. 앱 안의 창 사이 동작은 (b) 로 보증되지 않는다.
- (c) 는 입력 없는 자동 실행이라 사용자가 창을 옮기는 도중의 새로 고침은 재지 않았다. 새로 고침 중 옛 페이지의 쓰기 경합(사전 점검 P2)도 재지 않았다.
