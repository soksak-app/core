# Agent 역할

[English](agent-roles.md)

이 문서는 agent CLI의 tab이 역할을 받는 방식을 정의한다. 구현과 검증은 [features](../features.md)에서 추적한다. 역할 변경은 [messaging](messaging.md#injected-message)의 주입 경로로 agent에 닿는다. 이 문서는 launch identity, 역할 파일, 변경 메시지와 agent 메모리의 규칙을 정의한다.

## 결정

- Agent CLI의 tab은 launch adapter를 통해 CLI에 stable identity를 준다. Identity는 그 tab의 역할 파일의 절대 경로를 적는다. Agent는 역할을 그 파일에서 읽고, launch나 메시지로 역할 text를 받지 않는다.
- 역할 파일은 surface 하나에 속하며, 사람의 repository가 아니라 application의 configuration directory에 놓인다.
- 역할이 바뀌면 역할 파일을 다시 쓰고 짧은 변경 메시지를 보낸다. 변경 메시지는 역할 파일의 경로를 적고 역할이 바뀌었다고만 말하며, 역할 text를 담지 않는다.
- Launch adapter가 없는 CLI는 같은 경로를 적은 같은 identity를 첫 메시지로 받는다.
- Resume은 CLI의 launch 지시를 바꾸지 않는다. Resume된 tab은 같은 경로를 적은 재읽기 메시지를 보내므로, agent는 resume 뒤에 현재 역할을 읽는다.
- Agent는 역할을 CLI의 어떤 persistent 메모리에도 쓰지 않는다. 역할은 세션 context와 역할 파일에만 있다.
- Launch 지시는 agent의 context compaction을 넘어 남도록 의도되어 있으므로, 경로와 규칙도 함께 남는다. Compaction은 측정되지 않았다([측정된 사실](#측정된-사실)).

근거: [측정된 사실](#측정된-사실)에 나열된 사실은 launch flag가 새 세션에만 적용되고, `resume`이 세션 시작의 지시를 유지하며, 역할 파일을 가리키는 pointer를 받은 agent가 첫 답변에서 파일을 읽고 변경 메시지 뒤에 다시 읽는다는 것을 보인다. 메시지나 launch에 text로 준 역할은 뒤의 메시지로만 바뀔 수 있다. 파일은 현재 역할을 담는 유일한 곳이므로 모든 reader가 같은 역할을 본다.

## 측정된 사실

Claude Code 2.1.329와 Codex 0.171.0을 모두 대화형 TUI로, 임시 configuration directory를 쓰는 application에서 측정했다. 각 행은 한 번의 실행이며 agent가 보인 답을 적는다.

| # | Launch 또는 동작 | 관찰된 결과 |
| --- | --- | --- |
| 1 | `claude --append-system-prompt-file F`, F가 역할 text를 담음 | F의 역할이 TUI에 적용되었다. |
| 2 | `claude --resume ID --append-system-prompt-file G` | 세션은 시작 때의 지시를 유지했고, G는 적용되지 않았다. |
| 3 | 실행 중인 Claude 세션에 새 역할을 정하는 메시지 | 새 역할이 launch 역할을 바꾸었다. |
| 4 | `codex --no-daemon -c developer_instructions="..."` | 지시가 TUI에 적용되었고, 사람의 전역 `AGENTS.md`도 그 옆에서 계속 유효했다. |
| 5 | 실행 중인 Codex 세션에 새 역할을 정하는 사용자 메시지 | developer-instruction의 역할이 유지되었다. |
| 6 | `codex resume --no-daemon ID -c developer_instructions=...` | 세션 시작의 developer instruction이 유지되었다. |
| 7 | Stable identity와 접두어가 붙은 역할 메시지가 있는 Codex | 가장 최근의 역할 메시지가 역할을 정했다. |
| 8 | 역할 파일만 가리키는 launch를 받은 Codex, 파일 변경, 변경 메시지 전송 | Agent는 첫 답변에서 파일을 읽었고, 변경 메시지 뒤에 다시 읽어 새 역할을 받았다. |
| 9 | Flag 없이 첫 메시지에서 pointer를 받은 Claude Code, 파일 변경, 변경 메시지 전송 | Agent는 파일을 읽었고, 변경 뒤에 다시 읽어 새 역할을 받았다. |

측정의 한계: 최종 접두어를 쓴 Claude Code의 identity-only launch는 측정되지 않았다(9행은 launch flag가 아니라 역할 파일의 이름을 적은 첫 메시지를 썼다). Claude Code의 `blocked` hold는 측정되지 않았다([messaging](messaging.md#evidence-of-the-hold)). 두 CLI 모두 측정되지 않은 것: context compaction, resume 뒤의 변경 메시지, agent가 바쁠 때의 변경 메시지, 같은 tab의 subagent나 두 번째 세션, 자동 메모리나 Codex 메모리가 세션 사이에 공유되는지 여부. 이에 기대는 규칙은 이 계약의 규칙으로 적었으며 측정된 동작으로 주장하지 않는다. 영구 메모리 금지 규칙은 지시일 뿐이다. 측정된 launch 옵션으로 두 CLI의 메모리를 끄는 방법은 없으므로 launch는 이 규칙을 강제하지 않으며, acceptance target이 그 결과를 검사한다(5단계).

Compaction: identity는 파일을 적고, 역할이 바뀌었을 때 다시 읽으라고 요청한다. Context 요약 뒤에 agent가 다시 읽는지는 측정되지 않았다. 그 측정이 기록되기 전까지 계약은 identity text 이상을 요구하지 않는다.

## Launch adapter

Launch adapter는 CLI launch 중 stable identity를 싣는 부분이다. 그 CLI의 내장 지시에 더하는 adapter만 쓴다. 내장 지시를 대체하는 adapter는 CLI가 도구를 실행하는 데 필요한 지시를 없애므로 쓰지 않는다.

| CLI | Launch 형식 | 내장 지시에 주는 효과 | 상태 |
| --- | --- | --- | --- |
| Claude Code | `claude --append-system-prompt-file <identity file>` | System prompt에 더한다. Flag는 대화형 TUI에 적용된다(launch에 역할 text를 준 경우 측정). 최종 접두어를 쓴 identity-only launch는 아직 측정되지 않았다. | identity-only 측정 뒤 사용 |
| Codex | `codex --no-daemon -c developer_instructions="<identity>"` | 전역 `AGENTS.md` 옆에 developer instruction을 더한다. 대화형 TUI에 적용되며, 변경 메시지 뒤 역할 파일을 다시 읽는다(측정). | 사용 |
| Kimi | `--agent-file` | 측정되지 않음. | 후보, 미사용 |
| Copilot | `--agent <name>` | 측정되지 않음. | 후보, 미사용 |
| OpenClaw | `tui --local agent:<name>` | 측정되지 않음. | 후보, 미사용 |
| Qwen | `--append-system-prompt` | 측정되지 않음. | 후보, 미사용 |
| Goose | `session --system` | 측정되지 않음. 이 flag는 지시를 대체할 수 있다. | 후보, 미사용 |

후보는 TUI에서 launch 동작이 검증된 뒤에 adapter로 더한다. 검증 기준은 지시가 새 세션에 적용되는지, 내장 지시에 더해지는지, 변경 메시지가 agent에게 역할 파일을 다시 읽게 하는지다. 내장 지시를 대체하는 후보는 더하지 않는다.

Resume 형식: `claude --resume <id>`와 `codex resume --no-daemon <id>`은 세션 시작의 지시를 유지하고, resume 명령의 adapter flag를 무시한다(측정). 따라서 launch adapter는 새 launch에서만 쓴다.

Claude Code 전제 조건: 최종 접두어를 쓴 identity-only launch는 Claude Code adapter를 쓰기 전에 acceptance target으로 측정한다. 그 전에는 Claude Code tab이 역할 없이 시작하며 역할 메시지를 보내지 않는다.

신뢰되지 않은 folder: folder 신뢰나 update를 묻는 CLI는 주입의 Enter를 그 CLI가 보여 주는 prompt에 보낸다. 이는 [evidence of the hold](messaging.md#evidence-of-the-hold)에서 측정되었다. Tab은 CLI가 이미 신뢰하는 folder에서만 agent CLI를 시작한다. 그 folder 신뢰 확인은 이 계약이 정하지 않으며 launch 항목의 전제 조건이다.

## Stable identity

Stable identity는 tab의 launch가 전달하는 text다. 영어로 쓰며, 그 tab의 역할 파일의 절대 경로인 `<role file>`을 넣어 다음 형식을 가진다.

> soksak assigns your role with messages that begin with [soksak 역할]; the latest such message defines your role. Your role is written in the file <role file>. Read that file before your first answer, and read it again when a message that begins with [soksak 역할] says that the role changed. Do not write your role into any persistent memory of yours, such as automatic memory or saved memories; the role file is the only record of your role.

- Identity는 메시지 접두어를 적으므로, agent는 변경 메시지를 역할의 권한으로 알아본다.
- Identity는 역할 파일의 경로를 적으므로, agent는 첫 답변과 변경 메시지마다 파일에서 역할을 읽는다.
- 영구 메모리 금지 규칙은 다른 세션이 읽을 수 있는 메모리에 역할이 들어가는 것을 막는다. CLI의 메모리가 세션 사이에 공유되면 역할이 다른 tab에 닿을 수 있다. 공유 여부는 측정되지 않았다.
- 경로는 application의 configuration directory에서 온 절대 경로다. 따옴표나 제어 문자를 담지 않으며, launch는 그런 경로를 거부한다.
- Identity는 launch와 adapter가 없는 CLI의 첫 메시지에서 같은 text다. 전달 방식만 다르다([첫 메시지](#첫-메시지)).

## 역할 파일

- 경로: `<config-dir>/agents/<surface>/role.md`. `<config-dir>`은 application의 configuration directory([installation layout](installation.md#installation-layout))이고, `<surface>`는 tab의 surface다. 각 surface는 자기 파일을 가지므로 두 tab이 역할을 공유하지 않는다.
- 내용: 역할 text, UTF-8, 최대 8 KiB. 빈 파일은 tab에 역할이 없다는 뜻이다. 파일은 다른 내용을 담지 않는다.
- 파일은 configuration directory에 속하며 사람의 repository에 속하지 않는다. Project folder에 쓰지 않는다.
- 권한: `<config-dir>/agents/<surface>/` 디렉터리는 0700으로 만들고, `role.md`와 identity file은 0600으로 쓴다. 임시 파일은 rename 전에 0600으로 만들며, rename 뒤 권한이 다르면 쓰기를 거부한다.
- 쓰는 주체: host가 파일을 쓴다. Host는 configuration directory와 surface를 소유하며, 터미널 page는 파일을 만들지 않는다.
- 쓰기 규칙: host는 같은 folder의 임시 이름으로 쓴 뒤 `role.md`로 rename하므로, agent는 이전 text나 새 text 중 하나를 읽는다. 쓰기가 실패하면 경로와 원인을 적은 오류를 내며, 역할 상태는 바뀌지 않고 변경 메시지도 보내지 않는다. 역할 파일이나 identity file을 쓸 수 없는 launch는 같은 오류로 거부되며 CLI를 시작하지 않는다.
- 수명: `<config-dir>/agents/<surface>/` 디렉터리는 tab이 layout에 있는 동안 산다. Host는 launch 전에 만들고, tab이 layout에서 제거되면 지운다. 제거된 tab은 resume할 수 없다.
- Launch 기록: 각 launch는 세션의 registration에 identity 경로와 launch 식별자를 저장한다. Resume은 저장된 경로가 tab의 현재 역할 파일 경로와 같은지, 파일이 있는지 확인한다. Configuration directory가 옮겨져 경로가 다르거나 파일이 없으면, 경로와 원인을 적은 명시적 오류로 resume을 실패시키며, 낡은 identity로 agent를 시작하지 않는다.

Claude Code adapter의 identity file은 `<config-dir>/agents/<surface>/identity.txt`이며, launch 때 host가 역할 파일 옆에 같은 쓰기 규칙으로 쓴다. Codex adapter는 identity text를 TOML 문자열로 따옴표를 씌워 inline으로 넘긴다.

## 역할 정의

역할 정의는 역할 파일이 담는 text다. Soksak은 정의를 `<config-dir>/roles.json` 한 파일에 둔다. 이 파일은 `settings.json`, `projects.json`과 나란히 놓인다([stored data formats](installation.md#stored-data-formats)). 이 파일은 번호가 있는 형식이다. 그 member `format`은 `1`이며, reader는 그 번호만 받아들이고 다른 번호는 `<file>: roles: format must be 1`로 거부한다.

```json
{"format": 1, "roles": {"reviewer": {"text": "You review the changes of the other agents in this project."}}}
```

- 역할 식별자는 `[a-z][a-z0-9-]*`에 맞고 최대 64자다. 다른 식별자는 그 이름을 적은 오류로 거부된다.
- `text`는 최대 8 KiB의 UTF-8 text다. 역할 파일에 그대로 쓰인다.
- Tab이 이름을 댄 역할이 `roles.json`에 없으면 `unknown agent role <id>`로 거부되며, tab은 이전 역할을 유지한다. 내장 정의를 대신 쓰지 않는다.

파일을 편집하는 도구는 별도의 checklist 항목이다.

## Tab의 역할 상태

Agent CLI의 각 tab은 agent 역할 하나나 없음을 가진다. Tab의 역할은 `projects.json`의 layout에 tab의 역할 식별자로 저장되며, 없으면 `null`이다. 이 member를 더하면 `projects.json`의 형식이 바뀌므로, [stored data formats](installation.md#stored-data-formats)의 규칙에 따라 형식 번호를 올린다. Migration은 쓰지 않으며, reader는 이전 형식을 거부한다. 역할 변경은 명령 `core.tab.role {tab, role}`이며, 다른 명령과 같이 registry를 거친다. Tab이 이미 가진 역할을 다시 정하면 아무것도 바뀌지 않고 아무것도 보내지 않는다.

역할 변경은 다음 순서로 실행되며, 각 단계는 앞 단계가 성공해야 시작된다.

1. Host가 tab의 역할 식별자를 `projects.json`에 저장한다. 이것이 역할의 권위 있는 기록이다.
2. Host가 역할 정의의 text, 또는 `null`이면 빈 파일로 역할 파일을 쓴다.
3. Host가 `{role, seq}`로 상태 `core.tab.role`을 공개한다. `seq`는 변경마다 1씩 오른다.
4. 터미널 page가 변경 메시지를 보낸다([변경 메시지](#변경-메시지)).

실패 규칙: 2단계나 3단계가 실패하면 host가 오류를 보고하고 `projects.json`의 저장된 역할은 그대로 남는다. 따라서 다음 launch에서 기록과 파일을 `projects.json`에서 다시 쓴다. Host가 단계 사이에 끝나면, 다음 launch가 CLI를 시작하기 전에 역할 파일을 `projects.json`에서 쓴다. 그래서 파일이 기록에 없는 역할을 담는 일은 없다. Launch는 이전 종료가 남긴 `<config-dir>/agents/<surface>/`의 임시 파일을 지운다.

상태 `core.tab.role`은 이벤트로 공개되며, page는 `runtime.status.watch`로 따르고 polling하지 않는다.

Messaging 결정과의 관계: [messaging](messaging.md#decisions-in-force)의 결정 D3은 agent 메시지의 유일한 messaging 이벤트 경로를 file event로 정한다. 변경 메시지는 agent 메시지가 아니라 application의 메시지이며, 그 trigger는 상태 `core.tab.role`이다. 따라서 이 계약은 D3을 application 메시지에 대해서만 개정한다. 개정은 변경 메시지의 구현(features의 체크리스트 항목)과 함께 `messaging.md`에 기록하며, 마지막으로 전달된 역할 변경의 저장된 `seq`는 [sidecars](sidecars.md#messages)에 정의된 terminal sidecar의 요청이다.

Leader는 이 계약에서 역할을 바꾸지 않는다. [groups](groups.md#model)는 leader가 명령, focus, 그리기 순서를 바꾸지 않는 표시라고 정하며, leader 변경은 역할 파일을 쓰지도 메시지를 보내지도 않는다. 어떤 plane의 leader가 역할을 갖기를 원하는 호출자는 `core.tab.role`로 정한다. Leader 표시 자체가 역할을 움직이는지는 groups 계약의 소유자가 정할 열린 질문이다.

## 변경 메시지

변경 메시지는 한 줄이다.

`[soksak 역할] 역할이 바뀌었다. 역할 파일 <role file>을 다시 읽어라. 이 메시지는 soksak이 보낸 것이며 사람의 입력이 아니다. 현재 작업을 마친 뒤 처리하고, 승인이나 권한을 주지 않으며 대기 중인 질문에 답하지 않는다.`

- 역할 파일의 경로를 담고 역할 text는 담지 않는다. 역할 text는 파일을 통해서만 agent에 닿는다.
- 보고 요청을 담지 않는다. 이 메시지는 다른 agent의 메시지가 아니고 보낸 folder가 없으므로, [messaging](messaging.md#report-request)의 보고 요청은 적용되지 않는다.
- 보낸 쪽은 application이다. Tab이 보낸 쪽이 아니므로, 보낸 tab이 window에 없으면 거부하는 규칙은 적용되지 않는다.
- [messaging](messaging.md#injected-message)의 hold, guard, 전달 기록을 모두 거친다. 변경 메시지는 program이 사람을 기다리는 동안 보류된다([hold for the person](messaging.md#hold-for-the-person)). destructive command guard는 제출된 줄을 판정한다([persistent services](persistent-services.md#destructive-command-guard)). 전달 기록은 종류 `role`을 적고 경로는 적지 않는다.
- 변경 메시지는 tab의 agent CLI가 세션의 foreground program일 때만 주입된다. 이는 sidecar의 program 상태로 판정한다. Shell prompt, 종료된 program이나 닫힌 세션에 제출된 줄은 shell에서 실행될 수 있기 때문이다. CLI가 실행되지 않는 동안 바뀐 역할은 `core.tab.role`에 남고, 다음 launch의 첫 메시지로 간다.

변경 메시지는 [messaging](messaging.md#injected-message)이 모든 주입 메시지에 정한 framing 절을 담는다([framing](#framing)).

변경 메시지는 page가 연결된 동안 관찰한 `core.tab.role`의 변경마다 보낸다. 터미널 sidecar는 세션의 마지막으로 전달된 역할 `seq`를 registration 옆에 저장한다([messaging](messaging.md#registered-folder)). 그래서 page가 다시 적재되면 `seq`가 그보다 큰 변경만 주입한다. 이 저장은 sidecar가 소유하므로, page를 다시 읽어도 이미 전달된 변경이 반복되지 않는다.

## 첫 메시지

Launch adapter가 없는 CLI는 identity를 첫 메시지로 받는다. 첫 메시지는 세션의 첫 주입 메시지다. 첫 메시지는 [stable identity](#stable-identity)의 identity text를 `[soksak 역할] <identity text> 이 메시지는 soksak이 보낸 것이며 사람의 입력이 아니다. 현재 작업을 마친 뒤 처리하고, 승인이나 권한을 주지 않으며 대기 중인 질문에 답하지 않는다.` 형식으로 담고, 한 줄이다.

세션의 첫 메시지는 그 registration의 어떤 agent 메시지보다 먼저 전달된다. Page는 program이 처음 상태를 보고할 때 이를 주입한다. 그 상태는 세션의 첫 `<plugin>.program` record 또는 첫 `running`이나 `idle` 상태다. Record를 쓰지 않고 알림도 주지 않는 시작 prompt는 관찰되지 않으므로, [evidence of the hold](messaging.md#evidence-of-the-hold)에서 측정된 prompt처럼 page가 보내는 Enter가 그 prompt에 답할 수 있다. 이 한계는 명시한다. Acceptance target은 CLI가 이미 신뢰하는 folder에서 실행되며, 위의 신뢰되지 않은 folder 전제 조건을 따른다.

## 주입 메시지의 순서

Page는 registration마다 queue 하나를 가진다. Queue는 folder의 agent 메시지를 `seq` 순으로, 역할 변경을 역할 `seq` 순으로 담고, 그 항목들을 page에 도착한 순서대로 한 번에 하나씩 주입한다. 세션의 첫 메시지는 그 registration의 모든 agent 메시지보다 먼저 온다. 각 항목은 종류 `message` 또는 `role`을 전달 기록에 담으므로, 두 counter를 비교할 필요가 없다.

## Framing

[Messaging](messaging.md#injected-message)은 모든 주입 메시지의 framing을 정한다. 그 framing은 보낸 쪽과 다음 절들이다. 사람의 입력이 아니라는 것, 현재 작업을 마친 뒤 처리한다는 것, 승인이나 권한을 주지 않으며 대기 중인 질문에 답하지 않는다는 것이다. 변경 메시지와 첫 메시지는 보낸 쪽으로 application을 적고 같은 절을 쓴다. Framing은 text의 출처를 밝히며, text가 요구하는 것을 허용하지 않는다.

변경 메시지는 권한 prompt를 승인할 수 없으며, [messaging](messaging.md#hold-for-the-person)의 hold가 적용된다. Hold는 record를 쓰지 않는 prompt에는 적용되지 않는다. Claude Code의 `blocked` hold는 아직 측정되지 않았으므로, Claude Code에는 [launch adapter](#launch-adapter)의 측정이 기록된 뒤에만 역할 변경을 보낸다.

## Resume

Resume은 프로그램을 자기 명령으로 다시 시작하며, launch adapter는 세션을 바꾸지 않는다. Resume된 tab은 재읽기 메시지를 한 번 보낸다. 이는 역할 파일의 경로를 적은 변경 메시지이며, status의 `seq`와 관계없이 보낸다. 이는 resume 뒤에 역할 파일이 권위임을 알리는 신호이며, 역할 변경이 아니다. Adapter가 없는 tab은 resume 뒤에 첫 메시지의 identity를 다시 보낸다. 재개된 process는 처음 시작 때의 identity를 갖지 않기 때문이다. 역할이 `null`인 tab도 같은 방식으로 identity를 받는다. identity가 빈 파일을 가리키기 때문이며, 바뀌지 않은 역할에 대해서는 변경 메시지를 보내지 않는다.

Tab의 launch 명령으로 다시 실행하는 경우의 전달은 다음과 같다.

| 경우 | Identity | 변경 메시지 |
| --- | --- | --- |
| Tab의 launch 명령으로 새로 시작, adapter가 있는 CLI | Launch flag로 준다 | Program 상태가 보고된 뒤 보낸다 |
| Tab의 launch 명령으로 새로 시작, adapter가 없는 CLI | 첫 메시지 | 따로 보내지 않는다 |
| Tab의 launch 명령으로 resume | 세션 시작에서 유지(adapter가 있는 CLI), 또는 첫 메시지(adapter가 없는 CLI) | 보낸다 |
| 사람이 tab의 shell에 launch 명령 밖에서 입력한 명령 | 없음: soksak이 identity를 주지 않는다 | 없음 |
| 측정 전의 Claude Code | 주지 않는다 | 없음 |

사람이 launch 명령 밖에서 입력한 명령은 soksak의 launch가 아니므로, 계약은 identity를 주지 않고 아무것도 보내지 않는다. 사람이 경로를 적지 않는 한 그 agent는 역할 파일을 가리키는 pointer를 갖지 않는다.

## 실행 중 agent의 변경

변경 하나는 역할 변경 하나, 역할 파일의 다시 쓰기 하나, `core.tab.role`의 `seq` 하나, 변경 메시지 하나다. Agent는 파일을 읽을 때 변경을 적용하며, 변경 메시지가 그렇게 시키는 것이다(Codex에서 측정, Claude Code에서는 첫 메시지의 pointer로 측정, agent가 쉬고 있을 때). 재시작은 필요 없으며, 변경이 프로그램을 끝내지는 않는다.

사람이 tab 안의 shell에서 두 번째 agent로 CLI를 직접 시작하면, 그 CLI는 soksak의 identity를 받지 않는다. 변경 메시지는 foreground program이 무엇이든 닿으므로, 계약은 이 한계를 명시한다. Launch 기록은 identity를 가진 한 process를 가리키며, page는 변경 메시지를 그 tab의 등록된 launch에만 보내고, sidecar는 launch 식별자로 그것을 추적한다. 사람이 직접 시작한 두 번째 agent는 계약 밖이다.

Agent가 바쁠 때 도착한 변경 메시지의 동작은 두 CLI 모두 측정되지 않았다. Repository는 바쁜 수신자에 대해 두 가지 다른 기대를 적는다([messaging](messaging.md#injected-message)과 [terminal plan](../plans/terminal-plan.md)). 측정이 결정할 때까지, 변경 메시지는 program이 바쁘지 않다고 보고한 뒤에만 주입된다. 현재 작업이 끝난 뒤 처리한다는 규칙은 framing 절이며 측정된 보장이 아니다.

## 테스트

### 단위 테스트

- Launch adapter의 단위 테스트는 각 CLI에 대해 adapter가 만든 인자 목록과 identity file을 기대값과 비교한다. 단위 테스트에서 agent CLI는 실행하지 않는다.
- 터미널 launch 경로는 launch가 agent 명령으로 시작하는 기록 program으로 시험한다. 이 program은 받은 인자와 첫 입력을 기록하고 다른 일을 하지 않는다. Launch는 이를 실제 process로 시작하며, 테스트는 launch 함수를 대체하지 않고, program은 agent를 대신해 답하지 않는다.
- 역할 파일 쓰기의 단위 테스트는 surface별 경로, 임시 이름과 rename, `null`의 빈 파일, 8 KiB 한계, 쓰기 실패 오류를 다루며, 실패한 쓰기는 역할 상태를 바꾸지 않는다.
- `roles.json`의 단위 테스트는 형식 번호, 식별자 규칙, text 한계, 알 수 없는 역할 거부를 각각의 오류 text와 함께 다룬다.
- 변경 메시지의 단위 테스트는 형식, 역할 text가 없음, 같은 역할 변경에서 `seq`가 바뀌지 않음, 그리고 agent CLI가 아닌 program일 때 보내지 않음을 다룬다.

### Acceptance

Acceptance target은 `test-app-agent-role`이다. Core는 agent CLI나 plugin의 이름을 대는 window check를 선언하지 않으므로, target은 변경 메시지를 보내는 page를 소유한 터미널 plugin의 repository가 선언한다. 그 plugin을 설치한 application에서 실제 Claude Code와 Codex를 실행하며, 임시 configuration directory와 CLI가 이미 신뢰하는 project folder를 쓴다. 로컬에서만 실행하고, 화면이 필요하며, 사람이 실행할 때만 돈다. [AGENTS](../../AGENTS.md#verification)의 window check 규칙이 적용되며, `make test-app`에는 포함되지 않는다. 각 CLI에 대해 target은 다음을 한다.

1. `core.layout.open`으로 CLI와 역할 `reviewer`를 가진 tab을 열고, 상태 `core.tab.role`과 program 상태를 기다린다(timer를 기다리지 않는다).
2. Agent에게 역할의 code word로 답하라는 메시지를 보내고, 선언된 exposure로 화면의 답을 읽는다.
3. `core.tab.role`로 역할을 `leader`로 바꾸고 다시 묻는다. 새 역할의 code word를 요구하고, 이전 역할의 code word가 없어야 한다.
4. 세션을 resume하고 resume 뒤 현재 역할의 code word를 요구한다.
5. 어떤 역할의 code word도 CLI의 persistent 메모리 파일에 나타나지 않아야 한다. Target은 임시 home의 CLI 메모리 folder에서 읽는다.

`claude`나 `codex` 명령이 없으면 그 이름을 적은 오류로 target이 실패하며, 어떤 시험도 건너뛰지 않는다. 각 시험은 자신의 시간 한계를 가지며, `running`, `finished`, `passed`, `failed`와 경과 시간을 출력한다([AGENTS](../../AGENTS.md#verification)).

## 검증 경계

Adapter 표는 target이 각 CLI에 대해 실행될 때와, launch 옵션을 바꾸는 CLI의 새 버전마다 검증된다. Target이 존재하고 그 실행이 [features](../features.md)에 기록되기 전까지, 그 주장에 기대는 adapter 표는 검증되지 않은 것이다.

## 검토

이 결정은 적대적 검토자들이 검토했다. 각 검토자는 증거로 초안에 반대하고, 각 반론에 대한 답을 냈다. 각 라운드의 반론과 이 문서에 적용된 답은 다음과 같다.

- 1라운드, 기존 계약과의 일관성: 어떤 plane의 leader는 tab을 갖지 않는 group card일 수 있으므로, 역할은 tab에만 붙는다. Leader 표시는 명령을 바꾸지 않으므로([groups](groups.md#model)), 여기서 역할을 움직이지 않는다. 역할 변경의 queue는 folder queue와 따로 있으므로, 순서는 도착 순서로 정한다([순서](#주입-메시지의-순서)). `roles.json`과 tab 역할은 저장 형식이다([stored data formats](installation.md#stored-data-formats)). Guard 앵커는 [persistent services](persistent-services.md#destructive-command-guard)다.
- 1라운드, 실행 동작: 역할 변경은 agent CLI가 foreground program일 때만 주입된다. 첫 메시지는 program의 첫 상태를 기다리며, 시작 prompt의 한계는 명시한다. Claude Code의 blocked hold는 전제 조건이다. Sidecar가 마지막 전달된 역할 `seq`를 저장하므로 page 재적재가 전달을 반복하지 않는다. 식별자 파일 쓰기 실패는 명시적 오류로 launch를 실패시킨다.
- 1라운드, 범위와 시험: 단위 테스트는 adapter의 인자와 identity file을 확인하고, 기록 program은 받은 것을 기록하는 실제 process다. Acceptance target은 터미널 plugin repository에 있는데, core가 plugin 이름을 대는 window check를 선언하지 않기 때문이다. 용어의 표기는 개념마다 한 이름으로 맞췄고, kit 용어 목록을 전제 조건으로 한다.
- 2라운드, pointer 설계와 실행: 역할 디렉터리는 tab이 있는 동안 산다. Resume은 저장된 경로와 파일을 확인하고 아니면 명시적 오류로 실패한다. 쓰기 순서는 기록을 먼저 하고, 다음 launch에 기록에서 파일을 다시 쓴다. 역할 파일 mode는 0700과 0600이다. 재실행의 경우들을 표로 적었다. Compaction, 바쁜 수신자, 두 번째 세션, 메모리 공유는 측정되지 않았다고 적었다.
- 2라운드, 기록과 용어: 측정 날짜와 계정 설명을 제거했다. 다른 작업은 checklist ID가 아니라 설명으로 가리킨다. 측정 행은 관찰된 대로 적었다.

이 문서가 해결하지 못한 반론: Claude Code의 identity-only launch와 그 blocked hold가 측정되지 않아서 Claude Code adapter는 사용되지 않는다. Leader에서 역할로 가는 문제는 groups 계약의 소유자에게 속한다. 응용 메시지에 대한 messaging 결정 D3의 개정과 `projects.json` 형식 변경은 구현 항목에서 따로 한다. `agent role`, `role file`, `change message`, `stable identity`, `launch adapter`, `identity file` 용어는 이 문서를 받아들이기 전에 kit 용어 목록에 있어야 한다.
