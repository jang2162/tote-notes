# tote-notes 이름 통일 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 패키지·크레이트 설명·살아 있는 문서에서 쓰는 제품 슬러그를 `tote-note` 에서 `tote-notes` 로 바꿔, 자매 앱 `keyring-notes` 와 `-notes` 복수형으로 맞춘다.

**Architecture:** 바꾸는 것은 **슬러그**(패키지명, 설명 문자열, 살아 있는 문서의 산문)뿐이다. 사용자에게 보이는 이름(`productName` = `tote`), Rust 크레이트명(`tote`, `tote_lib`), 번들 ID(`dev.tote.note`)는 하이픈 슬러그가 아니므로 건드리지 않는다. 날짜가 붙은 plan·spec·report 는 발행 당시의 기록이라 고치지 않는다. 지침 소스(`.ruler/`)를 고치면 `ruler apply` 로 생성물을 다시 만든다.

**Tech Stack:** pnpm, Cargo, ruler(`pnpm exec ruler apply`), Vitest, `cargo test`.

**Spec:** 별도 스펙 없음. 결정 근거는 자매 저장소 `keyring-notes` 의 `docs/naming-decision.md`(시리즈로 묶는다는 전제에서 복수형 통일을 권한 판단). 실행자는 `docs/guides/development.md` 를 먼저 읽는다(테스트·툴체인 규칙).

## Global Constraints

- 새 슬러그는 정확히 `tote-notes`(소문자, 하이픈, 복수).
- 바꾸지 않는 것: `productName` `tote`, Cargo 패키지명 `tote`, 라이브러리명 `tote_lib`, 번들 ID `dev.tote.note`, 날짜가 붙은 `docs/superpowers/{plans,specs,reports}/*` 의 본문과 파일명.
- `keyring-notes` 저장소는 이 계획에서 건드리지 않는다(`@keyring-notes/*` 스코프 유지).
- 생성물(`AGENTS.md`, `CLAUDE.md`, `.claude/` 등)은 직접 고치지 않는다. 소스를 고치고 재생성한다.
- 작업은 워크트리에서 한다(최상위 체크아웃에서 하지 않는다).

## Review Focus

- **날짜 문서를 실수로 치환한다.** 파일명·본문이 바뀌면 `.ruler/90-reference.md` 의 경로 링크가 끊긴다. 치환 범위는 아래 Task 의 파일 목록으로만 한정한다.
- **`.ruler/90-reference.md` 의 경로까지 치환한다.** 산문의 `tote-note` 만 바꾸고, 백틱 안의 `docs/superpowers/...tote-note-...md` 경로는 그대로 둔다.
- **`ruler apply` 를 빠뜨린다.** 생성물이 gitignore 라 `git status` 에 안 떠서 낡은 지침이 조용히 남는다.
- **Cargo.lock·pnpm-lock 이 바뀐다.** 패키지명 `tote` 는 그대로라 lock 변경이 없어야 한다. 변경이 생기면 범위를 벗어난 것이다.
- **`description` 만 바꾸고 `name` 을 바꾼다.** `src-tauri/Cargo.toml` 의 `name = "tote"` 가 바뀌면 크레이트 경로(`tote_lib`)와 빌드가 깨진다.

---

### Task 1: 슬러그 치환과 지침 재생성

**Files:**

- Modify: `package.json`(`name`)
- Modify: `src-tauri/Cargo.toml`(`description`)
- Modify: `spikes/lab/README.md`(첫 문단 산문)
- Modify: `.ruler/90-reference.md`(표의 산문만, 백틱 경로 제외)
- 건드리지 않음: `.idea/`(IDE 생성물, 추적되지 않음), `docs/superpowers/**` 날짜 문서, `pnpm-lock.yaml`, `src-tauri/Cargo.lock`

**Interfaces:**

- Consumes: 없음.
- Produces: 슬러그 `tote-notes`. 이후 계획·문서는 이 슬러그로 쓴다.

- [ ] **Step 1: 치환 전 범위를 센다**

Run: `grep -rIlE 'tote-note([^s]|$)' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.worktrees --exclude-dir=target --exclude-dir=docs --exclude-dir=.idea .`
Expected: 위 Files 의 4개 파일(`package.json`, `src-tauri/Cargo.toml`, `spikes/lab/README.md`, `.ruler/90-reference.md`)과 생성물 `AGENTS.md`·`CLAUDE.md` 가 나온다. 다른 파일이 나오면 멈추고 판단한다.

- [ ] **Step 2: `package.json` 의 `name` 을 `"tote-notes"` 로 바꾼다**

한 줄 치환. `scripts`·`dependencies` 는 건드리지 않는다.

- [ ] **Step 3: `src-tauri/Cargo.toml` 의 `description` 첫머리를 `tote-notes:` 로 바꾼다**

`name`, `[lib] name` 은 그대로 둔다. 영문 설명 문장의 나머지도 그대로 둔다.

- [ ] **Step 4: `spikes/lab/README.md` 첫 문단의 `tote-note 코어 스펙` 을 `tote-notes 코어 스펙` 으로 바꾼다**

- [ ] **Step 5: `.ruler/90-reference.md` 표의 산문 `tote-note` 4곳을 `tote-notes` 로 바꾼다**

백틱 안의 문서 경로(`...2026-10-07-tote-note-core-design.md` 등)는 날짜 문서의 실제 파일명이라 그대로 둔다.

- [ ] **Step 6: 지침 생성물을 다시 만든다**

Run: `pnpm exec ruler apply && git status --short`
Expected: 추적 파일 변경이 Step 2~5 의 4개 파일뿐이다(생성물은 ignore). `pnpm-lock.yaml`·`src-tauri/Cargo.lock` 이 보이면 범위를 벗어난 것이다.

- [ ] **Step 7: 슬러그가 남은 곳을 다시 센다 — 두 방법으로**

Run: `grep -rIoE 'tote-note([^s]|$)' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.worktrees --exclude-dir=target --exclude-dir=docs --exclude-dir=.idea . | wc -l`
Expected: `0`. 다른 방법으로 `git grep -nE 'tote-note([^s]|$)' -- . ':!docs/superpowers'` 도 돌려 `docs/superpowers` 밖에서 남은 곳이 없는지 확인하고, `docs/` 안 날짜 없는 문서(`docs/guides/development.md`, `docs/guideline/`)에 남은 곳이 있으면 목록으로 보고한다.

- [ ] **Step 8: 빌드·테스트가 그대로 도는지 확인한다**

Run: `docs/guides/development.md` 에 적힌 프론트 테스트·타입체크·`cargo test` 명령.
Expected: 통과. 출력에서 **실제 실행 개수**가 0 이 아닌지 확인해 보고에 적는다.

- [ ] **Step 9: 커밋한다**

```bash
git add package.json src-tauri/Cargo.toml spikes/lab/README.md .ruler/90-reference.md
git commit -m "chore: unify the product slug as tote-notes to pair with keyring-notes"
```

---

## 계획 밖(별도 결정)

- 로컬 디렉터리 이름 `tote-note` 와 IDE 모듈 이름은 이 계획이 건드리지 않는다. 바꾸려면 워크트리·IDE 설정이 함께 움직이므로 따로 한다.
- 저장소를 원격에 처음 올릴 때 저장소 이름은 `tote-notes` 로 만든다.
- `keyring-notes` 가 `tote-notes` 를 호스팅하는 기능을 설계할 때, 두 슬러그가 `-notes` 로 맞아 있음을 전제로 한다.
