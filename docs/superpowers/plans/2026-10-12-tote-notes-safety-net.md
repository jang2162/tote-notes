# tote-notes 안전망 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「언제 꺼도 다시 켜면 그대로다」를 끝까지 세운다 — 백업(스냅샷·하드링크·보존·이전 버전), 워크스페이스 검색, 외부 변경 감시와 충돌·삭제 배너, 저장 실패의 재시도와 종료 경고, Dock 종료의 쓰고 닫기, 그리고 스펙이 구현 계획에 미룬 성능 목표치를 사전 등록해 실측한다. 앞 두 계획이 이월한 것은 전부 태스크에 배정하거나 이유를 적어 둔다.

**Architecture:** Rust 는 `backup`(스냅샷·보존·이전 버전), `search`(ripgrep 라이브러리 병렬 검색, Tauri `Channel` 스트리밍), `watch`(`notify` 감시, 자기 쓰기 걸러내기, inode 로 rename 추적) 모듈을 더하고, `AppCore` 가 창마다 감시기와 백업 타이머를 잇는다. 프론트엔드는 사이드바를 메모 목록 ↔ 검색 패널로 전환하는 `Sidebar`, 편집 영역 위의 `Banner`(충돌·삭제·저장 실패), 「이전 버전」 대화상자를 더하고, 외부 변경 이벤트를 `Doc` 이 받아 조용히 다시 읽거나 배너를 띄운다. 성능은 앱 안 계측 지점(`perf` 이벤트 로그)과 고정 픽스처로 잰다.

**Tech Stack:** Tauri 2.12(`ipc::Channel`, `tauri-plugin-dialog`), Rust `notify` 8, `grep` 0.4(`grep-searcher`·`grep-regex`), TypeScript + Vite, CodeMirror 6, Vitest, Playwright(WebKit), `cargo test`, Orca `computer-use`.

**Spec:** `docs/superpowers/specs/2026-10-07-tote-note-core-design.md`. 앞 계획 둘 `docs/superpowers/plans/2026-10-08-tote-note-core-foundation.md`·`docs/superpowers/plans/2026-10-10-tote-note-extensions-and-screens.md` 가 만든 코드 위에서 돈다. 이월분의 출처는 `docs/superpowers/reports/2026-10-12-tote-note-extensions-smoke.md`(「확인하지 않은 항목」·「다음 계획으로 넘길 것」)와 `docs/superpowers/reports/2026-10-09-tote-note-core-foundation-smoke.md`(「확인하지 못한 것·지켜볼 것」). 성능의 출발점은 `docs/superpowers/reports/2026-10-07-tote-note-spikes.md` 「스펙에 반영할 것」, 측정 절차의 본보기는 `docs/superpowers/reports/2026-10-11-long-line-boundary.md`. 실행자는 이 문서들을 함께 읽는다.

## 이 계획의 위치

코어는 계획 셋으로 나눠 쓴다. 이 문서는 셋째이자 마지막이다.

1. **코어 기반** — 끝났다(`docs/superpowers/reports/2026-10-09-tote-note-core-foundation-smoke.md`).
2. **확장과 화면** — 끝났다(`docs/superpowers/reports/2026-10-12-tote-note-extensions-smoke.md`).
3. **안전망(이 문서)** — 백업, 워크스페이스 검색, 파일 감시와 외부 변경·충돌·삭제 배너, 저장 실패 재시도와 종료 경고, 워크스페이스 위치 다시 지정, 성능 계측과 목표치, CLI 요청 실패의 알림, Dock 종료의 쓰고 닫기, 시작 때 `listMemos` 실패 시 세션 쓰기 막기, 복구로 메모 ID 가 바뀔 때의 사이드바 활성 표시, 개발 번들의 「셸 명령 설치」 범위, 그리고 2번 계획이 이월한 것 전부(아래 「이월분 배정표」).

이 계획이 끝나면 코어 스펙의 기능은 전부 구현된 상태다. 남는 것은 마켓플레이스·동기화 스펙과, 배정표에 「다음 계획」으로 적은 성능 미세 조정뿐이다.

## 스펙이 이 계획에 넘긴 것과 이 계획이 정한 것

스펙이 비워 둔 자리를 이 계획이 채운 것이다. 근거는 각 태스크에 있고, 여기에 모아 둔다.

- **백업의 「바뀐 것」.** `Workspace` 의 쓰기 연산(만들기·저장·제목·이름·언어·가져오기·삭제)과 감시기가 잡은 외부 변경이 더티 플래그를 세운다. 10분 타이머는 플래그가 선 워크스페이스만 찍는다. 앱 시작 직후에는 찍지 않는다(아무것도 안 바뀌었다). 앱을 끌 때도 찍지 않는다(스펙이 「10분마다」만 말하고, 종료를 느리게 하지 않기 위해서다) — 보고서의 「사람 판단 필요」에도 올린다.
- **백업 대상은 열린 워크스페이스뿐이다.** 닫힌 워크스페이스는 tote 가 바꾸지 않으므로 바뀐 것이 없다. 다른 앱이 바꾼 것은 다음에 열 때 감시기가 잡는다.
- **100MB 를 넘는 파일은 스냅샷에서 뺀다.** 편집기가 열지 않는 크기라 「이전 버전」이 쓸 데가 없고, 10분마다 복사하면 디스크를 먹는다. 스냅샷 안의 `.tote/manifest.json` 에 「뺀 파일」로 적어 둔다.
- **하드링크 판정은 내용 해시다.** 스냅샷마다 `.tote/manifest.json` 에 파일 → `{size, mtimeMs, sha256}` 를 적고, 다음 스냅샷은 크기·mtime 이 같으면 해시를 다시 재지 않고 같다고 본다(둘 중 하나라도 다르면 다시 해시한다). 매니페스트는 `.tote/` 안이라 Finder 에서 스냅샷을 열어도 메모 파일만 보인다.
- **보존의 「하루」는 기기의 로컬 날짜다.** 스냅샷 폴더 이름 `YYYYMMDD-HHMMSS` 도 로컬 시각이다 — Finder 에서 사람이 읽는 시각이다.
- **스냅샷은 임시 폴더에 만들어 rename 한다**(`.tmp-<이름>` → `<이름>`). 찍는 도중 죽어도 반쯤 된 스냅샷이 목록에 안 보이고, 다음 시작 때 `.tmp-*` 를 지운다.
- **「백업 폴더 열기」는 Finder 로 연다.** macOS 의 `open` 명령을 `backup` 모듈 안에서 부른다(OS 의존 코드는 모듈 경계 안에). 다른 OS 는 「지원하지 않음」 오류.
- **「이전 버전」 되돌리기는 편집기 트랜잭션 하나다.** `userEvent: "input.restore"` 로 넣어 ⌘Z 한 번에 통째로 돌아온다. 되돌린 뒤 자동 저장이 평소대로 쓴다.
- **검색의 문맥은 앞뒤 한 줄씩이다.** 결과 상한은 **검색 하나에 2,000개**, 파일 하나에 200개. 넘으면 「결과가 많아 일부만 보입니다」. 결과 순서는 도착 순(병렬이라 실행마다 다를 수 있다) — 정렬하려면 끝까지 기다려야 해서 스트리밍이 무의미해진다.
- **검색 패널은 ⇧⌘F 로 연다.** 사이드바가 메모 목록 ↔ 검색 패널로 바뀌고, 패널의 Esc 가 목록으로 돌아온다. 입력은 **150ms** 멈추면 검색한다. 창마다 검색은 하나만 돌고 새 검색이 이전 것을 취소한다(대용량 텍스트 뷰어의 파일 안 검색과는 별개의 번호다).
- **rename 추적은 inode 다.** 감시기 이벤트가 From/To 쌍으로 오면 그대로 쓰고, 아니면 같은 배치 안에서 사라진 파일과 새로 생긴 파일의 `(dev, ino)` 가 같으면 rename 으로 본다. inode 는 메모리에만 둔다(`index.json` 형식은 그대로).
- **감시 이벤트는 200ms 모아서 보낸다.** 한 저장이 임시 파일 생성 → rename 두 이벤트를 내므로 모아서 한 번 판정한다.
- **열린 외부 파일도 감시한다.** 스펙 「외부 변경」이 「열린 파일」이라 하므로 메모와 같은 배너를 받는다. 외부 파일은 「아직 쓰지 않은 내용」= 저장 전 수정분이다.
- **저장 실패의 「5초마다 재시도」는 `WriteScheduler` 에 5초 지연으로 다시 예약하는 것이다.** 탭에 「저장 실패」 표시(탭의 `failed` 클래스와 제목 끝 ⚠), 상태 표시줄에 오류 문구. 종료 경고는 flush 라운드의 답에 「막힘」을 실어 Rust 가 대화상자를 띄운다.
- **성능 목표치**(스펙 「목표와 측정」이 「구현 계획에서 정한다」고 한 것)는 Task 16 에 **측정 전에 고정**한다. 값: 콜드 스타트 → 첫 창 ready **1,500ms**, 파일 열기 → 첫 화면 10MB 코드 **500ms**(`.ts` 와 `.md` 둘 다), 10만 줄 로그 **500ms**, 탭 50개 세션 복원 → ready **1,000ms**, 메모 1만 개 워크스페이스 리터럴 검색 → 완료 **1,000ms**. 판정은 **5회 실행의 중앙값**. 릴리스 빌드. 근거는 Task 16.
- **배정하지 않은 이월분**과 그 이유는 아래 「이월분 배정표」.

## 이 계획이 다루지 않는 것

- 마켓플레이스·동기화(각자의 스펙).
- 사용자 설치 확장의 뷰어(별도 webview 로 옮긴 뒤 — 마켓플레이스 전).
- 사용자 확장의 병적인 정규식(`firstLine`·`wordPattern`·문법)의 길이 제한·타임아웃 — 마켓플레이스 전 점검으로 넘긴다(유출이 아니라 DoS 라 번들만 싣는 1차에는 당하지 않는다).
- `LONG_LINE_LIMIT` 의 언어별 한도 — 「사람 판단 필요」(지금 값은 모든 형식에 200,000 이고 안전한 쪽이다).
- 탭 전환 순간 조합 중이던 한글 음절이 사라지는 것 — 받아들인 판정(2번 보고서 「판정 대기」).
- 마크다운 미리보기의 원격 이미지, 분할 화면, PDF 뷰어, ⌘P, 명령 팔레트(스펙 「1차에 넣지 않는 것」).

## Global Constraints

모든 태스크의 요구 사항에 아래가 포함된다. 값은 스펙에서 그대로 옮겼다.

- 플랫폼은 macOS 먼저다. 경로·하드링크·Finder 열기·앱 데이터 위치처럼 OS 에 기대는 코드는 Rust 모듈 경계 안(`backup`, `watch`, `appdata`, `cli`)에 가둔다.
- 앱 셸 Tauri 2, 프론트엔드 TypeScript, 백엔드 Rust, 편집기 CodeMirror 6.
- **파일 내용은 JSON 문자열이 아니라 Tauri 2 바이너리 IPC 로 주고받는다.** 이전 버전의 내용(`read_version`)도 같다.
- **원자적 쓰기:** 같은 폴더의 임시 파일에 쓴 뒤 rename 한다. 파일을 제자리 수정하지 않는다 — 백업의 하드링크가 이 성질에 기댄다.
- **백업:** 바뀐 것이 있을 때만 **10분**마다, `backups/<워크스페이스 ID>/<YYYYMMDD-HHMMSS>/`. 워크스페이스 루트의 텍스트 파일과 `.tote/index.json` 을 담고, **앞 8KB 에 NUL 바이트가 있는 파일**과 세션 파일은 뺀다. 직전 스냅샷과 내용이 같은 파일은 **직전 스냅샷의 사본에** 하드링크하고 **워크스페이스 파일 자체에는 하드링크하지 않는다.** 첫 사본은 복사(가능하면 APFS clone). 보존: 24시간 안은 전부, 그보다 오래된 것은 하루에 마지막 하나만 30일까지, 30일이 지난 것은 지운다. 정리는 스냅샷을 만들 때마다 돈다. 이전 버전은 메모 ID 로 스냅샷을 거슬러 찾고 인접 스냅샷과 내용이 다른 시점만 보인다. 되돌리기는 ⌘Z 로 되돌릴 수 있다.
- **검색:** 별도 패널, 대소문자 구분·정규식 토글. Rust 가 ripgrep 라이브러리로 **병렬 검색**하고 결과를 나오는 대로 보낸다. 새 검색어가 들어오면 이전 검색을 취소한다. 대상은 워크스페이스 루트의 텍스트 파일. 바이너리와 **5MB 를 넘는 파일**은 건너뛴다. 색인은 만들지 않는다. 결과는 메모별로 묶어 줄과 앞뒤 문맥을 보이고, 누르면 그 위치로 연다.
- **외부 변경:** 백엔드는 경로마다 마지막으로 쓴 내용의 해시를 기억하고 그 해시와 같은 변경 이벤트는 무시한다. 다른 앱이 열린 메모를 고쳤을 때 아직 쓰지 않은 내용이 없으면 커서를 유지한 채 조용히 다시 읽고, 있으면 충돌 배너로 「디스크 버전 / 내 버전」을 고르게 한다. 외부 파일의 수정분을 복원할 때 디스크 내용 해시가 보관 당시와 다르면 같은 충돌 배너. 열린 파일이 지워졌을 때 「삭제됨」 배너를 띄우고 내용은 편집기에 남긴다. 감시기가 rename 을 잡으면 대응표를 고치고, **놓치면 새 메모로 취급**된다(탭 위치 정보만 사라진다).
- **오류 처리:** 저장 실패는 탭에 「저장 실패」 표시를 띄우고 내용은 메모리에 둔 채 **5초마다 재시도**한다. **앱 종료를 막는 경우는 이것 하나뿐이다** — 저장 실패가 남아 있으면 끄기 전에 경고한다. 워크스페이스 폴더가 사라졌을 때 최근 목록에 「찾을 수 없음」으로 표시하고 위치를 다시 지정할 수 있게 한다.
- **성능 지표:** 콜드 스타트, 파일 열기 → 첫 화면, 키 입력 지연, 스크롤 프레임, 메모리, 탭 50개 세션 복원, 검색 시간. 파일 세트: 1MB·10MB·100MB 코드 파일, 한 줄짜리 10MB minified JSON, 10만 줄 로그, 메모 1만 개 워크스페이스. 개발 빌드에 계측 지점을 심어 앱 안에서 잰다.
- **세션:** 변화가 멈추고 1초 뒤, 창을 닫거나 앱을 끌 때 즉시. **Dock 의 종료·로그아웃도 쓰고 닫기를 거친다**(이 계획이 더한다).
- 주석·문서 규칙: `docs/guideline/base/03-comments.md`, 인용은 `docs/guideline/base/04-citation.md`(줄번호가 아니라 이름·절 제목). 코드 주석은 영어, 사용자에게 보이는 문구는 한국어.
- **커밋:** 경로를 명시해 stage 한다(`git add -A` 금지). 커밋 전에 `pnpm exec oxfmt <바꾼 파일>`, `pnpm exec oxlint --fix <바꾼 TS 파일>`, `cargo fmt --manifest-path src-tauri/Cargo.toml`. 테스트 결과는 **실행된 개수**와 함께 보고한다(0개면 통과가 아니다).
- **포트:** Playwright 의 Vite 서버는 `TOTE_E2E_PORT`(기본 1430). 워크트리를 여럿 돌리면 워크트리마다 다른 값(`docs/guideline/base/08-shared-resources.md`). `tauri dev` 는 1420 고정이라 한 번에 한 워크트리에서만.
- **에이전트가 앱을 띄울 때는 반드시 `TOTE_DATA_DIR=<임시 폴더>`** 를 주고, 사람의 화면을 쓰지 않는 확인은 `TOTE_BACKGROUND=1` 도 준다(디버그 빌드만). 끝나면 `~/Tote-dev` 와 `~/Library/Application Support/tote-dev` 가 생기지 않았는지 검사한다 — 2번 계획 Task 13 에서 워커가 `TOTE_DATA_DIR` 없이 앱을 띄워 그 폴더들을 만든 사고가 있었다.
- 생성물(번들 확장의 `LICENSES.md`·문법·테마·뷰어 HTML, `src/backend/fake-registry.json`)은 손으로 고치지 않고 `pnpm sync:bundled` 로 다시 만든다. 소스를 고친 턴에 돌린다.

## Review Focus

스펙이 암시하지만 태스크의 기본 테스트가 놓치기 쉬운 입력이다. 사람이 쓰다가 가장 먼저 부딪힐 것부터 적었다. 줄마다 그것을 고정하는 테스트를 소유 태스크에 넣었다.

1. **타이핑하는 도중에 다른 앱(동기화 클라이언트)이 같은 메모를 고친다.** 조용한 다시 읽기가 아직 저장되지 않은 글자를 덮으면 안 된다 — 쓰지 않은 내용이 있으면 충돌 배너다. Task 12 의 `an external change while typing shows the conflict banner and keeps the typed text` 가 고정한다.
2. **스냅샷을 찍는 도중에 메모가 저장된다(파일이 rename 으로 바뀐다).** 반쯤 읽은 파일이나 사라진 임시 파일로 스냅샷이 실패하면 안 되고, 그 파일만 다음 스냅샷으로 미뤄야 한다. Task 9 의 `a_file_replaced_mid_snapshot_is_skipped_not_fatal` 이 고정한다.
3. **검색어가 정규식으로는 잘못됐고 토글이 켜져 있다(`(`).** 패널이 「잘못된 정규식」을 보이고 멈추지 않아야 하며, 다음 글자를 치면 다시 검색해야 한다. Task 14 의 `a bad regex says so and the next keystroke searches again` 이 고정한다.
4. **Finder 에서 열린 메모의 이름을 바꾸고 계속 친다.** 탭 제목이 따라오고 저장이 새 이름으로 가야 한다 — 옛 이름 파일이 다시 생기면 안 된다. Task 11 의 `a_rename_seen_only_as_remove_and_create_is_matched_by_inode` 와 Task 12 의 `a renamed memo keeps its tab and saves under the new name` 이 고정한다.
5. **디스크가 가득 차 저장이 계속 실패하는 채로 ⌘Q.** 글이 메모리에만 있으므로 경고 없이 끝나면 안 되고, 「취소」가 앱을 살려 두어야 한다. Task 6 의 `a quit with a failed save asks first and cancel keeps the app` 과 Rust `a_blocked_round_ends_with_a_cancel` 이 고정한다.

---

## 파일 구조

```
scripts/
  sync-bundled.ts                NOTICE 에서 라이선스 원문을 뽑아 LICENSES.md 에 싣는다
  perf-fixtures.ts               성능 측정 파일 세트 생성(코드 1·10·100MB, 한 줄 JSON, 로그, 메모 1만 개)
  measure-perf.sh                릴리스 빌드를 5회 띄워 perf 로그를 모은다
src-tauri/src/
  appdata.rs                     backups_dir, 성능 로그 경로
  app/mod.rs                     AppCore 에 backup 스케줄러·감시기·검색 취소 장부·perf 로그
  app/commands.rs                새 명령(검색·백업·버전·설정 patch·flush_blocked·relocate…)
  app/lifecycle.rs               막힌 flush 라운드의 대화상자, Dock 종료
  app/requests.rs                CLI 요청 실패를 창에 알린다
  app/menu.rs                    「이전 버전…」 「백업 폴더 열기」 「워크스페이스 검색」
  backup/{mod,snapshot,retention,versions}.rs
  search/mod.rs                  병렬 검색과 스트리밍
  watch/mod.rs                   notify 감시, 자기 쓰기 걸러내기, rename 추적
  workspace/{mod,ops,index}.rs   더티 플래그, 마지막 쓰기 해시, inode 표
  files/range.rs                 닫힌 Range 상한
  extensions/install.rs          원자적 교체
  perf.rs                        계측 지점 로그
src/
  backend/types.ts               새 Backend 메서드·이벤트·타입
  backend/{tauri,fake}.ts
  app/controller.ts              외부 변경·배너·검색 패널·이전 버전 연결
  app/docs.ts                    저장 실패 재시도, 외부 변경 반응, 되돌리기
  ui/sidebar.ts                  메모 목록 ↔ 검색 패널
  ui/search-panel.ts
  ui/banner.ts
  ui/versions.ts                 「이전 버전」 대화상자
  highlight/{client,worker,protocol}.ts   문법 파싱을 워커로, 따라잡기 조각내기
  viewer/large-text.ts           짧은 206 이어받기
tests/e2e/                       search.spec.ts, backup.spec.ts, watch.spec.ts, save-failure.spec.ts, carried-over.spec.ts
tests/measure/perf.md            측정 절차(사전 등록) — Task 16
docs/superpowers/reports/<날짜>-tote-notes-perf.md, <날짜>-tote-notes-safety-net-smoke.md
```

## 이월분 배정표

앞 계획과 보고서가 넘긴 것 전부다. 「배정」은 이 계획의 태스크, 「다음」은 배정하지 않은 이유.

| 이월분                                                                                                                                 | 출처                                    | 배정                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 번들 문법·테마 라이선스 원문(배포 전 필수)                                                                                             | 2번 보고서 「배포 전 필수」             | Task 1                                                                                                                           |
| 긴 줄 많은 큰 파일의 메모리(닫힌 Range·Range 없는 요청 상한, 뷰어 이어받기)                                                            | 2번 보고서 「중요 둘」 1, Task 13 Minor | Task 3                                                                                                                           |
| 멀리 점프하면 색이 늦게 온다                                                                                                           | 2번 보고서 「중요 둘」 2                | Task 15                                                                                                                          |
| ⌘N 직후 문법 첫 로딩의 메인 스레드 멈춤                                                                                                | 2번 보고서 「⌘N 직후 문법 로딩 멈춤」   | Task 15                                                                                                                          |
| Minor 2 설정 화면이 두 창 사이에서 변경을 지움 → patch 명령                                                                            | 2번 보고서 「안전망 계획으로」          | Task 2                                                                                                                           |
| Minor 3 구성 변경 뒤 열린 탭의 옛 언어 해석                                                                                            | 같은 절                                 | Task 4                                                                                                                           |
| Task 4 확장 교체가 원자적이지 않음                                                                                                     | 같은 절                                 | Task 2                                                                                                                           |
| Task 4 설치기 테스트 부재(`archive_prefix`, `MAX_UNPACKED_BYTES`, 심링크 스킵, parent 검사, `check_folder`)                            | 같은 절                                 | Task 2                                                                                                                           |
| Task 13 탭을 닫아도 scan/search 가 취소되지 않음                                                                                       | 같은 절                                 | Task 3                                                                                                                           |
| Task 2 ⇧⌘Z 가 빈 단계를 건너뛰는지 미확인, `undoRestores` 잘림 테스트                                                                  | 같은 절                                 | Task 4                                                                                                                           |
| Task 12 정화기 테스트, 미리보기 notice 테스트                                                                                          | 같은 절                                 | Task 4                                                                                                                           |
| Minor 5 `<!DOCTYPE html>` 대소문자                                                                                                     | 같은 절(판정 대기)                      | **버린다.** 스펙 「확실한 경우만」 — 소문자 doctype 은 인식 안 해도 사람이 상태 표시줄에서 고른다. 보고서에 적는다               |
| Minor 8 `tote-file` 요청마다 스레드 → 풀                                                                                               | 2번 보고서 「성능 계획으로」            | Task 3                                                                                                                           |
| Minor 9 `scan_text`·`search_text` 가 async 안에서 동기 I/O                                                                             | 같은 절                                 | Task 3                                                                                                                           |
| Minor 10 배경 토큰화가 숨은 탭까지 끝까지 돔                                                                                           | 같은 절                                 | Task 15                                                                                                                          |
| 작은 것들: `rescan_extensions` 가 잠금 쥔 채 디스크 훑음, 압축 항목 통째 읽기                                                          | 같은 절                                 | Task 2                                                                                                                           |
| 작은 것들: `tabs.test` 가운데 탭 닫기, `Tabs.list` 직접 변경                                                                           | 같은 절                                 | Task 4                                                                                                                           |
| 작은 것들: `DEFAULT_VARIABLES`·`styles.css` 중복, `Doc.size` getter, MIME 표 주석, Vite `__dirname` 경고, `startWithHugeLog` 내부 접근 | 같은 절                                 | **다음.** 사용자에게 보이는 동작이 없고 각각 리팩터링이라 안전망 계획의 위험을 늘릴 값이 없다. 마켓플레이스 계획의 정리 태스크로 |
| 회귀: 창이 설정을 받기 전 언어 데이터가 비어 ⌘/·괄호가 잠깐 꺼짐, 목록 행 깜빡임                                                       | 같은 절(받아들인 비용)                  | **다음.** 받아들인 판정 그대로                                                                                                   |
| 판정 대기: 병적 정규식 DoS                                                                                                             | 2번 보고서 「판정 대기」                | **다음.** 마켓플레이스 전 점검(「다루지 않는 것」)                                                                               |
| 판정 대기: `LONG_LINE_LIMIT` 언어별 한도                                                                                               | 같은 절                                 | **사람 판단 필요.** 보고서에 올린다                                                                                              |
| 판정 대기: 탭 전환 중 조합 음절 사라짐                                                                                                 | 같은 절                                 | 받아들인 판정 그대로                                                                                                             |
| 미확인: 강제 종료 뒤 미리보기·뷰어·대용량 탭 복원                                                                                      | 2번 보고서 「확인하지 않은 항목」       | Task 17(에이전트 스모크)                                                                                                         |
| 미확인: 한글 조합 중 ⇧⌘V                                                                                                               | 같은 절                                 | Task 18(사람)                                                                                                                    |
| 미확인: 실앱 해시 CSP + `tote-ext` 에서 로컬 이미지·원격 자리표시, 재실행 뒤 미리보기 복원                                             | 같은 절                                 | Task 17                                                                                                                          |
| 미확인: `.txt` → SQL 이 재실행 뒤 유지                                                                                                 | 같은 절                                 | Task 4(E2E)                                                                                                                      |
| 미확인: 같은 `.vsix` 재설치 교체 질문, `extensions/<id>@<버전>/` 폴더                                                                  | 같은 절                                 | Task 17                                                                                                                          |
| 미확인: `(` → `()` 자동 닫힘                                                                                                           | 같은 절                                 | Task 4(E2E)                                                                                                                      |
| 미확인: 마크다운 안 ` ```ts ` 펜스 하이라이트                                                                                          | 같은 절                                 | Task 4(E2E)                                                                                                                      |
| 미확인: 이미지 클릭 토글·캡션 `320×240`                                                                                                | 같은 절                                 | Task 4(E2E)                                                                                                                      |
| 미확인: 영상 탭 왕복                                                                                                                   | 같은 절                                 | Task 17                                                                                                                          |
| 미확인: PDF 「텍스트로 열기」 → 「텍스트로 열 수 없음」                                                                                | 같은 절                                 | Task 4(E2E)                                                                                                                      |
| 미확인: `big.log` 정확 검색·정규식                                                                                                     | 같은 절                                 | Task 4(E2E, 합성 파일)                                                                                                           |
| 미확인: `oneline.txt` 첫 줄 `… (3000000자)`                                                                                            | 같은 절                                 | Task 4(E2E)                                                                                                                      |
| 창 크기 복원 미확인                                                                                                                    | 1번 보고서 「확인하지 못한 것」         | Task 17                                                                                                                          |
| 한때 사라진 메모 탭 여섯(후보: 시작 때 목록 조회 실패)                                                                                 | 같은 절                                 | Task 5(세션 쓰기 막기) + Task 17 에서 지켜본다                                                                                   |
| Dock 종료·로그아웃의 쓰고 닫기                                                                                                         | 1번 계획 「다루지 않는 것」             | Task 7                                                                                                                           |
| 저장 실패 5초 재시도와 종료 경고                                                                                                       | 같은 절                                 | Task 6                                                                                                                           |
| 워크스페이스 위치 다시 지정                                                                                                            | 같은 절                                 | Task 8                                                                                                                           |
| CLI 요청 실패(inbox·가져오기·`-w`)의 알림                                                                                              | 같은 절                                 | Task 5                                                                                                                           |
| Finder 에서 이름이 바뀐 열린 메모의 옛 이름 재생성                                                                                     | 같은 절                                 | Task 11·12                                                                                                                       |
| 시작 때 `listMemos` 실패 시 세션 쓰기 막기, 복구로 ID 가 바뀔 때 사이드바 활성 표시, 「셸 명령 설치」 범위                             | 같은 절                                 | Task 5                                                                                                                           |

---

### Task 1: 번들 라이선스 원문 — NOTICE 에서 뽑아 `LICENSES.md` 에 싣는다

MIT 는 사본에 저작권·허가문을 요구한다. `tm-grammars`·`tm-themes` 패키지의 `NOTICE` 가 문법·테마마다 원문을 블록으로 싣고 있으므로(`Files: … / License: <URL> / SPDX: <id> / ---- / <원문> / ====`), 생성기가 거기서 읽는다. 네트워크는 쓰지 않는다. `yaml`·`toml` 은 NOTICE 에 없다(textmate 번들 출처) — 선택표의 허가문이 원문이다.

**Files:**

- Modify: `scripts/sync-bundled.ts`, `scripts/sync-bundled.test.ts`, `scripts/bundled-languages.ts`(주석만)
- Regenerate: `src-tauri/resources/extensions/tote.languages/LICENSES.md`, `src-tauri/resources/extensions/tote.themes/LICENSES.md`, `src-tauri/resources/extensions/tote.markdown-preview/LICENSES.md`

**Interfaces:**

- Consumes: `checkLicense(name, meta, override): LicenseRow`, `licensesMarkdown(title, rows)`(`scripts/sync-bundled.ts`), `node_modules/tm-grammars/NOTICE`, `node_modules/tm-themes/NOTICE`, `node_modules/marked/LICENSE.md`.
- Produces: `parseNotice(text: string): NoticeBlock[]` with `interface NoticeBlock { files: string[]; url: string; spdx: string; text: string }`; `licenseTextFor(name: string, blocks: NoticeBlock[], override?: BundledLanguage["license"]): string`(원문; 없으면 throw); `LicenseRow` 에 `text: string` 필드 추가; `licensesMarkdown` 이 표 뒤에 라이선스별 원문 절(같은 원문은 한 번, 그 원문을 쓰는 이름들을 머리에)을 붙인다.

- [ ] **Step 1: 실패하는 테스트** — `scripts/sync-bundled.test.ts` 에 더한다.

```ts
describe("parseNotice", () => {
  it("splits the NOTICE into blocks with files, url, spdx and the full text", () => {
    const blocks = parseNotice(readFileSync(require.resolve("tm-grammars/NOTICE"), "utf8"));
    const vscode = blocks.find((b) => b.files.includes("markdown.json"))!;
    expect(vscode.spdx).toBe("MIT");
    expect(vscode.url).toBe("https://raw.githubusercontent.com/microsoft/vscode/main/LICENSE.txt");
    expect(vscode.text).toContain("Copyright (c) 2015 - present Microsoft Corporation");
    expect(vscode.text).toContain("Permission is hereby granted, free of charge");
    expect(vscode.files).toContain("cpp-macro.json");
  });
  it("gives every bundled grammar a text: NOTICE for most, the override for yaml and toml", () => {
    const blocks = parseNotice(readFileSync(require.resolve("tm-grammars/NOTICE"), "utf8"));
    for (const lang of LANGUAGES.filter((l) => l.grammar))
      expect(licenseTextFor(lang.grammar!, blocks, lang.license).length).toBeGreaterThan(100);
    expect(
      licenseTextFor("yaml", blocks, LANGUAGES.find((l) => l.id === "yaml")!.license),
    ).toContain("Permission to copy, use, modify, sell and distribute");
    expect(() => licenseTextFor("no-such-grammar", blocks)).toThrow(/no license text/);
  });
  it("writes each distinct text once, headed by the names that use it", () => {
    const md = licensesMarkdown("t", [
      { name: "a", spdx: "MIT", url: "u", note: "", text: "TEXT-1" },
      { name: "b", spdx: "MIT", url: "u", note: "", text: "TEXT-1" },
      { name: "c", spdx: "textmate-bundle", url: "v", note: "n", text: "TEXT-2" },
    ]);
    expect(md.split("TEXT-1").length).toBe(2);
    expect(md).toMatch(/## a, b\n\nTEXT-1/);
    expect(md).toMatch(/## c\n\nTEXT-2/);
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm vitest run scripts/sync-bundled.test.ts`. Expected: FAIL, `parseNotice is not a function`.

- [ ] **Step 3: 구현** — `parseNotice`: `=====` 줄로 블록을 나누고 각 블록의 `Files:`(쉼표로 분리), `License:`, `SPDX:` 를 읽고 `-----` 줄 뒤부터 끝까지를 `text`(trim)로 둔다. `licenseTextFor`: NOTICE 블록 중 `files` 에 `<name>.json` 이 있는 것의 `text`; 없으면 `override?.note`; 둘 다 없으면 `throw new Error(\`${name}: no license text in NOTICE or bundled-languages.ts\`)`. `syncLanguages`·`syncThemes`가 NOTICE 를 한 번 읽어`rows`의`text`를 채운다.`tote.markdown-preview`의`LICENSES.md`는`marked/LICENSE.md`원문으로(지금 그 파일이 적는 방식을 따라 같은 자리에서 쓴다).`licensesMarkdown`은 표 뒤에`## <이름들>` + 원문을 붙인다.

- [ ] **Step 4: 통과 확인과 재생성** — `pnpm vitest run scripts/sync-bundled.test.ts`(실행 개수 보고), 그 뒤 `pnpm sync:bundled`. 세 `LICENSES.md` 에 `Copyright` 줄이 있는지 `grep -c 'Copyright' src-tauri/resources/extensions/*/LICENSES.md` 로 본다(0 이면 실패). `cargo test --manifest-path src-tauri/Cargo.toml extensions` 가 그대로 통과하는지 본다(번들 폴더를 읽는 테스트가 있다).

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-bundled.ts scripts/sync-bundled.test.ts scripts/bundled-languages.ts src-tauri/resources/extensions/*/LICENSES.md
git commit -m "build(bundled): ship the full license texts of bundled grammars and themes"
```

### Task 2: Rust 이월 — 설정 patch 명령, 확장 교체의 원자성, 설치기 테스트

**Files:**

- Modify: `src-tauri/src/appdata.rs`, `src-tauri/src/app/mod.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/extensions/install.rs`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src/ui/settings.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**

- Consumes: `AppCore::modify_settings(change)`, `Settings`·`ThemeSettings`·`ExtensionSettings`(`appdata.rs`), `install::install`·`installed_folders`(`install.rs`), `Backend.updateSettings`.
- Produces: `#[derive(Default, Deserialize)] pub struct SettingsPatch { workspace_root: Option<Option<PathBuf>>, theme_light: Option<Option<ThemeRef>>, theme_dark: Option<Option<ThemeRef>>, precedence: Option<Precedence> }`(serde `rename_all = "camelCase"`, 바깥 `Option` 은 `#[serde(default, deserialize_with = "double_option")]` — 키가 없으면 그대로, `null` 이면 지운다); `impl SettingsPatch { pub fn apply(&self, settings: &mut Settings) }`; 명령 `patch_settings(patch: SettingsPatch)`; TS `interface SettingsPatch { workspaceRoot?: string | null; themeLight?: ThemeRef | null; themeDark?: ThemeRef | null; precedence?: "user" | "bundled" }`, `Backend.patchSettings(patch: SettingsPatch): Promise<void>`. `updateSettings` 는 지운다(쓰는 곳이 설정 화면뿐이다).

- [ ] **Step 1: 실패하는 테스트(Rust)** — `appdata.rs` 테스트에 `a_patch_changes_only_the_fields_it_names`: `Settings` 에 루트 `/x`·다크 테마·`disabled: ["e"]` 를 두고 `SettingsPatch { theme_light: Some(Some(ThemeRef{…})), ..Default::default() }.apply` 뒤 루트·다크·disabled 가 그대로인지, `workspace_root: Some(None)` 이 루트를 지우는지. `serde_json::from_str::<SettingsPatch>(r#"{"workspaceRoot": null}"#)` 가 `Some(None)` 이고 `"{}"` 가 `None` 인지. `app/mod.rs` 에 `two_windows_patching_different_fields_keep_both`: 스레드 둘이 `core.patch_settings` 로 각각 루트와 precedence 를 바꾸고 둘 다 남는지.

- [ ] **Step 2: 실패하는 테스트(설치기)** — `install.rs` 테스트에 더한다: `archive_prefix_finds_the_manifest_at_root_under_extension_or_a_single_top_folder`(세 모양과, 두 최상위 폴더면 `Invalid`), `an_archive_over_the_unpacked_limit_is_refused`(zip 항목 `size()` 합이 `MAX_UNPACKED_BYTES` 를 넘게 — `zip::write` 로 stored 항목을 쓰고 헤더 크기만 큰 파일 대신 실제로 257MB 를 쓰지 말고, `MAX_UNPACKED_BYTES` 를 `pub(crate)` 로 두고 테스트가 작은 값으로 바꿀 수 있게 `unpack_with_limit(archive, into, limit)` 로 나눈다), `copy_folder_skips_symlinks_and_keeps_files`(폴더 안 심링크가 설치 결과에 없고 일반 파일은 있다 — **격리 성질**), `a_target_outside_the_user_folder_is_refused`(`Manifest` 의 id 알파벳 검사를 우회하는 경우는 없으므로 `stage_and_place` 의 parent 검사를 직접 부르는 테스트: `target.parent() != Some(user_dir)` 분기를 함수 `inside_user_dir(user_dir, target) -> bool` 로 꺼내 `../x@1` 이 false), `a_replace_that_fails_at_the_rename_keeps_the_old_version`(교체 중 `rename(staging → target)` 이 실패하도록 target 자리에 파일을 만들어 두면 옛 폴더가 **남아 있어야** 한다).

- [ ] **Step 3: 실패 확인** — `cargo test --manifest-path src-tauri/Cargo.toml appdata:: app:: extensions::install::`. Expected: 컴파일 실패(`SettingsPatch` 없음) 또는 새 테스트 FAIL.

- [ ] **Step 4: 구현** — `SettingsPatch`·`apply`·`AppCore::patch_settings(&self, patch: SettingsPatch) -> io::Result<()>`(= `modify_settings(|s| patch.apply(s))`), 명령 `patch_settings` 가 `broadcast_config` 까지. 교체 원자성: `stage_and_place` 를 「옛 폴더를 `.trash-<uuid>` 로 rename → `rename(staging, target)` → trash 삭제」 순으로 바꾸고, 가운데 rename 이 실패하면 trash 를 제자리로 되돌린다. 시작 때 `ExtensionStore::scan` 이 `.staging-*`·`.trash-*` 를 지운다(점으로 시작해 이미 목록에서는 빠진다). `rescan_extensions` 는 `self.extensions.scan()` 을 **잠금 밖에서** 먼저 돌리고 결과만 잠금 아래에서 넣는다. `unpack` 의 `read_to_end` + `fs::write` 를 `io::copy(&mut entry, &mut File::create(target)?)` 로.

- [ ] **Step 5: 프론트** — `Backend.patchSettings`, `TauriBackend`(`patch_settings`), `FakeBackend`(필드별 적용), `settings.ts` 의 `save(patch)` 를 「현재 설정을 읽어 통째로 쓰기」에서 `backend.patchSettings({...})` 로. `tests/e2e/settings.spec.ts` 에 `two settings screens do not undo each other`: 페이지 둘(같은 FakeBackend 는 못 나누므로 한 페이지에서 `backend.data.settings` 를 테스트가 바꾼 뒤 화면이 테마를 바꿔도 그 변경이 남는지).

- [ ] **Step 6: 통과 확인** — Rust 테스트, `pnpm test`, `pnpm test:e2e tests/e2e/settings.spec.ts`. 실행 개수 보고.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/appdata.rs src-tauri/src/app/mod.rs src-tauri/src/app/commands.rs src-tauri/src/lib.rs src-tauri/src/extensions/install.rs src-tauri/src/extensions/mod.rs src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src/ui/settings.ts tests/e2e/settings.spec.ts
git commit -m "fix(settings,extensions): patch settings per field, replace extensions atomically, test the installer's guards"
```

### Task 3: `files` 이월 — 닫힌 Range 상한, 뷰어의 이어받기, 스레드 풀, 동기 I/O, 검색 취소

**Files:**

- Modify: `src-tauri/src/files/range.rs`, `src-tauri/src/files/text.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/app/mod.rs`, `src/viewer/large-text.ts`, `src/viewer/large-text.test.ts`, `src/app/controller.ts`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `tests/e2e/large-text-viewer.spec.ts`, `tests/e2e/pages/large-text.ts`
- Modify: `src-tauri/Cargo.toml`(의존 추가 없음 — 풀은 `std::thread` 고정 수로)

**Interfaces:**

- Consumes: `parse_range`, `MAX_OPEN_RANGE`, `respond`(`range.rs`), `LargeTextViewer.page()`·`fetchLog`(뷰어 페이지), `AppCore::begin_search`.
- Produces: `pub const MAX_RANGE: u64 = MAX_OPEN_RANGE`(하나의 이름 — 열린·닫힌·Range 없음 모두 이 상한. `MAX_OPEN_RANGE` 는 지운다); `pub const MAX_FULL_RESPONSE: u64 = 64 * 1024 * 1024` — Range 없는 GET 은 그대로 통째 답하되 길이가 이것을 넘으면 `413 Payload Too Large`(대용량 텍스트 뷰어는 늘 Range 로 읽고, 영상은 WebKit 이 늘 Range 로 읽으며, 64MB 를 넘는 이미지는 뷰어가 「열 수 없음」으로 받는 것이 맞다 — 통째 읽기의 메모리 상한이 이것이다); `files::pool::spawn(f)` — 고정 **4** 스레드의 작업 큐(`std::sync::mpsc` + 워커 스레드, `OnceLock`)로 `tote-file` 응답을 돌린다; `scan_text`·`search_text` 명령은 `tauri::async_runtime::spawn_blocking` 으로 감싼다; 명령 `cancel_text_search()` 가 `core.begin_search(label, 0)`; `Backend.cancelTextSearch(): Promise<void>`; 뷰어 `page()` 는 `Content-Range` 의 끝이 요청 끝보다 앞이면 그 다음 바이트부터 다시 요청해 이어 붙인다.

- [ ] **Step 1: 실패하는 테스트(Rust)** — `range.rs`: `a_closed_range_is_cut_to_the_limit_too`(`bytes=0-<3·MAX_RANGE>` → `Partial{0, MAX_RANGE-1}`), `a_full_request_over_the_limit_is_413_and_under_it_is_200`(길이 `MAX_FULL_RESPONSE+1` 의 sparse 파일, Range 없음 → 413, body 비어 있음; 길이 `MAX_RANGE+1` 은 200 에 통째). `files/pool.rs`: `jobs_run_on_at_most_four_threads_and_all_finish`(50개 작업이 모두 끝나고 동시에 돈 최대 수 ≤ 4).

- [ ] **Step 2: 실패하는 테스트(뷰어)** — `large-text.test.ts` 에 `continueRange(requested: [number, number], contentRange: string): [number, number] | null` 순수 함수 테스트: `bytes 0-8388607/20000000` 에 요청 `[0, 9999999]` → `[8388608, 9999999]`; 끝까지 왔으면 `null`. `tests/e2e/large-text-viewer.spec.ts` 에 `a page longer than one range answer is fetched in pieces`: 테스트 페이지의 가짜 서버(`tests/e2e/pages/large-text.ts`)가 한 답에 최대 N 바이트만 주도록 `?maxRange=<n>` 을 받고, `fetchLog` 에 이어진 요청 둘이 남고 줄 텍스트가 온전한지.

- [ ] **Step 3: 실패하는 테스트(취소)** — `tests/e2e/large-text-viewer.spec.ts` 의 `closing the viewer cancels its search`: `FakeBackend.data.textSearchCancelled: number` 를 `cancelTextSearch` 가 올린다; 뷰어 탭을 닫으면 1.

- [ ] **Step 4: 실패 확인** — `cargo test --manifest-path src-tauri/Cargo.toml files::`, `pnpm vitest run src/viewer`, `pnpm test:e2e tests/e2e/large-text-viewer.spec.ts`.

- [ ] **Step 5: 구현** — 위 Interfaces 대로. `lib.rs` 의 `tote-file` 핸들러는 `std::thread::spawn` 대신 `files::pool::spawn`. `controller.ts` 의 `closePanel` 이 패널이 `LargeTextViewer` 면 `backend.cancelTextSearch()` 를 부른다. 뷰어 `page()` 의 fetch 를 루프로: 응답이 206 이고 `continueRange` 가 다음 범위를 주면 다시 fetch 해 `Uint8Array` 들을 이어 붙인다(200 이면 지금처럼 `subarray`).

- [ ] **Step 6: 통과 확인** — 같은 명령들. 실행 개수 보고. 메모리 확인: `tests/measure` 가 아니라 손으로 — 190MB 합성 로그를 `TOTE_DATA_DIR` 임시 폴더로 띄운 디버그 앱(`TOTE_BACKGROUND=1`)에서 열고 `ps -o rss= -p <pid>` 가 300MB 를 넘지 않는지 적는다(Task 16 이 정식으로 잰다).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/files src-tauri/src/lib.rs src-tauri/src/app/commands.rs src-tauri/src/app/mod.rs src/viewer/large-text.ts src/viewer/large-text.test.ts src/app/controller.ts src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts tests/e2e/large-text-viewer.spec.ts tests/e2e/pages/large-text.ts
git commit -m "fix(files): bound every range answer, read long pages in pieces, pool the file threads, cancel a closed viewer's search"
```

### Task 4: 프론트 이월 — 구성 변경 뒤 언어 재구성, ⇧⌘Z, 정화기 테스트, 2번 스모크 미확인 항목의 E2E

**Files:**

- Modify: `src/app/controller.ts`, `src/app/tabs.ts`, `src/app/tabs.test.ts`, `src/editor/ime.test.ts`, `tests/e2e/editor.spec.ts`, `tests/e2e/markdown.spec.ts`, `tests/e2e/highlight.spec.ts`, `tests/e2e/media.spec.ts`, `tests/e2e/external.spec.ts`, `tests/e2e/language.spec.ts`, `tests/e2e/large-text.spec.ts`
- Create: `tests/e2e/carried-over.spec.ts`(여기 모을 수 없는 것은 각 spec 에)

**Interfaces:**

- Consumes: `AppController.onConfigChanged`·`reconfigureLanguage(doc)`, `Tabs.list`, `undoWithCursors`·`undoRestores`(`src/editor/ime.ts`), `sanitize`(마크다운 뷰어 템플릿 안의 정화 함수 — `src-tauri/resources/extensions/tote.markdown-preview/viewer.template.html`), `window.ime`(`tests/e2e/pages/editor.ts`).
- Produces: `Tabs.push(doc: Doc): void`(`SessionSync.restore` 가 `list.push` 대신 쓴다 — `list` 는 `readonly Doc[]` 로 밖에서 못 바꾸게); `onConfigChanged` 가 확장 집합이 바뀌었으면 열린 탭마다 `doc.refreshLanguage()` 를 부른다.

- [ ] **Step 1: 실패하는 단위 테스트** — `tabs.test.ts`: `closing the middle tab keeps the order of the rest and activates the next`; `src/editor/ime.test.ts`: `undoRestores drops the records past an undo`(음절 둘 입력 → 레코드 둘 → ⌘Z 하나 → 레코드 하나). `tests/e2e/editor.spec.ts`: `redo after two undos of two syllables brings both back with every cursor`(⌥클릭 커서 셋, `ime` 로 `가`·`나` 조합 → ⌘Z ×2 → ⇧⌘Z ×2 → 세 줄 모두 `가나`, 커서 셋) — **먼저 지금 코드로 돌려 결과를 적는다**: 통과면 고칠 것이 없고 테스트만 남긴다, 실패면 `redoWithCursors` 를 `undoWithCursors` 의 거울로 `zedKeymap` 에 `Mod-Shift-z` 로 넣는다.

- [ ] **Step 2: 실패하는 E2E** — 각 한 줄씩:
  - `language.spec.ts`: `a language picked for an external .txt survives a restart`(SQL 선택 → 세션에 `"language":"sql"` → reload → 상태 표시줄 `SQL`).
  - `editor.spec.ts`: `typing ( closes it`(TypeScript 메모에서 `(` → 문서 `()`).
  - `highlight.spec.ts`: `a ts fence inside markdown is coloured`(`?file=note.md&highlight=1` 페이지에 ` ```ts\nconst a = 1;\n``` ` → `const` 토큰에 `tm-c*` 클래스).
  - `media.spec.ts`: `clicking an image toggles fit and the caption shows its size`(`pic.png` 320×240 픽스처 → 캡션 `320×240`, 클릭마다 `fit` 클래스 토글).
  - `external.spec.ts`: `a PDF offers 텍스트로 열기 and then says it cannot`(`doc.pdf` 바이트 `%PDF-1.4\0…` → 자리표시 「열 수 없음」 + 버튼 → 누르면 「텍스트로 열 수 없음」).
  - `large-text.spec.ts`: `a synthetic big log finds an exact line and a regex`(`FakeData.files` 에 100MB 는 못 넣으므로 `MAX_EDITOR_BYTES` 를 넘기는 대신 `LONG_LINE_LIMIT` 를 넘는 합성 파일로 뷰어를 열고, 10만 줄 `<n> lorem ipsum` 합성 파일에서 정확 검색 `99990` → `1 / 1`, 정규식 `^1000+ ` → `+` 없는 수), `the first line of a long one-line file ends with the count`(`… (300000자)`).
  - `markdown.spec.ts`: `the sanitizer drops on* handlers and script tags independently of CSP`(뷰어 페이지에 `<img onerror=x>`·`<script>` 가 든 텍스트 → DOM 에 `onerror` 속성·`script` 요소 없음), `a notice above the preview shows the document's notice`.
  - `carried-over.spec.ts`: `a config change reconfigures the language of every open tab`(탭 둘을 `.sh` 로 열고 `backend.data.extensionFiles` 로 shellscript 의 `language-configuration` 을 `lineComment: "##"` 로 바꾼 뒤 `backend.config()` → 두 탭 모두 ⌘/ 가 `## `).

- [ ] **Step 3: 실패 확인** — `pnpm vitest run src/app/tabs.test.ts src/editor/ime.test.ts`, `pnpm test:e2e`(새 테스트 이름으로 `-g`). Expected: 새 테스트가 FAIL(언어 재구성·정화기 테스트는 구현이 이미 맞으면 바로 PASS 일 수 있다 — 그 경우 그대로 두고 보고에 적는다).

- [ ] **Step 4: 구현** — `onConfigChanged`: `signature !== this.extensionSet` 분기 안에서 `for (const doc of this.tabs.list) void doc.refreshLanguage()`. `Tabs.push`. 필요하면 `redoWithCursors`.

- [ ] **Step 5: 통과 확인** — 같은 명령. 실행 개수 보고.

- [ ] **Step 6: Commit**

```bash
git add src/app/controller.ts src/app/tabs.ts src/app/tabs.test.ts src/app/session-sync.ts src/editor/ime.ts src/editor/ime.test.ts src/editor/setup.ts tests/e2e
git commit -m "test(e2e): pin the items the extensions smoke left unverified; reconfigure open tabs after a config change"
```

### Task 5: 시작 안전 — `listMemos` 실패 시 세션 쓰기 막기, 사이드바 활성 표시, CLI 실패 알림, 「셸 명령 설치」 범위

**Files:**

- Modify: `src/app/controller.ts`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src-tauri/src/app/requests.rs`, `src-tauri/src/cli/install.rs`, `src-tauri/src/app/menu.rs`, `tests/e2e/memo.spec.ts`
- Create: `tests/e2e/startup.spec.ts`

**Interfaces:**

- Consumes: `AppController.start`·`refreshMemos`·`restoring`, `MemoList.setActive`, `requests::handle`, `install::is_tote_link`.
- Produces: 이벤트 `tote://notice`(payload `string`) 와 `Backend.onNotice(handler: (message: string) => void)`; `FakeBackend.notice(message)`; `requests::handle` 이 stderr 대신(함께) 그 창에 `tote://notice` 를 보낸다 — 「`<경로>` 를 가져오지 못했습니다: <이유>」, 「워크스페이스가 없습니다: <이름>」, 「표준 입력을 받지 못했습니다」; `install::is_tote_link(script, at)` 는 링크 대상의 앱 번들 이름(`<name>.app`)이 `script` 의 것과 같을 때만 true(`tote-dev.app` 의 설치가 `tote.app` 의 링크를 바꾸지 않는다).

- [ ] **Step 1: 실패하는 테스트** — `startup.spec.ts`: `a failed memo listing at start keeps the session file as it was`(`FakeData.failListMemos: number` 를 두고 처음 n 번의 `listMemos` 가 `io` 로 거부 → 세션이 탭 둘을 가진 채 시작 → 상태 표시줄 오류, `backend.data.session` 이 **바뀌지 않음**(탭 둘 그대로) → 창 focus 이벤트(`page.evaluate(() => window.dispatchEvent(new Event("focus")))`)로 다시 읽기 성공 → 탭 둘 복원 → 그때부터 세션이 쓰인다). `memo.spec.ts`: `recovering a vanished memo moves the sidebar highlight to the new memo`(옛 메모 삭제 뒤 타이핑 → 새 메모 행이 `active`). `startup.spec.ts`: `a CLI failure shows in the status bar`(`backend.notice("워크스페이스가 없습니다: 없는곳")` → 상태 표시줄 오류 문구). Rust `install.rs`: `a_link_of_another_bundle_name_is_not_replaced`(`/Applications/tote.app/Contents/Resources/bin/tote` 를 가리키는 링크는 `tote-dev.app` 의 설치가 `AlreadyExists` 로 거절, 같은 이름의 옛 위치 링크는 교체).

- [ ] **Step 2: 실패 확인** — `pnpm test:e2e tests/e2e/startup.spec.ts tests/e2e/memo.spec.ts`, `cargo test --manifest-path src-tauri/Cargo.toml cli::install`.

- [ ] **Step 3: 구현** — `start()`: `refreshMemos` 가 실패하면 `restoring` 을 `true` 로 유지하고 `memosLoaded = false`; `session.restore()` 는 돌리되 탭 목록은 비어 있으므로(메모 정보가 없다) 세션 복원을 **미룬다** — 다음 `refreshMemos` 성공 때 `session.restore()` 를 다시 돌려 탭을 채우고 `restoring = false`. 그 사이 `saveSessionSoon`·`saveSessionNow` 는 아무것도 쓰지 않는다(`flushAll` 도). `changed(doc, "info")` 에서 `doc === tabs.active` 면 `memoList.setActive(doc.info.id)`. `requests.rs` 의 각 `eprintln!` 자리에 `notify(app, &label, message)`. `is_tote_link` 의 비교는 `app_bundle_name(path) -> Option<&OsStr>`(`…/<name>.app/Contents/…` 에서 `<name>.app`) 가 같을 때.

- [ ] **Step 4: 통과 확인** — 같은 명령. 실행 개수 보고.

- [ ] **Step 5: Commit**

```bash
git add src/app/controller.ts src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src-tauri/src/app/requests.rs src-tauri/src/cli/install.rs tests/e2e/startup.spec.ts tests/e2e/memo.spec.ts
git commit -m "fix(app): never write a session over one that could not be restored; report CLI failures in the window; scope the shell command install to its own bundle"
```

### Task 6: 저장 실패 — 탭 표시, 5초 재시도, 종료·창 닫기 경고

**Files:**

- Modify: `src/app/docs.ts`, `src/app/docs.test.ts`, `src/app/controller.ts`, `src/ui/tab-bar.ts`, `src/styles.css`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src-tauri/src/app/flush.rs`, `src-tauri/src/app/lifecycle.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/app/mod.rs`, `src-tauri/src/lib.rs`
- Create: `tests/e2e/save-failure.spec.ts`

**Interfaces:**

- Consumes: `MemoDoc.save/saveNow/unsaved`, `ExternalDoc.keepDraft`, `WriteScheduler.schedule`, `FlushCoordinator::{begin, ack, expire, window_gone}`·`FlushGoal`(`flush.rs`), `lifecycle::{begin, ack, finish}`, `TabBar.render` 의 항목.
- Produces: `export const SAVE_RETRY_MS = 5000`; `Doc.saveFailed: boolean`(탭 항목 `failed: boolean`, 탭 제목 뒤 ` ⚠`, 탭 `title` 속성에 오류 문구); `Backend.flushDone(id, blocked?: string)` — `blocked` 는 막는 이유(「저장하지 못한 메모 2개」); Rust 명령 `flush_done(id: u64, blocked: Option<String>)`; `FlushCoordinator::ack(id, label, blocked: Option<String>) -> Ack` with `enum Ack { Pending, Done(FlushGoal), Blocked { goal: FlushGoal, reasons: Vec<String> } }`; `lifecycle::ack` 가 `Blocked` 면 `tauri-plugin-dialog` 의 `ask`(제목 「저장하지 못한 메모가 있습니다」, 본문 reasons, 버튼 「그래도 종료」/「취소」 — 창 닫기면 「그래도 닫기」) 를 띄우고 「그래도」면 `finish`, 「취소」면 `FlushCoordinator::cancel(id)`(라운드를 버리고 `quitting` 을 되돌린다). 라운드가 timeout 으로 끝나면 막힘을 묻지 않고 `finish`(멈춘 창이 종료를 막지 않는다 — 1번 계획의 규칙).

- [ ] **Step 1: 실패하는 테스트(Rust)** — `flush.rs`: `a_blocked_ack_ends_the_round_as_blocked_with_its_reasons`(창 둘, 하나는 막힘, 하나는 정상 → 마지막 ack 에서 `Blocked{reasons: ["…"]}`), `a_blocked_round_ends_with_a_cancel`(`cancel(id)` 뒤 `ack` 가 `Pending` 이 아니라 무시되고 새 라운드를 시작할 수 있다), `app/mod.rs`: `cancelling_a_quit_round_clears_quitting`.

- [ ] **Step 2: 실패하는 테스트(프론트)** — `docs.test.ts`: `a failed save is retried after SAVE_RETRY_MS and the tab says so`(FakeBackend 의 `failWrites: number` 로 처음 2번 거부 → `saveFailed` true → 가짜 타이머 5초 → 재시도 → 성공 → false). `save-failure.spec.ts`: `a failing save marks the tab and keeps the text`(탭에 `failed` 클래스·⚠, 상태 표시줄 오류, 본문 그대로), `a quit with a failed save asks first and cancel keeps the app`(`backend.requestFlush(7)` → `backend.data.flushed` 에 `{id: 7, blocked: "저장하지 못한 메모 1개"}`), `a flush with everything saved answers without a reason`.

- [ ] **Step 3: 실패 확인** — `cargo test --manifest-path src-tauri/Cargo.toml app::`, `pnpm vitest run src/app/docs.test.ts`, `pnpm test:e2e tests/e2e/save-failure.spec.ts`.

- [ ] **Step 4: 구현** — `MemoDoc.save` 의 실패 분기(`unknown-memo` 외)에서 `saveFailed = true; host.changed(this, "dirty"); host.writes.schedule(saveKey, SAVE_RETRY_MS, () => this.save())`; 성공하면 `saveFailed = false`. `ExternalDoc.keepDraft` 실패도 같은 재시도(수정분을 잃는 것도 손실이다). `AppController.onFlush`: `flushAll` 뒤 `tabs.list.filter(d => d.saveFailed)` 가 있으면 `flushDone(id, \`저장하지 못한 메모 ${n}개\`)`. `FakeBackend.flushDone(id, blocked)`는`data.flushed`에`{id, blocked}`를 넣는다(지금의`number[]`를 바꾸고 기존 테스트를 맞춘다). Rust 는 Interfaces 대로.`lib.rs`의`RunEvent::ExitRequested` 처리는 Task 7 이 바꾼다 — 여기서는 건드리지 않는다.

- [ ] **Step 5: 통과 확인** — 같은 명령. 실행 개수 보고. 실앱 확인(디버그 빌드, `TOTE_DATA_DIR`·`TOTE_BACKGROUND=1`): 워크스페이스 폴더를 `chmod 555` 로 잠그고 메모를 치면 탭에 ⚠, ⌘Q 때 대화상자가 뜨는지 — 사람의 화면이 필요하므로 Task 17 의 표에도 넣는다.

- [ ] **Step 6: Commit**

```bash
git add src/app/docs.ts src/app/docs.test.ts src/app/controller.ts src/ui/tab-bar.ts src/styles.css src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src-tauri/src/app tests/e2e/save-failure.spec.ts tests/e2e
git commit -m "feat(app): retry a failed save every five seconds and warn before quitting with one"
```

### Task 7: Dock 종료·로그아웃의 쓰고 닫기

Dock 의 「종료」와 로그아웃은 macOS 의 `terminate:` 로 들어와 메뉴의 「tote 종료」(`lifecycle::begin(Quit)`)를 거치지 않는다. Tauri 2 는 이것을 `RunEvent::ExitRequested { code: None }` 으로 넘긴다(tao 의 `applicationShouldTerminate:` 가 종료를 미루고 이벤트를 보낸다). 지금 `lib.rs` 는 그 이벤트를 「마지막 창이 닫혔다」로만 읽고 `prevent_exit` 한다 — 그래서 Dock 종료가 **아무것도 쓰지 않고 그냥 꺼지거나, 반대로 꺼지지 않는다**(어느 쪽인지는 Step 1 이 확인한다).

**Files:**

- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/app/lifecycle.rs`, `src-tauri/src/app/mod.rs`

**Interfaces:**

- Consumes: `RunEvent::ExitRequested { code, api }`, `lifecycle::begin(app, FlushGoal::Quit)`, `AppCore::is_quitting`, `app.webview_windows()`.
- Produces: `lib.rs` 의 규칙 — `ExitRequested { code: None }` 이고 열린 창이 **없으면** `prevent_exit`(Dock 에 남는다, 지금과 같다); 열린 창이 **있고** `is_quitting()` 이 거짓이면 `prevent_exit` 뒤 `lifecycle::begin(app, FlushGoal::Quit)`(쓰고 닫기가 끝나면 `finish` 가 `app.exit(0)` 으로 다시 들어오고 그때는 `code: Some(0)` 이라 통과한다); `AppCore::has_windows() -> bool`.

- [ ] **Step 1: 재현을 먼저 기록한다** — 디버그 빌드를 `TOTE_DATA_DIR=<임시>` `TOTE_BACKGROUND=1` 로 띄우고 `lib.rs` 의 `app.run` 콜백에 임시 `eprintln!("run event: {event:?}")` 를 넣어, 터미널에서 `osascript -e 'quit app "tote-dev"'`(Dock 종료와 같은 `terminate:` 경로)를 보냈을 때 어떤 `RunEvent` 가 오는지 적는다. 세 경우를 적는다: `ExitRequested{code: None}` 이 온다 / 아무 이벤트 없이 꺼진다 / 꺼지지 않는다. 이 기록이 Step 3 의 분기를 정한다.

- [ ] **Step 2: 실패하는 테스트** — `app/mod.rs`: `has_windows_follows_register_and_closed`. 종료 경로 자체는 단위 테스트가 닿지 않는다 — Step 4 의 실앱 확인이 테스트다.

- [ ] **Step 3: 구현** — Step 1 이 `ExitRequested{code: None}` 을 보였으면 Interfaces 대로. 아무 이벤트 없이 꺼졌으면(tao 가 `NSTerminateNow` 를 돌려준다는 뜻) `objc2` 로 `NSApplicationDelegate` 의 `applicationShouldTerminate:` 를 바꿔 달아 `lifecycle::begin(Quit)` 뒤 `NSTerminateLater` 를 돌려주고 `finish` 가 `replyToApplicationShouldTerminate:` 를 부른다 — 이 경우 의존 `objc2`·`objc2-app-kit` 추가. **둘 중 어느 쪽을 했는지 보고에 적는다.**

- [ ] **Step 4: 실앱 확인(에이전트, 사람의 화면 없이)** — `TOTE_DATA_DIR=<임시>` `TOTE_BACKGROUND=1` 로 띄우고 `osascript -e 'tell application "tote-dev" to activate'` 없이(배경 유지) `orca computer type-text` 로 메모에 글을 넣자마자(0.3초 안에) `osascript -e 'quit app "tote-dev"'`. 재실행 뒤 그 글이 파일에 있고 세션에 탭이 있으면 통과. 3회 반복. `~/Tote-dev`·`~/Library/Application Support/tote-dev` 가 안 생겼는지 검사.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/app/lifecycle.rs src-tauri/src/app/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "fix(app): a Dock quit or logout writes pending edits before tote goes"
```

### Task 8: 워크스페이스 위치 다시 지정 — 「찾을 수 없음」

**Files:**

- Modify: `src-tauri/src/appdata.rs`, `src-tauri/src/app/mod.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/lib.rs`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src/ui/dialogs.ts`, `src/app/controller.ts`, `tests/e2e/dialogs.spec.ts`

**Interfaces:**

- Consumes: `LaunchState { open_windows, recent }`, `list_workspaces`, `workspacePicker(items, actions)`, `Backend.pickFolder`.
- Produces: `WorkspaceListItem.missing: boolean`(최근 목록에 있으나 폴더가 없거나 `.tote/workspace.json` 이 없는 항목 — 루트 아래 목록 **뒤에** 붙는다); Rust `LaunchState::relocate(&mut self, from: &Path, to: &Path)`(`recent`·`open_windows` 의 `from` 을 `to` 로); 명령 `relocate_workspace(from: String, to: String)` — `to` 가 워크스페이스가 아니면 `not-a-workspace`; 바꾼 뒤 `windows::show(to)`; `Backend.relocateWorkspace(from, to): Promise<void>`; 피커의 「찾을 수 없음」 행은 클릭하면 `pickFolder` → `relocateWorkspace`; `PickerActions.relocate(from: string): Promise<string | null>`.

- [ ] **Step 1: 실패하는 테스트** — `appdata.rs`: `relocate_moves_every_mention_of_the_path`. `commands.rs` 에는 `list_workspaces` 가 Tauri 상태를 받아 단위 테스트가 어렵다 — 목록 조립을 `fn workspace_items(root: &Path, recent: &[PathBuf], is_open: impl Fn(&Path) -> bool) -> Vec<WorkspaceListItem>` 로 꺼내고 `a_recent_workspace_whose_folder_is_gone_is_listed_as_missing` 테스트. `dialogs.spec.ts`: `a missing workspace offers to relocate`(`workspaces` 에 `{name: "옛", path: "/gone/옛", open: false, missing: true}` → 행에 「(찾을 수 없음)」 → 클릭 → `picks` 의 폴더로 `relocateWorkspace("/gone/옛", "/new/옛")` 호출 기록).

- [ ] **Step 2: 실패 확인** — `cargo test --manifest-path src-tauri/Cargo.toml appdata:: app::commands`, `pnpm test:e2e tests/e2e/dialogs.spec.ts`.

- [ ] **Step 3: 구현** — Interfaces 대로. `windows::restore` 가 `open_windows` 의 사라진 경로를 만나면(지금은 stderr) 그 경로를 그대로 두고 다음 피커에 「찾을 수 없음」으로 나오게 한다 — 지우지 않는다(사람이 옮긴 폴더를 다시 찾을 기회).

- [ ] **Step 4: 통과 확인** — 같은 명령. 실행 개수 보고.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/appdata.rs src-tauri/src/app src-tauri/src/lib.rs src/backend src/ui/dialogs.ts src/app/controller.ts tests/e2e/dialogs.spec.ts
git commit -m "feat(workspace): list a vanished workspace as missing and let the person point tote at its new place"
```

### Task 9: Rust `backup` — 스냅샷, 하드링크, 보존 정책

**Files:**

- Create: `src-tauri/src/backup/mod.rs`, `src-tauri/src/backup/snapshot.rs`, `src-tauri/src/backup/retention.rs`
- Modify: `src-tauri/src/lib.rs`(`pub mod backup`), `src-tauri/src/appdata.rs`(`backups_dir`), `src-tauri/src/persist/mod.rs`(`is_binary` 공용), `src-tauri/Cargo.toml`(`filetime = "0.2"` — 테스트에서 mtime 조작; `chrono` 는 넣지 않는다, 로컬 시각 폴더 이름은 `libc::localtime_r` 대신 `std::time` + 수동 변환이 아니라 **`time` 크레이트(`time = { version = "0.3", features = ["local-offset", "formatting", "parsing", "macros"] }`)** 를 쓴다)

**Interfaces:**

- Consumes: `atomic_write`, `content_hash`, `read_json`, `write_json`(`persist`), `memo_files(root)`(`workspace/index.rs`), `TOTE_DIR`.
- Produces(`backup/mod.rs`):
  - `pub const INTERVAL: Duration = Duration::from_secs(600)`, `pub const KEEP_ALL_FOR: Duration = 24h`, `pub const KEEP_DAILY_FOR: Duration = 30d`, `pub const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024`.
  - `pub struct BackupDir { root: PathBuf /* backups/<workspace id> */ }`, `BackupDir::new(backups_dir: &Path, workspace_id: &str)`, `BackupDir::snapshots(&self) -> io::Result<Vec<SnapshotName>>`(이름 순, `.tmp-*`·그 밖의 것 제외), `BackupDir::remove_leftovers(&self)`.
  - `#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)] pub struct SnapshotName(OffsetDateTime)` with `fn format(&self) -> String /* YYYYMMDD-HHMMSS */`, `fn parse(name: &str) -> Option<SnapshotName>`, `fn day(&self) -> Date`.
  - `pub fn is_binary(bytes: &[u8]) -> bool`(앞 8KB 에 NUL) — `persist` 로 옮겨 `codec`·외부 파일 판정과 하나로.
- Produces(`snapshot.rs`): `#[derive(Serialize, Deserialize)] pub struct Manifest { version: 1, files: BTreeMap<String, FileRecord>, skipped: Vec<Skipped> }`, `pub struct FileRecord { size: u64, mtime_ms: u64, sha256: String }`, `pub struct Skipped { file: String, reason: SkipReason /* Binary | TooLarge | Changed(파일이 찍는 도중 바뀜) */ }`; `pub fn take(workspace_root: &Path, dir: &BackupDir, now: SnapshotName) -> io::Result<Option<PathBuf>>` — 직전 스냅샷의 `.tote/manifest.json` 을 읽고, `memo_files` 의 파일마다 크기·mtime 이 직전과 같으면 그 해시를 그대로, 아니면 읽어서 해시; 해시가 직전과 같고 직전 사본이 있으면 `fs::hard_link(prev_copy, new_copy)`, 아니면 `fs::copy`(macOS 의 std `fs::copy` 는 APFS clone 을 쓴다); `.tote/index.json` 은 항상 복사; 임시 폴더 `.tmp-<name>` 에 만들어 `rename`; 담을 파일이 하나도 없으면(워크스페이스가 비었다) `Ok(None)`.
- Produces(`retention.rs`): `pub fn to_remove(snapshots: &[SnapshotName], now: SnapshotName) -> Vec<SnapshotName>` — 순수 함수; `pub fn prune(dir: &BackupDir, now: SnapshotName) -> io::Result<usize>`.

- [ ] **Step 1: 실패하는 테스트(보존, 순수)** — `retention.rs`: `keeps_everything_from_the_last_24_hours`, `keeps_only_the_last_snapshot_of_each_older_day`, `drops_everything_older_than_30_days`, `a_day_boundary_is_the_local_date`(`23:59:30` 과 다음날 `00:00:30` 이 다른 날 — `SnapshotName::day`). 이름: `snapshot_names_round_trip_and_sort`(`20261012-153000` 파싱·포맷, 순서).

- [ ] **Step 2: 실패하는 테스트(스냅샷)** — `snapshot.rs` 테스트, 모두 `tempfile`:
  - `a_snapshot_is_a_plain_folder_with_the_text_files_and_the_index`(`a.md`·`b.sh`·`pic.png`(NUL 포함)·`.tote/sessions/d.json` → 스냅샷에 `a.md`·`b.sh`·`.tote/index.json` 만, `pic.png`·세션 없음, 매니페스트 `skipped` 에 `pic.png: Binary`).
  - `unchanged_files_are_hard_linked_to_the_previous_copy_never_to_the_workspace`(두 번 찍고 `a.md` 그대로 → 두 사본의 `(dev, ino)` 가 같고, 워크스페이스 `a.md` 의 ino 와는 다르다; `b.sh` 를 바꾸면 새 사본의 ino 가 다르다).
  - `a_file_edited_in_place_by_another_app_does_not_change_an_older_snapshot`(스냅샷 뒤 워크스페이스 파일을 `OpenOptions::append` 로 제자리 수정 → 스냅샷 사본 내용 그대로).
  - `size_and_mtime_short_circuit_the_hash`(mtime·크기를 같게 두고 내용만 바꾼 파일은 **같다고 본다** — 이 함정을 테스트 이름으로 적어 두고 주석에 「mtime 을 보존한 채 내용만 바꾸는 도구는 다음 스냅샷을 속인다 — 받아들인 비용」).
  - `a_file_replaced_mid_snapshot_is_skipped_not_fatal`(`take` 에 `read: impl Fn(&Path) -> io::Result<Vec<u8>>` 훅을 두어 테스트가 한 파일에 `NotFound` 를 돌려주게 → 결과 `Some`, 그 파일은 `skipped: Changed`).
  - `files_over_the_limit_are_skipped`(`MAX_FILE_BYTES + 1` sparse → `TooLarge`).
  - `a_crash_mid_snapshot_leaves_only_a_tmp_folder_that_the_next_start_removes`(`.tmp-20261012-000000` 을 손으로 만들고 `remove_leftovers` → 없음, `snapshots()` 에 안 보임).
  - `an_empty_workspace_takes_no_snapshot`.

- [ ] **Step 3: 실패 확인** — `cargo test --manifest-path src-tauri/Cargo.toml backup::`. Expected: 컴파일 실패.

- [ ] **Step 4: 구현** — Interfaces 대로. 해시는 `content_hash`. `take` 의 순서: 매니페스트 읽기 → 파일 목록 → 파일마다 판정·복사/링크(실패한 파일은 `Changed` 로 건너뛴다) → `index.json` 복사 → 매니페스트 쓰기(`write_json`) → `rename(tmp, final)`. 하드링크가 실패하면(다른 볼륨 등) 복사로 대신한다.

- [ ] **Step 5: 통과 확인** — `cargo test --manifest-path src-tauri/Cargo.toml backup::`. 실행 개수 보고. `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/backup src-tauri/src/lib.rs src-tauri/src/appdata.rs src-tauri/src/persist/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(backup): workspace snapshots with hard links to the previous copy and the 24h/30d retention"
```

### Task 10: 백업 스케줄러, 「백업 폴더 열기」, 메모의 「이전 버전」 미리보기·되돌리기

**Files:**

- Create: `src-tauri/src/backup/versions.rs`, `src/ui/versions.ts`, `tests/e2e/backup.spec.ts`
- Modify: `src-tauri/src/backup/mod.rs`, `src-tauri/src/workspace/mod.rs`, `src-tauri/src/workspace/ops.rs`, `src-tauri/src/app/mod.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/app/menu.rs`, `src-tauri/src/lib.rs`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src/app/controller.ts`, `src/app/docs.ts`, `src/styles.css`

**Interfaces:**

- Consumes: `BackupDir`, `snapshot::take`, `retention::prune`, `Manifest`(Task 9), `Workspace`·`AppCore::workspace(label)`, `menu::build`, `modal`(`dialogs.ts`), `MemoDoc.state`·`EditorView.dispatch`.
- Produces(Rust):
  - `Workspace::mark_changed(&mut self)` / `take_changed(&mut self) -> bool` — `ops.rs` 의 쓰기 연산 전부가 `mark_changed` 를 부른다.
  - `AppCore::backup_tick(&self, now: SnapshotName) -> Vec<(String /* label */, io::Result<Option<PathBuf>>)>` — 열린 창마다 `take_changed` 면 `take` → `prune`; `lib.rs` 의 `setup` 이 `std::thread` 하나로 `INTERVAL` 마다 부른다(디버그 빌드는 `TOTE_BACKUP_INTERVAL_SECS` 로 짧게 — 에이전트 스모크용).
  - `versions.rs`: `#[derive(Serialize)] pub struct Version { snapshot: String, file: String, size: u64, sha256: String }`; `pub fn list(dir: &BackupDir, memo_id: &str) -> io::Result<Vec<Version>>` — 최신 스냅샷부터, 각 스냅샷의 `.tote/index.json` 에서 `memo_id` 의 파일 이름을 찾고(이름이 바뀌어도 따라간다) 매니페스트의 `sha256` 가 **인접(다음 오래된) 스냅샷과 다른 것만** 남긴다; `pub fn read(dir: &BackupDir, snapshot: &str, file: &str) -> io::Result<Vec<u8>>`(`snapshot`·`file` 은 한 경로 조각이어야 한다 — `/`·`..` 거절); `pub fn reveal(dir: &BackupDir) -> io::Result<()>`(macOS: `open <dir>`; 폴더가 없으면 만들고 연다).
  - 명령: `list_versions(id) -> Vec<Version>`, `read_version(snapshot, file) -> Response`(바이너리), `reveal_backups()`.
  - 메뉴 「파일」에 「이전 버전…」(단축키 없음) 과 「백업 폴더 열기」 — 둘 다 `tote://menu` 로 `versions`·`reveal-backups`.
- Produces(TS): `Backend.listVersions(id)`, `readVersion(snapshot, file): Promise<Uint8Array>`, `revealBackups()`; `FakeData.backups: Record<string /* memo id */, { snapshot: string; file: string; text: string }[]>`; `openVersions(versions, read): Promise<{ snapshot: string; text: string } | null>`(`ui/versions.ts` — 왼쪽 목록(`YYYY-MM-DD HH:MM:SS` 로 보인다), 오른쪽 읽기 전용 `<pre class="version-preview">`, 「이 버전으로 되돌리기」 버튼); `MemoDoc.restoreText(text: string): void` — `view`/state 에 `{changes: {from: 0, to: doc.length, insert: text}, userEvent: "input.restore", selection: {anchor: 0}}` 한 트랜잭션; `AppController.showVersions()`.

- [ ] **Step 1: 실패하는 테스트(Rust)** — `versions.rs`: `versions_follow_a_renamed_memo_and_skip_unchanged_neighbours`(스냅샷 셋: `a.md` 내용 1 → 이름 `회의.md` 내용 1 → 내용 2 → 목록은 둘(내용 2, 내용 1) 이고 가운데 것은 없다), `read_refuses_a_path_segment_that_leaves_the_snapshot`(`../x` → `InvalidInput`), `the_newest_snapshot_is_listed_even_if_equal_to_the_workspace`. `workspace/ops.rs`: `every_write_marks_the_workspace_changed`(만들기·저장·제목·이름·언어·가져오기·삭제 뒤 `take_changed()` 가 true, 바로 다시 부르면 false; `read_memo`·`list_memos` 는 세우지 않는다). `app/mod.rs`: `a_tick_snapshots_only_changed_workspaces_and_prunes`(창 둘, 하나만 쓰기 → tick → 그 하나만 스냅샷; 다시 tick → 아무것도 안 찍음).

- [ ] **Step 2: 실패하는 테스트(E2E)** — `backup.spec.ts`: `previous versions list, preview and restore undoably`(메모 `회의.md` 내용 `v3`, `backups` 에 두 버전 `v1`·`v2` → 메뉴 `versions` → 목록 둘 → 둘째 클릭 → 미리보기 `v1` → 「이 버전으로 되돌리기」 → 편집기 `v1` → ⌘Z → `v3`), `a memo without versions says so`(「이전 버전이 없습니다」), `reveal backups asks the backend`(`backend.data.revealed === 1`).

- [ ] **Step 3: 실패 확인** — `cargo test --manifest-path src-tauri/Cargo.toml backup:: workspace:: app::`, `pnpm test:e2e tests/e2e/backup.spec.ts`.

- [ ] **Step 4: 구현** — Interfaces 대로. 「이전 버전…」은 활성 탭이 메모이고 텍스트로 열려 있을 때만; 아니면 상태 표시줄 「메모 탭에서만 쓸 수 있습니다」. 되돌린 뒤 자동 저장은 평소 경로(`edited` → 0.5초). 대화상자의 Esc 는 `modal` 의 규칙대로.

- [ ] **Step 5: 통과 확인** — 같은 명령. 실행 개수 보고. 실앱: `TOTE_BACKUP_INTERVAL_SECS=5` `TOTE_DATA_DIR=<임시>` `TOTE_BACKGROUND=1` 로 띄워 메모를 고치고 10초 뒤 `<임시>/backups/<id>/` 에 스냅샷 폴더가 있고 안에 메모 파일과 `.tote/index.json`·`.tote/manifest.json` 이 있는지, 두 번째 스냅샷의 안 바뀐 파일이 `ls -li` 로 같은 inode 인지 적는다.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/backup src-tauri/src/workspace src-tauri/src/app src-tauri/src/lib.rs src/backend src/ui/versions.ts src/app/controller.ts src/app/docs.ts src/styles.css tests/e2e/backup.spec.ts
git commit -m "feat(backup): snapshot changed workspaces every ten minutes, open the backup folder, preview and restore a memo's earlier versions"
```

### Task 11: Rust `watch` — notify 감시, 자기 쓰기 걸러내기, rename 추적, 창으로 보내기

**Files:**

- Create: `src-tauri/src/watch/mod.rs`
- Modify: `src-tauri/src/workspace/mod.rs`, `src-tauri/src/workspace/index.rs`, `src-tauri/src/workspace/ops.rs`, `src-tauri/src/persist/external.rs`, `src-tauri/src/app/mod.rs`, `src-tauri/src/app/windows.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`(`notify = "8"`)

**Interfaces:**

- Consumes: `MemoIndex::{reconcile, get_mut, iter}`, `memo_files`, `content_hash`, `atomic_write`, `ExternalFiles::{open, save}`, `AppCore::{register, closed}`, `app.emit_to`.
- Produces(`workspace`): `Workspace::last_written(&self, file: &str) -> Option<&str>`(sha256 of the bytes tote wrote last — `write_memo`·`add_memo`·`import` 가 기록, `delete` 가 지운다); `Workspace::inodes(&self) -> &BTreeMap<String, (u64, u64)>`(`MemoIndex::load` 때 채우고 쓰기·rename 때 갱신); `pub enum Change { Modified { id: String }, Added { id: String, file: String }, Removed { id: String, file: String }, Renamed { id: String, from: String, to: String } }`(`Serialize`, `tag = "kind"`, camelCase); `Workspace::apply_fs_events(&mut self, touched: &BTreeSet<String> /* file names seen in the batch */, renames: &[(String, String)] /* From→To pairs the watcher paired itself */) -> io::Result<Vec<Change>>` — 순수에 가깝다: ① `renames` 를 index 에 적용 ② 사라진 파일과 새 파일 중 inode 가 같은 쌍을 rename 으로 ③ 남은 사라진 것은 `Removed`(index 에서 뺀다), 새 것은 `Added`(새 ID, `autoTitle: false`) ④ 남아 있는 touched 파일은 내용 해시가 `last_written` 과 같으면 **무시**, 다르면 `Modified`; 변경이 있었으면 `mark_changed`(Task 10) 와 `index.save`.
- Produces(`watch/mod.rs`): `pub struct Watcher { … }`, `Watcher::new(on_batch: impl Fn(WatchTarget, Batch) + Send + 'static) -> notify::Result<Watcher>`(`notify::recommended_watcher`, 배치 지연 **200ms** — 스레드 하나가 이벤트를 모아 `Batch { touched: BTreeSet<PathBuf>, renames: Vec<(PathBuf, PathBuf)> }` 로 넘긴다; `RenameMode::Both` 는 쌍으로, `From`/`To` 가 따로 오면 배치 안에서 cookie/순서로 짝짓고 못 지으면 `touched` 에 넣는다); `Watcher::watch_workspace(&self, label: &str, root: &Path)`(비재귀; `.tote/` 아래와 `.tote-tmp-*`·점 파일은 배치에서 뺀다), `unwatch_workspace(label)`, `watch_external(label, path)`/`unwatch_external(label, path)`(부모 폴더를 비재귀로 보고 그 경로만 거른다; 같은 부모를 여러 외부 파일이 쓰면 참조 수); `pub enum WatchTarget { Workspace(String), External(String, PathBuf) }`.
- Produces(`AppCore`): `AppCore::on_batch(&self, target: WatchTarget, batch: Batch) -> Option<(String, OutsideChange)>` with `#[derive(Serialize)] #[serde(tag = "kind", rename_all = "camelCase")] pub enum OutsideChange { Workspace { changes: Vec<Change> }, External { path: PathBuf, state: ExternalState /* Modified | Removed */ } }` — 외부 파일은 `ExternalFiles` 가 기억한 마지막 저장 해시(`save` 가 넣는 `bases`)와 같으면 무시; `register` 가 `watch_workspace`, `closed` 가 `unwatch`; 명령 `watch_external(path)`/`unwatch_external(path)`; 이벤트 `tote://outside`(payload `OutsideChange`)를 그 창에 `emit_to`.

- [ ] **Step 1: 실패하는 테스트(순수 판정)** — `workspace/mod.rs`(또는 `ops.rs`) 테스트:
  - `a_change_that_hashes_like_our_last_write_is_ignored`(`write_memo` 뒤 그 파일을 touched 로 → `[]`).
  - `a_change_by_another_app_is_modified`(파일을 `fs::write` 로 바꾼 뒤 → `[Modified{id}]`).
  - `a_rename_pair_updates_the_index_and_keeps_the_id`.
  - `a_rename_seen_only_as_remove_and_create_is_matched_by_inode`(`fs::rename` 뒤 `touched = {from, to}` → `[Renamed{id, from, to}]`, ID 그대로).
  - `a_missed_rename_becomes_a_new_memo`(inode 가 다른 새 파일 + 사라진 파일 → `Removed` + `Added(autoTitle: false)` — 스펙 「rename 을 놓치면 새 메모」).
  - `tote_temp_files_and_dot_files_never_appear`(`.tote-tmp-x`, `.DS_Store` 가 touched 여도 `[]`).
- [ ] **Step 2: 실패하는 테스트(감시기, 실제 FS)** — `watch/mod.rs`: `a_write_in_the_folder_arrives_as_one_batch_within_a_second`(tempdir 감시 → `fs::write` → 채널로 1초 안에 배치, `touched` 에 그 파일), `events_under_dot_tote_are_dropped`, `an_external_file_is_reported_alone`(부모 폴더의 다른 파일을 써도 안 온다). **macOS FSEvents 는 지연이 있다** — 타임아웃 2초, 실패하면 다시 돌리지 말고 그대로 보고한다(flake 를 재시도로 가리지 않는다).
- [ ] **Step 3: 실패 확인** — `cargo test --manifest-path src-tauri/Cargo.toml watch:: workspace::`.
- [ ] **Step 4: 구현** — Interfaces 대로. 배치 스레드는 `std::sync::mpsc::recv_timeout(200ms)` 로 모은다. `apply_fs_events` 는 `list_memos` 의 `reconcile` 와 겹치지 않게 **같은 `Workspace` 잠금** 아래에서 돈다(`AppCore::workspace(label)` 의 `Mutex`). `write_memo` 가 기록하는 `last_written` 은 해시 하나(경로마다) — 스펙 문장 그대로.
- [ ] **Step 5: 통과 확인** — 같은 명령. 실행 개수 보고. `cargo clippy --all-targets`.
- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/watch src-tauri/src/workspace src-tauri/src/persist/external.rs src-tauri/src/app src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(watch): watch open workspaces and external files, drop our own writes, follow renames by inode"
```

### Task 12: 외부 변경의 화면 — 조용한 다시 읽기, 충돌·삭제 배너, 수정분 복원 충돌

**Files:**

- Create: `src/ui/banner.ts`, `tests/e2e/watch.spec.ts`
- Modify: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src/app/docs.ts`, `src/app/docs.test.ts`, `src/app/controller.ts`, `src/app/surface.ts`, `src/styles.css`, `tests/e2e/external.spec.ts`

**Interfaces:**

- Consumes: `OutsideChange`·`Change`(Task 11 의 직렬화 모양을 TS 타입으로), `MemoDoc.{savedText, state, info, setInfo}`, `ExternalDoc.{modified, draft 복원 경로, DRAFT_RESTORED_NOTICE}`, `Surface`, `StatusBar`.
- Produces: `Backend.onOutsideChange(handler: (change: OutsideChange) => void)`, `Backend.watchExternal(path)`/`unwatchExternal(path)`; `FakeBackend.outside(change: OutsideChange)`; `Banner`(`ui/banner.ts`): `show(kind: "conflict" | "deleted" | "info", text: string, actions: { label: string; run(): void }[])`, `hide()` — `Surface` 의 편집기 위에 한 줄; `Doc.banner: BannerState | null`(탭마다 — 탭을 떠났다 와도 남는다); `MemoDoc.onOutside(change: Change): Promise<void>`: `Modified` → `savedText === state.doc`(쓰지 않은 내용 없음) 이면 `readMemo` 로 다시 읽어 `state` 를 **같은 selection·scroll 로** 바꾼다(`restoreSelection` 재사용, `userEvent: "input.reload"` 가 아니라 **새 state** — 되돌리기 역사에 남기지 않는다; 주석에 이유) / 쓰지 않은 내용이 있으면 `banner = conflict`(「디스크 버전」= 다시 읽기, 「내 버전」= `saveNow`); `Removed` → `banner = deleted`(「삭제됨 — 다시 저장하거나 닫을 수 있습니다」, 「다시 저장」= `saveNow` — `write_memo` 가 사라진 파일을 다시 만든다; `index` 에서도 빠졌으므로 `unknown-memo` → 기존 `recover` 경로가 새 메모로 만든다 — 그래서 배너의 「다시 저장」 뒤 `RECOVERED_NOTICE` 가 뜨는 것이 맞다); `Renamed` → `info.file` 갱신, 탭 제목·사이드바; `Added` → 사이드바만. `ExternalDoc.onOutside(state)`: `Modified` → `modified` 가 거짓이면 `readExternal` 로 다시 읽기, 참이면 충돌 배너(「디스크 버전」= 다시 읽고 수정분 버리기, 「내 버전」= `save`); `Removed` → 삭제됨 배너. 외부 파일 수정분 복원의 `diskChanged` 는 `DRAFT_RESTORED_NOTICE` 대신 **같은 충돌 배너**(「디스크 버전」= 디스크 내용으로 바꾸고 수정분 버림, 「내 버전」= 그대로 두고 ⌘S 때 쓴다 — 저장 전 수정분이므로 바로 쓰지 않는다). `ExternalDoc` 이 열릴 때(`read`) `watchExternal`, 닫힐 때 `unwatchExternal`.

- [ ] **Step 1: 실패하는 단위 테스트** — `docs.test.ts`: `an outside modification with nothing unsaved reloads and keeps the selection`(FakeBackend 의 메모 데이터를 바꾸고 `onOutside({kind:"modified"})` → `state.doc` 새 내용, 커서 자리 유지(길이 안이면 그대로, 넘으면 끝)), `an outside modification with unsaved text raises the conflict banner`, `an outside removal raises the deleted banner and keeps the text`, `an outside rename updates the file name`.

- [ ] **Step 2: 실패하는 E2E** — `watch.spec.ts`: `a memo changed outside is reread silently with the cursor in place`(사이드바 행도 갱신), `an external change while typing shows the conflict banner and keeps the typed text`(타이핑 → 저장 전 0.5초 안에 `backend.outside(...)` → 배너, 본문에 친 글 그대로 → 「내 버전」 → 파일이 친 글), `디스크 버전 replaces the text and can be undone`(⌘Z 가 **안** 되는 것이 맞다 — 새 state 이므로; 테스트 이름을 `디스크 버전 replaces the text and clears the banner` 로), `a deleted memo keeps its text and 다시 저장 brings it back`, `a renamed memo keeps its tab and saves under the new name`(rename 이벤트 뒤 타이핑 → 새 이름 파일에 저장, 옛 이름 파일 없음), `the memo list follows added and removed files`. `external.spec.ts`: `a draft whose file changed on disk opens with the conflict banner`(지금의 notice 테스트를 배너로 바꾼다), `an external file edited elsewhere while clean is reread`.

- [ ] **Step 3: 실패 확인** — `pnpm vitest run src/app/docs.test.ts`, `pnpm test:e2e tests/e2e/watch.spec.ts tests/e2e/external.spec.ts`.

- [ ] **Step 4: 구현** — Interfaces 대로. `AppController.start` 가 `backend.onOutsideChange` 를 걸고 `Workspace` 변경은 메모 ID 로 탭을 찾아 `onOutside`, 그 뒤 `refreshMemos`; `External` 은 경로로 탭을 찾는다. `show(doc)` 가 `doc.banner` 를 그린다. 배너 문구: 충돌 「다른 앱이 이 파일을 바꿨습니다. 어느 쪽을 둘까요?」 버튼 「디스크 버전」「내 버전」; 삭제 「파일이 지워졌습니다. 다시 저장하거나 탭을 닫을 수 있습니다」 버튼 「다시 저장」.

- [ ] **Step 5: 통과 확인** — 같은 명령. 실행 개수 보고.

- [ ] **Step 6: Commit**

```bash
git add src/ui/banner.ts src/backend src/app src/styles.css tests/e2e/watch.spec.ts tests/e2e/external.spec.ts
git commit -m "feat(app): react to outside changes — silent reread, conflict and deleted banners, renamed tabs"
```

### Task 13: Rust `search` — ripgrep 라이브러리 병렬 검색, 스트리밍, 취소

**Files:**

- Create: `src-tauri/src/search/mod.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/app/mod.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/Cargo.toml`(`grep = "0.4"` — `grep-regex`·`grep-searcher`·`grep-matcher` 를 재수출한다)

**Interfaces:**

- Consumes: `memo_files(root)`, `Workspace::{iter index → id by file}`, `AppCore::{begin_search, search_is_live}` 를 본떠 별도 장부, `tauri::ipc::Channel<T>`.
- Produces:
  - `pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024`, `pub const MAX_MATCHES: usize = 2000`, `pub const MAX_MATCHES_PER_FILE: usize = 200`, `pub const CONTEXT_LINES: usize = 1`.
  - `#[derive(Deserialize)] pub struct SearchQuery { query: String, case_sensitive: bool, regex: bool }`(`TextQuery` 와 같은 모양 — 그대로 재사용해도 된다).
  - `#[derive(Serialize)] #[serde(tag = "kind", rename_all = "camelCase")] pub enum SearchEvent { File { memo_id: String, file: String, matches: Vec<Match> }, Done { files_searched: u32, truncated: bool, cancelled: bool } }`, `pub struct Match { line: u64 /* 0-based */, column: u64 /* char offset, not byte */, text: String /* the line without its newline */, before: Vec<String>, after: Vec<String> }`.
  - `pub fn search(root: &Path, files: &[(String /* id */, String /* file */)], query: &SearchQuery, cancelled: &(dyn Fn() -> bool + Sync), emit: &(dyn Fn(SearchEvent) + Sync)) -> Result<(), SearchError>` — `RegexMatcherBuilder`(`case_insensitive(!case_sensitive)`, 리터럴이면 `regex::escape`), `SearcherBuilder` 에 `binary_detection(BinaryDetection::quit(b'\x00'))`·`before_context(1)`·`after_context(1)`·`line_number(true)`; 파일을 `std::thread::available_parallelism()` 개의 스레드가 공유 큐(`Mutex<VecDeque>`)에서 집어 간다; 파일 하나의 결과는 `Sink` 가 모아 `File` 이벤트 하나로 보낸다(매치가 있을 때만); 크기 > `MAX_FILE_BYTES` 는 열지 않는다; 전체 매치 수는 `AtomicUsize` 로 세고 `MAX_MATCHES` 를 넘으면 모두 멈춘다(`truncated`); `cancelled()` 는 파일을 집을 때마다 본다. 끝에 `Done` 하나. **빈 검색어는 아무것도 찾지 않고 바로 `Done`.**
  - `AppCore::begin_workspace_search(window, request_id)` / `workspace_search_is_live(window, request_id)`(대용량 뷰어 검색과 별도 장부; `closed` 가 지운다).
  - 명령 `search_workspace(query: SearchQuery, request_id: u64, on_event: Channel<SearchEvent>) -> CmdResult<()>` — `spawn_blocking` 안에서 `search`; `bad-request` 는 잘못된 정규식.

- [ ] **Step 1: 실패하는 테스트** — `search/mod.rs`, tempdir 에 파일을 만들고 `emit` 을 `Mutex<Vec<SearchEvent>>` 로 받는다:
  - `finds_literal_and_regex_matches_with_context`(`a.md` 3줄 가운데 매치 → `before`·`after` 한 줄씩, `column` 이 **문자** 오프셋(앞에 한글 둘을 두고 2), `text` 에 `\n` 없음).
  - `a_literal_that_looks_like_a_regex_is_literal`, `case_insensitive_by_default`.
  - `binary_and_oversize_files_are_skipped`(NUL 파일, `MAX_FILE_BYTES + 1` sparse → 이벤트 없음, `files_searched` 에서도 뺀다).
  - `results_stop_at_the_limits_and_say_truncated`(한 파일에 300 매치 → 그 파일 200; 파일 20개 × 150 → 전체 2,000 에서 `truncated: true`).
  - `a_cancelled_search_ends_with_cancelled`(`cancelled` 가 두 번째 호출부터 true → `Done{cancelled: true}`, 파일 전부를 돌지 않음).
  - `an_invalid_regex_is_a_bad_pattern`, `an_empty_query_finds_nothing`.
  - `files_are_searched_in_parallel`(파일 64개, 각 `Sink` 가 `thread::current().id()` 를 기록 → 서로 다른 id 가 2개 이상 — 1코어 머신이면 건너뛴다 `available_parallelism() > 1`).
  - `app/mod.rs`: `workspace_searches_are_separate_from_text_searches`.

- [ ] **Step 2: 실패 확인** — `cargo test --manifest-path src-tauri/Cargo.toml search:: app::`.

- [ ] **Step 3: 구현** — Interfaces 대로. 매치 column: 바이트 오프셋을 `text[..byte].chars().count()` 로 바꾼다(줄이 UTF-8 이 아니면 `from_utf8_lossy`). CRLF 는 `\r` 을 뗀다.

- [ ] **Step 4: 통과 확인** — 같은 명령. 실행 개수 보고.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/search src-tauri/src/lib.rs src-tauri/src/app src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(search): parallel workspace search with ripgrep's searcher, streamed per file, cancellable"
```

### Task 14: 검색 패널 — 사이드바 전환, 스트리밍 표시, 결과로 열기

**Files:**

- Create: `src/ui/sidebar.ts`, `src/ui/search-panel.ts`, `src/ui/search-panel.test.ts`, `tests/e2e/search.spec.ts`
- Modify: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src/app/controller.ts`, `src/app/docs.ts`, `src-tauri/src/app/menu.rs`, `src/styles.css`

**Interfaces:**

- Consumes: `SearchEvent`·`Match`·`SearchQuery`(Task 13 의 모양을 TS 로 — `export type SearchQuery = TextQuery;`, `interface SearchMatch { line: number; column: number; text: string; before: string[]; after: string[] }`, `type SearchEvent = { kind: "file"; memoId: string; file: string; matches: SearchMatch[] } | { kind: "done"; filesSearched: number; truncated: boolean; cancelled: boolean }`), `MemoList`, `AppController.openMemo`, `Channel`(`@tauri-apps/api/core`).
- Produces: `Backend.searchWorkspace(query: SearchQuery, requestId: number, onEvent: (e: SearchEvent) => void): Promise<void>`(TauriBackend 는 `new Channel<SearchEvent>()`; FakeBackend 는 메모를 훑어 파일마다 이벤트를 `queueMicrotask` 로 내고, `FakeData.searchDelayMs` 로 늦출 수 있다 — 취소 테스트용); `Sidebar`(`ui/sidebar.ts`): `constructor(memoList: MemoList, search: SearchPanel)`, `show(pane: "memos" | "search")`, `readonly el`(`nav.sidebar` 를 이쪽이 갖고 `MemoList.el` 은 `div.memo-pane` 으로); `SearchPanel`(`ui/search-panel.ts`): `constructor(options: { search(query: SearchQuery, onEvent): Promise<void>; cancel(): void; open(memoId: string, line: number, column: number): void; onEscape(): void })`, `focus()`, 입력칸 + 「Aa」·「.*」 토글 버튼(`aria-pressed`), 결과 `div.search-results`(메모별 `details.search-file` 열림 상태, 제목 = `displayName(file)`, 매치 행 = 줄 번호 + 앞뒤 문맥 흐리게 + 매치 줄), 상태 줄(「검색 중…」/「n개 파일에서 m개」/「결과가 많아 일부만 보입니다」/「잘못된 정규식」); 순수 함수 `groupKey`·`countOf(events)` 는 테스트용; `AppController`: 메뉴 `search-workspace`(⇧⌘F, 「보기」 메뉴) 가 `sidebar.show("search")` + `focus()`, 패널의 Esc 가 `show("memos")` 와 편집기 포커스; 검색 번호 `++this.workspaceSearches`; 결과 클릭 → `openMemo(id)` 뒤 `doc.ensureLoaded()` → `view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })` with `pos = state.doc.line(line + 1).from + column`(줄이 그새 짧아졌으면 끝으로 clamp); `MemoDoc.positionOf(line, column): number`.

- [ ] **Step 1: 실패하는 단위 테스트** — `search-panel.test.ts`(jsdom 없이 순수 부분만): `countOf sums files and matches and keeps the truncated flag`, `a done event with cancelled true leaves the status alone`.

- [ ] **Step 2: 실패하는 E2E** — `search.spec.ts`:
  - `⇧⌘F shows the search panel and Esc brings the memo list back`.
  - `results stream in grouped by memo and open at the match`(메모 셋, `foo` 가 둘에 → 그룹 둘, 둘째 그룹의 둘째 매치 클릭 → 그 탭 활성, 커서 `줄 n, 열 m`).
  - `typing again cancels the previous search`(`searchDelayMs: 300` → `fo` 치고 `o` 추가 → 첫 검색의 이벤트가 결과에 **안** 남음, FakeBackend 의 `data.workspaceSearchCancelled` 가 1 이상 — 새 요청 번호가 오면 이전 검색의 남은 이벤트를 버리며 올린다).
  - `a bad regex says so and the next keystroke searches again`(`.*` 켜고 `(` → 「잘못된 정규식」 → `)` 추가 → 결과).
  - `case and regex toggles change the query sent`(`backend.data.workspaceSearchCalls` 의 마지막 `query`).
  - `too many results say so`(`FakeData` 메모 하나에 매치 2,001개 → 상태 줄 문구).

- [ ] **Step 3: 실패 확인** — `pnpm vitest run src/ui/search-panel.test.ts`, `pnpm test:e2e tests/e2e/search.spec.ts`.

- [ ] **Step 4: 구현** — Interfaces 대로. 입력 디바운스 150ms(`WriteScheduler` 가 아니라 `setTimeout`). 이벤트가 **현재 요청 번호**의 것일 때만 그린다(패널이 `requestId` 를 닫아 둔다). 결과 행은 많을 수 있다 — 2,000 행까지 그대로 DOM 에 둔다(가상화하지 않는다; 상한이 작다).

- [ ] **Step 5: 통과 확인** — 같은 명령. 실행 개수 보고.

- [ ] **Step 6: Commit**

```bash
git add src/ui/sidebar.ts src/ui/search-panel.ts src/ui/search-panel.test.ts src/ui/memo-list.ts src/backend src/app src/styles.css src-tauri/src/app/menu.rs tests/e2e/search.spec.ts
git commit -m "feat(search): the workspace search panel — streamed, grouped by memo, opens at the match"
```

### Task 15: 하이라이트 — 문법 파싱을 워커로, 유휴 때 마크다운 미리 보내기, 따라잡기 조각내기, 숨은 탭 뒤로

**Files:**

- Modify: `src/highlight/protocol.ts`, `src/highlight/client.ts`, `src/highlight/client.test.ts`, `src/highlight/grammars.ts`, `src/highlight/grammars.test.ts`, `src/highlight/worker.ts`, `src/highlight/tokenizer.ts`, `src/highlight/tokenizer.test.ts`, `src/highlight/extension.ts`, `src/app/controller.ts`, `tests/e2e/highlight.spec.ts`, `tests/e2e/pages/editor.ts`

**Interfaces:**

- Consumes: `collectGrammars`·`collectIncludes`, `HighlightClient.{ensureGrammar, open, tokens}`, `LineTokenizer.{tokens, advance}`, `advanceSlice`(worker), `workerHighlighting`.
- Produces:
  - 프로토콜: `{ type: "grammars"; grammars: { scopeName: string; text: string }[] }` — **원문 텍스트**를 보내고 워커가 `parseJsonc` 한다(1.5MB 의 JSON 파싱이 메인 스레드에서 빠진다); `collectGrammars` 는 includes 를 알기 위해 메인에서 파싱하던 것을 **워커 답**으로 바꾼다: 워커가 `grammars` 를 받으면 `{ type: "grammars-ready"; includes: string[] }` 로 아직 없는 include 스코프를 알려 주고 클라이언트가 그것들을 읽어 또 보낸다(큐가 빌 때까지). `GrammarSource` 는 `{ scopeName, text }`.
  - `HighlightClient.preload(lang: LanguageInfo): void` — `requestIdleCallback`(없으면 `setTimeout(…, 1000)`) 안에서 `ensureGrammar`; `AppController.start` 끝에 `markdown` 언어를 `preload`.
  - `{ type: "tokens"; …; mode: "cached" }` 요청: `LineTokenizer.tokensIfCached(from, to): Uint32Array[] | null` — `from` 까지 상태가 없으면 `null`(캐시 끝에서 뷰포트까지 따라잡지 않는다); 워커는 `null` 이면 `{ type: "tokens"; lines: null; pending: true }` 로 답하고 따라잡기를 **조각**(`advance(15)` 반복, 뷰포트 문서를 우선)으로 돌린 뒤 캐시가 그 자리에 닿으면 `{ type: "ready"; doc; from }` 를 보낸다 → 클라이언트가 다시 요청한다.
  - 워커의 `advanceSlice` 는 `{ type: "visible"; docs: number[] }` 로 받은 보이는 문서를 먼저, 나머지는 보이는 것이 다 끝난 뒤에만 돈다; 숨은 문서는 **뷰포트 요청이 한 번이라도 온 자리까지만** 돌고 멈춘다(5MB 탭 열 개가 CPU 를 다 먹지 않는다 — Minor 10). `HighlightClient.setVisible(docs: number[])` — 컨트롤러의 `activate` 가 부른다.

- [ ] **Step 1: 실패하는 단위 테스트** — `tokenizer.test.ts`: `tokensIfCached answers only from the cache`(캐시 0줄에서 `(100, 110)` → `null`; `advance` 로 채운 뒤 → 배열). `client.test.ts`(워커를 가짜 `postMessage` 로): `grammars travel as text and includes come back from the worker`, `a pending answer is followed by a ready message and a second request`, `preload sends the grammar once and open reuses it`. `grammars.test.ts` 의 `collectIncludes` 테스트는 워커 쪽으로 옮긴다.

- [ ] **Step 2: 실패하는 E2E** — `highlight.spec.ts`(`?highlight=1` 페이지): `a far jump colours the viewport without waiting for everything before it`(`lines=200000` TypeScript, `End` 로 끝 → 끝 줄의 `tm-c*` 가 **3초 안에** 보인다 — 지금 코드는 전체 토큰화(수십 초)를 기다린다), `the first keystroke after opening a markdown memo is not delayed by grammar parsing`(측정이 아니라 구조 확인: `workerLog` 에 `grammars` 가 `open` 보다 먼저, 그리고 메인 스레드에서 `JSON.parse` 가 문법 크기로 불리지 않음 — `fileOverride` 로 문법 텍스트에 표식을 넣고 `window.parsedOnMain` 카운터가 0), `hidden documents stop advancing where they were last shown`(문서 둘 열고 하나만 `visible` → 1초 뒤 숨은 것의 `cachedLines` 가 늘지 않음 — 워커에 `{type: "stats"}` 요청을 더해 `cachedLines` 를 돌려받는다).

- [ ] **Step 3: 실패 확인** — `pnpm vitest run src/highlight`, `pnpm test:e2e tests/e2e/highlight.spec.ts`.

- [ ] **Step 4: 구현** — Interfaces 대로. `extension.ts` 의 `request()` 는 `mode: "cached"` 로 묻고 `pending` 이면 `ready` 를 기다렸다가 다시 묻는다(그동안 장식은 그대로 — 빈 색이 아니라 옛 색이 남는다).

- [ ] **Step 5: 통과 확인** — 같은 명령. 실행 개수 보고. 손 확인(디버그 앱, `TOTE_DATA_DIR`·`TOTE_BACKGROUND=1`): 10MB `.ts` 를 열고 ⌘↓ 로 끝 → 끝 줄 색이 몇 초 안에 오는지 적는다(스파이크의 35–40초와 비교).

- [ ] **Step 6: Commit**

```bash
git add src/highlight src/app/controller.ts tests/e2e/highlight.spec.ts tests/e2e/pages/editor.ts
git commit -m "perf(highlight): parse grammars in the worker, preload markdown, colour a far viewport without catching up, idle hidden tabs"
```

### Task 16: 성능 계측과 목표치 — 사전 등록한 규칙으로 잰다

스펙 「목표와 측정」이 「구현 계획에서 정한다」고 미룬 목표치를 **데이터를 보기 전에** 여기 고정한다. 2번 계획 Task 14 의 교훈: 규칙이 **측정 대상 파일 형식**을 정하지 않아 `.ts` 만 재고 `.md`(Lezer 파서가 붙는 메모의 기본 형식)를 놓쳤다 — 이번에는 형식·빌드·기기·반복 수·유효성까지 아래에 적고, 적힌 것 밖의 판단은 하지 않는다.

**Files:**

- Create: `scripts/perf-fixtures.ts`, `scripts/measure-perf.sh`, `tests/measure/perf.md`(이 절의 규칙을 그대로 옮긴 사본 — 실행자가 읽는 정본은 **이 계획**), `src-tauri/src/perf.rs`, `docs/superpowers/reports/<실행 날짜>-tote-notes-perf.md`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/app/commands.rs`, `src-tauri/src/appdata.rs`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src/app/controller.ts`, `src/app/docs.ts`, `src/ui/search-panel.ts`, `package.json`(`"perf:fixtures"`, `"perf:measure"`), `.gitignore`(`/tests/measure/results/` 는 이미 있다; `perf-fixtures/` 추가)

**Interfaces:**

- Produces(Rust `perf.rs`): `TOTE_PERF=1` 일 때만 켜진다. `pub fn mark(name: &str)` 가 `<data_dir>/perf.jsonl` 에 `{"t": <ms since process start>, "name": "<name>", "pid": <pid>}` 한 줄을 붙인다(`OnceLock<Mutex<File>>`); 프로세스 시작 시각은 `main` 첫 줄의 `Instant`. 명령 `perf_mark(name: String)` — 프론트가 같은 파일에 적는다. 찍는 자리: `process-start`(main), `core-loaded`(`AppCore::load` 뒤), `window-shown`(`windows::show` 의 `build` 뒤), 프론트 `app-ready`(`start()` 끝), `open-start:<tabId>`(`activate` 들어갈 때), `open-first-paint:<tabId>`(`Surface.showEditor`/`showPanel` 뒤 첫 `requestAnimationFrame` 콜백), `open-first-tokens:<tabId>`(그 탭의 첫 `setHighlight` 디스패치), `restore-done`(`start()` 에서 세션 복원 뒤 활성 탭이 그려진 rAF), `search-start:<n>`/`search-done:<n>`.
- Produces(TS): `Backend.perfMark(name: string): void`(Tauri: `invoke("perf_mark")` 를 `void` 로, Fake: no-op).
- Produces(`scripts/perf-fixtures.ts`): `pnpm perf:fixtures <폴더>` 가 만든다 — `code-1mb.ts`·`code-10mb.ts`·`code-100mb.ts`(각 줄 `const v<i> = f(<i>) + "text"; // c`), 같은 내용의 `.md` 판 `code-1mb.md`·`code-10mb.md`(코드를 ` ```ts ` 펜스 안에 — 메모의 기본 형식), `json-10mb-one-line.json`(`{"k":[…]}` 한 줄), `log-100k.log`(`2026-10-12T00:00:00.000Z INFO worker-<i> handled request <i> in <ms>ms`), 워크스페이스 `memos-10k/`(tote 워크스페이스: `.tote/workspace.json`·`index.json` 과 메모 1만 개, 각 2KB 안팎의 한국어·영어 섞인 문장, 100개마다 `needle-<n>` 이 든 줄 하나).
- Produces(`scripts/measure-perf.sh`): **`perf` 프로필 번들** — `src-tauri/Cargo.toml` 에 `[profile.perf] inherits = "release"`, `debug-assertions = true` 를 둔다. 최적화는 릴리스 그대로이고 `cfg!(debug_assertions)` 만 켜져 `TOTE_BACKGROUND` 와 `tote-dev` 데이터 경로가 **먹는다**(순수 릴리스 빌드는 둘 다 무시해 사람의 화면과 `~/Tote` 를 건드린다). 빌드: `pnpm tauri build --bundles app --config src-tauri/tauri.dev.conf.json -- --profile perf`(Tauri CLI 가 `--profile` 을 직접 받으면 그것으로; 번들은 `src-tauri/target/perf/bundle/macos/tote-dev.app`). 스크립트 첫 줄이 `TOTE_DATA_DIR` 이 비어 있으면 멈춘다. 그 번들을 `TOTE_DATA_DIR=<측정 폴더>` `TOTE_PERF=1` `TOTE_BACKGROUND=1` 로 띄워 시나리오마다 5회 돌리고, 매 회 `perf.jsonl` 을 `tests/measure/results/perf-<시나리오>-<회>.jsonl` 로 옮긴 뒤 `osascript -e 'quit app "tote-dev"'` 로 끝낸다. 시나리오의 조작은 앱 밖에서 한다 — 열기는 `tote <파일>` 명령(열린 창에 외부 탭으로), 세션 복원은 미리 만든 `sessions/<기기>.json`(탭 50개, 활성은 맨 뒤), 검색은 `TOTE_PERF_SEARCH=<검색어>` 환경 변수를 읽어 `start()` 끝에 패널을 열고 검색을 한 번 돌리는 **계측 전용 분기**(`TOTE_PERF` 가 있을 때만 컴파일되는 것이 아니라 런타임 분기 — 릴리스 빌드에서도 돈다). 결과 집계는 같은 스크립트의 끝에서 `node scripts/perf-summary.ts`(중앙값·p95 표 stdout).

**사전 등록 규칙(데이터를 보기 전에 고정한다).**

- **빌드·기기:** `perf` 프로필(릴리스 최적화 + `debug-assertions`), 내장 디스플레이, 전원 연결, 측정 중 다른 작업 없음. 시작 전 `uptime` 의 1분 load average 가 **3 미만**이어야 시작한다(아니면 기다린다). 기기·macOS 판·디스플레이를 보고서 「환경」에 적는다.
- **반복과 판정:** 시나리오마다 **5회**, 지표는 **중앙값**으로 판정하고 p95 도 적는다. 중앙값 ≤ 목표면 「된다」, 목표의 2배 이하면 「조건부」, 그보다 크면 「안 된다」. 조건부·안 된다는 고치지 않고 **보고서에 적고 사람에게 올린다** — 이 계획은 재는 계획이지 성능 계획이 아니다(고칠지는 다음 계획에서 정한다).
- **유효성:** 한 회의 `perf.jsonl` 에 해당 마크가 없거나 중복이면 그 회는 무효. 무효가 둘 이상이면 시나리오 전체를 다시 5회. 그래도 무효면 「실측 불가」로 적는다.
- **시나리오와 목표치**(지표 = 두 마크의 차):

  | 시나리오                            | 조건                                                                                                                                                 | 지표                               | 목표                                            |
  | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------- |
  | 콜드 스타트                         | 빈 워크스페이스 하나, 세션 없음. 앱을 끄고 **10초 뒤** 다시 띄운다(디스크 캐시는 따뜻하다 — 「콜드」는 프로세스 기준이다. 재부팅 콜드는 재지 않는다) | `process-start` → `app-ready`      | **1,500ms**                                     |
  | 파일 열기 `code-10mb.ts`            | 창이 떠 있고 `tote <파일>`                                                                                                                           | `open-start` → `open-first-paint`  | **500ms**                                       |
  | 파일 열기 `code-10mb.md`            | 같음 — **메모의 기본 형식도 잰다**                                                                                                                   | 같음                               | **500ms**                                       |
  | 파일 열기 `code-100mb.ts`           | 같음 — 대용량 텍스트 뷰어로 간다                                                                                                                     | `open-start` → `open-first-paint`  | **1,000ms**                                     |
  | 파일 열기 `json-10mb-one-line.json` | 같음 — 긴 줄 규칙으로 뷰어                                                                                                                           | 같음                               | **1,000ms**                                     |
  | 파일 열기 `log-100k.log`            | 같음 — 편집기                                                                                                                                        | 같음                               | **500ms**                                       |
  | 첫 색칠 `code-10mb.ts`·`.md`        | 위 열기와 같은 회                                                                                                                                    | `open-start` → `open-first-tokens` | **1,500ms**                                     |
  | 세션 복원 탭 50개                   | 메모 50개(각 20KB)의 워크스페이스, 탭 50개, 활성 탭 하나만 읽는다                                                                                    | `process-start` → `restore-done`   | **1,000ms**                                     |
  | 검색 메모 1만 개                    | `memos-10k` 워크스페이스, 리터럴 `needle-50`(100개 파일에 매치)                                                                                      | `search-start` → `search-done`     | **1,000ms**                                     |
  | 검색 정규식                         | 같은 워크스페이스, `needle-\d+5$`                                                                                                                    | 같음                               | **2,000ms**                                     |
  | 메모리                              | `code-100mb.ts` 를 뷰어로 연 뒤 10초, `ps -o rss=`                                                                                                   | RSS                                | **목표 없음 — 기록만.** 사람 판단 필요로 올린다 |

  근거: 파일 열기의 출발점은 스파이크 「스펙에 반영할 것」의 「줄 나누기 + 첫 화면 토큰화 10MB 코드 20–39ms, 편집기 `openMs` 31ms」 — 릴리스 앱에서 IPC·디코딩·state 생성을 더해도 10배 여유를 둔 값이 500ms 다. 콜드 스타트 1,500ms 는 Tauri 앱의 흔한 값(WebView 생성 수백 ms + 레지스트리 스캔)에 2배. 세션 복원은 활성 탭 하나만 읽으므로 콜드 스타트 안쪽이어야 하지만 메모 50개 목록 조회가 더해져 같은 급으로 두었다. 검색은 ripgrep 이 20MB 를 병렬로 수십 ms 에 훑는 값에, IPC 스트리밍과 DOM 그리기 100 그룹을 더한 여유다. **이 값들이 틀렸다고 데이터를 본 뒤 고치지 않는다** — 조건부·안 된다로 적는다.

- **재지 않는 것(미리 적는다):** 키 입력 지연(스파이크와 2번 계획 Task 14 가 이미 사전 등록 절차로 쟀다; 이번 하이라이트 변경(Task 15) 뒤 **같은 절차** `pnpm measure:long-line` 을 한 번 다시 돌려 `LONG_LINE_LIMIT` 판정이 바뀌지 않는지만 본다), 스크롤 프레임(계측 지점이 없다 — 다음 계획), Zed·Sublime 과의 수동 비교(사람 판단 필요), 한글 조합 키 지연(스펙이 「따로 재는 방법이 필요하다」고 한 것 — 다음 계획).

- [ ] **Step 1: 규칙 사본** — `tests/measure/perf.md` 에 위 「사전 등록 규칙」을 그대로 옮긴다(실행 중에 바꾸지 않는다). 커밋.

- [ ] **Step 2: 계측 지점** — `perf.rs`·`perf_mark`·프론트 마크. 테스트: `perf.rs` 의 `marks_are_appended_as_jsonl_only_when_enabled`(환경 변수 없으면 파일이 안 생긴다). `pnpm test` 가 Fake 의 no-op 으로 그대로 통과하는지.

- [ ] **Step 3: 픽스처 생성기와 측정 스크립트** — `scripts/perf-fixtures.ts`(테스트: `scripts/perf-fixtures.test.ts` 에 `the markdown twin has the same code inside a ts fence`, `the memo workspace has ten thousand indexed memos`), `scripts/measure-perf.sh`, `scripts/perf-summary.ts`(테스트: 중앙값·p95 계산, 무효 회 처리).

- [ ] **Step 4: 측정** — `pnpm perf:fixtures /tmp/tote-perf-fixtures && pnpm perf:measure /tmp/tote-perf-fixtures`. 사람의 화면을 쓰지 않는다(`TOTE_BACKGROUND=1`). 끝나면 `~/Tote-dev`·`~/Library/Application Support/tote-dev` 가 안 생겼는지 검사.

- [ ] **Step 5: 보고서** — `docs/superpowers/reports/<실행 날짜>-tote-notes-perf.md`: 환경, 규칙(사본을 가리킨다), 시나리오별 5회 값·중앙값·p95·판정, 유효성 사건, 「조건부·안 된다」 목록(사람에게 올릴 것), 재지 않은 것. `pnpm measure:long-line` 재실행 결과도 한 절로(판정이 바뀌면 **값을 바꾸지 말고** 사람 판단 필요로).

- [ ] **Step 6: Commit**

```bash
git add tests/measure/perf.md src-tauri/Cargo.toml src-tauri/src/perf.rs src-tauri/src/lib.rs src-tauri/src/app/commands.rs src-tauri/src/appdata.rs src/backend src/app src/ui/search-panel.ts scripts/perf-fixtures.ts scripts/perf-fixtures.test.ts scripts/measure-perf.sh scripts/perf-summary.ts package.json .gitignore docs/superpowers/reports/<실행 날짜>-tote-notes-perf.md
git commit -m "perf: instrument start, open, restore and search; measure the pre-registered targets"
```

### Task 17: 에이전트 화면 스모크 — Orca computer-use 로, 입력기가 필요 없는 것만

사람이 「사람이 직접 안 하고 확인할 수 없나」라고 물었다. 이 태스크는 그 답이다: 에이전트가 실제 앱 창을 스크린샷·접근성 트리·클릭·키로 조작해 **입력기가 필요 없는 항목**을 확인하고 결과를 적는다. **한계를 먼저 적는다** — `orca computer type-text`/`press-key` 는 합성 키 입력이라 macOS 한글 입력기를 거치지 않는다(조합 이벤트가 안 난다). 한글 조합이 걸린 항목은 Task 18 의 사람 몫이다. 또 synthetic input 은 `unverified` 로 보고되므로 **결과는 반드시 트리·스크린샷·파일로 확인**한다.

**Files:**

- Create: `docs/superpowers/reports/<실행 날짜>-tote-notes-safety-net-smoke.md`(Task 18 과 같은 파일 — 「에이전트」·「사람」 절로 나눈다)

- [ ] **Step 1: 사람에게 알린다** — 이 스모크는 사람의 화면에 창을 띄운다(computer-use 는 보이는 창이 필요하다 — `TOTE_BACKGROUND=1` 로 띄우면 포커스는 안 가져가지만 창은 보인다). 시작 전에 「지금부터 약 n분 동안 tote-dev 창이 화면에 뜨고 혼자 움직입니다. 그동안 그 창을 만지지 말아 주세요. 시작해도 될까요?」 를 묻고 **답을 받은 뒤** 시작한다.

- [ ] **Step 2: 빌드와 격리된 실행** — 실행 파일 경로를 **먼저 확인**한다.

```bash
pnpm sync:bundled
pnpm tauri build --debug --bundles app --config src-tauri/tauri.dev.conf.json
APP="$PWD/src-tauri/target/debug/bundle/macos/tote-dev.app"
test -x "$APP/Contents/MacOS/tote" || { echo "no app binary"; exit 1; }
export TOTE_DATA_DIR=/tmp/tote-agent-smoke
rm -rf "$TOTE_DATA_DIR"
ls -d ~/Tote-dev ~/Library/Application\ Support/tote-dev 2>/dev/null   # 기준선: 둘 다 없어야 한다
open --env TOTE_DATA_DIR="$TOTE_DATA_DIR" --env TOTE_BACKGROUND=1 --env TOTE_BACKUP_INTERVAL_SECS=5 "$APP"
orca status --json | head -5          # Orca 가 running 인지
orca skills get computer-use           # 버전 맞춤 가이드 — 플래그를 외우지 말고 여기서 읽는다
orca computer list-apps --json | grep -i tote
```

「다시 연다」는 언제나 위의 `open --env …` 줄이다. Dock·Finder·`tote` 명령으로 띄우면 `TOTE_DATA_DIR` 이 빠진다.

사전 준비(에이전트가 셸로): `mkdir -p /tmp/tote-agent-files && cd /tmp/tote-agent-files`, `ffmpeg` 로 `clip.mp4`(2번 계획 Task 16 의 명령), `pic.png`(320×240), `printf '%%PDF-1.4\n' > doc.pdf`, `seq 1 6000000 | sed 's/$/ lorem ipsum/' > big.log`, `python3 -c "print('x'*3_000_000)" > oneline.txt`, 마켓 `.vsix` 는 네트워크가 없을 수 있으므로 `src-tauri/fixtures/tote-test-theme-0.0.1.vsix` 를 쓴다.

- [ ] **Step 3: 항목별 확인** — 각 행의 조작은 `orca computer get-app-state --app dev.tote.note.dev --json` 으로 트리를 읽고 `click --element-index`/`hotkey`/`type-text`(영문만)로 한다. 메뉴 단축키는 `hotkey --key CmdOrCtrl+N` 처럼. 결과 판정은 트리 텍스트·스크린샷·`TOTE_DATA_DIR` 안의 파일로 한다.

  | 항목                                         | 할 일                                                                                                                                                                                                                                                                                 | 기대(무엇으로 확인하나)                                                                                        |
  | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
  | 창 크기 복원(1번 미확인)                     | 창을 `drag` 로 옮기고 크기를 바꾼 뒤 ⌘Q → 다시 연다                                                                                                                                                                                                                                   | `sessions/<기기>.json` 의 `window` 와 `list-windows` 의 프레임이 같다                                          |
  | 강제 종료 뒤 탭 복원(2번 미확인)             | 메모 탭·`pic.png` 뷰어 탭·`big.log` 대용량 탭·미리보기(⇧⌘V) 탭을 연 채 2초 뒤 `pkill -9 -f tote-dev.app` → 다시 연다                                                                                                                                                                  | 탭 넷이 돌아오고 각자의 화면(트리에 뷰어 iframe·대용량 뷰어 행·미리보기)으로                                   |
  | 재실행 뒤 언어 유지                          | `.txt` 외부 파일을 열고 상태 표시줄로 SQL → ⌘Q → 다시 연다                                                                                                                                                                                                                            | 상태 표시줄 `SQL`                                                                                              |
  | `.vsix` 재설치 교체 질문                     | 설정 ⌘, → 「파일에서 설치…」 — 파일 대화상자는 네이티브라 `type-text` 로 경로 입력이 불안정하다: `FakeBackend` 가 아니므로 **`TOTE_DATA_DIR/extensions/` 에 픽스처를 미리 풀어 두고** 두 번째 설치만 대화상자로 시도한다. 대화상자 조작이 안 되면 「에이전트 불가 — 사람」으로 적는다 | 「이미 설치돼 있습니다 … 교체」 질문, `extensions/tote-test.test-theme@0.0.1/`                                 |
  | 미리보기 로컬 이미지·원격 자리표시(실앱 CSP) | 메모에 `![](pic.png)`·`![](https://example.com/x.png)` 를 **영문 `type-text`** 로, `pic.png` 가져온 뒤 ⇧⌘V                                                                                                                                                                            | 스크린샷에 이미지, 트리에 「원격 이미지」 자리표시; 재실행 뒤 그 탭이 미리보기로                               |
  | 영상 탭 왕복                                 | `clip.mp4` 를 열고 다른 탭 갔다 돌아온다                                                                                                                                                                                                                                              | 트리에 video 요소가 다시 있다                                                                                  |
  | PDF 텍스트로 열기                            | `doc.pdf`                                                                                                                                                                                                                                                                             | 「열 수 없음」 → 버튼 → 「텍스트로 열 수 없음」                                                                |
  | 백업 스냅샷(Task 10)                         | 메모를 고치고 10초 기다린다. 한 번 더 고치고 10초                                                                                                                                                                                                                                     | `backups/<id>/` 에 폴더 둘, 두 번째의 안 바뀐 파일이 `ls -li` 로 같은 inode, `.tote/manifest.json` 있음        |
  | 백업 폴더 열기                               | 메뉴 「파일 › 백업 폴더 열기」                                                                                                                                                                                                                                                        | Finder 창이 그 폴더로(`list-windows --app com.apple.finder`) — 확인 뒤 Finder 창을 닫는다                      |
  | 이전 버전 되돌리기                           | 「파일 › 이전 버전…」 → 둘째 항목 → 「이 버전으로 되돌리기」 → ⌘Z                                                                                                                                                                                                                     | 편집기 본문이 옛 내용 → ⌘Z 로 원래대로                                                                         |
  | 외부 변경 — 조용한 다시 읽기                 | 열린 메모 파일을 셸에서 `printf` 로 바꾼다(1초 안에 반영)                                                                                                                                                                                                                             | 본문이 바뀌고 커서 자리 유지, 배너 없음                                                                        |
  | 외부 변경 — 충돌 배너                        | `type-text` 로 치는 중(0.3초 안)에 셸에서 파일을 바꾼다                                                                                                                                                                                                                               | 배너 「다른 앱이 이 파일을 바꿨습니다」, 「내 버전」 → 파일에 친 글                                            |
  | 외부 변경 — 삭제                             | 열린 메모 파일을 `rm`                                                                                                                                                                                                                                                                 | 「삭제됨」 배너, 본문 그대로, 「다시 저장」 → 파일 다시 생김(사이드바에 새 메모)                               |
  | Finder 이름 바꾸기                           | 열린 메모를 셸 `mv` 로 이름 바꾸고 `type-text`                                                                                                                                                                                                                                        | 탭 제목이 새 이름, 새 이름 파일에 친 글, 옛 이름 파일 없음, 사이드바 활성 유지                                 |
  | 워크스페이스 검색                            | ⇧⌘F → `lorem`                                                                                                                                                                                                                                                                         | 그룹·매치 행이 트리에, 클릭 → 그 탭·줄                                                                         |
  | 저장 실패·종료 경고(Task 6)                  | 워크스페이스 폴더 `chmod 555` → 메모에 `type-text` → 탭 ⚠ → ⌘Q                                                                                                                                                                                                                        | 대화상자 「저장하지 못한 메모가 있습니다」 → 「취소」 → 앱 살아 있음 → `chmod 755` → 5초 뒤 ⚠ 사라짐 → ⌘Q 정상 |
  | Dock 종료(Task 7)                            | 치자마자 `osascript -e 'quit app "tote-dev"'` → 다시 연다                                                                                                                                                                                                                             | 친 글이 파일에, 탭 복원                                                                                        |
  | 사라진 워크스페이스                          | 두 번째 워크스페이스를 만들고 창을 닫은 뒤 폴더를 `mv` → ⇧⌘O                                                                                                                                                                                                                          | 피커에 「(찾을 수 없음)」 — 위치 지정은 네이티브 폴더 대화상자라 「사람」으로 넘긴다                           |
  | 한때 사라진 메모 탭 여섯(1번 「지켜볼 것」)  | 위 모든 재실행 뒤 세션의 탭 수를 매번 적는다                                                                                                                                                                                                                                          | 재실행마다 탭이 줄지 않는다                                                                                    |

- [ ] **Step 4: 정리와 검사**

```bash
osascript -e 'quit app "tote-dev"'
ls -d ~/Tote-dev ~/Library/Application\ Support/tote-dev 2>/dev/null && echo "WARNING: launched without TOTE_DATA_DIR"
rm -rf /tmp/tote-agent-smoke /tmp/tote-agent-files
```

위 경고가 나오면 지우지 말고 사람에게 알린다(2번 계획 Task 13 의 사고).

- [ ] **Step 5: 보고서와 커밋** — 행마다 「그대로 / 다름 — 무엇이 어떻게 / 에이전트 불가 — 사람」과 확인 수단(트리·스크린샷 경로·파일). `unverified` 였던 조작은 무엇으로 결과를 확인했는지 적는다. 「다름」은 고칠지·다음 계획으로 넘길지 판정과 함께.

```bash
git add docs/superpowers/reports/<실행 날짜>-tote-notes-safety-net-smoke.md
git commit -m "docs: record the safety-net agent smoke check"
```

### Task 18: 사람 스모크 — 실제 입력기와 사람 눈이 필요한 것만, 한 단계씩

코디네이터가 **한 단계씩** 안내하고 결과를 받아 적는다(한 번에 목록 전체를 넘기지 않는다). 에이전트는 이 태스크에서 앱을 띄우지 않는다 — 사람의 화면에서 사람이 띄운다.

**Files:**

- Modify: `docs/superpowers/reports/<실행 날짜>-tote-notes-safety-net-smoke.md`(「사람」 절)

- [ ] **Step 1: 사람이 터미널에서**

```bash
APP="$PWD/src-tauri/target/debug/bundle/macos/tote-dev.app"
export TOTE_DATA_DIR=/tmp/tote-smoke
rm -rf "$TOTE_DATA_DIR"
open --env TOTE_DATA_DIR="$TOTE_DATA_DIR" "$APP"
```

- [ ] **Step 2: 한 단계씩** — 각 단계를 보낸 뒤 답을 받고 다음을 보낸다.

  | #   | 할 일                                                             | 기대                                                                                  |
  | --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
  | 1   | 마크다운 메모에 한글 제목을 **조합 중인 채로** ⇧⌘V                | 조합이 확정되고 미리보기에 그 제목(2번 미확인)                                        |
  | 2   | 커서 셋(⌥클릭)에서 `가나` → ⌘Z ×2 → ⇧⌘Z ×2                        | 세 줄 모두 `가나`, 커서 셋(Task 4 의 ⇧⌘Z)                                             |
  | 3   | ⌘N 직후 **빠르게** `급히 끈다`                                    | 첫 글자가 제자리(Task 15 뒤에도)                                                      |
  | 4   | ⇧⌘F 에 한글 `회의` 를 조합으로 입력                               | 조합 중에는 검색하지 않다가 확정 뒤 결과; Esc 로 목록 복귀                            |
  | 5   | 「이전 버전…」 대화상자를 눈으로                                  | 시각이 `YYYY-MM-DD HH:MM:SS` 로 읽히고, 미리보기가 읽기 전용이며 글꼴이 편집기와 같다 |
  | 6   | 충돌 배너를 눈으로(다른 편집기로 열린 메모를 고친다)              | 배너가 편집기 위 한 줄, 버튼 둘, 누르면 사라진다                                      |
  | 7   | 사라진 워크스페이스 「위치 지정…」(Task 17 이 넘긴 것)            | 폴더 대화상자 → 그 창이 열린다                                                        |
  | 8   | 설정 「파일에서 설치…」로 같은 `.vsix` 두 번(Task 17 이 넘겼으면) | 교체 질문                                                                             |
  | 9   | 10MB `.ts` 를 열고 ⌘↓ 로 끝                                       | 끝 줄 색이 몇 초 안에(스파이크는 수십 초) — 체감을 적는다                             |

- [ ] **Step 3: 정리** — `osascript -e 'quit app "tote-dev"'`, `rm -rf /tmp/tote-smoke`. `~/Tote-dev`·`~/Library/Application Support/tote-dev` 검사.

- [ ] **Step 4: 보고서와 커밋** — 단계마다 결과와 사람이 남긴 말. 「다름」은 판정과 함께.

```bash
git add docs/superpowers/reports/<실행 날짜>-tote-notes-safety-net-smoke.md
git commit -m "docs: record the safety-net human smoke check"
```

---

## 자기 검토

쓴 뒤 스펙을 처음부터 다시 훑어 태스크와 맞댄 결과다.

| 스펙 절                                                                            | 태스크                |
| ---------------------------------------------------------------------------------- | --------------------- |
| 「백업」 — 10분·하드링크·보존·백업 폴더 열기·이전 버전·⌘Z                          | Task 9, 10            |
| 「워크스페이스 검색」 — 패널·토글·병렬·스트리밍·취소·5MB·문맥·열기                 | Task 13, 14           |
| 「외부 변경」 — 자기 쓰기·조용한 다시 읽기·충돌 배너·수정분 복원 충돌·삭제 배너    | Task 11, 12           |
| 「메모 ID 와 색인」 — rename 추적, 놓치면 새 메모                                  | Task 11               |
| 「오류 처리」 — 저장 실패 5초 재시도·종료 경고, 워크스페이스 찾을 수 없음          | Task 6, 8             |
| 「세션」·「저장」 — 앱을 끌 때 즉시(Dock 종료 포함)                                | Task 7                |
| 「목표와 측정」 — 나머지 목표치, 파일 세트, 계측 지점                              | Task 16               |
| 「번들 확장」 — 문법마다 라이선스 확인(원문)                                       | Task 1                |
| 「`tote` CLI」 — 실패를 알린다                                                     | Task 5                |
| 「테스트」 — 백업 하드링크·보존·검색·자기 쓰기 걸러내기의 Rust 테스트, 수동 스모크 | 각 태스크, Task 17·18 |

쓰면서 고친 것: Task 3 의 Range 없는 GET 을 206 으로 답하는 안은 큰 이미지를 자르므로 64MB 상한의 413 으로 바꿨다. Task 3 과 14 의 가짜 백엔드 취소 카운터 이름이 겹쳐 `textSearchCancelled`·`workspaceSearchCancelled` 로 갈랐다. Task 16 의 순수 릴리스 빌드는 `TOTE_BACKGROUND` 와 dev 데이터 경로를 무시해 사람의 화면·`~/Tote` 를 건드리므로 `perf` 프로필(릴리스 + `debug-assertions`)로 바꿨다. Task 7 Step 4 가 사람의 화면을 쓰는데 알림이 없어 Task 17 과 같은 알림 단계를 넣었다.

이 계획이 정하지 않고 사람에게 올리는 것(보고서에도 적는다): 앱을 끌 때 스냅샷을 찍을지, `LONG_LINE_LIMIT` 의 언어별 한도, 메모리 목표치, Task 16 의 「조건부·안 된다」 판정이 나온 지표를 고칠지, Zed·Sublime 과의 수동 비교.
