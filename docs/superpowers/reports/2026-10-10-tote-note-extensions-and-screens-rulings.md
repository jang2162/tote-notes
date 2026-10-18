# tote-notes 확장과 화면 — 코디네이터 판정 기록

tote-notes 확장과 화면 계획(`docs/superpowers/plans/2026-10-10-tote-note-extensions-and-screens.md`)을 실행하며 코디네이터가 사람 대신 내린 판정과, 리뷰에서 미루거나 다음 태스크·다음 계획으로 넘긴 항목이다. 실행용 진행 기록(git 밖, `.superpowers/sdd/2026-10-10-tote-note-extensions-and-screens/progress.md`)을 지우기 전에 판정·이월에 해당하는 줄을 원문 그대로 옮겼다. 판정 줄은 `무엇을 정했나 — 왜 — 틀렸다면 드는 비용` 이다. 이후 계획이 이미 처리한 항목도 섞여 있으니, 남은 일인지는 다음 계획 문서와 코드로 확인한다.

## 사전 점검 판정

### 일반 판정

- **R0. 보고서의 「제안 판정」 열을 채택한다** — 차단·중간·낮음 모두. 제안이 둘 이상이면 첫째를 따른다. 따르면 스펙과 어긋나는 경우에만 `ask` 로 묻는다. 따른 행은 보고서 「브리프와 다르게 한 것」에 F 번호로 적는다.
- **R1 (F01).** Task 5 가 `.oxfmtrc.json` 의 `ignorePatterns` 에 `src-tauri/resources/extensions/` 와 `src/backend/fake-registry.json` 을 더한다(생성물 — 포매터가 viewer.html 인라인 스크립트를 고치면 CSP 해시가 어긋난다). 같은 이유로 생성물을 손으로 oxfmt 하지 않는다.
- **R2 (F02).** cargo 테스트 필터를 여럿 주려면 `cargo test --manifest-path src-tauri/Cargo.toml -- <필터1> <필터2>` 로 쓴다.
- **R3 (F03).** `FakeBackend.pickFiles()` 는 `picks` 를 한 번에 다 돌려준다 — 「열기」를 여러 번 누르는 테스트는 매번 하나씩 심는다.
- **R4 (F17·F31 순서 충돌).** 뒤 태스크가 만드는 번들 뷰어를 기대하는 테스트는 그 뒤 태스크(11·12)로 옮기고, 앞 태스크(6·10)는 테스트용 뷰어를 단 레지스트리로 같은 동작을 확인한다.
- **R5 (F29 — 자동 인식 시점).** 언어 자동 인식은 **커서가 문서의 1행을 떠날 때와 `leave()`** 에 돈다 — 제목을 바꾸는 시점(제목 줄을 떠날 때)과 따로 둔다. 근거: 스펙 「편집기」는 인식 시점을 정하지 않았고, shebang 은 1행에 있으므로 1행을 떠나는 순간이 인식에 맞다. 그 시점에 확장자만 바뀔 수 있다(예: `untitled.md` → `untitled.sh`), 제목은 제목 줄을 떠날 때 바뀐다. 테스트 기대값을 이 규칙으로 다시 따진다.
- **R6 (위험 — `tote-ext://` iframe).** Task 10 은 **첫 단계에서** 실제 앱(디버그 빌드, `TOTE_BACKGROUND=1`·`TOTE_DATA_DIR` 임시)으로 `tote-ext://` 문서를 sandbox iframe 에 싣는 최소 확인을 먼저 한다. 안 되면 보고서 5절의 대안(번들 뷰어 HTML 을 frontendDist 의 `/viewers/<확장 ID>/viewer.html` 로)으로 가고 그 사실을 보고서에 적는다 — 코디네이터에게 따로 묻지 않아도 된다.

### 사전 점검 판정 보충

- R1 의 ignore 에 `src-tauri/fixtures/` 도 들어간다(Task 3 수정 회차 1 이 넣는다).

## 판정과 이월 (원문, 시간순)

- Ruling: adopt every preflight 「제안 판정」 (first option when several) — the scan verified most against real packages/tsc/WebKit; spec wins if one conflicts — cost if wrong: one task's fix round
- Ruling: F01 Task 5 adds generated paths to .oxfmtrc ignorePatterns — viewer CSP hashes break otherwise — cost: none
- Ruling: F17/F31 tests needing bundled viewers move to Tasks 11/12; Tasks 6/10 use a test registry — keeps each task green — cost: viewer wiring checked later
- Ruling: F29 auto-detect runs when the cursor leaves doc line 1 and on leave(), separate from the title trigger — spec silent on timing; shebang lives on line 1 — cost: an extension rename before the title settles
- Ruling: tote-ext:// iframe unmeasured — Task 10 checks it first in the real app; fallback = viewers under frontendDist — cost: a Task 10 detour
- Task 1: minor (deferred): tabs.test does not pin "next tab first" when closing a middle tab ([a,b,c] remove b -> c); comment at :41 says middle
- Task 1: minor (deferred): SessionSync/controller mutate Tabs.list directly (append/replace helpers would keep invariants)
- Task 1: carry to Tasks 9·12: importExternal/importActive does not carry mode·language over (review ⚠️)
- Task 2: minor (deferred): ⇧⌘Z redo does not skip the no-text steps the ⌘Z loop skips (unverified; add E2E two syllables → ⌘Z×2 → ⇧⌘Z; else a redo twin)
- Task 2: minor (deferred): undo loop now runs on every ⌘Z (same-text edits fold into the previous step) — document in undoWithCursors
- Task 2: minor (deferred): ime.ts:271-274 head comment stale ("two dispatches")
- Task 2: minor (deferred): no test pins undoRestores truncation of records after undo
- Task 2: minor (deferred): ime.test placeholder before/startDoc values do not match scenarios
- Ruling: Task 3 M2 (English problem messages shown in settings) fixed now — Global Constraint "user-facing strings Korean" beats the brief code — cost: small
- Ruling: Task 3 M1 (one bad settings field drops the whole file incl. workspaceRoot) fixed now with per-field lenient deserialisation — losing the root looks like lost memos — cost: small
- Ruling: .oxfmtrc ignorePatterns also gets src-tauri/fixtures/ (same class as R1)
- Ruling: Task 4 M1 (settings read-modify-write race) and M2 (remove leaves stale registry on save error) fixed now — lose a person's setting / show a deleted extension — cost: small
- Task 4: minor (deferred): replace not atomic (old folder deleted before rename)
- Task 4: minor (deferred): rescan_extensions holds the settings lock while scanning disk (main thread waits)
- Task 4: minor (deferred): archive entries read whole into memory (256MB buffer) — stream with io::copy
- Task 4: minor (deferred): no tests for archive_prefix, MAX_UNPACKED_BYTES on zip, copy_folder symlink skip, parent check
- Task 4: minor (deferred): "folder without package.json copies nothing" test passes even without check_folder (weak discrimination)
- Ruling: Task 5 I1 fixed — the brief claims the test catches drift; the Global Constraint requires regeneration; a test that cannot fail is a false guard — cost: small
- Ruling: Task 5 M2/M3/M4 fixed in the same round (one-liners); M1/M5 deferred
- Task 5: minor (deferred): LICENSES.md carries SPDX+URL only — MIT requires the copyright/permission text in copies; add tm-grammars/tm-themes license texts before distribution
- Task 5: minor (deferred): checkLicense mixes metadata SPDX with override URL when licenseUrl missing
- Carry to Task 12: F36 placeholder /_**INLINE:marked**_/ needs the inlineViewer regex changed too, or marked ends up commented out (Task 5 review)
- Ruling: Task 6 M1 (languageData throws on malformed user language-configuration) — Task 8 makes languageData/parseLanguageConfiguration tolerant (Array.isArray, string checks, catch → plain config) with a test — spec: a bad extension must not block editing — cost: small
- Carry to Task 8: Task 6 M4 languageDataEffect untested — first use in Task 8 gets a test
- Carry to Task 9: Task 6 M2 built-in language data (markdown()) shadows config commentTokens/closeBrackets — order config first or Prec.high if Task 9 relies on it
- Carry to Task 15: Task 6 M3 fake backend ignores disabled for bundled rows; M5 fake settings() returns its internal object (return a copy)
- Ruling: Task 7 M1 fixed now — a theme/settings failure aborts session restore; spec: extension errors never block startup — cost: small
- Ruling: Task 7 M6 fixed now — theme colour strings could carry url(); spec: extensions have no network — cost: an odd but valid colour format falls back to default
- Ruling: Task 7 M2 (stale-guard test) and M4 (comment) ride along
- Task 7: minor (deferred): DEFAULT_VARIABLES duplicated in styles.css, no test pins equality
- Carry to Task 8: Task 7 M5 loadTheme does not type-check tokenColors values — Task 8's catch must cover a malformed installed theme
- Task 7: minor (deferred): colour filter drops named colours and negative numbers (falls back to default)
- Task 8: review Needs fixes (C0 I1 M3) — edits during first grammar load are dropped (open sends constructor-time text); closed docs leak in worker
- Carry to Task 9: Task 8 M1 tab switch recreates highlight plugin → close/open full text, cache lost (keep doc id on Doc, close only on tab close)
- Task 8: minor (deferred): negative assertions after fixed waits (highlight.spec 54/63/69)
- Task 8: carry: grammar/config caches not cleared on extension reinstall (Task 15)
- Task 8: minor (deferred): extension.ts:50 doc comment "text on creation" stale; closed-doc E2E negative assertion after fixed wait
- Carry to Task 16: smoke row expects '! bin zsh.sh' — under the new title rule it is untitled.sh (F46); coordinator edits task-16 brief before dispatch
- Ruling: renaming a memo to a different extension clears its index language; same-extension rename keeps it — spec: language comes from the extension; a picked language is a per-extension override — cost: a picked language is lost when the person renames to another extension
- Ruling: Task 9 M2 (import + language failure → duplicate memo on retry) and M1 (toString + regex compile on every line-1 exit for every .md memo) fixed now — cost: small
- Task 9: minor (deferred): saveSessionSoon on language change not pinned by a failing test
- Task 9: minor (deferred): Prec.high alone not pinned (test registry with a fake .md language could)
- Task 9: minor (deferred): never-back test input "# just a note" glued to line 1 gives an odd name
- Ruling: auto-detect only for .md + no language + autoTitle true — a person's rename (autoTitle false) must not be undone by detection; spec sentence amended — cost: imported .md files with a shebang are never auto-detected
- Ruling: Task 10 I1 — spec wins over brief: the button only for non-text kinds whose viewer is missing/failed — cost: none
- Ruling: Task 10 M1 (resolveRelative follows symlinks) and M4 (token issued after revoke) fixed now — Global Constraint "same folder only" and "revoke on close" taken literally — cost: a symlinked image in a note folder will not show in preview
- Ruling: Task 10 M2/M3 tests ride along
- Task 10: minor (deferred): (doc as ExternalDoc).size cast — Doc.size abstract getter
- Task 10: minor (deferred): MIME table comment vs serve.rs/range::content_type mismatch (case, .md)
- Carry to Task 11: real-app viewer iframe check beyond the R6 probe; Task 13: F39 OPTIONS preflight; open-ended Range memory
- Task 11: minor (deferred): Vite warns configLoader native unsupported (__dirname in vite.config.ts) on every webServer start
- Ruling: fix the tests now (insertText); the app-side stall is not changed in this plan — spec says grammars load on first open; stalls are under human key intervals — cost if wrong: a fast typist could see the first Hangul letter of a new memo move to the end
- Ruling: Task 16 smoke gets a row: ⌘N then type Hangul fast; first letter must stay first
- Carry to plan 3 (performance): move grammar read/parse off the main thread or yield between files
- Ruling: a failing preview viewer returns the tab to edit mode with "미리보기를 열 수 없어 편집으로 돌아왔습니다" — spec 「뷰어」's 「열 수 없음 + 텍스트로 열기」 is for non-text files; for a text file edit mode is the text view — cost: none
- Ruling: Task 12 M1 (<area href> click escapes the click guard → frame navigates to a remote page) fixed now — spec isolation — cost: none; M2/M3/M4/M6 ride along
- Task 12: minor (deferred): sanitizer (DROP, on*) not pinned separately from CSP
- Task 12: minor (deferred): notice-over-preview-text has no test
- Ruling: Task 13 option A — cap virtual height (MAX_SCROLL_HEIGHT) and map scrollTop↔line proportionally — 100MB+ logs usually exceed 1.67M lines — cost: coarse scrollbar precision on huge files
- Task 13: review Needs fixes (C0 I2 M6) — stale search results mix into a new search; proportional scroll (my ruling A) makes PageDown/wheel skip lines past 500k lines
- Ruling: Task 13 I2 fixed — keep a virtual position; wheel/keys move 1:1, only scrollbar drag is proportional — a reader must not silently miss lines — cost: more viewer code
- Ruling: Task 13 M1 (growing log overflows u64 / panics in debug), M2, M3 (CRLF search differs from fake), M4 (English regex error) and M6 (test for line placement) ride along
- Task 13: minor (deferred): closing a tab does not cancel a running scan/search
- Task 13: minor (deferred): Range-less requests read whole files; a 1000-line page of a long-line file can be huge
- Ruling: re-measure under the same pre-registered rule with the file type the rule left open fixed as BOTH code.ts and note.md, take the smaller boundary; spike endpoint (e.timeStamp → rAF+setTimeout0); keep raw per-key samples — LONG_LINE_LIMIT applies to every format, .md is the default — made after seeing the reviewer's probe, recorded as such — cost: a likely lower limit (~500k) sends more long-line memos to the read-only viewer
- Task 14: minor (deferred): startWithHugeLog pokes FakeBackend internals (as unknown as) — move to a helper
- Task 14: minor (deferred): docs.ts comment on LONG_LINE_LIMIT does not say it is the smaller of the two formats
- Ruling: Task 15 M1–M8 fixed in the same round (settings screen correctness; M8 is part of the Important fix) — cost: small
- Regression fix: 3c0a5ca (app) + 87645f7 (test); regression E2E fail 10/10 before, 20/20 after; pw 103 ×3, vitest 161; keys typed during a tab load are now dropped
- Ruling: keys typed while a tab first loads are dropped — better than editing another memo; the window is one 0.1–0.3s load per tab — cost: a few keystrokes typed blind into a not-yet-shown tab are lost
- Regression: minor (deferred): editor opens with empty language data until the config arrives (⌘/ / brackets briefly off); memo-list row may flash an old info; placeholder flicker while loading
- Final review: Ready to merge (C0, I2 next plan, M10, declined 8); suites rerun by reviewer at HEAD: vitest 161, cargo 160, pw 111, tsc; spec coverage: nothing missing; agrees with all rulings; deferred minors: 1 before merge, 21 next plan (license texts required before distribution), 10 dropped
- Ruling: final fix wave = M7 (comment), M1 (JSON.parse first), M4 (empty-filter Enter picks "C" → irreversible rename), M6 (importActive -1) — cost: small
- Ruling: Task 16 smoke runs BEFORE merge (final review's recommendation: preview in real app and ⌘N+fast Hangul are not covered by automation)
- Next plan (safety net) carry: Range cap for closed ranges + short 206 in viewer (I1), settings patch command (M2), reconfigure open tabs on config change (M3), license texts before distribution
- Next plan (performance) carry: chunk catch-up tokenization (I2), grammar read off main thread (M1 rest), thread pool for tote-file (M8), spawn_blocking scan/search (M9), pause hidden-tab background tokenization (M10)
