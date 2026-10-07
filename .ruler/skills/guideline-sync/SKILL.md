---
name: guideline-sync
description: 문서 저장소의 지침 중 이 프로젝트에 맞는 것을 가려내어 이 프로젝트의 지침 형태에 맞게 반영한다. "지침 받아와", "공용 지침 적용", "guideline 동기화" 같은 요청에 쓴다.
---

<!-- 이 파일은 guideline init 이 씨앗으로 만든다. 이후로는 이 저장소가 관리한다. guideline update 가 덮어쓰지 않으니 팀 사정에 맞게 고쳐도 된다. -->

# guideline-sync

**이 스킬은 지침을 받을 프로젝트에서 실행한다.** 지침 원본인 문서 저장소를 사용자에게 받아, 그 지침 중 이 프로젝트에 맞는 것을 이 프로젝트의 방식대로 반영한다.

## 전제 확인

1. **문서 저장소의 로컬 경로를 사용자에게 묻는다.** 그 경로에 `rules/` 가 없으면 문서 저장소가 아니다. 다시 묻는다.
2. 그 저장소가 원격보다 뒤처졌는지 `git -C <문서 저장소> fetch` 로 확인해 알린다. 뒤처졌으면 `git pull` 을 권한다. 계속할지는 사용자가 정한다.
3. 이 프로젝트의 작업 트리가 깨끗한지 본다. 더러우면 사용자에게 알린다. 계속할지는 사용자가 정한다 — 섞이면 사용자가 자기 변경과 구분하기 어렵다.

## 절차

1. **이 프로젝트를 파악한다.**
   - 지침 형태를 구분한다: ruler(`.ruler/`), `CLAUDE.md` 만, `AGENTS.md` 만, 두 파일이 서로 사본, 한 파일이 다른 파일을 import, 지침 없음
   - 쓰는 에이전트와 스킬 경로를 확인한다(`.claude/skills/`, `.agents/skills/`, `.ruler/skills/`).
   - 서브에이전트와 MCP 설정 위치를 확인한다. 서브에이전트: `.claude/agents/`, `.codex/agents/`, `.cursor/agents/`, `.github/agents/`, `.ruler/agents/`. MCP: `.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`, `.ruler/ruler.toml`. ruler 프로젝트면 `.ruler/agents/` 와 `.ruler/ruler.toml` 이 원본이다.
   - 이전에 반영한 지침 사본을 확인한다. 상시 지침은 ruler 면 `.ruler/<스택>/`, 참조 지침은 `docs/guideline/<스택>/`, 색인은 ruler 면 `.ruler/<스택>/99-reference.md`, 아니면 지침 파일의 `## <스택> 참조 지침` 절이다. `docs/guideline/` 이 있는데 `docs/guideline/README.md` 가 없거나 5번의 문장과 다르면, sync 사본이 아닌 문서가 섞였을 수 있다. 멈추고 사용자에게 묻는다.
   - **스택을 판정한다.** 빌드 파일과 의존성을 읽고 판단한다. 모노레포면 디렉터리별로 판정한다. 확신이 없으면 사용자에게 묻는다.

2. **문서 저장소의 지침을 읽는다.** 그 저장소에서 `pnpm guideline list --json` 을 돌려 스택·스킬·서브에이전트·MCP 목록과 지침 파일마다 칸(`load`)·`when` 을 보고, 해당하는 파일을 읽는다. `load` 가 `null` 인 파일은 칸 경고가 있는 것이다(`warnings` 에 이유). 반영하지 말고 문서 저장소의 원본을 고치자고 보고한다. `warnings` 에 스택 README(`rules/<스택>/README.md`)의 바꿈 경고가 있으면 그 스택도 반영하지 말고 같은 식으로 보고한다. 스택마다 `overrides` 에 다른 스택을 바꾸는 절이 있다(4번 「스택 사이」). 지침 파일이 없는 뼈대 스택은 목록에 나오지 않는다. MCP 는 `mcp/<이름>/README.md` 에서 맞는 스택과 필요한 환경 변수를 읽는다. `mcp` 에서 `build` 가 `true` 인 서버(텍스트 목록에서 `반영할 때 README 로 만든다`)도 판정 대상이다. 그 README 의 `## 반영할 때 항목 만들기` 절을 읽는다. `warnings` 에 `server.json` 과 그 절이 함께 있다고 나온 서버는 어느 쪽을 쓸지 사용자에게 묻는다.

3. **원본 파일마다 절 단위로 판정한다.**

   | 판정 | 기준 |
   | --- | --- |
   | 반영됨 | 같은 취지가 이 프로젝트에 이미 있다 |
   | 반영 가능 | 이 프로젝트에 없다 |
   | 갱신 가능 | 같은 주제인데 원본 쪽 내용이 더 낫거나 바뀌었다 |
   | 충돌 | 이 프로젝트가 의도적으로 다르게 정했다. 기본은 프로젝트 규칙 유지 |
   | 해당 없음 | 스택이 맞지 않는 등. 이유를 함께 적는다 |
   | 칸 변경 | 프로젝트 사본의 자리와 원본의 `load` 가 다르다(`.ruler/<스택>/` 에 있는데 원본이 `reference` 등) |
   | 원본에서 사라짐 | 사본 자리(`.ruler/<스택>/`, `docs/guideline/<스택>/`)에 있는데 원본에 없다. 지울 후보 |

   지침 사본은 frontmatter 를 뗀 원본과 비교한다. 색인은 판정하지 않는다 — 5번에서 매번 다시 쓴다.

   스킬·서브에이전트·MCP 서버도 이 프로젝트에 필요한지 같은 방식으로 하나씩 판단한다.

   README 로 만드는 MCP 서버는 필요하다고 판단하면 그 절대로 이 프로젝트에서 값을 읽어 항목을 만들고, 만든 항목으로 반영됨·갱신 가능을 가린다. 값을 알아내지 못했거나 절이 사용자에게 묻게 한 지점에 닿으면 묻는다.

4. **표로 보고하고 사용자가 확인한 항목만 반영한다.**

```
## 지침 받기 — <프로젝트> (형태: <ruler | CLAUDE.md | …>, 스택: <이름>)

| 원본 | 칸 | 절 | 판정 | 반영할 자리 |
| --- | --- | --- | --- | --- |
| rules/base/01-git.md | always | 「워크트리에서 작업한다」 | 반영 가능 | CLAUDE.md 「Git 작업 규칙」 뒤 |
| rules/browser/01-mcp-lifecycle.md | reference | — | 칸 변경 | .ruler/browser/01-mcp-lifecycle.md → docs/guideline/browser/01-mcp-lifecycle.md |
| — | — | — | 원본에서 사라짐 | docs/guideline/orca/05-old.md 지울 후보 |
| mcp/context7/ | — | — | 반영 가능 | .mcp.json, .codex/config.toml |
| mcp/gitlab/ (README 로 만듦) | — | — | 반영 가능 | .mcp.json, .codex/config.toml |

mcp/gitlab/ 에서 만든 항목
  { "type": "http", "url": "https://gitlab.example.com/api/v4/mcp" }
  <웹 주소> = https://gitlab.example.com  ← git remote get-url origin

스택 사이
| 바뀌는 절 | 바꾸는 절 | 이 프로젝트 |
| --- | --- | --- |
| base/01-git.md 「워크트리는 저장소 안에 만들고, 하나의 작업이 하나를 갖는다」 | orca/05-switch.md 「Orca 가 살아 있으면 워크트리도 Orca 로 만든다」 | 둘 다 적용 — orca 가 이긴다 |
```

   README 로 만든 MCP 서버는 표 아래에 만든 항목과, 채운 값마다 어디서 읽었는지 적어 사용자가 확인하게 한다. 읽은 원문에 사용자 정보·토큰(`https://<사용자>:<토큰>@…`)이 있으면 원문을 옮기지 않고 뽑은 값만 적는다.

   반영할 스택을 정한 뒤 `list --json` 의 각 스택 `overrides` 를 읽어 표 아래 「스택 사이」 표를 덧붙인다. `from` 이 바꾸는 절, `to` 가 바뀌는 절이다. 「적용」 은 이 프로젝트가 이미 받은 스택과 이번에 반영할 스택이다.
   - 둘 다 적용: 보고만 한다.
   - 바꾸는 쪽만 적용: 바뀌는 스택도 넣을지 사용자에게 묻는다. 넣지 않으면 바꾸는 절이 이 프로젝트에 없는 절을 가리킨다.
   - 바뀌는 쪽만 적용: 아무것도 하지 않고 표에도 싣지 않는다.

5. **반영 방식은 이 프로젝트의 형태에 맞춘다.**
   - **지침 — 공통**: 원본을 옮길 때 frontmatter 를 뗀다(첫 줄 `---` 부터 닫는 `---` 와 그 뒤 빈 줄까지). `reference` 파일은 형태와 관계없이 `docs/guideline/<스택>/NN-*.md` 에 원본 이름 그대로 둔다.
   - **지침 — ruler**: `always` 파일은 `.ruler/<스택>/NN-*.md` 에 원본 이름 그대로 둔다. nested 모드여도 루트 `.ruler/` 에만 둔다. 스킬은 `.ruler/skills/` 에 넣는다. `ruler apply` 는 이 프로젝트의 방식을 따르고, 정해진 방식이 없으면 실행을 안내만 한다.
   - **지침 — `CLAUDE.md`·`AGENTS.md`**: `always` 는 기존 문서 구조에 맞는 자리에 절로 넣는다. 두 파일이 사본이면 양쪽을 똑같이 고치고, import 관계면 원본 쪽 파일에 넣는다. 색인은 같은 파일 안에 `## <스택> 참조 지침` 절로 둔다.
   - 지침 파일이 없으면 어떤 파일을 만들지 사용자에게 묻는다.
   - **색인**: `reference` 파일이 하나라도 있는 스택에만 둔다(ruler 면 `.ruler/<스택>/99-reference.md`). 확인 없이 매번 통째로 다시 쓰고, `reference` 파일이 없어진 스택의 색인은 지운다. 모양은 정확히 아래와 같다. 행은 파일 이름순, 경로는 저장소 루트 기준이다. ruler 가 아니면 제목만 `## <스택> 참조 지침` 으로 쓴다.

     ```markdown
     # <스택> 참조 지침

     아래 작업을 할 때는 **시작하기 전에** 그 파일을 읽는다. 이 규칙들은 상시 지침에 없다.

     | 언제 | 읽을 파일 |
     | --- | --- |
     | <when> | `docs/guideline/<스택>/<파일>` |
     ```

   - **`docs/guideline/README.md`**: 없으면 만든다. 내용은 이 문장 하나다: 「이 디렉터리는 `sync-guideline` 이 문서 저장소에서 복사한 참조 지침이다. 직접 고치지 않는다 — 고칠 것은 문서 저장소에 `import-guideline` 으로 올린다.」
   - **칸 변경**: 새 자리에 쓰고 옛 자리 사본을 지운다. 같은 파일이 두 자리에 남지 않게 한다.
   - **원본에서 사라짐**: 사용자가 확인한 것만 지운다. 두 자리(`.ruler/<스택>/`, `docs/guideline/<스택>/`) 모두 본다.
   - 스킬은 이 프로젝트가 쓰는 에이전트 경로에 넣는다. 스킬은 `skills/<이름>/` 디렉터리를 통째로(보조 파일 포함) 복사한다.
   - **서브에이전트 — ruler**: `.ruler/agents/<이름>.md` 로 그대로 복사한다. `.ruler/ruler.toml` 에 `[agents]` 의 `enabled = true` 가 없으면 켜지 말고 사용자에게 묻는다. 실험적 기능이고, 켜면 `.gitignore` 에 생성물 경로가 더해진다.
   - **서브에이전트 — 그 밖**: Claude 는 `.claude/agents/<이름>.md` 에 그대로, Codex 는 `.codex/agents/<이름>.toml` 에 `name`, `description`, 본문을 `developer_instructions` 로 쓴다(`tools`, `model: inherit` 은 뺀다).
   - **MCP — ruler, 변수 참조도 `headers` 도 없음**: `.ruler/ruler.toml` 에 `[mcp_servers.<이름>]` 으로 `server.json` 의 필드를 옮긴다.
   - **MCP — ruler, 변수 참조나 `headers` 가 있음**: 전역 `[mcp_servers]` 에 두지 않는다. ruler 는 `${…}` 를 Codex 설정에 그대로 옮기는데 Codex 는 이것을 펼치지 않고, 헤더도 Codex 가 읽지 않는 `headers` 키로 쓴다. 이 프로젝트가 배포하는 에이전트마다 `[agents.<에이전트>.mcp_servers.<이름>]` 으로 쓴다. Claude 는 `server.json` 필드 그대로(`type` 포함 — 이 경로에서는 ruler 가 `type` 을 채우지 않는다), Codex 는 아래 표로 바꾼다. 그 밖의 에이전트는 그 에이전트의 형식을 확인하고, 확신이 없으면 사용자에게 묻는다.
   - **MCP — 그 밖**: Claude 는 `.mcp.json` 의 `mcpServers.<이름>` 에 `server.json` 을 그대로, Codex 는 `.codex/config.toml` 의 `[mcp_servers.<이름>]` 에 아래 표로 바꿔 쓴다.
   - **MCP — README 로 만드는 서버**: 3번에서 만든 항목을 `server.json` 으로 보고 위 경로대로 반영한다. ruler 에서 변수 참조나 `headers` 가 있는지도 만든 항목으로 가린다.
   - 기존 설정 파일에는 해당 항목만 더한다. 다른 서버·키·서식은 건드리지 않는다.

   Codex 로 바꾸는 표:

   | server.json | Codex `[mcp_servers.<이름>]` |
   | --- | --- |
   | `command`, `args`, `url` | 같은 이름 그대로 |
   | `env` 의 `"X": "${X}"` | `env_vars = ["X"]` |
   | `env` 의 고정값 | `env = { … }` |
   | `headers` 의 `"Authorization": "Bearer ${X}"` | `bearer_token_env_var = "X"` |
   | `headers` 의 `"H": "${X}"` | `env_http_headers = { "H" = "X" }` |
   | `headers` 의 고정값 | `http_headers = { … }` |
   | `type` | 쓰지 않는다 |

6. **멈추는 곳.** 커밋하지 않고 바뀐 파일 목록을 보고한다. MCP 를 반영했으면 필요한 환경 변수와 각 `mcp/<이름>/README.md` 의 발급 방법을 함께 보고한다. Codex 는 신뢰한 프로젝트에서만 `.codex/config.toml` 을 읽는다는 것도 알린다.
   지침을 반영했으면 반영 전후의 상시 크기를 적는다. ruler 면 `.ruler/` 아래 `skills/`·`agents/` 를 뺀 `.md` 의 바이트 합계다(`find .ruler -name '*.md' -not -path '.ruler/skills/*' -not -path '.ruler/agents/*' -exec cat {} + | wc -c`). ruler 가 아니면 상시 지침 파일(`CLAUDE.md`·`AGENTS.md`)의 바이트다.

## 지킬 것

- **문서 저장소 파일을 고치지 않는다.** 원본이 틀렸다고 판단되면 반영하지 말고 `guideline-export` 로 올리자고 제안한다.
- **프로젝트 고유 규칙을 지우거나 바꾸지 않는다.** 충돌 항목에서 사용자가 원본을 고른 경우만 예외다.
- 반영할 자리에 같은 이름의 파일이나 서브에이전트·MCP 서버 항목이 이미 있으면 덮어쓰지 않는다. 차이를 보여 준 뒤 사용자가 고르게 한다. 색인은 예외다 — 매번 다시 쓴다.
- 기록 파일이나 출처 주석을 남기지 않는다(5번의 색인과 `docs/guideline/README.md` 만 둔다). 다음에 다시 돌릴 때도 원본과 이 프로젝트의 지침을 처음부터 비교한다.
- 원본 문구를 이 프로젝트 문서에 맞춰 다듬되 규칙의 내용은 바꾸지 않는다.
- 사용자가 확인하지 않은 항목을 함께 반영하지 않는다.
- **사본은 원본 그대로 둔다.** 다른 스택이 바꾸는 절이라도 빼거나 고쳐 쓰지 않는다. 무엇을 대신하는지는 바꾸는 쪽 절이 말한다.
- **비밀값을 프로젝트 파일에 쓰지 않는다.** 사용자가 값을 알려 줘도 쓰지 않고 환경 변수로 두라고 안내한다.
- **프로젝트 설정에 박힌 값을 차이·보고·대화에 옮기지 않는다.** 기존 MCP 항목과 차이를 보여 줄 때도 비밀일 수 있는 값은 위치만 적는다(예: "`env.DB_PASSWORD` 에 값이 박혀 있음").
